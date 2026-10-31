export const meta = {
  name: 'dsgvo-check-cross-edit',
  description: 'Round 6b: cross-model edits of docs (Fable edits Codex/Opus docs, Opus edits Fable/Terra docs)',
  phases: [{ title: 'Cross-edit', detail: '5 editors from a different model family than the author' }],
}
const SP = '/private/tmp/claude-502/-Users-user-Documents-germany-coding-memes/09ac13f0-de2a-4656-af7a-4a95e6b60757/scratchpad/r6'
const REPO = '/Users/user/Documents/germany/coding-memes'
const JOBS = [
  { k: 'checks', model: 'fable', who: 'Claude Fable 5.1' },
  { k: 'brief', model: 'fable', who: 'Claude Fable 5.1' },
  { k: 'quality', model: null, who: 'Claude Opus 5.5' },
  { k: 'wording', model: null, who: 'Claude Opus 5.5' },
  { k: 'adr', model: null, who: 'Claude Opus 5.5' },
]
const SCHEMA = {
  type: 'object',
  properties: {
    changed: { type: 'array', items: { type: 'string' } },
    crossDocIssues: { type: 'array', items: { type: 'string' }, description: 'документ → место → проблема → как должно быть' },
    logFile: { type: 'string' },
  },
  required: ['changed', 'crossDocIssues', 'logFile'],
}
phase('Cross-edit')
return await parallel(JOBS.map(j => () => agent(`Рабочая директория: ${REPO}. Ты — ${j.who}. Прочитай задание ${SP}/${j.k}.md и выполни его: редактируй только указанный в нём документ и пиши журнал в docs/consensus/round-6/. Для проверки фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch"). Финальный ответ — через StructuredOutput.`, {
  label: `edit:${j.k} (${j.model || 'opus'})`, phase: 'Cross-edit', schema: SCHEMA, ...(j.model ? { model: j.model } : {}),
}).then(r => r && { doc: j.k, ...r })))
