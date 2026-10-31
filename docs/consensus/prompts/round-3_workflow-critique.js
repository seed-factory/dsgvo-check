export const meta = {
  name: 'dsgvo-check-critique',
  description: 'Round 3: cross-critique of 4 proposals by Claude Fable (legal lens) and Claude Opus (architecture lens)',
  phases: [{ title: 'Critique', detail: 'Fable legal lens + Opus engineering lens' }],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
const LENS = {
  fable: '**Правовая корректность и формулировки (DSGVO, TDDDG, DDG, MStV, BFSG).** Правовая база каждой проверки и её актуальность на октябрь 2026; где проверка, уровень, crmCode или текст находки подменяет юридический вывод; RDG и автоматизированные оценки; §§ 202a/202c StGB и § 824 BGB для самого инструмента; риск использования отчётов для массовых Abmahnungen; минимизация персональных данных в отчётах и CI-артефактах; третьи страны и DPF. Главный вопрос: что из предложенного опасно или неверно с точки зрения права ЕС и Германии, и как это исправить.',
  opus: '**Архитектура и инженерная реализуемость.** Границы модулей, контракт проверки и снимка артефактов, расширяемость «без правок ядра», модель результата и коды возврата, данные и их версионирование, оценки трудоёмкости и критический путь, YAGNI: что лишнее для MVP и чего не хватает. Главный вопрос: какое из предложений (или какая их комбинация) даст самую простую архитектуру, которая выдержит все P0 и последующие P1/P2 без переделки.',
}
const P = (who, lensKey, file) => `Рабочая директория репозитория: ${REPO}. Прочитай файл ${REPO}/docs/consensus/prompts/round-3_cross-critique.md — это твоё задание целиком (ты в нём — ${who}). Плейсхолдер {{LENS}} в нём замени на свою линзу:

${LENS[lensKey]}

Готовую критику запиши инструментом Write в ${REPO}/${file} (только этот файл, больше ничего не меняй). Для проверки фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch"). Финальный ответ — через StructuredOutput.`
const SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    votes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          choice: { type: 'string' },
          alignsWith: { type: 'array', items: { type: 'string', enum: ['Opus', 'Fable', 'Sol', 'Terra'] } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'choice', 'alignsWith', 'confidence'],
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['file', 'votes', 'blockers'],
}
phase('Critique')
return await parallel([
  () => agent(P('Claude Fable 5.1, критик с правовой линзой', 'fable', 'docs/consensus/round-3/claude-fable-5.1_critique.md'), { label: 'critique:fable (legal)', phase: 'Critique', schema: SCHEMA, model: 'fable' }),
  () => agent(P('Claude Opus 5.5, критик с архитектурной линзой', 'opus', 'docs/consensus/round-3/claude-opus-5.5_critique.md'), { label: 'critique:opus (architecture)', phase: 'Critique', schema: SCHEMA }),
])
