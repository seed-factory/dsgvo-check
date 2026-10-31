Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/00-brief.md** написала модель **Claude Opus 5.5 (оркестратор)**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - 00-brief line 110 «Изоляция»: «in-process egress-прокси против SSRF; HTML без JS с CSP default-src 'none'» → «EgressPolicy для прокси, undici и TLS; --proxy только HTTP CONNECT; полная CSP (img-src data:, хеш стиля); sandbox на трёх входах ТЗ — вопрос 8»
   - 00-brief line 156: «самая частая находка, 48 из 80» → «третья по частоте P0 (48 из 80; HDR-01 — 64, MAIL-01 — 54)»
   - 00-brief «Стек» table: pnpm → pnpm 12.16.1
   - 00-brief §8 «Где мы отходим от ТЗ»: add «--sandbox require по умолчанию vs «одна команда без конфига» (Ubuntu ≥ 23.10, голый docker run) — вопрос 8» and «generic-DKIM vs «перебор» — вопрос 16»
   - 00-brief §10: question 3 recommendation must reflect the static table (Borlabs, Cookiebot, Complianz do not match the literal UA); question 4 — format drop order; add question 8 (sandbox) to the urgent ones
   - 00-brief line 3 and «Карта документов»: the prototype manifest is docs/prototype/BRIEF.md and it is not release 1.0 (README §2а); §11 risks: narrow the first risk to RCB and isbot sites
   - docs/prototype/BRIEF.md (outside the list, but it now diverges): «Контракт адаптера — как в D12: extract, state, …, verify» → `extract / act / verify`, decision in core; HTML CSP → full CSP from §5.8; `--proxy` only http:// with no SSRF guarantee claimed; UA from navigator.userAgent with HeadlessChrome replaced; screenshot = viewport + crop ≤ 50 %; TLS-02 relative threshold and checkIP; the 100-site canary is a one-off measurement, not the D23 acceptance (question 5); reconcile Corepack with ADR-0018

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** правовая корректность и точность формулировок для заказчика (DSGVO-эксперта); соответствие обновлённому консенсусу, ТЗ и остальным документам; числа, сроки, оценки. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/00-brief_review-by-claude-fable-5.1.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
