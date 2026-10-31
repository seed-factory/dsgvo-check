# Раунд 6 — перекрёстное ревью `docs/00-brief.md`

Дата: 2026-10-30 · Документ: [`docs/00-brief.md`](../../00-brief.md) (автор — Claude Opus 5.5, оркестратор) · Редактор: Claude Fable 5.1 · Линза: правовая корректность и точность формулировок для заказчика; соответствие консенсусу после раунда 4б, ТЗ и остальным документам; числа и оценки.

Источники сверки: [`docs/consensus/README.md`](../README.md) (с поправками 4б), [`round-4/errata.md`](../round-4/errata.md), `specs/*.md`, `docs/02-architecture.md`, `docs/03-checks.md`, `docs/04-quality-and-delivery.md`, `docs/05-plan.md`, `docs/legal/wording-guide.md`, `docs/adr/*.md`, `docs/prototype/BRIEF.md`, `docs/prototype/CONTRACTS.md`. Факты, проверенные самостоятельно: `npm view pnpm dist-tags` (30.10.2026) — `latest-12` 12.16.1, `latest-11` 11.28.9; `playwright-core` 1.64.1; `docs/02-architecture.md` стр. 420 — `region: asserted` ставит только `--assume-region`, сам `--proxy` регион не заявляет.

Правки сделаны только в `docs/00-brief.md`. Код, конфиги и git не тронуты. Объём документа вырос на три строки таблиц: две новые строки в §8 и одна в §10 — по списку модератора; остальные правки сделаны внутри существующих строк.

---

## 1. Что изменено

### 1.1 Поправки из списка модератора (errata §5.7)

| № | Раздел | Было | Стало |
|---|---|---|---|
| 1 | §7 «Изоляция» | in-process egress-прокси против SSRF; HTML без JS с CSP `default-src 'none'` | `--sandbox require` ⇒ `chromiumSandbox: true`, без `auto`; единый `EgressPolicy` для прокси, undici и TLS с проверкой IP при соединении; `--proxy` только HTTP CONNECT; полная CSP (`img-src data:`, хеш стиля); sandbox на трёх входах ТЗ — вопрос 8 |
| 2 | §11, риск 2 | «самая частая находка, 48 из 80» | «третья по частоте P0: 48 из 80; HDR-01 — 64, MAIL-01 — 54» (каталог) |
| 3 | §7 «Стек» | pnpm | pnpm 12.16.1 (фолбэк 11.28.9) |
| 4 | §8 | — | Две строки: `--sandbox require` по умолчанию против «одной команды без конфига» (Ubuntu ≥ 23.10 с AppArmor ⚠, голый `docker run`) — вопрос 8; generic-селекторы DKIM против запрета «перебора» (≤ 25 TXT к DNS, только `info`) — вопрос 16 |
| 5 | §10, вопрос 3 | «Пересмотреть, если спайк С1 покажет бот-режим у Borlabs, Cookiebot или Complianz» | Рекомендация опирается на статическую таблицу ресёрча: буквальный UA ловят только `isbot` и RCB (1 из 25 CMP-находок), Borlabs, Cookiebot и Complianz — нет; переход на токен без URL только если С1 покажет бот-режим хотя бы у одного из них |
| 6 | §10, вопрос 4 | «15 P0 + CONSENT-05, PDF как stretch» | Добавлены HTML, JUnit, Summary, фаза M и порядок вылета PDF → JUnit → Job Summary → HTML; JSON и консоль — контракт ТЗ; фаза M не вылетает |
| 7 | §10 | 7 вопросов | Добавлен вопрос 8 «Sandbox на трёх входах ТЗ» с рекомендацией (а) и сроком: решение до этапа 1, шаблоны до этапа 2. Нумерация — как в README §8 |
| 8 | Строка 3 и «Карта документов» | «Отдельно собран минимальный прототип … см. docs/prototype»; «Бриф, контракты и статус минимального прототипа» | Прототип этапа 1 — отдельный срез по манифесту `docs/prototype/BRIEF.md`, не релиз 1.0 и не его ворота (README §2а). В строку статуса добавлена верификация (раунд 4б). Файла «статус» в `docs/prototype/` нет — слово убрано |
| 9 | §11, риск 1 | «CMP «принимают всё» для ботов или не показывают баннер вне ЕС» | Сужен до бот-режима при буквальном UA на сайтах с RCB и `isbot` (по статике) и гео-режима вне EWR |

### 1.2 Остальные расхождения с обновлённым README, найденные самостоятельно

| № | Раздел | Правка | Основание |
|---|---|---|---|
| 10 | §5 «Фазы браузера» | «Каждая фаза — в свежем профиле» → «Четыре свежих профиля: A (A′ — в конце того же), B, C, M» | D08, errata №32 |
| 11 | §5 «CMP» | Добавлен контракт адаптера `extract / act / verify` и правило «решение — чистая функция в ядре»; `info` «Banner nicht erkannt» нельзя поднять конфигом (`locked`) | D12, D13, 5.4–5.5, errata №13–14 |
| 12 | §5 «Бот и гео» | «Borlabs, RCB, Complianz и Cookiebot для ботов «принимают всё»» → прямой бот-сигнал даёт `inconclusive`; буквальный UA ловят только `isbot` и RCB, Borlabs, Cookiebot и Complianz — нет (С1 подтверждает). Условие `critical` CONSENT-03: `--proxy` убран, остаётся `--assume-region` с текстом «Region laut Nutzerangabe» | D10, D11, §7 №1, errata №46; `02-architecture.md` стр. 420: `--proxy` регион не заявляет |
| 13 | §5 «Передача за пределы ЕС» | Заголовок → «Передача в третьи страны (за пределы EWR)»; добавлено, что слов «Empfänger» и «Übermittlung» в текстах нет | D11 («Термин — EWR, не «EU»»), D16; правовая линза: Drittland определяется относительно EWR, а не ЕС. В §8 цитата идеи «за пределы ЕС» оставлена как цитата |
| 14 | §5 «Вежливость» | Добавлена политика 429/503: пауза по `Retry-After`, один повтор, затем `SCAN-THROTTLED` | D09, errata №29; ТЗ «Долбить сайт — нельзя» |
| 15 | §3, принцип 3 | Добавлена оговорка о границе для generic-селекторов DKIM (вопрос 16) | D18, errata №30 |
| 16 | §3, принцип 5 | «скриншот — только область баннера» → обрезка снимка первого экрана по области баннера, только при однозначном контейнере ≤ 50 % viewport | D20, errata №34–35 |
| 17 | §3, принцип 8 | Добавлен `THIRD_PARTY_NOTICES` для лицензий и атрибуций (MPL-2.0 autoconsent, CC BY 4.0 GHSA) | 5.8, errata №50 |
| 18 | §4, строка PDF | Добавлен порядок вылета форматов (вопрос 4) | D02, errata №58 |
| 19 | §7 «CONSENT-04» | `critical` для блокирующего баннера только при наличии кнопки согласия на первом уровне; добавлен вариант «только настройки» → `info`; «Banner nicht erkannt» не переопределяется | D13, errata №14–15 |
| 20 | §7 «PRIV-01» | DSE извлекается в фазе A без кликов и независимо от отказа, дополняется в B | D15, errata №19 |
| 21 | §10, вопрос 5 | Добавлено согласие заказчика на разовый приватный замер прототипа по 100 публичным сайтам — не приёмка D23 | README §2а, вопрос 5 |
| 22 | §10, вопрос 7 | Добавлен запрет `bot`, `crawler`, `spider`, `robot` в `<org>/<repo>` (Borlabs ловит `bot` в UA) | D27, errata №46 |
| 23 | §11, риск «Недоверенный JS» | «egress-прокси» → `EgressPolicy` с проверкой IP при соединении; `chromiumSandbox: true` | D25, 5.7 |
| 24 | §12, этап 0 | «спайки С1–С3 (UA/бот, захват, sandbox)» → «С1–С7 (UA/бот, профиль, sandbox на трёх входах, TLS 1.0/1.1, `EgressPolicy`, адаптеры, захват)»: С2 — это профиль, захват — С7, а не С2 | §3 D26 «Спайки этапа 0» |
| 25 | §12, этап 1 | «Каркас» → «Каркас = прототип» по BRIEF; `EgressPolicy` и прокси перенесены в строку этапа 2 | D26, §2а, критический путь п. 2–3 |
| 26 | §12, этап 3а | Явно «PDF как stretch», оценка «45–52 (без PDF 44–50)» | D26, errata №7 |
| 27 | «Карта документов», строка consensus | Добавлены верификация итога и errata (раунд 4б) | README §1 |

### 1.3 Что проверено и оставлено без изменений

- Коды возврата (§6) и приоритет `2 (fatal)` > `1` > `2 (ошибка проверки)` > `0` — совпадают с 5.2; якорь `#52---fail-on-и-коды-012` верен.
- Оценка §12: 79–94 / 91–108 / до 135 чд и ≈ 20 чд на P1 — по D26.
- Правовые ссылки брифа (§§ 202a/202c StGB для FILE-01, § 824 BGB, RDG, CRA) — соответствуют README; выдуманных номеров дел нет. CVE-2025-29927 исправлен в Next.js 15.2.3 — подтверждено в README §7.
- Формулировки для заказчика: «факт, а не правовая оценка», стоп-слова, смысл `critical` — без правок.
- Пометок «предложение автора, не согласовано» в брифе нет; отдельного раздела «Открытые вопросы» нет — его роль выполняет §10 с нумерацией вопросов README §8.

---

## 2. Расхождения с другими документами

Документы не правил. Номера строк — по состоянию файлов на 30.10.2026 (около 14:30). `docs/05-plan.md` к этому моменту уже приведён в соответствие параллельным агентом, кроме одной оговорки ниже.

| Документ | Место | Проблема | Как должно быть по консенсусу |
|---|---|---|---|
| `docs/02-architecture.md` | стр. 114, 179, 192 | pnpm 11 | pnpm 12.16.1 через `packageManager`, фолбэк 11.28.9 (D07, errata №57) |
| `docs/02-architecture.md` | стр. 215 | «Каждая фаза — свежий `launchPersistentContext`; A′ работает в профиле A» | Четыре свежих профиля: A (A′ в конце), B, C, M (D08, errata №32) |
| `docs/02-architecture.md` | стр. 245 | Скриншот через `locator.screenshot()` | `page.screenshot()` viewport до действий, затем обрезка по `box`; только при однозначном контейнере ≤ 50 % viewport, иначе `screenshot-skipped` (D20, errata №34–35) |
| `docs/02-architecture.md` | стр. 378, 419, 1380 | `--proxy` HTTP или SOCKS5, на все коллекторы кроме DNS | Только `http://` (HTTP CONNECT) для браузера, undici и TLS; SOCKS5 — бэклог; DNS напрямую с записью в `egress.collectors` (5.7, errata №41) |
| `docs/02-architecture.md` | стр. 539 | UA браузера «с версией из `browser.version()`» | `navigator.userAgent` CfT с заменой `HeadlessChrome/` на `Chrome/` или шаблон с major; `browser.version()` возвращает только версию (D10, errata №45) |
| `docs/02-architecture.md` | стр. 577 | Контракт адаптера `extract, state, geoSignals, botSignals, firstLayer, reject, accept, verify` | `extract / act / verify`; классы кнопок и решение — только `classifyFirstLayer` в core (D12, errata №13) |
| `docs/02-architecture.md` | стр. 788, 921, 958 | `observationId` | Связь через `evidence[].id` и общие `evidenceIds` (5.1, errata №27) |
| `docs/02-architecture.md` | стр. 87, 883, 1048, 1257 | `rulesetVersion` как имя поля | Поле `ruleset.version` (5.6, errata №27) |
| `docs/02-architecture.md` | стр. 1197 | D03 «спор 2:2» | «спор 2:1:1, решение модератора» (errata №1) |
| `docs/02-architecture.md` | стр. 1342 | CSP `default-src 'none'` | `default-src 'none'; img-src data:; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` (5.8, errata №43) |
| `docs/03-checks.md` | стр. 646, 685 | «§ 19 Abs. 4 S. 2 TDDDG» | «§ 19 Abs. 4 S. 3 TDDDG» — шифрование в Satz 3 (errata №51) |
| `docs/03-checks.md` | стр. 672 | TLS-02: `warning` при сроке ≤ 14 дней, `info` 15–30 дней | Порог относительно срока действия L: `warning` < min(14 д, 25 % L), `info` < min(30 д, 50 % L); при L ≤ 10 д находки о сроке нет (D19, errata №47) |
| `docs/03-checks.md` | стр. 410, 421 | `observationId` в TRACK-01 | Общие `evidenceIds` (errata №27) |
| `docs/04-quality-and-delivery.md` | стр. 103 | pnpm 11 | pnpm 12.16.1, фолбэк 11.28.9 |
| `docs/04-quality-and-delivery.md` | стр. 229 | CSP `default-src 'none'` | Полная CSP 5.8; к тесту «ноль сети» — тест отображения скриншотов и стилей |
| `docs/04-quality-and-delivery.md` | стр. 199 | `rulesetVersion` | `ruleset.version` (5.6) |
| `docs/05-plan.md` | стр. 30–31, 39 | Этапы 1 и 2 — 16–19 и 7–9 чд | D26: 18–21 и 5–7. План сам помечает это как перенос 2–2,5 чд (S1-09 → этап 2) до пересчёта на G0; бриф держит цифры D26 |
| `docs/legal/wording-guide.md` | стр. 197, 457 | «§ 19 Abs. 4 S. 2 TDDDG» в `legalNote` TLS-01/02 | «§ 19 Abs. 4 S. 3 TDDDG» (errata №51) |
| `docs/legal/wording-guide.md` | стр. 217 | «VG Hannover (10 A 5385/22, 2025 ⚠ Datum, Berufung unbekannt)» | Дата подтверждена: Urteil 19.03.2025 (voris); ⚠ остаётся только по Berufung и Rechtskraft (errata №54) |
| `docs/adr/0001-typescript-playwright.md` | стр. 21 | «Каждая фаза — свежий `launchPersistentContext`» | Четыре профиля, A′ в конце профиля A (D08) |
| `docs/adr/0006-exit-codes-and-gate.md` | стр. 12 | «Спор 2:2»; «MAIL-03 (максимум `info`)» | «спор 2:1:1»; у MAIL-03 есть `warning` (ключ < 1024 бит, заданный селектор отсутствует) — при `--fail-on critical` нерелевантна, максимум `warning` (errata №1, №25) |
| `docs/adr/0008-fingerprint-suppressions-baseline.md` | стр. 22 | «TRACK-01 — инвентарь со связью по `observationId`» | Связь через общие `evidenceIds` (errata №27) |
| `docs/adr/0010-user-agent-and-bot-mode.md` | стр. 18 | «HTTP- и TLS-пробы» несут UA; UA браузера из `browser.version()` | Только HTTP-пробы: у TLS-handshake заголовков нет; браузер — `navigator.userAgent` или шаблон (errata №45) |
| `docs/adr/0010-user-agent-and-bot-mode.md` | стр. 21 | «`--proxy` (HTTP или SOCKS5, на все коллекторы)» | Только HTTP CONNECT для браузера, undici и TLS; DNS напрямую (errata №41) |
| `docs/adr/0011-cmp-adapters.md` | стр. 18 | Контракт `extract, state, …, verify` | `extract / act / verify`, решение в core, `vendorRole` — факт, не класс (errata №13) |
| `docs/adr/0015-evidence-minimisation.md` | стр. 25, 32 | `locator.screenshot()`; CSP `default-src 'none'` | Снимок viewport до действий и обрезка, ≤ 50 % viewport; полная CSP (errata №34–35, №43) |
| `docs/adr/0016-isolation-sandbox-and-egress-proxy.md` | стр. 20 | CSP `default-src 'none'` | Полная CSP 5.8 |
| `docs/adr/0017-distribution.md` | стр. 14 | «`strictDepBuilds` pnpm 11» | pnpm 12.16.1 |
| `docs/adr/0018-toolchain-and-repository.md` | стр. 21, 45 | pnpm 11; «без Corepack» | pnpm 12.16.1, фолбэк 11.28.9 (errata №57). Corepack: ADR пишет «без Corepack», BRIEF и CONTRACTS — `corepack pnpm`; согласовать (⚠ Corepack не поставляется с Node ≥ 25, README §7 №32) |
| `docs/prototype/BRIEF.md` | стр. 3, 63–67 | «Проходит канареечный прогон по корпусу из 100 сайтов» как критерий | Разовый измерительный замер, не приёмка D23; нужен ответ заказчика (вопрос 5); результаты приватны — это уже так (README §2а) |
| `docs/prototype/BRIEF.md` | стр. 26 | Контракт адаптера «как в D12: `extract`, `state`, …, `verify`» | `extract / act / verify`, решение в core (README §2а) |
| `docs/prototype/BRIEF.md` | стр. 31 | HTML с CSP `default-src 'none'` | Полная CSP 5.8 — без `img-src data:` и хеша стиля отчёт теряет скриншоты и стили |
| `docs/prototype/BRIEF.md` | стр. 43 | `--proxy <url>` без ограничения схемы | Только `http://`; SSRF-гарантия прототипа не заявляется (граница — `page.route` и проверка IP при навигации) |
| `docs/prototype/BRIEF.md` | стр. 126 | UA «реальный Chrome UA плюс токен» | `navigator.userAgent` с заменой `HeadlessChrome/` на `Chrome/` плюс токен (D10) |
| `docs/prototype/BRIEF.md` | стр. 86, 129 | `corepack pnpm` | Согласовать с ADR-0018 («без Corepack») |
| `docs/prototype/BRIEF.md` | — (отсутствует) | Нет правил снимка первого экрана (viewport до действий, ≤ 50 %) и относительного порога TLS-02 с `checkIP` | Добавить в раздел «Объём» или явно сослаться на README §2а «Что прототип обязан взять» |
| `docs/prototype/CONTRACTS.md` | стр. 334–337 | `interface CmpAdapter { detect, extract, state, geoSignals, botSignals, firstLayer, reject, accept, verify }` | `extract(page, viewport) → CmpFacts`, `act(page, target) → ClickFact`, `verify(page) → ConsentState`; решение — `classifyFirstLayer` (уже чистая, стр. 346) |
| `docs/prototype/CONTRACTS.md` | стр. 320 | «real Chrome UA plus the token» | `navigator.userAgent` с заменой `HeadlessChrome/` |
| `docs/prototype/CONTRACTS.md` | стр. 360 | CSP `default-src 'none'` | Полная CSP 5.8 |

Не является расхождением: `docs/adr/0012-consent-04-criterion.md` стр. 11 «Спор 2:2» — для D13 README §3 действительно пишет «спор 2:2».

---

## 3. Что осталось открытым

1. **Вопросы заказчику**, от которых зависит текст брифа: 3 (UA — по данным С1), 4 (manifest и порядок вылета форматов), 5 (10 сайтов и согласие на 100-сайтовый замер прототипа), 8 (sandbox на трёх входах ТЗ), 16 (generic-селекторы DKIM). До ответа действует буква ТЗ, как и сказано в §8 брифа.
2. **Оценка этапов 1 и 2.** После переноса `EgressPolicy` и прокси на этап 2 и расширения прототипа план показывает 16–19 / 7–9 чд, консенсус D26 — 18–21 / 5–7. Бриф держит D26 и оговорку «после спайков этапа 0 оценку пересчитываем»; окончательные цифры — на G0.
3. **Непроверенные факты, на которые ссылается бриф (⚠):** AppArmor `apparmor_restrict_unprivileged_userns` на Ubuntu ≥ 23.10 для Chrome for Testing и образ GitHub `ubuntu-24.04` (спайк С3); рантайм-поведение Usercentrics, CCM19 и CookieHub при буквальном UA (спайк С1).
4. **Corepack.** ADR-0018 против BRIEF и CONTRACTS; решение нужно до install-smoke этапа 0 (README §7 №32).
5. **Терминология «за пределы ЕС».** В §8 брифа оставлена как цитата идеи заказчика; в собственных формулировках бриф теперь использует EWR / третьи страны. Если заказчик захочет единообразия, цитату можно сопроводить пометкой.
6. **Раздел «Открытые вопросы».** В брифе его нет и пометок «предложение автора, не согласовано» тоже нет; §10 с нумерацией README §8 выполняет эту роль. Отдельный раздел не добавлял, чтобы не раздувать документ.
