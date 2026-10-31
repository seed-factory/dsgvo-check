# dsgvo-check — итог консенсус-панели

Дата: 2026-10-30 · Раунд 4, синтез; поправки раунда 4б после верификации · Модератор: Claude Opus 5.5

Этот файл — единственный источник решений для брифа, архитектуры, спецификации проверок и плана. Если решение расходится с предложениями или ресёрчем, действует этот файл. Если оно расходится с ТЗ, действует ТЗ, пока заказчик не ответит на вопрос из раздела 8.

Порядок источников истины (предложен Terra, принят всеми): явное решение заказчика → ТЗ → каталог → этот файл → идея → ресёрч и предложения раундов 1–3.

Пометка ⚠ означает, что факт не подтверждён первоисточником. Все такие факты собраны в разделе 7. В решениях они используются только как гипотеза под спайк или как вопрос заказчику.

## Поправки после верификации (раунд 4б)

Итог проверили два независимых верификатора — Claude Fable 5.1 и Codex GPT-6.1-Sol ([`round-4/`](round-4/)). Все их находки сведены в [`round-4/errata.md`](round-4/errata.md): 61 строка, принято 57 (из них 7 частично), отклонено 2, вынесено заказчику 2. Правки внесены прямо в этот файл. Главное:

- **Уровни согласия.** D03 и D10 — спор 2:1:1, а не 2:2; D08 — большинство 3:1 за общую подвыборку B/C. D06, D14, D15, D18, D26, D27 и неблокирующий вариант D13 исправлены по матрице раунда 3. Где модератор решил вопреки части критиков, это сказано прямо (D06, D11, D26, D27).
- **CMP.** Адаптер — `extract / act / verify`. Что считать отказом и куда кликать, решает только чистая `classifyFirstLayer` в core (D12). `blocking-no-reject` требует, чтобы на первом уровне можно было дать согласие; добавлен вариант `no-choice-at-first-layer`; `banner-not-recognized` нельзя поднять override (D13, 5.4, 5.5).
- **Изоляция.** Поведение `--sandbox require` описано для трёх входов ТЗ (`npx`, `docker run`, CI); `require` ⇒ `chromiumSandbox: true`; конфликт с «одной командой без конфига» вынесен в вопрос 8 (D25). Единый `EgressPolicy` для прокси, undici, `node:tls` и `net`; `--proxy` в 1.0 — только HTTP CONNECT; DNS идёт к резолверу напрямую и записывается в Messumgebung; граница SSRF за upstream-прокси названа честно (5.7).
- **Детект и доказательства.** TLS-02 — порог относительно срока действия (6-дневные сертификаты) и `checkIP` для IP-целей. UA — из `navigator.userAgent` или шаблона, а не из `browser.version()`. Первый экран снимается без автопрокрутки: снимок viewport до действий, затем обрезка. Документы не зависят от успешного отказа. Default-denied — не отказ. Вместо «есть ID» — устойчивый идентификатор. Запросы — `delivery / result / provenance` на монотонной шкале времени (D10, D15, D19, D20, раздел 4, 5.3).
- **Отчёты и поставка.** Полная CSP HTML-отчёта; `THIRD_PARTY_NOTICES` (MPL-2.0, CC BY 4.0 для GHSA); `subject` fingerprint для всех ID; маппинг JUnit; окончательный код после репортёров; таблица гейта без противоречий (5.2, 5.4, 5.8).
- **Объём.** Прототип отделён от релиза, его манифест — [`docs/prototype/BRIEF.md`](../prototype/BRIEF.md) (раздел 2а). pnpm 12.16.1 вместо 11. `baseline migrate` — бэклог. VULN-02 `not_applicable` — только без всех поддерживаемых компонентов.
- **Факты.** § 19 Abs. 4 **S. 3** TDDDG; RFC 9989 — май 2026; VG Hannover — 19.03.2025; PM 38/26 доступен; PRIV-01 — третья по частоте P0 (HDR-01 — 64, MAIL-01 — 54).

---

## 1. Как шёл консенсус

| Раунд | Что делали | Модели и роли | Файлы |
|---|---|---|---|
| 1 · Ресёрч и критика | 7 исследований: право, регуляторика 2026, аналоги, данные и лицензии, браузер, HTTP/DNS/TLS/почта, инженерия и CI. Затем сводка, критик полноты, анализ ТЗ, red-team | Claude Opus 5.5 и Claude Fable 5.1 — ресёрч и сводка; Claude Fable 5.1 — критик полноты; Codex GPT-6.1-Sol — анализ ТЗ; Codex GPT-6.1-Terra — red-team QA | [`docs/01-research/`](../01-research/), [`round-1/`](round-1/) |
| 2 · Предложения | Четыре независимых архитектурных предложения по одному промпту ([`prompts/round-2_proposal.md`](prompts/round-2_proposal.md)) | Opus 5.5, Fable 5.1, GPT-6.1-Sol, GPT-6.1-Terra | [`round-2/`](round-2/) |
| 3 · Перекрёстная критика | Каждый разбирает все четыре предложения и голосует по точкам D01–D27 ([`prompts/round-3_cross-critique.md`](prompts/round-3_cross-critique.md)) | Fable — правовая линза; Opus — архитектура; Sol — точность браузерного детекта; Terra — тесты, CI, безопасность | [`round-3/`](round-3/) |
| 4 · Синтез | Сведение голосов, разбор споров, проверка отдельных фактов | Модератор Claude Opus 5.5 | этот файл |
| 4б · Верификация | Две независимые проверки итога: передача голосов, ТЗ, контракты, факты. Сведение находок и правка этого файла | Claude Fable 5.1 и Codex GPT-6.1-Sol — верификаторы; модератор Claude Opus 5.5 | [`round-4/`](round-4/), [`round-4/errata.md`](round-4/errata.md) |

**Правила синтеза.** Единогласно — все 4 критика за один вариант. Большинство — 3 из 4. Спор — большинства нет (2:2, 2:1:1 или все разные). Если меньшинство нашло ошибку факта, права или ТЗ, она весит больше голосов. При споре действует приоритет: ТЗ и право ЕС/Германии → корректность детекта (без ложных `critical`) → простота (YAGNI) → сроки.

**Проверено модератором.** Hosted Linux runners на GitLab.com (теги `saas-linux-*`) работают в privileged-режиме, каждый job получает отдельную VM ([docs.gitlab.com](https://docs.gitlab.com/ci/runners/hosted_runners/linux/)). Этот факт использован в D25. В раунде 4б модератор дополнительно проверил dist-tags pnpm, RFC 9989, VG Hannover 10 A 5385/22, PM 38/26 и короткоживущие сертификаты Let's Encrypt ([errata, раздел 4](round-4/errata.md)).

**Сокращения в ссылках.**

| Сокр. | Файл |
|---|---|
| Opus-П | [round-2/claude-opus-5.5_proposal.md](round-2/claude-opus-5.5_proposal.md) |
| Fable-П | [round-2/claude-fable-5.1_proposal.md](round-2/claude-fable-5.1_proposal.md) |
| Sol-П | [round-2/codex-gpt-6.1-sol_proposal.md](round-2/codex-gpt-6.1-sol_proposal.md) |
| Terra-П | [round-2/codex-gpt-6.1-terra_proposal.md](round-2/codex-gpt-6.1-terra_proposal.md) |
| Fable-К | [round-3/claude-fable-5.1_critique.md](round-3/claude-fable-5.1_critique.md) — правовая линза |
| Opus-К | [round-3/claude-opus-5.5_critique.md](round-3/claude-opus-5.5_critique.md) — архитектура |
| Sol-К | [round-3/codex-gpt-6.1-sol_critique.md](round-3/codex-gpt-6.1-sol_critique.md) — браузерный детект |
| Terra-К | [round-3/codex-gpt-6.1-terra_critique.md](round-3/codex-gpt-6.1-terra_critique.md) — тесты, CI, безопасность |
| R1-полнота | [round-1/claude-fable_completeness-critic.md](round-1/claude-fable_completeness-critic.md) |
| R1-ТЗ | [round-1/codex-gpt-6.1-sol_tz-analysis.md](round-1/codex-gpt-6.1-sol_tz-analysis.md) |
| R1-red-team | [round-1/codex-gpt-6.1-terra_redteam-qa.md](round-1/codex-gpt-6.1-terra_redteam-qa.md) |
| R1-сводка | [round-1/claude-research-digest.md](round-1/claude-research-digest.md) |
| V-Fable | [round-4/claude-fable-5.1_verification.md](round-4/claude-fable-5.1_verification.md) — верификация итога |
| V-Sol | [round-4/codex-gpt-6.1-sol_verification.md](round-4/codex-gpt-6.1-sol_verification.md) — верификация итога |
| Errata | [round-4/errata.md](round-4/errata.md) — сведение верификаций, раунд 4б |

---

## 2. Итоговые решения

| ID | Точка | Решение | Согласие | Кто против и почему | Обоснование |
|---|---|---|---|---|---|
| D01 | Объём релиза | Release manifest 1.0: все 15 P0 и CONSENT-05 (перенос из P1, нужно подтверждение заказчика). Остальные P1 идут на этапе 3б в порядке каталога; при нехватке бюджета первыми за релиз уходят VULN-01/02. P2 — после релиза; FILE-01 и ADMIN-01 только как opt-in класса E. Каркас этапа 1 («первая проверка каждого модуля») выполнением P0 не считается. Прототип этапа 1 — отдельный срез по [`docs/prototype/BRIEF.md`](../prototype/BRIEF.md), не релиз и не его ворота (раздел 2а) | единогласно | Никто. Sol-П держал CONSENT-05 в P1, но Sol-К за перенос. Terra-К: перенос — расширение ТЗ, нужно согласие (вопрос 4) | Opus-К, Fable-К, Sol-К, Terra-К: D01; R1-ТЗ §1 |
| D02 | Форматы отчёта | В релизе: JSON (контракт), консоль, HTML (один файл, без JS), JUnit, GitHub Job Summary. PDF — команда `dsgvo-check report report.json --format pdf`, печать того же HTML в офлайн-контексте Chromium; это последняя задача этапа 3а и первая уходит при нехватке времени. Порядок вылета при нехватке бюджета: PDF → JUnit → Job Summary → HTML; JSON и консоль — контракт ТЗ (вопрос 4). Отображение в JUnit — в 5.2. SARIF и GitLab Code Quality — после релиза: у их потребителей нет естественного места для веб-находки, хотя сам формат SARIF такое допускает | большинство | Terra-К: JUnit только после фиксации семантики кодов (зафиксирована в D03; маппинг JUnit задан в 5.2 в раунде 4б) | Opus-К D02; Fable-К D02; Sol-К D02, ошибка Opus №8; Terra-К D02 |
| D03 | Коды 0/1/2 | `gate()` — чистая функция с приоритетом `2 (fatal)` > `1 (порог)` > `2 (ошибка релевантной проверки или --strict)` > `0`. Fatal: скан не состоялся (цель недоступна, WAF, нет браузера, sandbox не поднялся), внутренний сбой, отчёт не записан. Релевантна проверка, у которой `maxSeverity` — статический максимум `variants` после ruleset и overrides, без кэпа уверенности — не ниже `--fail-on`. Нераспознанный баннер, бот- и гео-режим на код не влияют. Флаг `--strict` поднимает их до `2`. В JSON пишутся все `exitReasons[]` | спор (2:1:1); решение модератора — вариант Opus-К | Sol-К, Terra-К: любая ошибка включённой проверки → `2`, и `2` > `1`. Fable-К: ошибка проверки без `--strict` не даёт `2`. Opus-К — компромисс → §3 | Opus-К §4.6; Fable-К D03; Sol-К D03; Terra-К D03; R1-полнота «Семантика exit-кода 2» |
| D04 | Модель результата | Три независимые оси. `status` проверки: `completed / partial / inconclusive / not_applicable / skipped / error`, без `pass/fail`. `severity`: `critical / warning / info`. `confidence`: `high / medium / low`. Confidence ограничивает уровень в assess (`medium` → не выше `warning`, `low` → не выше `info`); скрытого фильтра в гейте нет. `diagnostics[]` (SCAN-*) — отдельная сущность без severity: не гейтит и не идёт в CRM. Одно наблюдение даёт одну гейтящую находку, остальные связываются через `evidenceIds` и `related[]` | единогласно | Никто. Fable-П (SCAN-* как `warning`, `--min-confidence`) отозвано в Fable-К | Все четыре -К: D04; Opus-К ошибка Fable №1 |
| D05 | Архитектура | Цепочка: коллекторы → снимок сырых отредактированных фактов, включая решения сбора в разделе `plan` (выбранные страницы, нажатая кнопка, запрошенные пробы) → `derive` (чистая классификация по каталогу, пересчитывается при `--from-snapshot`) → проверки над срезом `requires` → assess по ruleset → gate → репортеры. Безопасные признаки (`identifier {kind, matchesStoredIdentifier}`, `eventType`, `consentSignal`, `consentState`) извлекаются в коллекторе до удаления значений и сохраняются в снимке и evidence вместе с `parserVersion` и `observationSource` (5.3); пересчёт по снимку обещан только для сохранённых признаков. Новая проверка = папка + строка в явном реестре слоя checks + тест полноты (тексты `de`, а `en` — после объявления его релизным; ruleset, `crmCode` или явный `null`, фикстуры на каждый `variant`). Дополнительные запросы проверка описывает только декларативным `ProbeSpec`. Адаптер CMP разрезан: `extract / act / verify` в коллекторе (D12), решение `classifyFirstLayer(facts, lexicon)` — чистая функция в core | большинство | Terra-К: build-time manifest и автообнаружение. Это лишний шаг сборки; тест полноты даёт ту же гарантию | Opus-К §4.1–4.4; Sol-К D05, §4.10; Fable-К D05 |
| D06 | Репозиторий | Один публикуемый npm-пакет, один `package.json`, без pnpm-workspace; `test/fixture-server` и `test/utils` — обычные каталоги. Отдельные репозитории: `example` (красная и зелёная сборка, все коды 0/1/2) и приватная канарейка. GitLab Catalog-компонент — после релиза | один пакет — единогласно; без workspace — 2:1:1, решение модератора по YAGNI | Fable-К: workspace с приватными тестовыми пакетами — без публикации выгоды нет. Sol-К: workspace допустим (нейтрально). Против workspace — Opus-К, Terra-К | Opus-К D06; Sol-К D06; Terra-К D06 |
| D07 | Тулчейн | Node ≥ 24 (CI на 24 и 26). TypeScript 7.0.x, `tsc` для emit (TS 6.0 в запасе). pnpm 12.16.1 с lockfile (пин через `packageManager`; фолбэк 11.28.9, если не пройдёт smoke), Vitest 5, Biome 2.6 и oxlint-tsgolint (no-floating-promises). zod 4 → JSON Schema 2020-12 и Ajv. `playwright-core` с точным пином (1.64.x, Chrome for Testing 156), undici 8. Без бандлера, с лицензионным allowlist зависимостей в CI. Сочетание версий подтверждается install- и build-smoke на этапе 0 | единогласно | Никто. Sol-К и Terra-К: точные мажоры подтвердить smoke (принято) | Opus-К D07; Fable-К D07; Sol-К D07; Terra-К D07; R1-полнота (Node, undici) |
| D08 | Фазы согласия | Пять фаз в четырёх свежих `launchPersistentContext(tmpdir)`: A (A′ — в конце того же профиля), B, C, M. **A** — 6 страниц без взаимодействия. **A′** — старт и Kontakt: `mouse.move`, `wheel`, `Shift` без кликов; находки с `trigger: interaction-without-consent` того же уровня, что в A. **B** — старт: ≥ 4 с наблюдения до клика (репликация A), снимок первого экрана, «Ablehnen», верификация, reload, затем 2 контрольные страницы. **C** — «Alle akzeptieren» на старте и те же 2 страницы. **M** — 390×844, `isMobile`, только старт: первый уровень и блокировка, без кликов. Контрольные страницы B/C выбираются до фазы B по сетевым и DOM-сигналам A (Zwei-Klick-плейсхолдеры, iframes, шаблоны). «Первый визит» утверждается только для стартовой. Фаза C раскрывает IP сканирующей машины третьим лицам — это пишется в Messumgebung и Nutzungshinweise | единогласно по фазам; большинство 3:1 по общей контрольной подвыборке B/C | Sol-К: одинаковые контентные URL в A/B/C, иначе «до/после» несопоставимы → §3 | Opus-К D08, ошибка Terra №2; Sol-К §4.1–4.2; Terra-К D08, ошибка Sol №1 |
| D09 | Обход сайта | 6 уникальных страниц: старт после редиректов, Impressum, Datenschutzerklärung, Kontakt/Anfahrt и до 2 страниц по ключевым словам навигации, DOM-сигналам или sitemap (разные шаблоны). Выбор детерминирован (стабильная сортировка, причины записаны); ключ `pages:` в конфиге закрепляет выборку. Scope — финальный хост плюс пара www/apex. `robots.txt` соблюдается для дополнительных страниц; старт и правовые страницы проверяются всегда. Навигации идут по одной с паузой ≥ 1,5 с; HTTP-пробы ≤ 2 запр./с на хост. Подзагрузки браузера не троттлятся; общий счётчик браузерных запросов с потолком 2 000, усечение пишется в coverage. Тишина: окно 2 с, inflight ≤ 1, MIN_DWELL/HARD_CAP по фазам (A 6/20 с, A′ 3/10, B и C 4/12, M 3/8). `--timeout 8m` плюс 30 с резерва на запись отчётов. Coverage показывает «geplant / beobachtet / auswertbar». Перегрузка (раунд 4б): 429/503 на навигации или ≥ 3 таких ответа целевого хоста за фазу → пауза по `Retry-After` (≤ 30 с), один повтор; затем новые навигации к хосту не начинаются, `SCAN-THROTTLED`, coverage неполная. Политика общая для браузера и проб | единогласно; изменено меньшинством для LEGAL-01 | Никто. Fable-К добавил переход через «Kontakt» до `critical` LEGAL-01 (BGH I ZR 228/03) → §3 | Opus-К D09, §4.5; Fable-К D09, §4.11; Sol-К D09, §4.13; Terra-К D09 |
| D10 | UA и анти-бот | По умолчанию — буквально по ТЗ. HTTP-пробы: `dsgvo-check/<ver> (+https://github.com/<org>/<repo>; passive DSGVO/security check)`. Браузер: `navigator.userAgent` запущенного Chrome for Testing с заменой `HeadlessChrome/` на `Chrome/` (или шаблон Chrome с major из `browser.version()` — сам метод возвращает только версию) плюс тот же токен со ссылкой на репозиторий; в фазе M — мобильный шаблон с согласованными `userAgentMetadata`. TLS-handshake HTTP-заголовков не несёт, UA у него нет. По регуляркам из исходников буквальный UA ловят только `isbot` и RCB; Cookiebot, Complianz и Borlabs 3.5 — нет, пока в UA нет `bot`, `crawler`, `spider`, `robot` (browser-automation §3.2). Детектор бот-режима обязателен: прямой сигнал (Cookiebot `isSpider()`, ветка RCB `accept-all-for-bots` и т. п.) → затронутые проверки `inconclusive` и `SCAN-BOTMODE`. Consent-cookie без клика сама по себе бот-режим не доказывает. Без кастомных заголовков, без `DNT` и `Sec-GPC`; `From:` только по `--contact`. Отступление (ссылка только в HTTP-пробах) возможно лишь после ответа заказчика по данным спайка С1 | спор (2:1:1) | Fable-К: в браузере токен без URL и заголовок `X-…`, иначе на RCB- и isbot-сайтах `inconclusive`. Opus-К: Chrome UA и токен со ссылкой, адрес ссылки (репозиторий или страница проекта) выбирает заказчик по С1 — с решением совместимо → §3 | Sol-К D10; Terra-К D10, ошибка Opus №5; Opus-К D10, ошибка Fable №5; Fable-К D10 |
| D11 | Гео | Гео-сигналы CMP читаются всегда: Cookiebot `isOutOfRegion` и `CookieConsent=-1`, `__ucCmp.isConsentRequired()`, `complianz.region`, гео-диалог Borlabs, `__tcfapi('ping').gdprApplies`. Сигнал → затронутые проверки `inconclusive` и `SCAN-GEO`. Наличие или отсутствие CMP-скрипта и список `region` в Consent Mode гео-сигналом не считаются. `scan.environment.egress = {mode: direct/proxy, region: unknown/asserted, source}`. `--proxy` (в 1.0 только `http://` — HTTP CONNECT для браузера, undici и TLS-коллекторов; SOCKS5 — бэклог; DNS-коллектор идёт к резолверу напрямую, это пишется в `scan.environment.egress.collectors`, 5.7) и `--assume-region eea/de` записываются как «laut Nutzerangabe», без претензии на проверку; внешний «what is my IP» не вызывается. Термин — EWR, не «EU». CONSENT-03 даёт `critical` только при `region: asserted` (EWR); текст находки содержит «Region laut Nutzerangabe» | единогласно по механизму; изменено меньшинством; `critical` по заявлению пользователя — решение модератора | Sol-К: отсутствие CMP-скрипта, `region` в Consent Mode и сам прокси регион не доказывают (принято). Sol-К и Terra-К: заявления пользователя для `critical` недостаточно — не принято, вопрос 12 → §3 | Sol-К D11, ошибки Opus №1, Fable №6; Terra-К ошибка Fable №3; Fable-К §4.2 (EWR) |
| D12 | CMP | Семь собственных адаптеров — TS-модули в порядке каталога: Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. Контракт адаптера — три операции без решений: `extract(page, viewport) → CmpFacts` (распознавание; кнопки с ролью, accessible name, геометрией, actionability, контрастом и `vendorRole` — ролью по разметке или конфигу CMP; блокировка; `ConsentState`; гео- и бот-сигналы); `act(page, target) → ClickFact` — клик по элементу, который выбрала core; `verify(page) → ConsentState` — сразу после действия и после reload. Что считать reject, accept, settings, блокирует ли баннер и куда кликать, решает только чистая `classifyFirstLayer(facts, lexicon)` в core; выбор пишется в `plan.click`. `reject` и `accept` — классы кнопок в её результате, а не методы адаптера. JS-API CMP только читаем; клик — `locator.click()` без `force`. CMP распознан с `high` = ≥ 2 независимых признака. Клик — только по однозначному элементу класса reject/accept; у функции кнопки отдельная уверенность. `@duckduckgo/autoconsent@17.1.0` — закреплённая немодифицированная зависимость только для «CMP X erkannt, nicht unterstützt» и второго мнения классификатора кнопок; инжектируется после окна фазы A. Его правила не копируются в наш каталог и не модифицируются; детект autoconsent работает read-only на собственных правилах; `optOut`, `optIn`, cosmetic и любые действия, меняющие страницу, выключены (точный конфиг 17.1.0 — ⚠, §7 №30). Селекторы адаптеров пишем сами. Условия MPL-2.0 выполняются через `THIRD_PARTY_NOTICES` (5.8). Эвристика выдаёт только `info` | единогласно | Никто | Все четыре -К: D12; Fable-К §4.12 (MPL, § 87a UrhG); Sol-К §4.4 |
| D13 | Критерий CONSENT-04 | Решение принимает чистая таблица в ruleset по `CmpFacts` первого экрана. Геометрия, hit-testing и видимость снимаются до любого действия, на desktop и в M. `blocking-no-reject` → `critical`: CMP распознан с `high`, блокировка измерена (overlay, scroll-lock, `inert`, `coveredRatio`), на первом уровне **есть** actionable-кнопка класса accept (`acceptAvailableAtFirstLayer`) и нет actionable-кнопки класса reject; «Einstellungen», «Später», «Verbergen», «×» отказом не считаются. Блокирующий первый уровень без accept и без reject (только настройки) → `no-choice-at-first-layer`, `info` с ручной оценкой. `close-means-accept` (× = принять по прочитанному конфигу CMP) → `critical`. `reject-not-actionable`, `reject-ineffective` и `consent-without-action` (состояние CMP `granted` без клика: `consent-state.origin: default/stored`, `ready`, нет `SCAN-BOTMODE`) → `warning`. `reject-as-link`, `nonblocking-no-reject`, `pur-abo` → `info` с ручной оценкой; `pur-abo` — флаг, он не отключает остальные варианты. Неизвестный баннер → `info` «Banner nicht erkannt» и статус `inconclusive`; варианты `banner-not-recognized` и `cmp-not-supported` неповышаемые (`locked`, 5.4). Метрики равноценности (площади, контраст, тип элемента) — только evidence | спор | Sol-К, Terra-К: `warning` по умолчанию до экспертного утверждения → §3 | Opus-К D13; Fable-К D13; Sol-К D13, §4.4; Terra-К D13 |
| D14 | Каталог сервисов | Свой каталог (Apache-2.0, около 100 записей из экспорта аудитов заказчика и документации вендоров, чек-лист § 87a UrhG в PR). Поля: `serviceId`, `category`, `policyRelevance`, `provider`, `parent`, `dpfEntity`, `domains`, `signatures` (URL, payload, initiator), `aliasesDe/En`, `categoryTerms`. Fallback — third-party-web 0.30.0 (MIT); cookies — Open Cookie Database (Apache-2.0); CNAME — AdGuard `cname-trackers` (MIT). Всё вендорится и фиксируется в `datasets.lock.json`. EasyPrivacy/EasyList, NC- и GPL-данные в MVP не используются. Неизвестный хост — `unknown`, не трекер | единогласно по своему каталогу и fallback-источникам; большинство 3:1 за исключение EasyPrivacy | Fable-К: EasyPrivacy как opt-in кэш. Отложено: лицензия CC BY-SA и лишний режим | Все четыре -К: D14; Opus-К §4.11 |
| D15 | PRIV-01/02 | Поиск и извлечение документов — функция коллектора (раздел снимка `documents`); LEGAL-01 и PRIV-* только читают его. Документы собираются независимо от исхода отказа. DSE извлекается в фазе A без кликов (rendered- и скрытый DOM-текст по разделам, same- и cross-origin фреймы, ≤ 3 связанные страницы того же префикса) и дополняется в фазе B после подтверждённого отказа, когда баннер закрыт (раскрытие аккордеонов и табов кликом). Если B невозможна, раскрываемые части помечаются в manifest нераскрытыми, limitation `banner-open`; при полном manifest PRIV-01 работает (`completed` или `partial`), а не `inconclusive`. Согласие ради документа не нажимается. У каждого фрагмента есть происхождение (`visible / expandable / frame / linked / hidden-irrelevant`), у документа — manifest полноты. Нормализация: NFKC, регистр, ä/ae, дефисы, soft-hyphen. Уровни совпадения: `named > company > domain > category > none`. Отрицание привязано к субъекту и предикату; неподдерживаемая конструкция считается неоднозначной. PDF-политика в 1.0 → `inconclusive` «als PDF – nicht ausgewertet». PRIV-02 — каталог утверждений (субъект → предикат → отрицание → условие → фаза) | единогласно по конвейеру, спор по PDF | Sol-К: текстовый PDF через pdfjs-dist уже в MVP. Terra-К: PDF с текстовым слоем при наличии проверенного парсера → §3 | Opus-К D15, ошибка Opus №3; Fable-К D15; Sol-К D15, §4.11, ошибка Fable №9; Terra-К D15 |
| D16 | Передача за пределы ЕС | Отдельной проверки нет. Находка о стороннем сервисе несёт атрибут из каталога: `provider {name, country}` (Vertragspartner для EWR-Kunden laut Katalog), `parent`, `dpfEntity {name, listed, checkedAt, source}`, `processingLocation: "nicht feststellbar"`. Рядом лежит статический версионированный `data/legal/adequacy.json`: EWR, страновые решения с датами и сроками (UK до 27.12.2031), отдельно список организаций DPF. Статус DPF (C-703/25 P pending) — только в `legalContext`. На уровень атрибут не влияет; стоп-лист задан фразами о получателе и передаче (см. [Formulierungsleitfaden §2 №4](../legal/wording-guide.md#2-запрещённые-слова-и-конструкции-de-и-en)); исключения — только через allowlist с причиной. GeoIP (DB-IP Lite, CC BY) — после релиза, opt-in `--network-attribution` | единогласно; модель уточнена меньшинством | Никто не против. Fable-К исправил модель: Opus-К держал `recipient {company, hqCountry}` → §3 | Fable-К D16, §4.2; Sol-К D16; Terra-К D16 |
| D17 | VULN-01/02 | Источники: WPVulnerability (CC0) — ядро, плагины и темы WP; retire.js (Apache-2.0) — JS; OSV/GHSA с фильтром NC-источников — npm и Packagist; CISA KEV (CC0). Снапшоты с датой, sha256, лицензией и атрибуцией (`attribution`; для GHSA — CC BY 4.0) лежат в `datasets[]`; атрибуции выводятся в HTML-футере и в `THIRD_PARTY_NOTICES` (5.8). Wordfence и EUVD в MVP нет (условия не прочитаны). `critical` = версия `exact` ∧ попадание в affected range ∧ (CVE в KEV ∨ advisory описывает pre-auth RCE, SQLi, upload или auth-bypass). Одного CVSS `AV:N/PR:N` мало. `range` (в т. ч. только `Stable tag` или `?ver=`) — на ступень ниже; `unknown` → `info` без CVE; источник недоступен → `inconclusive` | единогласно | Никто. Terra-К выбирает источники на этапе 0 — совместимо | Opus-К D17, ошибка Terra №5; Fable-К D17; Sol-К D17, §4.14; Terra-К D17 |
| D18 | «Активные» запросы | Три класса действий, их проверяет валидатор `ProbeSpec`. **O** — браузерные навигации. **T** — по умолчанию, если соответствующая проверка включена: DNS ≤ 60 запросов, 2 TLS-handshake (TLS 1.0/1.1) для TLS-04, `http://`-цепочки host/www/apex, `/.well-known/security.txt`, Stage-2 `readme.txt`/`style.css` ≤ 20 только для обнаруженных плагинов. **E** — `--exposure-probes`: FILE-01 ≤ 15 путей по списку заказчика, ADMIN-01 3 GET; 4 KiB неотключаемо, тело не хранится; opt-in, вне релиза. DKIM: сначала `--dkim-selector`, затем документированные селекторы провайдера по MX, затем короткий generic-список, всего ≤ 25 TXT; результат «nicht gefunden» — только `info`. Совместим ли generic-список с запретом «перебора» в ТЗ — вопрос 16; до ответа действует этот порядок. README: флаг пользователя не создаёт разрешения владельца сайта | E — единогласно; TLS-04 — расхождение только в формулировке («при включении проверки»); DKIM — большинство 3:1 | Sol-К: DKIM только по заданным или документированным селекторам. Terra-К: отдельный лимит и без вывода об отсутствии DKIM — совместимо → §3 | Opus-К D18; Fable-К D18, §4.7; Sol-К D18; Terra-К D18 |
| D19 | Severity security | Уровни — данные `ruleset/de-2026.yaml`; lint проверяет согласованность: T3-коды не выше `warning`. HDR-01: нет HSTS, нет anti-framing (XFO или `frame-ancestors` в заголовке; meta не засчитывается), небезопасная Referrer-Policy → `warning`; нет CSP, nosniff, Permissions-Policy → `info`. MAIL-01: нет записи, `p=none`, невалидна → `warning`. MAIL-02 — по матрице с DMARC (BSI TR-03182). MAIL-03, DNS-01, SEC-01 → по умолчанию `info`; варианты `warning`: MAIL-03 — ключ < 1024 бит или заданный пользователем селектор отсутствует; DNS-01 — bogus при валидирующем резолвере. TLS-02: невалиден → `critical`; срок — относительно срока действия L = `notAfter − notBefore`: остаток < min(14 д, 25 % L) → `warning`, остаток < min(30 д, 50 % L) → `info`, при L ≤ 10 д находки о сроке нет (короткоживущие сертификаты, в т. ч. 6-дневные Let's Encrypt). TLS-01 → `critical` только при http-only, невалидном https или форме на http-странице. TLS-04 → `warning` | большинство | Terra-К: матрицу не выводить из CRM-тиров. Учтено: тиры только lint | Opus-К D19; Fable-К D19; Sol-К D19; Terra-К D19 |
| D20 | Минимизация evidence | В снимок, отчёт и логи не попадают значения cookies, Web Storage и TC-String — ни открыто, ни хешем. Пишутся имя, домен или `first-party`, путь, partitionKey, флаги, длина. Корреляция идентификаторов — в памяти скана (HMAC с одноразовым ключом), без экспорта. Query — allowlist параметров со значением `[redacted]`. Нет POST-тел, тел ответов, тел FILE-01; HAR, trace и NetLog выключены. `mailto:` в DMARC `rua/ruf` и в `security.txt` маскируется до домена; ADMIN-01 пишет только счётчики; `--contact` в отчёт не попадает. Скриншот первого экрана: `page.screenshot()` текущего viewport без прокрутки, до любого действия и вместе с геометрией, затем обрезка сохранённого изображения по `box` контейнера баннера; `locator.screenshot()` не используется — он прокручивает элемент. Снимок делается, только если контейнер однозначен и его `box` ≤ 50 % viewport (одно правило для адаптеров и эвристического кандидата); иначе снимка нет, limitation `screenshot-skipped`. По умолчанию включён (файл в артефактах и в HTML), `--no-screenshots` выключает; полностраничных скриншотов нет. Retention артефактов в шаблонах — 14 дней | единогласно по значениям и HAR, спор по скриншотам | Sol-К, Terra-К: скриншоты только opt-in → §3 | Opus-К D20; Fable-К D20, §4.3; Sol-К D20, §4.10; Terra-К D20 |
| D21 | JSON-схема | zod 4 → JSON Schema 2020-12, Ajv. `schemaVersion` — semver, независимый от CLI. Дискриминатор `scan.status: complete / partial / failed` с минимальной схемой `failed`. `evidence[]` на верхнем уровне, находки ссылаются через `evidenceIds`. `fingerprint = sha256(JCS{v:1, checkId, variantGroup, subject})` — без хоста цели, страниц и фазы. Подавления с обязательными `reason` и `expires`. Baseline хранит severity и возвращает в гейт рост уровня. У конфига, suppressions и baseline есть поле `version: 1`. `crmCode: string/null` — только в JSON | единогласно по технологии; состав fingerprint изменён меньшинством | Fable-К (eTLD+1 цели в ключе), Sol-К (маршрут для LEGAL/HDR), Terra-П (путь и фаза) → §3 | Opus-К D21, §4.5, §4.8; Fable-К D21, §4.1; Sol-К D21; Terra-К D21 |
| D22 | Тексты | Статические тексты `data/texts/{de,en}.yaml` в ICU MF1 по ключу `checkId.variant`, `de` по умолчанию. Формулировки: «beobachtet», «nicht gefunden in …», «Befund/Beobachtung», «Beleg». L0-lint стоп-слов для de **и** en. Lint «ни одной пользовательской строки вне `data/`». `legalNote` — общий текст по `checkId` со статусом источника (`authority-consensus / court-first-instance / court-appellate / contested / technical`), `reviewedAt` и `reviewBy`. Черновики помечены `draft: true` и штампом «Textentwurf»; неутверждённый `de` блокирует релиз. `en` выходит только вычитанным, иначе `--lang en` в 1.0 недоступен. В тесте полноты `en` обязателен только после того, как `en` объявлен релизным. Дисклеймер с условными абзацами, без флага отключения | единогласно | Никто. Terra-К: EN только при проверенном переводе (учтено) | Fable-К D22, §4.6; Opus-К D22; Sol-К D22; Terra-К D22 |
| D23 | Тестирование | **L0**: линты, реестр и полнота, стоп-слова, граф импортов (проверке недоступны Playwright и `node:*` I/O), лицензии. **L1**: чистые проверки на срезах снимка по `requires`; утверждения на уровне `variant`. На каждый ID — violation, clean, inconclusive/error и контрпример «соседняя ложная находка»; таблица ruleset тестируется отдельно. **L2**: настоящие Chromium, undici, `node:tls` и DNS в закрытой сети — fixture-server в своём netns на 80/443, тест-CA, dns2 с NXDOMAIN/NODATA/SERVFAIL/timeout, `--host-resolver-rules`, положительный контроль TLS-клиента. **L3**: упакованные CLI, образ и Action — коды 0/1/2, отчёты при `1` и `2`, sandbox на трёх входах ТЗ (`npx`, `docker run`, CI) и отсутствие `--no-sandbox`, SSRF по всем путям `EgressPolicy`. **L4**: CMP-лаборатория на лицензированных установках (сначала Borlabs, Cookiebot, Complianz) и приватная канарейка на 10 сайтах с письменным согласием владельцев (`mustFind`, `mustNotFind`, `allowedInconclusive`). Приёмка: 0 известных ложных `critical` на лаборатории и корпусе, все `mustFind` найдены, доля `inconclusive` по ID в отчёте. Precision 99 % на 10 сайтах не заявляем | единогласно | Никто | Все четыре -К: D23; Terra-К §4; Sol-К §4.14 (abstention rate) |
| D24 | Дистрибуция | **GitHub**: composite Action → `docker run` по digest (non-root, seccomp-профиль для sandbox, cap-drop, read-only, tmpfs, лимиты, без secrets и `docker.sock`, конфиг read-only, отдельный output); outputs `exit-code` и пути; Summary; upload через `if: always()`. Docker-action не используется. **GitLab**: версионированный `include:remote` + `integrity` (GitLab ≥ 17.9; для старых self-managed — копия шаблона по commit SHA), `artifacts: when: always`, `allow_failure: false`; Catalog-компонент — после релиза. **Образ**: `node:24-bookworm-slim` и полный Chrome for Testing (new headless), non-root, tini; amd64 сразу, arm64 после нативного smoke. **npm**: CLI плюс явная `dsgvo-check install`, без postinstall; Windows и macOS — best effort. Порядок релиза: образ → digest → коммит в `action.yml` → тег. npm-пакет и образ несут `THIRD_PARTY_NOTICES` (5.8). Цепочка supply chain (ADR-033) — предложение модератора к этапу 4, в раунде 3 не голосовалась | единогласно | Никто. Terra-П предлагал Docker-action, Terra-К перешёл на composite | Opus-К D24; Fable-К D24; Sol-К D24; Terra-К D24, §4 «Поставка» |
| D25 | Изоляция и HTML | Sandbox Chromium: `--sandbox require/off`, по умолчанию `require` (не поднялся → exit 2 с инструкцией); `require` ⇒ `chromiumSandbox: true` (у Playwright по умолчанию `false`) и запуск без `--no-sandbox`. `off` — только явно: `SCAN-SANDBOX-OFF`, предупреждение в консоли и Summary, `2` при `--strict`. Автоматического fallback нет. Поведение на трёх входах ТЗ — в §3 D25: `npx` распознаёт причину отказа (AppArmor, нет userns) и печатает пути; образ выдаёт свой seccomp-профиль и печатает точную строку `docker run`; Action и GitLab-шаблон — `require`. Конфликт с «одной командой без конфига» — вопрос 8. Загрузки выключены: `acceptDownloads: false`. SSRF: единый `EgressPolicy` (5.7) для in-process HTTP/CONNECT-прокси браузера, undici, `node:tls` и `net.Socket`. IP проверяется при фактическом соединении: все A/AAAA, IPv4-mapped, rebinding. Loopback, private, link-local и metadata запрещены, публичный IPv6 разрешён; QUIC и non-proxied UDP у WebRTC выключены. За upstream-прокси граница — проверенный адрес назначения (5.7). Принудительная сетевая граница из двух контейнеров — бэклог после релиза; в README честная модель угроз. HTML без JS с полной CSP (5.8), контекстное экранирование, URL текстом; консоль чистится от ANSI, bidi и workflow-команд; PDF — офлайн-контекст | спор | Opus-К, Fable-К: fail-open `auto` ради GitLab shared runners. Опасение снято фактом из документации GitLab (⚠ С3); на хостах без userns-sandbox и при голом `docker run` конфликт с ТЗ остаётся → вопрос 8, §3 | Sol-К D25; Terra-К D25, §4 «SSRF»; Opus-К D25, §4.9; Fable-К D25 |
| D26 | План и оценки | Структура Opus-К с правовыми воротами Fable-К в редакции модератора (раздел 3). Этап 0: 5–6 чд. Этап 1: 18–21; сдачу этапа 1 закрывает прототип (раздел 2а), а его работа сверх этапа 1 засчитывается в 3а при пересчёте после спайков. Этап 2: 5–7. Этап 3а (остальные P0, CONSENT-05, M, HTML, JUnit/Summary, PDF как stretch, тексты, калибровка): 45–52; без PDF — 44–50. Этап 4: 6–8. Итого 79–94 чд без буфера, **91–108 чд с буфером 15 %**; коридор риска до 135 чд; P1 сверх релиза — около 20 чд; PDF (1–2 чд) уже входит в 45–52. После спайков этапа 0 оценка пересчитывается | структура — большинство (Opus-К, Fable-К); спор по оценке | Sol-К и Terra-К — свои ворота этапов (совместимо). Sol-П 54–75 (занижено на 30–40 %), Terra-П 103–149, Fable-К 100–135 → §3 | Opus-К §4.12; Fable-К D26; Sol-К D26; Terra-К D26 |
| D27 | Название | Рабочее имя `dsgvo-check` остаётся: в npm оно свободно на 30.10.2026, одноимённый GitHub-репозиторий без лицензии существует. До начала этапа 1 — clearance: DPMA, EUIPO, домен, npm, GitHub-организация, GHCR. Переименование — только если clearance провален или заказчик выберет UA без URL, а токен не пройдёт тест `isbot` и регулярок CMP. В `<org>/<repo>` не должно быть `bot`, `crawler`, `spider`, `robot`: Borlabs ловит `bot` в UA. Имя, организация и домен фиксируются до этапа 1: они входят в UA, `$id` схемы, GHCR и `action.yml` | единогласно — рабочее имя до clearance; условия переименования — решение модератора | Fable-К: переименовать, если имя входит в браузерный UA. Opus-К: токен в UA должен проходить бот-тест (`dsgvo-check` не проходит `check\b`). При буквальном UA (D10) переименование бот-режим RCB и `isbot` не снимает: их ловит и ссылка (`http`, `\.com\b`). Поэтому эти условия не приняты | Все четыре -К: D27; R1-полнота (npm, GitHub) |

---

## 2а. Прототип (этап 1)

Прототип — отдельный срез, а не релиз 1.0 и не его ворота. Его манифест — [`docs/prototype/BRIEF.md`](../prototype/BRIEF.md): объём, упрощения, стек и владение файлами берутся оттуда, во всём остальном прототип следует этому файлу. Прототип закрывает сдачу этапа 1 ТЗ (CLI, JSON, коды возврата, первая проверка каждого модуля, Docker-образ) и проверяет архитектуру на живых сайтах. По ширине он заходит дальше этапа 1 — 14 из 15 P0 (без PRIV-02) и CONSENT-05, фазы A, B, C, семь адаптеров; по глубине — с явными упрощениями BRIEF. Этап 3а доводит эти проверки до спецификации раздела 4 и контрактов раздела 5, а не пишет их заново.

**Не являются воротами прототипа** (на этом сходятся оба верификатора, [errata №59–60](round-4/errata.md)):
- фазы A′ и M;
- in-process egress-прокси и `EgressPolicy`. Они переходят на этап 2 вместе с Action. До этого SSRF-граница прототипа — проверка IP при навигации и в инжектируемом `lookup`, без претензии на полноту, и прототип не запускается в CI с секретами;
- baseline, подавления и `baseline migrate`; PDF и JUnit; PRIV-02; autoconsent; вычитанный `en`;
- CMP-лаборатория и приёмочная канарейка D23.

**Что прототип обязан взять из поправок раунда 4б** (BRIEF приводится в соответствие):
- контракт адаптера `extract / act / verify`, решение — `classifyFirstLayer` в core (D12). Перечень `extract, state, …, verify` в BRIEF устарел;
- `chromiumSandbox: true` при `--sandbox require` (D25);
- UA из `navigator.userAgent` или шаблона (D10);
- снимок первого экрана без автопрокрутки и правило 50 % (D20);
- полная CSP HTML-отчёта (5.8);
- относительный порог TLS-02 и `checkIP` (D19, раздел 4);
- `--proxy` только `http://` (D11);
- поля `request` по 5.3 (`delivery`, `result`, `provenance`, `tMs`, `features`): их форма входит в alpha-схему, менять её потом дороже;
- подтверждённый отказ и устойчивый идентификатор (раздел 4: CONSENT-01, CONSENT-05);
- документы без зависимости от отказа (D15);
- pnpm 12.16.1 (в BRIEF уже так).

**Канарейка прототипа.** BRIEF предусматривает прогон по 100 публичным сайтам. Это разовый измерительный замер: доля `inconclusive`, бот- и гео-режим, ошибки сбора. Допустимы только классы O и T и паузы D09; результаты приватны и в git не попадают, именованные результаты не публикуются и не уходят в CRM. Приёмочную канарейку D23 (10 сайтов с письменным согласием владельцев, `mustFind` и `mustNotFind`) он не заменяет. Нужно подтверждение заказчика (вопрос 5).

---

## 3. Подробности по спорным точкам и точкам, изменённым меньшинством

### D03 — коды возврата (спор 2:1:1)

**Стороны.**
- Sol-К и Terra-К: `2` значит «заказанная операция не выполнена корректно». Любая ошибка включённой проверки даёт `2`, и `2` важнее `1`. Так проще, и CI никогда не зелёный при сбое.
- Fable-К: по ТЗ `2` — это «сканер сам упал». Флейк одной проверки (DKIM timeout) не должен красить CI этим кодом. Ошибка проверки идёт по порогу, `--strict` даёт `2`.
- Opus-К: компромисс — релевантность по `maxSeverity`, `1` выше ошибки проверки, все причины в `exitReasons[]`.

**Почему выбран компромисс Opus.**
1. Вариант Fable даёт `exit 0`, если упал `run` у P0-проверки (например, `TypeError` в CONSENT-04). Зелёный CI при невыполненной обязательной проверке нарушает корректность.
2. Вариант Sol/Terra превращает транзиентный SERVFAIL у MAIL-03 в «сканер упал». Это главный источник флейков. При `--fail-on critical` (по умолчанию) MAIL-03 не может повлиять на исход порога: её максимальный вариант — `warning`. При `--fail-on warning` она релевантна, и её ошибка даёт `2`.
3. Приоритет `1` над `2 (check-error)`: в обоих случаях job падает. Находка о сайте — это действие для разработчика сайта, а `exitReasons[]` сохраняет всю картину. Если среди причин есть `check-error`, GitHub Action печатает `::warning::` и строку в Job Summary (мягкий режим на GitHub — `continue-on-error`), а GitLab-шаблон — сообщение в stderr и `<error>` в JUnit. Цена мягкого режима GitLab (`allow_failure: exit_codes: [1]`): при наличии находки job проходит и тогда, когда упала проверка. Это сказано в документации шаблона и в вопросе 2.
4. Цена — статические `variants` у проверки. Они всё равно нужны для теста полноты (D05).

То, что `2` при недоступной цели или WAF уточняет буквальное «сканер сам упал», признают все четверо. Нужно подтверждение заказчика (вопрос 2). Большинства нет (2:1:1), поэтому выбор компромисса — решение модератора.

### D08 — страницы фаз B и C (большинство 3:1)

**Стороны.**
- Sol-К: без одинаковых контентных URL в A/B/C сравнение «до/после» бессмысленно. Выбор страниц C только по сетевым хитам A пропускает правильно заблокированные embeds (принято: выбор и по DOM-сигналам).
- Terra-К: независимые профили; B/C — вход и общая контрольная подвыборка.
- Opus-К: B и C на всей шестёрке страниц не укладываются в 8 минут и бюджет запросов. Fable-К: B/C — стартовая и 2 страницы. Расчёт «180 с и 600 запросов» на одинаковой выборке — ошибка Terra-П (§6.1 №61).

Итог — 3:1 за общую контрольную подвыборку, против Sol-К. В раунде 4 Terra-К был ошибочно записан в сторонники одинаковой выборки (errata №2).

**Решение и почему.** B и C идут по одной и той же контрольной выборке: старт и 2 страницы. Страницы выбираются до фазы B по сигналам A — сетевым и DOM (плейсхолдеры, iframes, шаблоны). Так B и C сопоставимы, а бюджет вырастает примерно на одну навигацию. Профиль A последовательный (Sol-К и Terra-К о накоплении состояния): порядок страниц и состояние пишутся в evidence, «первый визит» утверждается только для стартовой, остальные — «Folgeseite in derselben Sitzung». Адресные свежие A-прогоны для отдельных entrypoints — бэклог.

### D09 / LEGAL-01 — изменено меньшинством (Fable-К, Sol-К)

Fable-К: BGH I ZR 228/03 (20.07.2006) признаёт достаточной достижимость Impressum за два клика, в том числе через «Kontakt». `critical` без такого перехода может противоречить BGH. Sol-К: `#` и `javascript:` могут открывать рабочую модалку; страницу с challenge нельзя молча выкидывать из знаменателя.

**Решение.** До `critical` выполняется один переход по ссылкам «Kontakt», «Rechtliches» или «Über uns» (≤ 3 GET), затем фолбэк `/impressum` и `/datenschutz`. `#` без найденного содержимого модалки даёт `unresolved` (`info`), а не «broken». Формулировка: «auf n von m geprüften Seiten … nicht gefunden; über [Zwischenseite] erreichbar: ja/nein». В coverage — «geplant / beobachtet / auswertbar».

### D10 — User-Agent (спор 2:1:1)

**Стороны.**
- Fable-К: UA вида `Chrome … dsgvo-check/0.1 (+https://github.com/…)` распознаётся `isbot` по паттернам `http`, `\.com\b`, `check\b` и копией этой регулярки в Real Cookie Banner. RCB для ботов по умолчанию «принимает всё». Отсюда ложные CONSENT-01/02/03 или массовый `inconclusive`. Предлагал в браузере токен без URL и заголовок `X-Dsgvo-Check`.
- Opus-К: в браузере Chrome UA и токен со ссылкой; куда ведёт ссылка — на репозиторий или на страницу проекта, — решает заказчик по данным С1. С решением совместимо.
- Sol-К и Terra-К: ТЗ требует «честный User-Agent со ссылкой на репозиторий». Заголовок это требование не выполняет, переименование не гарантирует человеческого поведения CMP. Бот-режим — ограничение измерения.

**Найденные ошибки.** Заголовок `X-…` делает cross-origin-запросы «непростыми» и может вызвать CORS-preflight (⚠). Через CONNECT-прокси его в HTTPS не добавить, и он уходит всем третьим лицам (Opus-К, Terra-К). Поэтому вариант отклонён.

**Почему так.** Приоритет спора (ТЗ и право → корректность детекта → простота → сроки) ведёт к букве ТЗ. Корректность при этом сохраняется: обязательный детектор превращает бот-режим в `inconclusive`, а не в ложную находку. Цена ограничена. По регуляркам, извлечённым из исходников, буквальный UA ловят только `isbot` и RCB (1 из 25 CMP-находок каталога). Cookiebot `isSpider`, Complianz `cmplz_is_bot` и Borlabs 3.5 `isBot` его не ловят, пока в UA нет `bot`, `crawler`, `spider`, `robot` (browser-automation §3.2). Usercentrics ловит `HeadlessChrome` и `Playwright/` — это не наш UA, но эффект не изучен; CCM19 и CookieHub не проверены. Спайк С1 подтверждает таблицу в рантайме на CMP-лаборатории (буквальный UA, токен без URL, чистый Chrome UA) и отдельно проверяет Usercentrics, CCM19, CookieHub и лениво подгружаемые чанки. Рекомендация заказчику условная (вопрос 3).

### D11 — гео (изменено меньшинством, Sol-К)

Sol-К нашёл три ошибки вывода. (1) Opus-П: «CMP-скрипта нет → гео-таргетинг невозможен». Решение по региону может принять сервер, CDN, inline-код или собственная CMP. (2) Fable-П: «`region` в Consent Mode без DE — гео-сигнал». Региональные defaults не сообщают, где посетитель. (3) Fable-П: `--require-eu-egress` выполнялся при прокси или `--assume-region`. Ни то, ни другое регион не подтверждает (так же Terra-К). Ещё одна ошибка: consent-cookie без клика как общий признак бот-режима (Opus-П). Это может быть default-state CMP или настоящий дефект сайта.

**Что изменено.** Условие «нет CMP-скрипта» для `critical` CONSENT-03 удалено. `critical` требует `egress.region: asserted` (EWR) с записью происхождения «laut Nutzerangabe». Что одного заявления пользователя достаточно для `critical`, решил модератор, а не Sol-К: Sol-К и Terra-К считали заявление пользователя недостаточным. Поэтому текст находки всегда содержит «Region laut Nutzerangabe», для доказательных аудитов рекомендован контролируемый DE- или EWR-egress (вопрос 12), а уровень `verified-by-operator` — бэклог. Гео- и бот-диагностика ставится только по прямым сигналам. На уровне гипотезы факты сохраняются вместе с limitation и не подавляются.

### D13 — CONSENT-04 (спор 2:2)

**Стороны.**
- Sol-К и Terra-К: геометрия и наличие кнопки не исчерпывают правовую оценку. До экспертного утверждения — `warning`.
- Opus-К и Fable-К: для блокирующего баннера без равноценного отказа линия устоялась: DSK OH Digitale Dienste Rn. 124–125, OLG Köln 6 U 80/23 (19.01.2024), VG Hannover 10 A 5385/22, большинство EDPB TF (Type A). Каталог ставит CONSENT-04 в P0 с кодом T1.

**Почему `critical` для `blocking-no-reject` и `close-means-accept`.**
1. Право: для блокирующего баннера позиция устоявшаяся (legal-basis-map §2.1).
2. ТЗ запрещает ложный CONSENT-04 только на неизвестном баннере. Здесь вердикт дают лишь собственные адаптеры с `high`.
3. Корректность обеспечивают технические исправления Sol-К, все приняты. Первый экран снимается до клика, потому что `locator.click()` прокручивает элемент. `aria-modal` сам по себе блокировку не доказывает. Scroll-lock на внутреннем контейнере не считается. `elementFromPoint` может вернуть потомка ссылки. Семантика «×» и «Verbergen» не предполагается: `close-means-accept` — только по прочитанному конфигу. Уверенность в CMP и в функции кнопки считаются раздельно. `pur-abo` — флаг, а не выключатель.
4. Требование Terra «до экспертного утверждения» выполняется процессом: ruleset имеет статус draft, пока заказчик его не подписал (вопрос 9), и до подписи релиз заблокирован. Разработка не ждёт подписи, потому что тесты проверяют `variant`, а не уровень.
5. Вариант требует, чтобы на первом уровне можно было дать согласие (`acceptAvailableAtFirstLayer`). Экран «только настройки» неравноценности на первом уровне не содержит: там нельзя ни согласиться, ни отказаться. Такой экран — `no-choice-at-first-layer`, `info` с ручной оценкой (поправка Sol, раунд 4б; формулировка DSK Rn. 125 — ⚠, §7 №10).

`reject-as-link`: Fable-К предлагал `warning` (EDPB TF Type C), Opus-К — `info`. Выбран `info` с ручной оценкой: «достаточная визуальная поддержка» ссылки детектом не устанавливается. Заказчик может поднять уровень в таблице. Неблокирующий баннер без отказа → `info` (3:1 в раунде 3: Terra-К держал `warning` до экспертного утверждения; `warning` из Fable-П отозван).

### D15 — PDF-политики (спор)

**Стороны.**
- Sol-К: текстовый PDF через pdfjs-dist в изолированном процессе уже в MVP. Иначе релиз не вправе заявлять поддержку PDF.
- Terra-К: PDF с текстовым слоем — при наличии проверенного парсера.
- Opus-К и Fable-К: YAGNI; честный `inconclusive` лучше частичного разбора.

**Почему `inconclusive` в 1.0.**
1. Корректность: неполный разбор PDF даёт ложные «nicht gefunden». PRIV-01 — третья по частоте P0 (48/80; чаще только HDR-01 — 64 и MAIL-01 — 54) и самая шумная.
2. Простота и безопасность: недоверенный PDF требует отдельного изолированного процесса, это ещё одна поверхность атаки.
3. README прямо пишет: «PDF-Datenschutzerklärungen werden in 1.0 nicht ausgewertet».

pdfjs-dist (Apache-2.0) в отдельном процессе — P1 после релиза. Приняты исправления Sol-К: manifest полноты вместо порога «< 2 000 символов» (Fable-П), происхождение фрагментов (совпадение только в `hidden-irrelevant` — не «named»), отрицание, привязанное к предикату («Google Analytics ohne Cookies» — не отрицание использования).

### D16 — модель получателя (изменено меньшинством, Fable-К)

Opus-П и Fable-П писали «Empfänger: Google LLC (US)». Для GA и GTM Vertragspartner EWR-Kunden — Google Ireland Limited; Google LLC — Konzernmutter и DPF-сертифицированный импортёр при onward transfer. Договорную роль сканер не видит, поэтому такое утверждение рискует стать unwahre Tatsachenbehauptung (§ 824 BGB). Кроме того, DPF — решение для сертифицированных организаций, а не страновой статус адекватности.

**Решение:** поля `provider`, `parent`, `dpfEntity` и `adequacy.json` с разделением `country-adequacy` и `organisation-list`. Формулировка: «Anbieter laut Dienstekatalog v[X]: Google Ireland Ltd. (IE), Konzernmutter Google LLC (US); „Google LLC“ am [Datum] in der DPF-Liste geführt. Ort der Verarbeitung und Übermittlungsinstrument wurden nicht geprüft.»

### D18 — DKIM-селекторы (большинство 3:1; вопрос 16)

**Стороны.**
- Sol-К: только заданные пользователем или документированные селекторы. Generic-словарь — это перебор, и отсутствие из него не следует.
- Terra-К: DKIM только при включённой MAIL-03 и с отдельным лимитом; отсутствие записи у набора селекторов не доказывает отсутствие DKIM. С решением совместимо: лимит ≤ 25, результат только `info`.
- Opus-К и Fable-К: ≤ 25 TXT-запросов к публичному DNS не касаются сайта; короткий список снижает долю ложных «nicht gefunden».

**Почему ≤ 25 с `info`.** Запросы уходят к авторитетному DNS, а не к сайту, то есть это класс T. Риск ложного утверждения снимается тем, что результат — только `info` «unter N geprüften Selektoren nicht gefunden», без слов «DKIM fehlt». Одновременно отменена поправка «`warning` для провайдеров с фиксированными селекторами» (Fable-К, Opus-П): Google допускает собственный префикс селектора (Sol-К), а MX не определяет домен подписи. `warning` остаётся только для ключа < 1024 бит и для заданного пользователем селектора, которого нет или который отозван.

Совместим ли короткий generic-список с запретом «перебора» в ТЗ, решает заказчик (вопрос 16). До ответа действует этот порядок: сам каталог описывает MAIL-03 как поиск «на распространённых селекторах».

### D20 — скриншоты (спор 2:2)

**Стороны.**
- Sol-К и Terra-К: скриншоты по умолчанию увеличивают поверхность утечки; UrhG § 51 не разрешает их автоматически (⚠).
- Opus-К и Fable-К: скриншот баннера — главное человеческое доказательство для CONSENT-04; область баннера почти не содержит персональных данных.

**Почему включён по умолчанию, но только для области баннера.** Проверяемость важна для защиты по § 824 BGB и для аудитора. Обрезка снимка viewport по контейнеру баннера (desktop и M, JPEG ≤ 200 КБ, только при однозначном контейнере ≤ 50 % viewport) снижает риск попасть на фото людей и отзывы, но не исключает его: контейнер может быть прозрачным или содержать произвольный контент. `locator.screenshot()` не используется: он прокручивает элемент и меняет первый экран. Правовая неопределённость по § 51 вынесена в вопрос заказчику (вопрос 11); решение обратимо одним флагом. Абзац дисклеймера про скриншоты условный.

### D21 — состав fingerprint (изменено меньшинством, Opus-К)

Opus-К показал техническую ошибку, общую для всех четырёх предложений. Хост цели в ключе ломает baseline на preview-деплоях: каждый PR на `*.vercel.app` или `*.netlify.app` — это private suffix PSL со своим eTLD+1, и ни одна находка не совпадёт. Страницы и фаза в ключе (Sol-П, Terra-П) дают мигание при эвристической выборке, а у Terra — ещё и дубль одного трекера в A и A′.

**Решение:** ключ без хоста, страниц и фазы. У first-party-cookie в `subject` вместо хоста стоит маркер `first-party`. Возражение Sol-К («агрегация скрывает новую затронутую страницу») принято как документированное ограничение: страницы лежат в evidence, baseline возвращает находку при росте severity или смене `variantGroup`, выборку можно закрепить через `pages:`.

### D25 — sandbox и сетевая граница (спор 2:2)

**Стороны.**
- Sol-К и Terra-К: fail-closed и принудительный egress. Предупреждение в отчёте не заменяет границу безопасности.
- Opus-К и Fable-К: `--sandbox auto` с fail-open, иначе GitLab shared runners не работают, а шаблон GitLab обязателен по ТЗ.

**Почему `require` по умолчанию и явный `off` без `auto`.**
1. Главный аргумент за fail-open ослаб: hosted runners GitLab.com работают в privileged-режиме в одноразовой VM, так что sandbox там, скорее всего, поднимается. Это нужно подтвердить спайком С3.
2. Два режима проще трёх, а «тихой» деградации безопасности нет.
3. Для сред, где sandbox не поднимается, есть явный `off` с диагностикой — шаблон остаётся рабочим.

**Поведение `require` на трёх входах ТЗ** (раунд 4б):

| Вход ТЗ | Что делает сканер | Если sandbox не поднялся |
|---|---|---|
| `npx dsgvo-check <url>` на хосте | userns-sandbox Chromium (`chromiumSandbox: true`) | `exit 2`, `sandbox-unavailable`. Сообщение называет причину (AppArmor `apparmor_restrict_unprivileged_userns` на Ubuntu ≥ 23.10 ⚠, нет user namespaces) и три пути: запуск через образ; системная настройка AppArmor или userns, которую делает сам пользователь (сканер её не меняет); явный `--sandbox off` |
| `docker run <image> <url>` | Образ несёт seccomp-профиль и выдаёт его командой `docker run --rm <image> seccomp-profile > dsgvo-check-seccomp.json`. README даёт одну строку запуска с `--security-opt seccomp=…`, `--cap-drop=ALL`, non-root | С дефолтным seccomp Docker sandbox не стартует (эксперимент ресёрча) → `exit 2`; сообщение печатает точную строку запуска с профилем |
| CI: GitHub Action, GitLab-шаблон | Action сам передаёт профиль в `docker run`; GitLab.com `saas-linux-*` — privileged-VM (⚠ С3); для self-managed в шаблоне есть переменная для явного `off` | `exit 2` с инструкцией; `off` — только явной переменной шаблона |

Конфликт с ТЗ назван прямо. ТЗ требует «`<tool> https://example.de` — без конфига, с разумными умолчаниями» и «остальные CI — через Docker-образ». На хосте без userns-sandbox и при голом `docker run` первая команда даёт `2` с инструкцией, а не отчёт. Варианты и рекомендация — в вопросе 8. Молчаливый fail-open на ноутбуке панель не рекомендует: там рядом с браузером личные данные и ключи пользователя, и sandbox там важнее, чем в одноразовой VM CI.

Объяснение отказа в Docker уточнено в раунде 4б: дефолтный seccomp-профиль разрешает `clone` с `CLONE_NEWUSER` и `unshare --user`, но без `CAP_SYS_ADMIN` блокирует прочие `CLONE_NEW*` (PID, NET), которые нужны namespace-sandbox Chromium; профиль Playwright их разрешает.

Принудительная сетевая граница (сканер в `--internal`-сети и отдельный контейнер-прокси) в одном контейнере невыполнима (Opus-К), поэтому это бэклог. Модель угроз в README пишется честно: прокси — политика для неуязвлённого браузера.

### D26 — оценка (спор по числам)

Разброс оценок: Sol-П 54–75 (65–90 с резервом), Fable-П 72–90, Opus-П 108–120, Terra-П 103–149, Opus-К 79–94 (91–108 с буфером), Fable-К 100–135, Terra-К 80–140. Принята пошаговая оценка Opus-К: 7 адаптеров с симуляторами 8–9 чд, фазы и verify 3–4, PRIV и каталог 12–14, калибровка 5–6; 45–52 чд этапа 3а включают PDF как stretch, без него — 44–50. В плановую базу заложен буфер 15 % (91–108 чд), коридор риска — до 135 чд. Структуру Opus-К поддержал Fable-К; Sol-К и Terra-К предлагали свои ворота этапов, совместимые с ней.

Правовые ворота Fable-К встроены в план в редакции модератора. Fable-К ставил подпись ruleset и `crmCode`-маппинга на конец этапа 0. Модератор разделил её: в конце этапа 0 утверждается политика уровней, а конкретные значения подписываются в конце 3а. Им нужны данные калибровки, а тесты по `variant` подписи не ждут.
- конец этапа 0 — смысл `critical` (вопрос 1), политика уровней (T0/T1 «critical-способные», T3 не выше `warning`), коды, UA, manifest, политика `null` для `crmCode`;
- этап 2 — Impressum и Datenschutzerklärung домена проекта; витрина без реальных третьих сторон;
- конец этапа 3а — подписанные значения ruleset, маппинг `crmCode` и тексты, стоп-листы, лицензионный аудит;
- этап 4 — правовой статус проекта в README.

Спайки этапа 0:
- С1 — рантайм-подтверждение статической таблицы UA (ресёрч §3.2) на лаборатории; отдельно Usercentrics, CCM19, CookieHub и лениво подгружаемые чанки;
- С2 — persistent-профиль против `newContext`, CfT против headless shell;
- С3 — Chromium sandbox на трёх входах ТЗ: GitHub hosted (Action и шаг `npx` на `ubuntu-24.04`), GitLab.com `saas-linux-*`, голый `docker run` с дефолтным seccomp и с профилем образа (amd64), хост Ubuntu 24.04 с AppArmor;
- С4 — проба TLS 1.0/1.1 с OpenSSL образа;
- С5 — `EgressPolicy` и egress-прокси (`proxy-chain` или свой CONNECT, HTTP/2, QUIC, preconnect, WebRTC; `lookup` для undici, `node:tls`, `net`; приём upstream-прокси `CONNECT` на IP-литерал);
- С6 — адаптеры Borlabs и Cookiebot;
- С7 — захват pagehide/keepalive и SW-запросов.

Критический путь:
1. Решения по вопросам 1–3 и спайки С1, С2, С3, С5, С7.
2. Прототип (этап 1, раздел 2а): пять контрактов в alpha-версии (`Snapshot`, `CheckDefinition` с `variants`, `Ruleset`, `gate()`, схема `Report`) и браузерный коллектор.
3. `EgressPolicy` и egress-прокси — к этапу 2 вместе с Action. До этого SSRF-граница прототипа неполная, и в CI с секретами он не запускается.
4. `CmpFacts` и адаптеры Borlabs, Cookiebot, Complianz до релизного качества (20 из 25 CMP-находок каталога).
5. Фаза B, verify, CONSENT-04/05.
6. Калибровка.

Вторая цепочка: экспорт аудитов → каталог → derive → PRIV-01.

---

## 4. Сводная спецификация проверок

Обозначения фаз: A — до действия; A′ — нейтральное взаимодействие без клика; B — после отказа (и до клика на старте); C — после принятия; M — мобильный первый уровень; HTTP/TLS/DNS — небраузерные коллекторы. Этапы: «1» — первая проверка модуля на каркасе; «3а» — релизный manifest; «3б» — P1 после manifest; «после» — после релиза. Колонка «crmCode» повторяет каталог; ⚠ — вероятная ошибка каталога (вопрос 6). `crmCode` выводится только в JSON. Для вариантов «Banner nicht erkannt» и для P2 до утверждения справочника он равен `null`.

| ID | Фаза · источник | Суть детекта | Уровень по умолчанию | Понижение / inconclusive | crmCode | Правовой якорь | Этап |
|---|---|---|---|---|---|---|---|
| **PRIV-01** (P0) | A, A′, B, C — инвентарь сервисов; DSE из `documents` (A без кликов, дополнение в B) | Сервис каталога с `policyRelevance: required`, реально загруженный хотя бы в одной фазе, ищется в DSE по алиасам продукта, оператора и доменам; уровни `named > company > domain > category` | `warning` (not-named); никогда `critical` | `category-only` → `info`. Совпадение только в `hidden-irrelevant` или неоднозначное отрицание → `info` (ручная оценка). PDF, неполный manifest, язык не de/en → `inconclusive`. Баннер не закрыт, но manifest полон → `partial` с limitation `banner-open`. DSE не найдена → это LEGAL-01, не PRIV-01 | T3_LEGAL_DOCS_MISMATCH | Art. 13 Abs. 1 lit. e, f DSGVO; «Kategorien von Empfängern» допустимы | 3а |
| **PRIV-02** (P0) | DSE + наблюдения A, B, C | Каталог утверждений (~6 в MVP: «Google Fonts lokal», «keine Cookies vor Einwilligung», «Analyse nur nach Einwilligung», «wir nutzen kein X», «erweiterter Datenschutzmodus», «Matomo ohne Cookies»). Утверждение раскладывается на субъект → предикат → отрицание → условие → фазу и сверяется с противоречащим фактом. Цитата ≤ 200 знаков с URL и разделом | `critical`: утверждение распознано с `high`, противоречие наблюдается в той фазе, о которой оно говорит, и воспроизведено (≥ 2 страниц или A и B-до-клика). Иначе `warning` | Исторический или условный контекст («früher», «außer»), другой продукт → находки нет. Неоднозначно → `inconclusive`. Устаревшие формулировки (Privacy Shield; роль Google reCAPTCHA с 02.04.2026) → `info` «Formulierung prüfen» | T1_MISLEADING_CLAIM | Art. 5 Abs. 1 lit. a, Art. 12, 13 DSGVO; § 5 UWG — спорно, в текст не выносится | 3а |
| **CONSENT-01** (P0) | A, A′, B до клика · `context.on` с подпиской до навигации, CDP initiator, журнал прокси, время **начала** запроса | Сторонние (eTLD+1 ≠ цели) и first-party-proxy (sGTM/tag gateway по пути и параметрам) запросы, начатые до любого клика. Владеет категориями analytics, ads, session-recording, tag-manager и остатком; EMBED-* владеют своими. Одна находка на сервис, неизвестные хосты — одна агрегированная | `critical`: analytics/ads/session-recording, запрос отправлен и получен ответ (`delivery: sent`, `result: response`), идентификатор устойчивый (`identifier.kind`: `stored-match`, `persistent-param` по сигнатуре каталога или `user-supplied`). `warning`: tag-manager или библиотека без хита (GTM), first-party-proxy (`medium`), cookieless ping Consent Mode, хит с идентификатором `per-load` или `none`. `info`: cdn, payment, consent-provider, unknown | `delivery: attempted` или `blocked-by-browser`, CSP-блок → ≤ `info`. Не воспроизведено в B-до-клика → `replicated: false` в evidence, уровень сохраняется. Прямой бот- или гео-сигнал → `inconclusive`. A′ — тот же уровень с `trigger` | T1_TRACKER_BEFORE_CONSENT | § 25 Abs. 1 TDDDG; Art. 6 DSGVO; EuGH Planet49 C-673/17; VG Hannover 10 A 5385/22 (GTM ⚠) | 3а |
| **CONSENT-02** (P0) | A, A′ · `context.cookies()` после каждой страницы, CDP Set-Cookie ExtraInfo и `blockedCookies`, init-хук `document.cookie`/CookieStore (без значений), local/sessionStorage, имена IndexedDB | Новые cookies и записи хранилищ до клика минус allowlist (consent-cookie CMP, сессия, LB, CSRF, язык). Ключ `(name, domain или first-party, path, partitionKey)`. Классификация: каталог → Open Cookie Database → контекст сеттера. Транзиентные JS-cookies ловятся хуком | `critical`: известный трекинговый идентификатор (`_ga`, `_gid`, `_fbp`, `_gcl_au`, `_hjSession*`, `_pk_id`, NID, IDE и аналоги в storage) в состоянии `accepted`. `warning`: неизвестная persistent third-party. `info`: неизвестная persistent first-party, CMP-cookie с UID | Отвергнута браузером или только `attempted` → `info`. Бот-сигнал → `inconclusive`. Allowlist → «nicht bewertet (Allowlist vX)», а не «notwendig» | T1_TRACKER_BEFORE_CONSENT | § 25 Abs. 1, Abs. 2 Nr. 2 TDDDG; Planet49; BGH I ZR 7/16 | 3а |
| **CONSENT-03** (P0) | A, A′ · DOM всех фреймов и open shadow DOM, адаптеры, детект autoconsent, эвристика, сеть | Ни адаптер, ни autoconsent, ни эвристика не нашли кандидата баннера на старте и ещё ≥ 1 странице (с ожиданием до HARD_CAP и после A′), при этом есть сервисы, требующие согласия: analytics/ads/session-recording или embed с записью storage. Только шрифты или CDN — не CONSENT-03, это EMBED-01 | `critical`: сильный tracking (идентификатор или трекинговый storage), нет гео- и бот-сигналов, `egress.region: asserted` EWR. Иначе `warning` | Гео- или бот-сигнал → `inconclusive` и диагностика. Borlabs `dialogHideDialogOnPages` → страница пропускается. Эвристический кандидат без адаптера → это не CONSENT-03, а CONSENT-04 `info` | T1_CONSENT_BANNER_BROKEN | § 25 Abs. 1 TDDDG; Art. 6, 13 DSGVO | 3а |
| **CONSENT-04** (P0) | B (первый экран до клика), M, A (блокировка) · `CmpFacts`: кнопки (роль, accessible name, геометрия, actionability, контраст), блокировка, состояние CMP | Чистая таблица D13 поверх `CmpFacts` распознанного CMP; нажатая коллектором кнопка записывается в `plan.click` | `critical`: `blocking-no-reject` (accept на первом уровне есть, reject нет), `close-means-accept`. `warning`: `reject-not-actionable`, `reject-ineffective`, `consent-without-action` (CMP-состояние `granted` без клика и без бот-сигнала). `info`: `reject-as-link`, `nonblocking-no-reject`, `no-choice-at-first-layer` (блокирует, но нет ни accept, ни reject), `pur-abo` | Нет адаптера, CMP `medium` или версия вне диапазона → `info` «Banner nicht erkannt» / «CMP X erkannt, nicht unterstützt», статус `inconclusive`, `crmCode: null`; эти варианты неповышаемые (`locked`). Гео- или бот-режим → `inconclusive`. При повторе по снимку расхождение с `plan.click` даёт limitation `lexicon-changed-since-scan` | T1_CONSENT_BANNER_BROKEN | Art. 4 Nr. 11, Art. 7 DSGVO; § 25 TDDDG; DSK OH Rn. 124–125; OLG Köln 6 U 80/23; VG Hannover 10 A 5385/22 | 3а |
| **TRACK-01** (P0) | A, A′, B, C · сеть (сигнатуры payload), `dataLayer` | Инвентарь analytics/ads/session-recording/tag-manager по сигнатурам: GA4 `/g/collect` с `cid`, `gtag/js?id=G-`; GTM `gtm.js`; Meta `fbevents.js` и `/tr?ev=`; Google Ads `googleads.g.doubleclick.net`, `pagead`; Hotjar `static/script.hotjar.com`, `ws.hotjar.com`; Matomo, Clarity, LinkedIn, TikTok, Pinterest. Стадии `loaded → initialised → event-sent`; тайминг `before-interaction / after-reject / after-accept`. Связь с CONSENT-01/02/05/06 — через общие `evidenceIds` | `info` — инвентарь; уровень несёт связанная CONSENT-находка (рекомендация панели, вопрос 6) | Ссылка в исходнике без запуска → находки нет; GTM-контейнер ≠ сработавший тег | T1_TRACKER_BEFORE_CONSENT ⚠ для `info`-инвентаря и тайминга after-accept — вопрос 6 | § 25 TDDDG; Art. 6 Abs. 1 lit. a; Art. 26 (Fashion ID C-40/17) | 3а |
| **EMBED-01** (P0) | A, A′, B · сеть (CSS → `@font-face` → font, initiator), DOM `link rel`, журнал прокси | Фактическая загрузка CSS или файла шрифта с хостов категории fonts: `fonts.googleapis.com`, `fonts.gstatic.com`, `use.typekit.net`, `p.typekit.net` ⚠, `use.fontawesome.com`, `fonts.bunny.net` (с пометкой EU) | `warning` (`fonts-loaded`) | Только preconnect/dns-prefetch → `info`. Self-hosted или локальный прокси → находки нет. Загрузка после отказа — тот же `warning` плюс сигнал для PRIV-02 | T1_FONTS_EXTERNAL | Art. 6 DSGVO; LG München I 3 O 17493/20 (одиночное); § 25 спорно | 1 |
| **EMBED-02** (P0) | A, A′, B (приоритет у Kontakt и Anfahrt) · сеть, DOM | iframe `maps/embed`, JS API, static maps, тайлы (Google, OSM, Mapbox, HERE по каталогу); тип пишется в evidence | `warning`; запись cookie или storage провайдером — отдельно в CONSENT-02 | Обычная ссылка, локальная картинка, Zwei-Klick-плейсхолдер без загрузки → находки нет | T1_MAPS_BEFORE_CONSENT | § 25 TDDDG (cookies); Art. 6; DSK OH Rn. 74, 101, 123 | 3а |
| **MAIL-01** (P0) | DNS | TXT `_dmarc` хоста; Tree Walk по RFC 9989 (с PSD, без стопа на eTLD+1, ≤ 8 запросов); парсер тегов RFC 7489 и 9989; матрица MX и Null MX | `warning`: записи нет, `p=none`, запись невалидна | `info`: `sp=none` при `p≠none`, `t=y` (RFC 9989), legacy-тег `pct<100` (RFC 7489; в RFC 9989 удалён — отдельный вариант), нет `rua`, Null-MX без `p=reject`. SERVFAIL или timeout после повтора → `error`, а не «записи нет» | T3_MAIL_UNPROTECTED | Art. 32 DSGVO (косвенно); BSI TR-03108-1, TR-03182 — тех. стандарт | 1 |
| **MAIL-02** (P0) | DNS | Ровно одна запись `v=spf1`; разбор include и redirect, ≤ 10 lookups и ≤ 2 void, циклы; оценка вместе с DMARC | `warning`: нет записи, `+all`, `?all`, permerror, несколько записей, `~all` без DMARC quarantine/reject | `info`: `~all` при DMARC-enforcement (BSI TR-03182 допускает SoftFail), `ptr`. SERVFAIL → `error`. Вывода о реальной отправке нет | T3_MAIL_UNPROTECTED | как MAIL-01 | 3а |
| **HDR-01** (P0) | HTTP-ответы главных документов (старт, Impressum, DSE) после редиректов | По находке на механизм, в отчёте сгруппированы: HSTS (только на https), anti-framing (XFO или CSP `frame-ancestors` в заголовке), CSP (enforced или report-only), nosniff, Referrer-Policy, Permissions-Policy | `warning`: нет HSTS, нет anti-framing, Referrer-Policy `unsafe-url` или `no-referrer-when-downgrade`. `info`: нет CSP, nosniff, Permissions-Policy или Referrer-Policy | `frame-ancestors` в meta-CSP не засчитывается; HSTS через preload учитывается; текст «in der Antwort von [URL]» | T3_NO_SECURITY_HEADERS | Art. 32, 25 DSGVO; § 19 Abs. 4 TDDDG — тех. стандарт | 1 |
| **TLS-01** (P0) | HTTP-клиент (`http://` хоста, apex и www; ручные редиректы ≤ 5, без HSTS-кэша) + A (формы, http-ссылки) | Цепочка до https-2xx того же хоста; meta- или JS-редирект; формы на http-странице; ссылки меню на свои http-поддомены | `critical`: http отдаёт контент, а https недоступен или невалиден, либо на http-странице есть форма. `warning`: http 2xx без редиректа при рабочем https; редирект только через JS или meta | `info`: первый хоп не на https или на другой хост; http-ссылки на свои поддомены. Закрытый порт ≠ отдача. Timeout → `inconclusive`. Заглушка ≤ 1 KiB → находки нет | T1_UNENCRYPTED | § 19 Abs. 4 S. 3 TDDDG; Art. 32 Abs. 1 lit. a; для статичной страницы — спорно | 3а |
| **TLS-02** (P0) | TLS: `node:tls` через `EgressPolicy`; для имени — SNI и свой `X509Certificate.checkHost`, для IP-цели — без SNI и `X509Certificate.checkIP`; Mozilla-store (`--use-system-ca` опционально) | Цепочка, имя и срок для финального хоста (и www/apex); в evidence `connectedIp`, семейство адреса, trust store | `critical`: истёк, имя не совпадает (чужой сертификат хостера), самоподписан, неизвестный корень. `warning`: неполная цепочка; остаток < min(14 д, 25 % срока действия) | `info`: остаток < min(30 д, 50 % срока действия); при сроке действия ≤ 10 д находки о сроке нет, только evidence `lifetimeDays`. Расхождение валидаторов → описание конкретного результата. Handshake без установленной причины → `inconclusive`. Невалидный TLS → браузерные проверки `skipped (tls-blocked)` | T1_UNENCRYPTED | как TLS-01 | 1 |
| **LEGAL-01** (P0) | A, B, все посещённые страницы · DOM (accessible name, href, меню, shadow DOM, баннер), HTTP GET целей | Поиск ссылок Impressum и Datenschutz по словарю меток (Rechtliches, Imprint, Privacy…), отдельно по каждому типу документа. Цель: 2xx, содержательность, soft-404. Для `#` и `javascript:` проверяется модалка. Учитывается перекрытие подвала баннером. Если ссылок нет — один переход через Kontakt, Rechtliches или Über uns (≤ 3 GET), затем фолбэк `/impressum`, `/datenschutz` | `critical`: документ не найден ни ссылкой, ни переходом, ни фолбэком, либо все ссылки ведут на 4xx/soft-404. `warning`: ссылки нет на части страниц; документ найден только через переход или фолбэк (`medium`); подвал перекрыт баннером без правовых ссылок в нём | `#` без содержимого модалки, нерезолвленный SPA-маршрут → `unresolved` `info`. Страница с challenge остаётся в знаменателе: «geplant / beobachtet / auswertbar» | T1_OTHER | § 5 DDG; Art. 13 DSGVO; BGH I ZR 228/03 (два клика); § 18 MStV — только в legalNote | 3а |
| **CONSENT-05** (P1 → релиз) | B после верифицированного отказа: reload и 2 страницы · сеть по времени начала, события storage, журнал прокси, окно ухода со страницы | Отказ подтверждается по состоянию: CMP ready; состояние изменилось после нашего клика (`origin: action`), и CMP фиксирует ответ пользователя (`decision.responded`, например Cookiebot `hasResponse` и `declined`); все необязательные категории `denied` или consent-cookie `denied`; после reload — `origin: stored`. Исходное `default`-состояние с `denied` отказом не считается. Подтверждение не зависит от сети и от закрытия UI. Затем ищутся новые хиты analytics/ads с идентификатором (start > click) и трекинговые cookies/storage, принятые после клика | `critical`: хит с устойчивым идентификатором (как в CONSENT-01) или новая трекинговая запись storage после отказа. `warning`: cookieless pings (`gcs=G100`, `gcd` denied) | `info`: только CONNECT к трекер-хосту по журналу прокси. Запросы, начатые до клика, не считаются новыми, но Set-Cookie, принятый после клика, — запись. Consent-update CMP исключён. Отказ не подтверждён (в т. ч. есть только default-denied), CMP не распознан или захват pagehide недоступен → `inconclusive` | T1_CONSENT_BANNER_BROKEN | § 25 Abs. 1 TDDDG; Art. 7 Abs. 3, Art. 4 Nr. 11 DSGVO | 3а |
| **EMBED-03** (P1) | A, A′, B · сеть, DOM | YouTube (`youtube.com/embed`; `youtube-nocookie.com` с атрибутом `enhancedPrivacyMode`), превью `i.ytimg.com`, Vimeo; тип iframe, player или thumbnail-only | `warning` | thumbnail-only → `warning` с пометкой «Vorschaubild ≠ Wiedergabe». Локальное превью или ссылка → находки нет. Storage → CONSENT-02 | T1_MAPS_BEFORE_CONSENT ⚠ видео ≠ карты | § 25 TDDDG; DSK OH Rn. 74, 123 | 3б |
| **EMBED-04** (P1) | A, A′, B · сеть, DOM (формы) | reCAPTCHA v2/v3/Enterprise (`recaptcha/api.js`, `enterprise.js`, `gstatic.com/recaptcha`), hCaptcha, Turnstile, Friendly Captcha; стадии `loaded`/`executed`; есть ли видимая форма | `warning`: на странице без видимой формы | `info`: на странице с формой (DSK Rn. 74 — спорно). Turnstile как WAF-челлендж → `SCAN-BLOCKED`, не EMBED-04 | T1_OTHER | § 25 Abs. 1 vs Abs. 2 Nr. 2 TDDDG — спорно | 3б |
| **EMBED-05** (P1) | A, A′, B · сеть | Виджеты по каталогу по путям, а не только доменам: Elfsight, Trustindex, Instagram, ProvenExpert, Trustpilot, Calendly, чаты | `warning` | Storage → CONSENT-02. Кэшированные отзывы, общий CDN → находки нет | T1_OTHER | § 25 TDDDG; Art. 26 (Fashion ID) | 3б |
| **CONSENT-06** (P1) | A, B · init-хук `dataLayer.push` до скриптов, команды gtag и consent-API шаблонов, `gcs`/`gcd` хитов, состояние CMP | Default для региона DE (иначе default без `region`); исполненные команды с порядком; сверка «CMP denied — Google получает granted» | `critical`: Google получает granted до клика или после отказа (`gcs=G1x1/G11x` или `gcd` granted по версионированному декодеру). `warning`: default granted без хитов; гонка «хит до default» | Неизвестный формат `gcd` → unknown. GTM template API или custom dataLayer не наблюдаемы → `inconclusive`. Строка в исходнике без исполнения → находки нет | T1_TRACKER_BEFORE_CONSENT ⚠ агрегация? | § 25 TDDDG; Art. 7 DSGVO | 3б |
| **VULN-01** (P1) | A + Stage 2 (`readme.html`, feed) · HTML, заголовки | Отпечатки WP, TYPO3, Joomla, Drupal, Shopware, Contao, Next.js; версия `exact/range/unknown`; advisories WPVulnerability, OSV, GHSA; пересечение с KEV; EOL-мажоры | `critical`: `exact` ∧ affected range ∧ (KEV ∨ pre-auth RCE/SQLi/upload/auth-bypass по advisory). `warning`: прочие CVE при `exact`; EOL-мажор | `range` → ступень ниже. `unknown` → `info` без CVE. Источник недоступен → `inconclusive`. Текст «Datenbank listet …», не «verwundbar» | T1_EXPLOITABLE_CVE (`critical`) / T3_OUTDATED_CVE (остальные) | Art. 32 Abs. 1 lit. b, d; § 19 Abs. 4 TDDDG; KEV — приоритизация, не норма | 3б, последними |
| **VULN-02** (P1) | A (тела скриптов в памяти ≤ 512 KiB) + Stage 2 (`readme.txt`, `style.css` ≤ 20) | Плагины и темы WP по slug и `Stable tag`/`Version:`; JS-библиотеки по экстракторам retire.js (имя, содержимое, хеш); Next.js/Nuxt по runtime-маркерам | как VULN-01; jQuery < 3.5.0 (CVE-2020-11023 в KEV) → `critical` по правилу каталога (вопрос 14) | Только `Stable tag` или `?ver=` → `range`. Одноимённые или bundled-копии → `unknown` | как VULN-01 | как VULN-01 | 3б, последними |
| **MAIL-03** (P1) | DNS | `--dkim-selector`, затем документированные селекторы провайдера по MX, затем generic (граница с «перебором» — вопрос 16); ≤ 25 TXT `<sel>._domainkey`; пустой `p=` = ключ отозван | `info` «unter N geprüften Selektoren nicht gefunden» | `warning`: ключ < 1024 бит; заданного пользователем селектора нет или он отозван. «DKIM fehlt» — никогда | T3_MAIL_UNPROTECTED | как MAIL-01 | 3б |
| **TLS-03** (P1) | A (https-страницы) · CDP `Audits.issueAdded` (MixedContentIssue с `resolutionStatus`), `Network.requestWillBeSent.mixedContentType`, скан DOM и CSS (`src`, `href`, `srcset`, `action`, `url()`) | Четыре факта: небезопасный URL в исходнике → выбран браузером → upgraded или blocked → состоялась ли HTTP-передача. Плюс `ws://` и form action по http | `warning`: active blocked, passive upgrade failed, `form action="http://"` | `info`: passive auto-upgraded. Невыбранный `srcset`, неиспользуемое CSS → находки нет. «Daten übertragen» не пишем | T3_OTHER | Art. 32; § 19 Abs. 4 TDDDG | 3б |
| **TLS-04** (P1) | TLS: 2 handshake (TLS 1.0 и 1.1) с SNI через `EgressPolicy`, только при включённой проверке; план А — сырой ClientHello через `net.Socket`, план Б — `DEFAULT@SECLEVEL=0` | ServerHello с запрошенной версией → протокол принимается; Alert `protocol_version` → не принимается | `warning`: сервер принимает TLS 1.0/1.1 | `handshake_failure` или reset → `inconclusive` «nicht eindeutig». Клиент сам не способен (self-test) → `error` сканера | T3_NO_SECURITY_HEADERS ⚠ код заголовков для версии TLS — подтвердить | BSI TR-02102-2 (2026-01); RFC 8996 | 3б |
| **DNS-01** (P2) | DNS · CAA по дереву до eTLD+1; DS у родителя; DNSSEC только через доверенную валидацию (DoH opt-in) | Подтипы CAA и DNSSEC раздельно | `info`: нет CAA, unsigned | `warning`: bogus при валидирующем резолвере. AD от недоверенного резолвера или SERVFAIL → `error` или indeterminate | `null` (в каталоге нет) | RFC 8659; правовой нормы нет | после |
| **HDR-02** (P2) | `Set-Cookie` главных документов; `Server`, `X-Powered-By`, `X-Generator` | Атрибуты cookies по роли; версии в заголовках идут в VULN как EOL-сигнал | `warning`: сессионная cookie (PHPSESSID, `wordpress_logged_in_*`, `fe_typo_user`…) без Secure или HttpOnly | `info`: нет SameSite; версия в заголовке; прочие cookies | `null` | Art. 32; § 19 Abs. 4 TDDDG | после |
| **ADMIN-01** (P2) | Класс E, opt-in, только при обнаруженном WP · `GET /wp-json/wp/v2/users` (только число), `/?author=1` без редиректа (только факт), `/xmlrpc.php` (405) | Раскрытие пользователей и доступность XML-RPC без попыток входа и вызовов | `warning`: пользователи раскрыты и XML-RPC отвечает | Иначе `info`. «Вход без защиты» пассивно не устанавливается и не утверждается | `null` | Art. 32; Art. 5 Abs. 1 lit. c, f (имена) | после, после правовой оценки заказчика |
| **FILE-01** (P2) | Класс E, opt-in `--exposure-probes` · ≤ 15 фиксированных путей из списка заказчика, soft-404-базлайн, `Range: bytes=0-4095` и abort | Совпадение сигнатуры или магических байт ∧ отличие от базлайна; тело не хранится, секреты не используются | `critical`: сигнатура секретов, VCS-конфига или дампа | `warning`: одиночный `.git/HEAD`, phpinfo, debug.log. `info`: `.DS_Store`. SPA с 200 на всё или WAF → находки нет | `null` (в каталоге «T0» — такого кода нет) | Art. 32, 33/34; для сканера §§ 202a/202c StGB, § 4 GeschGehG | после |
| **SEC-01** (P2) | HTTP · `/.well-known/security.txt`, затем `/security.txt`; RFC 9116 | Наличие файла, `Contact`, `Expires` | `info`: файла нет, `Expires` в прошлом, нет `Contact` | HTML-заглушка → soft-404. Timeout ≠ отсутствие. `mailto:` маскируется | `null` | RFC 9116; правовой нормы нет | после |
| **LEGAL-02** (P2) | Тексты Impressum и DSE из `documents` | Словарь с `validFrom`: TMG → DDG (14.05.2024), RStV → MStV, TTDSG → TDDDG, OS-Plattform (закрыта 20.07.2025), Privacy Shield; исторический контекст исключается | `info` | Цитата об истории закона → находки нет. Выдержки ≤ 200 знаков и не из блока контактов | `null` | § 5 DDG; § 18 MStV; TDDDG; Art. 13 Abs. 1 lit. c | после |
| **BFSG-01** (P2) | Плагин; фаза B (баннер закрыт) · axe-core 4.14 (MPL-2.0) | Теги wcag2a, 2aa, 21aa, 22aa; ≤ 3 страницы; одна находка на правило; `incomplete` отдельно | `info`, `gating: false` | «BFSG-konform» не пишем никогда. Применимость (B2C, Kleinstunternehmen) не определяется | `null` | BFSG + BFSGV, EN 301 549 | после; нужна точка расширения `PageProbe` |
| **PERF-01** (P2) | Плагин; отдельный прогон Lighthouse 13.x | Lab-метрики LCP, CLS, TBT и размеры ресурсов | `info`, `gating: false` всегда | Текст «Laborwert, einmalig», «kein Rechtsbezug» | `null` | Правовой нормы нет | после; `PageProbe` |

**Дедупликация (routing как данные, `data/routing.yaml`).** Одно наблюдение даёт одну гейтящую находку:
- analytics, ads, session-recording, tag-manager, cdn, payment, consent-provider, unknown → CONSENT-01;
- fonts → EMBED-01, maps → EMBED-02, video → EMBED-03, captcha → EMBED-04, widget/social/reviews/chat → EMBED-05.

Независимые оси (не дубли): хранилище — CONSENT-02, сигналы Consent Mode — CONSENT-06, отсутствие баннера — CONSENT-03, поведение после отказа — CONSENT-05. TRACK-01 — связанный инвентарь. В отчёте связанные находки группируются по `serviceId` («Google Analytics 4: CONSENT-01, CONSENT-02, TRACK-01»). Подавить их можно одним правилом по `serviceId`. Смена владельца категории — minor-релиз с разделом «Baseline changes» в CHANGELOG.

---

## 5. Ключевые контракты

### 5.1 Модель результата

- **Отчёт верхнего уровня:** `schemaVersion`, `tool {name, version}`, `ruleset {version (CalVer), rechtsstand, profile: "de-2026"}`, `datasets[]` (имя, дата, sha256, лицензия, `attribution`), `scan`, `checks[]`, `findings[]`, `diagnostics[]`, `evidence[]`, `legalContext`, `summary {counts, exitCode, exitReasons[]}`, `disclaimer`.
- **`scan`:** `status` (`complete / partial / failed`), `target`, `finalUrl`, `startedAt` (UTC; от него отсчитывается монотонное `tMs` в evidence), `durationMs`, `failure {code, message}` при `failed`, `options`, `environment`, `coverage`. В `options`: `failOn`, `strict`, `sandbox`, `timeout`, `lang`, `checks`, `pages`, `baseline`, `suppressionsFile`, `overrides[]` (все переопределения уровней из `rules:`), `proxy {mode}` без учётных данных, `assumeRegion`. В `environment`: UA, движок и версия, headless-режим, sandbox, тип профиля, viewport, `de-DE`, `Europe/Berlin`, `egress {mode, region, source, collectors}` (какие коллекторы шли через прокси, какие напрямую), отключённые фичи Chromium, QUIC выключен, известные пробелы наблюдения, `requestsIssued {navigations, probes, dns, tls}`. В `coverage`: страницы с `planned / observed / evaluated` и причинами пропуска. Блок `environment` отображается в HTML как раздел «Messumgebung».
- **Минимальный отчёт при `failed`:** обязательны только `schemaVersion`, `tool`, `scan {status, target, startedAt, failure}`, `summary {exitCode, exitReasons}` и `disclaimer`. Отчёт пишется в `finally` верхнего уровня с собственным таймаутом. Каждый путь к `2` из таблицы 5.2 проверяется контрактным тестом на валидность по Ajv.
- **`checks[]` (CheckResult):** `id`, `status`, `reason`, `limitations[]`, `coverage`, `durationMs`.
  - `completed` — проверка выполнена.
  - `partial` — выполнена на части данных.
  - `inconclusive` — данных недостаточно для вывода (нераспознанный баннер, бот/гео, неполный документ).
  - `not_applicable` — неприменима целиком (например, VULN-02 без WP-компонентов, JS-библиотек и Next.js/Nuxt; отсутствие одного WP пропускает только WP-ветку).
  - `skipped` — выключена или пропущена по зависимости (например, `tls-blocked`).
  - `error` — сбой исполнения.
  - Статусов `pass` и `fail` нет: «нет находки» ≠ «соответствует».
- **`findings[]`:** `checkId`, `variant`, `variantGroup`, `severity`, `confidence`, `crmCode` (`string` или `null`), `fingerprint`, `subject`, `serviceId?`, `phases[]`, `pages[]`, `trigger?`, `replicated?`, `evidenceIds[]` (≤ 20 и `evidenceTruncated`), `messageId`, `params`, `legalNoteId`, `related[]`, `classification {source, datasetVersion}`, `provider?`, `parent?`, `dpfEntity?`, `suppression?`, `baselineStatus?`. Связи между находками — через общие `evidenceIds` (`evidence[].id` — id наблюдения) и `related[]`; отдельного `observationId` нет.
- **`severity`:** закрытый enum `critical / warning / info`. `info` никогда не гейтит. `critical` — уверенно установленный технический факт класса, приоритетного по утверждённому ruleset; это не констатация нарушения (вопрос 1).
- **`confidence`:** `high / medium / low` — уверенность технического сопоставления, а не вероятность нарушения. В assess действует кэп: `medium` → не выше `warning`, `low` → не выше `info`. После кэпа фильтра по confidence нет.
- **`diagnostics[]`:** `code`, `affects[]` (checkId), `evidenceIds[]`; без severity. Диагностика не гейтит (кроме `--strict`) и в CRM не идёт. Коды: `SCAN-GEO`, `SCAN-BOTMODE`, `SCAN-BLOCKED`, `SCAN-UNREACHABLE`, `SCAN-THROTTLED`, `SCAN-TIMEOUT`, `SCAN-SANDBOX-OFF`, `SCAN-PRIVATE-REQUEST-BLOCKED`. Список кодов открыт: новый код — minor.

### 5.2 `--fail-on` и коды `0/1/2`

`--fail-on critical` (по умолчанию), `warning` или `none`. Порог «достигнут или превышен»: `warning` включает `critical`.

**Учитываемая находка:** не подавлена действующим правилом, не покрыта baseline (или её уровень вырос относительно baseline), `rank(severity) ≥ rank(failOn)`.

**Релевантная проверка:** включена, `gating: true` в ruleset и `maxSeverity ≥ failOn`. `maxSeverity` — статический максимум уровней `variants` после ruleset и пользовательских overrides (`locked`-варианты не поднимаются). Кэп уверенности сюда не входит: у упавшей проверки уверенности нет, кэп применяется только к конкретной находке. При `--fail-on none` релевантных проверок нет.

**Приоритет:** `2 (fatal)` > `1` > `2 (check-error / strict)` > `0`. Политику гейта задают `--fail-on` и `--strict`. На вход гейта влияют также `--baseline`, файл подавлений, `rules:` (overrides), `--checks`, `--timeout` и `--sandbox off` (через `--strict`).

| Ситуация | Статусы | Код |
|---|---|---|
| Учитываемых находок нет; релевантные проверки `completed`, `inconclusive` или `not_applicable` | `complete` | `0` |
| Есть учитываемая находка | `complete` или `partial` | `1`, даже если другие проверки упали; причины — в `exitReasons` |
| Нераспознанный баннер | CONSENT-04 `info` «Banner nicht erkannt», статус `inconclusive`; CONSENT-05 `inconclusive` | не влияет; `2` только при `--strict` и отсутствии `1` |
| Бот- или гео-сигнал | затронутые проверки `inconclusive`, диагностика | не влияет; `--strict` → `2` |
| Ошибка релевантной проверки (исключение в `run`, коллектор не дал артефакт, SERVFAIL или timeout DNS после повтора) | `partial`, `check-error:<id>` | `2`, если нет `1`; при `1` GitHub Action печатает `::warning::` и строку в Summary, GitLab-шаблон — сообщение в stderr и `<error>` в JUnit |
| Ошибка нерелевантной проверки | `partial`, проверка `error` | не влияет |
| Цель недоступна: NXDOMAIN, отказ соединения на 80 и 443, timeout или 5xx навигации стартовой дважды | `failed`, `SCAN-UNREACHABLE` | `2` |
| WAF, челлендж или 403 на стартовой | `failed`, `SCAN-BLOCKED` | `2` |
| Челлендж на подстранице | страница в coverage как «nicht auswertbar» | по прочим правилам |
| Сайт отвечает, сертификат https невалиден | TLS-02 `critical`; браузерные проверки `skipped (tls-blocked)` | `1` (при `--fail-on none` — `0`) |
| 429/503 трижды подряд на пробах; в браузере — 429/503 на навигации или ≥ 3 таких ответа целевого хоста за фазу, после `Retry-After` и одного повтора | `SCAN-THROTTLED`, новые навигации к хосту не начинаются, затронутые проверки `partial` | по прочим правилам |
| Глобальный `--timeout` до завершения фазы A на стартовой | `failed`, `SCAN-TIMEOUT` | `2` (`timeout`) |
| Глобальный `--timeout` после частичного сбора | незавершённые проверки `error(timeout)`, `SCAN-TIMEOUT` | `1` при учитываемой находке; иначе `2`, если незавершённые релевантны; иначе `0` |
| `--sandbox require` (по умолчанию), sandbox не поднялся | `failed` | `2` |
| `--sandbox off` | `SCAN-SANDBOX-OFF` | не влияет; `--strict` → `2` |
| `--strict` и `egress.region: unknown` при включённых CONSENT-проверках | `strict:egress-unverified` | `2`, если нет `1` |
| Неверные аргументы или конфиг, URL не `http(s)`, credentials в URL, браузер не установлен или не стартовал | `failed` | `2`, сообщение в stderr |
| Внутренний сбой, unhandled rejection, OOM, SIGINT/SIGTERM | `failed`; частичный JSON, если успели | `2` |
| Не записан JSON или запрошенный HTML, PDF, JUnit, Summary | уже созданные файлы сохраняются; JSON перезаписывается с окончательным кодом | `2` (`report-write-failed`) |
| `--fail-on none` | порог `1` и релевантность ошибок проверок выключены; `--strict` действует независимо | `0`; `2` при fatal или при strict-причинах |
| Просроченное подавление | находка учитывается, в консоли предупреждение | по порогу |

Коды `exitReasons[]`: `threshold`, `check-error:<id>`, `unreachable`, `blocked`, `timeout`, `sandbox-unavailable`, `invalid-input`, `internal-error`, `report-write-failed`, `strict:inconclusive:<id>`, `strict:sandbox-off`, `strict:egress-unverified`. Находки, собранные до сбоя, сохраняются при любом коде. Мягкий режим GitLab (`allow_failure: exit_codes: [1]`) — только явная документированная опция, а не значение шаблона по умолчанию. Его цена: при наличии находки job проходит и тогда, когда упала релевантная проверка; шаблон печатает все `exitReasons` в stderr. На GitHub мягкий режим — `continue-on-error` с `::warning::` и строкой в Summary.

**Окончательный код.** `gate()` даёт предварительный код до репортёров. JSON пишется первым как страховка, затем работают остальные репортёры; ошибка любого запрошенного репортёра добавляет `report-write-failed` и даёт `2`. После них JSON атомарно перезаписывается (временный файл и rename) с окончательными `summary.exitCode` и `exitReasons`. Код процесса расходится с JSON, только если не удалась сама перезапись; тогда `2` и сообщение в stderr.

**JUnit** (D02). Один `testsuite` на модуль, один `testcase` на проверку. `<failure>` — учитываемые находки (по порогу, с учётом подавлений и baseline); `<error>` — `check-error`; `<skipped>` — `inconclusive`, `not_applicable`, `skipped`; подавленные, известные по baseline и `info`-находки — в `<system-out>`; `<properties>` — `exitCode`, `exitReasons`, `failOn`. Строк `T[0-9]_` нет (5.6).

### 5.3 Evidence

- Evidence лежит в общем массиве `evidence[]`, на каждый элемент ссылаются через `evidenceIds`. Каждый сетевой факт хранится один раз. `evidence.type` — открытый enum.
- **Покрытие требования ТЗ.** ТЗ требует «URL, запрос, cookie, заголовок, DNS-запись» — это закрывают типы `request`, `cookie`, `header` и `dns`.
- **Идентификаторы и время** (общие для всех типов). `id` — id наблюдения, на него ссылаются `evidenceIds`. `tMs` — монотонное время от `scan.startedAt`, одна шкала для всех фаз и коллекторов. `navigationId` и `actionId?` (клик) привязывают факт к навигации и действию; «мс после навигации» и «мс после клика» вычисляются, а не хранятся.
- **`request`:**
  - адрес и ресурс: `url` (очищенный), `method`, `resourceType`, `initiator`;
  - контекст: `phase`, `page`, `tMs`, `navigationId`, `actionId?`, `frameId`, `parentRequestId?`. Связь frame → SW → upstream: запрос страницы, обслуженный SW, и upstream-запрос самого SW — разные наблюдения со ссылкой друг на друга;
  - `delivery`: `attempted / blocked-by-browser / sent` — ушёл ли запрос в сеть;
  - `result`: `response {status} / failed {errorText} / aborted / none`;
  - `provenance`: `network / service-worker / http-cache / memory-cache`;
  - `features` — безопасные признаки, извлечённые в коллекторе до удаления значений (D05): `identifier {kind: stored-match / persistent-param / user-supplied / per-load / none, param?}` и `matchesStoredIdentifier` (сравнение с трекинговыми cookie и storage через одноразовый HMAC в памяти), `eventType`, `consentSignal` (`gcs`, декодированный `gcd`), `parserVersion`, `observationSource` (`playwright / cdp / proxy-log`); значения параметров не сохраняются;
  - сторона: `thirdPartyETLD1`, `serviceId?`;
  - `connectedIp {value, origin: resolvedLocally / upstream / unknown}`; за upstream-прокси локальный DNS не выдаётся за peer, а адрес назначения проверен `EgressPolicy` (5.7).
- **`cookie` и `storage`:**
  - идентификация: `name`, `domain` (или `first-party`), `path`, `partitionKey`;
  - атрибуты: `secure`, `httpOnly`, `sameSite`, `lifetime` (session или persistent, дни), `length`;
  - происхождение: `setter` (`http-response` или `script`), `setterHost`;
  - `state`: `attempted / accepted / rejected / sent`; плюс `phase`, `tMs`, `navigationId`, `actionId?`;
  - значений и хешей нет.
- **`header`:** `url`, `name`, `present`; значение — только для заголовков безопасности.
- **`dns`:**
  - запрос и ответ: `qname`, `type`, `rcode` (`NOERROR / NXDOMAIN / NODATA / SERVFAIL / TIMEOUT`), записи с замаскированным `mailto:`;
  - контекст: резолвер, время, путь Tree Walk.
- **`tls`:** `host` или `ipTarget`, `ip`, `family`, `lifetimeDays`, `protocol`, `issuer`, `san`, `notBefore`, `notAfter`, `chainComplete`, `authorizationError`, `trustStore`.
- **`cmp`:**
  - распознавание: `cmpId`, `version`, `recognitionConfidence`;
  - кнопки: `buttons[{role, name, vendorRole?, box, visibleAtFirstScreen, actionableAtFirstScreen, contrast}]` — факты адаптера; `kind` и `kindConfidence` — результат `classifyFirstLayer`, в evidence пишутся с версией лексикона;
  - блокировка: `blocking {overlay, scrollLock, inert, coveredRatio, method}`;
  - контекст: `viewport`, `plan.click`, производное `acceptAvailableAtFirstLayer`.
- **`consent-state`:**
  - `source` (`api / cookie / tcf`), `ready` (`stub / loading / ready`);
  - `categories` (`denied / granted / partial / unknown`);
  - `origin` (`default / stored / action / special-branch`), `scope`;
  - `decision {responded: true / false / unknown, method: explicit / implied / unknown}` — был ли ответ пользователя по данным CMP (например, Cookiebot `hasResponse`, `declined`, `consent.method`). `default` без ответа отказом не считается.
- **`document`:** `url`, `kind`, `lang`, `parts[]` с происхождением, `complete`, `errors[]`, `sha256`.
- **`text-match`:** `documentId`, `section`, `quote` (≤ 200 знаков), `matchLevel`, `negation`.
- **`component`:** `product`, `version`, `versionConfidence` (`exact / range / unknown`), `source`.
- **`mixed-content`:** `sourceUrl`, `selected`, `resolution` (`upgraded / blocked / loaded`), `transferred`.
- **`screenshot`:** путь к файлу артефакта, `sha256`, `crop {box, viewport}`; в JSON нет данных изображения. Если снимка нет — limitation `screenshot-skipped` с причиной.
- **Редактирование.** Выполняется в коллекторе до снимка, логов, исключений и артефактов (D20). L0-тест ищет значения cookies и `mailto:` в фикстурах вывода.

### 5.4 Fingerprint, подавления, baseline

- `fingerprint = "sha256:" + hex(sha256(JCS({v: 1, checkId, variantGroup, subject})))`.
- **Что входит в `subject`:**

  | Проверки | `subject` |
  |---|---|
  | CONSENT-01, CONSENT-05, CONSENT-06, TRACK-01, EMBED-*, PRIV-01 | `serviceId` (неизвестные хосты — `unknown:<eTLD+1 третьего лица>`) |
  | CONSENT-02, HDR-02 | `name` + (`first-party` или eTLD+1 третьего лица) + `path` + partitioned |
  | HDR-01 | имя заголовка |
  | MAIL-*, DNS-01 | вид записи |
  | LEGAL-01 | тип документа |
  | PRIV-02 | `claimId` + `serviceId` |
  | CONSENT-03, CONSENT-04 | `consent-ui` |
  | VULN | `product` + CVE |
  | FILE-01 | путь |
  | TLS-01 | `http-entry:` + роль хоста (`final` или `pair` — второй из пары www/apex) |
  | TLS-02 | `certificate:` + роль хоста |
  | TLS-03 | `resourceType` + (`first-party` или eTLD+1 третьего лица) |
  | TLS-04 | версия протокола + роль хоста |
  | SEC-01 | `security.txt` |
  | LEGAL-02 | id устаревшего термина |
  | ADMIN-01 | endpoint |
  | BFSG-01 | id правила axe |
  | PERF-01 | метрика |

- **Что не входит:** хост цели, страницы, фаза, время, query, значения, текст сообщения, severity. Поэтому TLS-находки различаются ролью хоста, а не его именем.
- **Подавления** — файл `.dsgvo-check/suppressions.yaml` с полем `version: 1`.
  - В каждой записи обязательны `reason` и `expires` (дата), `owner` — по желанию.
  - Матчеры: `fingerprint`, `checkId` (glob, в том числе `CHECK.variant`), `serviceId`; рекомендуемый — `serviceId`.
  - Подавленная находка остаётся в отчёте с флагом. Просроченное правило снова учитывается и выводит предупреждение.
  - Подавить нельзя `error`, `inconclusive`, диагностику и неполное покрытие.
- **Baseline.**
  - Создаётся командой `dsgvo-check baseline create report.json`. Файл с полем `version: 1` хранит `fingerprint`, `severity` и `fingerprintVersion`.
  - При `--baseline` гейтят новые отпечатки и отпечатки с выросшим уровнем.
  - В 1.0 `fingerprintVersion` = 1; baseline с другой версией — ошибка с понятным сообщением. Команда `baseline migrate` появится вместе с `fingerprintVersion` 2 (бэклог).
  - Канарейка baseline сама не обновляет.
- **Конфиг** `.dsgvo-check.yaml` (поле `version: 1`):
  - `pages:` закрепляет выборку страниц.
  - `rules:` переопределяет уровень на уровне варианта (`EMBED-01.fonts-loaded`) или всей проверки. Переопределение всей проверки не поднимает её `info`-варианты.
  - Варианты с `locked: true` в ruleset (`CONSENT-04.banner-not-recognized`, `CONSENT-04.cmp-not-supported`) не переопределяются ни на каком уровне: такое правило — ошибка конфига (`invalid-input`, код `2`). Инвариант проверяют assess, схема конфига и L0-тест.
  - Все переопределения видны в `scan.options.overrides`.

### 5.5 Правило «нераспознанный баннер → info»

- CONSENT-04 уровня `warning` или `critical` выдают только собственные адаптеры семи CMP при распознавании `high` (≥ 2 независимых признака) и однозначной классификации кнопок первого экрана.
- Эвристика, autoconsent, версия CMP вне известного диапазона или `medium` дают только находку CONSENT-04 с вариантом `banner-not-recognized` (или `cmp-not-supported` с именем CMP). Оба варианта `locked`: их уровень `info` и `gating: false` не меняют ни ruleset, ни overrides (5.4).
- Параметры такой находки: уровень `info`, текст «Banner nicht erkannt», статус проверки `inconclusive`, `crmCode: null`, в CRM не экспортируется.
- В evidence — измеренные факты для ручной проверки: кнопки, тексты, блокировка; скриншот области — по правилу D20 (однозначный контейнер кандидата ≤ 50 % viewport, иначе без снимка).
- Зависимые проверки (CONSENT-05, выводы PRIV-02 о фазе B) получают `inconclusive`. Документы от этого не зависят: DSE извлекается в фазе A, PRIV-01 и LEGAL-01 работают (D15).
- На код возврата это не влияет; исключение — `--strict`.
- Вердикт по эвристике в 1.0 не включается. Флаг возможен позже, только после precision ≥ 0,95 на размеченном корпусе.

### 5.6 `crmCode` и версии

- **Где задаётся.** `crmCode` берётся из маппинга `(checkId, variant)` в `data/crm/mapping.yaml`, а не из поля проверки: у VULN два кода. Строки — как в каталоге.
- **Когда `null`.** Для P2 до утверждения справочника, для `banner-not-recognized` и для вариантов, которые заказчик не сопоставил.
- **Где выводится.** Только в JSON. В консоли, HTML, PDF, JUnit и Summary строк `T[0-9]_` нет — это проверяет L0-тест. В описании схемы поле помечено как «interne Taxonomie des Auftraggebers, keine rechtliche Einordnung».
- **Смена маппинга** — minor-релиз с записью в CHANGELOG.
- **Версии** (ровно пять осей):
  1. версия пакета — semver; в неё входят каталог, CMP-данные, ruleset и тексты;
  2. `schemaVersion` — semver;
  3. `ruleset.version` (в тексте также «rulesetVersion»; в JSON это одно поле) — CalVer, плюс `ruleset.rechtsstand`;
  4. `datasets[]` — внешние снапшоты: имя, дата, sha256, лицензия, атрибуция, время онлайн-запроса;
  5. `fingerprintVersion`.

  `logicVersion` по проверкам нет.
- **Правила semver схемы.**
  - Minor: новое необязательное поле, новый `checkId`, `variant`, `evidence.type` или код диагностики.
  - Major: удаление или переименование, смена типа, новое значение закрытого enum (`severity`, `status`), смена семантики кодов возврата.
  - Публикуемая схема не закрывает `additionalProperties`.

### 5.7 Сетевая граница (`EgressPolicy`)

- **Один модуль на все соединения с сайтом.** `EgressPolicy` разрешает имя своим резолвером (все A и AAAA), проверяет **каждый** адрес (loopback, private, link-local, metadata, IPv4-mapped IPv6, специальные диапазоны) и открывает соединение только с проверенным адресом, без повторного разрешения. Его используют in-process HTTP/CONNECT-прокси браузера, undici (инжектируемые `connect` и `lookup`), `node:tls` в TLS-02 и `net.Socket` в TLS-04. Тот же инжектируемый `lookup` подменяет хосты в тестах L2.
- **DNS-коллектор** (MAIL-*, DNS-01) с сайтом не соединяется: он шлёт запросы к системному резолверу или к `--resolver` напрямую, в том числе при `--proxy`. Это пишется в `scan.environment.egress.collectors` и в Messumgebung.
- **`--proxy` в 1.0** — только `http://` (HTTP CONNECT) для браузера, undici и TLS-коллекторов. SOCKS5 — бэклог. Учётные данные прокси в отчёт и логи не попадают.
- **Граница SSRF за upstream-прокси.** `EgressPolicy` разрешает и проверяет адрес локально, upstream получает `CONNECT <проверенный IP>:<port>`; SNI и `Host` идут внутри туннеля. Гарантия: адрес назначения каждого соединения прошёл нашу проверку. Сеть, ACL и NAT самого upstream — вне границы, README говорит это прямо. Цена: CDN-узел выбирается по локальному резолверу, а не по региону выхода (limitation в Messumgebung; на гео-логику CMP по IP клиента это не влияет). Upstream, который не принимает IP-литерал в CONNECT, даёт ошибку конфигурации без фолбэка на имя хоста (⚠ С5).
- **Модель угроз** остаётся честной: in-process прокси — политика для неуязвлённого браузера; принудительная граница из двух контейнеров — бэклог (D25).

### 5.8 Отчёты: CSP и уведомления о лицензиях

- **CSP HTML-отчёта** (одна строка `<meta http-equiv>` в самом файле): `default-src 'none'; img-src data:; style-src 'sha256-<хеш единственного блока style>'; base-uri 'none'; form-action 'none'`. `default-src 'none'` служит fallback для `img-src` и `style-src`, поэтому без них отчёт теряет скриншоты и стили. Атрибутов `style=` в разметке нет; `'unsafe-inline'` для стилей допустим, только если хеш технически невозможен, и это фиксируется в ADR. JS и сеть по-прежнему запрещены. L2-тест проверяет «ноль сети» и то, что скриншоты и стили отображаются.
- **`THIRD_PARTY_NOTICES`** лежит в npm-пакете и в OCI-образе: лицензии всех распространяемых зависимостей и данных; для `@duckduckgo/autoconsent` (MPL-2.0) — текст лицензии и ссылка на исходный код точной версии; для GHSA — атрибуция по CC BY 4.0; NOTICE-файлы Apache-зависимостей. Немодифицированность MPL-зависимости обязанностей распространителя не снимает. L0-проверка лицензий сверяет файл с деревом зависимостей и `datasets.lock.json`.
- **Атрибуция в отчёте.** У каждого элемента `datasets[]` есть `attribution`; HTML-футер «Datensätze und Attribution» выводит атрибуции всех CC BY-источников, использованных в скане.

---

## 6. Ошибки, найденные в ходе консенсуса

### 6.1 В предложениях раунда 2

| # | Где | В чём ошибка | Исправление | Кто нашёл |
|---|---|---|---|---|
| 1 | Все четыре -П | Решение CONSENT-04 (классификация кнопок, блокировка) принимается в коллекторе; оно вне L1 и вне повтора по снимку | `extract → CmpFacts` плюс чистая `classifyFirstLayer`, `plan.click` | Opus-К §4.3 |
| 2 | Все четыре -П | Нет статического объявления `variants`: нельзя вычислить `maxSeverity` и проверить полноту текстов, ruleset и `crmCode` | `variants` в `CheckDefinition` | Opus-К §4.4 |
| 3 | Все четыре -П | Хост цели (eTLD+1) в fingerprint: на preview-деплоях baseline не совпадает | Ключ без хоста (D21) | Opus-К §4.5 |
| 4 | Все четыре -П | Нет минимальной валидной схемы отчёта при отказе | Дискриминатор `failed` (5.1) | Opus-К §4.8 |
| 5 | Все четыре -П | `crmCode` («MISLEADING», «EXPLOITABLE», «BROKEN») не запрещён в человекочитаемых отчётах — это правовые оценки | Только JSON, L0-тест | Fable-К §4.1 |
| 6 | Все четыре -П | Не редактируются `rua/ruf=mailto:`, `Contact: mailto:` в `security.txt`, имена из `/?author=1` и блок контактов Impressum | Маскирование (D20) | Fable-К §4.3 |
| 7 | Все четыре -П | «preConsent» — название фазы вместо модели состояния; `false` из API-стаба принимается за отказ | Поля действие/состояние/происхождение/готовность/scope (5.3) | Sol-К §4.1 |
| 8 | Все четыре -П | У пользовательских файлов (конфиг, suppressions, baseline) нет версии | `version: 1` и миграции | Opus-К §4.7 |
| 9 | Opus-П, Fable-П | «Empfänger: Google LLC (US)»: Vertragspartner EWR-Kunden для GA — Google Ireland Ltd.; DPF ≠ страновая адекватность | `provider/parent/dpfEntity` (D16) | Fable-К §2.1–2.2 |
| 10 | Opus-П, Fable-П | Публичная витрина на GitHub Pages грузит реальные Google Fonts без Impressum и Datenschutzerklärung — проект сам делает то, что ловит | Имитатор-поддомен; реальные третьи стороны только в CI-job; Impressum/DSE домена — этап 2 | Fable-К §4.5 |
| 11 | Opus-П, Fable-П | Стоп-слова только для `de` | de и en | Fable-К §2.1 |
| 12 | Opus-П, Fable-П | CONSENT-05 зависит от «верифицированного отказа», а верификация включает отсутствие трекинга — главный кейс недостижим | Отказ подтверждается по состоянию CMP | Terra-К (Opus №6, Fable №5) |
| 13 | Opus-П | Классификация (`derive`) запекается в снимок: `--from-artifacts` с новым каталогом даёт старый результат, фикстуры устаревают | Сырой снимок и derive при оценке | Opus-К §2.1 |
| 14 | Opus-П | LEGAL-01 «сам находит DSE для PRIV» — зависимость проверки от проверки | Раздел `documents` в коллекторе | Opus-К §2.1 |
| 15 | Opus-П | «CMP-скрипта нет → гео-таргетинг невозможен» | Условие удалено (D11) | Sol-К |
| 16 | Opus-П | Consent-cookie без клика — общий признак бот-режима | Только прямые сигналы | Sol-К |
| 17 | Opus-П | `UC_UI.areAllConsentsAccepted() === false` как подтверждение отказа | Готовность CMP и `denied` по всем необязательным категориям | Sol-К |
| 18 | Opus-П | `critical` за «хит с событием» при обещанном `warning` для cookieless pings | Нужен устойчивый идентификатор | Sol-К |
| 19 | Opus-П | Исключение всех ответов на запросы, начатые до клика, включая Set-Cookie, принятый после отказа | Раздельные события request-start, response и storage-write | Sol-К |
| 20 | Opus-П | HAR с `content: 'omit'` назван очищенным; headers и cookies он не чистит | HAR выключен; sanitizer до любого включения | Sol-К |
| 21 | Opus-П | Селектор Google `google` назван фиксированным (Google допускает свой префикс) | MAIL-03 без `warning` по провайдеру | Sol-К |
| 22 | Opus-П | «SARIF и GitLab CQ требуют путь и строку» — для SARIF неверно | Откладываем по иной причине (D02) | Sol-К, Terra-К |
| 23 | Opus-П | `frame-ancestors` в meta-CSP засчитывается как защита | Не засчитывать | Terra-К, Sol-К |
| 24 | Opus-П | Нерепликация в B понижает уверенность уже записанного запроса | Понижается утверждение о регулярности (`replicated: false`), не уровень | Sol-К |
| 25 | Opus-П | Ссылка на RDG и BGH Smartlaw как основание запрета правовой оценки (Smartlaw признал генератор **не** Rechtsdienstleistung) | Основание — ТЗ и § 824 BGB; RDG касается сервиса заказчика | Fable-К |
| 26 | Opus-П | `allow_failure: exit_codes: [1]` в ADR GitLab-шаблона: CI не падает по порогу | Только явный мягкий режим | Terra-К |
| 27 | Opus-П | UrhG § 51 представлен как достаточное основание скриншотов | ⚠, вопрос 11 | Terra-К |
| 28 | Opus-П | «Цена + Abo» целиком исключает CONSENT-04 | `pur-abo` — флаг, не выключатель | Sol-К |
| 29 | Fable-П | SCAN-* — находки уровня `warning`, которые роняют `--fail-on warning` из-за проблем измерения | `diagnostics[]` | Opus-К, Fable-К |
| 30 | Fable-П | `crmCode` на уровне проверки, а у VULN два кода | Маппинг по `(checkId, variant)` | Opus-К |
| 31 | Fable-П | Исключение в `run` → код по порогу: зелёный CI при упавшей P0 | D03 | Opus-К |
| 32 | Fable-П | Token-bucket 2 запр./с на браузерный трафик в CONNECT-прокси: без MITM туннель не раскрывает HTTP-запросы (HTTP/2 multiplexing), а лимит искажает измеряемое | Лимит только на навигации, счётчик в браузере | Opus-К, Sol-К, Terra-К |
| 33 | Fable-П | Заголовок `X-Dsgvo-Check` на всех запросах: CORS-preflight (⚠), через CONNECT в HTTPS не добавить, утечка третьим лицам, буквы ТЗ не выполняет | Отклонён (D10) | Opus-К, Terra-К |
| 34 | Fable-П | Digest образа через `extra-files` в Release PR — до сборки он неизвестен | Job после мержа (D24) | Opus-К |
| 35 | Fable-П | `valueSha256` cookie — связуемый псевдоним, дисклеймер становится ложным | Без хешей | Fable-К, Opus-К, Terra-К |
| 36 | Fable-П | «Не грузится в C, а в B грузится — ошибка классификации, не находка» | Факт B сохраняется, расхождение уходит на разбор | Sol-К |
| 37 | Fable-П | Если UI не закрылся, CONSENT-05 обрывается | Отказ — по состоянию, UI-переход пишется отдельно | Sol-К |
| 38 | Fable-П | `#` и `javascript:` → `link-broken`, хотя ссылка может открывать рабочую модалку | `unresolved` и проверка модалки | Sol-К |
| 39 | Fable-П | CONSENT-01 `critical` по запросу в состоянии `attempted` | Delivery-state входит в условие уровня | Sol-К |
| 40 | Fable-П | `region` в Consent Mode без DE считается гео-сигналом; `--require-eu-egress` выполняется прокси или `--assume-region` | Не сигнал; `region: asserted` с происхождением | Sol-К, Terra-К |
| 41 | Fable-П | Baseline учитывает только новые отпечатки — рост уровня скрыт | Baseline хранит severity | Sol-К |
| 42 | Fable-П | ADMIN-01: «базовый профиль (3 GET)» и одновременно opt-in | Класс E, opt-in | Sol-К |
| 43 | Fable-П | Отрицание по окну ±80 символов | Привязка к субъекту и предикату | Sol-К |
| 44 | Fable-П | Порог «< 2 000 символов» как признак неполноты DSE | Manifest полноты | Sol-К |
| 45 | Fable-П | § 303b StGB как основание rate limit (норма требует Nachteilszufügungsabsicht) | § 823 BGB, BGH I ZR 224/12 | Fable-К |
| 46 | Fable-П | Формулировка «Text veraltet» для reCAPTCHA: роль оператора сканеру не видна | `info` «Rollenänderung zum 02.04.2026 – Formulierung prüfen» | Fable-К |
| 47 | Fable-П | `implied-consent` отнесён к CONSENT-03 (баннер есть, согласие без действия) | CONSENT-04 `consent-without-action` | Fable-К |
| 48 | Fable-П | «DE/EU egress» вместо EWR | EWR | Fable-К, Sol-К |
| 49 | Fable-П | P2 «целиком вне MVP», но FILE-01 на этапе 3 при наличии бюджета | FILE-01 вне релиза | Terra-К |
| 50 | Sol-П | Оценка 54–75 чд занижена примерно на 30–40 % | D26 | Opus-К |
| 51 | Sol-П | Маршрут в fingerprint → мигание baseline | Без страниц | Opus-К |
| 52 | Sol-П | Пример каталога «Next.js 15.2.8» объявлен неверным, хотя каталог CVE не называет | Запросить CVE ID (вопрос 14) | Opus-К |
| 53 | Sol-П | Обязательные поля схемы не позволяют валидный отчёт при раннем отказе | Схема `failed` | Opus-К |
| 54 | Sol-П | «Официальный CI-профиль запрещает обход broker» — в одном контейнере невыполнимо | Бэклог: два контейнера | Opus-К |
| 55 | Sol-П | Actionability не отделена от первого экрана: `locator.click()` прокручивает | Снимок геометрии и hit-testing до действия | Sol-К |
| 56 | Sol-П, Terra-П | Не выбран тулчейн (TS-политика, менеджер пакетов, runner, linter, сборщик) | D07 | Sol-К, Terra-К |
| 57 | Sol-П, Terra-П | Последовательный профиль A описан как независимый «первый визит» на каждой странице | «Первый визит» только для стартовой | Terra-К |
| 58 | Sol-П | Автоскачивание Chromium при первом запуске противоречит офлайн-режиму | Явная `install` | Terra-К |
| 59 | Sol-П | Отозвано в раунде 4б. Fable-К счёл месяц публикации RFC 9989 неподтверждённым, но в заголовке RFC стоит «Published: May 2026»: утверждение Sol-П было верным | Май 2026 — факт (раздел 7) | Fable-К (ошибочно); исправил Sol, раунд 4б |
| 60 | Terra-П | Docker-action исполняется от root → Chromium без sandbox; противоречит собственному «non-root, sandbox» | Composite и `docker run` (D24) | Opus-К, Fable-К, Sol-К, Terra-К |
| 61 | Terra-П | 180 с и 600 запросов при одинаковой выборке A/B/C — на WP-сайтах сбор обрывается | D08, D09 | Opus-К, Sol-К |
| 62 | Terra-П | Нет центрального assess: severity назначается в 33 модулях | assess по ruleset | Opus-К |
| 63 | Terra-П | В браузере UA сканера без Chrome-UA: UA-сниффинг и бот-режим почти всех CMP | Chrome UA и токен | Opus-К |
| 64 | Terra-П | VULN без WPVulnerability: в OSV нет экосистемы WordPress → VULN-02 почти пуст | WPVulnerability (D17) | Opus-К |
| 65 | Terra-П | CONSENT-02 по начальному и конечному снимкам теряет транзиентные JS-cookies | Хук `document.cookie`/CookieStore | Sol-К |
| 66 | Terra-П | CONSENT-03 при «известных сторонних сервисах» — слишком широко | Предикат операции, требующей согласия | Sol-К |
| 67 | Terra-П | «Новые enum — как неизвестные» строгая схема не обеспечивает | Открытые строки с реестром; закрытые enum — major | Sol-К |
| 68 | Terra-П | DSE извлекается только из same-origin iframe | Cross-origin frames через Playwright | Sol-К |
| 69 | Terra-П | Репортеры работают до вычисления exit-кода | `gate()` до сериализации | Terra-К |
| 70 | Terra-П | «Запрет IPv6» целиком — IPv6-only сайты не сканируются | Запрет только специальных диапазонов | Terra-К |
| 71 | Terra-П | «Изменённые MPL-файлы autoconsent» противоречит «без модификаций» | Без модификаций | Fable-К |
| 72 | Terra-П | Дисклеймер неполон; нет модели третьих стран и правовой рамки инструмента | legal-basis-map §3.3; D16; ADR пассивности | Fable-К |
| 73 | Terra-П | TLS-02 `warning` при ≤ 30 днях регулярно отмечает нормально обновляемые сертификаты | Порог относительно срока действия (D19). В раунде 4б он заменил абсолютные 14/30 дней: они давали вечный `warning` на 6-дневных сертификатах | Sol-К; Fable (4б) |

### 6.2 В ресёрче раунда 1

| # | Где | В чём ошибка | Исправление | Кто нашёл |
|---|---|---|---|---|
| 74 | legal-basis-map | BSI TR-02102-2 указан как «2024-1» | 2026-01 (TLS 1.2 до конца 2031, TLS 1.0/1.1 не рекомендованы) | R1-полнота |
| 75 | engineering | `newContext()` на скан (ведёт себя как Incognito, без preconnect); headless shell по умолчанию (утечка `HeadlessChrome` в Sec-CH-UA) | Persistent-профиль на фазу; CfT new headless — чтобы после override UA `Sec-CH-UA` не содержал `HeadlessChrome`. Сам UA содержит `HeadlessChrome` в обоих режимах, override нужен всегда (D10; уточнено в раунде 4б) | R1-полнота, Opus-П; Fable, Sol (4б) |
| 76 | engineering | Рекомендованный формат UA распознаётся `isbot` как бот | D10 и детектор | R1-полнота |
| 77 | engineering | SSRF через `context.route` — отключает HTTP-кэш, оставляет гонку DNS | Egress-прокси | R1-полнота, Opus-П |
| 78 | engineering | `engines >=22.12` при undici 8 (нужно `>=22.19`) | Node ≥ 24 | R1-полнота |
| 79 | engineering | Статусы `pass/fail`; `defaultSeverity: critical` для EMBED-01 в коде; флаг `--include-cookie-values` | Статусы покрытия; уровни в ruleset, EMBED-01 `warning`; флаг удалён | R1-полнота, Opus-П |
| 80 | engineering | Любая ошибка проверки → `2` | D03 | R1-полнота, Opus-П |
| 81 | engineering | Digest образа через `extra-files` release-please | Job после мержа | Opus-П, Opus-К |
| 82 | http-dns-tls-mail | FILE-01 включён по умолчанию (`--no-files`), ~30 путей | Opt-in класса E, ≤ 15 путей | R1-полнота, Opus-П |
| 83 | http-dns-tls-mail | MAIL-03 `warning` для IONOS и Strato (у Strato только форумы) | `info` | R1-полнота, Sol-К |
| 84 | http-dns-tls-mail | DMARC Tree Walk со стопом на eTLD+1 — неполная реализация RFC 9989 (PSD) | Полный Tree Walk | Sol-П, Sol-К |
| 85 | browser-automation | CONSENT-04 по эвристике при score ≥ 0,8 — противоречит ТЗ | Эвристика только `info` | Opus-П |
| 86 | browser-automation | Бот- и гео-режим понижаются до `warning` (роняет `--fail-on warning`) | `inconclusive` и диагностика | Opus-П |
| 87 | browser-automation | «881 правило autoconsent»; SW-события «с Playwright 1.57» | 913 правил; версию не указывать | R1-полнота |
| 88 | prior-art | autoconsent «для detect и opt-out»; Consent-O-Matic «206 правил» | Только детект; 204 правила | Opus-П, R1-полнота |
| 89 | regulatory | EuGH C-526/24 помечен ✅ по PM 38/26, а ссылка отдаёт 404 | Раунд 4б: PM 38/26 от 19.03.2026 доступен по `curia.europa.eu/site/upload/docs/application/pdf/2026-03/cp260038en.pdf`. Отметка ✅ была верной, неверной была ссылка | R1-полнота; Sol (4б) |
| 90 | red-team Terra (R1) | Docker-action для GitHub | Composite | Opus-П |

### 6.3 В каталоге и ТЗ

| # | Где | В чём ошибка | Исправление | Кто нашёл |
|---|---|---|---|---|
| 91 | Каталог, EMBED-03 | `crmCode` T1_MAPS_BEFORE_CONSENT у видео | Вопрос 6: отдельный код или подтверждение агрегации | R1-полнота, Fable-П, Opus-П |
| 92 | Каталог, CONSENT-06 | `crmCode` T1_TRACKER_BEFORE_CONSENT (агрегация или ошибка) | Вопрос 6 | R1-полнота |
| 93 | Каталог, P2 | Нет `crmCode`, хотя ТЗ требует его в JSON; у FILE-01 «T0» — такого кода нет | `null` до справочника (вопрос 6) | R1-ТЗ, R1-полнота |
| 94 | Каталог, VULN-02 | «Next.js 15.2.8 с обходом авторизации middleware»: если имелся в виду CVE-2025-29927, ветка 15.x исправлена в 15.2.3 | CVE ID у заказчика (вопрос 14) | R1-ТЗ (Sol), подтвердил Fable-К |
| 95 | Каталог, MAIL-02 | `~all` трактуется как дефект без учёта DMARC (BSI TR-03182 допускает SoftFail) | Матрица с DMARC | R1-сводка, Opus-П, Fable-П |
| 96 | ТЗ | «2 — сканер сам упал» не покрывает недоступную цель, WAF, частичный обход | `2` для невозможного скана (вопрос 2) | R1-ТЗ, R1-полнота |
| 97 | ТЗ | «Честный UA со ссылкой на репозиторий» конфликтует с бот-режимом CMP (RCB `accept-all-for-bots`) | Детектор; вопрос 3 | R1 browser-automation, R1-полнота |
| 98 | ТЗ | 10 сайтов и тексты «к этапу 3» — поздно для калибровки UA, профиля, окна тишины и адаптеров | К концу этапа 1 (вопрос 5) | R1-ТЗ, R1-полнота, Opus-П |
| 99 | Идея и ТЗ | «Доступны ли с каждой страницы» при выборке страниц; «нарушения DSGVO», «не-необходимые», коды «EXPLOITABLE/MISLEADING» уже содержат оценку | «auf n von m geprüften Seiten»; формулировки наблюдений; `crmCode` только в JSON | R1-ТЗ, Fable-К |

### 6.4 В итоге консенсуса (найдено верификацией, раунд 4б)

Полный список — в [`round-4/errata.md`](round-4/errata.md): 61 находка Fable 5.1 и GPT-6.1-Sol, приняты 57 (7 частично), отклонены 2, вынесены заказчику 2. Самые тяжёлые и уже исправленные выше:
- контракт адаптера CMP возвращал решение в коллектор, повторяя ошибку №1 (D12);
- `blocking-no-reject` давал `critical` без возможности согласиться на первом уровне, а override мог поднять `banner-not-recognized` (D13, 5.4);
- `--sandbox require` не согласован с тремя входами ТЗ и не переведён в `chromiumSandbox: true` (D25, вопрос 8);
- `--proxy` «на все коллекторы» неисполним, а граница SSRF за upstream-прокси была заявлена шире, чем есть (5.7);
- безопасные признаки, модель запроса, время и связи наблюдений не были замкнуты в контракте evidence (5.3);
- таблица гейта противоречила себе (`none × strict`, таймаут, окончательный код после репортёров) (5.2);
- уровни согласия D03, D06, D08, D10, D13, D14, D15, D18, D26, D27 переданы неточно (раздел 2, §3).

---

## 7. Непроверенные факты

| # | Утверждение | Почему важно | Как проверить | До какого этапа |
|---|---|---|---|---|
| 1 | Статически (регулярки из исходников, browser-automation §3.2) буквальный UA ловят только `isbot` и RCB; у RCB бот-режим подтверждён исходником. Cookiebot `isSpider`, Complianz `cmplz_is_bot` и Borlabs 3.5 `isBot` его не ловят, пока в UA нет `bot`, `crawler`, `spider`, `robot`. В рантайме не подтверждено; эффект `isUserBot()` у Usercentrics, CCM19, CookieHub и лениво подгружаемые чанки диалогов не проверены | Решает вопрос 3 и долю `inconclusive` | Спайк С1: рантайм-подтверждение трёх профилей UA на CMP-лаборатории, 7 CMP | До этапа 1 |
| 2 | Chromium sandbox поднимается в GitHub hosted runner (composite с seccomp-профилем Playwright) и на GitLab.com `saas-linux-*` (privileged по документации). Дефолтный seccomp Docker разрешает `clone` с `CLONE_NEWUSER` и `unshare --user`, но без `CAP_SYS_ADMIN` блокирует прочие `CLONE_NEW*` (PID, NET), поэтому namespace-sandbox Chromium в голом `docker run` не стартует (эксперимент ресёрча §10). Профиль Playwright их разрешает, но в OrbStack/arm64 контейнер с ним не запустился. На хостах Ubuntu ≥ 23.10 AppArmor `apparmor_restrict_unprivileged_userns` может давать «No usable sandbox» у Chrome for Testing; поведение образа GitHub `ubuntu-24.04` и профиля `docker-default` не проверено | Default `--sandbox require` (D25), вопрос 8 | Спайк С3 на трёх входах ТЗ (§3 D26) | До этапа 1 (решение), до этапа 2 (шаблоны) |
| 3 | Persistent-профиль ведёт себя как обычный визит (preconnect), а `newContext` — как Incognito; один эксперимент R1 | ADR профиля | Спайк С2 на сайтах вендоров CMP | До этапа 1 |
| 4 | `proxy-chain` (Apache-2.0) позволяет свой `lookup` для проверки IP при соединении; HTTP/2 через CONNECT, preconnect виден как CONNECT; флаг блокирует non-proxied UDP у WebRTC | Egress-прокси (D25) | Спайк С5: прототип и исходники | До этапа 1 |
| 5 | Захват `pagehide`/`keepalive`-beacons и SW-запросов (граф frame → SW → upstream) на Chromium 156 через CDP auto-attach | Полнота CONSENT-05 | Спайк С7 и фикстуры с журналом принимающего сервера | До начала CONSENT-05 (этап 3а); до этого — limitation в Messumgebung |
| 6 | Сочетание TS 7.0 (declaration emit), Biome 2.6, oxlint-tsgolint, `playwright-core` 1.64 работает одной установкой с pnpm 12.16.1 (`latest` на 27.10.2026; 12.0.0 вышел 26.08.2026; фолбэк — 11.28.9) | Тулчейн (D07) | Install- и build-smoke | Этап 0 |
| 7 | Типичная WP-страница даёт 100–250 запросов; p95 времени фаз | Потолок 2 000 запросов, 8 мин | Замер на лаборатории | Этап 1; калибровка в 3а |
| 8 | Лимит GitHub Job Summary около 1 MiB на шаг | Обрезка Summary | Документация и тест | Этап 2 |
| 9 | Регион GitHub-hosted runners не документирован | Гео-режим CMP в CI | Гео-сигналы CMP из job | Этап 2 |
| 10 | DSK OH Digitale Dienste v1.2 (11/2024) актуальна, Rn. 121, 124–125, 134–137 верны (v1.3/2.0 не найдены, текст Rn. 124 в раунде 3 не перечитан). Дословно — что Rn. 125 говорит о первом уровне, на котором согласие дать нельзя (условие `acceptAvailableAtFirstLayer`, вариант `no-choice-at-first-layer`) | `legalNote`, уровни CONSENT-04 и LEGAL-01 | Чтение PDF DSK | До подписи ruleset (конец 3а) |
| 11 | OLG Köln 6 U 80/23 — rechtskräftig? VG Hannover 10 A 5385/22: дата подтверждена (Urteil 19.03.2025, voris), неизвестно, есть ли Berufung; деталь «GTM требует Einwilligung» — из вторичных источников | Статус `legalNote` (`court-appellate` / `court-first-instance`) | juris, пресс-релизы судов | Тексты (3а) |
| 12 | EDPB Guidelines 05/2020 Rn. 86 (скролл ≠ согласие) — дословно | Уровень находок A′ | PDF EDPB | 3а |
| 13 | EDPB Cookie Banner TF (adopted 17.01.2023), Type C: ссылка вместо кнопки | Уровень `reject-as-link` | Текст отчёта | 3а |
| 14 | UrhG § 51 покрывает скриншот области баннера как Beleg | Скриншоты по умолчанию (D20) | Юрист заказчика | До дисклеймера (3а) |
| 15 | `extraHTTPHeaders` в Chromium 156 вызывает CORS-preflight | Только для варианта (б) вопроса 3 | Фикстура | Если заказчик выберет (б) |
| 16 | Auto-upgrade mixed content при флагах Playwright (`HttpsUpgrades` отключён); полнота `MixedContentIssue` для OOPIF и workers | TLS-03 | Фикстуры | 3б |
| 17 | Формат `gcd` (спецификации Google нет); наблюдаемость consent-API шаблонов GTM | CONSENT-06 | Фикстуры, версионированный декодер | 3б |
| 18 | Поле `impact` в WPVulnerability (CVSS? CWE?) | Pre-auth класс в правиле `critical` VULN | Запрос к API | 3б |
| 19 | Условия Wordfence Intelligence (26.01.2026) и EUVD (ENISA) | Второй VULN-источник | Чтение условий живым браузером | До включения (после релиза) |
| 20 | ToS Cookiebot free, Usercentrics trial, Complianz для автоматических сканов собственной лаборатории; лицензия Borlabs около 40 € | CMP-лаборатория | Чтение ToS, покупка | Этап 0–1 |
| 21 | `youtube-nocookie.com` пишет localStorage; `p.typekit.net` — хост шрифтов | Варианты EMBED-03, каталог EMBED-01 | Фикстура и наблюдение | 3а / 3б |
| 22 | `include:integrity` требует GitLab ≥ 17.9 (по документации, Terra-К) | Self-managed | Документация GitLab | Этап 2 |
| 23 | npm staged publishing поддерживает первую публикацию нового пакета (changelog 02.10.2026) | Первый релиз | Документация npm | Этап 4 |
| 24 | Закрыт в раунде 4б: RFC 9989 опубликован в мае 2026 (заголовок RFC), obsoletes 7489 и 9091, удаляет тег `pct` | — | — | — |
| 25 | Актуальный URL TDDDG на gesetze-im-internet.de (у Sol — путь `ttdsg/`) | Живые ссылки в `legalNote` | Проверка ссылок в CI | Этап 4 |
| 26 | PLD (EU) 2024/2853: транспозиция до 09.12.2026 (по памяти). CRA Art. 24 применяется с 11.12.2027 (подтверждено Fable-К) | Правовой статус проекта | Юрист заказчика | Этап 4 |
| 27 | Modern Solution: Az. решения BVerfG (Nichtannahme 15.09.2025 подтверждена heise) | README и ADR пассивности | Первоисточник | Этап 4 |
| 28 | Закрыт в раунде 4б: EuGH C-526/24 Brillen Rottler, решение 19.03.2026, PM 38/26 доступен на curia.europa.eu | — | — | — |
| 29 | EinwV: «Consenter» признан 17.10.2025 (один вторичный источник); изменение BSIG Art. 8 от 22.10.2026 (BGBl. 2026 I Nr. 318) — содержание | PIMS вне MVP; `legalContext` | Реестр BfDI, BGBl. | После релиза |
| 30 | Конфигурация `@duckduckgo/autoconsent` 17.1.0 для detect-only: какие exports и флаги выключают `optOut`, `optIn`, cosmetic и прочие мутирующие действия | D12 | Исходники пакета и тест на фикстуре | Этап 3а |
| 31 | Популярные upstream-прокси принимают `CONNECT` на IP-литерал | 5.7, `--proxy` | Спайк С5 | До этапа 2 |
| 32 | Подтверждено 30.10.2026: Corepack не поставляется с Node ≥ 25 ([документация Node.js 25](https://nodejs.org/download/release/v25.8.0/docs/api/corepack.html), [release notes 25.0.0](https://nodejs.org/en/blog/release/v25.0.0), nodejs/node#57617). Открыто только, как ставить pnpm в CI на Node 26 и в образе | D07 | Install-smoke | Этап 0 |

Подтверждено в раундах 1–3, используется как факт: CVE-2025-29927 исправлен в Next.js 15.2.3; UK adequacy продлена до 27.12.2031; DPF 2023/1795 в силе, C-703/25 P pending; Digital Omnibus — мандат Совета ST 14756/26, а не действующее право; Google reCAPTCHA — Auftragsverarbeiter с 02.04.2026; BSI TR-02102-2 2026-01; CISA KEV catalogVersion 2026.10.29; лицензии third-party-web (MIT), Open Cookie Database (Apache-2.0), WPVulnerability (CC0), PDF.js (Apache-2.0); имя `dsgvo-check` в npm свободно; Docker-actions GitHub исполняются от root; `frame-ancestors` в meta-CSP не поддерживается; hosted runners GitLab.com — privileged. В раунде 4б подтверждены: RFC 9989 — Published May 2026, тег `pct` удалён; VG Hannover 10 A 5385/22 — 19.03.2025; EuGH C-526/24 — 19.03.2026 (PM 38/26); Let's Encrypt выдаёт 6-дневные и IP-сертификаты (opt-in, общедоступны с 15.01.2026); pnpm `latest` — 12.16.1; у Playwright `chromiumSandbox` по умолчанию `false`, `locator.screenshot()` прокручивает элемент, `browser.version()` возвращает версию, а не UA; § 19 Abs. 4 TDDDG: шифрование — Satz 3.

---

## 8. Вопросы заказчику

Порядок — по важности. Дубликаты раундов 1–3 объединены. Оставлены только вопросы, без которых нельзя начать этап или зафиксировать контракт. Пока ответа нет, разработка следует рекомендации панели, а если она отходит от ТЗ — букве ТЗ.

1. **Что означает `critical`.**
   - **Варианты:** (A) доказанное нарушение; (B) уверенно установленный технический факт класса, приоритетного по утверждённому ruleset; (C) любой серьёзный риск.
   - **Рекомендация:** B. Связь с тирами `crmCode`: T0 и T1 — «critical-способные», T3 — не выше `warning` (lint, не автоматическая выводимость).
   - **Нужно:** до этапа 1.
2. **Контракт кодов 0/1/2.**
   - **Варианты:** (а) D03: fatal `2` > `1` > `2` за ошибку релевантной проверки > `0`, плюс `--strict`; (б) любая ошибка включённой проверки → `2`, и `2` > `1`; (в) ошибка проверки без `--strict` не даёт `2`.
   - **Рекомендация:** (а). Подтвердить, что недоступная цель, WAF и таймаут до завершения сбора стартовой страницы дают `2` — это уточнение буквального «сканер сам упал». Таймаут после частичного сбора даёт `1` при находке, `2` — если не завершились релевантные проверки, иначе `0` (5.2). Подтвердить и цену мягкого режима GitLab (`allow_failure: exit_codes: [1]`): при наличии находки job проходит и тогда, когда упала проверка.
   - **Нужно:** до этапа 1.
3. **User-Agent браузера.**
   - **Варианты:** (а) буква ТЗ: ссылка на репозиторий и в браузерном UA, бот-режим CMP → `inconclusive`; (б) поправка ТЗ: ссылка в UA HTTP-проб и на странице проекта, в браузере Chrome UA и токен без URL, прошедший тест `isbot` и регулярок CMP (возможно переименование); (в) идентифицирующий заголовок — панель отклоняет.
   - **Рекомендация:** (а) по умолчанию. Статически буквальный UA ловят только `isbot` и RCB (1 из 25 CMP-находок каталога), а Borlabs, Cookiebot и Complianz — нет; С1 проверяет это в рантайме. Перейти на (б), если С1 всё же покажет бот-режим хотя бы у одного из Borlabs, Cookiebot, Complianz (20 из 25 CMP-находок каталога). При (б) учесть, что имя `dsgvo-check` само ловится `isbot` и RCB по `check\b`.
   - **Нужно:** до этапа 1, по данным С1.
4. **Release manifest.**
   - **Рекомендация:**
     - в релизе: 15 P0 и CONSENT-05 (перенос из P1), HTML, JUnit, Job Summary, фаза M;
     - stretch: PDF;
     - порядок вылета при нехватке бюджета: PDF → JUnit → GitHub Job Summary → HTML; JSON и консоль — контракт ТЗ; фаза M не вылетает (корректность CONSENT-04);
     - на этапе 3б: остальные P1 в порядке каталога, VULN первыми за борт;
     - после релиза: P2; FILE-01 и ADMIN-01 только как opt-in.
   - **Варианты:** принять; только P0; сокращённое ядро с явным списком исключений. Прототип по `docs/prototype/BRIEF.md` — отдельный срез, не релиз (раздел 2а).
   - **Нужно:** до этапа 1.
5. **Корпус и входные данные.**
   - **Что нужно от заказчика:**
     - 10 сайтов с письменным согласием владельцев (объём, частота, срок);
     - кто размечает `mustFind` и `mustNotFind`;
     - экспорт собственных аудитов: домены → сервисы → `crmCode` → фрагменты политик, только свои данные (§ 87a UrhG);
     - бюджет и лицензии CMP-лаборатории (минимум Borlabs, Cookiebot, Complianz);
     - согласие на разовый измерительный прогон прототипа по 100 публичным сайтам без согласия их владельцев: только классы O и T, паузы D09, приватные результаты, без публикации и CRM (раздел 2а).
   - **Варианты:** по ТЗ «к этапу 3»; раньше.
   - **Рекомендация:** экспорт — на этапе 0, сайты — к концу этапа 1.
   - **Нужно:** до этапа 1.
6. **Дедупликация и маппинг `crmCode`.**
   - **Варианты дедупликации:** (а) TRACK-01 — владелец analytics/ads с уровнем, CONSENT-01 — остаток; (б) CONSENT-01 гейтит все сторонние запросы до клика, EMBED-* — свои категории, TRACK-01 — `info`-инвентарь со связью через общие `evidenceIds`; (в) все ID с уровнем.
   - **Рекомендация по дедупликации:** (б). Совпадает с примером каталога для CONSENT-01 («GTM, GA и Google Ads ставят `_ga`, пока баннер ещё висит») и с тремя из четырёх предложений.
   - **Маппинг:**
     - код для EMBED-03 (видео ≠ T1_MAPS…) — отдельный или подтверждение агрегации;
     - CONSENT-06 — подтвердить код;
     - `null` для P2, «Banner nicht erkannt» и непривязанных `info`-вариантов;
     - TRACK-01 после принятия — какой код;
     - FILE-01 «T0»;
     - выдержит ли CRM `null` и коды по варианту.
   - **Рекомендация по маппингу:** `crmCode` только в JSON; смена маппинга — minor.
   - **Нужно:** политика `null` и коды по варианту — до этапа 1 (схема); конкретные коды — до конца 3а.
7. **Организация, репозиторий, домен проекта, имя.**
   - **Что нужно:**
     - URL для UA, `$id` схемы, GHCR и `action.yml`; в имени организации и репозитория не должно быть `bot`, `crawler`, `spider`, `robot` (Borlabs ловит `bot` в UA);
     - Impressum и Datenschutzerklärung заказчика для домена проекта и витрины — до этапа 2;
     - clearance имени (DPMA, EUIPO, домен, npm, GitHub).
   - **Рекомендация:** оставить `dsgvo-check`, если clearance пройден.
   - **Нужно:** до этапа 1.
8. **Sandbox на трёх входах ТЗ** (`npx`, `docker run`, CI).
   - **Конфликт с ТЗ.** ТЗ требует запуска одной командой без конфига, а остальные CI — через Docker-образ. При `require` на хосте без userns-sandbox (Ubuntu ≥ 23.10 с AppArmor-ограничением ⚠) и при голом `docker run` с дефолтным seccomp первая команда даёт `2` с инструкцией, а не отчёт (§3 D25).
   - **Варианты:** (а) `require` на всех входах плюс явный `off` с диагностикой; образ выдаёт seccomp-профиль и печатает точную строку запуска; (б) `require` в Action, GitLab-шаблоне и образе, а у `npx` вне CI — `off` с громкой диагностикой, если sandbox недоступен; (в) `auto` с fail-open везде; (г) только `require` без `off`.
   - **Рекомендация:** (а): на ноутбуке рядом с браузером личные данные и ключи, sandbox там важнее, чем в одноразовой VM CI. Пересмотреть в пользу (б), если С3 покажет, что `npx` не поднимает sandbox на массовых хостах (Ubuntu 24.04, образ GitHub `ubuntu-24.04`). GitLab-шаблон — `require`, если С3 это подтвердит.
   - **Нужно:** решение — до этапа 1 (оно влияет на образ и сообщения об ошибке), шаблоны — до этапа 2.
9. **Подпись таблицы уровней `ruleset/de-2026`** (раздел 4). Спорные строки:
   - CONSENT-04: блокирующий → `critical`; неблокирующий, ссылка, Pur-Abo → `info`;
   - EMBED-01 `warning` при коде T1;
   - CONSENT-03 `critical` только с заявленным EWR-egress;
   - LEGAL-01 `critical` после перехода и фолбэка;
   - PRIV-01 не выше `warning`; PRIV-02 `critical` при воспроизведённом противоречии в своей фазе;
   - TLS-01 — градация;
   - cookieless pings → `warning`;
   - A′ — тот же уровень, что A;
   - reCAPTCHA с формой → `info`;
   - anti-framing → `warning`;
   - MAIL-02: `~all` при DMARC-enforcement → `info` (каталог считает «мягкий SPF» находкой);
   - EMBED-02…05 → `warning` при коде T1;
   - TLS-02: порог срока относительно срока действия, короткоживущие сертификаты без находки;
   - CONSENT-01: хит с `user-supplied`-идентификатором при `denied` в Consent Mode — `critical` или `warning` (рекомендация: `critical` только при `stored-match`, `persistent-param` или `user-supplied`, иначе `warning`);
   - CONSENT-04: `no-choice-at-first-layer` → `info`.

   - **Варианты:** подписать как есть; изменить значения в ruleset.
   - **Рекомендация:** подписать как в разделе 4; профиль `de-strict` в 1.0 не делаем.
   - **Нужно:** до конца этапа 3а (ворота релиза), разработку не блокирует.
10. **Тексты.**
    - **Что нужно:**
      - кто и когда пишет DE-тексты по `checkId.variant`, `legalNote`, дисклеймер, стоп-листы de и en;
      - словарь статусов источников;
      - выходит ли `en` в 1.0;
      - лицензия текстов.
    - **Варианты лицензии:** CC BY 4.0 для `data/texts` и `legal/`; Apache-2.0, как код; оставить за заказчиком с разрешением на распространение.
    - **Рекомендация:**
      - с этапа 1 — черновики legal-basis-map с `draft: true`;
      - финальные `de` — к середине 3а;
      - лицензия CC BY 4.0 и DCO;
      - `en` — только вычитанный.
    - **Нужно:** до этапа 3 (как в ТЗ).
11. **Evidence и хранение.**
    - **Что решить:**
      - скриншот области баннера по умолчанию — с оценкой UrhG § 51;
      - значения и хеши cookies — никогда;
      - маскирование `mailto:`;
      - retention артефактов 14 дней;
      - запрет публикации отчётов о третьих лицах в Nutzungshinweise;
      - HAR и trace выключены.
    - **Варианты:** как D20; скриншоты opt-in; только агрегаты.
    - **Рекомендация:** как D20.
    - **Нужно:** до этапа 3а (условный дисклеймер).
12. **Egress для доказательных аудитов.**
    - **Варианты:** (а) не нужен; (б) для аудитов seed-factory обязателен DE- или EWR-egress (`--proxy` или self-hosted runner в DE, `--assume-region de`, `--strict`); (в) всегда.
    - **Рекомендация:** (б). В CI клиентов допустим `unknown` с ограничениями. Сейчас `critical` CONSENT-03 открывается одним заявлением пользователя (`--assume-region`) с пометкой «laut Nutzerangabe» — это решение модератора, Sol-К и Terra-К считали такого заявления недостаточным. Если заказчик требует проверяемого egress, `critical` будет требовать (б); уровень `verified-by-operator` — бэклог.
    - **Нужно:** до этапа 3а.
13. **Стандарт описания сервисов для PRIV-01.**
    - **Варианты:** (A) точное имя бренда; (B) продукт, оператор или категория с ручной оценкой; (C) любое совпадение слова.
    - **Рекомендация:** B. `not-named` → `warning`, `category-only` → `info`; заказчик утверждает алиасы и допустимые формулировки.
    - **Нужно:** до этапа 3а.
14. **VULN.**
    - **Что решить:** правило каталога «запись в KEV → `critical`» для клиентских библиотек (jQuery < 3.5.0, CVE-2020-11023), и какой CVE имелся в виду в примере «Next.js 15.2.8».
    - **Варианты:** оставить правило; понизить клиентские KEV до `warning` без pre-auth server-side вектора.
    - **Рекомендация:** оставить правило каталога только при версии `exact`, с поясняющим текстом; пересмотреть по данным канарейки.
    - **Нужно:** до этапа 3б.
15. **Правовой статус проекта.**
    - **Что оценить:**
      - RDG для платных аудитов заказчика (§ 5 RDG);
      - CRA (Hersteller или OSS-steward, Art. 24 с 11.12.2027) и PLD при монетизации через seed-factory;
      - список путей FILE-01 и ADMIN-01 для будущего opt-in (§§ 202a/202c StGB, § 4 GeschGehG).
    - **Рекомендация:** оценка юриста заказчика, результат — в README и дисклеймере.
    - **Нужно:** до этапа 4.
16. **Generic-селекторы DKIM и запрет «перебора»** (раунд 4б).
    - **Суть:** ТЗ запрещает «активные атаки: перебор…». MAIL-03 после заданных и документированных селекторов запрашивает короткий generic-список: ≤ 25 TXT к авторитетному DNS, результат только `info`. Каталог сам описывает MAIL-03 как поиск «на распространённых селекторах».
    - **Варианты:** (а) generic-список допустим: это публичные DNS-записи, а не запросы к сайту; (б) только `--dkim-selector` и документированные селекторы провайдера.
    - **Рекомендация:** (а), как в каталоге. До ответа действует (а).
    - **Нужно:** до этапа 3б (MAIL-03).

---

## 9. Риски

| # | Риск | Вероятность | Влияние | Мера | Владелец |
|---|---|---|---|---|---|
| 1 | Бот- или гео-режим CMP: ложные CONSENT-01/02/03 или `inconclusive`. По статическому анализу при буквальном UA — прежде всего на сайтах с RCB и `isbot`; гео-режим — на всех CMP с гео-логикой | средняя | высокое | Детектор по прямым сигналам, `inconclusive` и диагностика; спайк С1 до этапа 1; DE-egress для аудитов; CONSENT-03 `critical` только с заявленным EWR | Разработка; решения по UA и egress — заказчик |
| 2 | Шум PRIV-01 (48/80 аудитов, третья по частоте P0) подрывает доверие к самой шумной P0 | высокая | высокое | Manifest полноты, происхождение фрагментов, `category-only` → `info`, `inconclusive` при неполноте, не выше `warning`, размеченный корпус | Разработка; алиасы и формулировки — заказчик |
| 3 | Поздние входные данные: решения 1–8, 10 сайтов, экспорт аудитов, тексты | средне-высокая | высокое | Запрос на этапе 0; CMP-лаборатория как временный корпус; черновые тексты; тесты по `variant` выводят уровни из критического пути | Заказчик |
| 4 | Дрейф семи CMP (селекторы, shadow DOM, версии) ломает адаптеры после релиза | высокая | среднее | Ночная лаборатория и канарейка; версия CMP в evidence; fail-safe в `info`; autoconsent как сигнал дрейфа | Разработка |
| 5 | Правовой риск вывода: § 824 BGB, Abmahn-злоупотребление, ложные факты о получателях, § 186 StGB для Einzelunternehmer | средняя | высокое | Только факты; стоп-листы de и en; `crmCode` не в человекочитаемых отчётах; модель provider/parent/dpfEntity; Messumgebung; дисклеймер; non-features (batch, рейтинги, генератор претензий, автоуведомления); приватная канарейка | Заказчик (тексты, юрист) и разработка |
| 6 | Компрометация CI недоверенным JS или SSRF к metadata раннера | средняя | высокое | Sandbox `require` (`chromiumSandbox: true`); `EgressPolicy` с проверкой IP при соединении для прокси, undici и TLS; за upstream — CONNECT на проверенный IP; non-root, read-only; job без secrets, OIDC и `docker.sock`; быстрые апдейты Chromium | Разработка |
| 7 | Флейки измерений (таймерные теги, A/B-тесты) дают мигающий CI | высокая | среднее | Детерминированная выборка и `pages:`; окно тишины; `2` только за релевантные ошибки; baseline без хоста и страниц; `exitReasons` | Разработка |
| 8 | Пропуски захвата (SW, pagehide-beacons, sGTM, транзиентные cookies, OOPIF) дают ложное «чисто» | высокая | среднее | CDP auto-attach, граф SW, хук cookies, фикстуры на каждый путь, ограничения в Messumgebung, спайк С7 | Разработка |
| 9 | Перерасход оценки и расползание объёма | высокая | среднее | Release manifest; PDF как stretch; VULN первыми за борт; новые ID в бэклог; еженедельный burn-down; буфер 15 % | Заказчик и разработка |
| 10 | Персональные данные и секреты в evidence и артефактах (mailto, Impressum, имена авторов, скриншоты) | средняя | высокое | Редактирование в коллекторе до снимка и логов; маски; только область баннера; retention 14 дней; L0-тест редактирования | Разработка; срок хранения — заказчик |
| 11 | Sandbox недоступен на части входов ТЗ (хост Ubuntu ≥ 23.10, голый `docker run`, self-managed GitLab): «одна команда» даёт `2` | средняя | среднее | Спайк С3 на трёх входах; seccomp-профиль в Action и в образе; точная строка запуска в сообщении; инструкция `off` с диагностикой; README; вопрос 8 | Разработка; решение — заказчик |
| 12 | Лицензионное загрязнение данных (NC, CC BY-SA, модифицированный MPL, § 87a при сборке каталога, условия Wordfence) | низко-средняя | высокое | Allowlist лицензий в CI; `datasets.lock.json`; autoconsent без модификаций и без копирования правил, `THIRD_PARTY_NOTICES`; чек-лист § 87a; только собственные аудиты | Разработка; права на экспорт — заказчик |

---

## 10. ADR-кандидаты

1. **ADR-001 Граница продукта** — технические наблюдения без правовых выводов; `critical` — факт по утверждённому ruleset; non-features: batch, рейтинги, генератор претензий, автоуведомления, тексты под сайт (в т. ч. LLM).
2. **ADR-002 Release manifest** — 15 P0 и CONSENT-05; HTML, JUnit, Summary, фаза M; PDF как stretch; порядок вылета PDF → JUnit → Summary → HTML; P1 на этапе 3б по каталогу; P2 после релиза; прототип отделён от релиза.
3. **ADR-003 Конвейер** — коллекторы → сырой отредактированный снимок с `plan` → `derive` → проверки по `requires` → assess → gate → репортеры.
4. **ADR-004 Контракт проверки** — `CheckDefinition {id, requires, variants, planProbes?, run}`; явный реестр и тест полноты; `ProbeSpec`; тест графа импортов.
5. **ADR-005 Модель результата** — `status`, `severity`, `confidence`; кэп уровня; `diagnostics[]` отдельно; нет `pass/fail`.
6. **ADR-006 Коды возврата** — чистая `gate()`: `2 (fatal)` > `1` > `2 (relevant error / strict)` > `0`; `exitReasons[]`; `--fail-on critical/warning/none`; `--strict`; релевантность без кэпа уверенности; `none × strict`; окончательный код после репортёров; мягкий режим по платформам.
7. **ADR-007 Схема отчёта** — zod 4 → JSON Schema 2020-12 и Ajv; независимый semver; схема `failed`; `evidence[]` верхнего уровня; открытые `evidence.type` и коды диагностики.
8. **ADR-008 Fingerprint, подавления, baseline** — `sha256(JCS{v, checkId, variantGroup, subject})` без хоста и страниц; `subject` для всех ID; `reason` и `expires`; `locked`-варианты не переопределяются; baseline с severity; `baseline migrate` — бэклог; `version` у пользовательских файлов.
9. **ADR-009 Версионирование** — пакет, `schemaVersion`, `rulesetVersion` (CalVer) и `rechtsstand`, `datasets[]`, `fingerprintVersion`.
10. **ADR-010 Фазы согласия** — пять фаз в четырёх свежих persistent-профилях: A (с A′ в конце), B, C, M; общая контрольная выборка B/C; алгоритм тишины; репликация как факт; общая политика 429/503.
11. **ADR-011 Браузер** — CfT new headless; `playwright-core` с точным пином; `context.on` и CDP; `route` не для наблюдения.
12. **ADR-012 User-Agent** — буква ТЗ до ответа заказчика; браузерный UA из `navigator.userAgent` или шаблона, мобильный в M; у TLS-проб UA нет; обязательный детектор бот-режима; без кастомных заголовков, `DNT` и `GPC`.
13. **ADR-013 Гео** — сигналы CMP → `inconclusive` и `SCAN-GEO`; `egress` с происхождением; терминология EWR.
14. **ADR-014 CMP** — семь своих адаптеров с контрактом `extract / act / verify`; решение — чистая `classifyFirstLayer` в core, выбор в `plan.click`; autoconsent — read-only детект на собственных правилах после окна A; эвристика → `info`.
15. **ADR-015 Критерий CONSENT-04** — таблица вариантов по `CmpFacts` первого экрана (desktop и M), включая `consent-without-action` и `no-choice-at-first-layer`; `blocking-no-reject` требует `acceptAvailableAtFirstLayer`; `banner-not-recognized` и `cmp-not-supported` — `locked`.
16. **ADR-016 Дедупликация** — `routing.yaml`; одна гейтящая находка на наблюдение; TRACK-01 — инвентарь (после ответа на вопрос 6).
17. **ADR-017 Каталог и лицензии данных** — свой каталог, third-party-web, Open Cookie Database, `cname-trackers`; без NC, SA и GPL; чек-лист § 87a; `datasets[].attribution`, атрибуция GHSA (CC BY 4.0).
18. **ADR-018 Документный конвейер** — `documents` в коллекторе; DSE в фазе A без кликов и дополнение в B, без зависимости от отказа; manifest полноты; происхождение фрагментов; PDF → `inconclusive` в 1.0.
19. **ADR-019 Третьи страны** — `provider`, `parent`, `dpfEntity` и `adequacy.json`; DPF в `legalContext`; GeoIP после релиза.
20. **ADR-020 VULN** — WPVulnerability, retire.js, OSV/GHSA, KEV; `critical` = `exact` ∧ range ∧ (KEV ∨ pre-auth класс); CVSS один недостаточен.
21. **ADR-021 Пассивный режим** — классы O, T, E; E — opt-in вне релиза; таблица вежливости и общая политика 429/503; DKIM ≤ 25 селекторов, результат `info` (вопрос 16).
22. **ADR-022 Ruleset** — уровни, `gating` и `crmCode` по `(checkId, variant)` — данные; lint «T3 не выше `warning`»; подпись заказчика.
23. **ADR-023 Минимизация evidence** — без значений и хешей; безопасные признаки с `parserVersion`; маски; скриншот области баннера по умолчанию — снимок viewport до действий и обрезка, только при контейнере ≤ 50 % viewport; HAR выключен; retention 14 дней.
24. **ADR-024 Тексты и i18n** — ICU MF1; `de` по умолчанию, `en` только вычитанный; стоп-листы de и en; `draft` блокирует релиз; `crmCode` только в JSON.
25. **ADR-025 Сетевая граница** — единый `EgressPolicy` для прокси, undici, `node:tls`, `net`; in-process HTTP/CONNECT; `--proxy` только HTTP, SOCKS5 — бэклог; DNS напрямую; upstream — CONNECT на проверенный IP; QUIC и non-proxied UDP выключены; принудительная сеть — бэклог.
26. **ADR-026 Изоляция** — `--sandbox require/off`, без `auto`; `require` ⇒ `chromiumSandbox: true`; поведение на трёх входах ТЗ (вопрос 8); non-root, read-only, seccomp-профиль в образе; `acceptDownloads: false`.
27. **ADR-027 GitHub Action** — composite и `docker run` по digest; порядок релиза образ → digest → `action.yml` → тег.
28. **ADR-028 GitLab** — `include:remote` и `integrity`, `allow_failure: false`; Catalog-компонент после релиза.
29. **ADR-029 Образ и npm** — `node:24-bookworm-slim` и CfT; amd64 сразу, arm64 после smoke; явная `install`, без postinstall; `THIRD_PARTY_NOTICES` в обоих.
30. **ADR-030 Тулчейн и репозиторий** — Node ≥ 24, TS 7, pnpm 12.16.1 (фолбэк 11.28.9), Vitest 5, Biome; один пакет без workspace.
31. **ADR-031 Тестирование** — L0–L4; L1 по `variant`; критерии приёмки канарейки и лаборатории.
32. **ADR-032 Форматы отчёта** — JSON, консоль, HTML без JS с полной CSP, JUnit по маппингу 5.2, Summary; PDF как stretch; SARIF после релиза.
33. **ADR-033 Релизы и supply chain** — предложение модератора к этапу 4, в раунде 3 не голосовалось: release-please; npm trusted publishing и provenance; `actions/attest` и SBOM (без cosign — Opus-К §4.11); actions по SHA; Renovate с группой Playwright.
34. **ADR-034 Прототип** — срез этапа 1 по `docs/prototype/BRIEF.md`; не релиз и не его ворота; что прототип берёт из поправок раунда 4б (раздел 2а).
