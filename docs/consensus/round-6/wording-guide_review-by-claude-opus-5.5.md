# Раунд 6 — перекрёстная редактура `docs/legal/wording-guide.md`

Дата: 2026-10-30 · Редактор: Claude Opus 5.5 · Автор документа: Claude Fable 5.1 · Предмет: [`docs/legal/wording-guide.md`](../../legal/wording-guide.md)

Источник истины: [README консенсуса](../README.md) с блоком «Поправки после верификации (раунд 4б)», [errata §5.5](../round-4/errata.md), `specs/*.md`. Отдельные факты проверены веб-поиском (раздел «Что изменено», п. 24).

## Что изменено

### Поправки консенсуса (список модератора, errata §5.5)

1. **§ 19 Abs. 4 S. 3 TDDDG.** Раздел 4 (TLS-01, TLS-02), `legalNote` TLS-01 (5.14), правило № 11 стоп-листа. «S. 2» оставлен только там, где речь о Stand der Technik (статус `technical`).
2. **Состояние запроса — `delivery / result / provenance`.** Слой Beobachtung (1.1), стоп-правило № 15, словарь 3.1, шаблон и таблица 3.2, чек-лист 8.A. Формулировки: «gesendet», «Antwort erhalten», «aus Service Worker bzw. Cache bedient».
3. **Время.** `{tStartMs}` заменён на `{sinceMs}`: время вычисляется из монотонного `tMs` от `navigationId` или `actionId` при рендере и в снимке не хранится (3.2, 5.1, 5.16, общие плейсхолдеры).
4. **TLS-02.** `expires-soon` и `expires-within-30-days` (абсолютный порог 30 дней в имени) заменены на `certificate-expiring` (`warning`) и `certificate-expiry-approaching` (`info`). Текст: «Restlaufzeit {days} Tage bei Gesamtlaufzeit {lifetimeDays} Tage». Для IP-цели `{target}` раскрывается в «IP-Adresse {ip}» через ICU `select`. Описаны относительный порог D19 и правило «при L ≤ 10 д находки нет».
5. **Новые тексты.**
   - `CONSENT-04.no-choice-at-first-layer` (`info`, de и en, Hinweis «Manuelle Bewertung erforderlich»).
   - Новый 5.20: limitation `banner-open`, `screenshot-skipped` и перенесённый `lexicon-changed-since-scan`.
   - `CONSENT-05.reject-not-confirmed` со строкой «Ablehnung nicht bestätigt (nur Ausgangszustand des CMP)».
   - `MAIL-01.legacy-pct`; из `weak-option` убран `pct<100`.
6. **Messumgebung.** Новый 3.5 с тремя строками консенсуса: DNS напрямую через резолвер, «Zieladressen lokal geprüft; Proxy {proxy}» (без учётных данных), IP в фазе C. Добавлены ещё две строки, которых требует README: выбор CDN-узла по локальному резолверу (5.7) и недоступный захват pagehide/keepalive (§7 № 5).
7. **`CONSENT-01.tracking-completed`.** Новый текст «mit dauerhafter Kennung (Abgleich mit gespeichertem Cookie bzw. Speicher)» с ветвями по `identifier.kind`. Условие формулируется через «gesendet» и «Antwort erhalten». `cookieless-ping` теперь покрывает `per-load` и `none`.
8. **`CONSENT-04.blocking-no-reject`.** Заголовок и текст (de, en) прямо говорят: согласиться на первом уровне можно (bedienbare annehmende Schaltfläche „{acceptLabel}“), отказаться — нельзя.
9. **Футер HTML «Datensätze und Attribution».** Строка добавлена в 3.4; GHSA — с атрибуцией CC BY 4.0. Дисклеймер ссылался на «Datenquellen», теперь ссылается на этот раздел.
10. **Nutzungshinweise** (раздел 6): UA HTTP-проб и браузера; TLS-handshakes и DNS UA не несут; IP в фазе C; DNS при `--proxy`. Добавлено правило, что `{org}/{repo}` не содержат `bot`, `crawler`, `spider`, `robot`.

### Остальные расхождения с README

11. **VG Hannover 10 A 5385/22.** Дата 19.03.2025 подтверждена (README §7 № 11). Исправлено в разделе 4 и в `legalNote` CONSENT-01 и CONSENT-04. Пометка ⚠ осталась только для Rechtskraft/Berufung и детали о GTM.
12. **RFC 9989.** Месяц публикации подтверждён: исправлены раздел 4, 7 (`rfc-9989`), 8.B и перечень ⚠. EuGH C-526/24 (№ 28) убран из открытых фактов.
13. **CONSENT-05.** В `tracking-after-reject` подтверждённый отказ теперь описан полностью: `origin: action` → `stored` и `decision.responded`. Недоступный захват pagehide убран из `reject-not-confirmed` и вынесен в Messumgebung. Слова «Kennung» заменены на «dauerhafte Kennung», как в CONSENT-01.
14. **`banner-not-recognized` и `cmp-not-supported`** помечены `locked`. Hinweis ссылается на скриншот «falls vorhanden» (правило 50 % из D20).
15. **Абзац дисклеймера о скриншотах.** Снимок первого экрана делается до действий, затем обрезается; только однозначный контейнер не больше половины viewport (D20).
16. **Диагностики.** `SCAN-THROTTLED` описан по общей политике 429/503 с `Retry-After` и одним повтором для браузера и проб (D09). В `SCAN-PRIVATE-REQUEST-BLOCKED` «Egress-Proxy» заменён на «Egress-Prüfung»: `EgressPolicy` охватывает все пути соединений (5.7).
17. **`legalNote` CONSENT-04.** Добавлена фраза о блокирующем первом уровне без выбора (DSK Rn. 125 ⚠).
18. **PRIV-01.** Добавлено примечание: при `banner-open` и полном manifest статус `completed` или `partial`, а не `policy-not-evaluable` (D15).

### Ревью через свою линзу: ключи, полнота, lint, ICU

19. **Пригодность стоп-листов для lint.**
    - Плейсхолдеры исключены из проверки шаблона: иначе `{note}` попадает под № 11 (`Note`).
    - № 13 действует только в поле `hint`. Иначе L0 падал бы на `legalNote` MAIL-01 («Pflicht»), на описании DNS-01 («keine gesetzliche Pflicht») и на `legalNote` CONSENT-04 («muss»).
    - № 15: «gesendet» и «Antwort erhalten» разрешены только по allowlist ключей с нужным условием.
    - № 1 (en): регулярное выражение — `violat(e|es|ed|ion|ions)`.
    - Allowlist дополнен: «Übermittlungsinstrument», фраза о фазе C, термин axe «violations».
20. **Стоп-слова в самих черновиках.**
    - «nicht notwendigen Kategorien» (№ 6) в `CONSENT-04.reject-ineffective` и `CONSENT-05` → «optionalen».
    - Заголовок «erteilte Einwilligung» (№ 17) в `consent-without-action` → «Status `granted`».
    - en «hidden text» (№ 7) в `PRIV-01.ambiguous-match`; en «has passed» (№ 11) в `SEC-01`.
    - Оценочное «Kein Handlungsbedarf» в `MAIL-02`.
    - «Übertragung fand nicht statt» в `TLS-03` → «nicht gesendet».
    - Разрешение в № 3 приведено к реальному заголовку `first-party-proxy`.
21. **Полнота релизных вариантов.**
    - Добавлен `MAIL-02.ptr-mechanism`: README §4 выделяет `ptr` в отдельный `info`, а при `-all` прежний текст его терял.
    - Правило 3.3.4 дополнено вариантами `no-choice-at-first-layer` и `ambiguous-match`.
    - Сверено: 15 P0 и CONSENT-05 покрыты текстами на все варианты README §4.
22. **ICU.**
    - Булев `{transferred}` → `select`.
    - Неопределённый `{euNote}` → `{eeaNote}` с определением.
    - `{state}` в `request-not-completed` → вложенные `select` по `delivery` и `result`.
    - `{record}` в MAIL-01 — только с замаскированными `mailto:`.
    - Правило: перечисления — через `select` с ветвью `other`.
    - Заголовок `MAIL-03.given-selector-missing` укорочен до 70 знаков.
23. **Ключ варианта.** `EMBED-01.fonts-preconnect-only` → `preconnect-only`, как в иллюстрации ruleset в архитектуре (§10.1).
24. **Факты и внутренние противоречия.**
    - `legalNote` CONSENT-05 ссылался на EDPB Cookie Banner TF «Type H» в подтверждение тезиса «отказ нельзя обходить». Type H — о berechtigtem Interesse (отчёт EDPB от 17.01.2023; `legal-basis-map.md`), ссылка теперь передаёт именно это.
    - Правило 4 раздела 4 («`technical` не выше `warning`») противоречило FILE-01 (`technical`, `critical`-вариант). Теперь ограничение D19 привязано к `crmCode`.
    - «ADR-001» исправлен на ссылку на ADR-0002.
    - Поле `reviewedBy`, которого нет в D22, убрано из чек-листа.
    - Проверены и оставлены без изменений: C-703/25 P (подан 31.10.2025), отзыв ePrivacy-VO (C/2025/5423, 06.10.2025), продление UK-adequacy (19.12.2025), LG München I 4 O 13063/22 (30.03.2023).
25. **Пометки автора.**
    - Место `legalNote` (`data/legal/`) помечено «предложение автора, не согласовано» и вынесено в ОВ 1.
    - Добавлен ОВ 3: ключи `limitation.*` и значения `reason`.
    - Уточнены ОВ 2 (ключи 03-checks, два варианта TLS-02) и ОВ 4 (правила lint).
    - Вопросы заказчику дополнены номерами 3, 7, 12 и 16.
    - Решений автора, противоречащих консенсусу, не найдено.

Объём: 756 → около 806 строк. Прирост — только новые обязательные тексты: `no-choice`, `legacy-pct`, `ptr-mechanism`, разделы 3.5 и 5.20, Nutzungshinweise.

## Расхождения с другими документами

Документы сам не правил. Состояние на 30.10.2026; 03-checks и 02-architecture параллельно правят другие агенты, поэтому часть пунктов errata §5.2 там уже закрыта: S. 3, `{target}`, `legacy-pct`, `no-choice-at-first-layer`, `request.delivery`.

| Документ | Место | Проблема | Как должно быть по консенсусу |
|---|---|---|---|
| `docs/03-checks.md` | «Текст находки» почти всех ID | Ключи вариантов расходятся с wording-guide:<br>• CONSENT-01: `hit-with-identifier` / `library-loaded` ↔ `tracking-completed` / `tag-manager-loaded`<br>• CONSENT-02: `tracking-storage-accepted` ↔ `tracking-identifier-stored`<br>• CONSENT-03: `banner-not-found` ↔ `no-banner-strong-tracking` / `no-banner-consent-services`<br>• CONSENT-05: `hit-after-reject`, `storage-after-reject`, `cookieless-ping`, `connect-only` ↔ `tracking-after-reject`, `*-after-reject`<br>• MAIL-01: `monitoring-only` ↔ `policy-none`<br>• MAIL-02: `softfail-without-enforcement`, `permerror` ↔ `softfail-without-dmarc`, `record-invalid`<br>• HDR-01: `referrer-policy-unsafe` ↔ `referrer-policy-permissive`<br>• TLS-01: `http-content`, `http-form` ↔ `https-unavailable`, `form-on-http-page`<br>• TRACK-01: `service-observed` ↔ `service-inventory`<br>• PRIV-02: `claim-contradicted`, `formulation-review` ↔ `contradiction-*`, `wording-to-review`<br>• EMBED-04: `captcha-without-visible-form` ↔ `captcha-without-form`<br>• P1/P2 — аналогично | D05 и D22: один реестр `variants`, и ключ текста = ключ ruleset = ключ CRM = `messageId`. Оба документа называют свои ключи «предложением автора». Реестр фиксирует 03-checks (его Q10), тексты переименовываются вслед за ним |
| `docs/03-checks.md` | §3.15 LEGAL-01, «Текст находки» | `LEGAL-01.link-unresolved` | D09 и §4 README: вариант `unresolved` |
| `docs/03-checks.md` | §3.14 TLS-02 | Один ключ `certificate-expiring` для `warning` и `info` | Уровень задаётся по `(checkId, variant)` (D19, 5.6). Нужны два варианта, например `certificate-expiring` и `certificate-expiry-approaching`, при желании с общим `variantGroup` |
| `docs/03-checks.md` | §3.11 MAIL-02 | `ptr` назван «информационным вариантом», но ключа нет | README §4 MAIL-02: `info` для `ptr` → отдельный ключ (в wording-guide — `ptr-mechanism`) |
| `docs/02-architecture.md` | §9.4 (тест полноты), раздел про тексты | `legalNote` лежит в `data/texts/{de,en}.yaml`, в wording-guide — в `data/legal/` | Консенсус место не фиксирует. Решить в одном документе (ОВ 1 wording-guide); lint «ни одной строки вне `data/`» выполняется в обоих вариантах |
| `docs/02-architecture.md` | §11, `findings[]`: «отрендеренные `title`/`summary`» | Имена полей текста: в архитектуре `title/summary`, в wording-guide `title/description/hint`, в прототипе (`data/texts/de/*.yaml`) `title/body` | Одно решение в архитектуре; поле рекомендации называется нейтрально, без «remediation» (D22, Fable-К §4.6) |
| `docs/prototype/BRIEF.md` и `data/` прототипа | `data/texts/de/{browser,dns,http,core}.yaml`, `data/ruleset/de-2026/*.yaml`, `legalNotes` внутри файлов текстов | Разбиение по модулям расходится с `data/texts/{de,en}.yaml` и `data/ruleset/de-2026.yaml` (архитектура §9.4, wording-guide §5 и §8) | Допустимо как упрощение прототипа, но BRIEF должен это назвать, а тест полноты, lint и чек-лист вычитки — знать фактические пути |
| `docs/05-plan.md` | S4-06 | EuGH C-526/24 числится среди непроверенных фактов | Закрыт в раунде 4б (README §7 № 28, errata №54, §5.4 п. 17) |
| Задание раунда 6 (`r6/wording.md`) | Список «связанные документы — не редактируй» | В список включён и сам `docs/legal/wording-guide.md` | Редактировался только он, как требует п. 1 задания |

## Что осталось открытым

- **Реестр вариантов.** Ключи wording-guide и 03-checks нужно свести в один реестр. До этого L0-тест полноты не сможет сопоставить тексты с ruleset и CRM.
- **Имена полей и место `legalNote`** (ОВ 1) решает архитектура.
- **Предложения автора без согласования:** ключи `limitation.*` и значения `reason` в `select` (5.16, 5.20), имена `certificate-expiry-approaching` и `ptr-mechanism`, режимы lint и их область (№ 13 — `hint`, № 15 — allowlist ключей).
- **`identifierKind: user-supplied`.** Формулировка «Nutzerkennung im Parameter `{param}`» условна: README не раскрывает семантику `user-supplied`. Приоритет `denied` и `user-supplied` — вопрос 9.
- **Messumgebung о фазе C.** Формулировка консенсуса «übermittelt … an Drittanbieter» сохранена дословно и внесена в allowlist. Стоит решить, не заменить ли её на «offengelegt», как в правиле № 20.
- **Факты с ⚠ без изменений:** DSK OH Rn. 121, 124–125 (в т. ч. Rn. 125 для `no-choice`), 134–137; Rechtskraft OLG Köln 6 U 80/23; Berufung VG Hannover и деталь о GTM; EDPB 05/2020 Rn. 86; EDPB TF Type C; UrhG § 51; URL TDDDG; EinwV «Consenter»; содержание мандата Совета по Digital Omnibus.
- **Вопросы заказчику, от которых зависят тексты:** 1, 3, 6, 7, 9, 10, 11, 12, 13, 15, 16. `en` выходит только вычитанным.
