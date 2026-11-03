# Спецификация проверок `dsgvo-check`

Этот документ задаёт контракт детекта для разработчика проверки и материал для вычитки правовой части DSGVO-экспертом заказчика. Он описывает наблюдаемые факты, доказательства, ограничения и черновики немецких сообщений для пассивного CLI-сканера на TypeScript + Playwright под Apache-2.0; состояние спецификации — 2026-10-30.


## 1. Границы и общие контракты

Основание: [архитектура и контракты](02-architecture.md), [каталог](../specs/dsgvo-check_katalog-proverok.md), [ТЗ](../specs/dsgvo-check_TZ.md), [правовая карта](01-research/legal-basis-map.md). Устройство коллекторов и конвейера описывает [архитектура](02-architecture.md).

Проверка сообщает техническое наблюдение. Отсутствие находки не означает соответствия DSGVO, TDDDG, DDG или требованиям безопасности. `critical` означает уверенно установленный технический факт класса, приоритетного по утверждённому `ruleset`; смысл уровня и таблица уровней требуют подтверждения заказчика.

Реестр вариантов и `messageId` (§2.1) — канон для ruleset, текстов wording-guide и CRM-маппинга: тексты и данные переименовываются вслед за ним. Дополнительные имена вариантов, конкретные сценарии фикстур и распределение отдельных `SCAN-*` по этапам — **предложение автора, не согласовано**. Они вынесены в открытые вопросы. Немецкие формулировки являются черновиками; для всех действует пометка **«Entwurf — Prüfung durch Auftraggeber»**.

### 1.1. Фазы и покрытие

| Фаза | Профиль и страницы | Действия | Наблюдение: минимум / предел |
|---|---|---|---|
| `A` | Свежий persistent-профиль; до 6 уникальных страниц | Без взаимодействия | 6 / 20 с |
| `A′` | Профиль `A`; старт и Kontakt | `mouse.move`, `wheel`, `Shift`; без кликов | 3 / 10 с |
| `B` | Свежий persistent-профиль; старт и 2 контрольные страницы | На старте ≥ 4 с до клика; первый экран; отказ; проверка состояния; reload; контрольные страницы | 4 / 12 с |
| `C` | Свежий persistent-профиль; та же выборка, что в `B` | Принятие на старте; контрольные страницы | 4 / 12 с |
| `M` | Свежий persistent-профиль; только старт; 390×844, `isMobile` | Первый уровень баннера и блокировка; без кликов | 3 / 8 с |

Окно тишины — 2 с при `inflight ≤ 1`, с соблюдением минимального времени и предела фазы. Контрольные страницы `B/C` выбираются до `B` по сетевым и DOM-сигналам `A`, включая Zwei-Klick-плейсхолдеры, iframe и разные шаблоны. Фаза `C` раскрывает IP сканирующей машины третьим лицам; это пишется в Messumgebung.

Выборка `A`: старт после редиректов, Impressum, Datenschutzerklärung, Kontakt/Anfahrt и до 2 дополнительных страниц. Выбор детерминирован; причины и порядок входят в `plan`, `pages:` закрепляет выборку. «Первый визит» относится только к стартовой; остальные страницы `A` обозначаются как «Folgeseite in derselben Sitzung».

Scope — финальный хост и пара www/apex. Для дополнительных страниц соблюдается `robots.txt`; старт и правовые страницы проверяются всегда. Навигации последовательны с паузой ≥ 1,5 с; HTTP-пробы — ≤ 2 запросов/с на хост. Потолок браузерных запросов — 2 000. При 429/503 — пауза по `Retry-After` (≤ 30 с) и один повтор, затем новые навигации к хосту не начинаются (`SCAN-THROTTLED`); политика общая для браузера и проб. Общий `--timeout 8m`, резерв записи отчётов — 30 с. Усечение и недоступные страницы отражаются в `coverage`: `planned / observed / evaluated`.

### 1.2. Результат и уровень

| Ось | Значения и смысл |
|---|---|
| `status` | `completed`, `partial`, `inconclusive`, `not_applicable`, `skipped`, `error` |
| `severity` | `critical`, `warning`, `info`; `info` не гейтит |
| `confidence` | `high`, `medium`, `low`; уверенность технического сопоставления |
| Кэп | `medium` → максимум `warning`; `low` → максимум `info` |
| `diagnostics[]` | Отдельные `SCAN-*`, без `severity` и CRM-экспорта |

`completed` означает выполнение проверки, а не положительное заключение. `partial` обозначает оценённую часть покрытия, `inconclusive` — недостаточные данные для требуемого вывода, `error` — сбой исполнения. Одна проверка может иметь находки по оценённой части и ограничения по остальному покрытию.

Уровни, `gating` и `crmCode` задаются по `(checkId, variant)` в данных. T3-коды ограничены уровнем `warning`; код CRM не определяет уровень автоматически. Пользовательские overrides видны в `scan.options.overrides`; override всей проверки не поднимает её `info`-варианты. Варианты с `locked: true` (`CONSENT-04.banner-not-recognized`, `CONSENT-04.cmp-not-supported`) не переопределяются ни на каком уровне: такое правило — ошибка конфига `invalid-input`, код `2`.

### 1.3. Данные и минимизация

Коллекторы собирают уже отредактированный снимок, `derive` классифицирует факты, проверки читают только свой срез `requires`, затем выполняются assess и gate. Проверки не обращаются к Playwright, файловой системе или сети; дополнительные пробы описываются декларативным `ProbeSpec`. Все соединения с сайтом — браузер, undici, `node:tls`, `net.Socket` — идут через единый `EgressPolicy` (проверка каждого A/AAAA, соединение только с проверенным IP); DNS-коллектор с сайтом не соединяется и идёт к резолверу напрямую, в том числе при `--proxy`, что записывается в `environment.egress.collectors`.

Общие типы доказательств:

| Тип | Основные поля |
|---|---|
| `request` | `url`, `method`, `resourceType`, `initiator`, `phase`, `page`, `tMs` (монотонное от `scan.startedAt`), `navigationId`, `actionId`, `frameId`, `parentRequestId`, `delivery` (`attempted / blocked-by-browser / sent`), `result` (`response / failed / aborted / none`), `provenance` (`network / service-worker / http-cache / memory-cache`), `features`, `thirdPartyETLD1`, `serviceId`, `connectedIp` |
| `cookie`, `storage` | `name`, `domain` или `first-party`, `path`, `partitionKey`, флаги, `lifetime`, `length`, `setter`, `setterHost`, `state`, `phase`, `tMs`, `navigationId`, `actionId` |
| `header` | `url`, `name`, `present`; значение только для заголовков безопасности |
| `dns` | `qname`, `type`, `rcode`, записи, резолвер, время, путь Tree Walk |
| `tls` | `host` или `ipTarget`, `ip`, `family`, `lifetimeDays`, `protocol`, `issuer`, `san`, `notBefore`, `notAfter`, `chainComplete`, `authorizationError`, `trustStore` |
| `cmp` | `cmpId`, `version`, `recognitionConfidence`, `buttons[]` (факты адаптера, в т. ч. `vendorRole`; `kind`/`kindConfidence` — результат `classifyFirstLayer`), `blocking`, `viewport`, `plan.click`, производное `acceptAvailableAtFirstLayer` |
| `consent-state` | `source`, `ready`, `categories`, `origin` (`default / stored / action / special-branch`), `scope`, `decision {responded, method}` |
| `document`, `text-match` | URL, язык, части и происхождение, полнота, ошибки, `sha256`; раздел, цитата ≤ 200 знаков, `matchLevel`, `negation` |
| `component` | `product`, `version`, `versionConfidence`, `source` |
| `mixed-content` | `sourceUrl`, `selected`, `resolution`, `transferred` |
| `screenshot` | Путь артефакта, `sha256`, `crop {box, viewport}`, без изображения в JSON; при отсутствии снимка — limitation `screenshot-skipped` |

Значения и хеши cookies, Web Storage и TC-String не попадают в снимок, отчёт, логи и исключения. Безопасные признаки `request.features` — `identifier {kind: stored-match / persistent-param / user-supplied / per-load / none}`, `matchesStoredIdentifier`, `eventType`, `consentSignal`, `parserVersion`, `observationSource` — извлекаются в коллекторе до удаления значений; пересчёт по снимку возможен только для сохранённых признаков. Корреляция идентификаторов возможна только в памяти скана через HMAC с одноразовым ключом, без экспорта.

Query обрабатывается allowlist; сохраняемые значения заменяются на `[redacted]`. POST-тела и тела сетевых ответов не сохраняются. Исключения по назначению данных — извлечённые части правовых документов и обработка скриптов VULN в памяти; это не разрешение сохранять сетевые тела. Адреса `mailto:` в DMARC и `security.txt` маскируются до домена.

HAR, trace и NetLog выключены. Скриншот: `page.screenshot()` текущего viewport до любого действия, затем обрезка сохранённого изображения по `box` контейнера баннера; `locator.screenshot()` не используется, потому что прокручивает элемент. Снимок делается только при однозначном контейнере с `box` ≤ 50 % viewport (одно правило для адаптеров и эвристики), иначе limitation `screenshot-skipped`. JPEG ≤ 200 КБ, desktop и `M`; отключение — `--no-screenshots`. Полностраничных скриншотов нет. ⚠ проверить применимость UrhG § 51 к такому Beleg. Retention артефактов в CI-шаблонах — 14 дней.

Находка ссылается на общий `evidence[]` через ≤ 20 `evidenceIds`; усечение отмечается `evidenceTruncated`. Поля `pages[]`, `phases[]`, `trigger`, `replicated`, `classification` и связи `related[]` сохраняют контекст.

### 1.4. Владение наблюдениями

| Категория сетевого наблюдения | Владелец |
|---|---|
| analytics, ads, session-recording, tag-manager, cdn, payment, consent-provider, unknown | `CONSENT-01` |
| fonts | `EMBED-01` |
| maps | `EMBED-02` |
| video | `EMBED-03` |
| captcha | `EMBED-04` |
| widget, social, reviews, chat | `EMBED-05` |

Маршрутизация хранится в `data/routing.yaml`. Одно сетевое наблюдение даёт одну гейтящую находку. Хранилище (`CONSENT-02`), отсутствие баннера (`CONSENT-03`), поведение после отказа (`CONSENT-05`) и сигналы Consent Mode (`CONSENT-06`) — самостоятельные оси. `TRACK-01` предоставляет связанный инвентарь.

Неизвестный хост классифицируется как `unknown`, а не как трекер. Каталог сервисов использует `policyRelevance`, сигнатуры и алиасы; версии внешних данных фиксируются в `datasets.lock.json`.

Атрибуты `provider`, `parent`, `dpfEntity` описывают каталог, а не установленного договорного получателя. `processingLocation` — `"nicht feststellbar"`. DPF и страновая adequacy находятся в `legalContext` и не повышают уровень; отдельной проверки передачи в третьи страны нет.

### 1.5. Общие требования к фикстурам и текстам

Для каждого ID нужны нарушение, чистая, `inconclusive/error` и соседний контрпример. L1 проверяет `variant`; таблица уровней тестируется отдельно. L2 использует реальные Chromium, HTTP/TLS/DNS в закрытой сети, тестовый CA и DNS-ответы `NXDOMAIN`, `NODATA`, `SERVFAIL`, `TIMEOUT`. Для TLS обязателен положительный контроль клиента.

Тексты хранятся в `data/texts/{de,en}.yaml`, ICU MF1; ключ находки — `checkId.variant` по реестру §2.1. Все формулировки ниже имеют `draft: true`. Неутверждённые немецкие тексты блокируют релиз; `en` доступен только после вычитки. `legalNote` общий по ID, со статусом источника, `reviewedAt` и `reviewBy`.

## 2. Сводный реестр

`1` — первая проверка модуля в каркасе; это не завершение P0. Сдачу этапа 1 закрывает прототип по [брифу прототипа](prototype/BRIEF.md) — не релиз и не его ворота. `3а` — релизный manifest; `3б` — остальные P1 после manifest; «после» — после релиза. Перенос `CONSENT-05` в обязательный релиз требует подтверждения заказчика. VULN реализуются последними среди P1 и первыми исключаются при нехватке бюджета.

В колонке уровня перечислены основные варианты; подробные условия находятся в разделах ID. `crmCode` выводится только в JSON. Для непривязанных вариантов действует `null`.

| ID | Приоритет | Модуль и фаза | Уровень по умолчанию | `crmCode` | Этап |
|---|---|---|---|---|---|
| `PRIV-01` | P0 | browser + http; инвентарь `A/A′/B/C`, документы `A` (дополнение в `B`) | `warning`; категорийное описание `info` | `T3_LEGAL_DOCS_MISMATCH` | 3а |
| `PRIV-02` | P0 | browser + http; документы, `A/B/C` | `critical` при воспроизведённом противоречии; иначе `warning` | `T1_MISLEADING_CLAIM` | 3а |
| `CONSENT-01` | P0 | browser; `A/A′`, `B` до клика | `critical / warning / info` по типу запроса | `T1_TRACKER_BEFORE_CONSENT` | 3а |
| `CONSENT-02` | P0 | browser; `A/A′` | `critical` для принятого известного трекингового идентификатора | `T1_TRACKER_BEFORE_CONSENT` | 3а |
| `CONSENT-03` | P0 | browser; `A/A′` | `critical` при сильном tracking и заявленном EWR; иначе `warning` | `T1_CONSENT_BANNER_BROKEN` | 3а |
| `CONSENT-04` | P0 | browser/CMP; `A`, первый экран `B`, `M` | `critical / warning / info` по варианту | `T1_CONSENT_BANNER_BROKEN`; неизвестный CMP `null` | 3а |
| `TRACK-01` | P0 | browser; `A/A′/B/C` | `info`, инвентарь | `T1_TRACKER_BEFORE_CONSENT` ⚠ подтвердить | 3а |
| `EMBED-01` | P0 | browser; `A/A′/B` | `warning`; только preconnect `info` | `T1_FONTS_EXTERNAL` | 1 |
| `EMBED-02` | P0 | browser; `A/A′/B` | `warning` | `T1_MAPS_BEFORE_CONSENT` | 3а |
| `MAIL-01` | P0 | dns | `warning`; отдельные ограничения `info` | `T3_MAIL_UNPROTECTED` | 1 |
| `MAIL-02` | P0 | dns; совместная оценка DMARC | `warning / info` | `T3_MAIL_UNPROTECTED` | 3а |
| `HDR-01` | P0 | http; главные документы после редиректов | `warning / info` по механизму | `T3_NO_SECURITY_HEADERS` | 1 |
| `TLS-01` | P0 | http + browser `A` | `critical / warning / info` по варианту | `T1_UNENCRYPTED` | 3а |
| `TLS-02` | P0 | tls | `critical`; срок и цепочка `warning / info` | `T1_UNENCRYPTED` | 1 |
| `LEGAL-01` | P0 | browser + http; `A/B`, все посещённые страницы | `critical / warning`; неразрешённая цель `info` | `T1_OTHER` | 3а |
| `CONSENT-05` | P1 → релиз | browser; `B` после подтверждённого отказа | `critical`; cookieless `warning`; CONNECT `info` | `T1_CONSENT_BANNER_BROKEN` | 3а |
| `EMBED-03` | P1 | browser; `A/A′/B` | `warning` | `T1_MAPS_BEFORE_CONSENT` ⚠ видео | 3б |
| `EMBED-04` | P1 | browser; `A/A′/B` | `warning` без формы; с формой `info` | `T1_OTHER` | 3б |
| `EMBED-05` | P1 | browser; `A/A′/B` | `warning` | `T1_OTHER` | 3б |
| `CONSENT-06` | P1 | browser; `A/B` | `critical / warning` | `T1_TRACKER_BEFORE_CONSENT` ⚠ подтвердить | 3б |
| `VULN-01` | P1 | browser `A` + http Stage 2 | `critical / warning / info` | `T1_EXPLOITABLE_CVE` / `T3_OUTDATED_CVE` | 3б, последними |
| `VULN-02` | P1 | browser `A` + http Stage 2 | как `VULN-01` | `T1_EXPLOITABLE_CVE` / `T3_OUTDATED_CVE` | 3б, последними |
| `MAIL-03` | P1 | dns | `info`; заданный селектор/короткий ключ `warning` | `T3_MAIL_UNPROTECTED` | 3б |
| `TLS-03` | P1 | browser; HTTPS-страницы `A` | `warning`; успешный auto-upgrade `info` | `T3_OTHER` | 3б |
| `TLS-04` | P1 | tls; 2 handshake | `warning` | `T3_NO_SECURITY_HEADERS` ⚠ код | 3б |
| `DNS-01` | P2 | dns | `info`; подтверждённый bogus `warning` | `null` | после |
| `HDR-02` | P2 | http; главные документы | `warning / info` | `null` | после |
| `ADMIN-01` | P2 | http, класс `E`, только opt-in и WP | `warning / info` | `null` | после правовой оценки |
| `FILE-01` | P2 | http, класс `E`, только opt-in | `critical / warning / info` | `null`; «T0» не код | после |
| `SEC-01` | P2 | http, класс `T` | `info` | `null` | после |
| `LEGAL-02` | P2 | документы из browser/http | `info` | `null` | после |
| `BFSG-01` | P2 | browser-плагин; `B`, ≤ 3 страниц | `info`, `gating: false` | `null` | после |
| `PERF-01` | P2 | отдельный прогон Lighthouse | `info`, `gating: false` | `null` | после |
| `SCAN-GEO` | Служебная | browser/CMP; затронутые фазы | Нет `severity` | Не применяется | 3а¹ |
| `SCAN-BOTMODE` | Служебная | browser/CMP; затронутые фазы | Нет `severity` | Не применяется | 3а¹ |
| `SCAN-BLOCKED` | Служебная | browser/http; старт или подстраница | Нет `severity` | Не применяется | 1¹ |
| `SCAN-UNREACHABLE` | Служебная | browser/http/dns; старт | Нет `severity` | Не применяется | 1¹ |
| `SCAN-THROTTLED` | Служебная | http; пробы | Нет `severity` | Не применяется | 1¹ |
| `SCAN-TIMEOUT` | Служебная | оркестратор; все коллекторы | Нет `severity` | Не применяется | 1¹ |
| `SCAN-SANDBOX-OFF` | Служебная | запуск браузера | Нет `severity` | Не применяется | 1¹ |
| `SCAN-PRIVATE-REQUEST-BLOCKED` | Служебная | egress-прокси; соединения | Нет `severity` | Не применяется | 1¹ |

¹ Детализация этапов для диагностик — предложение автора, не согласовано. Контракт требует соответствующую диагностику при появлении условия независимо от этапа.

### 2.1. Реестр вариантов и `messageId`

Полный перечень вариантов; каждый `checkId.variant` назван здесь ровно один раз. Для реализованных проверок источник — `data/ruleset/de-2026/*.yaml` (уровень по умолчанию, `locked`, `crm`): первая таблица генерируется из него командой `corepack pnpm registry`, тест падает при расхождении. Вторая таблица — запланированные проверки; при реализации строка переносится из неё в ruleset. `messageId` находки — `checkId.variant` без исключений, `legalNoteId` — `checkId` ([архитектура](02-architecture.md) §10.1). Уровень — значение ruleset по умолчанию до overrides и кэпа confidence; условия выбора варианта — в «Уровне» раздела ID.

Исходы без находки (`inconclusive`, `error`, `skipped`, `not_applicable`) — не варианты: у них нет `severity`, `messageId` и `crmCode`, а есть `reason` и `limitations[]` CheckResult. Их тексты — ключи `reason.<id>` и `limitation.<id>` (схема ключей — предложение автора, не согласовано; wording-guide, ОВ 3). Единственное исключение — два `locked`-варианта `CONSENT-04`: находка `info` при статусе `inconclusive` ([архитектура](02-architecture.md) §10.1 и §11.3). Текст диагностики `SCAN-*` — по её коду (§7), без `severity`.

**Реализованные проверки.** Исходы без находки описаны в разделе каждой проверки.

<!-- registry:begin: generated from data/ruleset by `corepack pnpm registry`, do not edit -->
| ID | `critical` | `warning` | `info` |
|---|---|---|---|
| `CONSENT-01` | `tracking-completed` | `library-loaded`, `first-party-proxy`, `cookieless-ping` | `third-party-resource`, `unknown-host`, `request-not-completed` |
| `CONSENT-02` | `tracking-identifier-stored` | `unknown-third-party-persistent` | `unknown-first-party-persistent`, `cmp-cookie-with-uid`, `storage-rejected-or-attempted` |
| `CONSENT-03` | `no-banner-strong-tracking` | `no-banner-consent-services` | — |
| `CONSENT-04` | `blocking-no-reject`, `close-means-accept` | `reject-not-actionable`, `reject-ineffective`, `consent-without-action` | `reject-as-link`, `nonblocking-no-reject`, `no-choice-at-first-layer`, `pur-abo`, `banner-not-recognized`², `cmp-not-supported`² |
| `CONSENT-05` | `tracking-after-reject` | `cookieless-ping-after-reject` | `connect-only-after-reject` |
| `TRACK-01` | — | — | `service-inventory` |
| `EMBED-01` | — | `fonts-loaded` | `preconnect-only` |
| `EMBED-02` | — | `maps-loaded` | — |
| `LEGAL-01` | `document-not-found`, `links-broken` | `link-missing-on-some-pages`, `reachable-via-intermediate`, `footer-covered-by-banner` | `unresolved` |
| `PRIV-01` | — | `not-named` | `category-only`, `ambiguous-match` |
| `MAIL-01` | — | `record-not-found`, `policy-none`, `record-invalid` | `weak-option`, `legacy-pct` |
| `MAIL-02` | — | `record-not-found`, `permissive-qualifier`, `record-invalid`, `softfail-without-enforcement` | `softfail-with-enforcement`, `ptr-mechanism` |
| `HDR-01` | — | `hsts-missing`, `anti-framing-missing`, `referrer-policy-permissive` | `header-missing` |
| `TLS-01` | `https-unavailable`, `form-on-http-page` | `no-redirect`, `client-side-redirect-only` | `redirect-chain-detail` |
| `TLS-02` | `certificate-invalid` | `chain-incomplete`, `certificate-expiring` | `certificate-expiry-approaching` |
<!-- registry:end -->

**Запланированные проверки.**

| ID | `critical` | `warning` | `info` | Не варианты: `reason`, limitation |
|---|---|---|---|---|
| `PRIV-02` | `contradiction-replicated` | `contradiction-single` | `wording-to-review` | `claim-ambiguous` |
| `EMBED-03` | — | `video-loaded` | — | — |
| `EMBED-04` | — | `captcha-without-form` | `captcha-with-form` | — |
| `EMBED-05` | — | `widget-loaded` | — | — |
| `CONSENT-06` | `google-granted-despite-denied` | `default-granted`, `hit-before-default` | — | `not-observable` |
| `VULN-01`, `VULN-02`³ | `version-listed-kev-or-preauth` | `version-listed`, `eol-major` | `version-unknown` | `source-unavailable` |
| `MAIL-03` | — | `key-too-short`, `given-selector-missing` | `selectors-not-found` | — |
| `TLS-03` | — | `active-mixed-content-blocked`, `passive-upgrade-failed`, `form-action-http` | `passive-auto-upgraded` | — |
| `TLS-04` | — | `legacy-protocol-accepted` | — | `handshake-inconclusive` |
| `DNS-01` | — | `dnssec-bogus` | `caa-not-found`, `dnssec-unsigned` | — |
| `HDR-02` | — | `session-cookie-attributes` | `cookie-attributes`, `cookie-samesite-missing`, `version-header` | — |
| `ADMIN-01` | — | `users-and-xmlrpc-exposed` | `partial-exposure` | — |
| `FILE-01` | `sensitive-signature` | `exposed-file` | `minor-file` | — |
| `SEC-01` | — | — | `security-txt-not-found`, `security-txt-incomplete` | — |
| `LEGAL-02` | — | — | `outdated-reference` | — |
| `BFSG-01`⁴ | — | — | `axe-rule-observed` | — |
| `PERF-01`⁴ | — | — | `lab-metrics` | — |

² `locked: true`, `gating: false`, `crmCode: null`, статус проверки `inconclusive`.  
³ Уровни при `versionConfidence: exact`; `range` — на ступень ниже. `crmCode`: `version-listed-kev-or-preauth` — `T1_EXPLOITABLE_CVE`, остальные сопоставленные — `T3_OUTDATED_CVE`; запись понижения и код при нём — Q10.
⁴ `gating: false`.

Не варианты и без строки ruleset: `TLS-03` в состоянии `loaded` и `ws://` (Q10), неизвестный формат `gcd` в `CONSENT-06`. `variantGroup`, CRM-коды `info`-вариантов и фикстуры на каждый вариант — Q2, Q10.

## 3. Проверки P0

### 3.1. `PRIV-01` — сервис не найден в Datenschutzerklärung

**Что ловим.** Фактически загруженный сервис каталога с `policyRelevance: required`, для которого в обработанной Datenschutzerklärung не найдено поддерживаемое описание. Поимённое название не является единственным допустимым способом информирования.

**Данные и фаза.** Инвентарь сервисов `A/A′/B/C`; `documents`, извлечённые в `A` без кликов (rendered- и скрытый DOM-текст, фреймы, связанные страницы) и дополненные в `B` после подтверждённого отказа (раскрытие аккордеонов и табов кликом). Согласие ради документа не нажимается. Manifest содержит полноту, ошибки, язык и происхождение частей: `visible`, `expandable`, `frame`, `linked`, `hidden-irrelevant`.

**Алгоритм детекта.**

1. Отобрать реально загруженные сервисы с `policyRelevance: required`; ссылки в исходнике без загрузки не включать.
2. Проверить наличие DSE и manifest полноты. Отсутствие документа передать `LEGAL-01`; не создавать каскад находок о каждом сервисе.
3. Использовать rendered-текст разделов, раскрываемые аккордеоны и табы, same- и cross-origin iframe, ≤ 3 связанных страниц того же префикса.
4. Нормализовать NFKC, регистр, ä/ae, дефисы и soft-hyphen.
5. Искать алиасы продукта, оператора, домены и термины категории: `named > company > domain > category > none`.
6. Привязать отрицание к субъекту и предикату. «Wir verwenden X nicht» не засчитывать как положительное описание использования; неоднозначную конструкцию направить на ручную оценку.
7. Выдать `not-named` при `none`, `category-only` при категорийном совпадении. Совпадение только в `hidden-irrelevant` не повышать до `named`.

**Evidence.** `request`, `document`, `text-match`; `serviceId`, `classification.source`, `datasetVersion`, `matchLevel`, URL и раздел. Цитата ≤ 200 знаков. Query редактируется; сетевые тела и идентификаторы не сохраняются. В доказательстве отрицательного поиска указываются обработанный документ и manifest, а не утверждение об отсутствии текста на всём сайте.

**Уровень.** `not-named` — `warning`, никогда `critical`; `category-only` — `info`; совпадение только в `hidden-irrelevant` и неоднозначное отрицание — `ambiguous-match`, `info` с ручной оценкой. PDF, неполный manifest или язык вне de/en — `inconclusive` (`pdf-not-evaluated`, `document-incomplete`, `language-unsupported`). Баннер не закрыт (`B` невозможна), но manifest полон — `completed`/`partial` с limitation `banner-open`, не `inconclusive`. При отсутствующей DSE содержательная оценка `PRIV-01` невозможна.

**Ложные срабатывания и пропуски → защита.** Название оператора вместо бренда → алиасы компаний. Категорийное описание → отдельный `info`. Генератор политики во фрейме или аккордеоне → извлечение всех поддерживаемых частей. Неполная загрузка → `inconclusive`. Неизвестный сервис и текст в изображении остаются ограничениями, а не основанием для `warning`.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | Trustindex реально загружен; полная немецкая DSE не содержит продукта, оператора, домена и категории → `not-named` |
| Чистая | Тот же сервис; оператор назван в раскрываемом разделе iframe → `company`, находки об отсутствии нет |
| `inconclusive` | DSE доступна только как PDF → `inconclusive`, без `not-named` |
| Контрпример | Только описание категории отзывов → `category-only`, `info`; скрытый нерелевантный шаблон с брендом не считается `named` |

**Правовой якорь.** Art. 13 Abs. 1 lit. e, f DSGVO; Informationspflicht — устоявшаяся. Требование называть каждый продукт отдельно — спорная позиция: допустимы «Kategorien von Empfängern».

**Текст находки.** `PRIV-01.not-named`: «Im ausgewerteten Text der Datenschutzerklärung unter {policyUrl} wurde keine Nennung von {service} oder der bekannten Aliasse gefunden. Der Dienst wurde auf {pageCount} geprüften Seiten beobachtet.»  
`PRIV-01.category-only`: «Eine Beschreibung der Kategorie {category} wurde gefunden; eine eindeutige Zuordnung zu {service} wurde nicht festgestellt.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Заказчик утверждает алиасы, категории и приемлемые описания; см. Q4. Нужен утверждённый маппинг `info`-вариантов; см. Q2.

### 3.2. `PRIV-02` — утверждение политики расходится с наблюдением

**Что ловим.** Конкретное распознанное утверждение DSE и технический факт, противоречащий именно его субъекту, предикату, условию и фазе.

**Данные и фаза.** `documents`, `text-match`, запросы и хранилища `A/B/C`, состояния CMP и сведения о репликации. В MVP каталог примерно из 6 утверждений: локальные Google Fonts; отсутствие cookies до действия; аналитика только после принятия; отсутствие сервиса X; erweiterter Datenschutzmodus; Matomo ohne Cookies.

**Алгоритм детекта.**

1. Извлечь утверждение из полного поддерживаемого документа.
2. Разобрать `subject → predicate → negation → condition → phase`.
3. Исключить исторический контекст, исключения и другой продукт: `früher`, `außer`, упоминание продукта в сравнении.
4. Найти противоречащий факт в соответствующей фазе. «Ohne Cookies» не означает «не используется».
5. Проверить воспроизведение: ≥ 2 страниц или `A` и `B` до клика.
6. При `high`, совпадении фазы и воспроизведении выдать `contradiction-replicated` (`critical`); без воспроизведения установленное противоречие — `contradiction-single` (`warning`); `medium` ограничивается кэпом.
7. Устаревшие формулировки, включая Privacy Shield и роль Google reCAPTCHA с 02.04.2026, отделить в `wording-to-review` (`info`, «Formulierung prüfen»).

**Evidence.** `claimId`, `serviceId`, `documentId`, URL, раздел и цитата ≤ 200 знаков; связанные `request`, `cookie/storage`, `consent-state`, фазы, страницы, `replicated`. Без значений хранилищ и POST-тел. Для «локальных шрифтов» показываются реальный внешний запрос и его initiator.

**Уровень.** `critical` только при всех перечисленных условиях; иначе `warning` с учётом кэпа confidence. Неоднозначный синтаксис — `inconclusive` (`claim-ambiguous`). Для утверждения о фазе `B` неподтверждённый отказ или неизвестный CMP дают `inconclusive` по этой части. Устаревшее обозначение — `info`.

**Ложные срабатывания и пропуски → защита.** «Google Analytics ohne Cookies» → проверять запись cookies, а не наличие GA. Условное обещание → сопоставить условие. Историческое описание → исключить. Однократный ресурс или A/B-ротация → не выдавать `critical` без репликации. Неподдерживаемый язык → не угадывать значение.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | DSE: «Google Fonts sind lokal installiert»; внешний font-запрос на двух страницах → `critical` |
| Чистая | Та же фраза; шрифты обслуживаются локально; внешний URL есть только в комментарии → находки нет |
| `inconclusive` | Неоднозначная область отрицания либо обещание «Analyse nur nach Einwilligung» при неподтверждённой фазе `B` |
| Контрпример | «Matomo ohne Cookies» и реально работающий Matomo без наблюдаемой записи cookies → само наличие Matomo не противоречие |

**Правовой якорь.** Art. 5 Abs. 1 lit. a, Art. 12, 13 DSGVO — Transparenz. Применение § 5 UWG спорно и в текст находки не выносится.

**Текст находки.** `PRIV-02.contradiction-replicated`, `PRIV-02.contradiction-single`: «Die Aussage „{quote}“ unter {policyUrl} wurde gefunden. In der beschriebenen Situation wurde dagegen {observation} beobachtet; Belege liegen für {replicationScope} vor.»  
`PRIV-02.wording-to-review`: «Die Formulierung „{quote}“ wurde gefunden. Bitte die Aktualität der beschriebenen Rolle oder Grundlage prüfen.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить точный каталог утверждений и поддерживаемые конструкции; Q4, Q10. Порог и правовой текст `critical` требуют подписи ruleset; Q3.

### 3.3. `CONSENT-01` — запросы до взаимодействия

**Что ловим.** Запросы, начатые до любого клика, к сторонним сервисам и распознаваемым first-party-proxy. Категории EMBED принадлежат соответствующим `EMBED-*`.

**Данные и фаза.** `A`, `A′`, старт `B` до клика. Подписка `context.on` до навигации, CDP initiator, журнал прокси, время начала запроса. Запрос описывается тремя осями: `delivery` (`attempted / blocked-by-browser / sent`), `result` (`response / failed / aborted / none`), `provenance` (`network / service-worker / http-cache / memory-cache`).

**Алгоритм детекта.**

1. Сопоставить время начала запроса с навигацией, нейтральным действием и кликом.
2. Определить сторонность через eTLD+1 и каталог; first-party sGTM/tag gateway распознавать по пути и параметрам.
3. Извлечь `features` до редактирования: `identifier.kind` (`stored-match` — совпадение с трекинговым cookie/storage через одноразовый HMAC в памяти, `persistent-param` по сигнатуре каталога, `user-supplied`, `per-load`, `none`), `matchesStoredIdentifier`, `eventType`, `consentSignal`.
4. Применить `routing.yaml`; fonts/maps/video/captcha/widget передать владельцам.
5. Различить библиотеку, идентифицированный хит, cookieless ping и попытку, заблокированную браузером.
6. Агрегировать одну находку на сервис; неизвестные хосты представить одной агрегированной находкой.
7. Для стартовой сопоставить повторное окно `B` до клика. Отсутствие повтора записать как `replicated: false`, сохранив уровень.
8. Для `A′` записать `trigger: interaction-without-consent`.

**Evidence.** `request` с `tMs`, `navigationId`, `delivery`, `result`, `provenance`, `initiator`, страницей и фазой; `features` (вид идентификатора, событие, `parserVersion`), источник классификации, `replicated`. `connectedIp.origin` различает локальное разрешение, upstream и неизвестный peer. Query редактируется, payload и идентификатор не экспортируются.

**Уровень.** `critical` (`tracking-completed`): analytics/ads/session-recording, `delivery: sent` и `result: response`, идентификатор устойчивый (`stored-match`, `persistent-param` по сигнатуре каталога или `user-supplied`). `warning`: tag-manager или библиотека без хита (`library-loaded`), first-party-proxy с `medium` (`first-party-proxy`), cookieless ping и хит с идентификатором `per-load` или `none` (`cookieless-ping`). `info`: CDN, payment, consent-provider (`third-party-resource`), unknown (`unknown-host`), запрос с `delivery` ≠ `sent` или `result` ≠ `response`, в т. ч. CSP-блок (`request-not-completed`). Прямой бот- или гео-сигнал → затронутая оценка `inconclusive`. `A′` имеет тот же уровень, что `A`.

**Ложные срабатывания и пропуски → защита.** GTM без сработавшего тега → `warning`, не идентифицированная аналитика. CSP-блок → максимум `info`. Только кэш или SW → не объявлять новым сетевым обменом. CNAME и first-party endpoint → каталог и сигнатуры, без автоматического `critical`. Server-side forwarding вне наблюдения сканера.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | До клика завершён GA4-хит, `cid` совпадает с сохранённым `_ga` (`stored-match`); приём подтверждён fixture-server → `critical` |
| Чистая | Тот же endpoint вызывается только после принятия в `C` → находки `CONSENT-01` нет |
| `inconclusive` | Прямой `isSpider()` либо гео-ветка CMP → соответствующая диагностика |
| Контрпример | GTM-библиотека без хита → `warning`; запрос, заблокированный CSP, → `info`; один лишь неизвестный домен → `info`; хит со случайным идентификатором на загрузку (`per-load`) → `warning` |

**Правовой якорь.** § 25 Abs. 1 TDDDG, Art. 6 DSGVO; EuGH Planet49 C-673/17. Для Speicherung/Zugriff принцип устоявшийся; для чистого запроса без такого события квалификация спорная. VG Hannover 10 A 5385/22 (Urteil 19.03.2025): ⚠ проверить деталь позиции о GTM и наличие Berufung.

**Текст находки.** `CONSENT-01.tracking-completed`: «Vor einer Interaktion mit dem Banner wurde eine abgeschlossene Anfrage an {service} mit einer dauerhaften Kennung ({identifierKind}) beobachtet; der Wert wurde nicht gespeichert.»  
`CONSENT-01.library-loaded`: «Vor einer Interaktion wurde eine Bibliothek von {service} geladen; ein zugehöriger Ereignisversand wurde in diesem Beleg nicht festgestellt.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить маршрутизацию и инвентарную роль `TRACK-01`, Q2; уровни cookieless и `A′`, Q3. Правовой статус GTM остаётся с пометкой ⚠ проверить. Приоритет при сочетании `denied` в Consent Mode и `user-supplied`-идентификатора — строка Q3.

### 3.4. `CONSENT-02` — cookies и хранилища до взаимодействия

**Что ловим.** Новые cookies и записи клиентских хранилищ до клика с классификацией по каталогу и контексту. Сканер не устанавливает правовую необходимость записи.

**Данные и фаза.** `A/A′`: `context.cookies()` после каждой страницы; CDP Set-Cookie ExtraInfo и `blockedCookies`; init-хуки `document.cookie` и CookieStore; localStorage, sessionStorage, имена IndexedDB.

**Алгоритм детекта.**

1. Сопоставлять записи по `(name, domain или first-party, path, partitionKey)`.
2. Разделить попытку записи, принятие, отклонение и отправку.
3. Зафиксировать транзиентные JS-cookies хуком, даже если они удалены до итогового чтения.
4. Применить allowlist CMP-состояния, сессии, LB, CSRF и языка.
5. Классифицировать: собственный каталог → Open Cookie Database → контекст сеттера.
6. Выделить известные трекинговые идентификаторы: `_ga`, `_gid`, `_fbp`, `_gcl_au`, `_hjSession*`, `_pk_id`, NID, IDE и аналоги в storage.
7. Для неизвестных persistent-записей различить first-party и third-party.
8. Связать сетевое наблюдение с `CONSENT-01` или EMBED, сохраняя самостоятельную ось хранения.

**Evidence.** `cookie/storage`: имя, домен или `first-party`, путь, partitionKey, флаги, срок, длина, сеттер, состояние, время и фаза. Значений, TC-String и хешей нет. In-memory-корреляция не экспортируется.

**Уровень.** `critical` (`tracking-identifier-stored`): известный трекинговый идентификатор в `accepted`. `warning` (`unknown-third-party-persistent`): неизвестная persistent third-party. `info`: неизвестная persistent first-party (`unknown-first-party-persistent`), CMP-cookie с UID (`cmp-cookie-with-uid`), `attempted` или отклонённая браузером запись (`storage-rejected-or-attempted`). Прямой бот-сигнал → `inconclusive`. Allowlist обозначается «nicht bewertet (Allowlist vX)», без утверждения «notwendig». Общий гео-сигнал ограничивает затронутую consent-оценку.

**Ложные срабатывания и пропуски → защита.** Совпадение имени без контекста → учитывать каталог и сеттер. Consent-cookie с UID не считать бот-режимом. Отклонённый third-party cookie не объявлять сохранённым. Partitioned cookies не сливать. Хуки и итоговый снимок дополняют друг друга; недоступные хранилища отражаются в покрытии.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | Скрипт до клика устанавливает и удаляет `_ga`; хук фиксирует принятие → `critical` |
| Чистая | Только allowlisted CSRF/session/CMP-state, без известных трекинговых записей → соответствующих находок нет |
| `inconclusive` | Прямой бот-режим CMP; записи собраны, но затронутая оценка не утверждается |
| Контрпример | Set-Cookie с `_fbp` отклонён браузером → `info`; одинаковые имена с разными partitionKey остаются разными фактами |

**Правовой якорь.** § 25 Abs. 1, Abs. 2 Nr. 2 TDDDG; EuGH Planet49 C-673/17, BGH I ZR 7/16. Принцип устоявшийся; отнесение конкретной записи к `unbedingt erforderlich` требует оценки Einzelfall.

**Текст находки.** `CONSENT-02.tracking-identifier-stored`: «Vor einer Interaktion mit dem Banner wurde die Speicherung von {name} beobachtet. Die Einordnung als Tracking-Merkmal stammt aus {dataset}. Werte wurden nicht gespeichert.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить allowlist и контекстные исключения; Q4. Согласовать CRM-маппинг информационных вариантов; Q2.

### 3.5. `CONSENT-03` — баннер не найден при наблюдаемом tracking

**Что ловим.** Отсутствие кандидата consent-интерфейса на обследованной выборке при сильных сигналах сервисов, требующих согласия по ruleset.

**Данные и фаза.** `A/A′`: DOM всех фреймов и open shadow DOM, собственные CMP-адаптеры, autoconsent после окна `A`, эвристика, сеть и storage; egress и прямые гео-/бот-сигналы.

**Алгоритм детекта.**

1. На стартовой и ещё ≥ 1 странице искать кандидата баннера всеми поддерживаемыми средствами.
2. Дождаться HARD_CAP и выполнить `A′`; преждевременное отсутствие DOM не считать результатом.
3. Исключить страницу с Borlabs `dialogHideDialogOnPages` из соответствующей оценки отсутствия.
4. Убедиться, что ни адаптер, ни autoconsent, ни эвристика не нашли кандидата.
5. Проверить analytics/ads/session-recording либо embed с записью storage. Только fonts или CDN недостаточно.
6. Проверить прямые бот-/гео-сигналы.
7. Для `critical` потребовать идентификатор или трекинговый storage и `egress.region: asserted` EWR. Источник заявления записать «laut Nutzerangabe».

**Evidence.** Перечень обследованных страниц и окон, результаты поиска кандидатов, `request`, `cookie/storage`, CMP-факты, `environment.egress`. Нулевой результат ограничен `coverage`; значения cookies и query удаляются.

**Уровень.** `critical` (`no-banner-strong-tracking`) только при сильном tracking, заявленном EWR и отсутствии прямых бот-/гео-сигналов; иначе при достаточных данных — `warning` (`no-banner-consent-services`). Гео-/бот-ветка → `inconclusive`. Найден неизвестный баннер → `CONSENT-04` `info`, а не `CONSENT-03`. Одной обследованной страницы недостаточно для заявленного алгоритма.

**Ложные срабатывания и пропуски → защита.** Поздний баннер → HARD_CAP и `A′`. Серверная геолокация без CMP-скрипта → отсутствие скрипта ничего не доказывает. Прокси сам по себе не подтверждает регион. Closed shadow DOM и недоступные фреймы остаются ограничениями.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | На старте и Kontakt нет кандидата до HARD_CAP и после `A′`; GA-хит с идентификатором; заявлен DE-egress → `critical` |
| Чистая | Есть распознанный баннер либо загружаются только внешние шрифты → `CONSENT-03` нет |
| `inconclusive` | CMP сообщает `gdprApplies: false` или иной прямой out-of-region-сигнал |
| Контрпример | Неизвестный баннер в iframe найден эвристикой → `CONSENT-04.banner-not-recognized`, без вывода об отсутствии баннера |

**Правовой якорь.** § 25 Abs. 1 TDDDG; Art. 6, 13 DSGVO. Принцип Einwilligung устоявшийся; применимость исключений и необходимость конкретного сервиса не устанавливаются автоматически.

**Текст находки.** `CONSENT-03.no-banner-strong-tracking`, `CONSENT-03.no-banner-consent-services`: «Auf den auswertbaren geprüften Seiten wurde kein Einwilligungsdialog gefunden. Gleichzeitig wurde {trackingObservation} beobachtet. Region laut Nutzerangabe: {regionStatement}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить зависимость `critical` от заявленного EWR и требования к доказательным аудитам; Q3, Q5.

### 3.6. `CONSENT-04` — первый уровень и работоспособность отказа

**Что ловим.** Поддерживаемые варианты первого уровня баннера: измеренная блокировка без actionable-отказа, принятие через закрытие, недоступный или неэффективный отказ, блокирующий первый уровень без выбора и отдельные информационные случаи.

**Данные и фаза.** `CmpFacts` из `A`, первого экрана `B` до действия и `M`. Собственные адаптеры в порядке реализации: Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. `high` распознавания требует ≥ 2 независимых признаков.

**Алгоритм детекта.**

1. Определить CMP и поддерживаемый диапазон версии; отдельно оценить уверенность функции каждой кнопки.
2. До любого действия снять роли, accessible name, геометрию, видимость, hit-testing, контраст и блокировку.
3. Не считать `aria-modal` самостоятельным доказательством блокировки; scroll-lock внутреннего контейнера не равен блокировке страницы. При hit-testing учитывать потомка целевого элемента.
4. Чистой функцией `classifyFirstLayer(facts, lexicon)` в core классифицировать `reject/accept/settings/close` по фактам и лексикону; адаптер (`extract / act / verify`) сообщает факты и `vendorRole`, но не класс.
5. «Einstellungen», «Später», «Verbergen», «×» не считать отказом по одному тексту. `close-means-accept` устанавливать только по прочитанному конфигу CMP.
6. Применить таблицу вариантов ниже. Площади и контраст использовать как evidence, без самостоятельного численного вердикта о равноценности.
7. Выполнять только однозначный `locator.click()` без `force`; JS-API CMP только читать.
8. Сопоставить клик и состояние CMP; отказ без изменения состояния — `reject-ineffective`.
9. При `--from-snapshot` (имя флага выбирается на этапе 1: `--from-snapshot` или `--from-artifacts`, [ОВ-23 архитектуры](02-architecture.md#открытые-вопросы)) не переигрывать действия. Расхождение нового лексикона с `plan.click` отметить `lexicon-changed-since-scan`.

| Вариант | Условие | Уровень |
|---|---|---|
| `blocking-no-reject` | CMP `high`, измеренная блокировка, `acceptAvailableAtFirstLayer: true`, нет actionable reject на первом уровне | `critical` |
| `close-means-accept` | Конфиг подтверждает принятие через закрытие | `critical` |
| `reject-not-actionable` | Отказ найден, но недоступен пользователю | `warning` |
| `reject-ineffective` | Клик выполнен, отказ не подтверждается состоянием | `warning` |
| `consent-without-action` | CMP сообщает `granted` без клика и без прямого бот-сигнала | `warning` |
| `reject-as-link` | Отказ реализован ссылкой; требуется ручная оценка оформления | `info` |
| `nonblocking-no-reject` | Баннер не блокирует; reject первого уровня не найден | `info` |
| `pur-abo` | Найден Pur-Abo-сценарий; флаг не отключает другие варианты | `info` |
| `no-choice-at-first-layer` | Блокирующий первый уровень без actionable accept и без reject (только настройки); ручная оценка | `info` |
| `banner-not-recognized`, `cmp-not-supported` | Нет поддерживаемого адаптера, `medium` или неизвестный диапазон версии | `info`, `inconclusive`, `crmCode: null`; `locked: true`, `gating: false` — не повышаются ни ruleset, ни overrides |

**Evidence.** `cmp.buttons[]` с `vendorRole`, `kind`/`kindConfidence` (результат `classifyFirstLayer`, с версией лексикона), `box`, `visibleAtFirstScreen`, `actionableAtFirstScreen`, `contrast`; `blocking {overlay, scrollLock, inert, coveredRatio, method}`, `acceptAvailableAtFirstLayer`, viewport, `consent-state`, `plan.click`, скриншот области. Значения consent-cookie и TC-String удаляются; снимок — viewport до действий с обрезкой по однозначному контейнеру ≤ 50 % viewport, иначе `screenshot-skipped`.

**Уровень.** По таблице, с общим кэпом confidence. `warning/critical` доступны только собственному адаптеру с `high` и однозначной семантикой кнопок. Эвристика и autoconsent дают только информационный результат. Прямой гео-/бот-режим → `inconclusive`. Зависимые `CONSENT-05` и утверждения `PRIV-02` о `B` также ограничиваются.

**Ложные срабатывания и пропуски → защита.** `locator.click()` может прокрутить элемент → первый экран снимается заранее. Consent-cookie без клика не доказывает бота. Ссылка может быть визуально равноценной → только `info`. Отсутствие reject у неблокирующего баннера не повышается до `critical`. Закрытый shadow DOM и неподдерживаемая версия → отказ от вердикта.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | Поддерживаемый CMP с двумя признаками; overlay блокирует контент; только accept/settings; отдельно desktop и `M` → `blocking-no-reject` |
| Чистая | Поддерживаемый CMP; accept и видимый actionable reject первого экрана; отказ подтверждается и переживает reload |
| `inconclusive` | Неизвестный CMP либо известный CMP вне диапазона версии → `info`, `crmCode: null` |
| Контрпримеры | Только `aria-modal`; scroll-lock внутреннего блока; «×» без читаемой семантики; reject-ссылка; `pur-abo` вместе с блокировкой; блокирующий экран только с «Einstellungen» → `no-choice-at-first-layer`, `info` |
| Дополнительные варианты | Перекрытый reject; клик без смены состояния; `granted` без действия; конфиг «× = accept»; override `banner-not-recognized` в `rules:` → `invalid-input` |

**Правовой якорь.** Art. 4 Nr. 11, Art. 7 DSGVO; § 25 TDDDG. DSK OH Digitale Dienste Rn. 124–125, OLG Köln 6 U 80/23, VG Hannover 10 A 5385/22: линия для блокирующего баннера рассматривается как устоявшаяся; абсолютное требование reject первого уровня для неблокирующего баннера и Pur-Abo — спорные позиции. VG Hannover — Urteil 19.03.2025. ⚠ проверить актуальность DSK и точные Rn. (в т. ч. формулировку Rn. 125 о первом уровне без возможности согласия), Rechtskraft OLG, Berufung VG; Type C отчёта EDPB также требует проверки.

**Текст находки.**

| Ключ | Немецкий черновик |
|---|---|
| `CONSENT-04.blocking-no-reject` | «Der Dialog blockierte die Seitennutzung. Auf der ersten sichtbaren Ebene wurde eine Zustimmungsoption gefunden, jedoch keine unmittelbar bedienbare Ablehnoption.» |
| `CONSENT-04.close-means-accept` | «Laut ausgelesener CMP-Konfiguration führt das Schließen des Dialogs zur Zustimmung.» |
| `CONSENT-04.reject-not-actionable` | «Eine Ablehnoption wurde gefunden, war auf dem ersten Bildschirm jedoch nicht unmittelbar bedienbar.» |
| `CONSENT-04.reject-ineffective` | «Nach Betätigung der Ablehnoption wurde kein bestätigter Ablehnzustand festgestellt.» |
| `CONSENT-04.no-choice-at-first-layer` | «Der Dialog blockierte die Seitennutzung. Auf der ersten sichtbaren Ebene wurde weder eine Zustimmungs- noch eine Ablehnoption gefunden; die Gestaltung wurde nicht abschließend ausgewertet.» |
| `CONSENT-04.banner-not-recognized` | «Banner nicht erkannt. Die Gestaltung und Funktion der Optionen wurden nicht abschließend ausgewertet.» |
| `CONSENT-04.cmp-not-supported` | «CMP {cmp} erkannt, nicht unterstützt.» |

**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подписать таблицу уровней, Q3. Численные пороги `coveredRatio`, метод сочетания признаков блокировки и диапазоны версий адаптеров не зафиксированы; Q10. Утвердить скриншоты, Q6. Уровень `no-choice-at-first-layer` (`info`) — строка Q3.

### 3.7. `TRACK-01` — инвентарь аналитики и рекламы

**Что ловим.** Наблюдаемую загрузку и исполнение analytics/ads/session-recording/tag-manager с разделением библиотеки, инициализации и отправленного события.

**Данные и фаза.** `A/A′/B/C`: сеть, безопасные признаки payload, `dataLayer`; связь с CONSENT-находками через общие `evidenceIds`.

**Алгоритм детекта.**

1. Сопоставить домен, путь, initiator и сигнатуры каталога.
2. Распознавать GA4 `/g/collect` с `cid`, `gtag/js?id=G-`; GTM `gtm.js`; Meta `fbevents.js`, `/tr?ev=`; Google Ads `googleads.g.doubleclick.net`, `pagead`; Hotjar `static/script.hotjar.com`, `ws.hotjar.com`.
3. Дополнить каталогом Matomo, Clarity, LinkedIn, TikTok, Pinterest.
4. Вывести подтверждённую стадию `loaded → initialised → event-sent`; не повышать стадию по наличию строки в исходнике.
5. Присвоить timing `before-interaction / after-reject / after-accept`.
6. Связать с `CONSENT-01/02/05/06`; гейтящий уровень оставлять владельцу соответствующей оси.

**Evidence.** `request`, стадия, timing, `serviceId`, сигнатура и версия данных, общие `evidenceIds` и `related[]`. Идентификаторы и payload не сохраняются, остаются безопасные признаки.

**Уровень.** `info` (`service-inventory`), связанный инвентарь. Это рекомендуемая семантика, требующая подтверждения заказчика. Только ссылка в исходнике — находки нет. Неполный сетевой сбор → `partial` или `inconclusive` по доступному покрытию; из отсутствия хита не выводится отсутствие аналитики.

**Ложные срабатывания и пропуски → защита.** GTM-контейнер не равен сработавшему тегу. Несколько библиотек одного сервиса агрегируются. First-party forwarding и неизвестные сигнатуры ограничивают полноту; неизвестный endpoint не объявляется аналитикой.

**Фикстуры.** Нарушение: GA4-библиотека и реальный `page_view` до клика → `event-sent`, связь с `CONSENT-01`. Чистая: названия GA/GTM только в неисполняемом тексте → нет инвентарной находки. `inconclusive`: недоступен обязательный сетевой срез. Контрпример: GTM загружен без тегов → только `loaded`; GA после принятия остаётся `info`.

**Правовой якорь.** § 25 TDDDG; Art. 6 Abs. 1 lit. a DSGVO; Art. 26, EuGH Fashion ID C-40/17. Правовая оценка зависит от функции и обработки; наличие контейнера её не устанавливает.

**Текст находки.** `TRACK-01.service-inventory`: «{service} wurde im Zustand {stage} beobachtet, Zeitpunkt: {timing}. Zugehörige Beobachtungen: {relatedChecks}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить `info`-инвентарь и `crmCode` для `after-accept`; Q2.

### 3.8. `EMBED-01` — внешние шрифты

**Что ловим.** Реальную загрузку CSS или файлов внешних шрифтов; отдельно — только предварительное соединение.

**Данные и фаза.** `A/A′/B`: сеть, цепочка CSS → `@font-face` → font, initiator, DOM `link rel`, журнал прокси.

**Алгоритм детекта.**

1. Сопоставить запрос с категорией fonts: `fonts.googleapis.com`, `fonts.gstatic.com`, `use.typekit.net`, `use.fontawesome.com`, `fonts.bunny.net`.
2. Для `p.typekit.net` сохранить пометку ⚠ проверить назначение хоста.
3. Различить загрузку CSS/font и `preconnect/dns-prefetch`.
4. Исключить self-hosted и локальный прокси.
5. Агрегировать сервис и страницы; загрузку после отказа сохранить с фазой `B`.
6. Передать противоречие утверждению «lokal» в `PRIV-02` как связанный факт.

**Evidence.** `request`, resourceType, initiator, тип ресурса, страница и фаза. Только preconnect подтверждается как соединение, без утверждения о передаче шрифта. Query редактируется; CSS и font-тела не сохраняются.

**Уровень.** `fonts-loaded` — `warning`; только `preconnect/dns-prefetch` — `preconnect-only`, `info`. После отказа уровень остаётся `warning`. Self-hosted/локальный прокси — находки нет. Невозможность установить факт загрузки → `inconclusive` по соответствующему срезу.

**Ложные срабатывания и пропуски → защита.** `@font-face` без выбранной загрузки не равен фактической загрузке. EU-атрибут `fonts.bunny.net` не превращает запрос в локальный. Хост Adobe с иным назначением не включается без проверки сигнатуры.

**Фикстуры.** Нарушение: загружаются CSS Google Fonts и font с `fonts.gstatic.com` до клика → `warning`. Чистая: те же шрифты на своём хосте. `inconclusive`: сетевой сбор отсутствует. Контрпример: только preconnect → `info`; неиспользуемое правило CSS не доказывает font-загрузку.

**Правовой якорь.** Art. 6 DSGVO; LG München I 3 O 17493/20 — одиночное решение. Квалификация чистой загрузки как § 25 TDDDG спорная.

**Текст находки.** `EMBED-01.fonts-loaded`: «Eine externe Schriftressource von {service} wurde auf {page} geladen, Zeitpunkt: {phaseDescription}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** ⚠ проверить `p.typekit.net`; подтвердить `warning` при T1-коде, Q3.

### 3.9. `EMBED-02` — карты до принятия и после отказа

**Что ловим.** Загрузку внешних карт: iframe, JS API, static maps и тайлов.

**Данные и фаза.** `A/A′/B`, прежде всего Kontakt/Anfahrt; сеть и DOM. Провайдеры Google, OSM, Mapbox, HERE — по каталогу.

**Алгоритм детекта.**

1. Найти карту или плейсхолдер в DOM.
2. Сопоставить фактические запросы по провайдеру и сигнатуре: `maps/embed`, JS API, static maps, tiles.
3. Записать тип интеграции и фазу загрузки.
4. Исключить обычную ссылку, локальную картинку и Zwei-Klick-плейсхолдер без внешней загрузки.
5. Сгруппировать по сервису; запись cookies/storage направить отдельно в `CONSENT-02`.
6. Сохранить страницы `B`, чтобы не смешивать их с загрузкой после принятия `C`.

**Evidence.** `request`, тип карты, URL страницы, DOM-контекст и initiator; связанные storage-evidence. Query и ключи, если они находятся в query, не экспортируются в открытом виде; сетевые тела не сохраняются.

**Уровень.** `warning` для наблюдаемой загрузки. Storage не повышает EMBED-находку, а создаёт независимую `CONSENT-02`. Заблокированную попытку нельзя описывать как состоявшуюся загрузку; при недостаточном сборе — `inconclusive`.

**Ложные срабатывания и пропуски → защита.** Ссылка на Maps не равна embed. Локальная схема проезда не является сторонней картой. Тайлы учитываются независимо от наличия iframe. Правильно блокируемый плейсхолдер влияет на выбор контрольной страницы `B/C`.

**Фикстуры.** Нарушение: Kontakt без действия загружает внешние тайлы → `warning`. Чистая: локальная картинка и ссылка либо Zwei-Klick-плейсхолдер без запросов. `inconclusive`: Kontakt закрыт challenge и не оценён. Контрпример: карта появляется только в `C` → находки о загрузке до принятия нет.

**Правовой якорь.** § 25 TDDDG при cookies/storage; Art. 6 DSGVO; DSK OH Rn. 74, 101, 123. Позиция надзора устоявшаяся; для статичных тайлов без storage правовая квалификация спорная. ⚠ проверить актуальность и Rn. DSK.

**Текст находки.** `EMBED-02.maps-loaded`: «Ein externer Kartendienst von {service} wurde als {integrationType} geladen, Zeitpunkt: {phaseDescription}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить сигнатуры типов карт и текст для static maps; Q4, Q10.

### 3.10. `MAIL-01` — DMARC

**Что ловим.** Отсутствие обнаруживаемой DMARC-политики, `p=none`, невалидную запись и отдельные ограничения enforcement.

**Данные и фаза.** DNS: TXT `_dmarc`, MX/Null MX, Tree Walk, ответы резолвера и время. Общий DNS-бюджет — ≤ 60 запросов.

**Алгоритм детекта.**

1. Запросить TXT `_dmarc` обследуемого хоста.
2. При отсутствии применимой записи выполнить Tree Walk по RFC 9989 с PSD, ≤ 8 запросов, без искусственной остановки на eTLD+1.
3. Разобрать теги RFC 7489 и RFC 9989, сохраняя различие современного и исторического синтаксиса.
4. Отличить `NXDOMAIN/NODATA` от `SERVFAIL/TIMEOUT`.
5. Определить найденную политику и путь наследования; учесть MX и Null MX.
6. Выдать основной вариант для отсутствия, `p=none` или невалидной записи.
7. Отдельно представить `sp=none` при `p≠none`, `t=y` (RFC 9989), отсутствие `rua`, Null MX без `p=reject`. Legacy-тег `pct<100` (RFC 7489; в RFC 9989 удалён, Appendix A.6) — самостоятельный `info`-вариант «Legacy-Tag `pct`», основная оценка идёт по RFC 9989.

**Evidence.** `dns`: qname, TXT, rcode, резолвер, путь Tree Walk, время; MX-контекст. В `rua/ruf` локальная часть `mailto:` удаляется до сохранения. Не выводится утверждение о фактической отправке почты.

**Уровень.** Отсутствие (`record-not-found`), `p=none` (`policy-none`), невалидная запись (`record-invalid`) — `warning`. `sp=none`, `t=y`, отсутствие `rua` и Null MX без `p=reject` — одна находка `weak-option` с перечнем, `info`; `pct<100` — `legacy-pct`, `info`. `SERVFAIL/TIMEOUT` после повтора — `error`, не отсутствие записи. Усечение бюджета до завершения поиска не даёт основания для «не найдено».

**Ложные срабатывания и пропуски → защита.** Политика родителя → Tree Walk. Null MX → отдельная трактовка. Многострочный TXT → корректная сборка записи. Недоступный DNS → ошибка измерения. Сам факт `p=reject` не доказывает корректность реальной почтовой инфраструктуры.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | `v=DMARC1; p=none` либо отсутствие записи по завершённому Tree Walk → `warning` |
| Чистая | Валидная применимая `p=reject`, в том числе найденная у родителя |
| `inconclusive/error` | `SERVFAIL` после повтора → `error`; неполный Tree Walk из-за лимита не считается отсутствием |
| Контрпример | Null MX без `p=reject` → `info`; найденная PSD-политика не теряется на PSL-границе |

**Правовой якорь.** Art. 32 DSGVO — косвенная связь; BSI TR-03108-1 и TR-03182 — технические стандарты. Конкретная обязательность DMARC из этих фактов не выводится. RFC 9989 (май 2026) заменяет RFC 7489 и 9091.

**Текст находки.** `MAIL-01.record-not-found`: «Im dokumentierten DNS-Suchpfad wurde kein anwendbarer DMARC-Eintrag gefunden.»  
`MAIL-01.policy-none`: «Der gefundene DMARC-Eintrag enthält p=none; eine Quarantäne- oder Ablehnrichtlinie wurde darin nicht gefunden.»  
`MAIL-01.legacy-pct`: «Der DMARC-Eintrag enthält das Tag pct; in RFC 9989 ist es entfallen. Die Richtlinie wurde nach RFC 9989 ausgewertet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Зафиксировать полную матрицу наследования и MX/Null MX как тестируемые данные; Q10. Подтвердить `info`-маппинг, Q2.

### 3.11. `MAIL-02` — SPF с учётом DMARC

**Что ловим.** Отсутствующую, чрезмерно разрешающую или невалидную SPF-политику; SoftFail оценивается совместно с DMARC.

**Данные и фаза.** DNS TXT `v=spf1`, рекурсивные `include/redirect`, результат `MAIL-01`, rcode и счётчики lookups/void.

**Алгоритм детекта.**

1. Найти ровно одну SPF-запись; несколько записей классифицировать как ошибку политики.
2. Разобрать механизмы и квалификаторы, `include` и `redirect`.
3. Обнаружить циклы и синтаксические ошибки.
4. Проверить предел ≤ 10 lookups и ≤ 2 void; превышение — `permerror`.
5. Определить итоговый `all`: `+all`, `?all`, `~all`, `-all`.
6. Для `~all` проверить наличие валидного DMARC enforcement `quarantine/reject`.
7. Отдельно отметить `ptr` вариантом `ptr-mechanism` (`info`).
8. Не моделировать реальную отправку с конкретного IP.

**Evidence.** `dns`, нормализованная политика, дерево include/redirect, счётчики, тип ошибки, ссылка на DMARC-evidence. Маскируются `mailto:` в связанном DMARC; произвольные значения посторонних TXT не включаются в отчёт.

**Уровень.** `warning`: нет SPF (`record-not-found`), `+all`/`?all` (`permissive-qualifier`), `permerror` и несколько SPF (`record-invalid`), `~all` без DMARC enforcement (`softfail-without-enforcement`). `info`: `~all` при `quarantine/reject` (`softfail-with-enforcement`), `ptr` (`ptr-mechanism`). DNS-сбой — `error`. Если DMARC не удалось оценить, нельзя утверждать его отсутствие и завершать совместную классификацию SoftFail.

**Ложные срабатывания и пропуски → защита.** `~all` сам по себе не дефект. Расход lookup-бюджета отличается от количества строк. Неполное дерево не считается валидной политикой. SPF не доказывает защиту всех фактических From-доменов.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | `v=spf1 ~all` и применимый DMARC `p=none` → `warning`; отдельно цикл include и превышение 10 lookups |
| Чистая | Валидная политика с `-all`, без превышений и циклов |
| `inconclusive/error` | TXT SPF или требуемый DMARC недоступен после повтора → `error` либо незавершённая совместная оценка |
| Контрпример | `~all` с DMARC `p=reject` → `info`, не `warning` |

**Правовой якорь.** Art. 32 DSGVO косвенно; BSI TR-03108-1, TR-03182; RFC 7208. Технический стандарт; SoftFail допускается в сочетании с DMARC enforcement.

**Текст находки.** `MAIL-02.softfail-without-enforcement`: «Der SPF-Eintrag endet mit ~all. Eine anwendbare DMARC-Richtlinie mit p=quarantine oder p=reject wurde im ausgewerteten Suchpfad nicht gefunden.»  
`MAIL-02.record-invalid`: «Bei der statischen Auswertung des SPF-Eintrags wurde {reason} festgestellt.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Уточнить совместную матрицу для Null MX и частично недоступного DMARC; Q10. Подтвердить исправление трактовки `~all` в каталоге; Q1.

### 3.12. `HDR-01` — заголовки безопасности

**Что ловим.** Отсутствующие или явно небезопасные механизмы в ответах главных документов.

**Данные и фаза.** HTTP-ответы стартовой, Impressum и DSE после редиректов; известный HSTS-preload-контекст.

**Алгоритм детекта.**

1. Для каждого финального документа сохранить заголовки безопасности.
2. HSTS оценивать только для HTTPS; учитывать preload.
3. Anti-framing считать найденным при XFO либо `frame-ancestors` в CSP-заголовке; meta-CSP не засчитывать.
4. Для CSP различать enforced и report-only.
5. Проверить `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
6. Создать находку на механизм, сгруппировать затронутые URL.
7. Формулировать вывод применительно к конкретному ответу, а не всему домену.

**Evidence.** `header {url, name, present}`, значения только заголовков безопасности, статус/цепочка ответа и preload-основание. Произвольные response headers, cookies и тела не копируются.

**Уровень.** `warning`: нет HSTS (`hsts-missing`), нет anti-framing (`anti-framing-missing`), Referrer-Policy `unsafe-url` или `no-referrer-when-downgrade` (`referrer-policy-permissive`). `info` (`header-missing`): нет CSP, nosniff, Permissions-Policy или Referrer-Policy. Недоступный документ не считается ответом без заголовков; покрытие `partial` либо `inconclusive`.

**Ложные срабатывания и пропуски → защита.** HSTS только на HTTP не засчитывается. Meta `frame-ancestors` не обеспечивает искомый механизм. Report-only не выдаётся за enforcement. Разные ответы CDN отражаются по URL. Отсутствие CSP не означает установленную эксплуатацию.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | HTTPS-ответ без HSTS и anti-framing, с `unsafe-url` → соответствующие `warning` |
| Чистая | Ответ содержит поддерживаемые механизмы; anti-framing через XFO либо CSP-заголовок |
| `inconclusive` | Главный документ закрыт challenge; отсутствие заголовков не утверждается |
| Контрпример | `frame-ancestors` только в meta; HSTS-preload при отсутствии собственного заголовка; CSP report-only как отдельный факт |

**Правовой якорь.** Art. 32, 25 DSGVO; § 19 Abs. 4 TDDDG. Технический стандарт, без нормы, предписывающей весь перечисленный набор каждому сайту.

**Текст находки.** `HDR-01.hsts-missing`, `HDR-01.anti-framing-missing`, `HDR-01.header-missing`: «In der Antwort von {url} wurde {mechanism} nicht gefunden.»  
`HDR-01.referrer-policy-permissive`: «In der Antwort von {url} wurde die Referrer-Policy {policy} beobachtet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить `warning` anti-framing, Q3; источник и обновление preload-данных, Q10.

### 3.13. `TLS-01` — HTTP и переход на HTTPS

**Что ловим.** Отдачу контента по HTTP, отсутствие надлежащего перехода на HTTPS и формы на HTTP-странице.

**Данные и фаза.** HTTP-пробы (undici через `EgressPolicy`) `http://` финального хоста, apex и www без HSTS-кэша; ≤ 5 ручных редиректов; результаты HTTPS/TLS и DOM `A`.

**Алгоритм детекта.**

1. Выполнить HTTP-пробу и пройти цепочку вручную.
2. Отделить HTTP-redirect от meta/JS-перехода.
3. Проверить достижение HTTPS-2xx и хост назначения.
4. Если HTTP отдаёт контент, сопоставить доступность и валидность HTTPS.
5. Проверить наличие формы на HTTP-странице.
6. Отдельно собрать ссылки меню на свои HTTP-поддомены.
7. Исключить заглушку ≤ 1 KiB; закрытый порт не считать отдачей контента.
8. Зафиксировать всю цепочку, а не только финальный URL.

**Evidence.** `request/header` цепочки, исходная схема, статусы, Location, meta/JS-признак, форма и связанное TLS-evidence. URL очищаются; формы не заполняются и не отправляются.

**Уровень.** `critical`: HTTP-контент при недоступном/невалидном HTTPS (`https-unavailable`) либо форма на HTTP-странице (`form-on-http-page`). `warning`: HTTP-2xx без редиректа при рабочем HTTPS (`no-redirect`), переход только JS/meta (`client-side-redirect-only`). `info` (`redirect-chain-detail`): первый хоп не на HTTPS или на другой хост; HTTP-ссылки на свои поддомены. Timeout → `inconclusive`.

**Ложные срабатывания и пропуски → защита.** HSTS браузера может скрыть HTTP → отдельный клиент без кэша. Закрытый порт не является http-only-сайтом. Заглушка не равна основной странице. Редирект на сторонний хост не выдаётся за защищённость исходного.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | HTTP-страница с формой либо HTTP-контент при невалидном HTTPS → `critical` |
| Чистая | HTTP сразу перенаправляет на валидный HTTPS-2xx того же хоста |
| `inconclusive` | HTTP-проба завершается timeout; ответа о контенте нет |
| Контрпример | HTTP-2xx и рабочий HTTPS без формы → `warning`; закрытый 80; заглушка ≤ 1 KiB; JS-переход |

**Правовой якорь.** § 19 Abs. 4 S. 3 TDDDG; Art. 32 Abs. 1 lit. a DSGVO. Transportverschlüsselung при сборе персональных данных — устоявшаяся позиция; для чисто статичной страницы квалификация спорная.

**Текст находки.** `TLS-01.https-unavailable`, `TLS-01.no-redirect`: «Unter {url} wurde Inhalt über HTTP ausgeliefert. {httpsObservation}»  
`TLS-01.form-on-http-page`: «Auf der über HTTP geladenen Seite wurde ein Formular gefunden. Das Formular wurde nicht ausgefüllt oder abgesendet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подписать градацию уровней; Q3. Уточнить контракт распознавания заглушки помимо размера; Q10.

### 3.14. `TLS-02` — сертификат и срок

**Что ловим.** Истёкший, чужой, самоподписанный или недоверенный сертификат, неполную цепочку и приближение срока окончания относительно срока действия.

**Данные и фаза.** `node:tls` через `EgressPolicy` для финального хоста и www/apex; Mozilla-store, опционально `--use-system-ca`. Для имени — SNI и свой `X509Certificate.checkHost`; для IP-цели (IP-литерал) — без SNI (RFC 6066) и `X509Certificate.checkIP` по `iPAddress`-SAN. В evidence `lifetimeDays = notAfter − notBefore`.

**Алгоритм детекта.**

1. Установить соединение (SNI только для имени, не для IP-литерала), сохранив фактический IP и семейство.
2. Проверить цепочку и доверие выбранным trust store.
3. Проверить имя через `checkHost`; для IP-цели — `checkIP`.
4. Проверить срок относительно времени скана и срока действия L = `notAfter − notBefore`.
5. Различить установленную причину невалидности и handshake без объяснимого результата.
6. Сопоставить результаты валидаторов; при расхождении описать конкретное расхождение.
7. При невалидном TLS не обходить ошибку браузером: браузерные проверки `skipped (tls-blocked)`.

**Evidence.** `tls` со всеми полями общего контракта; peer IP, SAN, issuer, сроки, `authorizationError`, `trustStore`. Секретные ключи и сетевые тела отсутствуют.

**Уровень.** `critical` (`certificate-invalid`): истёкший сертификат, несовпадение имени, самоподписанный, неизвестный корень. `warning`: неполная цепочка (`chain-incomplete`) либо остаток срока < min(14 д, 25 % L) (`certificate-expiring`). `info` (`certificate-expiry-approaching`): остаток < min(30 д, 50 % L). При L ≤ 10 д находки о сроке нет — только evidence `lifetimeDays` (короткоживущие сертификаты, в т. ч. 6-дневные Let's Encrypt). Handshake без установленной причины → `inconclusive` (`handshake-inconclusive`). Для срока действует кэп confidence и контекст выбранного trust store.

**Ложные срабатывания и пропуски → защита.** Сертификат хостера → проверка имени, а не строка issuer. Различия IPv4/IPv6 → IP в evidence. Системный CA → явно записанный trust store. Неуспешный handshake не объявляется сертификатной ошибкой без причины. Короткоживущий сертификат → относительный порог, иначе корректно администрируемый сайт получал бы вечный `warning` при `--fail-on warning`.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | SAN другого хоста; отдельно истёкший и self-signed → `critical`, browser `tls-blocked` |
| Чистая | Валидная цепочка и имя, 90-дневный сертификат с остатком > 45 дней; 6-дневный сертификат (L ≤ 10 д) — чистая, без находки о сроке |
| `inconclusive` | Соединение сброшено до получения диагностируемого результата |
| Контрпример | Неполная цепочка → `warning`; 90-дневный сертификат с остатком 13 / 15 / 29 / 31 дней → `warning` / `info` / `info` / нет находки; IP-цель с `iPAddress`-SAN → чистая через `checkIP`, при несовпадении → `critical`; доверенный тестовый CA явно указан |

**Правовой якорь.** § 19 Abs. 4 S. 3 TDDDG; Art. 32 Abs. 1 lit. a DSGVO. Как для `TLS-01`: установлен технический результат проверки сертификата, а не самостоятельный правовой вывод.

**Текст находки.** `TLS-02.certificate-invalid`: «Die Zertifikatsprüfung für {target} ergab mit {trustStore}: {reason}.» — `{target}` ist der Hostname oder «IP-Adresse {ip}».  
`TLS-02.certificate-expiring`, `TLS-02.certificate-expiry-approaching`: «Das Zertifikat für {target} ist laut notAfter noch {days} Tage gültig (Gesamtlaufzeit {lifetimeDays} Tage).»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подписать относительный порог срока и пограничные формулировки; Q3, Q10.

### 3.15. `LEGAL-01` — Impressum и Datenschutzerklärung

**Что ловим.** Документ не найден, все обнаруженные цели неработоспособны либо достижимость ограничена на части обследованных страниц.

**Данные и фаза.** DOM `A/B` всех посещённых страниц, accessible name/href, меню, open shadow DOM, баннер, модалки; HTTP-цели; общий `documents` коллектора.

**Алгоритм детекта.**

1. Отдельно искать Impressum и Datenschutzerklärung по меткам, включая Rechtliches, Imprint, Privacy.
2. Проверить цели: 2xx, содержательность, soft-404.
3. Для `#` и `javascript:` проверить содержимое модалки; сам href не означает broken.
4. Учесть перекрытие подвала баннером и наличие правовых ссылок в баннере.
5. До `critical` выполнить один промежуточный переход через Kontakt, Rechtliches или Über uns, ≤ 3 GET.
6. Затем проверить `/impressum` и `/datenschutz`.
7. Определить отсутствие документа, частичную достижимость или достижимость только через переход/фолбэк.
8. Сохранить `planned / observed / evaluated`; challenge-страницы не исключать молча из знаменателя.

**Evidence.** `document`, найденные ссылки, цепочки целей, результат модалки, промежуточная страница, причина soft-404/недоступности, coverage по типу документа. Текст контактов не копируется как доказательство отсутствия; query редактируется.

**Уровень.** `critical`: документ не найден ссылкой, переходом и фолбэком (`document-not-found`) либо все ссылки ведут на 4xx/soft-404 (`links-broken`). `warning`: ссылка отсутствует на части страниц (`link-missing-on-some-pages`); документ найден только через переход/фолбэк, `medium` (`reachable-via-intermediate`); подвал перекрыт без правовых ссылок в баннере (`footer-covered-by-banner`). `#` без разрешённого содержимого и неразрешённый SPA-маршрут — `unresolved`, `info`. Заблокированная выборка не доказывает отсутствие документа.

**Ложные срабатывания и пропуски → защита.** Два клика могут быть достаточны → обязательный промежуточный переход. SPA и модалки → не объявлять `#` сломанным. PDF-DSE может быть найдена для `LEGAL-01`, даже если `PRIV-*` её не оценивают. Частичное покрытие не переносится на весь сайт.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение | Ни ссылок, ни документов через промежуточные страницы и фолбэки; либо все цели 404 → `critical` |
| Чистая | На всех оценённых страницах рабочие правовые ссылки; отдельно рабочая модалка через `#` |
| `inconclusive` | Правовые цели закрыты challenge; отсутствие документа не устанавливается |
| Контрпример | Impressum доступен через Kontakt → не `critical`; неразрешённый `#` → `info`; PDF-DSE считается найденной |

**Правовой якорь.** § 5 DDG; Art. 13 DSGVO; BGH I ZR 228/03 — достижимость за два клика, включая Kontakt. Позиция устоявшаяся. § 18 MStV только в `legalNote`, без автоматического определения применимости.

**Текст находки.** `LEGAL-01.document-not-found`: «{documentKind} wurde auf {n} von {m} geprüften Seiten nicht gefunden. Über eine geprüfte Zwischenseite erreichbar: {reachable}. Abdeckung: {coverage}.»  
`LEGAL-01.unresolved`: «Das Linkziel für {documentKind} konnte nicht eindeutig aufgelöst werden.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить уровни достижимости через переход/фолбэк; Q3. Уточнить критерии содержательности и soft-404; Q10.

## 4. `CONSENT-05` — поведение после отказа

**Что ловим.** Новые идентифицированные analytics/ads-хиты и новые трекинговые записи storage после технически подтверждённого отказа.

**Данные и фаза.** `B`: состояние CMP, consent-cookie без значения, момент клика, reload, старт и 2 контрольные страницы; сеть по времени начала, storage-события, журнал прокси, окно ухода со страницы.

**Алгоритм детекта.**

1. Распознать поддерживаемый CMP и однозначную функцию отказа.
2. Выполнить человеческий клик `locator.click()` без `force`; сохранить `plan.click`.
3. Подтвердить отказ независимо от сети: CMP `ready`; состояние изменилось после нашего клика (`consent-state.origin: action`) и CMP фиксирует ответ пользователя (`decision.responded: true`, например Cookiebot `hasResponse`/`declined`); все необязательные категории `denied` либо consent-cookie означает `denied`. Исходное `default`-состояние с `denied` отказом не считается.
4. Проверить сохранение отказа после reload: `origin: stored`. Исчезновение интерфейса само по себе не подтверждает отказ.
5. Если отказ не подтверждён (в т. ч. есть только default-denied), выдать `CONSENT-04.reject-ineffective`, когда его условия установлены; `CONSENT-05` оставить `inconclusive` «Ablehnung nicht bestätigt».
6. Для подтверждённого отказа анализировать новые запросы, у которых `tMs` начала больше `tMs` клика (`actionId`), на reload и контрольных страницах.
7. Различить хит с устойчивым идентификатором (как в `CONSENT-01`: `stored-match`, `persistent-param`, `user-supplied`), cookieless ping и только CONNECT к трекер-хосту.
8. Отдельно учитывать трекинговую cookie/storage, принятую после клика. Запрос мог начаться до клика, но принятый после клика Set-Cookie остаётся новым событием записи.
9. Исключить собственный consent-update CMP из трекинговых хитов.
10. Проверить сбор pagehide/keepalive и SW. Если захват ухода недоступен, результат `inconclusive`; ограничение явно показать в Messumgebung.

**Evidence.** `cmp`, `consent-state` до/после действия и после reload (`origin`, `decision`), `plan.click`, `request.tMs`/`actionId`, `cookie/storage.state`, фазы, страницы, `features` (`identifier.kind`, `eventType`, `consentSignal`), proxy CONNECT. Значения cookies, TC-String, POST-тела и идентификаторы не сохраняются. `gcs/gcd` превращаются в безопасный признак `consentSignal` версионированным декодером.

**Уровень.**

| Наблюдение после подтверждённого отказа | Уровень |
|---|---|
| Новый analytics/ads-хит с устойчивым идентификатором и/или новая принятая трекинговая запись storage | `critical` (`tracking-after-reject`) |
| Cookieless ping: `gcs=G100`, `gcd` с denied | `warning` (`cookieless-ping-after-reject`) |
| Только CONNECT к трекер-хосту | `info` (`connect-only-after-reject`) |
| Отказ не подтверждён (в т. ч. только default-denied) или CMP не поддержан | `inconclusive` (reason `reject-not-confirmed`) |
| Отказ подтверждён, но захват pagehide/keepalive недоступен | `inconclusive` (reason `pagehide-capture-unavailable`) |

Применяются общий кэп confidence и ограничения гео-/бот-режима. Сеть не используется для доказательства самого отказа: иначе отсутствие трафика одновременно стало бы условием и результатом проверки.

**Ложные срабатывания и пропуски → защита.** Завершение старого запроса после клика → сравнение времени начала. Новая cookie из старого запроса → самостоятельное событие принятия. Закрытие баннера без denied → отказ не подтверждён. Consent-update → исключение по назначению. CONNECT не доказывает хит или передачу идентификатора. Отсутствие запросов на выбранных 3 страницах не распространяется на остальные страницы сайта. Default-denied (у Cookiebot необязательные категории изначально `false`) → не отказ без `origin: action` и `decision.responded`.

**Фикстуры.**

| Сценарий | Содержимое и ожидание |
|---|---|
| Нарушение: новый хит | CMP сообщает denied с `origin: action` и `decision.responded`, после reload `origin: stored`; после клика сервер получает GA4 `page_view` с устойчивым идентификатором → `critical` |
| Нарушение: storage | После клика принят трекинговый cookie, в том числе из запроса, начатого раньше → `critical` |
| Чистая | Отказ подтверждён и сохраняется; после него только consent-update и обычные ресурсы без новых трекинговых записей |
| `inconclusive` | UI закрывается, но CMP остаётся `loading/granted`; default-denied без ответа пользователя (`origin: default`) → `inconclusive`; либо pagehide не наблюдаем |
| Контрпример | Запрос начался до клика и завершился после, без новой записи → не новый хит |
| Пониженные варианты | Denied cookieless ping → `warning`; только CONNECT → `info` |
| Полнота сбора | Beacon на `pagehide`, keepalive и SW проверяются журналом принимающего fixture-server |

**Правовой якорь.** § 25 Abs. 1 TDDDG; Art. 7 Abs. 3, Art. 4 Nr. 11 DSGVO. Принцип устоявшийся; cookieless pings и технические исключения требуют отдельной оценки. ⚠ проверить полноту CDP-захвата pagehide/keepalive и SW на выбранном Chromium до реализации проверки.

**Текст находки.** `CONSENT-05.tracking-after-reject` (ветка `select` по виду наблюдения): «Nach bestätigter Ablehnung und erneutem Laden wurde eine neue Anfrage an {service} mit einer dauerhaften Kennung ({identifierKind}) beobachtet.» / «Nach bestätigter Ablehnung wurde eine neue Speicherung von {name} beobachtet.»  
`CONSENT-05.cookieless-ping-after-reject`: «Nach bestätigter Ablehnung wurde ein Ping an {service} mit ausgelesenem Ablehnzustand beobachtet.»  
`CONSENT-05.connect-only-after-reject`: «Nach bestätigter Ablehnung wurde eine Verbindung zum Host {host} beobachtet; ein konkreter Ereignisversand wurde daraus nicht festgestellt.»  
`reason` `reject-not-confirmed` (без находки): «Ablehnung nicht bestätigt (nur Ausgangszustand des CMP).»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить перенос из P1 в релиз, Q1; уровни cookieless, Q3. ⚠ проверить техническую полноту захвата, Q7. Утвердить признаки `origin: action` и `decision.responded` для каждого адаптера, Q10.

## 5. Остальные проверки P1

### 5.1. `EMBED-03` — видео и превью

**Что ловим.** Внешние видеоинтеграции и загрузку превью до принятия либо после отказа.

**Данные и фаза.** `A/A′/B`: сеть, iframe и DOM. YouTube, `youtube-nocookie.com`, `i.ytimg.com`, Vimeo.

**Алгоритм детекта.** 1) Сопоставить provider/path. 2) Различить `iframe`, `player`, `thumbnail-only`. 3) Для `youtube-nocookie.com` записать `enhancedPrivacyMode`, не считать его отсутствием обработки. 4) Исключить локальное превью и обычную ссылку. 5) Storage связать с `CONSENT-02`.

**Evidence.** `request`, тип интеграции, `enhancedPrivacyMode`, страница, фаза, initiator; общая редакция URL, без тел.

**Уровень.** `warning`, включая `thumbnail-only` с явной оговоркой «Vorschaubild ≠ Wiedergabe». Недоступный сетевой/DOM-срез → `inconclusive`. Только заблокированная попытка не описывается как загрузка.

**Ложные срабатывания и пропуски → защита.** Превью не равно воспроизведению; локальная картинка не внешний embed; `nocookie` не доказывает отсутствие storage. ⚠ проверить наблюдение localStorage для `youtube-nocookie.com`.

**Фикстуры.** Нарушение: `i.ytimg.com` загружает превью в `A`. Чистая: локальное превью, плеер только после принятия. `inconclusive`: недоступны данные iframe/сети. Контрпример: thumbnail фиксируется отдельно от player.

**Правовой якорь.** § 25 TDDDG при Speicherung/Zugriff; Art. 6 DSGVO; DSK OH Rn. 74, 123. Позиция надзора по embed устоявшаяся; чистое превью без storage — спорная квалификация. ⚠ проверить DSK Rn.

**Текст находки.** `EMBED-03.video-loaded`: «Eine externe Videoressource von {service} wurde als {integrationType} geladen. Ein Vorschaubild belegt keine Wiedergabe.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Код `T1_MAPS_BEFORE_CONSENT` относится к картам; подтвердить агрегацию или новый код, Q2.

### 5.2. `EMBED-04` — CAPTCHA

**Что ловим.** Загрузку CAPTCHA до принятия с учётом наличия видимой формы.

**Данные и фаза.** `A/A′/B`: сеть и DOM форм; reCAPTCHA v2/v3/Enterprise, hCaptcha, Turnstile, Friendly Captcha.

**Алгоритм детекта.** 1) Найти `recaptcha/api.js`, `enterprise.js`, `gstatic.com/recaptcha` и сигнатуры остальных провайдеров. 2) Различить `loaded/executed`. 3) Проверить наличие видимой формы. 4) Turnstile как WAF-челлендж маршрутизировать в `SCAN-BLOCKED`.

**Evidence.** `request`, провайдер, стадия, факт видимой формы, фаза и URL. Поля формы не заполняются; payload, ответы CAPTCHA и токены не сохраняются.

**Уровень.** Без видимой формы — `warning` (`captcha-without-form`); с видимой формой — `info` (`captcha-with-form`). При WAF-челлендже нет EMBED-вердикта. Недостаточный DOM-контекст → `inconclusive` для градации по форме.

**Ложные срабатывания и пропуски → защита.** Наличие защитной функции не определяет `unbedingt erforderlich`; WAF не считается обычной CAPTCHA-интеграцией; скрытая форма не объявляется видимой.

**Фикстуры.** Нарушение: reCAPTCHA исполняется на стартовой без формы → `warning`. Чистая: внешней CAPTCHA нет. `inconclusive`: видимость формы не установлена. Контрпример: CAPTCHA у видимой формы → `info`; Turnstile challenge → `SCAN-BLOCKED`.

**Правовой якорь.** § 25 Abs. 1 и Abs. 2 Nr. 2 TDDDG — спорная позиция; DSK Rn. 74, ⚠ проверить. Google reCAPTCHA — Auftragsverarbeiter с 02.04.2026; это не решает автоматически вопрос Einwilligung.

**Текст находки.** `EMBED-04.captcha-without-form`: «{service} wurde geladen oder ausgeführt. Auf der ausgewerteten Seite wurde keine sichtbare zugehörige Formularfläche gefunden.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подписать `info` для страницы с формой, Q3; утвердить привязку CAPTCHA к форме, Q10.

### 5.3. `EMBED-05` — виджеты

**Что ловим.** Фактическую загрузку сторонних social/reviews/chat/widget-интеграций.

**Данные и фаза.** `A/A′/B`: сеть и сигнатуры Elfsight, Trustindex, Instagram, ProvenExpert, Trustpilot, Calendly, чатов.

**Алгоритм детекта.** 1) Сопоставить домен и путь. 2) Подтвердить загрузку компонента виджета. 3) Исключить общий CDN и локально кэшированные отзывы. 4) Агрегировать сервис; storage передать `CONSENT-02`.

**Evidence.** `request`, сигнатура пути, service/category, initiator, страница и фаза. Не сохраняются тексты отзывов, имена авторов, тела чата и payload.

**Уровень.** `warning`. Неполные данные для отличия CDN от виджета → `inconclusive`, без объявления произвольного CDN виджетом.

**Ложные срабатывания и пропуски → защита.** Только домена недостаточно; кэшированный HTML отзыва не означает живую интеграцию; серверный виджет может быть не виден браузерному классификатору.

**Фикстуры.** Нарушение: Elfsight `platform.js` и подтверждённый путь виджета в `A`. Чистая: локальный блок отзывов. `inconclusive`: обрезанный сетевой срез без сигнатуры. Контрпример: общий CDN того же провайдера без виджета.

**Правовой якорь.** § 25 TDDDG; Art. 6, 26 DSGVO; EuGH Fashion ID C-40/17. Для Social-Plugins позиция устоявшаяся; для произвольного виджета — Einzelfall.

**Текст находки.** `EMBED-05.widget-loaded`: «Ein externer {widgetType}-Dienst von {service} wurde auf {page} geladen, Zeitpunkt: {phaseDescription}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить пути и классы виджетов в каталоге, Q4.

### 5.4. `CONSENT-06` — Consent Mode

**Что ловим.** Исполненный default `granted`, гонку до default и передачу Google состояния granted до клика либо после отказа.

**Данные и фаза.** `A/B`: init-хук `dataLayer.push` до скриптов, исполненные gtag-команды, consent-API шаблонов, `gcs/gcd` хитов, состояние CMP.

**Алгоритм детекта.** 1) Восстановить порядок исполненных команд. 2) Выбрать default для DE, иначе default без `region`. 3) Сопоставить с моментом клика и CMP denied. 4) Декодировать `gcs/gcd` версионированным декодером. 5) Отделить default без хитов, хит до default и реально переданный granted.

**Evidence.** Порядок команд, тип default/update, безопасное состояние consent, фаза, CMP-state и связанные запросы. Полный `dataLayer`, пользовательские события и идентификаторы не сохраняются.

**Уровень.** `critical` (`google-granted-despite-denied`): Google получает granted до клика или после отказа, включая `gcs=G1x1/G11x` либо подтверждённый `gcd`. `warning`: default granted без хитов (`default-granted`); гонка «хит до default» (`hit-before-default`). Неизвестный `gcd` → `unknown`, без варианта; ненаблюдаемый template API/custom dataLayer → `inconclusive` (`not-observable`).

**Ложные срабатывания и пропуски → защита.** Строка в исходнике без исполнения не считается командой. Список `region` не определяет местоположение сканера. Неизвестный формат не декодируется предположительно. ⚠ проверить формат `gcd` и наблюдаемость API шаблонов.

**Фикстуры.** Нарушение: CMP denied, до клика отправлен хит с распознанным granted. Чистая: default denied, granted только после принятия. `inconclusive`: неизвестный `gcd` и ненаблюдаемый API. Контрпример: неисполняемая строка `consent default granted`.

**Правовой якорь.** § 25 TDDDG; Art. 7 DSGVO. Принцип предшествующего Einwilligung устоявшийся; оценка cookieless/advanced mode спорная.

**Текст находки.** `CONSENT-06.google-granted-despite-denied`: «In einer Anfrage an Google wurde der Zustand {consentState} beobachtet, Zeitpunkt: {phaseDescription}. Der ausgelesene CMP-Zustand war {cmpState}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить `crmCode`, Q2; формат декодера и coverage, Q7; уровни, Q3.

### 5.5. `VULN-01` — ядро CMS и платформы

**Что ловим.** Версию обнаруженного ядра, совпадающую с affected range advisory, и EOL-мажор.

**Данные и фаза.** `A`: HTML и заголовки; Stage 2: `readme.html`, feed. Продукты: WordPress, TYPO3, Joomla, Drupal, Shopware, Contao, Next.js. Источники — WPVulnerability, OSV/GHSA с фильтром NC, CISA KEV.

**Алгоритм детекта.** 1) Определить продукт и `versionConfidence: exact/range/unknown`. 2) Сопоставить версию с affected range. 3) Проверить KEV либо явный pre-auth RCE/SQLi/upload/auth-bypass в advisory. 4) Одного CVSS `AV:N/PR:N` не считать достаточным. 5) Отдельно отметить EOL. 6) Зафиксировать дату, sha256 и лицензию snapshot-источника.

**Evidence.** `component`, источник отпечатка, advisory/CVE, affected range, KEV/pre-auth-основание, `datasets[]`. Без сетевых тел и эксплуатационных запросов.

**Уровень.** `critical` (`version-listed-kev-or-preauth`) = `exact` ∧ affected range ∧ (KEV ∨ указанный pre-auth-класс). Остальные CVE при `exact` (`version-listed`) и EOL-мажор (`eol-major`) — `warning`. `range` понижает на ступень; `unknown` — `version-unknown`, `info` без CVE. Источник недоступен → `inconclusive` (`source-unavailable`). Для `critical` код `T1_EXPLOITABLE_CVE`, остальных сопоставленных вариантов — `T3_OUTDATED_CVE`.

**Ложные срабатывания и пропуски → защита.** Версия в URL может быть cache-buster; backport не устанавливается пассивно; advisory не доказывает применимость конфигурации. Текст сообщает совпадение с базой, без слова «verwundbar».

**Фикстуры.** Нарушение: `exact`-версия ядра в affected range и advisory с pre-auth-классом → `critical`. Чистая: точная исправленная версия. `inconclusive`: нет доступного snapshot. Контрпример: только `?ver=` даёт `range`; неизвестная версия не получает CVE.

**Правовой якорь.** Art. 32 Abs. 1 lit. b, d DSGVO; § 19 Abs. 4 TDDDG. Обновление по Stand der Technik — устоявшаяся обязанность; применимость CVE — Einzelfall. KEV — приоритизация, не правовая норма.

**Текст находки.** `VULN-01.version-listed-kev-or-preauth`, `VULN-01.version-listed`: «Die Datenbank {dataset} listet {cve} für {product} im Versionsbereich {range}. Beobachtete Version: {version}, Zuordnung: {versionConfidence}. Die konkrete Ausnutzbarkeit wurde nicht geprüft.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Источники и пороги подтверждения версии, Q8, Q10. ⚠ проверить семантику `impact` WPVulnerability; не использовать её как pre-auth-признак без проверки.

### 5.6. `VULN-02` — плагины, темы и библиотеки

**Что ловим.** Совпадение версии обнаруженного компонента с advisory; EOL-сигналы по общему правилу VULN.

**Данные и фаза.** `A`: скрипты в памяти ≤ 512 KiB; Stage 2: `readme.txt/style.css`, ≤ 20 проб только для обнаруженных плагинов. WP-компоненты, JS по retire.js; Next.js/Nuxt по runtime-маркерам.

**Алгоритм детекта.** 1) Определить slug/продукт. 2) Извлечь версию по содержимому, имени, хеш-сигнатуре или runtime-маркеру. 3) Только `Stable tag` и `?ver=` считать `range`. 4) Одноимённые и неоднозначные bundled-копии — `unknown`. 5) Применить общую VULN-матрицу.

**Evidence.** `component`, источник версии, advisory и dataset-метаданные. Скрипты обрабатываются в памяти, не сохраняются; хеш-сигнатура библиотеки не является разрешением хешировать пользовательские данные.

**Уровень.** Как `VULN-01`, с теми же вариантами. Для jQuery < 3.5.0 и CVE-2020-11023 в KEV действует правило каталога `critical` только при `exact`; требуется подтверждение заказчика. `range` понижается, `unknown` не получает CVE, недоступный источник → `inconclusive`. `not_applicable` — только когда нет ни WP-компонентов, ни JS-библиотек, ни Next.js/Nuxt; отсутствие WP пропускает только WP-ветку.

**Ложные срабатывания и пропуски → защита.** `Stable tag` не доказывает установленную версию; одна библиотека может иметь несколько копий; minified bundle может не дать точного продукта; backport остаётся ограничением.

**Фикстуры.** Нарушение: точно распознанная affected-библиотека и соответствующая KEV/advisory-запись. Чистая: исправленная точная версия. `inconclusive`: источник отсутствует. Контрпример: только `?ver=` либо неоднозначный bundle → `range/unknown`, без необоснованного `critical`.

**Правовой якорь.** Как `VULN-01`; KEV не является нормой и не доказывает эксплуатацию конкретной установки.

**Текст находки.** `VULN-02.version-listed-kev-or-preauth`, `VULN-02.version-listed`: «Für {product} wurde die Version {version} mit Zuordnung {versionConfidence} beobachtet. {dataset} listet dazu {cve}; die konkrete Ausnutzbarkeit wurde nicht geprüft.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить правило клиентских KEV и CVE из примера Next.js 15.2.8; Q8.

### 5.7. `MAIL-03` — DKIM

**Что ловим.** Отсутствие записи среди конкретно проверенных селекторов, отзыв заданного ключа и ключ < 1024 бит.

**Данные и фаза.** DNS TXT `<selector>._domainkey`; сначала `--dkim-selector`, затем документированные селекторы провайдера по MX, затем короткий generic-список (совместимость с запретом «перебора» в ТЗ — вопрос 16 заказчику; до ответа действует этот порядок); всего ≤ 25 TXT.

**Алгоритм детекта.** 1) Сформировать ограниченный список с происхождением каждого селектора. 2) Запросить TXT. 3) Разобрать ключ; пустой `p=` означает отзыв. 4) Определить размер применимого ключа. 5) Сообщить число проверенных селекторов и результаты.

**Evidence.** Селекторы, rcode, источник выбора, наличие/отзыв, тип и размер ключа. Почтовые сообщения и подписи пользователей не собираются; в отчёте достаточно разобранных свойств публичного ключа.

**Уровень.** Не найдено в списке — `info` (`selectors-not-found`). `warning`: ключ < 1024 бит (`key-too-short`); заданного пользователем селектора нет или он отозван (`given-selector-missing`). DNS-сбой — `error`, не отсутствие DKIM. MX не определяет фактический домен подписи.

**Ложные срабатывания и пропуски → защита.** Custom selector может не попасть в список; поэтому никогда не писать «DKIM fehlt». Документированный селектор провайдера не даёт права повышать отсутствие до `warning`.

**Фикстуры.** Нарушение: заданный селектор отозван либо ключ < 1024 бит. Чистая: заданный валидный ключ. `inconclusive/error`: DNS timeout после повтора. Контрпример: ни один generic-селектор не найден → `info` «unter N geprüften Selektoren nicht gefunden».

**Правовой якорь.** Art. 32 DSGVO косвенно; BSI TR-03108-1/TR-03182, DKIM — технический стандарт.

**Текст находки.** `MAIL-03.selectors-not-found`: «Unter {count} geprüften DKIM-Selektoren wurde kein Schlüssel gefunden. Andere Selektoren und die tatsächliche Signierung wurden nicht geprüft.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить списки и provenance селекторов, Q10; generic-список против «перебора» — вопрос 16 заказчику; коды информационных вариантов, Q2.

### 5.8. `TLS-03` — mixed content

**Что ловим.** Выбранный браузером небезопасный ресурс, его upgrade/block и фактическое состояние передачи; HTTP form action и `ws://`.

**Данные и фаза.** HTTPS-страницы `A`; CDP `Audits.issueAdded`, `Network.requestWillBeSent.mixedContentType`, DOM/CSS: `src`, `href`, `srcset`, `action`, `url()`.

**Алгоритм детекта.** 1) Найти небезопасный URL. 2) Проверить выбор браузером. 3) Установить `upgraded/blocked/loaded`. 4) Проверить `transferred`, не выводя его из строки исходника. 5) Исключить невыбранный `srcset` и неиспользуемое CSS.

**Evidence.** `mixed-content {sourceUrl, selected, resolution, transferred}`, тип ресурса, страница и CDP-основание. URL редактируются, тела отсутствуют.

**Уровень.** `warning`: active blocked (`active-mixed-content-blocked`), passive upgrade failed (`passive-upgrade-failed`), `form action="http://"` (`form-action-http`). `info`: passive auto-upgraded (`passive-auto-upgraded`). Неполная наблюдаемость → `inconclusive` по соответствующему факту. Для иных состояний без строки ruleset уровень не изобретается.

**Ложные срабатывания и пропуски → защита.** Исходный URL не доказывает HTTP-передачу; успешный upgrade не описывается как незашифрованная загрузка. ⚠ проверить CDP-полноту для OOPIF/workers и поведение auto-upgrade.

**Фикстуры.** Нарушение: active HTTP-script заблокирован; отдельно HTTP form action. Чистая: только HTTPS-ресурсы. `inconclusive`: не установлен resolution. Контрпример: невыбранный HTTP `srcset`; успешный passive upgrade → `info`.

**Правовой якорь.** Art. 32 DSGVO; § 19 Abs. 4 TDDDG — технический стандарт.

**Текст находки.** `TLS-03.active-mixed-content-blocked`, `TLS-03.passive-upgrade-failed`, `TLS-03.passive-auto-upgraded`: «Für die ausgewählte Ressource {url} wurde der Browserstatus {resolution} beobachtet. Eine Datenübertragung über HTTP wird daraus nicht pauschal abgeleitet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить полную таблицу реально загруженных ресурсов и `ws://`, Q10; проверить сбор, Q7.

### 5.9. `TLS-04` — TLS 1.0/1.1

**Что ловим.** Подтверждённое принятие сервером устаревшей версии протокола.

**Данные и фаза.** Класс `T`, по умолчанию при включённой проверке: 2 handshake с SNI через `EgressPolicy`. Основной путь — сырой ClientHello через `net.Socket`; запасной — `DEFAULT@SECLEVEL=0`.

**Алгоритм детекта.** 1) Выполнить self-test клиента. 2) Отправить отдельные предложения TLS 1.0 и 1.1. 3) ServerHello с запрошенной версией считать подтверждением. 4) Alert `protocol_version` — отказом версии. 5) `handshake_failure/reset` не считать доказанным отказом версии.

**Evidence.** `tls`: хост, IP, семейство, предложенный/полученный протокол, результат handshake и self-test. Прикладные запросы и тела отсутствуют.

**Уровень.** Подтверждённое принятие — `warning` (`legacy-protocol-accepted`). Неоднозначный отказ → `inconclusive` (`handshake-inconclusive`) «nicht eindeutig». Неспособность клиента выполнить тест → `error` сканера.

**Ложные срабатывания и пропуски → защита.** Локальная блокировка cipher не является отказом сервера; обязательный положительный контроль. ⚠ проверить реализацию на OpenSSL образа.

**Фикстуры.** Нарушение: сервер возвращает ServerHello TLS 1.0. Чистая: явный `protocol_version` для обеих проб. `inconclusive`: reset/`handshake_failure`. Контрпример: self-test клиента не проходит → `error`, а не «старый TLS отключён».

**Правовой якорь.** BSI TR-02102-2 (2026-01), RFC 8996 — технические стандарты; связь с Art. 32 DSGVO и § 19 Abs. 4 TDDDG.

**Текст находки.** `TLS-04.legacy-protocol-accepted`: «Der Server bestätigte in der Handshake-Probe {protocol}. Es wurden keine Anwendungsdaten gesendet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить код заголовков `T3_NO_SECURITY_HEADERS` для TLS-версии; Q2.

## 6. Проверки P2

### 6.1. `DNS-01` — CAA и DNSSEC

**Что ловим.** Отсутствие CAA и unsigned DNSSEC; отдельно подтверждённый bogus.

**Данные и фаза.** DNS: CAA по дереву до eTLD+1, DS у родителя; DNSSEC через доверенную валидацию, DoH opt-in.

**Алгоритм детекта.** 1) Разделить подтипы CAA/DNSSEC. 2) Найти наследуемую CAA. 3) Проверить цепочку DNSSEC доверенным валидатором. 4) Не считать произвольный AD доказательством.

**Evidence.** `dns`, путь поиска, DS, источник валидации, `rcode`; произвольные TXT не копируются.

**Уровень.** Нет CAA (`caa-not-found`) и unsigned (`dnssec-unsigned`) — `info`; подтверждённый bogus — `warning` (`dnssec-bogus`). Недоверенный AD и `SERVFAIL` → `error` или indeterminate, без вывода unsigned.

**Ложные срабатывания и пропуски → защита.** CAA может наследоваться; DS сам по себе не доказывает валидность всей цепочки.

**Фикстуры.** Нарушение: CAA отсутствует либо доверенно подтверждён bogus. Чистая: наследуемая CAA и валидная цепочка. `inconclusive`: недоверенный AD/SERVFAIL.

**Правовой якорь.** RFC 8659 и DNSSEC — технические стандарты; отдельной правовой обязанности не заявляется.

**Текст находки.** `DNS-01.caa-not-found`: «Im dokumentierten Suchpfad wurde kein CAA-Eintrag gefunden.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** `crmCode: null` до справочника; выбор доверенного валидатора не зафиксирован, Q2, Q10.

### 6.2. `HDR-02` — атрибуты cookies и раскрытие версий

**Что ловим.** Сессионную cookie без защитных атрибутов и версии в заголовках.

**Данные и фаза.** Set-Cookie главных документов, `Server`, `X-Powered-By`, `X-Generator`.

**Алгоритм детекта.** 1) Определить роль cookie. 2) Проверить `Secure/HttpOnly/SameSite`. 3) Извлечь публичную версию; передать её VULN как EOL-сигнал.

**Evidence.** Метаданные `cookie`; продукт/версия как `component`. Значения cookies удаляются; произвольные значения заголовков не сохраняются.

**Уровень.** Сессионные `PHPSESSID`, `wordpress_logged_in_*`, `fe_typo_user` без Secure или HttpOnly — `warning` (`session-cookie-attributes`). `info`: прочие cookies без Secure или HttpOnly (`cookie-attributes`), нет SameSite (`cookie-samesite-missing`), версия в заголовке (`version-header`). Неизвестная роль не повышается до сессионной.

**Ложные срабатывания и пропуски → защита.** JS-доступная несессионная cookie не обязана автоматически иметь HttpOnly; версия заголовка не доказывает CVE.

**Фикстуры.** Нарушение: PHPSESSID без Secure/HttpOnly. Чистая: сессионная cookie с атрибутами. `inconclusive`: Set-Cookie не собран. Контрпример: несессионная JS-cookie без HttpOnly → `info`.

**Правовой якорь.** Art. 32 DSGVO; § 19 Abs. 4 TDDDG — технический стандарт.

**Текст находки.** `HDR-02.session-cookie-attributes`: «Bei dem als Sitzungscookie eingeordneten Cookie {name} wurde {attribute} nicht gefunden.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить роли cookies и CRM, Q2, Q4.

### 6.3. `ADMIN-01` — публичные сведения WordPress

**Что ловим.** Публичное раскрытие пользователей вместе с доступным XML-RPC; защищённость входа не определяется.

**Данные и фаза.** Только найденный WP, класс `E`, `--exposure-probes`: 3 GET — `/wp-json/wp/v2/users`, `/?author=1` без перехода, `/xmlrpc.php`. Лимит 4 KiB не отключается, тело не хранится.

**Алгоритм детекта.** 1) Подтвердить WP. 2) Выполнить фиксированные GET. 3) Сохранить число пользователей и факт author-ответа. 4) Проверить ответ XML-RPC, включая 405; без вызовов и входа.

**Evidence.** URL, статусы, счётчики и факты доступности. Имена, логины, тела и адреса author-редиректов с персональными данными не сохраняются.

**Уровень.** Пользователи раскрыты и XML-RPC отвечает — `warning` (`users-and-xmlrpc-exposed`); доступно только одно из двух — `info` (`partial-exposure`). Нет opt-in → `skipped`; незавершённые пробы → `inconclusive`.

**Ложные срабатывания и пропуски → защита.** Ответ 405 не доказывает возможность атаки; отсутствие MFA/rate limit не утверждается.

**Фикстуры.** Нарушение: users endpoint возвращает пользователей, XML-RPC отвечает. Чистая: users закрыт, XML-RPC отсутствует. `inconclusive`: WAF/обрезанный ответ не позволяет установить счётчик.

**Правовой якорь.** Art. 32, Art. 5 Abs. 1 lit. c, f DSGVO — технический и минимизационный контекст. Для класса `E` требуется правовая оценка заказчика.

**Текст находки.** `ADMIN-01.users-and-xmlrpc-exposed`: «Öffentlich abrufbare Benutzerinformationen wurden als Anzahl erfasst; der XML-RPC-Endpunkt antwortete. Anmeldeversuche wurden nicht durchgeführt.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить правовой объём, классификацию ответов и CRM, Q2, Q9, Q10.

### 6.4. `FILE-01` — служебные файлы

**Что ловим.** Сигнатуру секретов, VCS-конфига, дампа или другого служебного содержимого на фиксированном пути.

**Данные и фаза.** Класс `E`, `--exposure-probes`; ≤ 15 путей из списка заказчика; soft-404-базлайн; `Range: bytes=0-4095`, abort и неотключаемый предел 4 KiB.

**Алгоритм детекта.** 1) Проверить opt-in и список. 2) Получить ограниченный фрагмент в памяти. 3) Сопоставить сигнатуру/магические байты. 4) Потребовать отличие от soft-404-базлайна. 5) Отбросить тело; секреты не использовать.

**Evidence.** Путь, статус, тип сигнатуры, факт отличия от baseline, факт усечения. Тело, секреты, их значения и хеши не сохраняются.

**Уровень.** Сигнатура секретов/VCS-конфига/дампа — `critical` (`sensitive-signature`); одиночный `.git/HEAD`, phpinfo, debug.log — `warning` (`exposed-file`); `.DS_Store` — `info` (`minor-file`). SPA-200/WAF не являются положительной находкой; при невозможности оценки — `inconclusive`.

**Ложные срабатывания и пропуски → защита.** HTTP 200 недостаточно; одинаковая SPA-заглушка исключается; фрагмент 4 KiB может не содержать сигнатуру.

**Фикстуры.** Нарушение: синтетический VCS-конфиг, отличный от baseline. Чистая: 404. `inconclusive`: WAF или сигнатура не оценивается в лимите. Контрпример: одинаковый HTML-200 на всех путях.

**Правовой якорь.** Art. 32, 33/34 DSGVO; для сканера §§ 202a/202c StGB, § 4 GeschGehG. Обязанность уведомления сканер не устанавливает.

**Текст находки.** `FILE-01.sensitive-signature`: «Unter {path} wurde innerhalb der begrenzten Antwort eine Signatur vom Typ {signatureType} beobachtet. Der Antwortinhalt wurde nicht gespeichert.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Список путей, сигнатуры, правовая оценка и отсутствующий код вместо «T0»; Q2, Q9, Q10.

### 6.5. `SEC-01` — `security.txt`

**Что ловим.** Отсутствие файла, `Contact` или действующего `Expires`.

**Данные и фаза.** Класс `T`: `/.well-known/security.txt`, затем `/security.txt`; RFC 9116.

**Алгоритм детекта.** 1) Проверить оба расположения по порядку. 2) Исключить HTML/soft-404. 3) Разобрать Contact/Expires. 4) Сравнить срок со временем скана.

**Evidence.** URL, статус, наличие полей, Expires; `mailto:` маскируется до домена.

**Уровень.** Только `info`: файла нет (`security-txt-not-found`); нет `Contact` или `Expires` в прошлом (`security-txt-incomplete`). Timeout → `inconclusive/error`, не «файла нет».

**Ложные срабатывания и пропуски → защита.** HTML-200 не считается файлом; недоступность не равна отсутствию.

**Фикстуры.** Нарушение: оба пути 404 либо Expires в прошлом. Чистая: корректный файл. `inconclusive`: timeout. Контрпример: HTML-заглушка 200.

**Правовой якорь.** RFC 9116 — техническая рекомендация, отдельной правовой обязанности нет.

**Текст находки.** `SEC-01.security-txt-not-found`: «An den geprüften Standardpfaden wurde keine auswertbare security.txt gefunden.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** CRM и полная таблица полей RFC, Q2, Q10.

### 6.6. `LEGAL-02` — устаревшие обозначения

**Что ловим.** Текущую ссылку на старое обозначение нормы или закрытый механизм.

**Данные и фаза.** Impressum/DSE из `documents`; словарь с `validFrom`: TMG → DDG с 14.05.2024, RStV → MStV, TTDSG → TDDDG, OS-Plattform закрыта 20.07.2025, Privacy Shield.

**Алгоритм детекта.** 1) Найти термин. 2) Проверить актуальность по словарю. 3) Исключить историческую цитату. 4) Связать пересечение с `PRIV-02`.

**Evidence.** URL, раздел, цитата ≤ 200 знаков вне блока контактов, правило словаря. Персональные контакты не копируются.

**Уровень.** `info`. PDF, неполный документ или неоднозначный исторический контекст → `inconclusive` по соответствующему фрагменту.

**Ложные срабатывания и пропуски → защита.** Упоминание истории закона не ошибка; старое обозначение не означает автоматически неполное Impressum.

**Фикстуры.** Нарушение: действующая ссылка «gemäß TMG» без исторического контекста. Чистая: DDG/TDDDG/MStV. `inconclusive`: PDF. Контрпример: «Bis 2024 galt …».

**Правовой якорь.** § 5 DDG; § 18 MStV; TDDDG; Art. 13 Abs. 1 lit. c DSGVO. Последствия старого обозначения спорны; проверка информационная.

**Текст находки.** `LEGAL-02.outdated-reference`: «Die Bezeichnung {term} wurde im aktuellen Text gefunden. Bitte den zeitlichen und sachlichen Bezug prüfen.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Словарь, CRM и дедупликация Privacy Shield с `PRIV-02`, Q2, Q10.

### 6.7. `BFSG-01` — автоматические сигналы доступности

**Что ловим.** Автоматически проверяемые правила axe-core; применимость BFSG не определяется.

**Данные и фаза.** Плагин `PageProbe`, `B` с закрытым баннером, ≤ 3 страниц; axe-core 4.14, MPL-2.0; теги `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`.

**Алгоритм детекта.** 1) Выполнить правила. 2) Агрегировать одну находку на правило. 3) `incomplete` представить отдельно.

**Evidence.** ID правила, URL и сведения затронутого элемента; DOM целиком и значения форм не сохраняются. Точный минимизированный формат элемента не утверждён.

**Уровень.** `info`, `gating: false`. Незавершённая проверка → `inconclusive`; axe `incomplete` не считается подтверждённой проблемой.

**Ложные срабатывания и пропуски → защита.** B2C, Kleinstunternehmen и полный WCAG-охват не определяются; требуется ручная оценка.

**Фикстуры.** Нарушение: изображение без доступного имени. Чистая: тот же элемент с именем. `inconclusive`: axe возвращает `incomplete`.

**Правовой якорь.** BFSG, BFSGV, EN 301 549. Применимость конкретному сайту и соответствие не устанавливаются.

**Текст находки.** `BFSG-01.axe-rule-observed`: «Die automatische Prüfung meldete {rule} auf {page}. Anwendbarkeit des BFSG und vollständige Barrierefreiheit wurden nicht geprüft.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Контракт `PageProbe`, редакция element-evidence и CRM, Q2, Q10.

### 6.8. `PERF-01` — лабораторная производительность

**Что ловим.** Однократные lab-метрики и размеры ресурсов.

**Данные и фаза.** Отдельный прогон Lighthouse 13.x через будущий `PageProbe`; LCP, CLS, TBT, размеры.

**Алгоритм детекта.** 1) Выполнить отдельный прогон. 2) Сохранить измеренные значения и условия. 3) Не выдавать lab-метрики за полевые Core Web Vitals.

**Evidence.** Метрика, значение, единица, URL, условия запуска; query редактируется, тела ресурсов не сохраняются.

**Уровень.** Всегда `info`, `gating: false`. Незавершённый прогон → `inconclusive/error`; численные пороги находок не утверждены.

**Ложные срабатывания и пропуски → защита.** Однократный результат зависит от среды; повторяемость и полевые показатели не заявляются.

**Фикстуры.** Нарушение: синтетическая тяжёлая страница с отложенным LCP. Чистая: лёгкий аналог. `inconclusive`: прогон не завершён. Эти сценарии проверяют сбор, а не несогласованный порог.

**Правовой якорь.** Правовой нормы нет; «kein Rechtsbezug».

**Текст находки.** `PERF-01.lab-metrics`: «Laborwert, einmalig: {metric} = {value} {unit}. Kein Rechtsbezug; keine Aussage über Feldwerte.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** `PageProbe`, условия прогона, пороги и CRM, Q2, Q10.

## 7. Служебные диагностики `SCAN-*`

Диагностика имеет `code`, `affects[]`, `evidenceIds[]`; у неё нет `severity` и `crmCode`. В фикстурах «нарушение» ниже означает срабатывание условия диагностики, а не нарушение закона. Для диагностик нет собственного CheckResult: они объясняют статусы затронутых проверок или скана.

### 7.1. `SCAN-GEO`

**Что ловим.** Прямой сигнал CMP о географической ветке, ограничивающей интерпретацию consent-данных.

**Данные и фаза.** CMP-состояния всех соответствующих фаз: Cookiebot `isOutOfRegion`, `CookieConsent=-1`; `__ucCmp.isConsentRequired()`; `complianz.region`; гео-диалог Borlabs; `__tcfapi('ping').gdprApplies`.

**Алгоритм детекта.** 1) Прочитать сигнал через адаптер. 2) Установить его смысл и затронутые страницы/проверки. 3) Записать диагностику. 4) Пометить затронутую оценку `inconclusive`.

**Evidence.** `cmp`, `consent-state`, источник сигнала, `environment.egress`; cookie-значения/TC-String удаляются, остаётся безопасный признак.

**Уровень.** Отсутствует. Обычный режим — без изменения gate только из-за гео; `--strict` может дать `2` по затронутому `inconclusive`.

**Ложные срабатывания и пропуски → защита.** Отсутствие CMP-скрипта, список Consent Mode `region` и сам прокси не являются гео-доказательством.

**Фикстуры.** Нарушение: `gdprApplies: false`. Чистая: нет ограничивающего сигнала. `inconclusive`: API возвращает `loading`, смысл не установлен; подтверждённая гео-диагностика не выдумывается.

**Правовой якорь.** `technical`: ограничение измерения; термин EWR.

**Текст находки.** Ключ диагностики `SCAN-GEO`: «Die CMP meldete eine geografisch abhängige Konfiguration. Betroffene Einwilligungsprüfungen sind nicht abschließend auswertbar.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Полная семантика сигналов по версиям CMP и порядок показа нескольких сигналов, Q5, Q10.

### 7.2. `SCAN-BOTMODE`

**Что ловим.** Прямое указание CMP на специальную обработку автоматического клиента.

**Данные и фаза.** CMP-адаптеры: Cookiebot `isSpider()`, Real Cookie Banner `accept-all-for-bots` и другие подтверждённые ветки.

**Алгоритм детекта.** 1) Прочитать прямой сигнал. 2) Связать с затронутыми фазами. 3) Сохранить диагностику и `inconclusive`. 4) Не скрывать собранные факты.

**Evidence.** CMP-ветка, UA и состояние без cookie-значений.

**Уровень.** Нет. Без `--strict` диагностика сама код не меняет; strict учитывает незавершённость оценки.

**Ложные срабатывания и пропуски → защита.** Consent-cookie до клика сама по себе не бот-сигнал; `granted` без действия может быть `CONSENT-04.consent-without-action`.

**Фикстуры.** Нарушение: `isSpider() = true`. Чистая: обычная ветка CMP. `inconclusive`: признак не читается; одна cookie не заменяет его.

**Правовой якорь.** `technical`, без правового вывода.

**Текст находки.** Ключ `SCAN-BOTMODE`: «Die CMP meldete einen speziellen Modus für automatisierte Zugriffe. Betroffene Einwilligungsprüfungen sind nicht abschließend auswertbar.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** ⚠ проверить поведение буквального UA на семи CMP; Q5, Q7.

### 7.3. `SCAN-BLOCKED`

**Что ловим.** WAF, challenge или 403, препятствующие оценке страницы.

**Данные и фаза.** Стартовая навигация и подстраницы; HTTP-статус и признаки challenge, включая Turnstile как WAF.

**Алгоритм детекта.** 1) Отличить challenge от обычного содержимого. 2) На стартовой установить `scan.status: failed`. 3) На подстранице отметить `evaluated: false` и сохранить её в coverage.

**Evidence.** URL, статус, безопасные признаки блокировки, затронутые ID. Тело challenge и токены не сохраняются.

**Уровень.** Нет. На старте скан не состоялся → fatal `2`; подстраница — по остальным правилам gate.

**Ложные срабатывания и пропуски → защита.** CAPTCHA обычной формы не равна WAF; блокировка не превращается в отсутствие DSE/Impressum или заголовков.

**Фикстуры.** Нарушение: 403/challenge на старте → `failed`. Чистая: обычный 200. `inconclusive`: challenge только на Kontakt → неполное покрытие.

**Правовой якорь.** `technical`, ограничение доступа.

**Текст находки.** Ключ `SCAN-BLOCKED`: «Der Zugriff auf {page} wurde durch eine Zugriffssperre oder Challenge eingeschränkt; die Seite wurde nicht inhaltlich ausgewertet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Сигнатуры challenge и различение обычного 403, Q10.

### 7.4. `SCAN-UNREACHABLE`

**Что ловим.** Невозможность начать содержательный скан цели.

**Данные и фаза.** DNS и стартовая: NXDOMAIN, отказ соединения на 80 и 443, timeout или 5xx стартовой дважды.

**Алгоритм детекта.** 1) Классифицировать DNS/соединение/навигацию. 2) Выполнить предусмотренный повтор. 3) При выполнении условия записать `failed` и причину.

**Evidence.** qname/rcode либо URL, попытки, ошибка соединения, статусы и время; credentials и секретные параметры не сохраняются.

**Уровень.** Нет; невозможный скан — fatal `2`.

**Ложные срабатывания и пропуски → защита.** Ошибка сертификата отвечающего сайта относится к `TLS-02`, не к общей недоступности. Единичный 5xx не равен двум неудачным навигациям.

**Фикстуры.** Нарушение: NXDOMAIN либо два 5xx стартовой. Чистая: успешный повтор после первого 5xx. `inconclusive`: получен один сбой, повтор не завершён; незавершённость отражается без утверждения нужного числа попыток.

**Правовой якорь.** `technical`; недоступность не квалифицируется как нарушение сайта.

**Текст находки.** Ключ `SCAN-UNREACHABLE`: «Die Zielseite konnte unter den dokumentierten Versuchsbedingungen nicht für den Scan erreicht werden: {reason}.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить расширение exit `2` на невозможный скан, Q5; интервалы повторов, Q10.

### 7.5. `SCAN-THROTTLED`

**Что ловим.** Три последовательных ответа 429/503 на пробах; в браузере — 429/503 на навигации или ≥ 3 таких ответа целевого хоста за фазу после паузы по `Retry-After` (≤ 30 с) и одного повтора.

**Данные и фаза.** HTTP-коллектор проб и браузерные навигации, порядок ответов, `Retry-After`, затронутые проверки.

**Алгоритм детекта.** 1) Считать последовательные 429/503. 2) После третьего (в браузере — после повтора) зафиксировать throttling, не начинать новые навигации к хосту и не продолжать затронутый сбор так, будто покрытие полное. 3) Отметить затронутые результаты `partial`.

**Evidence.** URL, статусы и время последовательности; query редактируется, тела ответов отсутствуют.

**Уровень.** Нет; код по находкам, ошибкам и strict-условиям, без отдельного порога диагностики.

**Ложные срабатывания и пропуски → защита.** Один 503 не доказывает throttling. Диагностика не сообщает мотив защиты сервера.

**Фикстуры.** Нарушение: 429, 503, 429 подряд. Чистая: успешные ответы без серии. `inconclusive`: сбор оборван до завершения серии; недостающие пробы не считаются чистыми.

**Правовой якорь.** `technical`, ограничение сбора.

**Текст находки.** Ключ `SCAN-THROTTLED`: «Der Zielhost antwortete wiederholt mit 429 oder 503. Die betroffene Erfassung ist unvollständig.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Точный scope счётчика и прекращения проб не задан; Q10.

### 7.6. `SCAN-TIMEOUT`

**Что ловим.** Достижение глобального `--timeout`.

**Данные и фаза.** Оркестратор, незавершённые коллекторы/проверки, уже собранные находки.

**Алгоритм детекта.** 1) На дедлайне прекратить сбор. 2) Незавершённые проверки отметить `error(timeout)`. 3) Сохранить частичный отчёт с резервом 30 с. 4) Передать все причины в gate.

**Evidence.** Настроенный timeout, длительность, незавершённые ID, coverage; исключения редактируются до записи.

**Уровень.** Нет. Timeout до завершения фазы `A` на стартовой → `scan.status: failed`, fatal `2` (`timeout`). После частичного сбора: при учитываемой находке — `1`; иначе `2`, если незавершённые проверки релевантны; иначе `0`. Fatal-ошибка записи отчёта имеет высший приоритет.

**Ложные срабатывания и пропуски → защита.** HARD_CAP отдельной страницы не равен глобальному timeout; уже собранные находки не теряются.

**Фикстуры.** Нарушение: глобальный дедлайн с незавершённой релевантной проверкой. Чистая: всё завершено. `inconclusive`: частичные данные сохранены, незавершённые результаты явно помечены; отдельно проверяется приоритет существующего `1`.

**Правовой якорь.** `technical`.

**Текст находки.** Ключ `SCAN-TIMEOUT`: «Das globale Zeitlimit wurde erreicht. {count} Prüfungen wurden nicht vollständig abgeschlossen; bereits erfasste Beobachtungen bleiben im Bericht enthalten.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Подтвердить приоритеты gate, Q5.

### 7.7. `SCAN-SANDBOX-OFF`

**Что ловим.** Явный запуск браузера с `--sandbox off`.

**Данные и фаза.** Опции запуска и `environment.sandbox`.

**Алгоритм детекта.** 1) Проверить явный `off`. 2) Записать диагностику. 3) Показать предупреждение в консоли и Summary. Автоматического fallback нет.

**Evidence.** Режим sandbox и источник опции; без локальных секретов среды.

**Уровень.** Нет. Обычный режим — код не меняется; `--strict` → `2`, если отсутствует более приоритетный `1`. Неуспех `require` — fatal `2`, а не скрытый переход в `off`.

**Ложные срабатывания и пропуски → защита.** Опция `require` не считается выполненной без успешного старта; `off` не объявляет наблюдения сайта ложными автоматически.

**Фикстуры.** Нарушение: явный `off`. Чистая: работающий `require`. `inconclusive/error`: sandbox не стартует при `require` → `failed`, без fallback.

**Правовой якорь.** `technical`, безопасность среды сканера.

**Текст находки.** Ключ `SCAN-SANDBOX-OFF`: «Der Browser wurde auf ausdrückliche Option ohne Chromium-Sandbox gestartet.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** ⚠ проверить sandbox на GitHub/GitLab runners; Q7.

### 7.8. `SCAN-PRIVATE-REQUEST-BLOCKED`

**Что ловим.** Запрос, заблокированный egress-политикой из-за запрещённого адреса назначения.

**Данные и фаза.** Единый `EgressPolicy`: in-process HTTP/CONNECT-прокси браузера, undici, `node:tls` (`TLS-02`) и `net.Socket` (`TLS-04`); IP при фактическом соединении, все A/AAAA, IPv4-mapped и rebinding. За upstream `--proxy` (только `http://`) уходит `CONNECT <проверенный IP>:<port>`; сеть и ACL самого upstream — вне границы.

**Алгоритм детекта.** 1) Проверить адрес соединения. 2) Запретить loopback/private/link-local/metadata. 3) Разрешить публичный IPv6. 4) Не выполнять соединение к запрещённому адресу. 5) Сохранить диагностику и влияние на coverage.

**Evidence.** Очищенный URL, адрес/класс блокировки, источник разрешения и затронутые ID. Внутренний ответ не получается и не сохраняется.

**Уровень.** Нет; последствия для проверки выражаются её статусом. Отдельная безусловная политика exit для этой диагностики не зафиксирована.

**Ложные срабатывания и пропуски → защита.** Проверять фактический IP, а не только предварительный DNS. Прокси является политикой для неуязвлённого браузера; принудительная сеть из двух контейнеров находится вне релиза.

**Фикстуры.** Нарушение: публичное имя резолвится при соединении в private/metadata IP. Чистая: публичные IPv4/IPv6. `inconclusive`: необходимый ресурс заблокирован, зависимая проверка не может завершиться; контрпример — rebinding и IPv4-mapped адрес.

**Правовой якорь.** `technical`, защита сканера и среды исполнения; правовой вывод о цели отсутствует.

**Текст находки.** Ключ `SCAN-PRIVATE-REQUEST-BLOCKED`: «Eine Verbindung wurde durch die Netzwerkregel des Scanners blockiert: {addressClass}. Betroffene Ressourcen wurden nicht abgerufen.»  
**Entwurf — Prüfung durch Auftraggeber.**

**Открытые вопросы.** Утвердить переходы статусов/strict для затронутых проверок; Q10. ⚠ проверить техническую полноту прокси, Q7.

## 8. Gate, ошибки и воспроизводимость

`--fail-on critical` — умолчание; допустимы `warning` и `none`. Порог включает равный уровень. `info` никогда не гейтит.

Учитываются находки без действующего suppression и вне baseline; рост severity относительно baseline возвращает находку в gate. Suppression требует `reason` и `expires`, не скрывает `error`, `inconclusive`, диагностику и неполное покрытие.

Приоритет: `2 (fatal)` → `1 (threshold)` → `2 (relevant error / strict)` → `0`.

| Ситуация | Результат |
|---|---|
| Есть учитываемая находка | `1`, даже при ошибке другой проверки; все причины в `exitReasons[]` |
| Ошибка релевантной проверки, пороговой находки нет | `2` |
| Только неизвестный баннер, гео-/бот-режим | Без strict сами код не меняют |
| `--strict` и затронутое `inconclusive` | `2`, если нет более приоритетного результата |
| `--strict`, consent-проверки включены, `egress.region: unknown` | `strict:egress-unverified` |
| Старт недоступен/WAF, браузер не запустился, sandbox `require` не поднялся | Fatal `2` |
| Глобальный `--timeout` до завершения фазы `A` на стартовой | Fatal `2` (`timeout`); позже — `1` при находке, иначе `2` при незавершённых релевантных, иначе `0` |
| Сайт отвечает, TLS невалиден | `TLS-02 critical`, browser `skipped (tls-blocked)`; код по порогу |
| Не записан JSON или запрошенный HTML/JUnit/Summary | Fatal `2` (`report-write-failed`); JSON пишется первым и после репортёров атомарно перезаписывается с окончательным `exitCode` |
| Не напечатан явно запрошенный PDF | Одна строка предупреждения, без `report.pdf`; код выхода и `report.json` не меняются |
| `--fail-on none` | `0`; `2` при fatal или strict-причинах (`--strict` действует независимо) |

Релевантность вычисляется из включённости, `gating` и статического максимума `variants` после ruleset и overrides (`locked`-варианты не поднимаются); кэп confidence применяется только к конкретной находке, а не к релевантности. Неполученные данные не заменяются пустыми массивами с результатом `completed`.

Fingerprint: `sha256(JCS{v:1, checkId, variantGroup, subject})`, без хоста цели, страниц и фаз. Поэтому новые затронутые страницы при прежнем `variantGroup/severity` могут не вернуть находку из baseline; страницы остаются в evidence. Для устойчивого сравнения выборка закрепляется `pages:`.

`subject` по ID ([архитектура](02-architecture.md) §11.8):

| Проверки | `subject` |
|---|---|
| `CONSENT-01/05/06`, `TRACK-01`, `EMBED-*`, `PRIV-01` | `serviceId`; неизвестный хост — `unknown:<eTLD+1>` |
| `CONSENT-02`, `HDR-02` | `name` + (`first-party` или eTLD+1) + `path` + partitioned |
| `CONSENT-03`, `CONSENT-04` | `consent-ui` |
| `PRIV-02` | `claimId` + `serviceId` |
| `HDR-01` | имя заголовка |
| `MAIL-*`, `DNS-01` | вид записи |
| `LEGAL-01` | тип документа |
| `LEGAL-02` | id устаревшего термина |
| `TLS-01` | `http-entry:` + роль хоста (`final` / `pair`) |
| `TLS-02` | `certificate:` + роль хоста |
| `TLS-03` | `resourceType` + (`first-party` или eTLD+1) |
| `TLS-04` | версия протокола + роль хоста |
| VULN | `product` + CVE |
| `FILE-01` | путь |
| `ADMIN-01` | endpoint |
| `SEC-01` | `security.txt` |
| `BFSG-01` | id правила axe |
| `PERF-01` | метрика |

Приёмка: все `mustFind` найдены, 0 известных ложных `critical` на CMP-лаборатории и корпусе, доля `inconclusive` показана по ID. Корпус из 10 сайтов не даёт основания заявлять precision 99 %.

## 9. Открытые вопросы: ошибки и неясности каталога

### Q1. Приоритеты и состав релиза

| Вопрос | Зафиксированное направление | Что подтвердить |
|---|---|---|
| `CONSENT-05` | Перенос P1 → обязательный релиз вместе с 15 P0 | Расширение manifest до этапа 1 |
| Остальные P1 | Этап `3б`, после manifest, в порядке каталога | Объём бюджета; VULN первыми исключаются |
| P2 | После релиза | Не считать описанный детект обязательством релиза |
| `ADMIN-01`, `FILE-01` | Только opt-in класса `E` | Правовую оценку и список разрешённых проб |
| `MAIL-02` | SoftFail зависит от DMARC | Исправить безусловную трактовку `~all` как дефекта |

### Q2. `crmCode` и дедупликация

| ID/вариант | Неясность | До подтверждения |
|---|---|---|
| `EMBED-03` | Видео имеют код карт `T1_MAPS_BEFORE_CONSENT` | Сохранить исходный код с пометкой ошибки в документации |
| `CONSENT-06` | `T1_TRACKER_BEFORE_CONSENT` — намеренная агрегация или ошибка | Сохранить код каталога |
| `TRACK-01` | T1-код у `info`-инвентаря, включая `after-accept` | Подтвердить инвентарную семантику и маппинг вариантов |
| `TLS-04` | Код заголовков для версии TLS | Сохранить исходную строку до решения |
| P2 | В каталоге нет кодов | `null` |
| `FILE-01` | «T0» не является полным кодом | `null` |
| Неизвестный CMP | CRM не должна получать оценочную находку | `crmCode: null`, без CRM-экспорта |
| Прочие `info` | Нет полного маппинга по вариантам | `null`, если вариант не сопоставлен заказчиком |

Подтвердить, что CRM принимает `null` и маппинг по `(checkId, variant)`. Политику `null` требуется зафиксировать до этапа 1, конкретные коды — до конца `3а`. Смена маппинга — minor-релиз.

Подтвердить маршрутизацию: `CONSENT-01` владеет своими сетевыми категориями, EMBED — своими, `TRACK-01` остаётся связанным инвентарём. Дубли одного наблюдения не должны повторно гейтить CI.

### Q3. Подпись уровней

К концу `3а` заказчик подписывает ruleset, включая:

- `CONSENT-04`: блокирующий вариант и закрытие с принятием — `critical`; ссылка, неблокирующий баннер и Pur-Abo — `info`.
- `CONSENT-03`: `critical` только при сильном tracking и заявленном EWR.
- `PRIV-01`: максимум `warning`; категорийное описание — `info`.
- `PRIV-02`: `critical` только при точном и воспроизведённом противоречии.
- `EMBED-01`: `warning` при T1-коде.
- Cookieless pings: `warning`; `A′` — тот же уровень, что `A`.
- `LEGAL-01`: отсутствие после промежуточного перехода и фолбэка.
- `TLS-01`: разграничение http-only, рабочего HTTPS и форм.
- CAPTCHA при видимой форме — `info`; отсутствие anti-framing — `warning`.
- `MAIL-02`: `~all` при DMARC-enforcement — `info`; `EMBED-02…05` — `warning` при коде T1.
- `TLS-02`: относительный порог срока, короткоживущие сертификаты без находки.
- `CONSENT-01`: хит с `user-supplied`-идентификатором при `denied` в Consent Mode — `critical` или `warning`; отправленный запрос без ответа (`request-not-completed`) — `info`.
- `CONSENT-04`: `no-choice-at-first-layer` — `info`.

До подписи ruleset и немецкие тексты имеют статус draft; релиз заблокирован.

### Q4. Каталог сервисов, cookies и описаний политики

Нужны экспорт собственных аудитов заказчика, утверждённые алиасы продуктов/операторов, category terms, `policyRelevance`, cookie/storage-сигнатуры и allowlist с provenance. Подтвердить стандарт `PRIV-01`: продукт, оператор или категория с ручной оценкой.

Неизвестный домен не становится трекером; совпадение имени cookie без контекста не считается достаточной классификацией.

### Q5. Среда и коды возврата

Подтвердить смысл `critical`, приоритеты `0/1/2`, fatal при недоступном старте/WAF и требования к EWR-egress. По умолчанию браузерный UA содержит реальный Chrome UA и токен со ссылкой на репозиторий; изменение этого требования возможно только после ответа заказчика.

`--proxy` и `--assume-region eea/de` отражают заявление пользователя, а не независимую проверку местоположения. Для доказательных аудитов предложено использовать DE/EWR-egress и `--strict`; в клиентском CI допустим `unknown` с ограничениями.

### Q6. Evidence и тексты

Подтвердить скриншот области баннера по умолчанию, оценку UrhG § 51, retention 14 дней, маскирование `mailto:` и запрет экспорта значений/хешей storage. Утвердить немецкие тексты, `legalNote`, статусы источников, `reviewedAt`, `reviewBy`, стоп-листы и лицензию текстов.

Немецкие формулировки в документе — **Entwurf — Prüfung durch Auftraggeber**. Дополнительные имена вариантов §2.1 и схема ключей `reason.<id>` — **предложение автора, не согласовано**.

### Q7. Факты с пометкой «⚠ проверить»

| Факт | Влияние | Срок проверки |
|---|---|---|
| Поведение буквального UA на семи CMP | `SCAN-BOTMODE`, доля `inconclusive` | Этап 0 |
| Persistent-профиль и обычный визит | Полнота preconnect и сетевого наблюдения | До этапа 1 |
| `EgressPolicy` и egress-прокси: IP при соединении, CONNECT, HTTP/2, WebRTC/QUIC; приём upstream'ом `CONNECT` на IP-литерал | `SCAN-PRIVATE-REQUEST-BLOCKED`, полнота сети | До этапа 2 |
| Sandbox на GitHub/GitLab runners | Запуск и `SCAN-SANDBOX-OFF` | До CI-шаблонов |
| CDP pagehide/keepalive/SW | `CONSENT-05` | До начала проверки в `3а` |
| Актуальность DSK OH и точные Rn., включая Rn. 125 о первом уровне без возможности согласия | CONSENT/EMBED/LEGAL `legalNote`, `no-choice-at-first-layer` | До подписи ruleset |
| Rechtskraft OLG Köln; Berufung VG Hannover (дата 19.03.2025 подтверждена); деталь GTM | `CONSENT-01/04` | `3а` |
| EDPB: скролл не согласие; Type C | `A′`, `reject-as-link` | `3а` |
| `p.typekit.net` — font-хост | `EMBED-01` | `3а` |
| `youtube-nocookie.com` и localStorage | `EMBED-03` | `3б` |
| Mixed-content auto-upgrade, OOPIF/workers | `TLS-03` | `3б` |
| Формат `gcd`, наблюдаемость GTM template API | `CONSENT-06` | `3б` |
| Семантика `impact` WPVulnerability | Pre-auth-классификация VULN | `3б` |
| TLS 1.0/1.1-клиент в образе | `TLS-04` | Спайк этапа 0 |

Эти пункты не считаются подтверждёнными из-за их использования в алгоритмах.

### Q8. Ошибки примеров VULN

В примере «Next.js 15.2.8 с обходом авторизации middleware» требуется CVE ID. Если имелся в виду CVE-2025-29927, ветка 15.x исправлена в 15.2.3; пример нельзя использовать как положительную фикстуру без уточнения.

Для jQuery < 3.5.0 и CVE-2020-11023 подтвердить правило `KEV → critical` для клиентской библиотеки при версии `exact`. Альтернатива заказчика — `warning` без pre-auth server-side вектора; до решения не подменять правило собственной оценкой.

### Q9. Пассивные exposure-пробы

Утвердить список ≤ 15 путей `FILE-01` и 3 GET `ADMIN-01`, правовой объём и допустимость обработки ограниченного фрагмента. Флаг `--exposure-probes` не создаёт разрешения владельца сайта. Проверки не включают подбор, вход, XML-RPC-вызовы, инъекции или использование секретов.

### Q10. Неутверждённые детали контрактов

Следующие пробелы нельзя закрывать скрытыми эвристиками:

| Область | Требуемое решение |
|---|---|
| `CONSENT-04` | Пороги/комбинации измеренной блокировки, диапазоны версий CMP, подтверждение функции кнопок |
| `CONSENT-05` | Точные denied-состояния и признаки сохранения после reload для каждого адаптера |
| `PRIV-02` | Окончательные claim ID, грамматики, условия и ограничения фаз |
| `MAIL-*` | Полная MX/Null MX-матрица и поведение при недоступном связанном DMARC; generic-селекторы `MAIL-03` — вопрос 16 заказчику |
| `HDR-01` | Источник и обновление HSTS-preload |
| `TLS-01`, `LEGAL-01`, `FILE-01`, `SEC-01` | Критерии заглушки, содержательности и soft-404 без новых несогласованных численных порогов |
| VULN | Достаточные признаки `exact`, EOL-источник, обработка неоднозначных bundled-копий; запись понижения `range` (отдельные варианты или `confidence`) и `crmCode` понижённой находки |
| `TLS-03` | Уровни остальных подтверждённых состояний, включая loaded и `ws://` |
| `DNS-01` | Доверенный валидатор и граница `error/indeterminate` |
| `BFSG-01`, `PERF-01` | Контракт `PageProbe`, минимизация plugin-evidence, условия и пороги измерений |
| `SCAN-*` | Scope throttling, интервалы повторов, влияние private-request block на статусы и strict |
| Все ID | Варианты и `messageId` закреплены в §2.1; открыты `variantGroup` (кандидаты в общую группу — пары одной оси, например `TLS-02.certificate-expiring`/`certificate-expiry-approaching`, `PRIV-02.contradiction-*`), CRM-коды `info`-вариантов и фикстуры на каждый вариант |

Конкретные фикстуры и новые ключи сообщений в этом документе, а также детализация этапов для `SCAN-*` — **предложение автора, не согласовано**. Их требуется утвердить как примеры контракта; они не вводят новые уровни, сетевые действия или правовые выводы.