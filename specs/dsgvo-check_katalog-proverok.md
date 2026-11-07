# dsgvo-check — из последних 80 аудитов

Примеры — реальные находки из аудитов

**P0** — без этого релиза нет · **P1** — в MVP, если успеваем · **P2** — после релиза

---

## P0

| ID | Что ловим | Модуль | Частота | Пример из аудитов | crmCode |
|---|---|---|---|---|---|
| PRIV-01 | Сервис работает на сайте, но не упомянут в Datenschutzerklärung | browser + http | 48 | Отзывы Trustindex грузятся на главной, в политике о них ни слова | T3_LEGAL_DOCS_MISMATCH |
| PRIV-02 | Политика утверждает обратное тому, что происходит | browser + http | редко | «Google Fonts lokal installiert» — а каждая страница тянет `fonts.googleapis.com`, даже после «Nur essenzielle» | T1_MISLEADING_CLAIM |
| CONSENT-01 | Сторонние запросы до любого клика по баннеру | browser | 39–44 | GTM, GA и Google Ads ставят `_ga`, пока баннер ещё висит | T1_TRACKER_BEFORE_CONSENT |
| CONSENT-02 | Не-необходимые cookies до согласия | browser | вместе с CONSENT-01 | Трекинг-cookie `wpvp1` и запрос на AWS в США при первом заходе | T1_TRACKER_BEFORE_CONSENT |
| CONSENT-03 | Сторонние сервисы есть, баннера нет | browser | 7 | Maps и Fonts грузятся, согласие никто не спрашивает | T1_CONSENT_BANNER_BROKEN |
| CONSENT-04 | Нет равноценного отказа на первом уровне | browser | 10 | Только «Zustimmen» и «Cookie-Einstellungen»; в другом случае вместо отказа — «Verbergen» | T1_CONSENT_BANNER_BROKEN |
| TRACK-01 | Аналитика и рекламные пиксели | browser | 35 | GA4 22 · GTM 15 · Meta Pixel 13 · Google Ads 10 · Hotjar 4 | T1_TRACKER_BEFORE_CONSENT |
| EMBED-01 | Шрифты с внешних серверов | browser | 27 | `fonts.gstatic.com`; трижды — Adobe Fonts с `use.typekit.net` | T1_FONTS_EXTERNAL |
| EMBED-02 | Карты до согласия | browser | 26 | Google Maps на странице «Kontakt», включая статичные тайлы | T1_MAPS_BEFORE_CONSENT |
| MAIL-01 | DMARC нет или `p=none` | dns | 54 | Нет записи — 28, `p=none` — 26 | T3_MAIL_UNPROTECTED |
| MAIL-02 | SPF нет или мягкий | dns | 40 | `~all` — 32, записи нет — 8 | T3_MAIL_UNPROTECTED |
| HDR-01 | Нет заголовков безопасности | http | 64 | Обычно нет всего набора сразу: HSTS, CSP, nosniff, Referrer-Policy, Permissions-Policy, frame-ancestors | T3_NO_SECURITY_HEADERS |
| TLS-01 | http не уводит на https | http | 15 | `http://` отдаёт 200, HSTS нет, «Startseite» в меню ведёт на http-поддомен | T1_UNENCRYPTED |
| TLS-02 | Сертификат чужой, невалиден или истекает | http | вместе с TLS-01 | На https сертификат хостера `*.alfahosting-server.de`, браузер блокирует сайт | T1_UNENCRYPTED |
| LEGAL-01 | Нет Impressum или Datenschutzerklärung | browser | 19 | Ссылки в подвале ведут на `#` | T1_OTHER |

**Баннеры для CONSENT-04, в порядке реализации:**

| Порядок | CMP | Встречался в находках |
|---|---|---|
| 1 | Borlabs | 12 |
| 2 | Cookiebot | 4 |
| 3 | Complianz | 4 |
| 4 | Usercentrics | 1 |
| 5 | CCM19 | 2 |
| 6 | Real Cookie Banner | 1 |
| 7 | CookieHub | 1 |

---

## P1

| ID | Что ловим | Модуль | Частота | Пример из аудитов | crmCode |
|---|---|---|---|---|---|
| EMBED-03 | Видео до согласия | browser | 12 | Превью YouTube грузится с `i.ytimg.com` на странице истории компании | T1_MAPS_BEFORE_CONSENT |
| EMBED-04 | reCAPTCHA до согласия | browser | 11 | Капча Google на каждой странице, а не только у формы | T1_OTHER |
| EMBED-05 | Виджеты до согласия | browser | 4–10 | Elfsight `platform.js` на главной; лента Instagram | T1_OTHER |
| CONSENT-05 | Запросы не прекращаются после отказа | browser | 3 | GA4 и Ads шлют `page_view` и после «Nur technisch notwendige» | T1_CONSENT_BANNER_BROKEN |
| CONSENT-06 | Consent Mode по умолчанию `granted` | browser | 5 | CMP сообщает `analytics=false`, а Google получает `granted` | T1_TRACKER_BEFORE_CONSENT |
| VULN-01 | Устаревшее ядро CMS с CVE | http + browser | 15 | Версия WordPress видна в исходнике главной | T1_EXPLOITABLE_CVE / T3_OUTDATED_CVE |
| VULN-02 | Устаревшие плагины, темы, библиотеки с CVE | http + browser | 34 | jQuery 3.4.1 (CVE в CISA KEV); Next.js 15.2.8 с обходом авторизации middleware | T1_EXPLOITABLE_CVE / T3_OUTDATED_CVE |
| MAIL-03 | DKIM не найден | dns | 14 | Ни на одном из распространённых селекторов | T3_MAIL_UNPROTECTED |
| TLS-03 | Смешанный контент | browser | 18 | Картинки и скрипты по `http://` на https-странице | T3_OTHER |
| TLS-04 | Старые версии TLS | http | 7 | Сервер всё ещё принимает TLS 1.0 | T3_NO_SECURITY_HEADERS |

**Что чаще всего устаревает (VULN-02):**

| Компонент | Находок |
|---|---|
| Elementor | 9 |
| jQuery | 6 |
| Contact Form 7 | 5 |
| Borlabs | 5 |
| Divi | 4 |
| Slider Revolution | 4 |
| TYPO3 | 4 |
| WPBakery | 2 |

**Уровень для VULN:**

| Уровень | Когда |
|---|---|
| critical | Эксплуатация без входа: RCE, загрузка файлов, SQL-инъекция, обход авторизации — или запись в CISA KEV |
| warning | Всё остальное: нужна учётная запись, только чтение, XSS для авторов |

---

## P2

| ID | Что ловим | Модуль | Частота | Пример из аудитов |
|---|---|---|---|---|
| DNS-01 | Нет CAA и DNSSEC | dns | 54 | — |
| HDR-02 | Cookies без Secure / HttpOnly / SameSite, версии в заголовках | http | 22 | `X-Powered-By: PHP/7.4` |
| ADMIN-01 | Логины WP публичны и вход без защиты | http | редко | `/wp-json/wp/v2/users` + открытый `xmlrpc.php` |
| FILE-01 | Открытые служебные файлы | http | 0 | `.git/`, `.env`, бэкапы — не нашли ни разу, но если найдём, это T0 |
| SEC-01 | Нет `security.txt` | http | почти везде | только info |
| LEGAL-02 | В Impressum ссылки на старые законы | http | редко | TMG и RStV вместо DDG и MStV |
| BFSG-01 | Базовая доступность (axe-core) | browser | 42 | отдельный плагин |
| PERF-01 | Скорость, Core Web Vitals (Lighthouse) | browser | 64 | видео на главной весом 34,5 МБ |

---

