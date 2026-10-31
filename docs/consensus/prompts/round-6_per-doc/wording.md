Ты — перекрёстный редактор в проекте `dsgvo-check`: open-source CLI-сканер на TypeScript + Playwright, Apache-2.0. Он пассивно проверяет немецкие сайты на признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности и роняет CI по порогу. Сегодня 2026-10-30.

Документ **docs/legal/wording-guide.md** написала модель **Claude Fable 5.1**. Ты из другого семейства моделей. Твоя задача — исправить документ прямо в файле и записать журнал изменений.

## Источник истины

- `docs/consensus/README.md` — итог консенсуса, уже с поправками после верификации (блок «Поправки после верификации (раунд 4б)»).
- `docs/consensus/round-4/errata.md` — журнал этих поправок.
- `specs/*.md` — ТЗ и каталог: ТЗ выше консенсуса, пока заказчик не ответил.

Связанные документы — сверяй с ними, но **не редактируй**: `docs/00-brief.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`.

## Что сделать

1. **Внеси поправки консенсуса для этого документа.** Список от модератора:

   - Lines 197 and 457: «§ 19 Abs. 4 S. 2 TDDDG» → «§ 19 Abs. 4 S. 3 TDDDG» (Satz 3 is the encryption sentence)
   - Line 129 «Zustand … attempted / blocked-by-browser / completed / failed / from-sw / from-cache» → three fields `delivery`/`result`/`provenance` with wording such as «gesendet», «Antwort erhalten», «aus Service Worker bzw. Cache bedient»
   - Lines 113 and 128: «{tStartMs} ms nach Navigation / Klick» → relative time computed from the monotonic `tMs` from navigation or action
   - TLS-02 `certificate-expiring`: «Restlaufzeit {days} Tage bei Gesamtlaufzeit {lifetimeDays} Tage»; for an IP target «IP-Adresse {ip}» instead of {host}
   - New texts: `CONSENT-04.no-choice-at-first-layer` (info); limitations `banner-open` and `screenshot-skipped`; CONSENT-05 «Ablehnung nicht bestätigt (nur Ausgangszustand des CMP)»; MAIL-01 legacy `pct`
   - New Messumgebung texts: «DNS-Abfragen direkt über Resolver {resolver}, nicht über den Proxy»; «Zieladressen lokal geprüft; Proxy {proxy}»; «Phase C übermittelt die IP-Adresse des prüfenden Rechners an Drittanbieter»
   - Line 221 `CONSENT-01.tracking-completed`: add «mit dauerhafter Kennung (Abgleich mit gespeichertem Cookie bzw. Speicher)»; for per-load use the cookieless text
   - `CONSENT-04.blocking-no-reject`: the text must state that consent is possible on the first layer and refusal is not
   - HTML footer «Datensätze und Attribution» with the CC BY 4.0 attribution for GHSA; Nutzungshinweise: TLS handshakes carry no UA; org/repo names contain no bot/crawler/spider/robot

   Затем сам найди в документе остальные места, которые расходятся с обновлённым README, и исправь их.
2. **Ревью через свою линзу:** согласованность ключей текстов с вариантами проверок и ruleset (checkId.variant), полнота по всем релизным вариантам, пригодность стоп-листов для lint, ICU-параметры; правовую суть не переписывай без явной ошибки. Ищи ошибки фактов, права и техники, внутренние противоречия, расхождения с другими документами, плейсхолдеры («TBD», «по необходимости»), выдуманные номера дел, версии и лицензии. Исправляй в своём документе.
3. **Пометки «предложение автора, не согласовано».** Решение, которое противоречит консенсусу, приведи к консенсусу. Остальные оставь помеченными и проверь, что они вынесены в «Открытые вопросы» в конце документа.
4. **Стиль и объём.** Сохрани структуру и стиль: русский язык, немецкие термины — как есть. Не раздувай документ: если правка короче оригинала — хорошо.
5. **Не трогай** код (`src/`, `test/`, конфиги) и git. Там параллельно работают другие агенты.

## Журнал

Запиши файл `docs/consensus/round-6/wording-guide_review-by-claude-opus-5.5.md` (Markdown, русский):
- **Что изменено** — список: раздел и суть правки.
- **Расхождения с другими документами** — таблица: документ → место → проблема → как должно быть по консенсусу. Сам эти документы не исправляй.
- **Что осталось открытым.**
