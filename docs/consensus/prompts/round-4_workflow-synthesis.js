export const meta = {
  name: 'dsgvo-check-synthesis',
  description: 'Round 4: synthesize consensus decisions D01-D27 from 4 proposals and 4 critiques into docs/consensus/README.md',
  phases: [{ title: 'Synthesize', detail: 'Opus moderator, xhigh effort' }],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
phase('Synthesize')
return await agent(`Рабочая директория репозитория: ${REPO}. Прочитай ${REPO}/docs/consensus/prompts/round-4_synthesis.md — это твоё задание целиком (ты — модератор консенсус-панели). Выполни его и запиши ${REPO}/docs/consensus/README.md.

Сводка голосов критиков в машинном виде есть также в журналах; но опирайся на файлы критик — в них обоснования. Для проверки отдельных фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch").

Финальный ответ — через StructuredOutput.`, {
  label: 'synthesis:opus',
  phase: 'Synthesize',
  effort: 'xhigh',
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      disputed: { type: 'array', items: { type: 'string' }, description: 'ID точек со статусом спор или изменённых меньшинством, с итогом в одну строку' },
      customerQuestions: { type: 'integer' },
      errorsFound: { type: 'integer' },
    },
    required: ['file', 'disputed', 'customerQuestions', 'errorsFound'],
  },
})
