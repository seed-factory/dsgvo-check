# Раунд 6 — перекрёстная правка `docs/adr/*` (Claude Opus 5.5)

Дата: 2026-10-30 · Автор документа: Claude Fable 5.1 · Редактор: Claude Opus 5.5 · Источник истины: [`docs/consensus/README.md`](../README.md) с поправками раунда 4б, [`round-4/errata.md`](../round-4/errata.md), `specs/*.md`.

Отредактированы: `docs/adr/README.md`, ADR-0001–0018; добавлен `docs/adr/0019-prototype.md`. Код, конфиги и git не тронуты.

## Что изменено

### Поправки модератора (errata §5.6)

| ADR | Раздел | Суть правки |
|---|---|---|
| 0006 | Статус, Контекст | «Спор 2:2» → «спор 2:1:1, решение модератора»; вопрос 2 — таймаут до завершения сбора стартовой и цена мягкого режима GitLab. «MAIL-03 (максимум `info`)» → максимум `warning`, при `--fail-on critical` нерелевантна (errata №25) |
| 0006 | Решение | `maxSeverity` — статический максимум `variants` после ruleset и overrides, без кэпа уверенности; строки `--fail-on none × --strict`, таймаут до и после фазы A на стартовой; окончательный код после репортёров (атомарная перезапись JSON); «На код влияют только `--fail-on` и `--strict`» → перечень входов гейта; мягкий режим по платформам (GitHub `continue-on-error` + `::warning::` + Summary; GitLab stderr + JUnit `<error>`, цена названа). В fatal добавлены таймаут до фазы A и override `locked`-варианта |
| 0006 | Последствия | «`--fail-on none` даёт только `0` или `2 (fatal)`» удалено (противоречило strict); контрактные тесты на новые строки |
| 0009 | Статус, Решение | «Пять фаз в четырёх свежих профилях (A с A′, B, C, M)», профиль в таблице пронумерован; D08 — 3:1 по общей подвыборке B/C (против Sol-К); DSE — в A без кликов, дополнение в B, limitation `banner-open`; пометка про IP в фазе C; общая политика 429/503; coverage «geplant / beobachtet / auswertbar» |
| 0009 | Варианты | «Одинаковые 6 URL (Sol-К, Terra-К)» → только Sol-К (errata №2) |
| 0010 | Решение п. 1 | «HTTP- и TLS-пробы» → «HTTP-пробы (undici)», у TLS-handshake UA нет; браузерный UA — `navigator.userAgent` с заменой `HeadlessChrome/` (или шаблон с major из `browser.version()`), M — мобильный шаблон и `userAgentMetadata`. «Client Hints не подменяются» уточнено до `brands` (иначе противоречило M) |
| 0010 | Решение п. 4 | «`--proxy` (HTTP или SOCKS5, на все коллекторы)» → HTTP CONNECT для браузера, undici и TLS, DNS напрямую, `egress.collectors`; `critical` CONSENT-03 по `asserted` — решение модератора, «Region laut Nutzerangabe», вопрос 12 |
| 0010 | Контекст, Последствия, Статус | Статическая таблица ресёрча (ловят только `isbot` и RCB); С1 — рантайм-подтверждение плюс Usercentrics, CCM19, CookieHub, ленивые чанки; запрет `bot/crawler/spider/robot` в `<org>/<repo>`; D10 — 2:1:1, вариант (б) — только Fable-К (errata №3); статус — вопросы 3 и 12 |
| 0011 | Решение | Контракт `extract / act / verify`, решение — только `classifyFirstLayer` в core, `vendorRole` как факт; подтверждённый отказ с `origin: action` → `stored` и `decision.responded`; autoconsent — правила не копируются и не модифицируются, детект read-only на собственных правилах, мутирующие действия выключены (⚠ факт 30); `THIRD_PARTY_NOTICES` для MPL. Новая строка вариантов «первая редакция D12» |
| 0012 | Таблица вариантов | `acceptAvailableAtFirstLayer` в `blocking-no-reject`; новый `no-choice-at-first-layer` → `info`; `banner-not-recognized`/`cmp-not-supported` — `locked`, override → `invalid-input`; условия `reject-ineffective` и `consent-without-action` по 5.3; неблокирующий — 3:1 (Terra-К) |
| 0012 | Evidence, Последствия | `kind`/`kindConfidence` — результат core, адаптер даёт `vendorRole`; снимок viewport до действий и обрезка вместо `locator.screenshot()`; факт 10 дополнен формулировкой Rn. 125 |
| 0013 | Статус, Решение | D14 — 3:1 по EasyPrivacy (errata №4); GHSA CC BY 4.0, `datasets[].attribution`, футер «Datensätze und Attribution», `THIRD_PARTY_NOTICES` |
| 0014 | Статус (стр. 7) | «D18 единогласно по классам E и TLS-04» → «E — единогласно; TLS-04 — T при включённой проверке; DKIM — 3:1 (против Sol-К) и вопрос 16». Класс T — «по умолчанию при включённой проверке»; вариант DKIM-only — только Sol-К; политика 429/503 общая с браузером |
| 0015 | Таблица, Решение | Запросы — `delivery / result / provenance`, монотонный `tMs`, `navigationId`, `actionId`, `frameId`, `parentRequestId`, `features`; скриншот — `page.screenshot()` viewport до действий и обрезка, правило 50 %, `screenshot-skipped`, `locator.screenshot()` запрещён; «почти не содержит персональных данных» → «снижает, но не исключает риск»; полная CSP |
| 0016 | Целиком | Sandbox на трёх входах ТЗ (таблица) и вопрос 8; `chromiumSandbox: true` и проверка отсутствия `--no-sandbox`; единый `EgressPolicy` (прокси, undici, `node:tls`, `net.Socket`); DNS напрямую; `--proxy` только `http://`; upstream — `CONNECT <проверенный IP>`, честная граница SSRF; полная CSP; объяснение seccomp и AppArmor. Альтернатива «Только `require` — self-managed не работает вовсе» переписана как вариант (г) вопроса 8 с учётом явного `off`; добавлен вариант (б). Статус: D25 — спор, `EgressPolicy` — поправка 4б |
| 0017 | Решение, Последствия | `THIRD_PARTY_NOTICES` в npm и OCI; команда `docker run --rm <image> seccomp-profile` и строка `docker run --security-opt seccomp=…`; строка 42 разделена по платформам; ADR-033 помечен как предложение модератора к этапу 4 |
| 0018 | Решение, Варианты, Последствия | pnpm 11 → 12.16.1, фолбэк 11.28.9; альтернатива «pnpm 12 — отклонено» перевёрнута; «пересмотр в I кв. 2027» удалён; Corepack согласован: установка без опоры на Corepack (с Node ≥ 25 не поставляется, ⚠ факт 32), `corepack pnpm` работает только на Node 24 |
| 0003 | Решение, Последствия | Порядок вылета PDF → JUnit → Summary → HTML, фаза M не вылетает; прототип отделён от релиза; PDF внутри 45–52 чд (без него 44–50); правовые ворота в редакции модератора |
| 0004 | Решение | Адаптер `extract / act / verify` в коллекторе, решение в core; безопасные признаки `identifier.kind`, `matchesStoredIdentifier`, `consentSignal` с `parserVersion`; документы не зависят от отказа; предварительный и окончательный код; `en` в тесте полноты — после объявления релизным |
| 0008 | Решение | `subject` для всех ID (TLS-01…04, SEC-01, LEGAL-02, ADMIN-01, BFSG-01, PERF-01, роль хоста); `baseline migrate` — бэклог, чужая `fingerprintVersion` — ошибка; `locked`-варианты в overrides; `observationId` → общие `evidenceIds` и `related[]` |
| 0019 | Новый | «Прототип (этап 1)» по README §2а (кандидат ADR-034): срез по BRIEF, что не является воротами, что обязан взять из 4б, канарейка на 100 сайтах — вопрос 5 |
| README | Индекс | Строка 0019, соответствие ADR-034 → 0019, следующий номер — 0020; статусы 0010 (вопросы 3, 12), 0008 (вопрос 6), 0014 (вопрос 16) |

### Найдено при ревью

| ADR | Раздел | Суть правки |
|---|---|---|
| README | Открытые вопросы | «Шесть записей `Proposed`» при семи перечисленных → «семь»; добавлен вопрос 12; новые строки: частично ожидающие `Accepted`-записи (вопросы 5, 6, 16), расхождение `--allow-private` с ОВ-9 архитектуры, seccomp, pnpm без Corepack |
| 0003 | Контекст | «11 P2» → «8 P2»: в каталоге P2 — DNS-01, HDR-02, ADMIN-01, FILE-01, SEC-01, LEGAL-02, BFSG-01, PERF-01. Статус дополнен уровнями D01/D02; arm64 — «после нативного smoke», а не обязательно после релиза (D24) |
| 0011 | Контекст | «Семь CMP в порядке частоты» → «в порядке реализации»: каталог упорядочивает по реализации, Usercentrics (1) стоит перед CCM19 (2) |
| 0001 | Варианты | «Бренд `HeadlessChrome` в Client Hints включает бот-режим Usercentrics v3, RCB и `isbot`» — неверно: эти детекторы читают строку UA, а не `Sec-CH-UA` (ресёрч §3.2, §10). Переписано как признак автоматизации в `Sec-CH-UA`. Фазы — «четыре свежих профиля». Renovate помечен как кандидат ADR-033 |
| 0002 | Решение п. 1 | Стоп-слова сформулированы фразами («Übermittlung in ein Drittland», «übermittelt an»), как в Formulierungsleitfaden: голое «Übermittlung» противоречило формулировке D16 «…Übermittlungsinstrument wurden nicht geprüft» в ADR-0013 |
| 0005 | Последствия, Решение | «JUnit отображает `status`, не `pass/fail`» → маппинг §5.2 (`<failure>`, `<error>`, `<skipped>`, `<system-out>`); добавлены `not_applicable` для VULN-02 и default-denied как `inconclusive` |
| 0007 | Решение | Каталог схемы `schemas/` → `schema/` (`schema/report.schema.json` в `package.json` и BRIEF); `datasets[].attribution`; «команда миграции» → миграции со второй версией формата |
| 0008 | Статус | «Принят всеми» → единогласно по технологии, состав изменён меньшинством, возражение Sol-К — документированное ограничение |
| 0010 | Варианты | «Дефолтный UA headless-shell» → «без override»: `HeadlessChrome` есть в UA в обоих headless-режимах (§6.2 №75) |
| 0014 | Контекст | Modern Solution: дата Nichtannahme BVerfG 15.09.2025 и ссылка на факт 27 |
| 0016 | Контекст | Объяснение seccomp: консенсус (§3 D25, §7 №2, errata №39) и таблица docs.docker.com пишут, что `CLONE_NEWUSER` и `unshare --user` разрешены; `moby/profiles` `seccomp/default.json` маскирует `clone` значением `0x7E020000` (включает `CLONE_NEWUSER`) и разрешает `unshare` только с `CAP_SYS_ADMIN`. Записано как расхождение источников под ⚠ и С3; вывод (нужен свой профиль) не меняется |
| 0016, 0017, 0018 | Решение | Имя `dsgvo-check-example` → `example`, как в D06 и плане |
| 0018 | Решение | «L2 в `--network none`» → закрытая сеть со своим netns, dns2 и `--host-resolver-rules` (D23; Terra-К: `--network none` сам серверов и DNS не создаёт); «seccomp-профиль в корне — требование Marketplace» → требование касается только `action.yml` |
| 0013 | Решение | `tldts` (MIT) несёт вшитый Public Suffix List под MPL-2.0 — это вторая MPL-компонента в `THIRD_PARTY_NOTICES` |

Пометки «предложение автора, не согласовано» (`--allow-private` в 0016, имена каталогов в 0018) консенсусу не противоречат и оставлены; обе вынесены в «Открытые вопросы» README. Путь `src/cmp/<id>/` из 0011 и `src/checks/<id>/` из 0004 убраны как несогласованные имена каталогов.

## Расхождения с другими документами

Состояние файлов — на момент правки. Документы не редактировались.

| Документ | Место | Проблема | Как должно быть по консенсусу |
|---|---|---|---|
| `docs/02-architecture.md` | §12, стр. 1197 | «спор 2:2» по D03 | Спор 2:1:1, решение модератора (errata №1) |
| `docs/02-architecture.md` | стр. 1214, 1396 | «Флаги порога — только `--fail-on` и `--strict`» | Политику задают `--fail-on` и `--strict`; на вход гейта влияют `--baseline`, подавления, `rules:`, `--checks`, `--timeout`, `--sandbox off` (README §5.2) |
| `docs/02-architecture.md` | §4.2, стр. 215 | «Каждая фаза — свежий `launchPersistentContext`; A′ работает в профиле A» | Пять фаз в четырёх свежих профилях: A (A′ в конце), B, C, M (errata №32) |
| `docs/02-architecture.md` | стр. 237, 577, 595, 712, 805 | Контракт адаптера `extract, state, …, firstLayer, reject, accept, verify` | `extract / act / verify`, решение — `classifyFirstLayer` в core (D12) |
| `docs/02-architecture.md` | стр. 245 | Скриншот через `locator.screenshot()` | `page.screenshot()` viewport до действий и обрезка; только при контейнере ≤ 50 % viewport, иначе `screenshot-skipped` (D20) |
| `docs/02-architecture.md` | §7.6, стр. 538–539 | «HTTP- и TLS-пробы»; UA «с версией из `browser.version()`» | HTTP-пробы (undici), у TLS UA нет; `navigator.userAgent` с заменой `HeadlessChrome/` или шаблон, M — мобильный (D10) |
| `docs/02-architecture.md` | §6.1 стр. 378; ОВ-7, ОВ-8 | Upstream `--proxy` «HTTP или SOCKS5»; upstream получает имя хоста; ОВ-7 открыт | Только `http://`, SOCKS5 — бэклог; `CONNECT <проверенный IP>`; ОВ-7 закрыт README §5.7 |
| `docs/02-architecture.md` | стр. 114, 179 | pnpm 11, «dist-tags pnpm 11 — ⚠» | pnpm 12.16.1, фолбэк 11.28.9 (D07) |
| `docs/02-architecture.md` | стр. 1108, 1365 | `baseline migrate` в 1.0 | Бэклог; baseline с чужой `fingerprintVersion` — ошибка (README §5.4) |
| `docs/02-architecture.md` | стр. 1342 | CSP `default-src 'none'` без других директив | Полная CSP README §5.8 |
| `docs/02-architecture.md` | стр. 315, 1029; 788, 921, 958 | `request.tStartMs`, `state` (`completed / from-sw / …`); `observationId` | `tMs`, `delivery / result / provenance`, `navigationId`, `actionId`, `frameId`, `parentRequestId`, `features`; связи — `evidenceIds` (README §5.3) |
| `docs/02-architecture.md` | стр. 157 | Схема в `schemas/` | `schema/` — так в `package.json`, BRIEF и ADR-0007 |
| `docs/02-architecture.md` | ОВ-9 ↔ ADR-0016 | Архитектура: флага `--allow-private` нет; ADR-0016: опция нужна для сервиса в том же job. Оба — предложения авторов | Одно решение на этапе 1 (README ADR, открытый вопрос 3) |
| `docs/00-brief.md` | стр. 110 «Изоляция» | «in-process egress-прокси против SSRF; CSP `default-src 'none'`» | `EgressPolicy` для прокси, undici и TLS; `--proxy` только HTTP CONNECT; полная CSP; sandbox на трёх входах — вопрос 8 (errata §5.7 п. 1) |
| `docs/03-checks.md` | стр. 51, 63, 236, 243, 410, 421, 752 | `tStartMs`, `state`, `identifierPresent`, `observationId` | Поля README §5.3; `identifier.kind`, `matchesStoredIdentifier`; общие `evidenceIds` |
| `docs/04-quality-and-delivery.md` | стр. 103 | «pnpm 11 с lockfile» | pnpm 12.16.1 (`packageManager`), фолбэк 11.28.9 |
| `docs/04-quality-and-delivery.md` | стр. 229 | CSP `default-src 'none'` | Полная CSP README §5.8 и тест «скриншоты и стили отображаются» |
| `docs/legal/wording-guide.md` | стр. 113, 128 | «{tStartMs} ms nach Navigation / Klick» | Относительное время, вычисленное из монотонного `tMs` (README §5.3) |
| `docs/prototype/BRIEF.md` | стр. 26 | Контракт адаптера `extract, state, …, verify` | `extract / act / verify`, решение в core (README §2а) |
| `docs/prototype/BRIEF.md` | стр. 31 | CSP `default-src 'none'` | Полная CSP README §5.8 |
| `docs/prototype/BRIEF.md` | стр. 43 | `--proxy <url>` без ограничения схемы | Только `http://` (D11, §2а) |
| `docs/prototype/BRIEF.md` | стр. 126 | «реальный Chrome UA» | `navigator.userAgent` с заменой `HeadlessChrome/` на `Chrome/` (D10) |
| `docs/prototype/BRIEF.md` | стр. 86, 129 | `corepack pnpm` | Corepack не поставляется с Node ≥ 25, CI-матрица — 24 и 26; установка pnpm без опоры на Corepack (ADR-0018, ⚠ факт 32) |
| `docs/prototype/BRIEF.md` | стр. 3, 63–67 | «Проходит канареечный прогон по корпусу из 100 сайтов» как критерий прототипа | Разовый измерительный замер, не приёмка D23; только O и T, паузы D09; нужно согласие заказчика (вопрос 5) |
| `docs/consensus/README.md` | §3 D25 (стр. 254), §7 №2; errata №39 | «Дефолтный seccomp разрешает `clone` с `CLONE_NEWUSER` и `unshare --user`» | Источники расходятся: так пишет таблица docs.docker.com, но `moby/profiles` `seccomp/default.json` маскирует `clone` значением `0x7E020000` (включает `CLONE_NEWUSER`, `0x10000000`) и разрешает `unshare` только с `CAP_SYS_ADMIN`. Нужна формулировка «блокирует namespace-флаги `clone`/`unshare` без `CAP_SYS_ADMIN`; точный набор — ⚠, С3». Вывод D25 не меняется |
| `docs/consensus/round-4/errata.md` | раздел 2, «Срез прототипа» | «13 из 15 P0 и CONSENT-05» | 14 из 15 P0 (без PRIV-02), как в README §2а и таблице BRIEF |
| `docs/consensus/README.md` | D16 и §3 D16 | Стоп-слово «Übermittlung» и рекомендуемая формулировка «…Übermittlungsinstrument wurden nicht geprüft» | Стоп-лист — фразами («Übermittlung in ein Drittland», «übermittelt an»), как в Formulierungsleitfaden; иначе L0-lint отвергнет собственную формулировку D16 |

## Что осталось открытым

- **Ответы заказчика.** `Proposed`: 0002 (вопрос 1), 0003 (4), 0006 (2), 0010 (3, 12), 0012 (9), 0015 (11), 0016 (8). Части `Accepted`-записей: маппинг `crmCode` и политика `null` (вопрос 6, 0007/0008), generic-DKIM (вопрос 16, 0014), канарейка прототипа на 100 сайтах (вопрос 5, 0019).
- **`--allow-private`** (0016) против ОВ-9 архитектуры — оба предложения авторов, решение на этапе 1.
- **Имена каталогов `src/` и `data/`** (0018) — предложение автора, этап 0.
- **Seccomp Docker** — какой набор флагов блокируется на самом деле; проверить спайком С3 (на amd64) и поправить формулировку консенсуса.
- **pnpm без Corepack** на Node 26 и в сборке образа — install-smoke этапа 0 (факт 32).
- **Desktop viewport 1440×900** в 0009 взят из ресёрча (§3.3); консенсус его не фиксирует, архитектура держит как ОВ-5 — калибровка 3а.
- **Строка `docker run`** в 0017 содержит только флаги, названные консенсусом (`--security-opt seccomp=…`, `--cap-drop=ALL`, non-root); полный набор (`--read-only`, tmpfs, том для отчётов) задаёт README проекта.
- **Неоформленные кандидаты** ADR-009, 018, 020, 022, 024, 031–033 — следующий номер 0020.
- Непроверенные факты, на которые опираются ADR: 2, 4, 6, 9, 10–14, 19, 20, 22, 27, 30–32 (README §7).
