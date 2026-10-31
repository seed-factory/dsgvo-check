Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/05-plan.md** написала модель **Claude Opus 5.5**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - S0-02, S1-01: pnpm 11 → pnpm 12.16.1, fallback 11.28.9
   - S0-04 (С1): runtime confirmation of the static research table (only isbot and RCB match the literal UA), plus Usercentrics, CCM19, CookieHub and lazy-loaded chunks
   - S0-06 (С3): add plain `docker run` (default seccomp and the image profile, amd64), an Ubuntu 24.04 host (npx), GitHub `ubuntu-24.04` outside the Action, AppArmor `docker-default` (⚠)
   - S0-08 (С5): `EgressPolicy` for the proxy, undici, node:tls and net; whether upstream proxies accept CONNECT to an IP literal
   - Stage 1 = the prototype per docs/prototype/BRIEF.md (README §2а). Move S1-09 (egress proxy) to stage 2 alongside the Action; in stage 1 SSRF = IP check in the injected `lookup` and on navigation. S1-06 without `baseline migrate`. S1-04: `en` optional in the completeness test. S1-12: check scope per BRIEF
   - S3-01: «каждая в свежем профиле, A′ в профиле A» → «четыре свежих профиля». S3-02: adapter contract `extract / act / verify`, decision in core
   - S3-06: `acceptAvailableAtFirstLayer`, `no-choice-at-first-layer`, locked unknown variants. S3-07: reject with `origin: action` and `decision.responded`. S3-09: DSE in A without clicks plus supplement in B
   - S3-13: full CSP; viewport capture + crop. S3-14: JUnit mapping from README §5.2, final exit code after reporters
   - S3-17: PDF is already included in the 45–52 person-days of stage 3а as stretch (44–50 without it), not added on top. S3-20 MAIL-03: depends on question 16
   - §7 critical path: «Egress-прокси и браузерный коллектор фазы A» → «прототип (этап 1) → EgressPolicy и прокси (этап 2)». Line 281 «PRIV-01 — самая частая P0» → «третья по частоте P0 (48/80)»
   - Risk register: risk 2 — as above; narrow risk 1 to RCB and isbot sites; risk 11 → sandbox on the three TZ entry points (question 8)
   - Legal gates: end of stage 0 — severity policy (meaning of critical, T0/T1/T3, null policy); end of 3а — signing of the concrete ruleset values, the crmCode mapping and the texts. Mark this explicitly as a moderator change to Fable-К's proposal
   - S4-02/S4-03: `THIRD_PARTY_NOTICES`; ADR-033 as a stage-4 proposal. S4-06: remove the RFC 9989 month and PM 38/26 from unverified facts (confirmed on 30.10.2026)
   - Format drop order under budget pressure: PDF → JUnit → Job Summary → HTML; phase M is not dropped (question 4)

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** реалистичность плана, оценки, зависимости и критический путь, тестируемость каждого пакета работ, Definition of Done по каждому пункту «Обязательно» ТЗ, CI и поставка. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/05-plan_review-by-codex-gpt-6.1-terra.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
