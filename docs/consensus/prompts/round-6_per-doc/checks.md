Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/03-checks.md** написала модель **Codex GPT-6.1-Sol**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - Lines 646 and 685 (TLS-01, TLS-02): «§ 19 Abs. 4 S. 2 TDDDG» → «§ 19 Abs. 4 S. 3 TDDDG»
   - TLS-02 «Уровень» (line 672): «warning … срок ≤ 14 дней. info: 15–30 дней» → warning if remaining < min(14 d, 25 % L), info if < min(30 d, 50 % L), L = notAfter − notBefore; no expiry finding when L ≤ 10 d. Text `certificate-expiring` → «… noch {days} Tage gültig (Gesamtlaufzeit {lifetimeDays} Tage)». Fixtures «сроки 14, 15, 30 дней» → 6-day certificate = clean; 90-day certificate at 13/15/29/31 days
   - TLS-02 data and algorithm step 3 (lines 658, 664): add the IP-target branch with `checkIP` and no SNI; add an IP-target fixture
   - CONSENT-04 variant table (~lines 360–367): `blocking-no-reject` gets the `acceptAvailableAtFirstLayer` condition; new variant `no-choice-at-first-layer` → info; `banner-not-recognized`/`cmp-not-supported` cannot be raised (locked)
   - CONSENT-01 (lines 236, 245): «Извлечь identifierPresent…» → `identifier.kind` (stored-match / persistent-param / user-supplied / per-load / none) and `matchesStoredIdentifier`. critical only with a stable identifier and `delivery: sent` + `result: response`; per-load/none → warning
   - CONSENT-05 (~lines 740–790): confirmed reject = `origin: action` → `stored` + `decision.responded`; default-denied → inconclusive «Ablehnung nicht bestätigt»
   - Common evidence contract (line 51): `tStartMs`, `state` → `tMs` (monotonic from scan start), `navigationId`, `actionId`, `frameId`, `parentRequestId`, `delivery`, `result`, `provenance`, `features`. TRACK-01 (lines 410, 421): `observationId` → shared `evidenceIds`
   - MAIL-01 (line 510): split «t=y/pct<100»: `t=y` per RFC 9989; `pct` = separate info variant «Legacy-Tag, in RFC 9989 entfallen»
   - MAIL-03 and DNS-01: never say «максимум info»; list the warning variants (key < 1024 / missing user-supplied selector; DNSSEC bogus). MAIL-03: generic list stands pending question 16. TLS-04: «по умолчанию при включённой проверке», probes go through EgressPolicy
   - VULN-02: `not_applicable` only when there are no WP components, no JS libraries and no Next.js/Nuxt; missing WP skips only the WP branch
   - PRIV-01: DSE from A without clicks plus supplement in B; limitation `banner-open`; complete manifest → partial, not inconclusive. Remove «самая частая P0» (it is third: HDR-01 64, MAIL-01 54)
   - Line 67 (screenshots): `locator.screenshot` → viewport capture before actions + crop, ≤ 50 % viewport, otherwise `screenshot-skipped`
   - Fingerprint: `subject` for every ID per README §5.4 (TLS-01 `http-entry:<role>`, TLS-02 `certificate:<role>`, TLS-03, TLS-04, P2)

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** правовая корректность: правовые якоря и статус позиций (устоявшаяся / спорная / одиночное решение), немецкие черновики текстов находок без правовых выводов (стоп-слова, «nicht gefunden», «beobachtet»), RDG, § 824 BGB, минимизация данных в evidence. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/03-checks_review-by-claude-fable-5.1.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
