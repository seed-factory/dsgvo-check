export const meta = {
  name: 'dsgvo-check-docs',
  description: 'Round 4 verification (Fable) + Round 5 doc writing: architecture & plan (Opus), legal wording guide & ADRs (Fable)',
  phases: [
    { title: 'Verify', detail: 'Fable verifies consensus README' },
    { title: 'Write', detail: 'Opus: architecture, plan; Fable: wording guide, ADRs' },
  ],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
const SP = '/private/tmp/claude-502/-Users-user-Documents-germany-coding-memes/09ac13f0-de2a-4656-af7a-4a95e6b60757/scratchpad/docs'
const WRITE = (who, briefFile) => `Рабочая директория репозитория: ${REPO}. Ты — ${who}.
Прочитай общее задание ${REPO}/docs/consensus/prompts/round-5_doc-writing.md. Плейсхолдер {{DOC}} в нём замени содержимым файла ${SP}/${briefFile} — это описание твоего документа. Выполни задание. Пиши только указанные в описании файлы.
Для проверки фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch"). Финальный ответ — через StructuredOutput.`
const DOC_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    authorProposals: { type: 'array', items: { type: 'string' }, description: 'решения, которых нет в консенсусе и которые автор пометил как несогласованные' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'authorProposals', 'openQuestions'],
}
const tasks = [
  () => agent(`Рабочая директория репозитория: ${REPO}. Ты — Claude Fable 5.1, независимый верификатор. Прочитай задание ${REPO}/docs/consensus/prompts/round-4_verification.md и выполни его. Результат запиши инструментом Write в ${REPO}/docs/consensus/round-4/claude-fable-5.1_verification.md (только этот файл). Для проверки фактов можешь загрузить WebSearch через ToolSearch ("select:WebSearch"). Финальный ответ — через StructuredOutput.`, {
    label: 'verify:fable', phase: 'Verify', model: 'fable',
    schema: { type: 'object', properties: { file: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } }, majors: { type: 'array', items: { type: 'string' } }, mustFix: { type: 'array', items: { type: 'string' } } }, required: ['file', 'blockers', 'majors', 'mustFix'] },
  }),
  () => agent(WRITE('Claude Opus 5.5, автор документа об архитектуре', '02-architecture.txt'), { label: 'write:02-architecture (opus)', phase: 'Write', schema: DOC_SCHEMA }),
  () => agent(WRITE('Claude Opus 5.5, автор плана реализации', '05-plan.txt'), { label: 'write:05-plan (opus)', phase: 'Write', schema: DOC_SCHEMA }),
  () => agent(WRITE('Claude Fable 5.1, автор Formulierungsleitfaden', 'legal.txt'), { label: 'write:legal-wording (fable)', phase: 'Write', schema: DOC_SCHEMA, model: 'fable' }),
  () => agent(WRITE('Claude Fable 5.1, автор ADR', 'adr.txt'), { label: 'write:adr (fable)', phase: 'Write', schema: DOC_SCHEMA, model: 'fable' }),
]
return await parallel(tasks)
