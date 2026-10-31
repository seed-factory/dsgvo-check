export const meta = {
  name: 'dsgvo-check-proposals',
  description: 'Round 2: independent architecture proposals from Claude Opus and Claude Fable (Codex runs separately)',
  phases: [{ title: 'Propose', detail: 'Opus + Fable, same prompt as Codex' }],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
const P = (name, file) => `Рабочая директория репозитория: ${REPO}. Прочитай файл ${REPO}/docs/consensus/prompts/round-2_proposal.md — это твоё задание целиком (ты в нём — ${name}). Выполни его.

Готовое предложение запиши инструментом Write в ${REPO}/${file} (только этот файл, больше ничего не меняй). Для проверки фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch"). Финальный ответ — через StructuredOutput: путь к файлу и краткая выжимка.`
const SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    summary: { type: 'string', description: '10-15 главных решений предложения, по одному в строке' },
    disagreementsWithResearch: { type: 'array', items: { type: 'string' } },
  },
  required: ['file', 'summary', 'disagreementsWithResearch'],
}
phase('Propose')
const res = await parallel([
  () => agent(P('Claude Opus 5.5', 'docs/consensus/round-2/claude-opus-5.5_proposal.md'), { label: 'propose:opus', phase: 'Propose', schema: SCHEMA }),
  () => agent(P('Claude Fable 5.1', 'docs/consensus/round-2/claude-fable-5.1_proposal.md'), { label: 'propose:fable', phase: 'Propose', schema: SCHEMA, model: 'fable' }),
])
return res
