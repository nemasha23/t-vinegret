// Нагрузочная проверка: запускает сервер, подключает N участников и проходит игру.
// node test/load.test.js [N]
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const N = Number(process.argv[2]) || 500;
const PORT = 3999;
const KEY = 'test-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-'));
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, body: s }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const admin = (action, body) => req(body ? 'POST' : 'GET', '/api/admin/' + action, body, { 'x-admin-key': KEY });

function sse(onStep) {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, (res) => {
    let buf = ''; res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) onStep(JSON.parse(line.slice(6)).step);
      }
    });
  });
  return r;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, ADMIN_PASSWORD: KEY, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('запущен') && r()));

  const players = [];
  const sses = [];
  const seen = new Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    sses.push(sse((st) => { seen[i] = st.index; }));
  }
  let t = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => req('POST', '/api/register',
    { first: 'Имя' + i, last: 'Фам' + i, tg: 'nick' + i, club: 'Олимпиадная математика' })
    .then((r) => { if (!r.body.pid) throw new Error('регистрация: ' + JSON.stringify(r.body)); players[i] = r.body.pid; })));
  console.log(`Регистрация ${N}: ${Date.now() - t} мс`);

  const steps = (await admin('state')).body.steps;
  let maxSwitch = 0, totalAnswerMs = 0, answers = 0;
  for (let idx = 1; idx < steps.length; idx++) {
    t = Date.now();
    await admin('go', { index: idx });
    while (seen.some((s) => s !== idx)) await new Promise((r) => setTimeout(r, 5));
    maxSwitch = Math.max(maxSwitch, Date.now() - t);
    const step = (await req('GET', '/api/state')).body.step;
    if (step.type !== 'question') continue;
    t = Date.now();
    // Игрок i отвечает верно, если i % 3 !== 0. Чётные ещё и меняют ответ.
    const accept = (await admin('state')).body.step.accept[0];
    await Promise.all(players.map((pid, i) => req('POST', '/api/answer', { pid, qid: step.qid, text: i % 3 ? accept.toUpperCase() : 'не знаю' })
      .then((r) => { if (!r.body.ok) throw new Error('ответ: ' + JSON.stringify(r.body)); })));
    totalAnswerMs += Date.now() - t; answers += N;
  }
  console.log(`Переключение экранов у всех ${N}: максимум ${maxSwitch} мс`);
  console.log(`Ответы: ${answers} шт, в среднем ${Math.round(totalAnswerMs / (steps.length))} мс на волну из ${N}`);

  // Ответ на закрытый вопрос не принимается.
  const late = await req('POST', '/api/answer', { pid: players[1], qid: 'I-1', text: '1' });
  if (late.status !== 409) throw new Error('закрытый вопрос принял ответ');

  const st = (await admin('state')).body;
  // 15 + 15 + 7*2 + 4*3 (пентагон с первой попытки) + 9*2 = 74
  if (st.top[0].score !== 74) throw new Error('ожидалось 74, получено ' + st.top[0].score);
  console.log(`Максимум очков: ${st.top[0].score}, на связи: ${st.online}`);

  const csv = await admin('export.csv');
  const lines = String(csv.body).trim().split('\r\n');
  if (lines.length !== N + 1) throw new Error('в CSV не те строки: ' + lines.length);

  // Перезапуск и восстановление из копии.
  const backup = (await admin('backup.json')).body;
  await admin('reset', { confirm: 'СБРОС' });
  if ((await admin('state')).body.players !== 0) throw new Error('сброс не сработал');
  await admin('restore', backup);
  const after = (await admin('state')).body;
  if (after.players !== N || after.top[0].score !== 74) throw new Error('восстановление не сработало');
  console.log('Резервная копия: восстановление работает');

  sses.forEach((r) => r.destroy());
  srv.kill('SIGTERM');
  await new Promise((r) => srv.on('exit', r));
  if (!fs.existsSync(path.join(dataDir, 'state.json'))) throw new Error('состояние не сохранилось на диск');
  console.log('OK');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
