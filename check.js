// Автоматическая проверка ответов.

// Латинские буквы-двойники приводим к русским (с обеих сторон одинаково).
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };

function normalize(s) {
  let t = String(s || '').toLowerCase().replace(/ё/g, 'е');
  t = t.replace(/[a-z]/g, (ch) => LOOKALIKE[ch] || ch);
  return t.replace(/[^0-9a-zа-я]/g, '');
}

function isNumeric(s) {
  return /^-?\d+(\.\d+)?$/.test(String(s).trim());
}

function firstNumber(s) {
  const m = String(s || '').replace(/\s/g, '').replace(/,/g, '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function isCorrect(answer, accept, typo) {
  if (!answer || !String(answer).trim()) return false;
  if (accept.every(isNumeric)) {
    const n = firstNumber(answer);
    return n !== null && accept.some((a) => Math.abs(Number(a) - n) < 1e-9);
  }
  const got = normalize(answer);
  if (!got) return false;
  return accept.some((a) => {
    const want = normalize(a);
    if (got === want) return true;
    return typo && want.length >= 6 && levenshtein(got, want) <= 1;
  });
}

module.exports = { normalize, isCorrect };
