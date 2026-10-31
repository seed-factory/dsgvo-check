# Источники данных для dsgvo-check и их лицензии

Дата: 2026-10-30 · Автор: панель консенсуса, участник Claude (Fable) · Статус: черновик для критики другими моделями
Контекст: репозиторий Apache-2.0, заказчик seed-factory.com использует отчёты в **платных** аудитах, поле `crmCode` уходит в CRM заказчика. Всё ниже оценивается в этой рамке: «коммерческое использование» — да, всегда.

Легенда вердиктов: **вендорить** (снапшот в репо/npm/Docker-образе) · **тянуть при запуске** (скачать в кэш при `dsgvo-check update`/первом запуске, в репо не класть) · **только идея** (повторить структуру/подход, данные не брать) · **нельзя** (без отдельного договора). ⚠ проверить — не удалось подтвердить первоисточником.

---

## Коротко

1. **Все «большие» базы трекеров закрыты для нас лицензией NC**: DuckDuckGo Tracker Radar, Disconnect и Ghostery TrackerDB — CC BY-NC-SA 4.0, коммерческое использование только по договору. cookiedatabase.org — CC BY-NC-ND. Для платных аудитов это «нельзя» даже в режиме «тянуть при запуске».
2. **Пермиссивная замена есть**: `third-party-web` (MIT, 2 143 сущностей с доменами, компанией и категорией; используется Lighthouse), Open Cookie Database (Apache-2.0, ~2 280 cookie с категорией и контроллером), AdGuard `cname-trackers` (MIT), EasyPrivacy/EasyList (GPLv3 **или** CC BY-SA 3.0 — берём ветку CC BY-SA, матчим через `@ghostery/adblocker`, MPL-2.0). Этой комбинации хватает для CONSENT-01/02, TRACK-01, EMBED-01…05.
3. **CMP: `@duckduckgo/autoconsent` (MPL-2.0) покрывает все 7 наших баннеров** — Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub (913 JSON-правил + 11 TS-классов, релиз 17.1.0 от 30.10.2026). Consent-O-Matic (MIT) покрывает 4 из 7 и не обновлялся с ноября 2025. Для CONSENT-04 правила autoconsent **недостаточно**: `optOut` там идёт «любым путём», включая «Einstellungen → снять галочки», а нам нужно различать «равноценный отказ на первом уровне» — это свой слой семантики кнопок.
4. **PSL**: `tldts` (MIT, 7.4.19 от 20.10.2026, PSL под MPL-2.0 внутри) — без вопросов.
5. **GeoIP: MaxMind GeoLite2 не вшивать.** EULA (ред. 12.02.2026) требует уничтожать старые версии в течение 30 дней и перекладывать EULA/DPA на каждого получателя — несовместимо с git-историей и неизменяемым Docker-образом. По умолчанию **DB-IP Lite** (CC BY 4.0, без аккаунта, ежемесячно, страна/город/ASN) + **iptoasn.com** (PDDL, ASN → организация). IPinfo Lite (CC BY-SA 4.0, нужен бесплатный токен) и GeoLite2 (ключ пользователя) — опционально.
6. **GeoIP ≠ «передача за пределы ЕС»**: `fonts.gstatic.com` с anycast-узла во Франкфурте остаётся Google LLC (US). Нужны два независимых признака в отчёте: страна/ASN IP-адреса (доказательство) и страна получателя из собственного каталога сервисов (правовая оценка). Статус EU-US DPF: решение Общего суда T-553/23 (03.09.2025) в пользу DPF, апелляция C-703/25 P в Суде ЕС **не решена** на 30.10.2026 ⚠.
7. **Уязвимости WordPress**: WPScan — платная лицензия для коммерческого использования (free 25 вызовов/день только non-commercial) → нельзя. Patchstack API — только по договору. **Wordfence Intelligence v3** — бесплатен для коммерческого использования, но с 09.03.2026 нужен бесплатный API-ключ (v2 отдаёт HTTP 410). **WPVulnerability.net** — агрегатор под **CC0**, без ключа, сразу даёт ссылки на CVE/WPScan/Wordfence. Рекомендация MVP: WPVulnerability по умолчанию, Wordfence v3 по ключу пользователя.
8. **JS-библиотеки**: retire.js `jsrepository` (Apache-2.0, 6.1.0 от 06.10.2026, 76 библиотек с regex-экстракторами версий) — вендорить. **TYPO3/Drupal/Joomla/Composer**: OSV.dev API (typo3/cms-core — 128 записей, drupal/core — 201) + GitHub Advisory Database (CC-BY 4.0). **Признак critical**: CISA KEV (CC0, 1 764 записи на 29.10.2026) ∪ вектор CVSS `AV:N/PR:N/UI:N` с high impact ∪ список `exploited` ENISA EUVD (API без ключа, условия ⚠).
9. **Фингерпринтинг**: оба живых форка Wappalyzer (enthec/webappanalyzer, HTTPArchive/wappalyzer) — **GPL-3.0** → в Apache-2.0-репо не вендорить. Для MVP хватает собственного набора из ~30 отпечатков (WordPress/TYPO3/Drupal + плагины из топа VULN-02), написанного с нуля, плюс экстракторы retire.js; Wappalyzer-данные — опциональная загрузка при запуске, по умолчанию выключена.
10. **Самим придётся вести**: каталог сервисов с немецкими алиасами для PRIV-01 (≈100 записей: домены → сервис → компания → страна → категория → `crmCode`), семантику кнопок первого уровня CMP, allowlist технически необходимых cookie, собственные отпечатки CMS/плагинов, список ЕЭЗ/адекватности, файл атрибуций для отчёта. Это не «долг», а ядро продукта: именно эти данные делают отчёт отличимым от Blacklight/WEC.

---

## 0. Правовая рамка оценки

| Класс лицензии | Примеры | Что можно в Apache-2.0-репо при коммерческом использовании |
|---|---|---|
| CC0 / PDDL / Unlicense / public domain | CISA KEV, WPVulnerability, iptoasn, FriendsOfPHP | Всё: вендорить, менять, сливать с нашими данными. Атрибуция — вежливость |
| MIT / Apache-2.0 / CC BY 4.0 | third-party-web, Open Cookie Database, cname-trackers, DB-IP Lite, GHSA | Вендорить и менять; сохранить NOTICE/атрибуцию в репо **и в отчёте** (DB-IP требует ссылку на страницах с результатами) |
| MPL-2.0 (file-level copyleft) | autoconsent, @ghostery/adblocker, PSL внутри tldts | Использовать как зависимость; изменённые файлы MPL остаются под MPL. Наши аннотации к правилам — в отдельных файлах |
| CC BY-SA 4.0 | IPinfo Lite, AdGuard companiesdb, «copyrightable elements» GeoLite2 | Использовать как есть с атрибуцией. **Не сливать** в наш Apache-2.0-каталог: производная БД обязана быть CC BY-SA. Держать отдельным файлом/кэшем |
| GPL-3.0 (данные) | AdGuard filters, форки Wappalyzer, webXray owner list, Blacklight | Не вендорить в Apache-2.0-дерево. Загрузка при запуске в кэш (opt-in) юридически защитима («данные, а не производное произведение»), но консервативный путь — обходиться без них. Никогда не переписывать записи в свои файлы |
| CC BY-NC-* | Tracker Radar, Disconnect, Ghostery TrackerDB, cookiedatabase.org | **Нельзя** для платных аудитов ни в каком режиме. Только идея (структура данных) |
| Проприетарные/договорные | Cookiepedia, WPScan, Patchstack API, IAB GVL/CMP-list, GeoLite2 EULA | Либо договор, либо ручная проверка аналитиком, либо только при запуске под ключом пользователя |

Две оговорки, важные для ЕС:
- **Sui-generis-право на базы данных (§ 87a ff. UrhG, Richtlinie 96/9/EG)** защищает существенные извлечения даже из фактов. «Переписать домены из Tracker Radar в свой каталог» — это извлечение, а не «идея». Собственный каталог собираем из своих 80 аудитов, наблюдаемого трафика и документации вендоров.
- **EasyList двойная лицензия**: мы вправе выбрать CC BY-SA 3.0 и не касаться GPL. Прецедент: Website Evidence Collector (EDPS, EUPL-1.2) кладёт EasyList-списки в `assets/` «under their respective license as indicated in their file headers».

---

## 1. Классификация сторонних доменов и сервисов

### 1.1 Таблица

| Источник | Лицензия (проверено) | Что даёт | Формат / доступ | Актуальность | Вердикт |
|---|---|---|---|---|---|
| DuckDuckGo Tracker Radar | **CC BY-NC-SA 4.0**; «If you'd like to license the list for commercial use, please reach out» | домен → владелец (parent entity), категории, prevalence, fingerprinting, cookies, privacy policy | `domains/<region>/<domain>.json`, репо ~765 коммитов | активно | **нельзя** → только идея (модель данных `DATA_MODEL.md`) |
| Disconnect tracking protection | **CC BY-NC-SA 4.0** (файл LICENSE), «email support@disconnect.me … commercial use» | `services.json`: категории Advertising/Analytics/Social/Content/Fingerprinting… | JSON | активно | **нельзя** |
| EasyList / EasyPrivacy / EasyList Germany / EasyList Cookie List | **GPLv3+ или CC BY-SA 3.0+** (на выбор); атрибуция «The EasyList authors (https://easylist.to/)» | правила блокировки запросов (трекеры, реклама) и косметика баннеров | ABP-синтаксис, `easylist.to/easylist/easyprivacy.txt`, `…/easylistgermany/easylistgermany.txt`, `secure.fanboy.co.nz/fanboy-cookiemonster.txt` (все HTTP 200) | ежедневно | **тянуть при запуске** (кэш, уважать частоту ⚠ политика серверов EasyList не проверена); вендорить допустимо по CC BY-SA 3.0 как отдельный файл |
| @ghostery/adblocker (+ -playwright) | **MPL-2.0**, 2.20.3 (28.10.2026) | движок матчинга EasyList/uBO-правил в Node; `engine.match(request)` → `{match, filter, exception, redirect}` → можно показать сработавшее правило в доказательстве | npm; `FiltersEngine.fromLists(fetch, urls)` / `fromPrebuiltAdsAndTracking` | активно | **зависимость** |
| Ghostery TrackerDB / WhoTracks.me | TrackerDB и npm `@ghostery/trackerdb` 1.0.959: **CC BY-NC-SA 4.0**, «for business use contact sales@ghostery.com»; whotracks.me: контент CC BY 4.0, код MIT, но «builds heavily on TrackerDB» | organizations/categories/patterns (`.eno`), `matchDomain/matchUrl` | npm, `dist/trackerdb.engine` | ежедневные релизы | **нельзя** → только идея (лучшая модель «организация → паттерны → категория», в т.ч. категория `consent management`) |
| AdGuard companiesdb | **CC BY-SA 4.0** (LICENSE проверен) | `trackers.json` (name, categoryId 0–15/101, url, companyId), `companies.json` (name, websiteUrl, description) | JSON в `dist/` | активно | **тянуть при запуске с атрибуцией, отдельным файлом**; ⚠ README: «basically the Whotracks.me database converted … with some additions» — цепочка whotracks.me (CC BY) ← TrackerDB (NC) юридически мутная. Не делать основой |
| AdGuard filters (Base, SpywareFilter = Tracking Protection, GermanFilter…) | **GPL-3.0** | правила блокировки | ABP-синтаксис | активно | не вендорить; при запуске opt-in. Для MVP не нужны — EasyPrivacy хватает |
| AdGuard cname-trackers | **MIT** | CNAME-замаскированные трекеры (`combined_disguised_trackers.txt`, `_justdomains.txt`, RPZ) + `combined_original_trackers.txt` | текст | автообновление | **вендорить** (для first-party-поддоменов с CNAME на трекер; нужен `dns.resolveCname`) |
| webXray Domain Owner List | оригинал `timlib/webXray_Domain_Owner_List` — 404; форк `RDBinns/…` **GPL-3.0**, последний push 2018 | owner_name, aliases, parent_id, homepage_url, privacy_policy_url, **country**, uses, domains | JSON | мёртв | **только идея** — поля `aliases`/`country`/`privacy_policy_url` ровно то, что нужно PRIV-01 |
| Blacklight collector (The Markup) | **GPL-3.0**; `data/webxray`, `data/blocklists` | эталон методики (third_party_trackers, canvas fingerprinting, session recorders) | TS/Puppeteer | активно | только идея/аналог |
| Website Evidence Collector (EDPS) | **EUPL-1.2**, списки EasyList в `assets/` под их лицензией | эталон: cookies, localStorage, beacons, third-party hosts | Node/Puppeteer, code.europa.eu (активен 30.10.2026) | активно | аналог; подтверждает выбор EasyPrivacy |
| DuckDuckGo tracker-radar-collector | **Apache-2.0** | краулер-коллекторы (requests, cookies, APIs, CMP через autoconsent) | Node/Puppeteer | push 28.10.2026 | **референс архитектуры**, код можно заимствовать |
| **third-party-web** (Patrick Hulce, Lighthouse) | **MIT**, 0.30.0 (14.09.2026) | 2 143 сущности: `name, company, homepage, category, domains[] (с `*.`), examples[]`; категории: ad 751, analytics 393, utility 281, content 192, hosting 92, other 91, marketing 82, customer-success 76, consent-provider 69, social 64, cdn 30, tag-manager 15, video 7 | npm / `data/entities.js` | активно | **вендорить (npm-зависимость)** — основная пермиссивная карта «домен → сервис → компания» |
| Open Cookie Database (jkwakman) | **Apache-2.0** | ~2 279 строк: `ID, Platform, Category, Cookie / Data Key name, Domain, Description, Retention period, Data Controller, User Privacy & GDPR Rights Portals, Wildcard match` | CSV/JSON; коммит 16.10.2026 | активно | **вендорить** — классификация cookie для CONSENT-02 (Functional/Analytics/Marketing…) |
| Cookiepedia (OneTrust) | проприетарно, «All Rights Reserved», нет API/выгрузки | описания cookie | web | — | **нельзя** (аналитик может смотреть руками) |
| cookiedatabase.org (Complianz/SIDN) | **CC BY-NC-ND 4.0** | cookie + сервисы | web, без API | — | **нельзя** |

### 1.2 Выводы по категории

- Категорий `fonts / maps / captcha / video / widget`, которые нужны для EMBED-01…05 и `crmCode`, **нет ни в одном пермиссивном источнике в нужной гранулярности** (third-party-web: Google Fonts, Maps, reCAPTCHA, YouTube живут в `utility`/`content`/`video` вперемешку ⚠ точное распределение не проверял). Значит, поверх third-party-web нужен **собственный каталог сервисов** (см. §8), а third-party-web — fallback для «неизвестного третьего лица: компания X, категория analytics».
- EasyPrivacy через `@ghostery/adblocker` даёт независимое второе мнение «это трекер» с указанием правила — это и есть «доказательство» для JSON-отчёта (`evidence.matchedRule`). Для немецких сайтов добавить EasyList Germany.
- Для CONSENT-03 («баннера нет») EasyList Cookie List полезен как эвристика наличия баннера (косметические правила `##.cookie-banner`) — но только как `info`, как требует ТЗ.
- Прямое сравнение с Blacklight/WEC: оба используют EasyList-семейство, оба не имеют «каталога сервисов с алиасами для политики» — там наш продукт и выигрывает.

---

## 2. Правила распознавания CMP

### 2.1 Покрытие наших 7 CMP

| CMP (порядок ТЗ) | autoconsent (MPL-2.0) | Consent-O-Matic (MIT) | IAB TCF cmp-list |
|---|---|---|---|
| Borlabs | `rules/autoconsent/borlabs.json` | `rules/borlabs.json` | id 323 «Borlabs GmbH» |
| Cookiebot | TS-класс `lib/cmps/cookiebot.ts` + `cookiebot-be.json` | `rules/cookiebot.json` | id 134 |
| Complianz | `complianz-banner/-categories/-notice/-opt-out/-optin.json` | `rules/complianz.io.json` | id 332 «Complianz BV» |
| Usercentrics | `usercentrics-api.json`, `usercentrics-button.json` | `rules/usercentrics.json` | id 5 |
| CCM19 | `ccm19.json` | нет | нет (не TCF) |
| Real Cookie Banner (devowl) | `real-cookie-banner.json` | нет | нет (не TCF) |
| CookieHub | `cookiehub.json` | нет | id 354 |
| Итого | **7/7** | 4/7 | 5/7 (только как факт регистрации) |

Проверено по GitHub API 30.10.2026: autoconsent — 913 файлов в `rules/autoconsent` + 13 файлов в `lib/cmps` (admiral, consentmanager, conversant, cookiebot, evidon, klaro, onetrust, sourcepoint-frame, tiktok, trustarc-top, uniconsent + base/all); Consent-O-Matic — 204 правила, последний коммит 07.11.2025.

### 2.2 autoconsent: формат и интеграция

- Лицензия **MPL-2.0** (npm `@duckduckgo/autoconsent` 17.1.0, опубликован 30.10.2026; коммит в main в тот же день — проект живой, это основной движок DuckDuckGo-браузеров).
- Правило — декларативный JSON: `name`, `vendorUrl`, `prehideSelectors`, `detectCmp[]`, `detectPopup[]`, `optIn[]`, `optOut[]`, `test[]`, флаги `cosmetic`, `runContext {main, frame}`. Действия: `exists`, `visible`, `waitFor`, `waitForVisible`, `waitForThenClick`, `click` (+`all`), `if/then/else`, `eval`, `wait`, селекторы CSS и `xpath//…`. Пример (`real-cookie-banner.json`, сокращено):

```json
"optOut": [{ "waitForThenClick": [
  "div[consent-skip-blocker=\"1\"] … a[role=button]:not([id])",
  "xpath///span[contains(., ' ohne ') or contains(., 'without') or contains(., 'Ablehnen')]"
]}]
```

- Сложная логика — TS-классы `AutoCMP` (Cookiebot, OneTrust, Sourcepoint…). Сборка — `rules/rules.json` (импорт `@duckduckgo/autoconsent/rules/rules.json`), есть `dist/autoconsent.playwright.js`, который экспонирует `window.autoconsentHeuristics` (`getPotentialPopups`, `getButtonData`, `getActionablePopups`) — эвристика для неизвестных баннеров (CONSENT-04 → `info "Banner nicht erkannt"`). Интеграция в Playwright: инжект бандла через `page.addInitScript` / `page.evaluate`, обмен сообщениями `detectCmp → detectPopup → optOut → test` (так устроен `CMPCollector` в tracker-radar-collector, Apache-2.0 — можно переносить код).
- **Ограничение для CONSENT-04**: `optOut` в autoconsent — это «добиться отказа любым путём». В `borlabs.json` цепочка: `.brlbs-btn-accept-only-essential, a[data-cookie-refuse]` → иначе `.brlbs-btn-save` → иначе close-button → иначе `a[data-cookie-individual]` → снять все чекбоксы → `#CookiePrefSave`. Для нас успех ветки 2–4 означает **нарушение** (нет равноценного отказа на первом уровне), а не успех. Поэтому нужен свой слой: для каждого CMP разметить селекторы первого уровня как `reject-all | accept-all | settings | close` и немецкие подписи (`Ablehnen`, `Alle ablehnen`, `Nur notwendige`, `Nur essenzielle`, `Nur technisch notwendige`; негативный пример из аудитов — `Verbergen`). Селекторы можно брать из правил autoconsent (MPL позволяет), разметку хранить в своём файле.

### 2.3 Consent-O-Matic

- **MIT** (LICENSE: «Copyright (c) 2019…2022 Janus Bager Kristensen and Rolf Bagge», Aarhus University). Формат: `detectors[] {presentMatcher, showingMatcher}`, `methods[]` из `OPEN_OPTIONS | DO_CONSENT | SAVE_CONSENT | HIDE_CMP`, действия click/wait/slide/consent с привязкой к категориям согласия A–F. Полезная идея: явная модель «какие категории есть и как их выключить», но форма — браузерное расширение, библиотеки нет, год без коммитов. Вердикт: **вендорить можно (MIT), как референс/вторичный источник селекторов**; не основа.

### 2.4 IAB TCF

- `https://cmplist.consensu.org/v2/cmp-list.json`: `lastUpdated: 2026-10-29T16:00:21Z`, 274 CMP (включая удалённые), поля `id, name, isCommercial, environments[], deletedDate`. Terms & Conditions TCF (PDF, апрель 2023): §8(a) «All rights, title and interest in and to the Framework … are hereby reserved to IAB Europe and IAB Tech Lab»; доступ к Framework сформулирован для зарегистрированных GV/CMP. Публичной лицензии на cmp-list/GVL нет → **не вендорить**; маппинг `cmpId → name` при запуске — допустимо как факт, но ⚠ серо.
- Практичнее читать на странице `__tcfapi('ping')` → `cmpId, cmpVersion, gdprApplies, tcfPolicyVersion` и `__tcfapi('getTCData')` — это публичный интерфейс спецификации. TCF-сайтов среди немецких КМУ мало (в каталоге нет ни одного TCF-кейса), приоритет P2.

---

## 3. Public Suffix List и библиотеки

| Источник | Лицензия | Факты | Вердикт |
|---|---|---|---|
| Public Suffix List (Mozilla) | **MPL-2.0** | publicsuffix.org: «have your app download the list no more than once per day», меняется несколько раз в неделю | через библиотеку, не качать самим |
| **tldts** | **MIT**, 7.4.19 (20.10.2026) | PSL вшит, релизы при обновлении PSL, есть `tldts-experimental` (тот же номер версии); `getDomain()` даёт eTLD+1; опция `allowPrivateDomains` отделяет `*.github.io`, `*.cloudfront.net` | **зависимость** |
| psl | MIT, 1.15.0 (02.12.2024) | обновляется редко | нет |

Применение: first/third party по eTLD+1 цели vs. eTLD+1 запроса; CNAME-cloaking — `dns.resolveCname` для first-party-поддоменов + `cname-trackers` (MIT). Playwright DNS не показывает, значит отдельный DNS-модуль (он и так нужен для MAIL-01…03, DNS-01).

---

## 4. GeoIP и «передача за пределы ЕС»

### 4.1 Провайдеры

| Источник | Лицензия / условия (проверено) | Данные | Доступ | Вердикт |
|---|---|---|---|---|
| MaxMind GeoLite2 (Country/City/ASN) | EULA, ред. **12.02.2026**: §3 «copyrightable elements are governed by the Creative Commons License» = **CC BY-SA 4.0**, но §6.1 «you will not disclose the Services to any third party without notifying MaxMind … and obtaining MaxMind's prior written consent» (кроме явно разрешённого CC) с перекладыванием EULA и DPA на получателя; §6.3 «cease use of and destroy … old versions … within thirty (30) days»; атрибуция «This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.»; с 30.12.2019 нужен аккаунт + license key | страна/город/ASN, MMDB | загрузка по ключу, обновления 2×/нед. | **не вендорить и не класть в образ**; опционально **тянуть при запуске** с ключом пользователя (`MAXMIND_LICENSE_KEY`) |
| **DB-IP Lite** (Country/City/ASN) | **CC BY 4.0**; атрибуция `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>` на страницах с результатами | страна/город/ASN, MMDB/CSV | без аккаунта (HEAD `download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz` → 200, 4,1 МБ), ежемесячно | **по умолчанию: тянуть при запуске/сборке в кэш**; вендорить тоже можно, но файл меняется ежемесячно |
| IPinfo Lite | **CC BY-SA 4.0**; «commercial and non-commercial applications»; атрибуция-ссылка («IP address data is powered by IPinfo») | `country, continent, asn, as_name, as_domain`; MMDB/CSV/JSON/Parquet; ежедневно | нужен бесплатный токен (`https://ipinfo.io/data/ipinfo_lite.mmdb?token=…`) | **опционально при запуске** с токеном пользователя; не сливать с нашим каталогом (SA) |
| IP2Location LITE | Страница Terms: «You are not permitted to redistribute or resell this product», атрибуция «[Your site…] uses the IP2Location LITE database for IP geolocation», аккаунт обязателен; блог IP2Location говорит CC BY-SA 4.0 — **противоречие** ⚠ | страна/город/ASN | аккаунт | **нельзя вендорить**; низкий приоритет, пропустить |
| **iptoasn.com** | **PDDL v1.0** («Licensed under Public Domain»); обновление ежечасно; публичный API закрыт 31.12.2020 | диапазон → ASN, страна регистрации, AS description (имя организации) | TSV.gz | **вендорить/тянуть** — источник «ASN → организация» |
| sapics/ip-location-db | агрегатор: DB-IP (CC BY 4.0), iptoasn и собственные наборы (PDDL), GeoLite2 (под EULA — не брать) | CSV/MMDB, ежедневно/ежемесячно | GitHub/npm ⚠ имена пакетов не проверял | удобный зеркальный источник DB-IP/iptoasn |

### 4.2 Как интерпретировать

- GeoIP показывает **где стоит сервер**, а DSGVO спрашивает **кто получатель и где он учреждён** (Art. 44 ff. DSGVO). Anycast-CDN Google/Cloudflare/Meta в DE не отменяет статуса US-получателя. Поэтому в JSON-отчёте два поля: `evidence.ip.country/asn/asOrg` (DB-IP + iptoasn) и `service.recipientCountry` (собственный каталог сервисов, §8). Формулировка в отчёте — только факты: «Verbindung zu `fonts.gstatic.com` (Google LLC, USA; Server-Standort laut GeoIP: DE)».
- Список «внутри ЕС/ЕЭЗ + адекватность» ведём сами (одна JSON-таблица): ЕЭЗ = ЕС-27 + IS, LI, NO; решения об адекватности с сайта Еврокомиссии (Андорра, Аргентина, Канада (commercial), Фарерские о-ва, Гернси, Израиль, о. Мэн, Япония, Джерси, Новая Зеландия, Корея, Швейцария, Великобритания, Уругвай, США только для DPF-сертифицированных) ⚠ проверить актуальный перечень (UK-продление, Бразилия).
- **EU-US DPF**: Общий суд отклонил иск Latombe (T-553/23) 03.09.2025; апелляция **C-703/25 P** подана 31.10.2025, в июне 2026 вступила Microsoft; решения нет ⚠. DPF-статус конкретной компании — ручное поле `dpfCertified` в каталоге (у dataprivacyframework.gov нет официального bulk-API ⚠).

---

## 5. Уязвимости для VULN-01/02

### 5.1 Таблица

| Источник | Покрытие WP (ядро/плагины/темы) | JS-библиотеки | TYPO3 / Drupal / Joomla | Формат, доступ | Лицензия | Офлайн vs онлайн | Признак «эксплуатация без входа / KEV» | Вердикт |
|---|---|---|---|---|---|---|---|---|
| **OSV.dev** | нет (нет экосистемы WordPress; `wpackagist-plugin/elementor` → `{}`) | npm (jquery 3.4.1 → GHSA-gxr4-xjj5-5px2, GHSA-jpcq-cgw6-v4j6) | Packagist: `typo3/cms-core` 128, `georgringer/news` 2, `drupal/core` 201 (ID `DRUPAL-CORE-*`), `joomla/joomla-cms` 8 | `POST /v1/query`, `/v1/querybatch` без ключа; снапшоты `gs://osv-vulnerabilities/<ECOSYSTEM>/all.zip` | по источнику: GHSA CC-BY 4.0; часть источников NC (Chainguard/Wolfi CC BY-NC-ND) — фильтровать по экосистеме | оба | CVSS в записи (`severity`), KEV — нет | **основной для TYPO3/Drupal/Joomla/npm** |
| GitHub Advisory Database | нет | npm | Composer (TYPO3, Drupal) | git-репо/REST/GraphQL | **CC-BY 4.0** | офлайн-снапшот | CVSS, CWE | через OSV |
| NVD | CPE для WP-плагинов фрагментарный, backlog обогащения 2024–25 | частично | да | JSON API 2.0; без ключа 5 req/30 s, с ключом 50 req/30 s, рекомендуют sleep 6 s; JSON-фиды 1.1 отключены (дек. 2023) — всё ⚠ по вторичным источникам, страница ToU за JS-челленджем | US-gov work, public domain; просят notice «This product uses data from the NVD API but is not endorsed or certified by the NVD.» ⚠ | онлайн | CVSS v3.1 вектор → `PR:N` | **вторичный** (обогащение по CVE-ID при наличии ключа) |
| **CISA KEV** | всё, что в KEV | да (jQuery-кейс из каталога ⚠ проверить, что именно за CVE) | да | JSON `cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`; `catalogVersion 2026.10.29`, `count 1764`; поля `cveID, vendorProject, product, vulnerabilityName, dateAdded, shortDescription, requiredAction, dueDate, knownRansomwareCampaignUse, notes, cwes` | **CC0 1.0** (license.txt) | **вендорить снапшот + обновлять при запуске** | **это и есть признак critical** | ✔ |
| **ENISA EUVD** | да — записи CNA Wordfence (`assigner: "Wordfence"`), поиск «wordpress» → 22 236 | да | да | `GET euvdservices.enisa.europa.eu/api/search?text=&size=`, `/api/lastvulnerabilities`, `/api/exploitedvulnerabilities` (проверены, без ключа); `/api/enisaid?id=`, `/api/vulnerability?id=` ⚠ по community-OpenAPI; поля `id, aliases (CVE/GHSA), baseScore, baseScoreVector, epss, exploited, enisaIdProduct{vendor, product, version}` | условия использования не найдены; общий legal notice ENISA: воспроизведение с указанием источника, публикации CC BY 4.0 — ⚠ не подтверждено для EUVD; `/apidoc` — только JS | онлайн | `exploitedvulnerabilities` + EPSS | **онлайн-обогащение, opt-in**; европейский источник — плюс для отчёта |
| **retire.js jsrepository** | нет | **да**: 76 библиотек (`jquery, jquery-ui, bootstrap, angularjs, @angular/core, react, lodash, moment.js, nextjs, ckeditor, pdf.js, DOMPurify…`); `extractors.uri/filename/filecontent` с `§§version§§`, `hashes`, `func`; `vulnerabilities[] {atOrAbove/below (ranges), severity, cwe, identifiers {CVE, githubID, summary}, info}` | нет | `repository/jsrepository-v4.json … -v6.json` (76), `jsrepository-master.json`, `npmrepository.json` (409, deprecated); CLI/npm `retire` 6.1.0 (06.10.2026) | **Apache-2.0** | **вендорить + обновлять** | `severity` + CVE → KEV | ✔ основной для VULN-02 (JS) |
| **Wordfence Intelligence** | **да, самый полный** (ядро/плагины/темы, CNA) | нет | нет | v3: `GET /api/intelligence/v3/vulnerabilities/production` и `/scanner`, `Authorization: Bearer <key>` (без ключа → 401, проверено); v2 → **HTTP 410** (v1/v2 отключены 09.03.2026 ⚠); ключ бесплатный, «free for personal and commercial use» ⚠ (сайт отдаёт боту пустой 202); production-фид ~158 МБ / ~42,5 тыс. записей, повторная полная выгрузка → 429 ⚠ (сторонний клиент); атрибуция Wordfence + копирайт MITRE для CVE; Terms обновлены 26.01.2026 | custom terms, коммерческое использование разрешено ⚠ | **тянуть при запуске/обновлении** с ключом пользователя, кэш | `cvss.vector` (`PR:N/AV:N`), `cwe`, заголовки «Unauthenticated … RCE/SQLi/Arbitrary File Upload/Privilege Escalation» | ✔ опциональный основной для WP |
| WPScan (Automattic) | да | нет | нет | REST, ключ | «requires a paid license for commercial use»; free 25 вызовов/день только non-commercial | — | `cvss`, `poc` | **нельзя** |
| Patchstack | да | нет | нет | Threat Intelligence API `patchstack.com/database/api/v2/`, заголовок `PSKey`; Standard (legacy, 5 000 req/24 h, новым не продаётся), Extended — custom pricing; поля `vuln_type, cvss_score, cve, is_exploited, patch_priority, affected_in, fixed_in, patched_in_ranges` | договор; условий редистрибуции нет | — | `is_exploited`, заголовки «Unauthenticated …» | **нельзя без договора** → только идея (их маркировка auth-уровня в заголовках) |
| **WPVulnerability (wpvulnerability.net)** | да (ядро `/core/{ver}`, плагины `/plugin/{slug}`, темы `/theme/{slug}`; плюс `/php`, `/apache`, `/nginx`… ) | нет | нет | JSON без ключа; `data {name, plugin, link, latest, closed, closed_reason, closed_date, vulnerability[] {uuid, name, operator {min_version, min_operator, max_version, max_operator, unfixed, closed}, source[] {id, name, link, description, date}}}` — в источниках CVE, WPScan, Wordfence (проверено на `contact-form-7`: 12 записей); «Please consider using it reasonably», донаты для интенсивного использования | **CC0 1.0** («dedicated to the public domain»), «underlying source keeps its own terms» | онлайн (снапшот не публикуется) | только через ссылки на источники/CVE → нужен NVD/EUVD/KEV для вектора ⚠ проверить наличие cvss/impact в полной схеме | ✔ **основной для WP в MVP без ключей**; риск — один мейнтейнер (Javier Casares / ROBOTSTXT), SLA нет |
| TYPO3 Security Advisories | — | — | TYPO3-CORE-SA / TYPO3-EXT-SA / PSA; RSS `news.typo3.com/security/rss-security`; машинно — через GHSA/OSV (Packagist) | RSS/HTML | ⚠ лицензия контента не указана | — | — | читать через OSV; RSS для свежих EXT-SA |
| Drupal security | — | — | RSS `drupal.org/security/rss.xml`, `/security/contrib/rss.xml`, `/security/psa/rss.xml`; OSV содержит `DRUPAL-CORE-*` | RSS | ⚠ лицензия контента drupal.org не подтверждена | — | — | через OSV |
| Joomla | — | — | OSV `joomla/joomla-cms` 8; VEL переехал на `extensions.joomla.org/vulnerable-extensions` («All Rights Reserved»; JSON-feed редиректит ⚠) | — | — | — | — | P2, через OSV |
| FriendsOfPHP/security-advisories | нет | нет | typo3, drupal, joomla, magento, contao… (YAML по `vendor/package`, `composer://`) | git | **Unlicense** (public domain); «not authoritative» | офлайн | — | резерв/оффлайн для Composer |

### 5.2 Схема уровня для VULN (по каталогу: critical = «эксплуатация без входа … или запись в KEV»)

`critical`, если выполнено любое: (a) CVE ∈ KEV (CC0, снапшот); (b) CVSS-вектор `AV:N` ∧ `PR:N` ∧ (`C:H` ∨ `I:H` ∨ `A:H`) из Wordfence/OSV/NVD/EUVD; (c) заголовок/CWE из класса RCE (CWE-94/-502), SQLi (CWE-89), arbitrary upload (CWE-434), auth bypass (CWE-287/-288), privilege escalation (CWE-269) **и** в заголовке «Unauthenticated»; (d) CVE ∈ EUVD `exploitedvulnerabilities` (opt-in). Иначе `warning`. Все четыре признака — факты с источником, без юридической оценки.

### 5.3 Поток данных для MVP

`fingerprint (CMS, slug, version)` → WordPress: WPVulnerability (`/plugin/{slug}`, сравнить `operator` с версией; `latest` даёт «устарел, но без CVE» = `T3_OUTDATED_CVE`-кандидат) → если задан `WORDFENCE_API_KEY`: сверка с кэшем production-фида (вектор CVSS) → JS: retire.js-экстракторы по URL/телу скрипта (Playwright `response.text()`) → TYPO3/Drupal/Composer: OSV `querybatch` → KEV-пересечение → уровень. Для версий «что актуально сейчас»: `api.wordpress.org/plugins/info/1.2/` и `api.wordpress.org/core/version-check/1.7/` (бесплатно, без ключа; ⚠ ToS не проверял), TER REST API для TYPO3 ⚠.

---

## 6. Фингерпринтинг версий

| Источник | Лицензия | Факты | Вердикт |
|---|---|---|---|
| Wappalyzer (оригинал) | закрыт с августа 2023, репозиторий удалён | — | — |
| enthec/webappanalyzer | **GPL-3.0** (LICENSE проверен), коммит 19.10.2026 | `src/technologies/{_,a…z}.json`, `categories.json`, `groups.json`, `schema.json`; поля `cats, website, js, headers, cookies, scriptSrc, dom, meta, html, implies, requires`, версии через `\;version:\1`; ≈855 коммитов | **не вендорить**; опционально тянуть при запуске (`--fingerprints wappalyzer`, по умолчанию off) |
| HTTPArchive/wappalyzer | **GPL-3.0**, коммит 26.10.2026, используется для ежемесячного HTTP Archive crawl; есть `cli.js` | тот же формат | то же |
| js-library-detector (Lighthouse) | **MIT**, 6.7.0 (27.07.2023) | детект JS-библиотек и версий в контексте страницы | опционально; стареет |
| retire.js extractors | Apache-2.0 | regex по URL/имени файла/содержимому, хэши | **основа для версий JS** |
| WhatWeb (GPL-2.0), CMSeeK (GPL-3.0), droopescan (AGPL-3.0), typo3scan (GPL-3.0) | copyleft | идеи сигнатур | только идея |

Рекомендация MVP: собственный набор отпечатков под Apache-2.0 (писать с нуля, не переносить записи из GPL-JSON): WordPress (`<meta name="generator">`, `/wp-content/`, `/wp-includes/`, `?ver=`), TYPO3 (`typo3/sysext/`, `typo3temp/assets/`, `typo3conf/ext/` — версия ядра пассивно почти не видна ⚠, отчёт даст «TYPO3 erkannt, Version nicht ermittelbar»), Drupal (`/core/misc/drupal.js`, `X-Generator`), Joomla, Shopware; плагины из топа VULN-02 — Elementor, Contact Form 7, Borlabs, Divi, Slider Revolution, WPBakery, Yoast, WooCommerce — по путям `/wp-content/plugins/{slug}/…?ver=X` и по `readme.txt` («Stable tag», один GET на плагин, с rate-limit и честным UA — пассивно, но это дополнительный запрос; согласовать с заказчиком).

---

## 7. Итоговая таблица «источник → лицензия → вердикт»

| Источник | Лицензия | Вердикт | Роль |
|---|---|---|---|
| third-party-web | MIT | вендорить (npm) | домен → сервис/компания/категория |
| Open Cookie Database | Apache-2.0 | вендорить | классификация cookie |
| AdGuard cname-trackers | MIT | вендорить | CNAME-cloaking |
| EasyPrivacy / EasyList / EasyList Germany / Cookie List | GPLv3 **или** CC BY-SA 3.0 | тянуть при запуске (кэш); допустимо вендорить отдельным файлом по CC BY-SA | «это трекер» + правило как доказательство |
| @ghostery/adblocker(-playwright) | MPL-2.0 | зависимость | матчинг правил |
| @duckduckgo/autoconsent | MPL-2.0 | зависимость (+ свой слой семантики) | CMP detect/optOut, все 7 CMP |
| Consent-O-Matic | MIT | вендорить как референс | резервные селекторы |
| IAB cmp-list.json / GVL | права зарезервированы IAB | только при запуске/⚠; читать `__tcfapi` | TCF-сайты (P2) |
| tldts (+PSL) | MIT (+MPL-2.0) | зависимость | eTLD+1 |
| DB-IP Lite | CC BY 4.0 | тянуть при запуске/сборке (атрибуция в отчёте) | страна/ASN IP |
| iptoasn.com | PDDL | вендорить/тянуть | ASN → организация |
| IPinfo Lite | CC BY-SA 4.0 | опционально, токен | альтернатива |
| MaxMind GeoLite2 | EULA (+CC BY-SA на элементы) | не вендорить; опционально по ключу | альтернатива |
| IP2Location LITE | противоречивые условия ⚠ | нельзя вендорить; пропустить | — |
| CISA KEV | CC0 | вендорить снапшот + обновлять | critical-флаг |
| retire.js jsrepository | Apache-2.0 | вендорить + обновлять | JS-библиотеки |
| WPVulnerability | CC0 | онлайн без ключа | WP ядро/плагины/темы |
| Wordfence Intelligence v3 | custom, free commercial ⚠ | тянуть по ключу пользователя | WP, CVSS-вектор |
| OSV.dev | по источнику (GHSA CC-BY 4.0) | онлайн + опц. снапшот Packagist/npm | TYPO3/Drupal/Joomla/npm |
| GitHub Advisory DB | CC-BY 4.0 | через OSV | — |
| ENISA EUVD | ⚠ условия | онлайн, opt-in | exploited/EPSS, EU-источник |
| NVD | public domain ⚠ notice | онлайн по ключу, opt-in | обогащение |
| FriendsOfPHP/security-advisories | Unlicense | офлайн-резерв | Composer |
| WPScan | платно для коммерции | нельзя | — |
| Patchstack API | договор | нельзя | идея маркировки «Unauthenticated» |
| DuckDuckGo Tracker Radar | CC BY-NC-SA 4.0 | нельзя → идея | модель данных |
| Disconnect | CC BY-NC-SA 4.0 | нельзя | — |
| Ghostery TrackerDB / @ghostery/trackerdb | CC BY-NC-SA 4.0 | нельзя → идея | модель organizations/patterns |
| AdGuard companiesdb | CC BY-SA 4.0, цепочка ⚠ | при запуске, отдельно; не основа | компания по домену (резерв) |
| AdGuard filters | GPL-3.0 | не вендорить; не нужно | — |
| Wappalyzer-форки | GPL-3.0 | не вендорить; опц. при запуске | расширенный фингерпринт |
| webXray owner list | GPL-3.0, мёртв | только идея | поля aliases/country |
| Cookiepedia | проприетарно | нельзя | ручная справка |
| cookiedatabase.org | CC BY-NC-ND 4.0 | нельзя | — |
| WEC (EDPS), Blacklight, tracker-radar-collector | EUPL-1.2 / GPL-3.0 / Apache-2.0 | аналоги; код tracker-radar-collector можно заимствовать | референс |

---

## 8. Рекомендуемая комбинация для MVP

| Модуль | Данные | Режим | Атрибуция в отчёте/NOTICE |
|---|---|---|---|
| Классификация запросов/cookie (CONSENT-01/02, TRACK-01, EMBED-*) | свой каталог сервисов → third-party-web (fallback) → EasyPrivacy+EasyList Germany через @ghostery/adblocker → Open Cookie Database → cname-trackers | каталог/OCD/cname: в репо; EasyList: кэш `~/.cache/dsgvo-check/` при `update`, снапшот в Docker-образе | «The EasyList authors», third-party-web (MIT), OCD (Apache-2.0) |
| CMP (CONSENT-03…06) | autoconsent rules.json + собственный `cmp-semantics.json` (first-layer buttons, немецкие подписи, consent-cookies) | зависимость | MPL-уведомление |
| First/third party | tldts | зависимость | — |
| GeoIP/ASN | DB-IP Country+ASN Lite, iptoasn | загрузка при `update`/сборке образа, кэш; опц. MaxMind/IPinfo по ключам | «IP Geolocation by DB-IP» (ссылка обязательна) |
| Получатель/третья страна | свой каталог (`company, hqCountry, dpfCertified`), свой `adequacy.json` | в репо | — |
| VULN WP | WPVulnerability (без ключа) + Wordfence v3 (по ключу) | онлайн + кэш | Wordfence + MITRE-копирайт CVE, если показываем их тексты |
| VULN JS | retire.js jsrepository | вендорить, обновлять `update` | Apache-2.0 |
| VULN TYPO3/Drupal/Composer | OSV API (+опц. снапшот) | онлайн | GHSA CC-BY 4.0 |
| critical | KEV снапшот (+ EUVD exploited opt-in) | вендорить + обновлять | CC0 |
| Фингерпринт | свои отпечатки + retire-экстракторы; Wappalyzer-форк opt-in | в репо / кэш | — |
| Режимы | `dsgvo-check update` (все скачиваемые наборы с датой снапшота в JSON-отчёте), `--offline` (только вендоренное + кэш), `--no-network-data` для CI без egress | | |

Принципы: в репо и образе только CC0/PDDL/MIT/Apache/CC BY; CC BY-SA и GPL — только в кэше пользователя и только отдельными файлами; NC — никогда. В JSON-отчёте для каждой находки — `evidence.source` (имя набора + версия/дата снапшота), чтобы заказчик мог защитить вывод в аудите.

---

## 9. Что придётся вести самим

1. **Каталог сервисов (`services.yaml`)** — ядро PRIV-01/02 и `crmCode`: `id, name, aliasesDe[] (например Google Fonts: «Google Fonts», «Google Web Fonts», «Schriftarten von Google», «fonts.googleapis.com»; Meta Pixel: «Meta-Pixel», «Facebook-Pixel»; Google Maps: «Google Maps», «Google Karten»; reCAPTCHA; YouTube/«youtube-nocookie»; Trustindex; Elfsight; Hotjar; Adobe Fonts/Typekit; Vimeo; Cloudflare; Matomo), category (fonts | maps | video | captcha | analytics | ads | tag-manager | social | widget | chat | cdn | consent | payment), domains[] (glob), company, hqCountry, euHostingClaimPossible, dpfCertified ⚠ (ручное), consentRequiredByDefault, defaultCrmCode (`T1_FONTS_EXTERNAL`, `T1_MAPS_BEFORE_CONSENT`, `T1_TRACKER_BEFORE_CONSENT`, `T1_OTHER`), policyKeywords[]`. Старт — ~100 записей из 80 аудитов; third-party-web — только fallback.
2. **Семантика CMP первого уровня** (`cmp-semantics.json`): для 7 CMP — селекторы `rejectAll | acceptAll | settings | close`, допустимые подписи отказа, флаг «отказ только на втором уровне»; плюс эвристика по тексту для неизвестных баннеров → `info`.
3. **Allowlist технически необходимых cookie**: cookie согласия CMP (`borlabs-cookie*`, `CookieConsent`, `cmplz_*`, `uc_*`, `ccm_consent`, `real_cookie_banner-*`, `cookiehub`), сессии (`PHPSESSID`, `wordpress_test_cookie`, `wp-wpml_current_language`, `fe_typo_user`…) — иначе CONSENT-02 шумит.
4. **Собственные отпечатки CMS/плагинов** (Apache-2.0) и правила извлечения версий (`?ver=`, `readme.txt`, generator).
5. **`adequacy.json`** (ЕЭЗ + адекватность + DPF-оговорка) с датой и источником (страница Еврокомиссии).
6. **`THIRD_PARTY_NOTICES.md` + футер отчёта** с обязательными атрибуциями (DB-IP ссылка, EasyList authors, MITRE/CVE, NVD-notice при использовании, Wordfence, MaxMind — если включён).
7. **Снапшот-менеджер**: манифест наборов (URL, лицензия, частота, дата, SHA-256) — то, что `dsgvo-check update` обновляет и что попадает в `report.meta.datasets`.
8. Не данные, но тоже своё: паттерны ссылок Impressum/Datenschutz (LEGAL-01), устаревшие нормы для LEGAL-02 (TMG/RStV → DDG/MStV), baseline заголовков (HDR-01).

---

## Источники

| URL | Что подтверждает |
|---|---|
| https://github.com/duckduckgo/tracker-radar | CC BY-NC-SA 4.0; «license the list for commercial use, please reach out» |
| https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/LICENSE | Disconnect: CC BY-NC-SA 4.0 |
| https://easylist.to/pages/licence.html | EasyList/EasyPrivacy: GPLv3+ или CC BY-SA 3.0+, атрибуция «The EasyList authors» |
| https://github.com/ghostery/trackerdb ; https://registry.npmjs.org/@ghostery%2Ftrackerdb | TrackerDB CC BY-NC-SA 4.0; npm 1.0.959 |
| https://github.com/whotracksme/whotracks.me | контент CC BY 4.0, код MIT, зависит от TrackerDB |
| https://github.com/AdguardTeam/companiesdb ; …/companiesdb/main/LICENSE | структура trackers/companies; CC BY-SA 4.0; «basically the Whotracks.me database converted» |
| https://github.com/AdguardTeam/AdGuardFilters | GPL-3.0 |
| https://github.com/AdguardTeam/cname-trackers | MIT; форматы файлов |
| https://github.com/jkwakman/Open-Cookie-Database ; raw `open-cookie-database.csv` | Apache-2.0; колонки CSV; ~2 279 строк; коммит 16.10.2026 |
| https://cookiepedia.co.uk/ | OneTrust, All Rights Reserved, нет API |
| https://cookiedatabase.org/ | CC BY-NC-ND 4.0 |
| https://github.com/patrickhulce/third-party-web (raw `data/entities.js`) ; https://registry.npmjs.org/third-party-web | MIT; 0.30.0 (14.09.2026); 2 143 сущности; распределение категорий |
| https://wiki.personaldata.io/wiki/WebXray_domain_ownership_list ; GitHub API `RDBinns/webXray_Domain_Owner_List` | поля списка webXray; форк GPL-3.0, 2018; оригинал 404 |
| https://github.com/the-markup/blacklight-collector | GPL-3.0; `data/webxray`, `data/blocklists` |
| https://code.europa.eu/edps/website-evidence-collector (README main) | EUPL-1.2; EasyList-списки в `assets/` под их лицензией |
| https://github.com/duckduckgo/tracker-radar-collector (LICENSE) | Apache-2.0; push 28.10.2026 |
| https://github.com/duckduckgo/autoconsent ; GitHub API `contents/rules/autoconsent`, `contents/lib/cmps`; raw `borlabs.json`, `real-cookie-banner.json`, `ccm19.json`; https://registry.npmjs.org/@duckduckgo%2Fautoconsent | MPL-2.0; 913 правил; 7/7 CMP; формат правил; 17.1.0 от 30.10.2026 |
| https://github.com/cavi-au/Consent-O-Matic ; raw LICENSE; GitHub API `contents/rules`, `commits` | MIT; формат detectors/methods; 204 правила; 4/7 CMP; коммит 07.11.2025 |
| https://cmplist.consensu.org/v2/cmp-list.json | 274 CMP, lastUpdated 2026-10-29; id Borlabs 323, Cookiebot 134, Usercentrics 5, Complianz 332, CookieHub 354 |
| https://iabeurope.eu/wp-content/uploads/IABEurope_TransparencyConsentFramework_TermsConditions.pdf | T&C апрель 2023, §8(a) права зарезервированы |
| https://github.com/publicsuffix/list ; https://publicsuffix.org/list/ | MPL-2.0; «no more than once per day» |
| https://registry.npmjs.org/tldts ; …/psl ; …/tldts-experimental | tldts 7.4.19 (20.10.2026) MIT; psl 1.15.0 (2024) |
| https://www.maxmind.com/en/geolite2/eula | ред. 12.02.2026; §3 CC BY-SA на copyrightable elements; §6.1 disclosure; §6.3 30 дней; текст атрибуции |
| https://forum.matomo.org/t/maxmind-is-changing-access-to-free-geolite2-databases/35439 (и др. в выдаче) | с 30.12.2019 аккаунт+ключ, до того CC BY-SA 4.0 |
| https://db-ip.com/db/lite.php ; HEAD https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz | CC BY 4.0; текст атрибуции; ежемесячно; скачивание без аккаунта (200) |
| https://ipinfo.io/lite ; https://support.ipinfo.io/hc/en-us/articles/34121895556242-Legacy-Free-API-vs-IPinfo-Lite | CC BY-SA 4.0; поля; токен обязателен |
| https://lite.ip2location.com/ ; https://lite.ip2location.com/data-license ; https://blog.ip2location.com/?p=5634 | аккаунт; «not permitted to redistribute or resell»; текст атрибуции; блог — CC BY-SA 4.0 (противоречие) |
| https://iptoasn.com/ | PDDL v1.0; ежечасно; TSV |
| https://github.com/sapics/ip-location-db | агрегатор, лицензии по наборам |
| https://google.github.io/osv.dev/data/ ; `POST https://api.osv.dev/v1/query` ; `osv-vulnerabilities.storage.googleapis.com/ecosystems.txt` | экосистемы; лицензии по источнику; счётчики typo3/cms-core 128, drupal/core 201, georgringer/news 2, joomla 8, jquery 3.4.1 → 2; wpackagist → {} |
| https://github.com/github/advisory-database | CC-BY 4.0; экосистемы |
| https://www.cisa.gov/known-exploited-vulnerabilities-catalog ; `…/licenses/kev/license.txt` ; `…/feeds/known_exploited_vulnerabilities.json` | CC0 1.0; 1 764 записи; catalogVersion 2026.10.29; поля |
| `https://euvdservices.enisa.europa.eu/api/search?text=wordpress&size=1`, `/api/lastvulnerabilities`, `/api/exploitedvulnerabilities` | API без ключа; поля; total 22 236 |
| https://www.enisa.europa.eu/about-enisa/legal-notice ; https://www.enisa.europa.eu/about-enisa/legal-notice/enisa-ipr-policy-public-version | общие условия ENISA (воспроизведение с указанием источника; публикации CC BY 4.0) |
| https://github.com/RetireJS/retire.js ; GitHub API `contents/repository`, `releases/latest`; raw `repository/README.md`, `jsrepository-v4.json`; https://registry.npmjs.org/retire | Apache-2.0; 6.1.0 (06.10.2026); 76 библиотек; формат extractors/vulnerabilities |
| https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/ (через поиск; сайт отдаёт 202/пусто) ; `GET …/api/intelligence/v2/vulnerabilities/scanner` → 410 ; `…/v3/vulnerabilities/scanner|production` → 401 | v3 с бесплатным ключом; v2 отключён; free for commercial ⚠ |
| https://www.wordfence.com/blog/2022/12/wordfence-free-vulnerability-database/ ; https://github.com/typisttech/wordfence-api | «free … for commercial use»; атрибуция MITRE/Wordfence; Terms обновлены 26.01.2026 |
| https://wpscan.com/pricing/ | 25 вызовов/день; «requires a paid license for commercial use» |
| https://patchstack.com/database/ ; https://docs.patchstack.com/llms-full.txt | заголовки «Unauthenticated…»; Threat Intelligence API: Standard 5 000/24 h legacy, Extended custom; поля |
| https://www.wpvulnerability.com/ ; https://www.wpvulnerability.com/license/ ; `GET https://www.wpvulnerability.net/plugin/contact-form-7`, `/core/6.4.2` | CC0 1.0; без ключа; структура ответа; источники CVE/WPScan/Wordfence |
| https://news.typo3.com/security | RSS `rss-security`; TYPO3-EXT-SA/PSA |
| https://www.drupal.org/security | RSS core/contrib/psa |
| https://extensions.joomla.org/vulnerable-extensions/about/ | VEL, All Rights Reserved |
| https://github.com/FriendsOfPHP/security-advisories | Unlicense; покрытие typo3/drupal/joomla |
| https://github.com/enthec/webappanalyzer (+raw LICENSE, GitHub API commits) ; https://github.com/HTTPArchive/wappalyzer (+raw LICENSE) | оба GPL-3.0; формат технологий; активность 19.10 / 26.10.2026 |
| https://registry.npmjs.org/js-library-detector | MIT, 6.7.0 (2023) |
| https://github.com/ghostery/adblocker ; Context7 `/ghostery/adblocker` ; https://registry.npmjs.org/@ghostery%2Fadblocker-playwright | MPL-2.0; `FiltersEngine.fromLists`, `engine.match → {match, filter, exception, redirect}`; 2.20.3 (28.10.2026) |
| https://www.wilmerhale.com/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20251201-european-court-of-justice-to-review-challenge-to-eu-us-data-privacy-framework ; https://ieu-monitoring.com/editorial/microsoft-backs-eu-commission-in-eu-court-case-on-transatlantic-data-flows-and-privacy/1244467/ | T-553/23 отклонён 03.09.2025; апелляция C-703/25 P от 31.10.2025; июнь 2026 — Microsoft вступила; решения нет |
| https://github.com/aboutcode-org/vulnerablecode/issues/2011 ; https://gitlab.alpinelinux.org/alpine/infra/docker/secfixes-tracker/-/issues/1 | NVD 5/30 s и 50/30 s; notice-текст (вторичные) |

## Открытые вопросы

1. **Wordfence Intelligence v3**: прочитать Terms (26.01.2026) живым браузером — коммерческое использование, формулировка атрибуции, rate-limit полной выгрузки (сообщают 429), стабильность схемы. Без этого Wordfence остаётся «по ключу пользователя, под его ответственность».
2. **ENISA EUVD**: официальные условия использования API и данных (страница `/apidoc` рендерится JS); нет ли запрета на автоматический доступ. Запросить ENISA напрямую — для продукта «made for EU» это сильный аргумент.
3. **AdGuard companiesdb**: подтвердить у AdGuard правомерность CC BY-SA при NC-источнике (TrackerDB). До ответа — не использовать как основу.
4. **IAB cmp-list.json**: допустимо ли нерегистрированному инструменту кэшировать список? Альтернатива `__tcfapi('ping')` закрывает потребность — возможно, вопрос снимается.
5. **NVD**: подтвердить точный текст ToU/notice и лимиты на nvd.nist.gov (страница за JS-челленджем).
6. **IP2Location LITE**: противоречие «CC BY-SA 4.0» (блог) vs «not permitted to redistribute» (Terms) — не использовать до разъяснения.
7. **GeoLite2 EULA**: нужна юридическая оценка заказчика, разрешает ли §3/§6.1 (CC BY-SA на элементы) включать базу в публичный Docker-образ. Мы исходим из «нет».
8. **§ 87a UrhG**: согласовать с заказчиком правило «собственный каталог — только из своих аудитов и первичных источников вендоров», чтобы исключить претензии по извлечению из NC-баз.
9. **DPF**: как формулировать в отчёте US-получателей при неопределённости C-703/25 P (предложение: факт «Empfänger in den USA; DPF-Zertifizierung: ja/nein/unbekannt», без оценки).
10. **WPVulnerability**: проверить полную схему ответа (есть ли `cvss`/`impact`, включены ли данные Patchstack), и договориться о «reasonable use»/донате — заказчик планирует коммерческое использование.
11. **retire.js**: какой `jsrepository-vN.json` потребляет CLI 6.x и чем v6 отличается от v4 при равном числе библиотек (76); хватит ли 76 библиотек для топа VULN-02 (jQuery — да; Slider Revolution/Elementor — это WP-плагины, покрываются Wordfence/WPVulnerability).
12. **GPL-данные при запуске** (AdGuard, Wappalyzer-форки): принять ли позицию «загрузка данных в кэш пользователя ≠ производное произведение» или полностью исключить из продукта. Предложение: исключить из MVP.
13. **Политика загрузки EasyList**: частота/зеркала для инструмента, запускаемого в CI множеством клиентов (кэш в образе + `update` не чаще раза в день).
14. **Лицензия контента drupal.org / typo3.org** для цитирования текстов advisories в отчёте (решение: ссылаться, не копировать).
