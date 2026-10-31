Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/adr/*.md (все файлы каталога и README-индекс)** написала модель **Claude Fable 5.1**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - ADR-0006: «Спор 2:2» → «спор 2:1:1, решение модератора»; maxSeverity without the confidence cap; rows none×strict, timeout before/after the start page, final code after reporters; «На код влияют только --fail-on и --strict» → list of gate inputs; soft mode per platform (GitHub continue-on-error/::warning::, GitLab stderr/JUnit error)
   - ADR-0009: «Пять фаз» → «пять фаз в четырёх свежих профилях (A с A′, B, C, M)»; 3:1 on the shared B/C subsample (Sol-К against); note on IP disclosure in phase C; DSE in A
   - ADR-0010: line 18 «HTTP- и TLS-пробы» → «HTTP-пробы»; browser UA from navigator.userAgent/template, mobile in M. Line 21 «--proxy (HTTP или SOCKS5, на все коллекторы)» → «--proxy (HTTP CONNECT) для браузера, undici и TLS; DNS напрямую». Static research table; ban bot words in <org>/<repo>; critical for CONSENT-03 on `asserted` is a moderator decision (question 12)
   - ADR-0011: contract `extract / act / verify`, decision in core, `vendorRole` as a fact; autoconsent detect-only, read-only, on its own rules (not copied, not modified); `THIRD_PARTY_NOTICES` for MPL
   - ADR-0012: `acceptAvailableAtFirstLayer`; `no-choice-at-first-layer`; locked unknown variants; non-blocking = 3:1; screenshot = viewport capture + crop
   - ADR-0013: CC BY 4.0 attribution for GHSA, `datasets[].attribution`, `THIRD_PARTY_NOTICES`
   - ADR-0014 line 7: «D18 единогласно по классам E и TLS-04» → «E — единогласно; TLS-04 — T при включённой проверке; DKIM — 3:1 (против Sol-К) и вопрос 16»
   - ADR-0015: request `delivery`/`result`/`provenance`, `features`, monotonic `tMs`; screenshot without `locator.screenshot`, 50 % rule, «снижает риск» instead of «снимает»; full CSP
   - ADR-0016: sandbox on the three TZ entry points and question 8; `chromiumSandbox: true`; `EgressPolicy`; upstream = CONNECT to the checked IP and an honest SSRF boundary; full CSP; corrected seccomp/AppArmor explanation; rewrite the alternative «Только require — self-managed не работает вовсе»
   - ADR-0017: `THIRD_PARTY_NOTICES` in npm and OCI; split line 42 «Мягкий режим печатает ::warning::…» per platform; the `docker run --security-opt seccomp=…` line and the command that prints the profile from the image
   - ADR-0018: pnpm 11 → 12.16.1; flip the alternative «pnpm 12 — отклонено» (11.28.9 is the fallback); remove «Переход на pnpm 12 — пересмотр в I кв. 2027»; reconcile Corepack («без Corepack» here vs «corepack pnpm» in BRIEF; ⚠ Corepack is not bundled with Node ≥ 25)
   - ADR-0003: format drop order PDF → JUnit → Summary → HTML; the prototype (BRIEF) is separate from the release. ADR-0004/0008: adapter extract/act/verify in the pipeline; safe features in the snapshot; `baseline migrate` to backlog; subject for every ID; locked variants in overrides. New ADR-0019 «Прототип» (README ADR-034)

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** соответствие каждого ADR обновлённому консенсусу, корректность статусов Accepted/Proposed, ссылки, отсутствие противоречий между ADR и с архитектурой. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/adr_review-by-claude-opus-5.5.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
