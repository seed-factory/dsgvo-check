# dsgvo-check — этап 0: таблица аналогов (prior art)


Статус: исследовательский черновик · Дата среза: 2026-10-30 · Иллюстрации не являются реализацией.

Метод: метаданные репозиториев (лицензия, архив, последний push) — GitHub REST API, code.europa.eu (GitLab API), Codeberg API, npm registry; релизы — Atom-ленты GitHub и API релизов; функциональность — README, исходники и официальные страницы. Всё, что не подтверждено первоисточником, помечено «⚠ проверить».

---

## Коротко

1. **Ни один аналог не закрывает P0 целиком.** По consent-части ближе всех — `Slashgear/gdpr-cookie-scanner` (TypeScript + Playwright, MIT, exit 0/1/2, готовые шаблоны GitHub Actions и GitLab CI). По доказательной базе ближе всех EDPS **Website Evidence Collector** (TypeScript + Puppeteer, EUPL-1.2). По безопасности и почте — **Internet.nl**, **ZAP baseline**, **MDN HTTP Observatory** и **testssl.sh**. Ни в одном из изученных инструментов нет PRIV-01/02 («политика vs реальность»), CONSENT-06 (Consent Mode), LEGAL-01/02 с немецкой спецификой и crmCode.
2. **Связка «Playwright + до/после согласия + exit-код для CI» уже не уникальна.** Её делают Slashgear, consentcrawl и несколько мелких репозиториев 2026 года. Отличаться мы должны другим: немецкий фокус, сверка с Datenschutzerklärung, privacy + security + mail/DNS в одном стабильном JSON, гейтинг по ID проверки, crmCode.
3. **Главная находка для CONSENT-03/04/05 — DuckDuckGo `autoconsent`** (MPL-2.0, v17.1.0 от 2026-10-30, 913 JSON-правил). У него есть правила для **всех 7 CMP** из каталога: Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. Есть немецкие эвристики кнопок («ablehnen», «nur notwendige …») и отдельная сборка для Playwright. Подключаем как npm-зависимость. Оговорка: его `optOut` по цепочке fallback может пройти через «Speichern»/«Schließen». Значит, вердикт «отказ на первом уровне» (CONSENT-04) строим своими адаптерами, а autoconsent используем для распознавания CMP и выполнения отказа.
4. **Лицензии.** Копировать код и данные можно только из MIT/Apache/CC0: Slashgear, правила Consent-O-Matic, nuclei-templates, retire.js, Open Cookie Database, third-party-web, Internet.nl, CISA KEV. MPL-2.0 (autoconsent, Observatory, axe-core, Ghostery adblocker) — только немодифицированные зависимости. EUPL-1.2 (WEC, EDPB WAT) и GPL (Blacklight, OpenWPM, форки Wappalyzer, testssl.sh) — только идеи или запуск отдельным процессом. Трекер-базы Disconnect, DuckDuckGo Tracker Radar и Ghostery TrackerDB лицензированы под **CC BY-NC-SA 4.0**, в проект их не включаем.
5. **Wappalyzer закрыт с августа 2023.** Его открытые форки данных (enthec/webappanalyzer, HTTPArchive/wappalyzer) — под GPL-3.0. Для VULN-01/02 делаем узкий собственный каталог отпечатков (ядро WP, плагины и темы через `readme.txt`/`?ver=`, TYPO3) плюс retire.js для JS-библиотек.
6. **Немецкие коммерческие сканеры** (eRecht24, Usercentrics/Cookiebot, CookieYes) — закрытые, работают как лид-генерация, для CI не годятся. eRecht24 сам признаёт ложные срабатывания: он ищет ключевые слова в исходнике и цепляет текст баннера, Elementor, иконку WhatsApp. Это готовый набор **негативных фикстур** для нас. Сканер BayLDA (пресс-релиз 09.02.2024, >350 сайтов, критерий «gleichwertige Möglichkeit auf erster Ebene») не публичен. Федерального IHK-инструмента и сканера 2B Advice не нашли.
7. **Модель гейтинга берём у ZAP baseline:** конфиг `ID → FAIL/WARN/IGNORE` плюс `OUTOFSCOPE`-regex и «не падать на warning». Но у ZAP exit `2` означает «есть WARN», а у нас по ТЗ `2` — «сканер упал». Различие надо явно описать в README.
8. **Доказательную модель берём у WEC:** раздельные фазы collect → `inspection.json` → report (HTML/PDF/DOCX), классифицированные ошибки навигации (`DNS_ERROR`, `TLS_ERROR`, `TIMEOUT`), списки `failed_pages`/`skipped_links` как отчёт о покрытии и запрет префлайт-запросов к третьим сторонам.
9. **Имя.** На GitHub уже есть `CreativeCodingSolutions/dsgvo-check` (TS, без лицензии, «DSGVO-Compliance-Scanner für deutsche Websites», push 2026-06-23). Имя `dsgvo-check` в npm на 2026-10-30 свободно. Решить до этапа 1.
10. **Позиционирование одной фразой** — см. §9.

---

## 1. Легенда

| Знак | Значение |
|---|---|
| ✔ | Проверка из каталога реализована по существу |
| ◐ | Частично: собирает сырые данные без вердикта, только часть признаков, ручной режим или другой метод (например, поиск по исходнику вместо наблюдения сети) |
| ✘ | Нет |
| — | Неприменимо (инструмент — исполнитель, а не проверка) |

Переиспользование в Apache-2.0: **код** можно скопировать или вендорить с сохранением NOTICE · **dep** — только как немодифицированная зависимость или внешний процесс · **идеи** — код и данные не переносим.

---

## 2. Паспорт аналогов (состояние на 2026-10-30)

| # | Инструмент | Статус | Последний релиз | Язык / браузер | Лицензия |
|---|---|---|---|---|---|
| 1 | **Website Evidence Collector (WEC)**, EDPS | жив, активная разработка; переехал с GitHub (`EU-EDPS/…` → 404) на code.europa.eu | v4.6.0 · 2026-10-23 | TypeScript, Node ≥ 22.17 / Chromium через Puppeteer ^25 | EUPL-1.2 (фильтр-листы EasyList — под своими лицензиями) |
| 2 | **EDPB Website Auditing Tool (WAT)** | жив; запущен 29.01.2024 | 3.0.1 · 2026-09-28 | TypeScript, Angular + Electron (десктоп) / puppeteer-core, внутри Lighthouse | EUPL (EDPB: 1.2; в `package.json` указано `EUPL-1.0` ⚠ расхождение) |
| 3 | **MDN HTTP Observatory** (новая версия Mozilla Observatory) | жив | v1.7.2 · 2026-10-26 | JavaScript (Node, ESM) / без браузера, HTTP-клиент axios | MPL-2.0 |
| 4 | **testssl.sh** | жив | 3.2.4 (стабильная, `releases/latest`); снапшоты 3.3dev · 2026-07 | Bash + OpenSSL / без браузера | GPL-2.0 |
| 5 | **ZAP baseline** (`zap-baseline.py`), «ZAP by Checkmarx» | жив | 2.17.0 · 2025-12-15 (стабильная) + weekly w2026-10-29 | Java (JDK 17+) / собственный прокси и spider; AJAX-spider с браузером — опция | Apache-2.0 |
| 6 | **webbkoll** (Dataskydd.net → 5th of July Foundation) | сервис работает (webbkoll.5july.net); код заархивирован: GitHub 2022, Codeberg 2025-04-25 | — (архив) | Elixir + Node/Puppeteer-бэкенд / Chromium | MIT (фронтенд); бэкенд ⚠ проверить |
| 7 | **PrivacyScore** | мёртв: GitHub archived (push 2021-06-22); privacyscore.org не ответил (таймаут, 2026-10-30) | — | Python / ⚠ проверить | GPL-3.0 |
| 8 | **Blacklight collector**, The Markup | жив | v3.11.0 · 2026-06-04 | TypeScript / Chromium через Puppeteer ^22 | GPL-3.0 |
| 9 | **OpenWPM** | жив (исследовательский краулер) | v0.38.0 · 2026-10-04 | Python / Firefox + Selenium | GPL-3.0 |
| 10 | **DuckDuckGo autoconsent** | жив, релизы почти ежедневно | v17.1.0 · 2026-10-30 | TypeScript / контент-скрипт; сборки для расширения, Playwright (`dist/autoconsent.playwright.js`) и Puppeteer | MPL-2.0 |
| 11 | **Consent-O-Matic**, CAVI Aarhus | жив, но медленный (последний push 2026-02) | v1.1.5 · 2025-06-17 | JavaScript / расширение браузера | MIT |
| 12 | **Lighthouse**, Google | жив | v13.6.0 · 2026-10-27 | JavaScript / Chrome через puppeteer-core/CDP; зависимости `third-party-web` ^0.30, `axe-core` 4.14.0 | Apache-2.0 |
| 13 | **Nuclei** + **nuclei-templates**, ProjectDiscovery | жив | движок v3.11.1 · 2026-08; шаблоны v10.5.1 · 2026-10-23 | Go / свой HTTP; headless — опция | MIT / MIT |
| 14 | **retire.js** | жив | 6.1.0 · 2026-10-06 | JavaScript / без браузера | Apache-2.0 (включая `repository/jsrepository-v4.json`) |
| 15 | **Wappalyzer** → открытые форки | оригинал закрыт с 08.2023. Форки: `enthec/webappanalyzer` (только данные, без релизов, push 2026-10-19); `HTTPArchive/wappalyzer` (push 2026-10-26); `projectdiscovery/wappalyzergo` (v0.3.7 · 2026-10-25) | см. статус | данные JSON; wappalyzergo — Go | enthec и HTTPArchive — **GPL-3.0**; wappalyzergo — MIT, но данные берёт из GPL-форков ⚠ |
| 16 | **WPScan** | жив | v4.2.0 · 2026-10-27 | Ruby / без браузера | «WPScan Public Source License»: коммерческое использование только по платной лицензии; API базы уязвимостей — free 25 запросов/день ⚠ проверить актуальные условия |
| 17 | **Internet.nl** (NL Internet Standards Platform) | жив | 1.11.6 · 2026-10-22 | Python/Django / без браузера | Apache-2.0 (переводы — CC BY 4.0; имя и лого исключены) |
| 18 | **Slashgear/gdpr-cookie-scanner** (найден поиском) | жив | npm 3.8.2 · 2026-06-30; push 2026-10-01 | TypeScript, Node ≥ 24 / Playwright, chromium-headless-shell | MIT |
| 19 | **consentcrawl** (dumkydewilde) | полуживой (push 2025-10-12) | PyPI ⚠ | Python / Playwright | MIT |
| 20 | **gdpr-cli** (mirkoschubert, DE) | заброшен (push 2024-05), alpha | — | JavaScript / без браузера (скрейпинг HTML/CSS/JS) | MIT |

Нашли поиском на GitHub, детально не изучали: `trustyourwebsite/cookie-consent-validator` (MIT, TS, «кликает Reject All и проверяет»), `iAnonymous3000/site-behavior-lab` (AGPL-3.0, TS), `ConsentTheater/playbill` (AGPL-3.0, база трекеров), `cookieyes/cookiebannerbench` (MIT, бенчмарк CMP), `54GradSoftware/google-fonts-checker` (DE, лицензия NOASSERTION), `dennisbuchwald/e-mail-check.de` (AGPL-3.0, SPF/DKIM/DMARC по-немецки), `exiv703/ShieldEye_ComplianceScan` (MIT, Python), `strobh/cookie-notice-scanner` (MIT, Python), `CovenantSQL/CookieScanner` (Apache-2.0, Go, заброшен 2023), `seb-1980/dsgvo-scanner` (TS, без лицензии). Это сигнал, что ниша активно заполняется в 2026 году.

---

## 3. Что умеют, чего нет, можно ли переиспользовать

ID — из `specs/dsgvo-check_katalog-proverok.md`.

| Инструмент | Что умеет из каталога | Чего нет (важное для нас) | Переиспользование в Apache-2.0 | Заметки |
|---|---|---|---|---|
| **WEC** | CONSENT-01/02 (cookies, localStorage, beacons, websockets в состоянии «без взаимодействия»), TRACK-01 (beacons по EasyPrivacy), EMBED-01…05 ◐ (список сторонних хостов без категорий), TLS-01 (`https_redirect`), TLS-02 ◐ (`TLS_ERROR` + testssl), TLS-04 (через `--testssl`), HDR-01 ◐ (разбор CSP), HDR-02 ◐ (атрибуты cookies), LEGAL-01 ◐ (поиск ссылок по `keywords.yml`: privacy/legal/cookie — англоцентрично) | Не кликает баннер (только `--set-cookie` для подстановки согласия) → нет CONSENT-03…06. Нет вердиктов, уровней, порога и exit-кода. Нет DNS/MAIL, VULN, FILE, PRIV-01/02 | **идеи** (EUPL-1.2 — копилефт, перелицензировать в Apache нельзя). Можно запускать как внешний инструмент | Эталон «доказательного» отчёта для надзорных органов. Форматы HTML/PDF/DOCX/ODT/JSON/YAML; есть режим `serve`, Docker/Podman. Свой формат cookie-db (glob по имени + домен + категория). В экосистеме есть CI-обёртки (`wec-testrunner`, `ovh/website-evidence-collector-batch`), то есть спрос на CI вокруг WEC существует |
| **EDPB WAT** | То же, что WEC, плюс ручной аудит: скриншоты, мобильный превью, базы знаний для сопоставления целей cookies и трекеров, импорт/экспорт анализов; CONSENT-05 ◐ вручную ⚠ | Не CLI и не CI; десктоп-GUI для аудитора; без порогов | **идеи** (EUPL) | Ориентир для структуры отчёта и «базы знаний целей». Немецкий интерфейс — машинный перевод |
| **MDN HTTP Observatory** | HDR-01 (CSP, HSTS, X-Content-Type-Options, X-Frame-Options/`frame-ancestors`, Referrer-Policy, CORP/COOP/COEP), TLS-01 (redirection), HDR-02 ◐ (Secure/HttpOnly/SameSite у cookies), SRI, CORS | Нет Permissions-Policy (тестов `permissions-policy` в `src/analyzer/tests` нет), версий в заголовках, TLS-02/04, всего privacy. В README CLI отдаёт JSON (grade/score), но флага порога нет ⚠ | **dep** (MPL-2.0); тяжёлые зависимости (fastify, pg, sentry) → как библиотеку брать неудобно, лучше переписать семантику | Источник «правильных» порогов (например, минимальный HSTS max-age) и текстов рекомендаций. `npx @mdn/mdn-http-observatory host` |
| **testssl.sh** | TLS-02 (цепочка, срок, имя), TLS-04 (протоколы и шифры), HDR-01 ◐ (HSTS и прочие заголовки в секции header), HDR-02 ◐ (флаги cookies, баннеры сервера) ⚠, DNS-01 ◐ (CAA) ⚠ | Не браузер; privacy нет; медленный (минуты); нужен bash + собственный OpenSSL | **dep** — как внешний процесс (GPL-2.0, агрегация). Включение в Docker-образ требует соблюдать GPL (исходники/лицензия) ⚠ юр. проверка | WEC интегрирует его опционально (`--testssl`, вызов через `execFile` без shell, импорт готового JSON). Для TLS-04 это самый надёжный способ «честно» предложить TLS 1.0 |
| **ZAP baseline** | HDR-01 (CSP, anti-clickjacking, nosniff, HSTS, Permissions-Policy), HDR-02 (флаги cookies, утечки версий в `Server`/`X-Powered-By`), TLS-03 (mixed content), VULN-02 ◐ (пассивное правило «Vulnerable JS Library», powered by Retire.js). ID правил (10038, 10020, 10021, 10035, 10063, 10010/10011/10054, 10036/10037, 10040, 10003) ⚠ сверить с zaproxy.org/docs/alerts | Нет privacy/consent, DNS/MAIL, TLS-02/04; FILE-01 — только в активном сканировании (нам запрещено); тяжёлый (Java, образ на сотни МБ) | **код/идеи** (Apache-2.0), но код Java нам не нужен | **Эталон CI-гейтинга:** exit 0 = успех, 1 = есть FAIL, 2 = есть WARN без FAIL, 3 = прочий сбой; конфиг правил `ID<TAB>WARN/FAIL/IGNORE`, `ID OUTOFSCOPE regex`, `-I` (не падать на WARN), `-p progress_file` (известные проблемы). Spider по умолчанию 1 минута, затем пассивный анализ |
| **Internet.nl** | MAIL-01 (DMARC), MAIL-02 (SPF), MAIL-03 ◐ (существование `_domainkey`: ждёт NOERROR, а не NXDOMAIN; эвристика ломается на нестандартных DNS-серверах), DNS-01 (DNSSEC; CAA с релиза 1.10, в баллы не идёт), TLS-01, TLS-02, TLS-04, HDR-01 (CSP, Referrer-Policy, nosniff, XFO), SEC-01 (security.txt через библиотеку `sectxt`) | Нет браузера и privacy; тяжёлый серверный стек (Django, свой резолвер); активные TLS-рукопожатия | **код** (Apache-2.0), но это Python → берём семантику проверок и тексты пояснений (переводы CC BY 4.0, с атрибуцией) | Лучший открытый ориентир для MAIL/DNS/TLS. Имя и лого «Internet.nl» использовать нельзя |
| **Nuclei + templates** | FILE-01 (`http/exposures/{configs,files,backups,logs}`; например `git-config.yaml`: GET `/.git/config`, matcher `[core]` и защита от soft-404 через `!contains(body,'<html')`), ADMIN-01 ◐ (шаблоны WP user enum / xmlrpc ⚠), VULN-01/02 ◐ (технологии и CVE, но многие CVE-шаблоны активные), HDR-01 ◐ ⚠ | Нет браузерного privacy; часть шаблонов — фаззинг и перебор (например `zip-backup-files` генерирует десятки имён), это нарушает «не долбить». Экстракторы вытаскивают секреты (`pass = …`) — нам нельзя | **код/данные** (MIT) — список путей и матчеры для FILE-01 переносим вручную с атрибуцией | Брать только пассивные GET с `max-request: 1`; экстракторы секретов **не** переносить |
| **retire.js** | VULN-02 для JS-библиотек (jQuery и др.): extractors по имени файла, содержимому и хэшу, диапазоны версий, CVE | Не знает плагины WP, Elementor, TYPO3; нет KEV | **код/данные** (Apache-2.0) — npm-зависимость или вендоринг `jsrepository-v4.json` | Exit-код при находках настраивается `--exitwith` (по умолчанию 13 ⚠). Тот же движок использует ZAP |
| **Wappalyzer-форки** | Детект технологий и версий (вход для VULN-01/02), категорий «Analytics», «Cookie compliance», «Maps», «Font scripts» (TRACK-01/EMBED ◐) | Нет CVE; детект ≠ проверка | **идеи** для данных (GPL-3.0). wappalyzergo — MIT-код с GPL-данными ⚠ | Безопаснее держать свой узкий каталог (ядро WP, ~10 плагинов из каталога, TYPO3, jQuery через retire.js). В ЕС есть ещё sui generis право на базы данных (Директива 96/9/EC) ⚠ юр. проверка |
| **WPScan** | VULN-01/02 для WordPress (ядро, плагины, темы + база уязвимостей), ADMIN-01 (перечисление пользователей, xmlrpc), FILE-01 ◐ (config backups и db exports — перебором) | Агрессивные режимы перебора; лицензия запрещает коммерческое использование без платной лицензии | **идеи**; API — только опционально, с токеном самого пользователя ⚠ | Не встраивать и не бандлить |
| **webbkoll** | CONSENT-01/02 ◐ (cookies и сторонние запросы при заходе, без классификации), HDR-01 (CSP, HSTS, Referrer-Policy и др.), HDR-02 ◐ (флаги cookies), TLS-01, localStorage, отчёты третьим сторонам через CSP `report-uri`/NEL | Нет баннера и порогов; код в архиве | **код** (MIT, фронтенд на Elixir; для нас — идеи) | Убрал геолокацию сторонних хостов (2021-11-11). Аргумент против IP-геолокации для «передачи за пределы ЕС»: лучше классифицировать по владельцу сервиса |
| **PrivacyScore** | ◐ сторонние встраивания, HTTPS/TLS, заголовки, почта (STARTTLS) ⚠ по памяти | Проект мёртв | **идеи** (GPL-3.0) | Историческая ценность: бенчмарк-листы сайтов |
| **Blacklight** | TRACK-01 (события FB Pixel и GA по параметрам запросов, session recorders вроде Hotjar, сторонние трекеры по ad-block-листам), CONSENT-01/02 ◐ (состояние «без взаимодействия»), сверх каталога — canvas fingerprinting, key logging | Нет баннера, заголовков, TLS, DNS; порогов нет | **идеи** (GPL-3.0) | Методика распознавания событий (`page_view` и др.) полезна для CONSENT-05 и доказательств TRACK-01 |
| **OpenWPM** | ◐ сырые данные для CONSENT-01/02/TRACK-01: HTTP, cookies, JS-вызовы | Исследовательский фреймворк, не аудит; Firefox/Python | **идеи** (GPL-3.0) | Методика инструментирования JS API (до выполнения скриптов страницы) |
| **autoconsent** | CONSENT-03 ◐ (`detectPopup`), CONSENT-04 ◐ (`detectCmp` + шаги `optOut`; эвристическая классификация кнопок с немецкими regex: `ablehnen`, `zustimmung verweigern`, `nur … notwendige/essenzielle`), CONSENT-05 — (выполняет отказ, после которого мы меряем сеть) | Нет вердикта «первый уровень»: `optOut` у Borlabs по цепочке fallback кликает «accept only essential» → «save» → «close» | **dep** (MPL-2.0, npm `@duckduckgo/autoconsent`; экспорты `.`, `./heuristics`, `./rules/rules.json`). Правки файлов autoconsent публикуем под MPL; лучше слать upstream PR | 913 JSON-правил и 11 TS-классов CMP. Есть `prehideSelectors` (скрытие баннера) — при проверке CONSENT-04 их **не** применять |
| **Consent-O-Matic** | CONSENT-04 ◐: правила для Borlabs, Cookiebot, Complianz (`complianz.io`), Usercentrics, Klaro, consentmanager | Нет CCM19, Real Cookie Banner, CookieHub (по именам файлов в `rules-list.json` ⚠) | **код/данные** (MIT) | 206 файлов правил; второй источник селекторов для перекрёстной проверки адаптеров |
| **Lighthouse** | TLS-03 (`is-on-https`, включая mixed content), HDR-01 ◐ (`has-hsts`, `csp-xss`, `clickjacking-mitigation`, `origin-isolation`, `trusted-types-xss`), CONSENT-02 ◐ (`third-party-cookies`), TRACK/EMBED ◐ (сводка по сторонним через `third-party-web`), VULN-02 ◐ (`js-libraries`: только детект, аудита уязвимостей в текущем наборе нет), PERF-01 ✔, BFSG-01 ◐ (часть axe-core) | Нет consent-фаз, DNS, TLS-02/04, privacy-вердиктов | **dep/код** (Apache-2.0); данные `third-party-web` — MIT | Кандидат на P2-плагины PERF-01/BFSG-01. Гейтинг — через Lighthouse CI ⚠ |
| **Slashgear/gdpr-cookie-scanner** | CONSENT-01, CONSENT-02, CONSENT-03 ◐, CONSENT-04 (`no-reject-button`, `buried-reject`, `click-asymmetry`, `pre-ticked`, `asymmetric-prominence`, `nudging`, `misleading-wording`), CONSENT-05 (cookies после отказа, трекеры по фазам), TRACK-01 (своя база трекеров), декодирование IAB TCF (info) | Нет PRIV-01/02, LEGAL, DNS/MAIL, TLS, HDR, VULN, FILE, crmCode; гейтинг по общей оценке 0–100 и буквам A–F, а не по ID; ориентирован на Францию (`--locale fr-FR`, ссылки на CNIL/CEPD); как распознаёт немецкие CMP — ⚠ не проверено | **код** (MIT) — можно брать с атрибуцией | Ближайший функциональный конкурент: exit 0/1/2 как у нас, `--fail-on`, `--json-summary`, Docker ~300 МБ (chromium-headless-shell), примеры для GitHub Actions и GitLab. Зависимости минимальные (commander, playwright) |
| **consentcrawl** | CONSENT-01/02, TRACK-01 (7 ad-block-листов), детект 25+ CMP, скриншоты до и после согласия | Сравнивает «до» и «после **принятия**»; про отказ ⚠ не проверено. Нет CI-порога | **код** (MIT; Python — для нас идеи) | Пакетный режим и SQLite-хранилище результатов |
| **gdpr-cli** (DE) | EMBED-01 (Google Fonts, Typekit — статически), TLS-02 ◐ (сертификат), детект ПО/темы WP | Статический скрейпинг без браузера; alpha; заброшен | **код** (MIT) | Немецкая документация; как продукт неактуален |

---

## 4. Матрица покрытия каталога

Столбцы: WEC · WAT · Slg = Slashgear · aC = autoconsent · BL = Blacklight · wbk = webbkoll · LH = Lighthouse · Obs = MDN Observatory · ZAP = ZAP baseline · tssl = testssl.sh · Inl = Internet.nl · Nuc = Nuclei · rjs = retire.js · WPS = WPScan · eR24 = eRecht24.

| ID | Prio | WEC | WAT | Slg | aC | BL | wbk | LH | Obs | ZAP | tssl | Inl | Nuc | rjs | WPS | eR24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PRIV-01 | P0 | ✘ | ◐ ручн. | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ ⚠ |
| PRIV-02 | P0 | ✘ | ◐ ручн. | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CONSENT-01 | P0 | ✔ | ✔ | ✔ | — | ✔ | ✔ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ исх. |
| CONSENT-02 | P0 | ✔ | ✔ | ✔ | — | ✔ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CONSENT-03 | P0 | ✘ | ◐ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CONSENT-04 | P0 | ✘ | ◐ ручн. | ✔ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| TRACK-01 | P0 | ✔ | ✔ | ✔ | — | ✔ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ исх. |
| EMBED-01 | P0 | ◐ | ◐ | ◐ ⚠ | — | ◐ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ исх. |
| EMBED-02 | P0 | ◐ | ◐ | ◐ ⚠ | — | ◐ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ исх. |
| MAIL-01 | P0 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ | ◐ ⚠ | ✘ | ✘ | ✘ |
| MAIL-02 | P0 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ | ◐ ⚠ | ✘ | ✘ | ✘ |
| HDR-01 | P0 | ◐ | ✘ | ✘ | — | ✘ | ✔ | ◐ | ✔ | ✔ | ◐ | ✔ | ◐ ⚠ | ✘ | ✘ | ✘ |
| TLS-01 | P0 | ✔ | ✘ | ✘ | — | ✘ | ✔ | ◐ | ✔ | ◐ | ◐ | ✔ | ✘ | ✘ | ✘ | ✘ |
| TLS-02 | P0 | ◐ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ | ✔ | ◐ | ✘ | ✘ | ✘ |
| LEGAL-01 | P0 | ◐ | ◐ ручн. | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| EMBED-03/04/05 | P1 | ◐ | ◐ | ◐ | — | ◐ | ◐ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ исх. |
| CONSENT-05 | P1 | ✘ | ◐ ручн. | ✔ | — (исполнитель) | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| CONSENT-06 | P1 | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| VULN-01 | P1 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ | ✘ | ✔ | ✘ |
| VULN-02 | P1 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ◐ | ✘ | ◐ | ✘ | ✘ | ◐ | ✔ JS | ✔ WP | ✘ |
| MAIL-03 | P1 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ | ✘ | ✘ | ✘ | ✘ |
| TLS-03 | P1 | ◐ | ✘ | ✘ | — | ✘ | ◐ | ✔ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| TLS-04 | P1 | ◐ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ | ✔ | ◐ | ✘ | ✘ | ✘ |
| DNS-01 | P2 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ◐ ⚠ | ✔ | ◐ ⚠ | ✘ | ✘ | ✘ |
| HDR-02 | P2 | ◐ | ✘ | ✘ | — | ✘ | ◐ | ✘ | ◐ | ✔ | ◐ | ✘ | ◐ | ✘ | ✘ | ✘ |
| ADMIN-01 | P2 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ ⚠ | ✘ | ✔ | ✘ |
| FILE-01 | P2 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ акт. | ✘ | ✘ | ✔ | ✘ | ◐ | ✘ |
| SEC-01 | P2 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ | ◐ ⚠ | ✘ | ✘ | ✘ |
| LEGAL-02 | P2 | ✘ | ✘ | ✘ | — | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| BFSG-01 | P2 | ✘ | ◐ ⚠ | ✘ | — | ✘ | ✘ | ◐ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| PERF-01 | P2 | ✘ | ◐ ⚠ | ✘ | — | ✘ | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| **CI-порог / exit** | — | ✘ | ✘ | ✔ оценка | — | ✘ | ✘ | ◐ LHCI | ✘ | ✔ по правилу | ⚠ | ✘ | ⚠ | ✔ | ⚠ | ✘ |
| **crmCode / DE-тексты** | — | ✘ | ◐ машинный DE | ✘ | — | ✘ | ◐ DE-UI | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ DE, закрыт |

«исх.» — поиск ключевых слов в исходнике, не наблюдение сети. «ручн.» — аудитор вручную. «акт.» — только в активном режиме.

**Что не делает никто из изученных:** CONSENT-06 (Consent Mode v2 по умолчанию `granted`), PRIV-01/02 (автоматическая сверка наблюдаемых сервисов с текстом Datenschutzerklärung), LEGAL-01 по немецким признакам (Impressum/Datenschutz по DDG/TDDDG, «доступно с каждой посещённой страницы») и LEGAL-02 (TMG/RStV → DDG/MStV). Consent Mode вручную показывает Google Tag Assistant (закрытый) ⚠.

---

## 5. Коммерческие и регуляторные (DE/EU)

| Инструмент | Что делает | Метод | Чего нет | Переиспользование | Заметки |
|---|---|---|---|---|---|
| **eRecht24 Website Scanner** | Ищет «kritische Tools und Plugins» (Google Fonts/Adobe Fonts, Maps, reCAPTCHA, GA, GTM, DoubleClick, Matomo, Vimeo, PayPal, WhatsApp и др.); обещает показать, «ob Ihre Datenschutzerklärung aktuell ist» | По FAQ «scannt den Quellcode» — поиск по исходнику, не браузерная сеть | Нет фаз согласия, проверки «Ablehnen», безопасности; CI нет | ✘ (проприетарный) | FAQ сам перечисляет ложные срабатывания: текст CMP (Real Cookie Banner → GA; Matomo, Vimeo), `CATPCHA` в JS Elementor, иконка WhatsApp, Font Awesome. Готовые **негативные фикстуры**: наш сканер не должен на них срабатывать. Бесплатен, это вход в eRecht24 Premium |
| **Usercentrics Privacy Compliance Scanner** (Cookiebot в той же группе) | Cookies и сторонние запросы, «vorherige Einwilligung», передача в третьи страны | Краулер вендора (детали закрыты) | Нет «Ablehnen», Impressum, безопасности; результаты только после ввода e-mail; полный скан — после создания аккаунта | ✘ | Конфликт интересов: сканер продаёт CMP. Пример результатов — 10 страниц |
| **Cookiebot scanner** | Инвентаризация cookies для декларации CMP | Краулер (free: 1 домен, ≤ 50 подстраниц) | Не аудит согласия | ✘ | Сканирует, чтобы задекларировать cookies, а не проверить поведение |
| **CookieYes cookie checker / scanner** | Инвентаризация cookies, отчёт | Краулер, лимит страниц зависит от тарифа | То же | ✘ | Есть открытый `cookieyes/cookiebannerbench` (MIT) — бенчмарк производительности баннеров, не аудит |
| **2B Advice** | Публичного сканера сайтов не нашли (компания продвигает GRC-платформу Ailance) | — | — | — | ⚠ уточнить у заказчика, что имелось в виду |
| **BayLDA** (Bayern) | Автоматическая проверка: есть ли рядом с «Alle akzeptieren» **gleichwertige** возможность закрыть баннер без согласия **auf erster Ebene**. Пресс-релиз 09.02.2024: >350 сайтов, сначала одна распространённая CMP, потом расширение | Внутренний инструмент | Не публичен | ✘ | Формулировка надзора — прямой критерий для CONSENT-04 |
| **noyb** | Автоматическое картирование consent-flow; в 2021 разослано >500 проектов жалоб | Внутренний инструмент (название «WeComply» ⚠) | Не публичен; в 2021 покрывал ограниченный набор CMP | ✘ | Подтверждает: правоприменение идёт от CMP-адаптеров |
| **IHK / LfDI** | Федерального бесплатного сканера IHK не нашли. Были региональные консультации «Website-Check» (IHK Limburg, 2018–2019). LfD Niedersachsen публикует опросник по tracking-tools | Ручные | — | — | ⚠ проверить у заказчика конкретную IHK |
| Прочие DE | website-check.de (Website-Check GmbH, Saarbrücken; «Profi-Tool» для агентств и юристов, описание 2021), Hugo Check (hagel-it.de, «29 Punkte» на главной), Passiro (публичные автоотчёты по consent) | ⚠ не изучены | — | ✘ | Рынок агентских чек-листов есть, открытого CI-инструмента нет |

Регуляторный ориентир для CONSENT-04 — EDPB, «Report of the work undertaken by the Cookie Banner Taskforce», принят 17.01.2023. Большинство надзорных органов требуют отказ на первом уровне. Отдельные органы не считают отсутствие кнопки отказа нарушением (по вторичным источникам — испанский AEPD) ⚠. Для Германии это позиция DSK/BayLDA из пресс-релиза выше. Юридическую часть подтверждает заказчик.

---

## 6. Данные и правила: лицензии

| Набор | Для ID | Лицензия | Можно включить в Apache-2.0-репо? |
|---|---|---|---|
| autoconsent `rules/rules.json` + эвристики | CONSENT-03/04/05 | MPL-2.0 | **Да, как зависимость** (без правок; правки — под MPL, upstream) |
| Consent-O-Matic `rules/*.json` | CONSENT-04 (сверка) | MIT | Да, с атрибуцией |
| Open Cookie Database (`jkwakman/Open-Cookie-Database`) | CONSENT-02 (категория cookie по имени) | Apache-2.0 | Да |
| `third-party-web` (используется в Lighthouse) | TRACK-01, EMBED-* (сущность и категория домена) | MIT | Да |
| EasyPrivacy / EasyList | TRACK-01 (beacons) | двойная: GPL-3.0+ **или** CC BY-SA 3.0+ | ◐ Только отдельным файлом под своей лицензией (так делает WEC) или скачивать при запуске. ⚠ юр. проверка ShareAlike |
| Disconnect `services.json` | TRACK-01 | CC BY-NC-SA 4.0 | **Нет** (NC) |
| DuckDuckGo Tracker Radar | TRACK-01, «владелец домена» | CC BY-NC-SA 4.0 | **Нет** (NC) |
| Ghostery TrackerDB | TRACK-01 | CC BY-NC-SA 4.0 | **Нет** (NC) |
| `@ghostery/adblocker` (движок матчинга фильтр-листов, его использует WEC) | TRACK-01 | MPL-2.0 | Да, как зависимость |
| nuclei-templates `http/exposures/*` | FILE-01, ADMIN-01 | MIT | Да, выборочно, с атрибуцией |
| retire.js `jsrepository-v4.json` | VULN-02 (JS) | Apache-2.0 | Да |
| CISA KEV | Уровень VULN (critical) | CC0-1.0 | Да |
| OSV.dev | VULN-01/02 | код Apache-2.0; данные — по лицензиям источников ⚠ | ◐ скачивать, не бандлить |
| Wordfence Intelligence (API v3; v1/v2 отключены 09.03.2026) | VULN-01/02 (WP-плагины) | бесплатный API-ключ, атрибуция на запись ⚠ условия | ◐ скачивать по ключу пользователя ⚠ |
| WPScan Vulnerability DB API | VULN-01/02 | коммерческие условия ⚠ | **Нет** по умолчанию; опционально с токеном пользователя |
| Данные Wappalyzer-форков | VULN-01/02 (детект) | GPL-3.0 | **Нет** (свой каталог) |
| WEC `keywords.yml`, формат cookie-db | LEGAL-01, CONSENT-02 | EUPL-1.2 | Нет (только идея формата) |
| Internet.nl, тексты пояснений (`/translations`) | MAIL/DNS/TLS/HDR | CC BY 4.0 | Да, с атрибуцией (нужен DE-перевод) |
| axe-core | BFSG-01 (P2) | MPL-2.0 | Да, как зависимость |

Своё ядро данных, которого нет ни у кого: **немецкий каталог сервисов** (Trustindex, Elfsight, Borlabs, Usercentrics, Adobe Fonts, Google Maps-тайлы, `i.ytimg.com`, reCAPTCHA и т. п.). Для каждого сервиса: домены, категория, юрлицо-получатель, страна или статус EU-US DPF, алиасы для поиска в Datenschutzerklärung и crmCode. Каталог с версией и ссылками на источники — основа PRIV-01/02 и «передачи за пределы ЕС».

---

## 7. Что заимствуем

| У кого | Что берём | Форма | Для ID |
|---|---|---|---|
| ZAP baseline | Конфиг правил `checkId → fail/warn/ignore` и URL-исключения (`OUTOFSCOPE`-regex); режим «не падать на warning»; файл известных проблем (baseline/suppressions с причиной и сроком); отчёты HTML/JSON/MD | идея | гейтинг, все ID |
| WEC | Фазы collect → inspect → report и сохранение сырого `inspection.json` для перегенерации отчётов; классификация ошибок навигации (DNS/CONNECTION/TLS/TIMEOUT) → exit 2 или находка TLS-02; `failed_pages`/`skipped_links` как отчёт о покрытии; запрет префлайт-запросов к третьим сторонам при обходе; testssl как опция через `execFile`; формат cookie-db с glob-именами; дисклеймер «инструмент сам обрабатывает персональные данные» | идея | ядро, LEGAL-01, TLS-*, отчёт |
| autoconsent | Распознавание CMP, `detectPopup`, выполнение отказа, немецкие regex кнопок | зависимость | CONSENT-03/04/05 |
| Consent-O-Matic | Альтернативные селекторы для перекрёстной проверки наших 7 адаптеров | данные (MIT) | CONSENT-04 |
| Slashgear | Таксономия dark patterns (`buried-reject`, `click-asymmetry`, `pre-ticked`, `asymmetric-prominence`) как подтипы CONSENT-04 в evidence; декодирование IAB TCF как `info`; `--json-summary`; вывод о размере Docker-образа с chromium-headless-shell; шаблоны GitHub/GitLab с `if: always()` для артефактов | идея/код (MIT) | CONSENT-04/05, CI |
| Blacklight | Распознавание событий GA/FB Pixel по параметрам запроса (`en=page_view`, `ev=PageView`) и session recorders | идея | TRACK-01, CONSENT-05 |
| MDN Observatory | Семантика и пороги тестов заголовков (HSTS max-age, разбор CSP, флаги cookies), тексты рекомендаций | идея (MPL) | HDR-01/02, TLS-01 |
| Internet.nl | Семантика DMARC/SPF; эвристика DKIM через `_domainkey` (NOERROR против NXDOMAIN) с оговоркой о кривых DNS-серверах → в отчёте только «nicht gefunden für geprüfte Selektoren»/`info`; CAA; валидация security.txt | идея/тексты (Apache, CC BY) | MAIL-01/02/03, DNS-01, SEC-01 |
| nuclei-templates | Пары «путь + матчер + анти-soft-404» для `.git/config`, `.env`, дампов; `max-request: 1` | данные (MIT) | FILE-01, ADMIN-01 |
| retire.js | База JS-библиотек с диапазонами CVE | данные (Apache) | VULN-02 |
| Lighthouse | `third-party-web` для категорий доменов; логика mixed content; позже — плагины PERF-01/BFSG-01 | данные (MIT) / зависимость | TRACK-01, EMBED-*, TLS-03, P2 |
| eRecht24 FAQ | Список источников ложных срабатываний → негативные фикстуры | идея | EMBED-*, TRACK-01, PRIV-01 |
| BayLDA / EDPB Taskforce | Формулировка критерия «gleichwertige Ablehnen-Möglichkeit auf erster Ebene» | критерий | CONSENT-04 |
| webbkoll | Отказ от IP-геолокации → «за пределы ЕС» определяем по владельцу сервиса | идея | EMBED-*, PRIV-01 |

---

## 8. В чём наше отличие

| Аспект | Аналоги | dsgvo-check |
|---|---|---|
| Юрисдикция | WEC/WAT — общеевропейские и англоцентричные; Slashgear — Франция (CNIL); eRecht24 — DE, но закрытый | Немецкий фокус: DSGVO + §25 TDDDG + §5 DDG; немецкие CMP по частоте из 80 аудитов (Borlabs 12, Cookiebot 4, Complianz 4, CCM19 2…); немецкие тексты находок от заказчика |
| Политика vs реальность | Ни у кого (у eRecht24 заявлено расплывчато ⚠) | PRIV-01/02: наблюдаемые сервисы сверяются с текстом Datenschutzerklärung. Формулировка «nicht gefunden in der Datenschutzerklärung», без юридического вывода |
| Охват | Либо privacy (WEC, Slashgear, Blacklight), либо security (ZAP, Observatory, testssl, Internet.nl) | Privacy + consent + legal + headers/TLS + mail/DNS + VULN в одном прогоне и в одной JSON-схеме |
| Гейтинг | ZAP — по правилу; Slashgear — по общей оценке; остальные — без порога | `--fail-on critical\|warning` по стабильным ID; exit 0/1/2; конфиг исключений с причиной и сроком |
| Связь с бизнес-процессом | Нет | `crmCode` из каталога в каждой находке |
| Честность при неопределённости | Обычно бинарно: pass/fail | «Banner nicht erkannt» → `info`, а не ложный CONSENT-04; отчёт о покрытии (сколько страниц, какие фазы, какие селекторы DKIM проверены) |
| Пассивность | WPScan и Nuclei умеют агрессивные режимы | Только пассивные проверки; лимиты частоты; честный User-Agent со ссылкой на репозиторий; FILE-01 — короткий фиксированный список, секреты не сохраняются |
| Лицензия | Ближайшие по смыслу — EUPL/GPL | Apache-2.0: можно встраивать в агентские и коммерческие пайплайны |
| Consent Mode | Нет ни у кого из OSS | CONSENT-06: состояние `default`/`update` против момента запуска тегов |

---

## 9. Позиционирование

**dsgvo-check — открытый (Apache-2.0) пассивный CI-гейт для немецких сайтов. Одной командой фиксирует, что реально уходит до и после «Ablehnen», сверяет это с Datenschutzerklärung и Impressum, добавляет базовую гигиену безопасности (заголовки, TLS, DMARC/SPF, служебные файлы) и выдаёт стабильный JSON с crmCode — без юридических выводов.**

Короткий вариант для README: *«Was Ihre Website vor und nach ‚Ablehnen‘ wirklich tut — als CI-Check.»* (немецкий текст — на вычитку заказчику).

---

## 10. Рекомендации для этапа 0 (build vs reuse)

| Решение | Рекомендация | Уверенность |
|---|---|---|
| Браузерный слой | Своё ядро на Playwright, эталонный движок — Chromium. Почти все аналоги на Chromium: сопоставимость результатов, cookie-поведение без ITP WebKit | high |
| CMP | `@duckduckgo/autoconsent` как зависимость для detect/opt-out плюс свои 7 адаптеров «первого уровня» для CONSENT-04. Консервативный fallback: `info` «Banner nicht erkannt» | high |
| Каталог сервисов | Свой DE-каталог (§6) + `third-party-web` (MIT) + Open Cookie Database (Apache-2.0). NC-лицензированные листы не использовать. EasyPrivacy — только опционально, после юр. проверки | high / medium (EasyPrivacy) |
| Заголовки и TLS-01/02 | Своя реализация по семантике MDN Observatory и Internet.nl; Observatory как зависимость не тянуть (сервер и БД в зависимостях) | medium |
| TLS-04 | Опциональная интеграция testssl.sh отдельным процессом (как у WEC). Своя Node-проба TLS 1.0 требует снижения OpenSSL security level ⚠ проверить осуществимость | medium |
| MAIL/DNS | Своя реализация (DNS-резолвер с внедряемой заглушкой для фикстур); семантика Internet.nl | high |
| VULN | retire.js (JS) + свой узкий WP/TYPO3-детект + Wordfence Intelligence v3 / OSV / KEV. WPScan — только с токеном пользователя | medium (условия Wordfence ⚠) |
| FILE-01 | ≤ 10 путей из nuclei-templates с анти-soft-404-матчерами; тело и секреты не сохранять | high |
| Гейтинг и отчёт | Модель ZAP (правила по ID) + доказательная модель WEC (сырые данные → отчёт). В README объяснить, что exit 2 у нас ≠ exit 2 у ZAP | high |

---

## Источники

| URL | Что подтверждает |
|---|---|
| https://code.europa.eu/EDPS/website-evidence-collector | WEC: README (Puppeteer, `--testssl`, cookie-db, `--max/--depth`, Docker), лицензия EUPL кроме фильтр-листов, раздел Third-Party Software |
| https://code.europa.eu/EDPS/website-evidence-collector/-/blob/main/CHANGELOG.md | v4.6.0 от 2026-10-23; `failed_pages`, классификация `NavigationError`, запрет редиректов к третьим сторонам, `execFile` для testssl |
| https://code.europa.eu/EDPS/website-evidence-collector/-/blob/main/package.json | `"license": "EUPL-1.2"`, `puppeteer ^25`, `@ghostery/adblocker-puppeteer`, Node ≥ 22.17 |
| https://code.europa.eu/edpb/website-auditing-tool/-/releases | WAT: релизы 3.0.1 (2026-09-28), 3.0.0, 2.0.x; Electron/Angular, puppeteer-core, lighthouse (`package.json`) |
| https://www.edpb.europa.eu/node/7174_en | Запуск EDPB WAT 29.01.2024, EUPL-1.2 (через результаты поиска) |
| https://github.com/mdn/mdn-http-observatory | MPL-2.0, v1.7.2, CLI `npx @mdn/mdn-http-observatory`, список тестов в `src/analyzer/tests` |
| https://github.com/testssl/testssl.sh/releases/tag/v3.2.4 | `releases/latest` = v3.2.4; GPL-2.0 (GitHub API) |
| https://www.zaproxy.org/docs/docker/baseline-scan/ | Exit-коды 0/1/2/3, формат конфига WARN/FAIL/IGNORE/OUTOFSCOPE, `-I`, отчёты, брендинг «ZAP by Checkmarx» |
| https://github.com/zaproxy/zaproxy/releases | 2.17.0 (2025-12-15) — последняя стабильная; weekly w2026-10-29; Apache-2.0 |
| https://webbkoll.5july.net/de/news | История webbkoll: переход к 5th of July Foundation (2024-09-24), перенос на Codeberg, удаление геолокации (2021-11-11) |
| https://codeberg.org/dataskydd.net/webbkoll | Архив с 2025-04-25; бэкенд `webbkoll-backend` — Express + Puppeteer, тоже архив |
| https://github.com/PrivacyScore/PrivacyScore | Archived, GPL-3.0, последний push 2021-06-22 |
| https://github.com/the-markup/blacklight-collector | GPL-3.0, v3.11.0, список тестов (`fb_pixel_events`, `session_recorders` …), Puppeteer |
| https://github.com/openwpm/OpenWPM | GPL v3 (LICENSE), Firefox + Selenium, v0.38.0 |
| https://github.com/duckduckgo/autoconsent | MPL-2.0, v17.1.0, поддержка Playwright, 913 JSON-правил, файлы `borlabs.json`, `ccm19.json`, `real-cookie-banner.json`, `cookiehub.json`, `usercentrics-*.json`, `complianz-*.json`, `cookiebot.ts`; немецкие regex в `lib/heuristic-patterns.ts` |
| https://github.com/cavi-au/Consent-O-Matic | MIT, v1.1.5, `rules-list.json` (206 правил) |
| https://github.com/GoogleChrome/lighthouse | Apache-2.0, v13.6.0, аудиты `has-hsts`, `is-on-https`, `third-party-cookies`, `js-libraries`; зависимости `third-party-web`, `axe-core` |
| https://github.com/projectdiscovery/nuclei-templates | MIT, v10.5.1, `http/exposures/*`, `git-config.yaml` (матчеры, экстракторы) |
| https://github.com/projectdiscovery/nuclei | MIT, v3.11.1 |
| https://github.com/RetireJS/retire.js | Apache-2.0, 6.1.0, `repository/jsrepository-v4.json` |
| https://github.com/enthec/webappanalyzer | GPL-3.0; продолжение Wappalyzer, который «went private in August 2023» |
| https://github.com/HTTPArchive/wappalyzer | GPL-3.0, активный форк |
| https://github.com/projectdiscovery/wappalyzergo | MIT; данные из enthec и HTTPArchive |
| https://github.com/wpscanteam/wpscan | «WPScan Public Source License», v4.2.0 |
| https://wordpress.org/plugins/wpscan/ | Free-план API — 25 запросов в день (вторичный источник) |
| https://github.com/internetstandards/Internet.nl | Apache-2.0 (README), переводы CC BY 4.0, 1.11.6 |
| https://internet.nl/article/release-1.10/ | CAA-тест с релиза 1.10; библиотека `sectxt` для security.txt |
| https://batch.internet.nl/mail/internet.nl/13791292/ | Логика DKIM: «expect … NOERROR to our query for _domainkey» |
| https://github.com/Slashgear/gdpr-cookie-scanner | MIT, TS + Playwright, `--fail-on`, exit 0/1/2, таксономия dark patterns, TCF, шаблоны GitHub/GitLab |
| https://www.npmjs.com/package/@slashgear/gdpr-cookie-scanner | Версия 3.8.2 (registry: modified 2026-06-30) |
| https://github.com/dumkydewilde/consentcrawl | MIT, Python + Playwright, 25+ CMP, 7 блок-листов |
| https://github.com/mirkoschubert/gdpr-cli | MIT, статический скрейпинг, alpha |
| https://github.com/jkwakman/Open-Cookie-Database | Apache-2.0 |
| https://github.com/patrickhulce/third-party-web | MIT |
| https://easylist.to/pages/licence.html | EasyList/EasyPrivacy: GPL-3.0+ или CC BY-SA 3.0+ |
| https://github.com/duckduckgo/tracker-radar | CC BY-NC-SA 4.0 (LICENSE) |
| https://github.com/ghostery/trackerdb | CC BY-NC-SA 4.0 (LICENSE) |
| https://github.com/disconnectme/disconnect-tracking-protection | CC BY-NC-SA 4.0 (LICENSE) |
| https://github.com/ghostery/adblocker | MPL-2.0 |
| https://github.com/cisagov/kev-data | CC0-1.0 |
| https://github.com/google/osv.dev | Apache-2.0 (код) |
| https://github.com/nabla-c0d3/sslyze | AGPL-3.0 (LICENSE) — альтернатива testssl, нам не подходит |
| https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/ | API v3 с бесплатным ключом; v1/v2 отключены 09.03.2026 (через результаты поиска) |
| https://www.e-recht24.de/websitescanner | «scannt den Quellcode», бесплатен, FAQ о ложных срабатываниях |
| https://usercentrics.com/de/privacy-compliance-scanner/ | «Für immer kostenlos», результаты по e-mail, полный скан после регистрации |
| https://support.cookiebot.com/hc/en-us/articles/360006241733-Why-am-I-not-on-the-Free-subscription | Free Cookiebot: 1 домен, ≤ 50 подстраниц (через результаты поиска) |
| https://www.lda.bayern.de/media/pm/pm2024_02.pdf | BayLDA 09.02.2024: >350 сайтов, инструмент проверяет gleichwertige Ablehnen-Möglichkeit auf erster Ebene, начат с одной CMP |
| https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf | Отчёт Cookie Banner Taskforce, принят 17.01.2023 |
| https://noyb.eu/node/281 | noyb, 2021: >500 проектов жалоб, автоматизированный инструмент (через результаты поиска) |
| https://www.ihk.de/limburg/servicemarken/presse/pressemitteilungen/website-check-ueberprueft-homepages-4199746 | Региональный IHK «Website-Check» — консультация, не сканер |
| https://github.com/CreativeCodingSolutions/dsgvo-check | Коллизия имени: TS, без лицензии, push 2026-06-23 |
| https://registry.npmjs.org/dsgvo-check | `Not found` на 2026-10-30 → имя в npm свободно |

---

## Открытые вопросы

1. **Имя.** Оставляем `dsgvo-check`, несмотря на одноимённый репозиторий на GitHub? Публикуем в npm без scope или как `@<org>/dsgvo-check`?
2. **EasyPrivacy** (GPL-3.0 / CC BY-SA): допустимо ли поставлять его отдельным файлом или скачивать при запуске в Apache-2.0-проекте? Нужна юр. оценка заказчика, в том числе sui generis права на базы данных в ЕС.
3. **testssl.sh в Docker-образе** (GPL-2.0): включаем как опциональный компонент с соблюдением GPL или делаем TLS-04 своей пробой в Node с риском ограничений OpenSSL 3?
4. **Источник VULN для WordPress-плагинов:** Wordfence Intelligence v3 (бесплатно, атрибуция на запись) — устраивают ли условия для показа в отчёте? WPScan исключаем?
5. **Критерий CONSENT-04:** фиксируем формулировку BayLDA («gleichwertige Möglichkeit auf erster Ebene, das Banner ohne Einwilligung zu schließen»)? Как классифицировать «Verbergen», «X», ссылку вместо кнопки и визуальную асимметрию (подтипы как у Slashgear)? Нужен юридический ответ заказчика.
6. **Отношения с апстримом:** присылать ли исправления немецких CMP-правил в autoconsent (MPL) вместо локальных форков? Есть ли смысл связаться с автором Slashgear (MIT, близкий функционал)?
7. **Совместимость с WEC:** нужен ли экспорт, совместимый с `inspection.json`, чтобы отчёт было проще передать надзорному органу или юристу?
8. **Нужна ли сводная оценка** (grade/score, как у Slashgear и Observatory), или достаточно уровней по ID и `--fail-on` из ТЗ? Оценка удобна для продаж, но повышает риск «юридического вывода».
9. **«Передача за пределы ЕС»:** согласовать метод — по владельцу и статусу DPF из каталога, без IP-геолокации (с ней отказался работать даже webbkoll).
10. **2B Advice и «Datenschutz-Scanner от IHK/LfDI»:** какие конкретно продукты имел в виду заказчик? Публичных сканеров не нашли.
