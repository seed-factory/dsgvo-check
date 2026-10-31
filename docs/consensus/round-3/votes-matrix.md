# Раунд 3 — матрица голосов критиков

Машинная сводка голосов по точкам D01–D27. Источник для Claude — структурированные ответы агентов, для Codex — таблицы раздела 1 их критик. Обоснования — в самих файлах критик.

## D01

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Все 15 P0 плюс CONSENT-05; FILE-01 вне релиза (opt-in после); HTML в релизе | Opus, Fable, Terra, Sol | high |
| Opus (архитектура) | Все 15 P0 + CONSENT-05; FILE-01/P2 вне релиза; P1 по manifest после | Opus, Fable, Terra | high |
| Sol (детект) | Все 15 P0 **плюс CONSENT-05**; остальные P1 не делать обязательными. | Opus, Fable, Terra | high |
| Terra (тесты/CI) | Все 15 P0; добавить CONSENT-05 в релизный manifest после согласования. Остальные P1/P2 — по порядку каталога. | Opus, Fable, Terra | high |

## D02

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | JSON, консоль, HTML без JS, JUnit + GitHub Job Summary; PDF командой report --pdf из того же HTML — в релиз при ≈1–2 PD, иначе первый пост-релиз; без SARIF/GitLab CQ | Opus, Fable | medium |
| Opus (архитектура) | JSON+консоль+HTML без JS+JUnit+GH Summary в релизе; PDF как report-рендер последним и первым на вылет; без SARIF/CQ | Opus, Sol, Terra | medium |
| Sol (детект) | JSON, консоль, статичный HTML, Job Summary и JUnit; PDF — следующий инкремент, SARIF — позже. | Fable; частично Opus | medium |
| Terra (тесты/CI) | JSON и консоль обязательны; HTML планировать в MVP; PDF — stretch. JUnit — только если решена семантика CI, SARIF и GitLab Code Quality — позже. | Fable | high |

## D03

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | 2 только когда скан невозможен (недоступен/WAF/таймаут/fatal/аргументы); ошибка одной проверки → status=error и exit по порогу, --strict → 2; fatal(2) > 1 > 0; баннер не распознан → info + inconclusive без влияния на код | Fable, Opus | high |
| Opus (архитектура) | gate() чистая: 2(fatal) > 1 > 2(ошибка проверки, релевантной порогу по статическим variants) > 0; баннер/гео/бот не влияют; один --strict; exitReasons[] в JSON | Opus | medium |
| Sol (детект) | `2 > 1 > 0`: ошибка исполнения заказанной операции, включая включённую проверку или запись отчёта, — `2`; активная находка на пороге — `1`; иначе `0`. Недоступность/WAF — `2`; неизвестный баннер — info и `inconclusive`, сам по себе `0`, а при явно заданном требовании полноты — `2`. | Sol, Terra | high |
| Terra (тесты/CI) | Предлагаю `2 > 1 > 0`: `2` при невозможности выполнить заказанную операцию, `1` при достижении порога, `0` иначе. Нераспознанный баннер — `info` и `inconclusive`; строгий coverage — отдельный режим. | Sol, Terra | medium |

## D04

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Три оси status/severity/confidence без pass/fail; confidence кэпит уровень (Opus); SCAN-* как отдельный массив diagnostics без severity; дедупликация primary/linked (Fable) | Opus, Fable, Terra, Sol | high |
| Opus (архитектура) | status/severity/confidence раздельно; confidence капирует severity в assess; Diagnostic вне гейта; limitations[] в CheckResult; без pass/fail | Opus, Sol | high |
| Sol (детект) | Раздельные observation, coverage/status, severity и confidence; никаких `pass` как утверждения соответствия. | Все | high |
| Terra (тесты/CI) | Раздельные `status`, `severity`, `confidence`, coverage и причины. `inconclusive` никогда не представлять как `pass`. | Все | high |

## D05

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | collectors → неизменяемый отредактированный Snapshot → чистые checks → assess по ruleset-данным → gate → reporters; явный реестр + тест полноты; ProbeSpec (Opus) как единственный путь к дополнительным запросам | Opus, Fable, Terra, Sol | high |
| Opus (архитектура) | Сырой снимок → derive (пересчитывается) → checks по requires-срезу → assess → gate → репортеры; явный реестр + тест полноты; variants в контракте; ProbeSpec; CMP extract/decide | Opus, Sol | medium |
| Sol (детект) | Сбор → извлечение безопасных признаков → минимизированный снимок → чистые проверки → assessment → gate → reporters; явный реестр в слое checks. | Opus, Fable; конвейер — все | high |
| Terra (тесты/CI) | Сбор → минимизация → неизменяемый снимок → чистые проверки → ruleset/gate → репортеры; сборочный manifest проверок и декларация capabilities. | Все | high |

## D06

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | pnpm-workspace: один публикуемый пакет + приватные fixture-server/test-utils; отдельные репо для example, GitLab-component и приватной канарейки | Fable, Opus, Sol | high |
| Opus (архитектура) | Один пакет без workspace; fixture-server/test-utils как каталоги test/; отдельные репо для примера, GitLab, канарейки | Sol | medium |
| Sol (детект) | Один публикуемый пакет; workspace с приватными тестовыми пакетами допустим. | Все по существу | high |
| Terra (тесты/CI) | Один публикуемый пакет; внутренние каталоги и тестовые инструменты без обязательного монорепо. | Sol, Terra | high |

## D07

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Node ≥24 (CI 24/26), TS 7, pnpm 11, Vitest 5, Biome 2.6 + oxlint-tsgolint, zod 4 → JSON Schema 2020-12 + Ajv, playwright-core 1.64.x пин, undici 8; лицензионный allowlist зависимостей в CI | Fable, Opus | medium |
| Opus (архитектура) | Node>=24 (CI 24/26), TS 7.0 (fallback 6.0), pnpm 11, Vitest 5, Biome+oxlint-tsgolint, zod4→JSON Schema, Ajv, playwright-core точный пин, без бандлера | Opus, Fable, Sol | high |
| Sol (детект) | Node 24 как базовый runtime; TypeScript, pnpm, Vitest, Biome и проверка промисов; `tsc` для сборки. Точные версии — после совместимого smoke на этапе 0. | Opus, Fable; Node — Sol | medium |
| Terra (тесты/CI) | Node 24 и 26 в CI, TypeScript, pnpm с lockfile, Vitest, Biome, сборка в один пакет; Playwright и браузер фиксировать вместе. Точные версии выбрать и проверить на этапе 0. | Opus, Fable, Sol, Terra — частично | medium |

## D08

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | A, A′, B, C в свежих persistent-профилях плюс M (мобильный первый уровень, только стартовая) в релизе; B/C — стартовая + 2 страницы | Opus, Sol | medium |
| Opus (архитектура) | A+A′ в одном свежем persistent-профиле; B, C, M — по свежему профилю; B/C на стартовой+2 стр.; M только стартовая | Opus, Sol | medium |
| Sol (детект) | Три независимых свежих persistent-профиля A/B/C; одинаковые контентные URL и действия, legal-документы в A/B; отдельно мобильный первый слой. | Terra — сопоставимость; Opus, Sol — mobile | high |
| Terra (тесты/CI) | Независимые профили A/B/C; A′ как маркированное нейтральное взаимодействие; отдельный мобильный первый слой M. В A проверять выбранные страницы с контролем накопленного состояния; B/C — вход и общую контрольную подвыборку. | Sol — ближе всего | high |

## D09

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | 6 страниц (старт, Impressum, Datenschutzerklärung, Kontakt, 2 по ключевым словам/sitemap); robots для доп. страниц; --timeout 8m; scope = финальный хост + www/apex; LEGAL-01 строго «auf n von m geprüften Seiten» с одним переходом через Kontakt/Rechtliches до вывода «не найдено» (BGH I ZR 228/03) | Fable, Opus, Sol | high |
| Opus (архитектура) | 6 страниц, детерминированный выбор + pages: в конфиге; robots для доп. страниц; хост+www/apex; тишина 2 с; потолок 8 мин | Opus, Fable, Sol | high |
| Sol (детект) | Шесть уникальных URL, включая документы; отдельный небольшой бюджет приложений политики; восемь минут сбора плюс резерв записи. | Ближе Sol | medium |
| Terra (тесты/CI) | До шести уникальных страниц, включая документы; детерминированный выбор, фиксированный scope, robots для дополнительных страниц, ограниченные запросы и общий deadline с резервом на отчёт. | Sol | medium |

## D10

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | HTTP-пробы — полный UA со ссылкой на репозиторий; браузер — реальный Chrome UA + нейтральный токен без URL, прошедший CI-тест против isbot/регулярок CMP (Opus), плюс идентифицирующий заголовок X-<Name> со ссылкой (профиль visitor Fable), From: по --contact; детектор SCAN-BOTMODE обязателен; умолчание — решение заказчика | Opus, Fable | medium |
| Opus (архитектура) | HTTP-пробы — UA с репо; браузер — Chrome UA + токен, ссылка по решению заказчика после спайка; без кастомных заголовков; детектор бот-режима → inconclusive | Opus | medium |
| Sol (детект) | Сохранить идентификатор и ссылку в browser UA; подтверждённое особое поведение CMP — ограничение измерения. Диагностический visitor-прогон — только как отдельно согласованный режим. | Sol, Terra | high |
| Terra (тесты/CI) | Ссылка на репозиторий и идентификатор в UA браузера и HTTP по ТЗ; bot mode — ограничение зависимых выводов. Альтернативный UA только после явного изменения требования. | Sol, Terra | high |

## D11

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Гео-сигналы CMP → SCAN-GEO в diagnostics, затронутые проверки inconclusive (не warning); --proxy, --assume-region, --require-eu-egress; CONSENT-03 critical только без CMP-скрипта или при подтверждённом egress из EWR; терминология EWR, не EU | Opus, Fable, Sol | high |
| Opus (архитектура) | Гео-сигналы CMP → inconclusive+SCAN-GEO; --proxy; без what-is-my-IP; CONSENT-03 critical только без CMP-скрипта или при ЕС-egress | Opus, Fable, Sol | high |
| Sol (детект) | Для немецкого эталонного прогона — контролируемый DE-egress; происхождение утверждения о регионе обязательно. | Sol, Terra; частично остальные | high |
| Terra (тесты/CI) | Рекомендуемый DE/EWR egress; источник утверждения о регионе фиксировать отдельно от измерения. При сигналах geo/bot mode — `inconclusive` для затронутых выводов. | Sol, Terra | high |

## D12

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | 7 собственных адаптеров (detect/state/firstLayer/reject/accept/verify), high = ≥2 независимых признака; autoconsent — пин, без модификаций, только детект вне семёрки/классификатор/справочник, инжект после окна A; эвристика → только info «Banner nicht erkannt»; селекторы пишем сами, файлы правил не копируем | Opus, Fable, Sol, Terra | high |
| Opus (архитектура) | 7 своих TS-адаптеров, high = 2 признака + однозначный элемент; autoconsent только детект после фазы A, без optOut; эвристика только info | Opus, Fable, Sol | high |
| Sol (детект) | Семь собственных адаптеров; autoconsent — проверенный источник детекта/правил; неизвестный баннер — строго info. | Opus, Fable, Sol | high |
| Terra (тесты/CI) | Семь собственных адаптеров по порядку каталога; autoconsent — возможный закреплённый вспомогательный детектор после проверки лицензии; общая эвристика без автоматического CONSENT-04. | Все | high |

## D13

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Таблица Opus 4.4 с классами Fable: CMP high + блокирует + нет reject на первом уровне → critical; ×/Verbergen = accept → critical (OLG Köln 6 U 80/23); reject не actionable → warning; неблокирующий без reject → info (DSK Rn. 124–125; warning в профиле de-strict); ссылка вместо кнопки → warning; Pay-or-Okay → info; равноценность — только метрики в evidence | Opus, Fable | medium |
| Opus (архитектура) | Блокирующий без отказа/×=accept → critical; неблокирующий, ссылка, Pur-Abo → info; mobile учитывается; неизвестный → info+inconclusive | Opus | medium |
| Sol (детект) | Распознанный первый слой: принятие, доступный отказ, блокировка и фактическое действие; default warning. Неблокирующий, неоднозначный и Pur-Abo — info/ручная оценка. | Sol; близко Terra | high |
| Terra (тесты/CI) | Измерять первый уровень, доступность и работу отказа, блокировку и относительную доступность принятия; Pur-Abo и неоднозначные close-кнопки отправлять на ручную оценку. Начальный уровень — `warning` до экспертного утверждения. | Sol, Terra — ближе всего | medium |

## D14

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Свой Apache-2.0 каталог из экспорта аудитов заказчика + первички вендоров (чек-лист § 87a UrhG); third-party-web fallback; Open Cookie Database; AdGuard cname-trackers; EasyPrivacy только opt-in кэш; NC никогда; поля provider/parent/dpfEntity вместо company/hqCountry | Opus, Fable, Sol, Terra | high |
| Opus (архитектура) | Свой каталог + third-party-web + OCD + cname-trackers вендорятся; EasyPrivacy вне MVP | Opus, Fable, Sol | high |
| Sol (детект) | Свой каталог с provenance + third-party-web + Open Cookie Database; сигнатуры URL/payload/инициатора важнее общего домена. | Все по основе | high |
| Terra (тесты/CI) | Собственный версионированный каталог с provenance; разрешённые источники подключать только после проверки лицензии **данных и конкретного snapshot**. Не считать неизвестный домен трекером автоматически. | Все | high |

## D15

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Datenschutzerklärung извлекать в фазе B: видимый + скрытый текст, фреймы, ≤3 связанных документа; PDF → inconclusive в MVP; уровни совпадения named > company > domain > category; отрицания/история; not-named → warning, category-only → info, неполное извлечение → inconclusive; PRIV-02 — каталог утверждений с предикатом фазы, цитата ≤200 знаков, critical только при противоречии в фазе утверждения | Opus, Fable, Sol | high |
| Opus (архитектура) | Документы — функция коллектора; HTML+скрытый текст+фреймы+2–3 связанные стр.; уровни совпадения, отрицания, claims; PDF → inconclusive в MVP | Opus, Fable | medium |
| Sol (детект) | Отдельный документный конвейер: HTML, доступные cross-origin frames, раскрываемые секции, связанные документы, текстовый PDF; структура, происхождение и полнота каждого фрагмента. | Ближе Sol; частично Terra | high |
| Terra (тесты/CI) | Ограниченное извлечение HTML, iframe и связанных документов; PDF с текстовым слоем при наличии проверенного парсера. Сопоставление по алиасам и ограниченным шаблонам утверждений с учётом отрицаний; неполный текст → `inconclusive`. | Sol, Terra | medium |

## D16

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Атрибут, не проверка; источник — каталог (provider для EWR, parent, dpfEntity {listed, checkedAt}) + версионированный adequacy.json (EWR + страновые решения с датами, UK до 27.12.2031, DPF как список организаций); GeoIP (DB-IP) только --network-attribution; на уровень не влияет; без слов Empfänger/Übermittlung в текстах | Opus, Fable, Sol, Terra | high |
| Opus (архитектура) | Атрибут recipient из каталога, без отдельной проверки; GeoIP после MVP opt-in; DPF в legalContext, на уровень не влияет | Opus, Fable, Sol, Terra | high |
| Sol (детект) | Атрибуты наблюдения, отдельного TRANSFER-ID нет; GeoIP выключен по умолчанию. | Все | high |
| Terra (тесты/CI) | Атрибуты наблюдения о предполагаемом получателе и, отдельно, опциональный GeoIP фактического peer; без автоматического вывода о Drittlandtransfer. | Все | high |

## D17

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | WPVulnerability (CC0) + retire.js + OSV/GHSA с фильтром источников + CISA KEV; Wordfence только по ключу после чтения Terms; critical = версия exact ∧ (KEV ∨ pre-auth класс RCE/SQLi/upload/auth-bypass); CVSS AV:N/PR:N сам по себе недостаточен (Sol); range −1; unknown → info; офлайн → inconclusive | Opus, Sol, Fable | medium |
| Opus (архитектура) | WPVulnerability + retire.js + OSV/GHSA + KEV; critical = exact ∧ (KEV ∨ pre-auth-класс по advisory); Wordfence по ключу | Opus, Sol | medium |
| Sol (детект) | WPVulnerability, Retire.js, разрешённые GHSA/OSV и KEV; critical только после уверенного package/version/range matching и условий каталога. | Ближе Sol; частично Opus/Fable | high |
| Terra (тесты/CI) | На этапе 0 выбрать источники по лицензиям и покрытию; KEV использовать как сигнал к уже сопоставленному advisory, а не базу версий. `critical` — по правилу каталога при достоверной версии и применимости, иначе ограничение/`warning`. | Opus, Fable — частично | medium |

## D18

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Три класса O/T/E: T по умолчанию (DNS incl. DKIM ≤25 фиксированных селекторов, 2 TLS-handshake, http-цепочки, security.txt, readme.txt cap 20); E (FILE-01, ADMIN-01) — --exposure-probes opt-in, ≤15 путей, список утверждает заказчик после правовой оценки, 4 KiB неотключаемо, тело не хранится; non-features в ADR | Opus, Fable | high |
| Opus (архитектура) | FILE-01/ADMIN-01 opt-in вне релиза; TLS-04 по умолчанию; DKIM провайдерские + короткий список, info | Opus, Fable | medium |
| Sol (детект) | FILE/ADMIN — opt-in; TLS-04 — две документированные пробы при включении проверки; DKIM — заданные/документированные selectors, отрицательный поиск только info. | Ближе Sol, Terra | high |
| Terra (тесты/CI) | Обычные DNS/HTTP/TLS-проверки с бюджетом — базовый профиль; FILE-01/ADMIN-01 — будущий opt-in для разрешённого scope; TLS-04 и DKIM — только при включении соответствующих P1 и с отдельными лимитами. | Sol, Terra — частично | high |

## D19

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | T3 → максимум warning: HSTS/anti-framing/небезопасный Referrer-Policy → warning, CSP/nosniff/Permissions-Policy → info; MAIL-01 нет/p=none → warning; MAIL-02 по матрице с DMARC (BSI TR-03182); MAIL-03 info (warning только документированные селекторы провайдера); TLS-04 warning; TLS-02 invalid → critical; TLS-01 градация Opus (critical только http-only или форма на http-странице) | Fable, Opus | medium |
| Opus (архитектура) | HSTS/framing/небезопасная Referrer-Policy → warning; CSP/nosniff/PP → info; TLS-02 invalid critical; TLS-01 critical только при битом https или форме; MAIL warning; MAIL-03/DNS/SEC info | Fable, Sol, Opus | medium |
| Sol (детект) | Hardening — warning/info; DNS/SEC absence — info; подтверждённо невалидный TLS — critical; чувствительный HTTP-контекст — условный critical. | Ближе Sol | medium |
| Terra (тесты/CI) | HDR, MAIL, DNS, SEC — обычно `info`/`warning`; подтверждённые TLS-ошибки и экспозиции оценивать отдельно. Матрицу утвердить как ruleset, не выводить механически из CRM-тиров. | Opus, Sol, Terra — частично | medium |

## D20

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Значения cookies/Storage/TC-String не хранятся вообще — имя/домен/путь/флаги/длина без хешей (при нужде корреляции HMAC с одноразовым ключом); query по allowlist; POST/HAR/тела FILE-01 — нет; скриншот только области баннера; дополнительно маскировать mailto в DMARC/security.txt, ADMIN-01 только счётчик, --contact не в отчёте; retention ≤14 дней | Opus, Sol, Terra | high |
| Opus (архитектура) | Значения cookies/storage не хранятся и не хэшируются; query allowlist; скриншот баннера в HTML; HAR выкл.; DSE только локально | Opus, Sol, Terra | medium |
| Sol (детект) | Значения не экспортировать; нужную корреляцию выполнять временным HMAC внутри запуска; screenshots opt-in; HAR/trace/NetLog off. | Sol, Terra | high |
| Terra (тесты/CI) | Значения cookies и тела ответов не сохранять; query, заголовки и DOM минимизировать до записи. Скриншоты, HAR и сырые документы — выключены по умолчанию, отдельный режим с ограничением доступа и срока хранения. | Sol, Terra — ближе всего | high |

## D21

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | zod → JSON Schema 2020-12, независимый semver; fingerprint v1 = sha256(JCS{v, checkId, scope, variantGroup, subject}); suppressions с reason+expires; baseline с учётом роста уровня (Opus); crmCode string/null только в JSON (не рендерится людям); legalContext, ruleset.rechtsstand, diagnostics[] | Opus, Fable | high |
| Opus (архитектура) | zod4→JSON Schema 2020-12+Ajv; независимый semver; открытый evidence.type; top-level evidence[]+evidenceIds; fingerprint JCS без хоста и страниц; version у config/suppressions/baseline | Opus, Sol | medium |
| Sol (детект) | Zod → JSON Schema 2020-12, Ajv; независимые версии schema/ruleset/fingerprint; baseline хранит допустимый уровень и срок. | Opus, Fable — технология; Sol — семантика | high |
| Terra (тесты/CI) | JSON Schema с машинной валидацией, независимая версия, явные версии ruleset/dataset/fingerprint. Baseline и suppression с причиной, сроком и обнаружением роста severity. | Все — частично | high |

## D22

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Статические тексты по checkId.variant в ICU MF1 de/en; L0-стоп-слова для de и en; draft: true блокирует релиз (Terra); дисклеймер с условными абзацами (Opus) без флага отключения; legalNote — общий текст со статусом источника (authority-consensus / court-first-instance / court-appellate / contested / technical) и reviewedAt; lint «нет пользовательских строк вне data/» | Opus, Fable, Terra | high |
| Opus (архитектура) | ICU MF1 YAML de/en по checkId.variant; стоп-слова L0; условный дисклеймер; draft-тексты блокируют релиз | Opus, Fable, Terra | high |
| Sol (детект) | Статические шаблоны `checkId.variant`, DE default и EN; экспертное ревью, фактические формулировки и дисклеймер. | Все | high |
| Terra (тесты/CI) | Статические DE-шаблоны по ID/варианту, дисклеймер и запрещённые юридические вердикты; EN — при наличии проверенного перевода. | Все | high |

## D23

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | L0–L4; L1 пары (+inconclusive) на каждый ID, записанные из L2; L2 офлайн через egress-прокси/тест-CA/dns2 в --network none; CMP-симуляторы своим кодом + CMP-лаборатория на лицензированных инсталляциях; приватная канарейка с письменным согласием; критерии: 0 ложных critical CONSENT-03/04 и precision critical ≥0,9 с оговоркой о статистической силе 10 сайтов | Opus, Fable, Sol, Terra | high |
| Opus (архитектура) | L0–L4; L1 = requires-срез, утверждения по variant, ruleset отдельной таблицей; L2 пары в --network none; симуляторы + лаборатория; приватная канарейка с allowedInconclusive | Opus, Fable, Sol | high |
| Sol (детект) | Unit на снимках, настоящая локальная сеть/Chromium, CLI/CI smoke, симуляторы и реальные установки семи CMP, независимая канарейка. | Все; особенно Sol/Fable | high |
| Terra (тесты/CI) | Пара violation/clean для каждого реализованного ID, плюс unknown/error; локальные DNS/TLS/HTTP/CMP-интеграции, тесты поставки и отдельная размеченная канарейка. | Все; Sol особенно подробно | high |

## D24

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Composite Action + docker run по digest с hardening; GitLab include:remote + integrity как контракт ТЗ, CI/CD-component вторым шагом; свой node:24-slim + Chrome for Testing, non-root; npm с явным install; Docker-action отвергнута | Fable, Opus, Sol | high |
| Opus (архитектура) | Composite + docker run по digest; GitLab include-шаблон в релизе, компонент позже; node:24-bookworm-slim + CfT, amd64, arm64 после smoke; npm install-команда; образ→digest→тег Action | Fable, Sol, Opus | medium |
| Sol (детект) | Composite Action над digest-pinned image; GitLab include; Debian slim + Node 24 + полный Chromium; npm с явной подготовкой браузера. | Opus, Fable, Sol | high |
| Terra (тесты/CI) | Composite GitHub Action с закреплённым OCI digest **при доказанном сетевом профиле**; обычный GitLab include; Docker и npm с явной установкой совместимого браузера. Linux amd64 — первая проверяемая платформа. | Sol — ближе всего | medium |

## D25

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Egress-прокси как SSRF-граница для браузера и undici; sandbox --sandbox auto с SCAN-SANDBOX-OFF (diagnostic) и --require-sandbox для аудитов; HTML без JS, CSP default-src 'none', URL текстом, L2-тест «ноль сети»; job без секретов/OIDC/docker.sock | Fable, Opus | medium |
| Opus (архитектура) | Sandbox+seccomp, --sandbox auto/require/off с SCAN-SANDBOX-OFF; egress-прокси как SSRF-граница; HTML без JS с CSP | Opus, Fable | high |
| Sol (детект) | Обязательный sandbox в официальном CI-профиле, принудительный egress без обхода, одноразовый runner без secrets; статичный экранированный HTML с CSP. | Sol, Terra | high |
| Terra (тесты/CI) | Одноразовый runner без секретов, sandbox Chromium fail-closed, принудительная сетевая граница на соединениях, non-root и ограничения ресурсов. HTML — контекстное экранирование, безопасные URL и строгая CSP; PDF — без сети. | Sol, Terra | high |

## D26

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Структура Opus (спайки С1–С6, release manifest, два трека) с правовыми воротами: подпись ruleset/crmCode-мэппинга в конце этапа 0, Impressum/Datenschutzerklärung для домена проекта и демо-сайта на этапе 2, тексты + стоп-слова + лицензионный аудит на выходе из этапа 3/4; оценка 100–135 PD | Opus, Terra | medium |
| Opus (архитектура) | ≈79–94 чд без буфера (91–108 с 15 %) для P0+CONSENT-05+HTML/PDF+M; критпуть К2→контракты→прокси+браузер A→3 адаптера→B/CONSENT-04/05→калибровка | Opus, Fable | medium |
| Sol (детект) | Gates этапов — по Sol; ранние PoC capture/CMP/egress и PRIV; бюджет планировать консервативнее Sol, пересчитать после этапа 0. | Комбинация Sol, Opus, Terra | medium |
| Terra (тесты/CI) | На этапе 0 — spike UA/CMP, egress/sandbox, фикстур и лицензий; этапы ТЗ сохранить. Планировать ориентир **80–140 человеко-дней**, пересчитать после spike; критический путь — изоляция, CMP, PRIV, интеграционные фикстуры и приёмка. | Sol, Terra — комбинированно | low |

## D27

| Критик | Выбор | Совпадает с | Уверенность |
|---|---|---|---|
| Fable (право) | Оставить dsgvo-check рабочим, но до этапа 1 провести clearance (DPMA/EUIPO, домены, npm, GitHub) 2–3 кандидатов и CI-бот-тест токена; переименовать, если clearance или бот-тест провалены либо имя входит в браузерный UA | Opus, Fable | low |
| Opus (архитектура) | Решить до этапа 1 вместе с UA; если токен = имя, оно должно проходить бот-тест (dsgvo-check не проходит check\b); иначе можно оставить после проверки знаков | Opus | low |
| Sol (детект) | Пока оставить рабочее `dsgvo-check`; namespace и товарные знаки проверить отдельно. | Fable; рабочее имя используют Sol, Terra | medium |
| Terra (тесты/CI) | Пока `dsgvo-check`; перед публикацией проверить npm, домены и товарные знаки. Не менять имя исключительно ради UA-эвристик. | Sol, Terra — частично | medium |
