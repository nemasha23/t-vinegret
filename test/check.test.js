// Проверка автопроверки: node test/check.test.js
const assert = require('assert');
const { isCorrect } = require('../check');
const { buildSteps } = require('../questions');

const cases = [
  ['Матрица', ['матрица'], true, true],
  ['  МАТРИЦА!! ', ['матрица'], true, true],
  ['матрца', ['матрица'], true, true],          // одна опечатка
  ['мтрца', ['матрица'], true, false],          // две опечатки
  ['Красно-чёрное дерево', ['красно-черное дерево'], true, true],
  ['красночерное дерево', ['красно-черное дерево'], true, true],
  ['Deep Learning', ['глубокое обучение', 'deep learning'], true, true],
  ['Ханойские башни', ['ханойская башня', 'ханойские башни'], true, true],
  ['Enigma', ['энигма', 'enigma'], true, true],
  ['Kобра', ['кобра'], true, true],             // латинская K
  ['7,5', ['7.5'], false, true],
  ['7.5 минут', ['7.5'], false, true],
  ['ответ 24', ['24'], false, true],
  ['25', ['24'], false, false],
  ['1 729', ['1729'], true, true],
  ['1728', ['1729'], true, false],              // числа без опечаток
  ['0', ['ноль', 'нуль', '0'], true, true],
  ['Нуль', ['ноль', 'нуль', '0'], true, true],
  ['2', ['2'], false, true],
  ['3', ['2'], false, false],
  ['', ['2'], false, false],
  ['лось', ['олень'], true, false],
  ['Калининград', ['калининград', 'кенигсберг'], true, true],
  ['Кёнигсберг', ['калининград', 'кенигсберг'], true, true],
];
for (const [ans, accept, typo, want] of cases) {
  assert.strictEqual(isCorrect(ans, accept, typo), want, `${ans} → ${accept} ожидалось ${want}`);
}

// Каждый эталонный ответ проходит собственную проверку.
for (const s of buildSteps().filter((x) => x.type === 'question')) {
  for (const a of s.accept) assert.ok(isCorrect(a, s.accept, s.typo), `${s.qid}: «${a}» не проходит`);
}
console.log(`OK: ${cases.length} случаев и все эталонные ответы`);
