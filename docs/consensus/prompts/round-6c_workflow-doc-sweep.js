export const meta = {
  name: 'dsgvo-check-doc-sweep',
  description: 'Round 6c: per-document fixers resolve all cross-document issues from round-6 logs; Fable residual check',
  phases: [
    { title: 'Fix', detail: 'one owner per document applies cross-doc issues' },
    { title: 'Residual', detail: 'Fable checks remaining contradictions' },
  ],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
const DOCS = [
  { k: 'brief', path: 'docs/00-brief.md' },
  { k: 'architecture', path: 'docs/02-architecture.md' },
  { k: 'checks', path: 'docs/03-checks.md' },
  { k: 'quality', path: 'docs/04-quality-and-delivery.md' },
  { k: 'plan', path: 'docs/05-plan.md' },
  { k: 'wording', path: 'docs/legal/wording-guide.md' },
  { k: 'adr', path: 'docs/adr/ (все файлы и README)' },
]
const COMMON = `Рабочая директория: ${REPO}. Не трогай код (src/, test/, конфиги, data/) и git — там работают другие агенты. Сегодня 2026-10-30.
Проект dsgvo-check: пассивный CLI-сканер DSGVO/безопасности на TypeScript + Playwright. Источник истины: docs/consensus/README.md (с поправками раунда 4б, журнал docs/consensus/round-4/errata.md); выше него — ТЗ (specs/).
В раунде 6 документы правили перекрёстно и параллельно; журналы с таблицами «Расхождения с другими документами» лежат в docs/consensus/round-6/*.md (7 файлов). Каноны: варианты проверок, messageId и ключи текстов — docs/03-checks.md (по checkId.variant); юридические формулировки — docs/legal/wording-guide.md; контракты и поля — docs/consensus/README.md §5 и docs/02-architecture.md.`
const SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, alreadyFixed: { type: 'integer' }, rejected: { type: 'array', items: { type: 'string' } } }, required: ['fixed', 'alreadyFixed', 'rejected'] }

phase('Fix')
const fixes = await parallel(DOCS.map(d => () => agent(`${COMMON}

Ты — владелец документа ${d.path} на финальной зачистке (Claude Opus). Редактируй ТОЛЬКО его.
1. Прочитай все журналы docs/consensus/round-6/*.md и выпиши все претензии, адресованные твоему документу (в таблицах расхождений и открытых вопросах).
2. Для каждой проверь, актуальна ли она на текущей версии файла (документ мог уже исправить другой редактор). Актуальную — исправь по канону и консенсусу. Если претензия противоречит консенсусу — отклони с причиной.
3. ${d.k === 'wording' ? 'Особо: приведи ВСЕ ключи текстов и варианты к набору checkId.variant из docs/03-checks.md (единый реестр). Если в 03-checks нет нужного варианта — оставь свой ключ с пометкой «⚠ нет в 03-checks» и добавь в открытые вопросы.' : d.k === 'checks' ? 'Особо: убедись, что у каждой проверки перечень вариантов и messageId полный и однозначный — это канон для wording-guide и ruleset; добавь в начало документа (или проверь, что есть) сводный реестр «checkId.variant → severity → messageId».' : d.k === 'brief' ? 'Особо: бриф должен совпадать с обновлённым консенсусом по числам (оценки, частоты: PRIV-01 не «самая частая» — HDR-01 64, MAIL-01 54, PRIV-01 48), по семантике кодов, sandbox для трёх входов, EgressPolicy, относительным порогам TLS-02, срезу прототипа; ссылки внутри docs/ должны вести на существующие файлы и якоря.' : 'Сверь также ссылки на другие документы: файлы и якоря должны существовать.'}
4. Не раздувай документ. Финальный ответ — StructuredOutput: fixed (что исправлено), alreadyFixed (сколько претензий уже были исправлены), rejected (отклонённые с причиной).`, {
  label: `fix:${d.k}`, phase: 'Fix', schema: SCHEMA,
}).then(r => r && { doc: d.k, ...r })))

phase('Residual')
const residual = await agent(`${COMMON}

Ты — Claude Fable 5.1, финальный независимый ревьюер документации. Прочитай целиком docs/00-brief.md, docs/05-plan.md, docs/adr/README.md, а docs/02-architecture.md, docs/03-checks.md, docs/04-quality-and-delivery.md, docs/legal/wording-guide.md — по оглавлению и в местах ключевых контрактов (коды возврата, модель результата, CONSENT-04, CONSENT-05, PRIV-01, TLS-02, sandbox, EgressPolicy, UA, тексты и стоп-слова). Найди ОСТАВШИЕСЯ противоречия между документами и с консенсусом/ТЗ, правовые ошибки и формулировки, которые звучат как правовой вывод, а также битые относительные ссылки (проверь существование файлов). Ничего не редактируй. Ответ — StructuredOutput: список находок с серьёзностью.`, {
  label: 'residual:fable', phase: 'Residual', model: 'fable',
  schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { doc: { type: 'string' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] } }, required: ['doc', 'where', 'problem', 'fix', 'severity'] } }, verdict: { type: 'string' } }, required: ['findings', 'verdict'] },
})
return { fixes, residual }
