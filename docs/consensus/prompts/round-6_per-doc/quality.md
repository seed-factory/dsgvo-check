Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/04-quality-and-delivery.md** написала модель **Codex GPT-6.1-Terra**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - Line 103: «pnpm 11 с lockfile» → «pnpm 12.16.1 (packageManager), фолбэк 11.28.9»
   - Line 217 SSRF: «egress-прокси для браузера и undici» → one `EgressPolicy` for the proxy, undici, node:tls, net.Socket; `--proxy` only HTTP CONNECT; DNS direct, recorded in Messumgebung; upstream gets CONNECT to the checked IP. Add L2/L3 tests for every connection path (TLS-02, TLS-04, upstream)
   - Line 229: CSP `default-src 'none'` → the full CSP from README §5.8; next to the «ноль сети» test add a test that screenshots and styles render
   - Line 215: next to `acceptDownloads: false` (basis D25) add `chromiumSandbox: true` and a check that launch args contain no `--no-sandbox`
   - L3: sandbox on the three TZ entry points — npx on Ubuntu 24.04; plain `docker run` → 2 with the exact launch line; `docker run` with the image profile; Action; GitLab
   - Fixtures: TLS-02 6-day cert = clean and an IP target; CONSENT-04 `no-choice-at-first-layer`; CONSENT-05 default-denied = inconclusive; cookieless per-load ID → warning; first screen does not scroll during capture; override on `banner-not-recognized` → invalid-input
   - Contract tests: JUnit mapping (failure/error/skipped/system-out/properties); process exit code = `summary.exitCode` after an HTML reporter failure; gate table for `--fail-on none --strict`, timeout before/after the start page, browser 429/503
   - Delivery: `THIRD_PARTY_NOTICES` in npm and OCI (MPL-2.0 with a source link, CC BY 4.0 for GHSA), attributions in the HTML footer, an L0 completeness check
   - Soft mode: GitHub `continue-on-error` + `::warning::` + Summary; GitLab stderr + JUnit `<error>`; document that with exit 1 scan errors also pass
   - Completeness test: `en` is required only after `en` is declared a release language
   - Canary: separate the prototype's one-off measurement run (100 public sites per BRIEF, private results) from the D23 acceptance canary (10 sites with owner consent)

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** инженерная реализуемость тестов, CI, Docker, Action, GitLab, релизов и безопасности сканера; согласованность с архитектурой. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/04-quality_review-by-claude-opus-5.5.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
