// Т-Винегрет: сервер приёма ответов. Без внешних зависимостей, только Node.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSteps, BLOCKS } = require('./questions');
const { normalize, isCorrect } = require('./check');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vinegret';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOOT_ID = crypto.randomBytes(6).toString('hex');

const CLUBS = [
  'Олимпиадная математика',
  'Олимпиадная геометрия',
  'Алгоритмы и структуры данных',
  'Информационная безопасность',
  'Искусственный интеллект',
  'Не учусь в кружке Т-Поколение',
];
const LATE_MESSAGE = 'Прости, игра уже идёт. Ты уже не можешь принять участие, но можешь просто послушать';

const STEPS = buildSteps();
const STEP_BY_QID = Object.fromEntries(STEPS.filter((s) => s.qid).map((s) => [s.qid, s]));

// ---------- Состояние ----------

function emptyState() {
  return {
    stepIndex: 0,
    allowLate: true,
    players: {},   // pid -> { pid, first, last, tg, club, at }
    answers: {},   // qid -> { pid: { t: текст, at: время } }
    manual: {},    // qid -> { нормализованный ответ: true (засчитать) | false (не засчитывать) }
    savedAt: 0,
  };
}

let state = emptyState();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...emptyState(), ...raw };
    console.log(`Состояние загружено: ${Object.keys(state.players).length} участников, шаг ${state.stepIndex}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать state.json:', e.message);
  }
  if (state.stepIndex >= STEPS.length) state.stepIndex = STEPS.length - 1;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.savedAt = Date.now();
    const tmp = STATE_FILE + '.tmp';
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.writeFile(tmp, JSON.stringify(state), (err) => {
        if (err) return console.error('Ошибка сохранения:', err.message);
        fs.rename(tmp, STATE_FILE, (err2) => err2 && console.error('Ошибка сохранения:', err2.message));
      });
    });
  }, 1000);
}

// ---------- Проверка и подсчёт ----------

const checkCache = new Map(); // `${qid}\n${текст}` -> boolean

function verdict(qid, text) {
  const step = STEP_BY_QID[qid];
  const manual = state.manual[qid];
  const norm = normalize(text);
  if (manual && norm in manual) return manual[norm];
  const key = qid + '\n' + text;
  let ok = checkCache.get(key);
  if (ok === undefined) {
    ok = isCorrect(text, step.accept, step.typo);
    checkCache.set(key, ok);
  }
  return ok;
}

// Очки каждого участника по блокам. Пентагон: засчитывается самая ранняя верная попытка темы.
function computeScores() {
  const scores = {};
  for (const pid of Object.keys(state.players)) {
    scores[pid] = { total: 0, byBlock: Object.fromEntries(BLOCKS.map((b) => [b.id, 0])) };
  }
  const themeDone = {}; // `${pid}|${theme}` -> true
  for (const step of STEPS) {
    if (step.type !== 'question' || step.demo) continue;
    const answers = state.answers[step.qid];
    if (!answers) continue;
    for (const [pid, a] of Object.entries(answers)) {
      const s = scores[pid];
      if (!s || !verdict(step.qid, a.t)) continue;
      if (step.theme) {
        const k = pid + '|' + step.theme;
        if (themeDone[k]) continue;
        themeDone[k] = true;
      }
      s.byBlock[step.block] += step.points;
      s.total += step.points;
    }
  }
  return scores;
}

// Места: больше очков выше; при равенстве выше тот, у кого больше очков в ЧГК; иначе место делится.
function ranking(scores, key) {
  const get = key === 'total' ? (s) => s.total : (s) => s.byBlock[key];
  const rows = Object.keys(scores)
    .map((pid) => ({ pid, score: get(scores[pid]), tie: key === 'total' ? scores[pid].byBlock.V : 0 }))
    .sort((a, b) => b.score - a.score || b.tie - a.tie);
  let place = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.score !== r.score || prev.tie !== r.tie) place = i + 1;
    r.place = place;
  });
  return rows;
}

function playerName(p) {
  return `${p.first} ${p.last}`.trim();
}

function publicStep(i) {
  const s = STEPS[i];
  const out = { index: i, type: s.type, label: s.label };
  if (s.qid) out.qid = s.qid;
  if (s.blockTitle) out.blockTitle = s.blockTitle;
  if (s.last) out.last = true;
  return out;
}

// ---------- SSE ----------

const clients = new Set();

function broadcast() {
  const msg = `data: ${JSON.stringify({ step: publicStep(state.stepIndex) })}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}

// Раз в 20 секунд повторяем текущий шаг: это и пульс соединения, и страховка от потерянных сообщений.
setInterval(broadcast, 20000);

// ---------- HTTP-помощники ----------

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function isAdmin(req) {
  const key = req.headers['x-admin-key'] || '';
  const a = Buffer.from(String(key));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const STATIC = {
  '/': 'index.html',
  '/admin': 'admin.html',
};
const staticCache = {};
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!staticCache[file] || process.env.NODE_ENV !== 'production') {
    try { staticCache[file] = fs.readFileSync(full); } catch (e) { return send(res, 404, 'Не найдено'); }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(staticCache[file]);
}

// ---------- Участник ----------

function participantState(pid) {
  const p = pid && state.players[pid];
  const step = STEPS[state.stepIndex];
  const out = { step: publicStep(state.stepIndex), registered: !!p };
  if (p) {
    out.name = p.first;
    if (step.qid) {
      const a = state.answers[step.qid] && state.answers[step.qid][pid];
      out.myAnswer = a ? a.t : null;
    }
  }
  return out;
}

async function handleRegister(req, res) {
  const body = await readBody(req);
  let pid = clean(body.pid, 40);
  if (pid && state.players[pid]) return send(res, 200, { pid, ...participantState(pid) });

  const first = clean(body.first, 60);
  const last = clean(body.last, 60);
  let tg = clean(body.tg, 60).replace(/\s/g, '');
  const club = clean(body.club, 80);
  if (!first || !last || !tg.replace(/@/g, '') || !CLUBS.includes(club)) {
    return send(res, 400, { error: 'Заполни все поля' });
  }
  if (!tg.startsWith('@')) tg = '@' + tg;

  // Повторная регистрация после перезапуска сервера (resume) пропускается всегда.
  const started = state.stepIndex > 0;
  if (started && !state.allowLate && !body.resume) {
    return send(res, 403, { error: LATE_MESSAGE, late: true });
  }
  if (!/^[a-zA-Z0-9_-]{8,40}$/.test(pid)) pid = crypto.randomBytes(9).toString('base64url');
  state.players[pid] = { pid, first, last, tg, club, at: Date.now() };
  scheduleSave();
  send(res, 200, { pid, ...participantState(pid) });
}

async function handleAnswer(req, res) {
  const body = await readBody(req);
  const pid = clean(body.pid, 40);
  if (!state.players[pid]) return send(res, 401, { error: 'Нужно зарегистрироваться', unknown: true });
  const step = STEPS[state.stepIndex];
  if (step.type !== 'question' || body.qid !== step.qid) {
    return send(res, 409, { error: 'Приём ответов на этот вопрос закрыт', ...participantState(pid) });
  }
  const text = clean(body.text, 200);
  if (!text) return send(res, 400, { error: 'Пустой ответ' });
  (state.answers[step.qid] ||= {})[pid] = { t: text, at: Date.now() };
  scheduleSave();
  send(res, 200, { ok: true, ...participantState(pid) });
}

// ---------- Ведущая ----------

function adminState() {
  const scores = computeScores();
  const step = STEPS[state.stepIndex];
  const nPlayers = Object.keys(state.players).length;
  const out = {
    bootId: BOOT_ID,
    stepIndex: state.stepIndex,
    steps: STEPS.map((s, i) => ({ i, type: s.type, label: s.label, blockTitle: s.blockTitle || '' })),
    step: { ...publicStep(state.stepIndex), accept: step.accept || null, points: step.points },
    allowLate: state.allowLate,
    players: nPlayers,
    online: clients.size,
    clubs: CLUBS.map((c) => ({ club: c, n: Object.values(state.players).filter((p) => p.club === c).length })),
  };

  if (step.qid) {
    const answers = state.answers[step.qid] || {};
    const groups = {};
    for (const a of Object.values(answers)) {
      const norm = normalize(a.t) || a.t;
      const g = (groups[norm] ||= { norm, sample: a.t, n: 0 });
      g.n++;
    }
    const manual = state.manual[step.qid] || {};
    out.answered = Object.keys(answers).length;
    out.distribution = Object.values(groups)
      .map((g) => ({ ...g, ok: verdict(step.qid, g.sample), manual: g.norm in manual }))
      .sort((a, b) => b.n - a.n);
  }

  const toRow = (r) => {
    const p = state.players[r.pid];
    return { place: r.place, name: playerName(p), tg: p.tg, club: p.club, score: r.score };
  };
  out.top = ranking(scores, 'total').slice(0, 15).map(toRow);
  out.blockTop = BLOCKS.map((b) => ({
    title: b.title,
    rows: ranking(scores, b.id).filter((r) => r.score > 0).slice(0, 5).map(toRow),
  }));
  return out;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const scores = computeScores();
  const qsteps = STEPS.filter((s) => s.type === 'question' && !s.demo);
  const head = ['Место', 'Имя', 'Фамилия', 'Телеграм', 'Кружок', ...BLOCKS.map((b) => b.title), 'Итого',
    ...qsteps.map((s) => `${s.block} ${s.label}`)];
  const lines = [head.map(csvCell).join(';')];
  for (const r of ranking(scores, 'total')) {
    const p = state.players[r.pid];
    const s = scores[r.pid];
    const cells = [r.place, p.first, p.last, p.tg, p.club, ...BLOCKS.map((b) => s.byBlock[b.id]), s.total,
      ...qsteps.map((q) => {
        const a = state.answers[q.qid] && state.answers[q.qid][r.pid];
        return a ? (verdict(q.qid, a.t) ? '✓ ' : '✗ ') + a.t : '';
      })];
    lines.push(cells.map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

async function handleAdmin(req, res, action) {
  if (!isAdmin(req)) return send(res, 401, { error: 'Неверный пароль' });

  if (req.method === 'GET') {
    if (action === 'state') return send(res, 200, adminState());
    if (action === 'export.csv') {
      return send(res, 200, exportCsv(), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="t-vinegret-results.csv"',
      });
    }
    if (action === 'backup.json') return send(res, 200, { ...state, bootId: BOOT_ID, backupAt: Date.now() });
    return send(res, 404, { error: 'Нет такой команды' });
  }

  const body = await readBody(req, action === 'restore' ? 50 * 1024 * 1024 : 64 * 1024);
  if (action === 'go') {
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= STEPS.length) return send(res, 400, { error: 'Нет такого шага' });
    state.stepIndex = i;
    scheduleSave();
    broadcast();
  } else if (action === 'allowLate') {
    state.allowLate = !!body.value;
    scheduleSave();
  } else if (action === 'manual') {
    const qid = String(body.qid || '');
    if (!STEP_BY_QID[qid]) return send(res, 400, { error: 'Нет такого вопроса' });
    const m = (state.manual[qid] ||= {});
    if (body.value === null || body.value === undefined) delete m[body.norm];
    else m[body.norm] = !!body.value;
    scheduleSave();
  } else if (action === 'reset') {
    if (body.confirm !== 'СБРОС') return send(res, 400, { error: 'Нужно подтверждение' });
    state = emptyState();
    checkCache.clear();
    scheduleSave();
    broadcast();
  } else if (action === 'restore') {
    if (!body || typeof body.players !== 'object' || typeof body.answers !== 'object') {
      return send(res, 400, { error: 'Это не похоже на резервную копию' });
    }
    const { bootId, backupAt, ...rest } = body;
    // Участники, зарегистрировавшиеся после перезапуска, не теряются.
    const players = { ...rest.players, ...state.players };
    const answers = { ...rest.answers };
    for (const [qid, m] of Object.entries(state.answers)) answers[qid] = { ...(answers[qid] || {}), ...m };
    state = { ...emptyState(), ...rest, players, answers };
    if (state.stepIndex >= STEPS.length) state.stepIndex = STEPS.length - 1;
    checkCache.clear();
    scheduleSave();
    broadcast();
  } else {
    return send(res, 404, { error: 'Нет такой команды' });
  }
  send(res, 200, adminState());
}

// ---------- Маршрутизация ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) return serveStatic(res, STATIC[p]);
    if (p === '/health') return send(res, 200, 'ok');

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\ndata: ${JSON.stringify({ step: publicStep(state.stepIndex) })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, participantState(url.searchParams.get('pid')));
    if (req.method === 'GET' && p === '/api/clubs') return send(res, 200, { clubs: CLUBS });
    if (req.method === 'POST' && p === '/api/register') return await handleRegister(req, res);
    if (req.method === 'POST' && p === '/api/answer') return await handleAnswer(req, res);
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, p.slice('/api/admin/'.length));

    send(res, 404, 'Не найдено');
  } catch (e) {
    console.error('Ошибка запроса', req.method, req.url, e.message);
    if (!res.headersSent) send(res, 400, { error: 'Ошибка запроса' });
    else res.end();
  }
});

// Сервер не должен падать из-за одной ошибки.
process.on('uncaughtException', (e) => console.error('Неперехваченная ошибка:', e));
process.on('unhandledRejection', (e) => console.error('Неперехваченная ошибка:', e));

function shutdown() {
  state.savedAt = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) { console.error('Ошибка сохранения при остановке:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadState();
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => {
  console.log(`Т-Винегрет запущен: http://localhost:${PORT}  (ведущая: /admin)`);
  if (!process.env.ADMIN_PASSWORD) console.log('ВНИМАНИЕ: пароль ведущей не задан, используется "vinegret"');
});
