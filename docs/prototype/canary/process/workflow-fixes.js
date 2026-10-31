export const meta = {
  name: 'canary2-fixes',
  description: 'Sonnet/Haiku zone fixers apply canary consensus groups (TDD); Sonnet integrator waits for the Codex Terra net zone, applies cross-zone items, runs the full suite, reanalyzes canary2 and writes TRIAGE.md',
  phases: [
    { title: 'Fix', detail: 'privacy, cmp, legal, requests, robustness on Sonnet; catalog data on Haiku (net runs on Codex Terra outside)' },
    { title: 'Integrate', detail: 'Sonnet: cross-zone, full suite, reanalyze, docs' },
  ],
}

const REPO = '/Users/user/Documents/germany/coding-memes'
const RUN = '20261030-canary2'
const T = `canary/results/${RUN}/triage`
const COMMON = `Рабочая директория: ${REPO}. Прочитай docs/prototype/canary/PROMPT-fix.md — это общие правила и формат отчёта. Следуй им.`

const ZONES = [
  { k: 'privacy', model: 'sonnet', groups: 'G01, G03 (fix); G04 (verify-then-fix)',
    files: 'src/core/url.ts, новый src/core/redact.ts, src/core/api.ts (только экспорт redact-функций), src/collectors/browser/{dom,util,in-page}.ts; тесты test/unit/core/**, test/integration/browser/**',
    extra: 'Ты владеешь in-page.ts, поэтому сделай и чужие части в нём: (а) G23 crossZone — expandables считать только внутри контейнера текста документа или возвращать признак расположения; (б) G35 crossZone — в журнал cookieHook добавить location.hostname документа и разобранный атрибут domain= (без значения cookie). Функцию маскирования e-mail/mailto/URL (redactText и маску mailto) экспортируй через src/core/api.ts — она нужна зонам legal и net.' },
  { k: 'cmp', model: 'sonnet', groups: 'G06, G07, G08, G09, G15, G16, G17, G18 (fix); G10, G11, G13, G14 (verify-then-fix)',
    files: 'src/cmp/**, data/cmp/**, src/collectors/browser/{cmp-bridge,screenshot}.ts, src/checks/browser/{consent-03,consent-04}.ts, src/core/report-schema.ts, schema/report.schema.json (через corepack pnpm schema), записи CONSENT-03/04 в data/{ruleset/de-2026,texts/de,texts/en,crm}/browser.yaml; тесты test/unit/cmp/**, test/integration/cmp/**, test/unit/checks/browser/consent-0{3,4}*, test/fixture-server/sites/cmp/**, test/fixtures/snapshots/browser/CONSENT-0{3,4}/**',
    extra: 'Ты владеешь src/core/report-schema.ts: добавь и поле DocumentEvidence.manifest из crossZone группы G28 (зона legal заполнит его в legal-01/priv-01). G07: ожидание стабилизации инкапсулируй в src/cmp/index.ts, если возможно; правку порядка в collector.ts — только через crossZone.' },
  { k: 'legal', model: 'sonnet', groups: 'G19, G20, G21, G22, G24, G25, G26, G27, G28 (fix); G23 (verify-then-fix)',
    files: 'src/collectors/browser/{documents,pages,robots}.ts, src/checks/browser/{legal-01,priv-01}.ts, новый data-файл лексикона правовых ссылок (G24, например data/legal/links.yaml) и его загрузчик, записи LEGAL-01/PRIV-01 в data/{ruleset/de-2026,texts/de,texts/en,crm}/browser.yaml; тесты test/unit/checks/browser/{legal,priv}*, test/integration/browser/** (новые файлы), test/fixtures/snapshots/browser/{LEGAL-01,PRIV-01}/**',
    extra: 'Сделай и чужие части в своих файлах: G01 crossZone (вызвать redactText из src/core/redact.ts для parts[].text, section, linkedFrom[].text до хеширования — зона privacy создаёт этот файл параллельно; если его ещё нет, опиши в crossZone), G04 crossZone (dom.linksTruncated → limitation в legal-01.ts), G18 crossZone (уверенность footer-covered-by-banner в legal-01.ts), G55 crossZone (L1-тест attempt error → limitation). Изменения collector.ts из crossZone G19/G20 делает зона robustness — не трогай collector.ts.' },
  { k: 'requests', model: 'sonnet', groups: 'G32, G33, G34, G35, G37 (fix)',
    files: 'src/derive/**, src/collectors/browser/{recorder,features,jar,quiet}.ts, src/checks/browser/{consent-01,consent-02,consent-05,track-01,embed-01,embed-02,shared}.ts, data/routing.yaml, записи этих проверок в data/{ruleset/de-2026,texts/de,texts/en,crm}/browser.yaml; тесты test/unit/derive/**, test/unit/checks/browser/** (кроме consent-03/04, legal, priv), test/integration/browser/pure/**, test/fixtures/snapshots/browser/{CONSENT-01,CONSENT-02,CONSENT-05,TRACK-01,EMBED-01,EMBED-02}/**',
    extra: 'НЕ трогай data/services/** — каталог правит отдельная зона catalog. Сделай и чужие части в своих файлах: G03 crossZone (features.ts извлекает признак идентификатора из matrix-параметров пути ДО редактирования), G49 crossZone (recorder.ts headersArray()/serverAddr() и jar.ts evaluate — под таймаутом и сигналом). Для G35 журнал cookieHook дополняет зона privacy (in-page.ts) — ты используешь новые поля в jar.ts; если их ещё нет, опиши в crossZone.' },
  { k: 'catalog', model: 'haiku', groups: 'G31, G36 (fix)',
    files: 'data/services/** (ads.yaml, analytics.yaml, consent.yaml, _catalog.yaml и т. п.); новый тест test/unit/derive/catalog-canary2.test.ts',
    extra: 'Это работа с данными каталога, код не трогай. Хосты бери из evidence групп и из snapshot.json названных там сайтов (canary/results/20261030-canary2/<siteId>/snapshot.json — только чтение), плюс общеизвестные домены вендоров. Сигнатуры консервативные: домен + путь библиотеки/хита; identifierParams добавляй только если параметр с идентификатором виден в snapshot. Allowlist (G36): только перечисленные в fix ключи; __cmpiuid и consentUUID не добавлять. Посмотри формат существующих записей и тестов каталога (test/unit/derive/**) и сделай так же. Тест: для каждого нового вендора derive классифицирует синтетический запрос на его домен как этот сервис; ключи allowlist классифицируются как consent-state.' },
  { k: 'robustness', model: 'sonnet', groups: 'G49, G50, G54, G55, G56, G57, G58 (fix); G51, G52 (verify-then-fix)',
    files: 'src/collectors/browser/{collector,launch,visit,challenge,ssrf}.ts, src/scan.ts, src/core/{gate,assess,snapshot,execute}.ts, src/cli.ts, data/texts/{de,en}/core.yaml, scripts/canary*.ts, README.md, canary/sites.yaml; тесты test/unit/core/**, test/integration/core/**, test/integration/browser/** (новые файлы), test/unit/canary/**',
    extra: 'Сделай и чужие части в своих файлах: G07 crossZone (порядок в collector.ts — только если зона cmp не смогла инкапсулировать ожидание; согласуй по факту в конце, иначе опиши в crossZone), G19 crossZone (collector.ts: при исходе «тип не подтверждён» пробовать следующего кандидата, ≤ 3 GET), G20 crossZone (collector.ts: исход judgeDocument → attempt outcome unconfirmed + тип в схеме снимка), G46 crossZone (поле environment.trustStore в src/core/snapshot.ts и запись CA-настройки процесса в scripts/canary-runner.ts run.json). G58: правка en-строки Nutzungshinweise по wording-guide и синхронизация README.md (немецкая фраза разрешена — см. rationale G58). В canary/sites.yaml поправь expectedCmp у сайта из заметки модератора (группа G59 evidence: CookieHub вместо other).' },
]

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results', 'crossZone', 'green'],
  properties: {
    results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['gid', 'outcome', 'test', 'note'], properties: {
      gid: { type: 'string' }, outcome: { type: 'string', enum: ['fixed', 'not-reproduced', 'deferred', 'cross-zone'] }, test: { type: 'string' }, note: { type: 'string' } } } },
    crossZone: { type: 'array', items: { type: 'string' } },
    green: { type: 'boolean' },
  },
}

phase('Fix')
const fixes = await parallel(ZONES.map((z) => () => agent(`${COMMON}

## Твоя зона: ${z.k}
Группы из ${T}/consensus.json: ${z.groups}.
Файлы зоны: ${z.files}.
${z.extra}`, { label: `fix:${z.k} (${z.model})`, phase: 'Fix', model: z.model, schema: SCHEMA }).then((r) => r && { zone: z.k, ...r })))
const done = fixes.filter(Boolean)
log(`zones done: ${done.map((f) => `${f.zone}:${f.results.filter((r) => r.outcome === 'fixed').length}/${f.results.length}${f.green ? '' : ' NOT-GREEN'}`).join(', ')}; missing: ${ZONES.filter((z) => !done.some((f) => f.zone === z.k)).map((z) => z.k).join(',') || 'none'}`)

phase('Integrate')
const integ = await agent(`${COMMON} Ты — интегратор, можно менять любые файлы (кроме canary/results/**, кроме ${T}/fix-*.json).

1. Зона net (HTTP/TLS/DNS: G02, G40–G44, G46, G48) параллельно правится Codex GPT-6.1-Terra вне этого workflow. Дождись её: повторяй bash \`while pgrep -f "codex exec -m gpt-6.1-terra" >/dev/null; do sleep 30; done\` (timeout 600000 мс, сколько потребуется). Её отчёт — ${T}/fix-net-terra.json (если файла нет — зона net упала, отметь это).
2. Отчёты остальных зон: ${JSON.stringify(done.map((f) => ({ zone: f.zone, green: f.green, crossZone: f.crossZone, results: f.results.map((r) => ({ gid: r.gid, outcome: r.outcome, note: r.note })) })))}
   Сделай все cross-zone изменения из всех отчётов (включая net) и из поля crossZone групп consensus.json, которые зоны не закрыли. Если net реализовала маскирование DNS локально — переведи на общую функцию из src/core/redact.ts.
3. Прогони и доведи до зелёного: corepack pnpm typecheck, lint, schema:check, test:unit, test:integration, затем build и test:e2e. Флейки чини в корне, не ретраями.
4. Пересчитай канарейку по сохранённым снимкам (без сети): \`node scripts/canary.ts --reanalyze ${RUN} --run-id ${RUN}-re1\` и \`node scripts/canary-summary.ts ${RUN}-re1\`. Сравни canary/results/${RUN}-re1/SUMMARY.md с canary/results/${RUN}/SUMMARY.md. Помни: reanalyze пересчитывает только проверки; исправления коллекторов (privacy, CMP-ожидание, документы) видны только после нового скана.
5. Напиши docs/prototype/canary/TRIAGE.md (по-русски, БЕЗ siteId, доменов и имён сайтов корпуса — AGENTS п. 7):
   - процесс: прогон 20261030-canary2 (замороженный dist, 100 сайтов), разбор Fable 5.1 + Codex Sol по 5 зонам, перекрёстное голосование, модератор + критик Fable, исправления (Sonnet/Haiku по зонам, net — Codex Terra, интеграция — Sonnet); промпты и скрипты лежат рядом;
   - таблица групп: gid → заголовок → решение → зона → итог (fixed / not-reproduced / deferred) → тест;
   - вопросы к спецификации (decision spec-question) с цифрами — для заказчика;
   - отклонённые с причиной;
   - сравнение агрегатов до/после reanalyze (только агрегаты).
6. Обнови docs/prototype/STATUS.md: раздел про канарейку (агрегаты canary2, что исправлено, что осталось), числа тестов, новые известные пробелы. Обнови docs/prototype/CONTRACTS.md, если поменялись контракты (redact.ts, schema снимка/отчёта, DocumentEvidence.manifest, environment.trustStore).
7. Проверь grep, что в docs/**, test/**, src/**, data/** (кроме canary/sites.yaml) не появилось siteId или доменов сайтов корпуса из canary/sites.yaml.
Финальный ответ — JSON по схеме.`, {
  label: 'integrate (sonnet)', phase: 'Integrate', model: 'sonnet',
  schema: { type: 'object', additionalProperties: false, required: ['summary', 'allGreen', 'testCounts', 'fixed', 'notReproduced', 'deferred', 'reanalyzeDelta'], properties: {
    summary: { type: 'string' }, allGreen: { type: 'boolean' },
    testCounts: { type: 'object', additionalProperties: false, required: ['unit', 'integration', 'e2e'], properties: { unit: { type: 'integer' }, integration: { type: 'integer' }, e2e: { type: 'integer' } } },
    fixed: { type: 'array', items: { type: 'string' } }, notReproduced: { type: 'array', items: { type: 'string' } }, deferred: { type: 'array', items: { type: 'string' } },
    reanalyzeDelta: { type: 'string' },
  } },
})
return { fixes, integ }
