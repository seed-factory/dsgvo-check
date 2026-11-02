# dsgvo-check — ресёрч браузерной части (Playwright)


| | |
|---|---|
| Дата | 2026-10-30 |
| Статус | Этап 0 · анализ, кода нет. Иллюстративные фрагменты — псевдокод |
| Входные документы | `specs/dsgvo-check_idea.md`, `specs/dsgvo-check_TZ.md`, `specs/dsgvo-check_katalog-proverok.md` |
| Зафиксированная база | Playwright **1.64.1** (npm, 2026-10-14), Chromium **156.0.8078.4** (Chrome for Testing + Chrome Headless Shell), Node ≥ 20 (`engines` у `playwright-core`), Docker-образы Playwright — Node 24 |

Обозначения: **✔ проверено** — по первоисточнику или исходнику; **⚠ проверить** — не удалось подтвердить, нужен прототип или ответ вендора; **[эксп.]** — результат мини-эксперимента в разделе 10.

---

## Коротко

1. **Главный риск — не Playwright, а то, что CMP ведут себя для сканера иначе, чем для человека.** По исходникам самих CMP (раздел 3.2): Borlabs Cookie 3.5 при `cookiesForBots` молча сохраняет «принять всё», Real Cookie Banner делает то же (`accept-all-for-bots`, по умолчанию **включено**), Complianz для бота возвращает `cmplz_has_consent() === true`, Cookiebot для «пауков» вызывает `setOutOfRegion()`, то есть тоже принимает всё. Usercentrics v3 содержит детектор ботов, в списке которого есть `HeadlessChrome` и `Playwright/`. Если сканер похож на бота, мы получим **ложные** CONSENT-01/02/03 (трекеры грузятся, баннера нет). Эта категория ошибок хуже пропусков: она роняет CI клиенту, у которого всё в порядке.
2. **Честный User-Agent со ссылкой на репозиторий конфликтует с этим.** Строку `… Chrome/156.0.0.0 Safari/537.36 dsgvo-check/0.1 (+https://github.com/…)` распознают как бота регулярка `isbot` (паттерны `http`, `\.com\b`, `check\b`) и встроенная в Real Cookie Banner копия этой регулярки. Регулярки Cookiebot, Complianz и Borlabs 3.5 её не ловят ✔. Дефолтный UA headless-shell (`HeadlessChrome`) ловят `isbot`, RCB и Usercentrics v3, так что оставлять его тоже нельзя. Заметка: **само имя `dsgvo-check` попадает под `check\b`**. Решение: честный токен оставить, но (а) ввести детекторы «бот-режима» и «гео-режима» CMP и в этих случаях понижать находки до `warning`/`info`, (б) прогнать набор из 10 эталонных сайтов заказчика в двух вариантах UA и измерить разницу (раздел 3.4).
3. **Гео — второй источник ложных срабатываний.** GitLab.com: hosted runners по умолчанию в `us-east1` ✔. GitHub: регион не документирован ⚠. У Usercentrics, если правило по умолчанию «без баннера», CMP работает в фоне, и все сервисы считаются согласованными. У Cookiebot вне региона ставится `CookieConsent=-1` и «принять всё». Complianz показывает посетителям из США opt-out-баннер. Нужны: `--proxy`/self-hosted runner в ЕС, чтение гео-сигналов каждой CMP и правило «нет баннера + гео-сигнал → `warning SCAN-GEO`, а не CONSENT-03».
4. **Без нейтральной интерактивности фаза «до согласия» неполна.** WP Rocket (Delay JS) держит все скрипты до движения мыши, скролла или клавиши. Borlabs 3.x с `dialogShowDialogAfterUserInteraction` вообще не монтирует баннер до keydown или scroll ✔. Нужна подфаза A′: скролл, движение мыши, безопасная клавиша, без кликов. Находки из неё помечаются отдельно; юридически это по-прежнему «до согласия», решение за заказчиком.
5. **Сетевой захват:** базовый источник — `context.on('request'|'response'|'requestfinished'|'requestfailed')`. Он видит service workers (с 1.57, только Chromium), dedicated workers и beacons при загрузке ✔ [эксп.]. Подтверждённые пробелы ✔ [эксп.]:
   - **beacons на `pagehide`/`visibilitychange` до сервера доходят, но в событиях Playwright их нет;**
   - preconnect в событиях не виден, а в `browser.newContext()` Chrome его вообще не выполняет (Incognito-подобный профиль).

   Закрываем NetLog (работает ✔), разбором DOM и `Link`-заголовков, а также **свежим persistent-профилем на фазу** вместо `newContext()`. CDP-сессию добавлять ради `initiator`, сырых `Set-Cookie` с `blockedCookies`/`cookiePartitionKey` и `Preload`-событий. `page.route` для наблюдения **не использовать**: он отключает HTTP-кэш ✔.
6. **`networkidle` не подходит** (Playwright сам помечает его DISCOURAGED ✔): страницы с аналитикой либо не «затихают», либо затихают до таймерных тегов. Вместо него — свой алгоритм: `load`, затем минимальная выдержка, окно тишины по счётчику in-flight и жёсткий потолок (раздел 1.4).
7. **Распознавание CMP:** собственные адаптеры для 7 CMP. Всё читаем через JS-API, кликаем только по реальному UI (`locator.click()` с actionability-проверками) и проверяем эффект по состоянию CMP, consent-cookie и сети. `@duckduckgo/autoconsent` (17.1.0, MPL-2.0) годится как библиотека детекции и эвристик, в том числе немецких, но **не как источник вердикта CONSENT-04**: его opt-out может идти через второй уровень, через API (`Cookiebot.withdraw()`) или через косметическое скрытие ✔.
8. **CONSENT-06:** default-состояние читаем из `dataLayer` (`['consent','default',{…, region}]`) и из `gcs`/`gcd` в запросах Google. `gcd` декодируется побитово (раздел 6.2). Если default задан с `region`, оцениваем его «как для DE», независимо от гео раннера.
9. **Режим и Docker:** по умолчанию — CfT new headless (`channel:'chromium'`), потому что headless-shell отдаёт `HeadlessChrome` в `Sec-CH-UA` даже при подменённом UA ✔ [эксп.]. Официальный `mcr.microsoft.com/playwright:v1.64.1-noble` весит ~**984 МБ** сжатым (amd64 ✔) и 3.52 ГБ распакованным (arm64 ✔ [эксп.]), содержит все 3 браузера, по умолчанию root. Sandbox Chromium с дефолтным seccomp Docker **не поднимается** ✔ [эксп.]. Для публикуемого образа предлагается свой: slim-Node, только Chromium, не-root, `tini`, шрифты для PDF, `--sandbox auto` с честным fallback.
10. **PDF:** `page.pdf()` (в Chromium через CDP `Page.printToPDF`) поддерживает `tagged` и `outline`. PDF/A не даёт ⚠. Отчёт должен быть self-contained, **без внешних шрифтов и CDN**: DSGVO-отчёт, который сам грузит Google Fonts, — репутационный риск.

---

## 0. Факты о версиях и окружении (на 2026-10-30)

| Что | Значение | Статус / источник |
|---|---|---|
| `playwright`, `playwright-core`, `@playwright/test` | 1.64.1 (опубл. 2026-10-14), Apache-2.0; 1.64.0 — 2026-10-07 | ✔ npm registry |
| Браузеры в 1.64.1 | `chromium` = Chrome for Testing 156.0.8078.4; `chromium-headless-shell` 156.0.8078.4; Firefox 157.0; WebKit 27.2 | ✔ `browsers.json` в `playwright-core@1.64.1` |
| Headless по умолчанию | `chromium-headless-shell` (отдельная сборка). «Новый headless» = полноценный Chrome через `channel: 'chromium'` | ✔ playwright.dev/docs/browsers; release notes 1.49, 1.57 |
| Установка | `npx playwright install --with-deps --only-shell chromium` (только shell) / `--no-shell` (только полный) | ✔ playwright.dev/docs/browsers |
| Service worker network events | Репортятся в `BrowserContext`, только Chromium, с 1.57 | ✔ release notes 1.57, docs service-workers |
| `partitionKey` в cookies | С 1.54 в `context.cookies()` / `addCookies()` | ✔ release notes 1.54 |
| `storageState({ indexedDB })` | С 1.51; `opfs` — с 1.63 | ✔ release notes |
| HAR | `recordHar` в контексте; `tracing.startHar()` с 1.60; WebSocket в HAR с 1.61 | ✔ release notes |
| Linux arm64 | Chrome for Testing с 1.63 | ✔ release notes |
| Docker-теги | `v1.64.1-noble` (24.04), `-jammy` (22.04), `-resolute` (26.04) | ✔ playwright.dev/docs/docker |
| `@duckduckgo/autoconsent` | 17.1.0 (2026-10-30), MPL-2.0; релизы почти ежедневно | ✔ npm registry |
| `isbot` | 5.2.2, Unlicense | ✔ npm registry |

Наблюдение по исходнику `playwright-core@1.64.1` (`chromiumSwitches`) ✔. Playwright по умолчанию отключает фичи Chromium `ThirdPartyStoragePartitioning`, `HttpsUpgrades`, `OptimizationHints`, `NetworkTimeServiceQuerying` и ставит `--disable-background-networking` и `--disable-dev-shm-usage`. Флаг `--no-sandbox` добавляется, **если не задан `chromiumSandbox: true`**. Следствия для нас:
- автоматического апгрейда http→https нет: это **хорошо** для TLS-01, потому что редирект обязан сделать сервер;
- собственных фоновых запросов Chrome почти нет, сетевой лог чище;
- разделение storage для third-party iframe **не как в настоящем Chrome**: ограничение достоверности, указываем в отчёте;
- sandbox по умолчанию выключен — см. раздел 9.

---

## 1. Захват сети

### 1.1 Источники событий

| Механизм | Что даёт | Ограничения | Роль в dsgvo-check |
|---|---|---|---|
| `context.on('request' / 'response' / 'requestfinished' / 'requestfailed')` | Все запросы всех страниц, popup, OOPIF-iframe. В Chromium с 1.57 — и service workers (`request.serviceWorker()`, при этом `request.frame()` **бросает**). `request.redirectedFrom()`, `resourceType()`, `postDataBuffer()`, `response.serverAddr()` (IP), `response.securityDetails()` (TLS), `response.headersArray()` (в т. ч. все `set-cookie`), `response.fromServiceWorker()`, `request.timing()` | Нет `initiator`/стека. Preconnect, DNS и прочие соединения без HTTP-запроса не видны. Подписываться нужно **до** первой навигации | **Основной источник** |
| `page.on('websocket')` → `framesent`/`framereceived` | Факт WS-соединения и кадры | — | Фиксировать WS к третьим сторонам (чаты, Hotjar и т. п.) |
| `page.route` / `context.route` | Перехват и подмена | Включает Fetch-перехват и **отключает HTTP-кэш** ✔. Не видит запросы, обработанные SW (рекомендуют `serviceWorkers: 'block'`) ✔ | **Не использовать** для наблюдения: меняет поведение сайта. Допустимо только в тестовых фикстурах |
| HAR (`recordHar` / `tracing.startHar`) | Полный журнал, удобен как артефакт CI; WebSocket с 1.61 | Тяжёлый. Содержит значения cookies и тела. Нет фаз и атрибуции | Опционально: `--har` (с `content: 'omit'`), как доказательство «для аудитора» |
| CDP (`context.newCDPSession(page\|frame)`) | `Network.requestWillBeSent.initiator` (`parser`/`script`/`preload`/…, URL, стек); `requestWillBeSentExtraInfo.associatedCookies`; `responseReceivedExtraInfo.blockedCookies`, `cookiePartitionKey`, сырые заголовки; `ResourceType` включает `Ping`, `Prefetch`, `Preflight`, `CSPViolationReport` ✔; домен `Preload` (`prefetchStatusUpdated`, `prerenderStatusUpdated`); `DOMStorage.*` (записи в localStorage) | Только Chromium. Сессию нужно открыть на каждую страницу и OOPIF. Экспериментальные домены могут меняться | **Дополнительный источник**: атрибуция «кто загрузил», блокированные cookies, хранилище. Подключать после того, как ядро стабильно |
| NetLog (`--log-net-log=…`) | DNS-резолвы и сокеты, включая preconnect; beacons на выгрузке | Файл ≈ 0.5 МБ на простую страницу, формат внутренний, включает и не-страничный трафик Chrome. Работает с Playwright в new headless ✔ [эксп.]; в headless-shell ⚠ | Опционально (`--netlog`), для доказательства preconnect и beacons на выгрузке |

**Идентификация первой и третьей стороны.** Сравниваем eTLD+1 по Public Suffix List; поддомены сайта — «first party» с пометкой. Отдельно помечаем **first-party прокси трекеров** (sGTM, Google tag gateway, раздел 6.3). Для «передачи в третьи страны» IP сервера (`serverAddr`) — слабый признак: CDN Google отвечает из ЕС, но это всё равно Google. Классифицировать нужно по **владельцу домена** (база вендоров — отдельный ресёрч). Важно: через HTTP-прокси `serverAddr()` вернёт адрес прокси ⚠, поэтому IP для доказательств резолвим отдельно (Node `dns`).

### 1.2 Что НЕ ловится стандартными событиями и как закрыть

| Канал | Видно в `context.on('request')`? | Как закрыть |
|---|---|---|
| Service worker | Да, Chromium, с 1.57 ✔ | Атрибутировать как `sw`; `serviceWorkers: 'allow'` (не блокировать, иначе ломаем сайт) |
| Dedicated worker (`new Worker`) | **Да** ✔ [эксп.] | — |
| Shared worker | ⚠ (Playwright не даёт API для shared workers) | CDP auto-attach с фильтром `shared_worker`. P2 |
| `navigator.sendBeacon` / `fetch(…,{keepalive:true})` при загрузке | **Да** ✔ [эксп.] (`resourceType` = `ping` / `fetch`) | — |
| То же на `pagehide`/`visibilitychange` при уходе со страницы | **Нет** ✔ [эксп.]: до сервера доходит, в событиях Playwright отсутствует | NetLog; или перед навигацией открыть вторую вкладку и `bringToFront()`, чтобы `visibilitychange` сработал на живой странице ⚠; контекст закрывать последним |
| WebSocket | Хэндшейк виден как request; кадры — через `page.on('websocket')` | См. 1.1 |
| `<link rel=preconnect>`, `dns-prefetch`, `Link:`-заголовки, 103 Early Hints | **Нет** ✔ [эксп.]: соединение без HTTP-запроса, но IP посетителя уходит третьей стороне на TCP/TLS-уровне. Важно: в `browser.newContext()` Chrome preconnect **вообще не выполняет**, в persistent-профиле — выполняет ✔ [эксп.] | (1) парсить DOM `link[rel~=preconnect\|dns-prefetch\|preload\|modulepreload]` и `Link`-заголовки ответов; (2) NetLog (работает ✔ [эксп.]). Уровень находки — ниже, чем у реального запроса (решение заказчика) |
| `<link rel=prefetch>` | Да, как обычный запрос (`Prefetch`) | Атрибутировать тип |
| Speculation Rules `prerender` | ⚠: prerender-страница — отдельная цель; в headless может быть отключён | Парсить `<script type="speculationrules">`; CDP `Preload.*` для статуса. P2 |
| Iframe (в т. ч. cross-origin, OOPIF) | Да | `request.frame()` → URL фрейма для атрибуции |
| Popup / `window.open` | Да (на уровне контекста) | Подписка на `context`, не на `page` |
| Запросы до подписки | Теряются | Подписываться на `context` **до** `newPage()`/`goto()` |
| Запросы расширений и самого Chrome | Не репортятся как страничные | Не нужны; в NetLog — отфильтровывать |
| CSP violation reports, `Preflight` | Preflight в Playwright не репортится как отдельный request ⚠; в CDP — да | Нужны только для отладки |

### 1.3 Модель записи (доказательство для JSON)

Минимум на запрос: `phase`, `pageUrl`, `frameUrl`/`sw`, `url` (query с редактированием известных ID-параметров: `cid`, `_gid`, `uid`, `fbp`…), `method`, `resourceType`, `cdpType` (если есть CDP), `initiator` (тип + URL скрипта), `firstParty/thirdParty` + eTLD+1, `status`, `serverIp`, `tStart` относительно навигации, `setCookieNames[]`, `consentSignals` (`gcs`, `gcd`, `npa`, `dma`), признаки `fromServiceWorker`, `viaPreconnectOnly`. Значения cookies и ID в отчёт **не** пишем: только имя, домен, атрибуты и хеш при необходимости (минимизация данных; формулировки — к заказчику).

### 1.4 Ожидание «тишины» вместо `networkidle`

Почему `networkidle` не годится:
- по документации Playwright он означает «нет соединений ≥ 500 мс» и помечен **DISCOURAGED** ✔;
- на реальных сайтах есть long-polling, heartbeat-пинги Hotjar и чатов, видео и стримы, поэтому состояние либо не наступает (уход в таймаут), либо наступает **раньше** таймерных тегов: GTM Timer, отложенная загрузка через 3–5 с, ленивые виджеты;
- 500 мс — слишком короткое окно для цепочек GTM → тег → пиксель.

Предлагаемый алгоритм (параметры — стартовые, калибровать на 10 эталонных сайтах):

```text
goto(url, waitUntil='domcontentloaded', timeout=30s)
wait for 'load' (max 15s, не фатально → evidence.pageLoadIncomplete=true)
t0 = now
loop:
  inflight = started − finished − failed   (без websocket, eventsource, media-range)
  quiet = (now − lastRequestStart ≥ 2000ms) && inflight ≤ 1
  if (now − t0 ≥ MIN_DWELL=6s && quiet) break
  if (now − t0 ≥ HARD_CAP=20s) { evidence.quietNotReached=true; break }
```

- Фаза A (до согласия) — `MIN_DWELL` 6 с, `HARD_CAP` 20 с. Затем A′ (нейтральная интерактивность, раздел 7.2) и повтор цикла с `MIN_DWELL` 3 с и `HARD_CAP` 10 с.
- Фазы B и C — `MIN_DWELL` 4 с, `HARD_CAP` 12 с.
- `page.clock` (fake timers) для «ускорения» таймерных тегов **не** включать по умолчанию: меняет `Date` и ломает сайты. Разве что как экспериментальный флаг.
- Ошибки сети (`ERR_NAME_NOT_RESOLVED`, TLS-ошибки) на главной считаются «сайт недоступен». Каким кодом выхода это оформлять, решаем отдельно (открытый вопрос): ТЗ резервирует `2` только для «сканер сам упал».

---

## 2. Cookies и хранилища

### 2.1 Источники

| Способ | Что возвращает | Комментарий |
|---|---|---|
| `context.cookies()` | Все cookies контекста (вкл. `httpOnly`, third-party, `partitionKey` с 1.54) ✔ | **Основной снимок по фазам** |
| CDP `Storage.getCookies` | То же + `size`, `priority`, `sourceScheme`, `sourcePort`, `partitionKey` (объект), `partitionKeyOpaque` ✔ | Для расширенных полей. `Network.getAllCookies` в CDP **deprecated**, «use Storage.getCookies» ✔ |
| `response.headersArray()` / CDP `Network.responseReceivedExtraInfo` | Сырые `Set-Cookie` каждого ответа; в CDP — `blockedCookies` с причиной и `exemptedCookies`, `cookiePartitionKey` ✔ | Доказательство **кто** поставил cookie (ответ какого хоста). Видны и cookies, которые Chrome отверг: попытка тоже факт |
| CDP `requestWillBeSentExtraInfo.associatedCookies` | Какие cookies ушли с запросом (и какие заблокированы) ✔ | Доказательство «cookie отправлена третьей стороне» |
| Init-script-хук `Document.prototype.cookie` (setter) и `CookieStore.prototype.set/delete` | Записи cookies из JS со стеком → URL скрипта | Отличает `document.cookie` от `Set-Cookie` и атрибутирует `_ga` к `gtag.js`. Ставить через `context.addInitScript` (выполняется в каждом фрейме) |

**Set-Cookie vs `document.cookie`.** Различие важно для доказательства и для HDR-02:
- `Set-Cookie` виден в сети, может быть `HttpOnly`, атрибутируется к хосту ответа;
- JS-cookie не видна в сети, всегда не-`HttpOnly`, её «автор» — скрипт.

Хук должен только **наблюдать**: вызвать оригинальный дескриптор и записать имя, домен, стек. Значение не логируем. Хук сам по себе — вмешательство в страницу, поэтому минимальный, без изменения семантики. `cookieStore` (Chromium) обходит `document.cookie`, его тоже оборачиваем.

### 2.2 Third-party и partitioned (CHIPS)

- В Playwright-Chromium третьи стороны **могут** ставить non-partitioned cookies: тест Playwright `browsercontext-cookies-third-party.spec.ts` ожидает для Chromium разрешение ✔. Наш эксперимент подтверждает это для headless-shell, CfT и Chrome stable в `newContext()` ✔ [эксп.]. В обычном Chrome 3PC тоже включены по умолчанию: 22.04.2025 Google объявил, что сохраняет текущий подход и не выкатывает отдельный промпт; в Incognito 3PC блокируются по умолчанию ✔ (privacysandbox.google.com). Нам это и нужно: видеть то, что увидит типичный посетитель. Для persistent-профиля (7.2) повторить проверку ⚠.
- Partitioned cookies (CHIPS) приходят с `partitionKey`. В отчёте показываем, но **ключ сравнения** по фазам — `(name, domain, path, partitionKey)`.
- Storage Access API: при разрешённых 3PC `requestStorageAccess()` в Chromium разрешается без промпта ⚠. Для MVP можно игнорировать, но фиксировать вызовы (hook) как сигнал.
- Ограничение: `ThirdPartyStoragePartitioning` выключен Playwright ✔, то есть localStorage в third-party iframe **не** партиционирован, в отличие от реального Chrome. В отчёте — «Messumgebung»-примечание.

### 2.3 localStorage / sessionStorage / IndexedDB

| Хранилище | Как снимать | Примечание |
|---|---|---|
| localStorage | `context.storageState()` → `origins[].localStorage` ✔ | Какие origin-ы попадают (в т. ч. origin-ы third-party iframes) — проверить фикстурой ⚠. Надёжнее дополнять `frame.evaluate` по всем фреймам и CDP `DOMStorage.domStorageItemAdded` («кто и когда писал») |
| IndexedDB | `context.storageState({ indexedDB: true })` (с 1.51) ✔ | Дорого; по умолчанию снимаем только **имена баз** (`indexedDB.databases()` в каждом фрейме), содержимое — опционально |
| sessionStorage | Не входит в `storageState`. `frame.evaluate(() => Object.keys(sessionStorage))` для каждого фрейма | Cross-origin фреймы Playwright тоже позволяет evaluate |
| OPFS | `storageState({ opfs: true })` (с 1.63) ✔ | P2 |

Трекинговые ID в localStorage (например, `_hjSession*`, `tt_*`) юридически под §25 TDDDG так же, как cookies: это «Zugriff auf Endgeräte» (оценка — за заказчиком). Поэтому в CONSENT-02 и schema нужно поле `storageType: cookie | localStorage | sessionStorage | indexedDB`.

### 2.4 Снимки по фазам

Каждая фаза — **отдельное чистое хранилище**: свежий временный persistent-профиль (рекомендация 7.2) или, как упрощение, отдельный `BrowserContext` в одном `Browser`. Снимок берём после окна тишины каждой страницы и в конце фазы. Сравниваем по ключам (2.2). Признаки в выходных данных:
- `firstSeenPhase`, `firstSeenUrl`, `setBy: header|js|unknown`, `setterUrl`;
- `lifetime` (expires − now; сессионная или нет);
- `sameSite`, `secure`, `httpOnly`, `partitionKey`.

После фазы B (отказ) отдельно фиксируем cookies, которые **остались или появились** после отказа (для CONSENT-05).

---

## 3. Анти-бот и реализм

### 3.1 Режимы headless в 1.64

| Режим | Как включить | Что это | За | Против |
|---|---|---|---|---|
| Headless shell (по умолчанию) | `chromium.launch()` | Отдельная сборка `chrome-headless-shell` | Быстрее, меньше. `--only-shell` в Docker | Не «настоящий Chrome». UA `HeadlessChrome/156.0.8078.4`; **brand `HeadlessChrome` в `Sec-CH-UA`, который не убирается override-ом UA** ✔ [эксп.] |
| New headless | `chromium.launch({ channel: 'chromium' })` | Полноценный Chrome for Testing без окна | Максимальная похожесть на реальный Chrome (Chrome: «real Chrome browser») ✔. Brands без `HeadlessChrome` ✔ [эксп.] | Больше места на диске и в образе. UA всё равно с `HeadlessChrome` → override ✔ [эксп.] |
| Headed + Xvfb | `headless: false` под `xvfb-run` | Полноценный Chrome с окном | Максимальная похожесть | Сложнее в CI, медленнее; без явной пользы перед new headless |

Размеры загрузки для linux64, версия 156.0.8078.4 (`cdn.playwright.dev/builds/cft/…` → 307 на `storage.googleapis.com/chrome-for-testing-public/…`) ✔ HEAD-запросом: `chrome-headless-shell-linux64.zip` — **125.8 МБ**, `chrome-linux64.zip` — **200.3 МБ** (в архиве).

**Рекомендация:** по умолчанию `channel: 'chromium'` (new headless). На нашей задаче важна достоверность поведения CMP, а не скорость, а headless-shell выдаёт `HeadlessChrome` в Client Hints даже после подмены UA ✔ [эксп.]. Флаг `--engine shell` — для быстрых прогонов, с пометкой в отчёте. Итог зафиксировать после замера на эталонных сайтах.

### 3.2 Как CMP распознают ботов (по исходникам, 2026-10-30)

| CMP | Логика (исходник) | Что происходит с «ботом» | Статус |
|---|---|---|---|
| **Cookiebot** (`consent.cookiebot.com/uc.js`) | `isSpider()` = регулярка по `navigator.userAgent` с конкретными токенами: `Googlebot/`, `bingbot/`, `Chrome-Lighthouse`, `PTST/`, `SEMrushBot`, `Siteimprove`, `Prerender/`, `webvitals.dev` и др.; общего `bot` **нет**. Отключается параметром **URL страницы** `?g_disable_bot_detection=1` (`getDomainUrlParam` читает `window.location.href`) | `if (this.isSpider()) return void this.setOutOfRegion()` → `consented=true`, все категории `true`, баннера нет | ✔ |
| **Complianz** (`complianz.js`, trunk) | `cmplz_is_bot()` — длинная регулярка (googlebot, bingbot, `java`, `wget`, `curl`, `nutch`, …); `cmplz_is_speedbot()` = `GTmetrix\|pingdom\|pingbot\|Lighthouse` | Бот → `cmplz_has_consent()` возвращает `true` (все скрипты разрешены); speedbot → баннер отключён | ✔ |
| **Real Cookie Banner** (wp.org, lite build) | Встроенная копия регулярки `isbot` (`http`, `\.com\b`, `scan`, `headless`, `check`…) + исключение Lighthouse. Отдельный детектор CMP-краулеров (`(cookiebot\|2gdpr).com` в UA, cookie `cmpcrawler…`). Настройка `accept-all-for-bots`, **по умолчанию `true`** (`Consent.php`) | Бот → решение `"all"` без баннера. Плюс `isRespectDoNotTrack` → при DNT автоматическое решение | ✔ |
| **Borlabs Cookie 3.5.0** (живой бандл на borlabs.io) | `isBot()` = `/bot\|googlebot\|crawler\|spider\|robot\|crawling\|lighthouse\|anthropic-ai\|chatgpt-user\|…/i` | Если `cookiesForBots` → `saveConsentAll()`. На borlabs.io `cookiesForBots: true`. Также `respectDoNotTrack` → только essentials | ✔ (v3.5); v2 — по вторичным источникам была опция «Cookies for Bots/Crawlers» ⚠ |
| **Usercentrics v3** (`web.cmp.usercentrics.eu/ui/loader.js`) | `isUserBot()` = регулярка: `AdsBot-Google`, `bingbot/`, `Chrome-Lighthouse`, `Googlebot/`, **`HeadlessChrome`**, `Lighthouse`, `Optimizer`, `Pagespeed`, **`Playwright/`**, `SISTRIX`, `Slurp/` … | Функция экспортируется из лоадера; **где и как применяется** (скрыть баннер или «принять всё») — в другом чанке, не анализировалось ⚠ | ✔ регулярка / ⚠ эффект |
| **CCM19**, **CookieHub** | ⚠ не проверено. В `isbot` есть паттерн `cookiehubverify/` (собственный верификатор CookieHub) | — | ⚠ |

Проверка кандидатов UA (регулярки, извлечённые из исходников выше; [эксп.] локально):

| UA | isbot 5.2.2 | Real Cookie Banner | Complianz `is_bot` | Cookiebot `isSpider` | Borlabs 3.5 `isBot` |
|---|---|---|---|---|---|
| Дефолтный headless-shell (`… HeadlessChrome/156…`) | **бот** (`headless`) | **бот** (`Headless`) | нет | нет | нет |
| Обычный Chrome (`… Chrome/156.0.0.0 Safari/537.36`) | нет | нет | нет | нет | нет |
| Chrome + `dsgvo-check/0.1 (+https://github.com/…)` | **бот** (`http`, `\.com\b`, `check\b`) | **бот** (`check`) | нет | нет | нет |
| Chrome + `dsgvo-check/0.1` (без URL) | **бот** (`check\b`) | **бот** (`check`) | нет | нет | нет |

Вывод: для Cookiebot, Complianz и Borlabs честный суффикс безопасен, пока в нём нет `bot`, `crawler`, `spider`, `robot`. **Осторожно с именем организации на GitHub** в ссылке: `…/somebot-org/…` включит Borlabs. Для Real Cookie Banner и любых сайтов на `isbot` честный суффикс небезопасен. `navigator.webdriver` и `Intl…timeZone` в проанализированных бандлах Cookiebot, Complianz, RCB (4 чанка) и Borlabs 3.5 (3 чанка) **не встречаются** ✔ (grep). Лениво подгружаемые чанки диалогов не анализировались ⚠.

### 3.3 Политика реализма — что делаем и чего не делаем

Делаем (это не маскировка, а «типичный посетитель из DE»):
- `locale: 'de-DE'` → `navigator.language(s)` и `Accept-Language`. Playwright передаёт locale в `Emulation.setUserAgentOverride.acceptLanguage` ✔, то есть заголовок будет `de-DE`. Для реализма можно задать `Accept-Language: de-DE,de;q=0.9,en;q=0.8` через `extraHTTPHeaders` ⚠ (проверить, что не дублируется);
- `timezoneId: 'Europe/Berlin'`: часть баннеров решает «ЕС/не ЕС» по `Intl…timeZone` на клиенте ⚠ (встречается у лёгких CMP; у 7 целевых не подтверждено);
- viewport десктоп 1440×900 по умолчанию; мобильный профиль — отдельный прогон P1 (баннеры на мобильных часто другие);
- не отправлять `DNT`/`Sec-GPC` по умолчанию: RCB и Borlabs при DNT сами принимают решение без баннера ✔, и мы получим ложное «баннера нет».

Не делаем: stealth-плагины (подмена `navigator.webdriver`, плагинов, WebGL), обход CAPTCHA, обход WAF/Cloudflare. Это противоречит требованию «честный UA» и пассивности. Если сканер заблокирован (403 или страница-челлендж), выдаём `SCAN-BLOCKED` (info/warning) и не делаем выводов о CONSENT.

### 3.4 User-Agent: рекомендация

1. Формат: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major реального движка>.0.0.0 Safari/537.36 dsgvo-check/<ver> (+https://github.com/<org>/dsgvo-check)`.
   - Версию берём из `browser.version()`, не врём.
   - Токен `HeadlessChrome` заменяем: он ничего не сообщает владельцу сайта, но гарантированно включает бот-детекторы RCB, `isbot` и Usercentrics v3.
   - Честность обеспечивают имя продукта и ссылка.
2. **Client Hints:** Playwright при `userAgent` задаёт `userAgentMetadata` без `brands` ✔ (исходник `calculateUserAgentMetadata`). Значит, `navigator.userAgentData.brands` и `Sec-CH-UA` остаются от браузера. В headless-shell это `"HeadlessChrome";v="156"` **и после override** ✔ [эксп.], в CfT new headless — `Chromium` ✔. Ещё один довод за CfT. Подменять brands через CDP `Emulation.setUserAgentOverride` можно, но это уже маскировка — не делаем.
3. **Измерение, а не вера:** на 10 эталонных сайтах прогнать пары «UA с суффиксом / UA без суффикса» из одной гео-точки. Сравнивать: найден ли баннер, cookies и трекеры в фазе A, состояние CMP. Если разница есть хотя бы на одном сайте с RCB или Borlabs — обсудить с заказчиком компромисс. Варианты компромисса:
   - (а) ссылку оставить в UA и принять бот-режим у RCB и `isbot` (с детектором и понижением, п. 4);
   - (б) в UA — только токен продукта без `http` и без `check` (влияет на выбор имени). Контакт — в заголовке `From:`. По RFC 9110 §10.1.2 ✔ это **e-mail** (mailbox, не URL); «robotic user agent SHOULD send a valid From», но без явной настройки пользователем его слать не следует. Поэтому только опцией `--contact <email>`. Клиентский JS заголовок не видит, но он уходит **всем** хостам, включая третьи стороны;
   - (в) ссылка в UA только для HTTP-проб без браузера (заголовки, FILE-01, security.txt), а браузер — с нейтральным токеном.

   **Решение — за заказчиком** (юр. и этическая сторона), это открытый вопрос.
4. **Рантайм-детектор бот-режима** (обязателен независимо от UA):
   - Cookiebot: `Cookiebot.isSpider?.() === true` или `Cookiebot.isOutOfRegion === true`;
   - Complianz: сначала `complianz.region` (`eu` ожидаем); если регион `eu`, а `cmplz_has_consent('marketing') === true` без consent-cookie `<prefix>marketing`, то это бот-режим;
   - RCB / Borlabs: consent-cookie `real_cookie_banner*` / `borlabs-cookie` **появилась без нашего клика** с полным набором согласий;
   - общий признак: consent-cookie CMP появилась в фазе A без взаимодействия.

   При срабатывании все CONSENT-0x этой фазы понижаются до `warning` с кодом `SCAN-BOTMODE`, в отчёте — честное объяснение.

---

## 4. Гео-таргетинг CMP

### 4.1 Где реально запускается сканер

| Платформа | Регион | Статус |
|---|---|---|
| GitLab.com hosted runners (Linux) | Google Cloud, **по умолчанию `us-east1`** | ✔ docs.gitlab.com |
| GitHub-hosted runners | Документация регионы **не называет**. IP Linux-раннеров «not limited to Azure datacenter ranges» ✔. Принятый ответ в GitHub Community от 19.02.2021: East US, East US 2, West US 2, Central US, South Central US, регион выбрать нельзя. Вопрос «актуально ли» (03.2026) остался без ответа | ⚠ (данные 2021 г.) |
| GitHub larger runners | Static IP, Azure private networking (регион задаётся подсетью Azure) | ⚠ доступность регионов ЕС проверить |
| Self-hosted runner в ЕС / локальный запуск | Контролируется пользователем | — |

Вывод: для типичного пользователя GitHub Action и GitLab-шаблона IP будет **не из ЕС**.

### 4.2 Как CMP решают «показывать ли баннер»

| CMP | Механизм | Что видит сканер из США | Как распознать (сигнал) | Статус |
|---|---|---|---|---|
| Cookiebot | Premium Geotargeting по анонимизированному IP (сторонний сервис) | Вне региона: `CookieConsent=-1`, `isOutOfRegion=true`, всё принято, баннера нет | Cookie `CookieConsent` со значением `-1`; `Cookiebot.isOutOfRegion`; `Cookiebot.regulations.gdprApplies` | ✔ (uc.js + developer docs) |
| Usercentrics | Geolocation Rulesets; правило по умолчанию может быть «без баннера» | **CMP работает в фоне, все сервисы согласованы по умолчанию**, баннера нет | v3: `__ucCmp.isConsentRequired()` (есть в API ✔); v2: ⚠ | ✔ поведение по докам; сигнал ⚠ в прототипе |
| Complianz (Premium GeoIP) | IP → страна → регион | США: **opt-out-баннер** (без «Ablehnen»-логики opt-in!); «other»: без баннера, всё разрешено | `complianz.region`, `complianz.consenttype`; классы `body.cmplz-eu\|cmplz-us\|cmplz-other` | ✔ (complianz.js, docs) |
| Borlabs 3.x | `dialogGeoIpActive` → REST `borlabs-cookie/v1/dialog/visibility` | Баннер не показывается, `consentRequired=false` | `borlabsCookieConfig.settings.dialogGeoIpActive`; ответ REST `visible:false` | ✔ (бандл 3.5.0) |
| Real Cookie Banner | Динамические pre-decision через REST `/consent/dynamic-predecision` (Pro; по вторичным источникам — «Geo-Restriction»/country bypass) | ⚠ | Наличие REST-вызова; решение без баннера | ⚠ |
| CookieHub, CCM19 | ⚠ | ⚠ | ⚠ | ⚠ |
| IAB TCF (любая TCF-CMP) | `gdprApplies` | `false` вне ЕС | `__tcfapi('ping', 2, cb)` → `gdprApplies`, `cmpId` | ✔ стандарт TCF v2 |
| Google Consent Mode | `gtag('consent','default',{…, region:[…]})` | Для не-перечисленных регионов действует default без `region` (часто `granted`) | Читать `region` из `dataLayer` (раздел 6) | ✔ developers.google.com |

### 4.3 Варианты решения

| Вариант | Как | За | Против |
|---|---|---|---|
| **`--proxy`** (HTTP/SOCKS5, ЕС-выход) | `chromium.launch({ proxy })` или per-context (в CDP `Target.createBrowserContext` есть `proxyServer` ✔) | Работает в любом CI; честно (мы и правда «из DE») | Нужен прокси у пользователя; учётку держать в CI-секрете; `serverAddr()` покажет прокси ⚠ |
| **Self-hosted runner в ЕС** | Документировать в README | Наиболее достоверно | Инфраструктура пользователя |
| **Детект + понижение** (обязательно всегда) | Гео-сигналы из 4.2 → `SCAN-GEO` (`warning`), CONSENT-03/04 не выдавать как critical | Защищает от ложных падений CI | Не даёт ответа «как для DE» |
| `?uc_cmp_country=DE` (Cookiebot **и** Usercentrics v3) | Cookiebot `uc.js` читает `uc_cmp_country` из `window.location.search` и передаёт `usercountry` в запрос конфигурации ✔. Лоадер Usercentrics v3 читает тот же параметр (`UC_GEO_PARAM`, формат `DE` или `DE-BY`) как `userLocation` ✔ (исходники). Usercentrics v2 — тестовый override через sessionStorage (`countryCode`/`regionCode`) по их help-страницам ⚠ | Без прокси; покрывает две из 7 CMP | Нигде не документировано, поведение сервера ⚠; меняет URL страницы (кэш и аналитика сайта). Только как опция `--cmp-geo-hint DE`, не по умолчанию, с пометкой в отчёте |
| `--assume-region eu` | Пользователь подтверждает, что запуск из ЕС | Простая подсказка для отчёта | Не меняет поведение сайта |

Внешний сервис «узнать свою страну по IP» сканер **по умолчанию не вызывает**: лишняя передача данных третьему лицу, неуместная для DSGVO-инструмента. Опционально — `--geo-check-url <url>` по выбору пользователя.

Псевдокод решения для CONSENT-03:

```text
if thirdPartyServicesBeforeConsent && !bannerDetected:
  if geoSignal (CookieConsent=-1 | isOutOfRegion | gdprApplies=false | isConsentRequired=false | cmplz-us/other | borlabs visible=false):
      emit SCAN-GEO (warning): "Banner vermutlich wegen Standort nicht angezeigt (…Signal…)"
  elif botSignal: emit SCAN-BOTMODE (warning)
  elif knownCmpPresent && cmpHiddenOnThisPage (z. B. Borlabs dialogHideDialogOnPages): skip on this page
  else: emit CONSENT-03 (уровень — по каталогу заказчика)
```

---

## 5. Распознавание и управление баннером

### 5.1 Модель адаптера (проверка независима от ядра)

```text
interface CmpAdapter {
  id: 'borlabs' | 'cookiebot' | …
  detect(page): {present, version?, confidence}            // скрипт, глобал, DOM-сигнатура
  state(page): {hasResponse, categories{…}, raw}             // через JS-API / consent-cookie, только чтение
  geoSignals(page), botSignals(page)
  firstLayer(page): {container, buttons[{role,label,kind,box,visible,contrast}]}
  reject(page): ClickResult      // реальный клик по UI первого уровня; fallback — путь через «Einstellungen» (помечается)
  accept(page): ClickResult
  verifyRejected(page): {uiClosed, stateDenied, cookieDenied, persistedAfterReload}
}
```

Правила:
- JS-API CMP используем **только для чтения** состояния в фазах A и B. Для фазы C (инвентаризация «после принятия») API можно использовать как fallback;
- клик — `locator.click()` без `force`. Actionability-проверки Playwright (видимость, стабильность, получение событий, enabled) — это и есть проверка «кнопка доступна человеку». Если кнопку перекрывает другой элемент, это доказательство для CONSENT-04, а не повод кликать JS-ом;
- после клика проверяем три независимых факта: UI закрылся; состояние CMP или consent-cookie = отказ; трекеры не пошли (основа CONSENT-05).

### 5.2 Семь целевых CMP

Селекторы — из правил `@duckduckgo/autoconsent@17.1.0` ✔ (поддерживаются сообществом и обновляются почти ежедневно) и из исходников и доков вендоров. Всё, что помечено ⚠, проверить на живых сайтах из списка заказчика.

| CMP | Детект | Контейнер / первый уровень | «Ablehnen» на первом уровне | Чтение состояния | Особенности |
|---|---|---|---|---|---|
| **Borlabs v3** | `window.BorlabsCookie` (v3: `Consents`, `ServiceGroups`… ✔), `window.borlabsCookieConfig`; DOM `.brlbs-cmpnt-dialog` | `#BorlabsCookieBox` → `.brlbs-cmpnt-dialog` | `.brlbs-btn-accept-only-essential` ✔ (autoconsent) | Cookie `borlabs-cookie` (JSON, `consents`, `v3:true`) ✔; `BorlabsCookie.Consents.hasConsent(id)` ✔ | `dialogShowDialogAfterUserInteraction` (баннер только после keydown/scroll) ✔; `dialogHideDialogOnPages` (на Impressum/Datenschutz баннера нет — это норма) ✔; `cookiesForBots`, `respectDoNotTrack`, GeoIP ✔; параметр `?borlabs-cookie-skip-dialog` ✔ |
| **Borlabs v2** | DOM `._brlbs-bar-wrap`, `._brlbs-box-wrap`, `._brlbs-block-content` | `#BorlabsCookieBox` | `a[data-cookie-refuse]` ✔ (autoconsent) | Cookie `borlabs-cookie` (`consents.statistics…`) ✔ | v2 ещё живёт на многих сайтах (VULN-02: Borlabs среди частых устаревших) |
| **Cookiebot** | `window.Cookiebot` / `window.CookieConsent`; `script[src*="consent.cookiebot.com/uc.js"]` (или `.eu`) | `#CybotCookiebotDialog` | `#CybotCookiebotDialogBodyButtonDecline` или `#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll` ✔ | `Cookiebot.consent.{preferences,statistics,marketing}`, `hasResponse`, `declined`, `consent.method` (`implied\|explicit`) ✔; cookie `CookieConsent` ✔ | Режим `data-level="implied"` / `data-type="optout"`: согласие без клика → отдельная находка; `isSpider`, `isOutOfRegion` (3.2, 4.2) |
| **Complianz** | `window.complianz`, `cmplz_has_consent` ✔; `#cmplz-cookiebanner-container` | `.cmplz-cookiebanner` | `.cmplz-deny` ✔ | Cookies `complianz.prefix` + категория (обычно `cmplz_marketing`/`_statistics`/`_preferences`), а также `…banner-status`, `…consented_services`, `…policy_id` ✔ (complianz.js); `cmplz_get_banner_status()` ✔ | `complianz.region`, `consenttype` (`optin`/`optout`); старые версии — тема `cc-window` (правила `complianz-optin`/`-categories` в autoconsent) |
| **Usercentrics** | v3: `window.__ucCmp` ✔; v2: `window.UC_UI` ✔ (autoconsent); `#usercentrics-cmp-ui` (v3), `#usercentrics-root` (v2) | **Shadow DOM** (v3: «CMP housed in Shadow DOM», `#uc-main-dialog` ✔) | v3: `[data-action-type=deny]`; v2: `[data-testid=uc-deny-all-button]` ✔ (autoconsent) | v3: `__ucCmp.getConsentDetails()`, `isConsentRequired()` ✔; v2: `UC_UI.areAllConsentsAccepted()` ✔ | Open shadow DOM Playwright пробивает по умолчанию ✔; `isConsentRequired()` — гео-сигнал |
| **CCM19** | `script[src*='ccm19'][src*='/app.js?apiKey=']`, `#ccm-widget` ✔ | `#ccm-widget.ccm-show` | `.ccm--decline-cookies` ✔; иначе панель `ccm-control-panel` (второй уровень) | Хранение в cookie или localStorage в зависимости от настройки ✔ (autoconsent); JS-API ⚠ (документация не найдена) | Виджет инжектится поздно → ждать до `HARD_CAP` |
| **Real Cookie Banner** | `window.consentApi` (`consent`, `consentAll`, `consentSync`, `unblock`) ✔; `div[consent-skip-blocker="1"][id][data-bg]` (id — случайный UUID на запрос ✔) | `… > dialog` | Кнопка `a[role=button]:not([id])` или текст «… ohne …»/«Ablehnen» ✔ (autoconsent) | `consentApi.consentSync(...)` (у стаба до загрузки — значения по умолчанию ✔); cookie `real_cookie_banner*` ⚠ | `accept-all-for-bots` = true по умолчанию ✔; DNT-логика ✔; классы и ID обфусцированы → только структурные селекторы |
| **CookieHub** | `window.cookiehub` (`hasAnswered`, `hasConsented`, `denyAll`…) ✔; `.ch2-container` | `.ch2-dialog` | Нет гарантированной кнопки на первом уровне; autoconsent идёт через `.ch2-open-settings-btn` → `.ch2-deny-all-btn` ✔ | `cookiehub.hasAnswered()`, `hasConsented(cat)` ✔; cookie `cookiehub` ✔ (autoconsent test) | CookieHub прямо пишет, что `denyAll()` не должен обходить UI-выбор пользователя — нам тем более: только чтение |

TCF-слой (если есть): `__tcfapi('ping',2,cb)` → `cmpLoaded`, `gdprApplies`, `cmpId`; `__tcfapi('addEventListener',2,cb)` → `eventStatus` (`cmpuishown` / `useractioncomplete` / `tcloaded`) и `purpose.consents`. `__cmp` — это API TCF v1 (выведен из обращения), считаем его только сигналом «старая CMP». IAB GPP (`__gpp`) — P2.

### 5.3 Iframes и shadow DOM

- **Open shadow DOM**: CSS-локаторы и `getByRole` Playwright пробивают его по умолчанию. XPath — **нет** ✔. Значит, только CSS и role-локаторы, без XPath (в правилах autoconsent для RCB есть XPath — переписать).
- **Closed shadow DOM**: Playwright не поддерживает ✔. Варианты:
  - (а) CDP `DOM.getDocument({depth:-1, pierce:true})` — по описанию протокола обходит iframes и shadow roots ✔; закрытые тоже ⚠ — для **чтения** (кнопки, тексты);
  - (б) init-скрипт, форсирующий `attachShadow({mode:'open'})`, — вмешательство, только за флагом;
  - (в) если нельзя кликнуть законно — `info: Banner nicht vollständig auswertbar`.
- **Iframes** (Sourcepoint, consentmanager.net, TrustArc и т. п.): `page.frameLocator()` без селектора ищет в любом фрейме ✔. Cross-origin OOPIF Playwright обслуживает сам.

### 5.4 Обобщённая эвристика для неизвестных баннеров

**Кандидаты:** видимые элементы в main frame, open shadow roots и iframes, у которых выполняется хотя бы одно:
- `role=dialog|alertdialog` / `aria-modal=true` / `<dialog open>`;
- `position: fixed|sticky` и z-index выше контента;
- покрытие ≥ 15 % вьюпорта или полоса у верхнего или нижнего края.

Кроме того, в тексте должны быть ключевые слова (`Cookie`, `Einwilligung`, `Datenschutz`, `Tracking`, `Dienste`, `Partner`, `personenbezogen`, `Drittanbieter`, en-аналоги).

**Кнопки:** `button`, `[role=button]`, `a`, `input[type=button|submit]`. Метка — accessible name. Классификация по регуляркам (немецкий + английский):

| Класс | Примеры (нормализованный lowercase) |
|---|---|
| reject | `ablehnen`, `alle ablehnen`, `nur (technisch )?notwendige`, `nur essenzielle`, `nur erforderliche`, `weiter ohne (einwilligung\|zustimmung)`, `mit notwendigen fortfahren`, `nicht zustimmen` |
| accept | `alle akzeptieren`, `akzeptieren`, `zustimmen`, `einverstanden`, `alle zulassen`, `ok` |
| settings | `einstellungen`, `anpassen`, `individuelle`, `mehr optionen`, `details`, `cookie-einstellungen` |
| save | `auswahl (speichern\|bestätigen)`, `speichern` |
| close-ambiguous | `×`, `schließen`, `verbergen`, `später` |

В `@duckduckgo/autoconsent/heuristics` уже есть немецкие паттерны (`alles? ablehnen`, `nur … essenzielle … cookies`, …) и чистая функция `classifyButtonTextRegex` ✔. Её можно использовать как зависимость (MPL-2.0 — файловый copyleft, с Apache-2.0 совместим при использовании пакета без модификации ⚠ юр. подтверждение у заказчика).

**Оценка уверенности (стартовая, калибровать):**

| Сигнал | Вес |
|---|---|
| Адаптер известной CMP сработал (скрипт или глобал + DOM) | 0.6 |
| `role=dialog` / `aria-modal` / `<dialog>` | 0.15 |
| Плотность consent-ключевых слов ≥ 2 разных | 0.15 |
| Найдена кнопка класса accept | 0.1 |
| Кнопка из «settings» ведёт к панели с переключателями категорий | 0.1 |
| Все кнопки первого уровня классифицированы (нет `unknown`) | обязательное условие для CONSENT-04 без адаптера |

**Решения:**
- Известная CMP и на первом уровне есть accept, но нет reject (в т. ч. reject только в `settings`, или вместо него `close-ambiguous`) → **CONSENT-04** (уровень по каталогу);
- неизвестная CMP, score ≥ 0.8, все кнопки классифицированы, accept есть, reject нет → **CONSENT-04** с пометкой `heuristic`. Это обсудить с заказчиком: возможно, для эвристики оставить только `warning`;
- иначе → `info: Banner nicht erkannt` / `Ablehnen-Option nicht eindeutig klassifizierbar` (требование ТЗ — никакого ложного CONSENT-04).

**Доказательство «равноценности»** — это юридическая оценка заказчика. Мы даём метрики, а не вывод:
- обе кнопки видимы без скролла;
- площадь кнопок и их отношение;
- контраст текста и фона (WCAG-формула);
- тип элемента (кнопка или текстовая ссылка);
- скриншот баннера (`locator.screenshot()`).

### 5.5 `@duckduckgo/autoconsent` — брать ли зависимостью

| Что даёт | Чего не хватает для нас |
|---|---|
| Правила для всех 7 CMP; всего 881 JSON-правило + 13 CMP-классов на TS (`lib/cmps`, считая `base.ts`/`all.ts`) ✔ | **Нет понятия «первый уровень»**: `optOut` легитимно идёт через «Einstellungen» и снятие чекбоксов (Borlabs v2, CookieHub, CCM19, Complianz-categories) ✔ |
| Сборка `dist/autoconsent.playwright.js` (IIFE для инъекции) и гайд для Puppeteer ✔ | Cookiebot-opt-out через **`Cookiebot.withdraw()` + `hide()`**, то есть через API, а не UI ✔ |
| Эвристики детекта попапов и классификации кнопок, в т. ч. немецкие ✔ | `prehide`/cosmetic скрывают баннер CSS-ом. Для нас это **недопустимо** (прятать улики), отключать `enablePrehide`, `enableCosmeticRules` |
| Self-test (`test`) — проверка эффекта | Часть self-test по cookie, часть — «баннер не виден», это не равно «отказ сохранён» |
| — | MPL-2.0 + частые мажорные релизы (16.x → 17.x за сутки) → пинить версию; правила — данные, их нужно ревьюить |

**Рекомендация:** использовать как (1) резервный детектор CMP за пределами 7 адаптеров, (2) источник эвристик классификации кнопок, (3) справочник селекторов. **Вердикт CONSENT-04/05 — только из наших адаптеров** с протоколом 5.1.

---

## 6. Google Consent Mode v2 (CONSENT-06) и server-side tagging

### 6.1 Источники состояния

| Источник | Что читаем | Надёжность |
|---|---|---|
| `window.dataLayer` | Объекты-`arguments` от `gtag()`: `{0:'consent',1:'default',2:{ad_storage,analytics_storage,ad_user_data,ad_personalization,…, wait_for_update, region}}` и `'update'`; порядок относительно `'js'`/`'config'`/событий | Высокая, если сайт использует gtag/GTM-шаблон CMP. Снимать в конце каждой фазы; первые элементы массива сайт обычно не трогает |
| `google_tag_data.ics` | Внутреннее состояние consent (default/update по типам) | ⚠ недокументировано — только как вспомогательный сигнал |
| Параметры запросов к Google (GA4 `…/g/collect`, Ads, Floodlight): `gcs`, `gcd`, `dma`, `dma_cps`, `npa` | Фактически переданное состояние | Высокая: это то, что **получил Google** (формулировка из каталога: «CMP сообщает analytics=false, а Google получает granted») |
| CMP-API (раздел 5.2) | Что CMP «думает» | Для сравнения «CMP vs Google» |

Типы согласия: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization` (+ `functionality_storage`, `personalization_storage`, `security_storage`) ✔. Basic mode: до взаимодействия **ничего** не отправляется Google. Advanced: теги грузятся сразу и шлют «measurements without cookies» при `denied` ✔.

### 6.2 Декодирование `gcs` и `gcd`

**`gcs`** = `G1` + `ad_storage` + `analytics_storage` (1 = granted, 0 = denied): `G100`, `G110`, `G101`, `G111`.

**`gcd`**: официальной спецификации Google нет ⚠. Сообщество (Complianz, Stape/analytics-debugger, Lukas Wojcik, consentmodehq) сходится на формате `1<x><ad_storage><x><analytics_storage><x><ad_user_data><x><ad_personalization><…>`, например `13r3r3r3r5`, `11p1p1p1p5`, `13l3l3l3l1`. Буква — символ алфавита base64url (`0-9a-zA-Z-_`); по шаблону analytics-debugger `default = (idx>>2)&3`, `update = idx&3`, где 1 = не задано, 2 = denied, 3 = granted. Расчёт по этой формуле совпадает с таблицей Complianz:

| Буква | default | update | Эффективно | Интерпретация до клика |
|---|---|---|---|---|
| `l` | не задано | не задано | — | Consent Mode для сигнала не настроен |
| `p` | denied | — | denied | Корректно |
| `q` | denied | denied | denied | Корректно (после отказа) |
| `t` | **granted** | — | granted | **CONSENT-06** |
| `r` | denied | granted | granted | До клика быть не должно → CMP шлёт update без согласия |
| `m` | — | denied | denied | update без default |
| `n` | — | granted | granted | **подозрительно** до клика |
| `u` | granted | denied | denied | default granted (плохо), потом исправлено |
| `v` | granted | granted | granted | **CONSENT-06** до клика |

**Правила CONSENT-06** (предложение для каталога; вердикт и формулировки — за заказчиком):
1. В фазе A есть `consent default` с `ad_storage` или `analytics_storage` = `granted` **для региона DE** → CONSENT-06. Учитываем `region`: если указан список, берём default для `DE`, а если DE не упомянут — default без `region`.
2. В фазе A запрос к Google содержит `gcs=G1x1|G11x` или `gcd` с `t|v|n|r` в любой из 4 позиций → CONSENT-06, evidence = URL с параметрами.
3. Default-команда отсутствует, а Google-хиты есть → это CONSENT-01, CONSENT-06 не выдаём (не дублировать).
4. После «Ablehnen» (фаза B) в хитах `gcs`/`gcd` всё ещё granted → CONSENT-05 / CONSENT-06 (решить, какой ID).
5. Advanced mode (хиты с `G100`/`p`, без cookies) — это не CONSENT-06, но CONSENT-01 («Anfragen an Google vor Einwilligung») сработает. Отдельный атрибут `consentModeAdvanced=true`, чтобы заказчик мог задать уровень.
6. `wait_for_update` и порядок: если первый хит ушёл **до** default (гонка) → CONSENT-06 с evidence по таймингу.

### 6.3 Server-side GTM, Google tag gateway, кастомные лоадеры

| Сигнал | Где искать | Вывод |
|---|---|---|
| Хит GA4 на **не-Google** хост: путь `/g/collect` или query с `v=2&tid=G-…&cid=…&en=…` | Сеть | sGTM, gateway или прокси |
| `gtm.js?id=GTM-…`, `gtag/js?id=G-\|AW-\|DC-…` с first-party хоста или поддомена (`sst.`, `metrics.`, `data.` …) | Сеть (Script) | Тег-сервер или gateway |
| В `dataLayer` / `gtag('config', …)`: `server_container_url`, `transport_url` | `dataLayer` | Явный sGTM-эндпоинт |
| `window.google_tag_manager` содержит `GTM-…`/`G-…`, но ни одного запроса к `googletagmanager.com` | JS + сеть | Кастомный лоадер (Stape Custom Loader меняет пути к gtm.js и gtag.js ✔) |
| Cookies `FPID` (HttpOnly, ставит сервер), `FPLC`, `FPAU` | Cookies | sGTM (first-party ID) ⚠ точный список проверить |
| Google tag gateway for advertisers | Настраиваемый путь на домене сайта (пример Cloudflare: `www.example.com/metrics`), с которого отдаётся `gtag/js?id=G-…` и куда идут измерения; CDN переписывает путь на эндпоинт Google ✔ (Cloudflare, 08.05.2025). Список проксируемых эндпоинтов не опубликован ⚠ | Gateway: «first-party» URL, но получатель — Google |

Ограничение, которое честно пишем в отчёте: **дальнейшая серверная передача (sGTM → Google/Meta CAPI) из браузера не наблюдаема**. Мы фиксируем «first-party Tracking-Endpoint erkannt» и `gcs`/`gcd` в этих хитах (они там тоже есть), а для PRIV-01 это сигнал искать упоминание в Datenschutzerklärung.

---

## 7. Стратегия обхода

### 7.1 Выбор страниц (по умолчанию `--max-pages 6`)

1. Стартовый URL (после редиректов; фиксируем цепочку для TLS-01).
2. Impressum и Datenschutzerklärung — по ссылкам со стартовой (раздел 7.4).
3. Kontakt / Anfahrt / Standort — самые вероятные места для Maps (EMBED-02) и reCAPTCHA (EMBED-04).
4. До 2 страниц «с вероятными встраиваниями» по ключевым словам ссылок навигации и подвала: `video`, `über uns`, `geschichte`, `team`, `karriere`, `blog`, `news`, `referenzen`, `bewertungen`, `termin`, `shop`, `newsletter`. Плюс сигнал из DOM главной: iframes, `youtube`/`maps` в href.
5. Если ссылок мало — sitemap: `robots.txt` → `Sitemap:`, затем `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml` (WordPress ≥ 5.5). Выбирать **разные шаблоны** (разные первые сегменты пути), а не 6 блог-постов.

Исключения: `mailto:`, `tel:`, `#`, `javascript:`, файлы (`.pdf`, `.zip`, `.docx`…), `wp-admin`, `wp-login.php`, корзина и checkout, поиск с параметрами, `logout`. Те же eTLD+1, поддомены — с лимитом (пример из каталога: «Startseite» ведёт на http-поддомен — это TLS-01, его нужно увидеть, но не обходить весь поддомен).

### 7.2 Фазы и контексты

| Фаза | Контекст | Действия | Что даёт |
|---|---|---|---|
| **A** до согласия | Новый (свежий профиль, см. ниже) | Страницы из 7.1 подряд, **без взаимодействия**; окно тишины | CONSENT-01/02/03, TRACK-01, EMBED-0x, LEGAL-01, TLS-03, Consent Mode default |
| **A′** нейтральная интерактивность | Тот же | На стартовой и Kontakt: `mouse.move`, `mouse.wheel(0, 400)`, `keyboard.press('Shift')`, без кликов; окно тишины | Delay-JS (WP Rocket и аналоги), Borlabs «баннер после взаимодействия», lazy-embeds. Находки помечены `trigger: interaction-without-consent` |
| **B** после «Ablehnen» | Новый | Стартовая → распознать баннер → reject первого уровня (или путь через настройки с пометкой) → верификация → reload → 2–3 страницы из A | CONSENT-04 (по первому уровню), CONSENT-05, Consent Mode update |
| **C** после «Alle akzeptieren» | Новый | Стартовая → accept → 1–2 страницы | Полный инвентарь сервисов для PRIV-01/02 (что сайт грузит при согласии) |

Детали:
- **«Новый контекст» = свежий временный профиль.** Эксперимент показал, что `browser.newContext()` в Chrome ведёт себя как Incognito как минимум в части preconnect (раздел 10). Предложение: на каждую фазу `chromium.launchPersistentContext(<tmpdir>)` с новым каталогом, который удаляется после фазы. Альтернатива — `newContext()` + пометка «Messumgebung: Inkognito-ähnlich» в отчёте. Выбор после замера на эталонных сайтах ⚠.
- Между страницами фазы A на каждой навигации проверяем состояние CMP. Если согласие появилось **без клика** (Cookiebot `consent.method === 'implied'`, opt-out-режимы) — это отдельная находка, а последующие наблюдения помечаем.
- «Свежий контекст на каждую страницу» для фазы A — опция `--fresh-context-per-page` (честнее для «каждая страница как вход», дороже по времени).
- Скролл в A′ и вопрос «скролл = согласие» решает заказчик. Ориентиры: EuGH C-673/17 «Planet49» (01.10.2019) — согласие требует активного поведения; EDPB Guidelines 05/2020 on consent, Rn. 86 (по вторичным источникам и EDPB-summary; дословный текст сверить ⚠), прямо называют скролл и свайп недостаточными. Юридическую квалификацию подтверждает заказчик.

### 7.3 Нагрузка, robots.txt, бюджет

- Навигации строго последовательно, одна страница за раз на хост, пауза ≥ 1.5 с между навигациями (`--delay`). HTTP-проверки без браузера (заголовки, FILE-01, security.txt) — ≤ 2 запросов/с.
- На `429`/`503` уважаем `Retry-After`, после 3 подряд — стоп и `SCAN-THROTTLED`.
- Ведём счётчик «сколько запросов инициировал сам сканер» (навигации + HTTP-пробы) и пишем его в отчёт: это прозрачность для владельца сайта.
- `robots.txt`: стартовый URL и юридические страницы проверяются всегда (это проверка соответствия одного сайта, а не индексирование). Для **дополнительных** страниц по умолчанию соблюдаем `Disallow` для `User-agent: *` и нашего токена; `--ignore-robots` — явная опция. Предложение; финал — у заказчика.
- Бюджет по умолчанию (оценка ⚠, калибровать): A ≈ 6 стр. × (10–20 с) ≈ 1–2 мин; A′ ≈ 20 с; B ≈ 40 с; C ≈ 25 с; HTTP, DNS и TLS-проверки — параллельно. **Итого ≈ 2.5–4 мин**, общий потолок `--timeout 8m`, рекомендуемый `timeout-minutes: 15` для джобы. Режимы `--quick` (стартовая + юр. страницы, без C) и `--thorough` (до 15 страниц).

### 7.4 LEGAL-01: «Impressum и Datenschutz доступны с каждой страницы»

На **каждой** посещённой странице (фазы A и B):
1. Найти ссылки, у которых accessible name или `href` соответствует `/impressum|imprint|anbieterkennzeichnung|legal[- ]notice/i` и `/datenschutz|privacy|datenschutzerkl/i`. Искать в main frame и open shadow DOM, включая элементы внутри баннера.
2. Классифицировать `href`:
   - `#`, пустой или `javascript:` → дефект («Link führt auf #» — кейс из каталога);
   - относительный или абсолютный → резолвить. Проверка HTTP-клиентом без браузера, с кэшем по URL и тем же UA. Нужен 2xx после редиректов, а цель должна содержать заголовок или текст `Impressum` / `Datenschutzerklärung`. Совпадения `TMG`/`RStV` передаём в LEGAL-02.
3. Видимость: ссылка видима в DOM, при необходимости после скролла к подвалу. Если **баннер перекрывает** подвал (`aria-modal`, backdrop; `elementFromPoint` в центре ссылки ≠ ссылка), а в самом баннере ссылок на Impressum и Datenschutz нет — отдельный признак «während des Banners nicht erreichbar» (уровень — заказчик). На страницах из `dialogHideDialogOnPages` Borlabs это нормальная ситуация.
4. SPA: «ссылка» без `href` с JS-роутингом → `info`; кликать не нужно.
5. Итог в отчёте: «Impressum-Link auf 6 von 6 geprüften Seiten gefunden» + список страниц без ссылки. Мы утверждаем только про **проверенные** страницы, без «auf jeder Seite».

---

## 8. HTML/PDF-отчёт через Playwright

- `page.pdf()` — для нас **Chromium** (CDP `Page.printToPDF`). Для Firefox и WebKit поддержка частичная (через BiDi; например, без `preferCSSPageSize`) — неважно, нам нужен только Chromium. В headed-режиме PDF исторически не поддерживался ⚠. Использует print-CSS (`emulateMedia({media:'screen'})` для экранного вида) ✔. Опции: `format: 'A4'`, `printBackground`, `preferCSSPageSize`, `displayHeaderFooter` + `headerTemplate`/`footerTemplate` (скрипты в шаблонах не выполняются, стили страницы там не видны: только inline-стили) ✔, `tagged` (доступный PDF, с 1.42) ✔, `outline` (закладки) ✔. Playwright запускает Chromium с `--export-tagged-pdf` ✔.
- Не умеет: PDF/A (архивный формат) ⚠ — при необходимости постобработка (Ghostscript / veraPDF для проверки); цифровую подпись; надёжную пагинацию сложных таблиц (`break-inside: avoid`, повтор `thead` работает не всегда ⚠).
- HTML-отчёт **полностью self-contained**: inline CSS и JS, шрифты — системные или встроенные (OFL) как data-URI, **никаких** внешних CDN или Google Fonts; скриншоты — сжатый JPEG/WebP.
- Длинные URL: `overflow-wrap:anywhere`. Немецкие умлауты в Docker → в образе нужны шрифты (Noto / DejaVu / Liberation).
- PDF лучше рендерить отдельным шагом (`dsgvo-check report --pdf report.json`), а не в скан-процессе: скан не будет зависеть от отчёта, а отчёт можно перегенерировать с исправленными немецкими текстами заказчика.
- Тексты находок и дисклеймер — от заказчика (ТЗ). Технически: i18n-ключи по `checkId` + `crmCode`.

---

## 9. Docker

| Вариант | Размер | Плюсы | Минусы |
|---|---|---|---|
| `mcr.microsoft.com/playwright:v1.64.1-noble` | **~984 МБ сжатый** (amd64, сумма слоёв по манифесту) ✔; arm64 распакованный — **3.52 ГБ**, из них ~570 МБ — Firefox и WebKit ✔ [эксп.] | Всё готово: Node 24, все браузеры, системные зависимости; `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` ✔ | Firefox и WebKit нам не нужны; по умолчанию **root** ✔ (sandbox Chromium тогда недоступен ✔) |
| Свой: `node:24-*-slim` + `npx playwright install --with-deps chromium` (+ `--no-shell` или `--only-shell` по решению 3.1) | ⚠ замерить. Браузер в архиве — 200 МБ (полный CfT) или 126 МБ (shell) ✔, плюс системные библиотеки и шрифты | Только Chromium, контроль над слоями, свой `USER` | Поддерживать самим; следить за совместимостью `install-deps` с базой |

Рекомендации:
- Пинить: `playwright-core@1.64.1` = браузер 156 (версии пакета и браузера связаны). Обновлять минимум раз в месяц: мы открываем **чужие, недоверенные** сайты, а патчи Chromium важны. Renovate или Dependabot.
- **Не-root:** создать пользователя (в официальном образе есть `pwuser`; в своём — `useradd`), `USER` в Dockerfile.
- **Sandbox:** Playwright документирует для краулинга запуск под отдельным пользователем + `--security-opt seccomp=seccomp_profile.json`, чтобы Chromium работал **с** sandbox ✔. Наш эксперимент (раздел 10):
  - с дефолтным seccomp Docker sandbox **не поднимается** даже от `pwuser`;
  - с `--cap-add=SYS_ADMIN` — поднимается, но capability широкая (Playwright советует её только для локальной отладки);
  - их seccomp-профиль в Docker/arm64 не дал стартовать контейнеру, на amd64 проверить ⚠.

  Поэтому: `--sandbox auto` — пробуем `chromiumSandbox: true`, при неудаче откатываемся на `--no-sandbox` с явным предупреждением в логе и отчёте.
  - GitHub Actions `container: options:` позволяет передать `--security-opt` ⚠.
  - GitLab shared runners — нет, там fallback.
  - На хостах Ubuntu ≥ 23.10 без контейнера Chrome for Testing может падать с «No usable sandbox» из-за AppArmor `apparmor_restrict_unprivileged_userns` ✔ (Puppeteer troubleshooting).
- `--init` (или `tini` как ENTRYPOINT) — против зомби-процессов ✔. `--ipc=host` рекомендуют, чтобы Chromium не падал по памяти ✔. Playwright и так передаёт `--disable-dev-shm-usage` ✔, так что `--ipc=host` в CI-шаблонах не обязателен ⚠ проверить на тяжёлых сайтах.
- Read-only rootfs + `tmpfs /tmp`; никаких секретов в env, кроме опционального прокси.
- Шрифты для PDF и скриншотов (`fonts-noto-core` или `fonts-dejavu`); `LANG=C.UTF-8`; `TZ` внутри контейнера не важен (используем `timezoneId`).
- Мульти-арх (amd64 + arm64): Chrome for Testing для Linux arm64 есть с 1.63 ✔.

---

## 10. Мини-эксперимент (верификация утверждений)

Прогон 2026-10-30, `playwright-core@1.64.1`, две среды:
- **(D)** официальный образ `mcr.microsoft.com/playwright:v1.64.1-noble` (linux/arm64, Docker): `chromium-headless-shell` 156.0.8078.4 (дефолт) и Chrome for Testing 156.0.8078.4 (`channel:'chromium'`, new headless);
- **(M)** установленный Google Chrome 156.0.8078.74 на macOS (`channel:'chrome'`, new headless; headed — где указано).

Условия: локальные HTTP- и HTTPS-серверы, домены `*.test` через `--host-resolver-rules`, `locale: 'de-DE'`, `timezoneId: 'Europe/Berlin'`. Скрипты лежат вне репозитория (scratchpad).

**Отпечаток по режимам (D):**

| | headless-shell (дефолт) | CfT new headless (`channel:'chromium'`) |
|---|---|---|
| UA без override | `… HeadlessChrome/156.0.8078.4 Safari/537.36` (полная версия, не reduced) | `… HeadlessChrome/156.0.0.0 Safari/537.36` |
| `userAgentData.brands` / `Sec-CH-UA` | `"Not:A-Brand";v="8", "Chromium";v="156", "HeadlessChrome";v="156"` | `"Not:A-Brand";v="8", "Chromium";v="156"` |
| **После override UA** (Chrome UA + `dsgvo-check/…`) | `Sec-CH-UA` **по-прежнему содержит `HeadlessChrome`** | `Sec-CH-UA` без `HeadlessChrome` |
| `navigator.webdriver` | `true` | `true` |

→ **headless-shell выдаёт себя через Client Hints даже при подменённом UA** (Playwright не задаёт `brands`, 3.4 п. 2). Это аргумент за CfT new headless по умолчанию (3.1). Chrome stable (M) отдаёт brands `Not:A-Brand / Chromium / Google Chrome`.

**Наблюдаемость (одинаково в D-shell, D-CfT и M, если не указано иное):**

| Проверка | Результат | Вывод |
|---|---|---|
| `Accept-Language` / `navigator.languages` / TZ | `de-DE` / `["de-DE"]` / `Europe/Berlin` | Как ожидалось (3.3) |
| Viewport по умолчанию | 1280×720 | Задавать явно (7.2) |
| `sendBeacon` и `fetch(keepalive)` при загрузке | Видны в `context.on('request')` (`resourceType` = `ping` / `fetch`) | ✔ |
| `sendBeacon` в `pagehide` и `visibilitychange` при `page.goto('about:blank')` | **Дошли до сервера, но в событиях Playwright их нет** — во всех 6 прогонах | **Подтверждённый пробел.** Меры: NetLog; или перед уходом со страницы открыть вторую вкладку и `bringToFront()`, чтобы `visibilitychange` сработал на живой странице ⚠ проверить |
| Dedicated worker `fetch` | Виден (`fetch`, `serviceWorker()=null`) | ✔ CDP-обвязка не нужна |
| Service worker: `sw.js` и `fetch` из `install` | Видны с `request.serviceWorker()` ≠ null | ✔ (как в доках 1.57) |
| Cookies: `Set-Cookie` HttpOnly + `document.cookie` | Обе в `context.cookies()` (`httpOnly=true/false`) | ✔ |
| Third-party cookies в `browser.newContext()` (iframe `tp.test` в `top.test`, HTTPS) | `tp_hdr` (Set-Cookie, `SameSite=None; Secure`) и `tp_js` сохранены; `tp_chips` (`Partitioned`) — с `partitionKey: "https://top.test"`. D-shell, D-CfT, M | 3PC **разрешены**, CHIPS работает ✔ |
| `<link rel=preconnect>` в `browser.newContext()` | **0 TCP-соединений** к целевым хостам (D-shell, D-CfT, M headless **и** headed) | Chrome в контекстах Playwright **не делает preconnect**. Вероятная причина — off-the-record-профиль, где network prediction выключен ⚠ |
| То же в `chromium.launchPersistentContext(tmpDir)` (M) | HTTP: 1 TCP, HTTPS: 1 TCP/TLS; в событиях Playwright — **нет**; в NetLog — **есть** | Preconnect реален для обычного профиля; ловится только NetLog ✔ |
| `dns-prefetch` (persistent, M) | В NetLog не обнаружен | ⚠ (возможно, из-за `--host-resolver-rules`) |
| `--log-net-log` с Playwright | Файл пишется во всех режимах (M: ≈ 0.5 МБ на простую страницу) | ✔ |

**Docker и sandbox (D):**

| Проверка | Результат |
|---|---|
| Размер образа `v1.64.1-noble` (arm64, распакованный) | **3.52 ГБ**. `/ms-playwright`: chromium 400 МБ, chromium_headless_shell 276 МБ, firefox 287 МБ, webkit 277 МБ, ffmpeg 4 МБ. Node v24.22.1; `pwuser` (uid 1001) есть |
| `chromiumSandbox: true`, дефолтный seccomp Docker (root или `pwuser`) | **Падает**: «Chromium sandboxing failed!» |
| То же + `--cap-add=SYS_ADMIN`, `--user pwuser` | **Работает** (shell и CfT) |
| `--security-opt seccomp=<seccomp_profile.json из репозитория Playwright>` | Контейнер **не стартует** в Docker/arm64 (ошибка рантайма). На linux/amd64 (CI) проверить ⚠ |
| Без sandbox (дефолт Playwright) | Работает от root и от `pwuser` |

**Новые выводы из эксперимента:**
1. **Профиль браузера влияет на достоверность.** `browser.newContext()` в Chrome ведёт себя как Incognito как минимум по preconnect. Рекомендация: каждая фаза — **отдельный `launchPersistentContext` со свежим временным `userDataDir`** (обычный профиль «нового посетителя»), а не `newContext()`. Цена — запуск браузера на фазу (≈ 1 с) и потеря «один браузер — много контекстов». Сравнить на эталонных сайтах ⚠.
2. Beacons на выгрузке страницы теряются: финальные хиты GA4 (`user_engagement`, scroll) и Hotjar-подобных инструментов могут уходить именно так. Для CONSENT-05 это важно, нужна одна из мер выше.

---

## 11. Главные риски и меры

| # | Риск | Последствие | Мера | Где |
|---|---|---|---|---|
| R1 | CMP в бот-режиме принимает всё (Borlabs, RCB, Complianz, Cookiebot) | Ложные CONSENT-01/02/03 → падение CI у «чистого» сайта | Нейтральный UA без `headless`/`bot`; рантайм-детектор бот-режима → `SCAN-BOTMODE`; A/B-замер на эталонных сайтах | 3.2–3.4 |
| R2 | Гео: раннер в США | Ложные CONSENT-03/04, пропущенные CONSENT-01 | `--proxy`, документация self-hosted, гео-сигналы → `SCAN-GEO` | 4 |
| R3 | Баннер или скрипты только после взаимодействия | Ложный CONSENT-03, пропуск CONSENT-01 | Фаза A′ | 7.2 |
| R4 | Неизвестный или нестандартный баннер | Ложный CONSENT-04 | Порог уверенности; `info: Banner nicht erkannt` | 5.4 |
| R5 | Кнопка «Ablehnen» есть, но перекрыта, не срабатывает или включает категории | Пропуск CONSENT-04/05 | Клик только через actionability; тройная верификация эффекта | 5.1 |
| R6 | Advanced Consent Mode и region-defaults | Спорные CONSENT-01/06 | Отдельные атрибуты, оценка default «для DE» | 6 |
| R7 | Нестабильность (таймеры, медленные сайты) | Флаки в CI | Алгоритм тишины, потолки, повтор фазы A один раз при `quietNotReached` и расхождении с B | 1.4 |
| R8 | Открываем недоверенные сайты в Chromium без sandbox | Компрометация CI-раннера при 0-day | Не-root, seccomp + sandbox где можно, эфемерный контейнер, без секретов, частые апдейты | 9 |
| R9 | Достоверность среды (`ThirdPartyStoragePartitioning` выключен, headless-отличия, `HeadlessChrome` в Client Hints у shell) | Расхождения с реальным Chrome; бот-детекция по `Sec-CH-UA` | CfT new headless по умолчанию; раздел «Messumgebung» в отчёте | 0, 3.1, 10 |
| R10 | autoconsent меняется ежедневно | Нестабильные результаты между версиями | Пин версии; правила — только как подсказки | 5.5 |
| R11 | Beacons на выгрузке страницы не видны Playwright | Пропуск хитов после отказа (CONSENT-05) | NetLog и/или трюк с `bringToFront()` перед навигацией | 1.2, 10 |
| R12 | `newContext()` = Incognito-подобный профиль (нет preconnect) | Расхождение с обычным посетителем | Свежий persistent-профиль на фазу | 7.2, 10 |

---

## Источники

| URL | Что подтверждает |
|---|---|
| https://www.npmjs.com/package/playwright (registry, `npm view`) | 1.64.1 опубликована 2026-10-14, Apache-2.0; история релизов 1.58–1.64 |
| https://www.npmjs.com/package/playwright-core (tarball 1.64.1: `browsers.json`, `lib/coreBundle.js`) | Chromium 156.0.8078.4 = Chrome for Testing + Chrome Headless Shell; `chromiumSwitches` (отключённые фичи, `--no-sandbox` без `chromiumSandbox`, `--disable-dev-shm-usage`, `--export-tagged-pdf`); `calculateUserAgentMetadata` без `brands`; `engines: node >=20` |
| https://playwright.dev/docs/release-notes | 1.49 (новый headless через `channel:'chromium'`), 1.51 (`indexedDB` в storageState), 1.54 (`partitionKey`), 1.57 (Chrome for Testing, headless shell, сеть SW в контексте), 1.60 (`tracing.startHar`), 1.61 (WebSocket в HAR), 1.63 (arm64, `opfs`), 1.64 (Chromium 156) |
| https://playwright.dev/docs/browsers | Headless shell vs new headless, `--only-shell` / `--no-shell` |
| https://playwright.dev/docs/docker | Теги образов, `--init`, `--ipc=host`, seccomp, root отключает sandbox, `pwuser` для краулинга |
| https://mcr.microsoft.com/v2/playwright/manifests/v1.64.1-noble (+ config blob) | ~984 МБ сжатых слоёв (amd64), есть arm64; User=root (не задан), Node 24, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` |
| https://github.com/microsoft/playwright/blob/main/docs/src/service-workers-js-python.md | Сеть SW репортится в BrowserContext, `request.frame()` бросает для SW |
| https://playwright.dev/docs/api/class-page#page-wait-for-load-state | `networkidle` — DISCOURAGED, 500 мс |
| https://playwright.dev/docs/api/class-browsercontext#browser-context-route | «Enabling routing disables http cache»; route не видит запросы через SW |
| https://playwright.dev/docs/api/class-browsercontext#browser-context-cookies | Поля cookie, `partitionKey` |
| https://playwright.dev/docs/locators#locate-in-shadow-dom | Shadow DOM пробивается по умолчанию, кроме XPath и closed roots |
| https://playwright.dev/docs/api/class-page#page-pdf | `page.pdf()` print-CSS, header/footer-ограничения, `tagged` (1.42), `outline` |
| https://github.com/microsoft/playwright/blob/main/tests/library/browsercontext-cookies-third-party.spec.ts | Ожидания Playwright по 3P cookies и партиционированию в Chromium |
| https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json | `Network.getAllCookies` deprecated → `Storage.getCookies`; `ResourceType` (Ping, Prefetch, Preflight…); ExtraInfo-события; `DOM.getDocument(pierce)`; домены `Preload`, `DOMStorage`; `Target.createBrowserContext(proxyServer)` |
| https://consent.cookiebot.com/uc.js (загружен 2026-10-30) | `isSpider()` (регулярка), `setOutOfRegion()` для spiders, `CookieConsent=-1` → out of region, `uc_cmp_country`, `g_disable_bot_detection`, `regulationRegions` |
| https://www.cookiebot.com/en/developer/ | JS-API Cookiebot, события, атрибуты скрипта, `CookieConsent="-1"` вне региона |
| https://support.cookiebot.com/hc/en-us/articles/26364939613596 | Geotargeting — Premium, IP-lookup у стороннего сервиса |
| https://support.cookiebot.com/hc/en-us/articles/360020501579 | Workaround Cookiebot с `setOutOfRegion()` для Lighthouse |
| https://plugins.svn.wordpress.org/complianz-gdpr/trunk/cookiebanner/js/complianz.js (r3774931) | `cmplz_is_bot()`, `cmplz_is_speedbot()`, `cmplz_has_consent()` → true для бота; `complianz.region` / `consenttype`; семантика регионов (opt-out US, other — без баннера) |
| https://complianz.io/how-complianz-geolocation-works-and-how-to-enable-it/ · https://complianz.io/css-lesson-12-apply-properties-based-on-consent-type-region/ | GeoIP Complianz; body-классы `cmplz-eu/us/other` |
| https://plugins.svn.wordpress.org/real-cookie-banner/trunk/inc/settings/Consent.php | `accept-all-for-bots`, default `true` |
| https://plugins.svn.wordpress.org/real-cookie-banner/trunk/public/dist/banner-lite-banner-ui.lite.js · …/banner.lite.js | isbot-регулярка, решение «all» для ботов, DNT-логика, детектор CMP-краулеров |
| https://docs.devowl.io/real-cookie-banner/js/functions/frontend-packages_cookie-consent-web-client.createApi.html | `window.consentApi` (`consent`, `consentAll`, `consentSync`, `unblock`) |
| https://borlabs.io/wp-content/plugins/borlabs-cookie/assets/javascript/borlabs-cookie.min.js (v3.5.0, chunk `consents.*.min.js`) · https://borlabs.io/wp-content/cache/borlabs-cookie/1/borlabs-cookie-config-en.json.js | `isBot()`, `cookiesForBots` → `saveConsentAll()`, `dialogShowDialogAfterUserInteraction`, GeoIP-REST, `dialogHideDialogOnPages`, cookie `borlabs-cookie`, `respectDoNotTrack` |
| https://borlabs.io/kb/javascript-api/ | JS-API Borlabs v3 и события |
| https://usercentrics.com/docs/web/features/api/control-functionality/ | Методы `__ucCmp` (вкл. `denyAllConsents`, `isConsentRequired`, `getConsentDetails`) |
| https://support.usercentrics.com/hc/en-us/articles/19753318026140 · https://usercentrics.com/beta-docs/geolocation-rules | Гео-правила; без баннера → сервисы согласованы в фоне |
| https://usercentrics.com/docs/web/features/custom-css/configuration/ | v3 UI живёт в Shadow DOM, `#uc-main-dialog` |
| https://web.cmp.usercentrics.eu/ui/loader.js (загружен 2026-10-30) | `isUserBot()` (HeadlessChrome, Playwright/, Lighthouse…), `UC_GEO_PARAM = "uc_cmp_country"` из `location.search`, событие `UC_CMP_API_READY`, `window.__ucCmp` |
| https://docs.cookiehub.com/advanced/javascript-api | API `window.cookiehub` |
| https://www.npmjs.com/package/@duckduckgo/autoconsent · https://github.com/duckduckgo/autoconsent | 17.1.0, MPL-2.0; правила 7 CMP; Cookiebot opt-out через `withdraw()`; немецкие эвристики; Playwright-бандл |
| https://www.npmjs.com/package/isbot | 5.2.2, Unlicense; паттерны `http`, `check\b`, `\.com\b`, `headless`, `playwright` |
| https://developers.google.com/tag-platform/security/guides/consent · https://developers.google.com/tag-platform/security/concepts/consent-mode | `consent default`/`update`, `wait_for_update`, `region`; basic vs advanced; 7 типов согласия; `gcs`/`gcd`/`dma` как поля |
| https://github.com/analytics-debugger/gtm-template-server-side-google-consent-parser | Побитовое декодирование `gcd` |
| https://complianz.io/help/wordpress/configuration/consent-mode-for-7-0/ · https://www.lukaswojcik.com/blog/en/digital-analytics/ga4-consent-mode-v2-decoding-gcd-parameter/ · https://consentmodehq.com/verify-consent-mode-from-the-network-tab/ | Таблица букв `gcd`, примеры |
| https://support.google.com/google-ads/answer/16214371 · https://blog.cloudflare.com/google-tag-gateway-for-advertisers/ | Google tag gateway: тег и измерения через настраиваемый путь на домене сайта (пример `/metrics`), CDN переписывает на Google |
| https://stape.io/solutions/custom-gtm-loader | Кастомный лоадер меняет пути gtm.js и gtag.js |
| https://docs.github.com/en/actions/reference/runners/github-hosted-runners | Регион не указан; IP не ограничены диапазонами Azure; larger runners — static IP и private networking |
| https://github.com/orgs/community/discussions/24969 | Регионы GitHub-hosted runners (ответ 2021: 5 регионов Azure в США; выбор невозможен) |
| https://docs.gitlab.com/ci/runners/hosted_runners/linux/ | GitLab.com hosted runners: GCP, `us-east1` по умолчанию |
| https://privacysandbox.google.com/blog/privacy-sandbox-next-steps | 22.04.2025: Chrome сохраняет 3P cookies (без нового промпта); Incognito блокирует их по умолчанию |
| https://docs.wp-rocket.me/article/1349-delay-javascript-execution | Delay JS: скрипты до движения мыши, тача, скролла, клавиши |
| https://pptr.dev/troubleshooting | AppArmor и userns на Ubuntu ≥ 23.10 → «No usable sandbox» |
| https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json | Seccomp-профиль Playwright для sandbox в Docker (использован в эксперименте) |
| https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/ (HEAD) | Размеры архивов: `chrome-linux64.zip` 200.3 МБ, `chrome-headless-shell-linux64.zip` 125.8 МБ |
| Раздел 10 (собственный эксперимент, 2026-10-30) | UA, brands, webdriver, beacons, workers, 3PC/CHIPS, preconnect, NetLog, sandbox и размер образа |
| https://www.rfc-editor.org/rfc/rfc9110#section-10.1.2 | `From` = mailbox; роботы SHOULD отправлять; без явной настройки пользователем — SHOULD NOT |
| https://interoperable-europe.ec.europa.eu/collection/free-and-open-source-software/solution/website-evidence-collector/release/210 | Website Evidence Collector (EDPS): EUPL-1.2, Puppeteer |

---

## Открытые вопросы

1. **UA-компромисс** (3.4, варианты а/б/в): ссылка обязательно в UA браузера (и мы принимаем бот-режим у RCB/`isbot` с детектором и понижением)? Или достаточно её в UA HTTP-проб плюс контактного e-mail в `From:`? Решает заказчик (честность vs достоверность).
2. **Имя продукта**: `dsgvo-check` срабатывает на `check\b` в `isbot` и RCB. Менять ли рабочее название (ТЗ это допускает) или нейтрализовать токен в UA?
3. **Гео в CI по умолчанию**: делать ли `--proxy` обязательным для «строгого» режима (`--fail-on critical`)? Что делать с CONSENT-03/04 без ЕС-выхода: `warning` или пропуск?
4. **Фаза A′**: считать ли находки после скролла и движения мыши без клика равными CONSENT-01 или отдельным уровнем?
5. **CONSENT-04 по эвристике** для неизвестных CMP: разрешаем `critical` при score ≥ 0.8 или только `warning`?
6. **Advanced Consent Mode** (cookieless pings до согласия): уровень находки и ID (CONSENT-01 или отдельный)?
7. **Сайт недоступен или заблокирован WAF**: какой код выхода — `2` (ТЗ: «сканер сам упал») или отдельная находка с `0/1`?
8. **robots.txt** для дополнительных страниц: соблюдать по умолчанию (предложение) или игнорировать?
9. **Режим и профиль браузера по умолчанию**: CfT new headless (`channel:'chromium'`) — предложение. Persistent-профиль на фазу или `newContext()` — финализировать по замеру на 10 эталонных сайтах (время, размер образа, расхождения в находках).
10. **Usercentrics, CCM19, CookieHub**: бот- и гео-логика не проверена по коду. Нужны живые сайты из списка заказчика для прототипа.
11. **PDF/A** нужен ли заказчику (архив, передача клиентам)? Если да — постобработка и валидация.
12. **Хранение доказательств**: включать ли HAR и скриншоты в артефакты CI по умолчанию (объём, содержимое cookies третьих сторон)?
