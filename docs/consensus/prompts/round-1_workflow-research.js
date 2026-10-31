export const meta = {
  name: 'dsgvo-check-research',
  description: 'Round 1: parallel research (Claude Opus + Fable) for dsgvo-check brief, written to docs/01-research',
  phases: [
    { title: 'Research', detail: '7 researchers, mixed Opus/Fable, each writes one report' },
    { title: 'Critic', detail: 'completeness critic over all reports' },
  ],
}

const REPO = '/Users/user/Documents/germany/coding-memes'
const PRE = `Проект: open-source CLI-сканер \`dsgvo-check\` (TypeScript + Playwright, лицензия Apache-2.0), который ПАССИВНО проверяет немецкие сайты на нарушения DSGVO/TDDDG/DDG и базовые проблемы безопасности, выдаёт JSON/консоль/HTML(/PDF)-отчёт и роняет CI по порогу (exit 0/1/2). Сегодня 2026-10-30.

Репозиторий: ${REPO}. Обязательно прочитай целиком:
- specs/dsgvo-check_idea.md — идея заказчика
- specs/dsgvo-check_TZ.md — ТЗ (контракт)
- specs/dsgvo-check_katalog-proverok.md — каталог проверок P0/P1/P2 (ID, crmCode, частоты из 80 аудитов)

Мы на этапе анализа: КОД НЕ ПИШЕМ (короткие иллюстративные фрагменты конфигов/псевдокода допустимы, если без них непонятно). Ты — участник консенсус-панели из моделей Claude (Opus, Fable) и OpenAI Codex; твой отчёт потом будут критиковать другие модели, поэтому будь точен.

Инструменты: для веб-поиска загрузи WebSearch через ToolSearch ("select:WebSearch"); для чтения страниц используй WebFetch, если он у тебя есть, иначе Agent с subagent_type "web-fetch"; для документации библиотек — MCP context7 (resolve-library-id / query-docs, загрузи через ToolSearch). Проверяй факты по первоисточникам: актуальные версии, лицензии, номера дел и даты, статус законопроектов на октябрь 2026. Всё, что не удалось подтвердить, помечай «⚠ проверить» — не выдумывай номера дел, версии и лицензии.

Формат отчёта: Markdown на русском, немецкие юридические термины и названия — как есть. Начни с блока «Коротко» (5–10 пунктов с выводами), дальше разделы, в конце «Источники» (URL + что подтверждает) и «Открытые вопросы». Таблицы приветствуются. Пиши плотно, без воды.

Запиши отчёт инструментом Write в файл, указанный в задаче (папка уже может не существовать — Write её создаст). Не трогай другие файлы. Финальный ответ — через StructuredOutput.`

const RESULT = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'путь к записанному отчёту' },
    summary: { type: 'string', description: 'главные выводы, до 200 слов' },
    keyDecisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['topic', 'recommendation', 'confidence'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['file', 'summary', 'keyDecisions', 'openQuestions', 'unverified'],
}

const TASKS = [
  {
    key: 'legal-map', model: 'fable',
    file: 'docs/01-research/legal-basis-map.md',
    prompt: `Задача: правовая карта проверок (для ревью DSGVO-экспертом заказчика — ты готовишь черновик, а не юридическое заключение).
1. Для КАЖДОЙ проверки каталога (все ID P0/P1/P2) — таблица: нормы, на которые она опирается (DSGVO Art. 5, 6, 7, 13, 25, 32, 44 ff.; §25 TDDDG (бывш. TTDSG); §5 DDG (бывш. §5 TMG); §18 MStV; BFSG; при необходимости UWG), ключевые решения судов и позиции надзорных органов (EuGH Planet49 C-673/17, Fashion ID C-40/17, BGH Cookie-Einwilligung II I ZR 7/16, LG München I 3 O 17493/20 Google Fonts, решения о кнопке отказа на первом уровне баннера, EDPB Cookie Banner Taskforce Report 2023, EDPB Guidelines 2/2023 о техническом объёме Art. 5(3) ePrivacy, DSK Orientierungshilfe Telemedien — актуальная редакция), насколько позиция устоялась (устоявшаяся / спорная / одиночное решение).
2. Где проверка технически может показать только факт, а правовая оценка зависит от обстоятельств вне досягаемости сканера (legitimes Interesse, unbedingt erforderlich, Auftragsverarbeitung, локальный хостинг, DPF-сертификация получателя) — и какая формулировка находки безопасна. ТЗ требует стиль «nicht gefunden in der Datenschutzerklärung», а не «verstößt gegen DSGVO». Дай для каждой проверки 1–2 предложения-шаблона на немецком в нейтральном стиле (черновик для вычитки заказчиком) и список запрещённых формулировок.
3. Правовые рамки самого инструмента: Rechtsdienstleistungsgesetz (RDG) и автоматизированные оценки (BGH Smartlaw I ZR 113/20), требования к дисклеймеру, ответственность авторов open-source; где граница пассивного сканирования (§202a, §202c StGB при запросах к .git/.env/бэкапам; §303b), хранение данных чужих сайтов в отчётах, cookies-значения как возможные персональные данные.
4. «Передача данных за пределы ЕС»: что сканер может установить технически (GeoIP сервера, юрисдикция провайдера, DPF-листинг) и чего не может; как не превратить GeoIP в юридический вывод; статус EU-US Data Privacy Framework на октябрь 2026 (решение о достаточности 10.07.2023, дело Latombe в Генеральном суде ЕС и возможная апелляция).
Отчёт: ${'docs/01-research/legal-basis-map.md'}`,
  },
  {
    key: 'reg-landscape', model: null,
    file: 'docs/01-research/regulatory-landscape-2026.md',
    prompt: `Задача: актуальный регуляторный ландшафт на октябрь 2026, который влияет на дизайн и формулировки проверок. Исследуй и проверь по первоисточникам:
- TDDDG (переименование TTDSG в 2024), DDG (замена TMG с 14.05.2024), Einwilligungsverwaltungsverordnung (EinwV, PIMS) — вступила ли в силу, что значит для баннеров;
- EU Digital Omnibus (предложение Еврокомиссии ноября 2025): что предлагалось про cookies/Art. 5(3) ePrivacy, перенос в DSGVO, браузерные сигналы согласия; текущий статус в Совете и Парламенте на октябрь 2026; что из этого может изменить проверки CONSENT-* в горизонте 1–2 лет;
- позиции DSK, BfDI, LfDI (особенно по Google Fonts, Google Maps, YouTube-nocookie, reCAPTCHA, Consent Mode v2, server-side tagging, «Nur essenzielle»-кнопкам, Pay-or-Okay);
- свежая судебная практика 2023–2026 по баннерам и отказу на первом уровне, по Google Fonts/CDN, по Abmahnungen за DSGVO-нарушения (EuGH C-300/21 Österreichische Post о Schadensersatz, BGH к Art. 82, решения о злоупотреблении Abmahnungen за Google Fonts), по UWG-праву конкурентов требовать устранения DSGVO-нарушений (EuGH Lindenapotheke C-21/23);
- BFSG (с 28.06.2025) — кого касается, как связано с BFSG-01;
- NIS2-Umsetzung в Германии и «Stand der Technik» по Art. 32 DSGVO — есть ли нормативная опора для HDR/TLS/MAIL-проверок; BSI TR-03116-4, BSI-рекомендации по DMARC/SPF;
- EU Vulnerability Database ENISA (EUVD) и Cyber Resilience Act — релевантны ли для VULN-проверок.
Для каждого пункта: суть, дата, статус, ссылка, влияние на конкретные ID проверок (что поменять в детектировании, уровне или формулировке). Отдельный раздел «Что может устареть за год» — проверки, чья правовая база в движении, и как заложить это в архитектуру (версионирование правил, ссылка на правовую базу в данных проверки).
Отчёт: docs/01-research/regulatory-landscape-2026.md`,
  },
  {
    key: 'prior-art', model: null,
    file: 'docs/01-research/prior-art.md',
    prompt: `Задача: этап 0 из ТЗ — таблица аналогов. Исследуй (актуальное состояние на 2026: жив ли проект, лицензия, язык, движок браузера, последний релиз):
Website Evidence Collector (EDPS) и EDPB Website Auditing Tool; Mozilla HTTP Observatory (новая версия на MDN); testssl.sh; OWASP ZAP baseline scan (теперь ZAP by Checkmarx); webbkoll (dataskydd.net); PrivacyScore; Blacklight (The Markup); OpenWPM; DuckDuckGo autoconsent; Consent-O-Matic; Lighthouse; Nuclei (exposures-шаблоны); retire.js; Wappalyzer и его открытые форки; WPScan; коммерческие немецкие сканеры (eRecht24, Usercentrics/Cookiebot-сканеры, CookieYes, 2B Advice, Datenschutz-Scanner от IHK/LfDI, если есть), а также всё, что найдёшь сам (например, cookie-сканеры на Playwright на GitHub, «dsgvo scanner», «cookie consent checker»).
Таблица: инструмент → что умеет из нашего каталога (по ID) → чего нет → лицензия → можно ли переиспользовать код/данные в Apache-2.0-проекте → заметки. Отдельно: что мы можем у них позаимствовать (идеи, данные, правила), и в чём наше отличие (немецкий фокус, crmCode, CI-гейтинг, проверки «политика vs реальность»). Вывод: позиционирование dsgvo-check одной фразой.
Отчёт: docs/01-research/prior-art.md`,
  },
  {
    key: 'data-licenses', model: 'fable',
    file: 'docs/01-research/data-sources-and-licenses.md',
    prompt: `Задача: источники данных, которые понадобятся сканеру, и их лицензии — с проверкой совместимости с Apache-2.0 и с коммерческим использованием (заказчик — seed-factory.com, отчёты используются в платных аудитах; поле crmCode → CRM заказчика).
Категории:
1. Классификация сторонних доменов/сервисов (аналитика, реклама, шрифты, карты, видео, капчи, виджеты, CDN): DuckDuckGo Tracker Radar, Disconnect, EasyPrivacy/EasyList, Ghostery TrackerDB / WhoTracks.me, AdGuard, webXray, Open Cookie Database (jkwakman), Cookiepedia, и что ещё найдёшь. Лицензии (CC BY-NC-SA, CC BY-SA, GPL, MPL, Apache…), можно ли вендорить данные в репозиторий, можно ли тянуть при запуске, атрибуция.
2. Правила распознавания CMP: DuckDuckGo autoconsent (лицензия, формат правил, покрытие наших 7 CMP: Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub), Consent-O-Matic, IAB TCF CMP list.
3. Public Suffix List и библиотеки (tldts и др.).
4. GeoIP для «передачи за пределы ЕС»: MaxMind GeoLite2 (EULA, можно ли вшивать в Docker-образ), DB-IP Lite, IPinfo Lite, IP2Location LITE — лицензии и требования атрибуции; ASN → организация.
5. Уязвимости для VULN-01/02: OSV.dev, GitHub Advisory Database, NVD (+CPE), CISA KEV, ENISA EUVD, retire.js jsrepository, Wordfence Intelligence (API, условия бесплатного фида, нужен ли ключ), WPScan (ограничения бесплатного API и коммерции), Patchstack, TYPO3 Security Advisories, Drupal/Joomla. Для каждого: покрытие WordPress-плагинов/тем/ядра, JS-библиотек, TYPO3; формат; лицензия; офлайн-снапшот vs онлайн-запрос; признак «эксплуатация без входа / KEV» для уровня critical.
6. Фингерпринтинг версий: Wappalyzer-форки (webappanalyzer и др.), их лицензии.
Итог: таблица «источник → лицензия → вердикт (вендорить / тянуть при запуске / только идея / нельзя)», рекомендуемая комбинация для MVP, и что придётся вести самим (например, собственный каталог сервисов с алиасами для поиска в Datenschutzerklärung для PRIV-01).
Отчёт: docs/01-research/data-sources-and-licenses.md`,
  },
  {
    key: 'browser', model: null,
    file: 'docs/01-research/browser-automation.md',
    prompt: `Задача: технический ресёрч браузерной части (самая рискованная часть проекта). Используй context7 для актуальной документации Playwright и проверь текущую версию Playwright на октябрь 2026.
1. Захват сети в Playwright: context.on('request'/'response'/'requestfailed'), page.route, HAR, CDP-сессия; что НЕ ловится стандартными событиями (service workers, sendBeacon/keepalive, WebSocket, preconnect/dns-prefetch, запросы из iframe и workers, prefetch/prerender) и как закрыть пробелы; таймауты и стратегия «ожидания тишины» (networkidle — почему ненадёжен, что вместо).
2. Cookies и хранилища: context.cookies() vs CDP Network.getAllCookies, third-party и partitioned (CHIPS) cookies, Storage Access, localStorage/sessionStorage/IndexedDB — как снять снимок по фазам (до согласия / после отказа / после принятия). Отличие cookies, выставленных через Set-Cookie и через document.cookie.
3. Анти-бот и реализм: headless-режимы Chromium в актуальном Playwright (chromium vs chromium-headless-shell, «new headless»), признаки headless в UA и navigator.webdriver; какие CMP скрывают баннер ботам (Cookiebot известен этим — проверь) и по каким признакам; как совместить честный User-Agent со ссылкой на репозиторий (требование ТЗ) с тем, чтобы CMP вели себя как для человека (например, реальный Chrome UA + суффикс без слов bot/crawler — проверь, как это влияет); locale de-DE, timezone Europe/Berlin, Accept-Language.
4. Гео: CMP с гео-таргетингом (Cookiebot, Usercentrics и др.) не показывают баннер посетителям из США — а GitHub-hosted runners в США. Варианты: --proxy, self-hosted runner в ЕС, детект «нет баннера + признаки гео-CMP» → предупреждение вместо ложного CONSENT-03.
5. Распознавание и управление баннером для 7 CMP (Borlabs Cookie v2/v3, Cookiebot, Complianz, Usercentrics (shadow DOM), CCM19, Real Cookie Banner, CookieHub): контейнеры и селекторы, JS API (window.Cookiebot, UC_UI, BorlabsCookie, __tcfapi, __cmp), кнопки первого уровня, как надёжно кликнуть «Ablehnen»/«Nur essenzielle», как проверить, что клик сработал (изменение consent-cookie/API-состояния), iframes и shadow DOM. Обобщённая эвристика для неизвестных баннеров и порог уверенности (ТЗ: не распознал → info «Banner nicht erkannt», никакого ложного CONSENT-04). Можно ли использовать @duckduckgo/autoconsent как зависимость и чего в нём не хватает для проверки «равноценного отказа на первом уровне».
6. Google Consent Mode v2 (CONSENT-06): как определить default-состояние (dataLayer 'consent','default', параметры gcs/gcd в запросах GA4/Ads — расшифровка), server-side GTM на поддомене первой стороны (как распознать по путям /g/collect, gtm.js и т.п.).
7. Стратегия обхода сайта: сколько страниц, как выбирать (главная, Impressum, Datenschutz, Kontakt, ссылки из навигации/подвала, sitemap), контекст-на-фазу, rate limiting, robots.txt, бюджет времени для CI. Как проверять «Impressum и Datenschutz доступны с каждой страницы» (LEGAL-01) и ссылки на «#».
8. PDF/HTML-отчёт через Playwright (page.pdf) — ограничения.
9. Docker: официальные образы Playwright (mcr.microsoft.com/playwright), размер, только Chromium, sandbox в контейнере, запуск от не-root.
Отчёт: docs/01-research/browser-automation.md`,
  },
  {
    key: 'net-dns-tls', model: 'fable',
    file: 'docs/01-research/http-dns-tls-mail.md',
    prompt: `Задача: технический ресёрч не-браузерных проверок на Node.js/TypeScript (актуальная LTS Node на октябрь 2026 — проверь).
1. HTTP: редиректы http→https (TLS-01), HSTS (includeSubDomains, preload), набор заголовков HDR-01 (HSTS, CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors/X-Frame-Options) — какие правила оценки брать (MDN HTTP Observatory scoring, OWASP Secure Headers Project), разумные уровни (что critical, что warning, что info); HDR-02 (флаги cookies, X-Powered-By/Server с версиями).
2. TLS: валидность и цепочка сертификата, несовпадение имени (пример хостерского *.alfahosting-server.de), срок истечения; TLS-04 — можно ли в Node (OpenSSL 3, SECLEVEL) проверить, что сервер принимает TLS 1.0/1.1, или нужен внешний инструмент (testssl.sh, sslyze) — что именно работает и с какими ограничениями.
3. DNS: SPF (парсинг, ~all/?all/+all, лимит 10 DNS-lookups, include-рекурсия), DMARC (p=, sp=, pct=, rua; DMARCbis — статус), DKIM (список распространённых селекторов для немецкого рынка: Google, Microsoft 365, IONOS, Strato, All-Inkl, Mailchimp, Brevo, Hetzner… — сколько запросов допустимо), CAA, DNSSEC — как проверить из Node (нет AD-флага в node:dns → DoH, dns-packet, внешний валидирующий резолвер; приватность запросов к DoH-провайдеру), MX отсутствует → что делать с MAIL-*.
4. FILE-01 и ADMIN-01: какой минимальный фиксированный список путей проверять (.git/HEAD, .git/config, .env, бэкапы, .DS_Store, phpinfo, wp-config.php.bak…), как отличать реальное содержимое от soft-404 (сигнатуры, сравнение с ответом на заведомо несуществующий путь), как не скачивать секреты (Range, ограничение байтов, редактирование evidence), почему это не «перебор» по смыслу ТЗ. ADMIN-01: /wp-json/wp/v2/users, ?author=1, xmlrpc.php — пассивно ли это и как сформулировать.
5. VULN-01/02: детект CMS и версий — WordPress (meta generator, feed, readme.html, ?ver=, wp-emoji), плагины/темы (пути /wp-content/plugins/<slug>/, readme.txt Stable tag — сколько запросов это даёт), TYPO3, Joomla, Drupal, Next.js (заголовки, /_next/), jQuery и др. JS-библиотеки (retire.js-подход). Уверенность версии (exact / range / unknown) и как она влияет на уровень находки.
6. SEC-01 security.txt (RFC 9116: Expires, Contact, расположение), LEGAL-02 (TMG/RStV vs DDG/MStV в тексте Impressum — регулярки).
7. Вежливость: лимит частоты, конкуррентность, таймауты, ретраи, честный User-Agent; общий HTTP-клиент для всех модулей (undici).
Для каждого пункта — рекомендуемые npm-библиотеки (с лицензиями и живостью) или «пишем сами».
Отчёт: docs/01-research/http-dns-tls-mail.md`,
  },
  {
    key: 'engineering', model: null,
    file: 'docs/01-research/engineering-ci-distribution.md',
    prompt: `Задача: инженерный ресёрч — тулчейн, тесты, CI, дистрибуция, безопасность самого сканера. Проверь актуальные версии на октябрь 2026 (Node LTS, TypeScript, Playwright, pnpm, Vitest, ESLint/Biome, tsup/tsdown/unbuild).
1. Структура репозитория: один пакет vs монорепо (core / checks / cli / action), где лежат данные (каталог сервисов, CMP-правила, тексты находок de/en), как добавляется проверка «без правок ядра» (реестр с автообнаружением vs явный импорт vs внешние плагины-пакеты).
2. Тесты: юнит-тесты проверок на записанных артефактах (без браузера) + интеграционные с Playwright. Фикстуры для каждой проверки (нарушение + чисто) без интернета: подмена сторонних доменов (--host-resolver-rules, route), локальный HTTPS с просроченным/чужим сертификатом, фейковый DNS (dns2 или подменяемый резолвер), имитация CMP. Канареечный ночной прогон по 10 реальным сайтам заказчика (не гейтит PR). Snapshot/golden-тесты JSON-отчёта, контрактные тесты схемы (Ajv). Как избежать флейков.
3. JSON-схема: zod/TypeBox/valibot → JSON Schema, версионирование schemaVersion (semver), стабильные ID, fingerprint находки для baseline/suppress-файла, SARIF для GitHub Code Scanning и JUnit/Code Quality для GitLab — нужны ли в MVP.
4. CI-интеграция: GitHub Action — docker-action vs composite (npx) vs JS-action; плюсы/минусы при тяжёлом Playwright; GitLab — шаблон через include vs CI/CD Catalog component (актуальный механизм); Docker-образ (база mcr.microsoft.com/playwright vs node-slim + chromium-headless-shell, размер, multi-arch, GHCR); npm-пакет и установка браузера (postinstall vs отдельная команда). Пример репозитория, где Action роняет сборку (этап 2).
5. Релизы и цепочка поставок: release-please vs changesets, npm provenance, подпись образа (cosign), SBOM, Dependabot/Renovate, OpenSSF Scorecard.
6. Безопасность сканера: он открывает недоверенные сайты в Chromium в CI, где есть секреты — изоляция (контейнер, отдельный пользователь, no-sandbox риски), запрет скачиваний, лимиты ресурсов; HTML-отчёт содержит данные с чужих сайтов → экранирование, CSP отчёта, никаких внешних ресурсов (ирония: отчёт не должен грузить Google Fonts); редактирование значений cookies в отчёте.
7. Локализация: тексты находок на немецком от заказчика (ключи в каталоге сообщений), английский для разработчиков; формат хранения (JSON/YAML/ICU MessageFormat).
Отчёт: docs/01-research/engineering-ci-distribution.md`,
  },
]

phase('Research')
const results = await parallel(TASKS.map(t => () =>
  agent(`${PRE}\n\n${t.prompt}\n\nФайл для отчёта: ${REPO}/${t.file}`, {
    label: `research:${t.key}${t.model ? ' (fable)' : ' (opus)'}`,
    phase: 'Research',
    schema: RESULT,
    ...(t.model ? { model: t.model } : {}),
  }).then(r => r && { key: t.key, model: t.model || 'opus', ...r })
))
const ok = results.filter(Boolean)
const missing = TASKS.filter(t => !ok.find(r => r.key === t.key)).map(t => t.key)
if (missing.length) log(`Missing reports: ${missing.join(', ')}`)

phase('Critic')
const critic = await agent(`${PRE}

Ты — критик полноты. В ${REPO}/docs/01-research/ лежат отчёты исследователей: ${ok.map(r => r.file).join(', ')}. Прочитай их все и каталог проверок.
Найди:
1. Проверки из каталога (каждый ID P0/P1/P2), которые ни один отчёт не покрыл технически или правово.
2. Прямые противоречия между отчётами (версии, лицензии, юридические позиции, рекомендации) — с цитатой и файлом.
3. Утверждения, которые выглядят непроверенными или сомнительными (номера дел, лицензии, версии, «известные факты» без источника) — перепроверь самые важные через веб-поиск и скажи, кто прав.
4. Чего не хватает для брифа и плана (темы, которые никто не поднял).
Ничего не записывай в файлы. Ответ через StructuredOutput.`, {
  label: 'critic:completeness (fable)',
  phase: 'Critic',
  model: 'fable',
  schema: {
    type: 'object',
    properties: {
      uncoveredChecks: { type: 'array', items: { type: 'string' } },
      contradictions: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, details: { type: 'string' }, resolution: { type: 'string' } }, required: ['topic', 'details', 'resolution'] } },
      doubtfulClaims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, file: { type: 'string' }, verdict: { type: 'string' } }, required: ['claim', 'file', 'verdict'] } },
      gaps: { type: 'array', items: { type: 'string' } },
    },
    required: ['uncoveredChecks', 'contradictions', 'doubtfulClaims', 'gaps'],
  },
})

return { reports: ok, missing, critic }
