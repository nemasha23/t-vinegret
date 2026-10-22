// Сценарий игры: блоки, вопросы и принимаемые варианты ответов.
// Чтобы поправить ответ, достаточно изменить массив accept.

const BLOCKS = [
  {
    id: 'I', title: 'I. Две правды, одна ложь', points: 1, typo: false,
    demo: ['2'],
    questions: [['1'], ['3'], ['2'], ['2'], ['1'], ['3'], ['3'], ['1'], ['3'], ['2'], ['3'], ['2'], ['1'], ['3'], ['2']],
  },
  {
    id: 'II', title: 'II. Т-Перевёртыши', points: 1, typo: true,
    demo: ['черный квадрат'],
    questions: [
      ['матрица'],
      ['простое число'],
      ['властелин колец'],
      ['машинное обучение'],
      ['последняя теорема ферма', 'великая теорема ферма'],
      ['задача о рюкзаке'],
      ['золотое сечение'],
      ['жадный алгоритм'],
      ['глубокое обучение', 'deep learning'],
      ['задача коммивояжера'],
      ['синий экран смерти'],
      ['ханойская башня', 'ханойские башни'],
      ['красно-черное дерево'],
      ['игры разума'],
      ['умница уилл хантинг'],
    ],
  },
  {
    id: 'III', title: 'III. Т-Блиц с собесов', points: 2, typo: false,
    demo: ['8'],
    questions: [['24'], ['10'], ['22'], ['7.5'], ['7'], ['14'], ['10']],
  },
  {
    id: 'IV', title: 'IV. Т-Пентагон', attempts: [3, 2, 1], typo: true,
    demo: ['луна'],
    questions: [
      ['энтропия'],
      ['ноль', 'нуль', '0'],
      ['перфокарта', 'перфокарты'],
      ['энигма', 'enigma'],
    ],
  },
  {
    id: 'V', title: 'V. Т-ЧГК', points: 2, typo: true,
    demo: ['эйфелева башня', 'башня'],
    questions: [
      ['калининград', 'кенигсберг'],
      ['олень'],
      ['волна'],
      ['биг мак', 'big mac', 'гамбургер'],
      ['кобра'],
      ['1729'],
      ['моль', 'мотылек', 'бабочка', 'насекомое'],
      ['32'],
      ['камешек', 'камушек', 'камень', 'камни', 'галька'],
    ],
  },
];

// Плоский список шагов, по которым ведущая идёт кнопкой «Дальше».
function buildSteps() {
  const steps = [{ type: 'lobby', label: 'Регистрация' }];
  for (const b of BLOCKS) {
    steps.push({ type: 'question', qid: `${b.id}-demo`, block: b.id, blockTitle: b.title,
      label: 'Демо', accept: b.demo, points: 0, typo: b.typo, demo: true });
    b.questions.forEach((accept, i) => {
      const n = i + 1;
      if (b.attempts) {
        b.attempts.forEach((pts, a) => {
          steps.push({ type: 'question', qid: `${b.id}-${n}-${a + 1}`, block: b.id, blockTitle: b.title,
            label: `Вопрос ${n} · Попытка ${a + 1}`, accept, points: pts, typo: b.typo,
            theme: `${b.id}-${n}` });
        });
      } else {
        steps.push({ type: 'question', qid: `${b.id}-${n}`, block: b.id, blockTitle: b.title,
          label: `Вопрос ${n}`, accept, points: b.points, typo: b.typo });
      }
    });
    steps.push({ type: 'break', block: b.id, blockTitle: b.title, label: `Разбор блока ${b.id}` });
  }
  steps[steps.length - 1] = { ...steps[steps.length - 1], last: true };
  steps.push({ type: 'end', label: 'Конец игры' });
  return steps;
}

module.exports = { BLOCKS, buildSteps };
