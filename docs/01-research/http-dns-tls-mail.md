# Ресёрч: не-браузерные проверки на Node.js/TypeScript (HTTP · TLS · DNS/Mail · файлы · версии · вежливость)


**Проект:** `dsgvo-check` (TypeScript + Playwright, Apache-2.0) · **Дата:** 2026-10-30 · **Статус:** исследовательский черновик. Фрагменты ниже — иллюстрации.

Охват: модули `http`, `dns`, частично `http + browser` из каталога: TLS-01/02/04, HDR-01/02, MAIL-01/02/03, DNS-01, FILE-01, ADMIN-01, VULN-01/02, SEC-01, LEGAL-02. Всё, что не удалось подтвердить первоисточником, помечено **⚠ проверить**. Факты про Node/TLS дополнительно проверены локальным экспериментом (Node 24.21.0, см. §2.2).

---

## Коротко

1. **Платформа:** на 30.10.2026 по официальному `schedule.json` Node 26 — Active LTS (с 28.10.2026), Node 24 — Maintenance (с 20.10.2026, до 30.04.2028), Node 22 — Maintenance до 30.04.2027. Рекомендация: `engines.node >= 24`, CI-матрица 24 + 26. Нужное API (глобальный `fetch`/undici, `crypto.X509Certificate`, `dns.resolveCaa`, OpenSSL 3.5) есть в обоих.
2. **HTTP-клиент:** один общий клиент на `undici` (MIT, 8.12.3 от 19.10.2026) с `Agent().compose(retry, redirect, dns)`, per-host лимитом (`p-limit`/`p-queue`), таймаутами `connect 5 s / headers 10 s / body 15 s`, лимитом тела, честным UA и журналом запросов → из него же берётся evidence. `got/ky/axios` не нужны.
3. **HDR-01:** брать шкалу **MDN HTTP Observatory** (модификаторы из `charts.js`: CSP −25, HSTS −20, X-Frame-Options −20, X-Content-Type-Options −5, Referrer-Policy 0 за отсутствие/−5 за unsafe) как основу для порядка важности, а **OWASP Secure Headers Project** (`headers_add.json`, обновлён 18.10.2026, Apache-2.0) — как источник рекомендуемых значений в тексте находки. Permissions-Policy Observatory не оценивает → только `info`. Для DSGVO Referrer-Policy важнее, чем для безопасности: `unsafe-url`/`no-referrer-when-downgrade` утекают полный URL третьим сторонам → `warning`, отсутствие → `info` (браузеры по умолчанию `strict-origin-when-cross-origin`).
4. **TLS-02 в Node без библиотек:** `tls.connect({rejectUnauthorized:false})` + `authorizationError` (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`) + `crypto.X509Certificate` (`checkHost`, `validToDate`, `checkIssued`). Подводный камень (проверено экспериментом): при ошибке цепочки Node **не** проверяет имя — несовпадение имени надо проверять самим через `X509Certificate.checkHost()`. Node не делает AIA-fetching → «неполная цепочка» у Node = ошибка, а Chrome страницу покажет → уровень `warning`, не `critical`.
5. **TLS-04 (TLS 1.0/1.1):** в Node это работает — `ciphers: 'DEFAULT@SECLEVEL=0', minVersion/maxVersion: 'TLSv1'|'TLSv1.1'`. Подтверждено экспериментом: сервер принял → `getProtocol()==='TLSv1'`; сервер отверг → `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`; забыли SECLEVEL → `ERR_SSL_NO_PROTOCOLS_AVAILABLE` (ошибка клиента, не сервера). OpenSSL 3.5 по умолчанию SECLEVEL=2, уровень 1 уже отключает TLS 1.0/1.1 — поэтому без `@SECLEVEL=0` никак. Ограничения: нет RC4 (legacy provider), только один IP, нет оценки шифров. Альтернатива «пишем сами» — сырой ClientHello через `net.Socket` (~150 строк, не зависит от сборки OpenSSL). testssl.sh (GPL-2.0) и sslyze (AGPL-3.0) — только как опциональные внешние процессы, не в MVP.
6. **DMARC: стандарт сменился.** RFC 7489 устарел: **RFC 9989** (май 2026, Proposed Standard) + RFC 9990/9991; добавлены теги `np`, `psd`, `t`, удалены `pct`, `rf`, `ri`; Organizational Domain определяется **DNS Tree Walk** (≤ 8 запросов), а не Public Suffix List. Сканер должен парсить и новые, и старые теги; `pct<100` → `info` «historic».
7. **DKIM-селекторы:** перебор ограничен ~40 TXT-запросами (generic + провайдерские, упорядочены по MX). Подтверждены из документации/практики: `google`, `selector1/2`, `s1-ionos/s2-ionos`, `k1–k3`, `mte1/2`, `brevo1/2`+`mail`, `hs1/2`, `s1/s2`, `pdk1/2`; Strato `strato-dkim-0002/0003` и mailbox.org `MBO0001–4` — только из форумов **⚠**. All-Inkl, Hetzner, CleverReach, rapidmail, Mailjet — **не подтверждены**, собрать из `DKIM-Signature` писем 10 реальных сайтов заказчика. SES/Postmark — случайные селекторы → MAIL-03 без MX-подсказки всегда `info` с текстом «unter N gängigen Selektoren nicht gefunden», никогда «DKIM fehlt».
8. **DNSSEC из Node:** `node:dns` (c-ares) не отдаёт AD-флаг и не умеет типы DS/DNSKEY (issue nodejs/node#14475 открыт с 2017). Решение: `dns-packet` (MIT) + сырой UDP/TCP к системному резолверу с DO-битом (читаем AD) **и/или** DoH wire-format (RFC 8484) через undici к валидирующему резолверу (Quad9 — швейцарский фонд, валидирует; с 15.12.2025 только HTTP/2 **⚠** → `allowH2`). DoH — opt-in (`--doh <url>`), т.к. домен уходит третьей стороне. Минимум для DNS-01: наличие DS у родителя.
9. **FILE-01 — фиксированный список ≈ 30 путей, не перебор:** `.git/HEAD|config`, `.env`, `wp-config.php.bak|.old|.save|~`, `.htpasswd`, дампы/архивы (`backup.zip|.sql|.tar.gz`, `db.sql`, `<host>.zip`), `phpinfo.php|info.php`, `wp-content/debug.log`, `error_log`, `server-status`, `.DS_Store`, `composer.lock`, `docker-compose.yml`. Находка засчитывается только при совпадении **сигнатуры/магических байт** и отличии от soft-404-базлайна (3 запроса к заведомо несуществующим путям). Читаем ≤ 4 KiB (`Range: bytes=0-4095` + `destroy()`), секреты редактируются до записи evidence, тело не сохраняется. Юридически: обычные GET к публичным URL без обхода защиты — но дело «Modern Solution» (штраф 3 000 €, LG Aachen 04.11.2024, OLG Köln 07/2025, BVerfG не принял жалобу **⚠ даты**) показывает, что читать содержимое секретов нельзя даже «случайно» → поэтому усечение+редактирование обязательны, плюс флаг `--no-files`.
10. **VULN:** определять версию с уверенностью `exact | range | unknown` и понижать уровень на ступень при `range`, при `unknown` — только `info` без упоминания CVE. WordPress: `readme.txt` → `Stable tag` (1 запрос на плагин, cap 20), темы — `style.css` → `Version:`; Elementor — `<meta name="generator" content="Elementor x.y.z">`. jQuery: подход retire.js (`jsrepository-*.json`, Apache-2.0) по телам скриптов, которые Playwright уже скачал — 0 лишних запросов. CISA KEV: CVE-2020-11023 (jQuery < 3.5.0) внесён 23.01.2025 → `critical` по правилу каталога. Wappalyzer-форк `enthec/webappanalyzer` — **GPL-3.0**, в Apache-2.0-проект не тянуть; свой минимальный набор отпечатков.
11. **LEGAL-02:** регулярки на `§ 5 TMG`/`Telemediengesetz` (→ § 5 DDG с 14.05.2024), `§ 55 … RStV`/`Rundfunkstaatsvertrag` (→ § 18 Abs. 2 MStV с 07.11.2020), `TTDSG` (→ TDDDG с 14.05.2024), `ec.europa.eu/consumers/odr`/«OS-Plattform» (платформа закрыта 20.07.2025, Verordnung (EU) 2024/3228), `Privacy Shield` (недействителен с 16.07.2020). Все — `info`.
12. **SEC-01 по RFC 9116:** `/.well-known/security.txt` (fallback `/security.txt`), HTTPS, `text/plain`, обязательны `Contact` (≥1) и `Expires` (ровно 1, рекомендовано < 1 года). Отсутствие/просрочка → `info`. Парсер — свой, ~60 строк.

---

## 0. Платформа: Node.js на октябрь 2026

| Версия | Статус 30.10.2026 | Источник | Для нас |
|---|---|---|---|
| v22 «Jod» | Maintenance (до 30.04.2027) | nodejs/Release `schedule.json` | Не поддерживать — нет смысла тянуть |
| v24 «Krypton» | Maintenance с 20.10.2026, EOL 30.04.2028 | там же | Минимальная (`engines >= 24`) |
| v26 | **Active LTS** с 28.10.2026, EOL 30.04.2029 | там же | Основная в CI |
| v27 | alpha с 28.10.2026, релиз 22.04.2027 | там же | Новая модель: один мажор в год, каждый — LTS |

- OpenSSL: официальные сборки Node 24.21.0 / 26.8.2 — OpenSSL **3.5.8** (⚠ вторичный источник, linuxcompatible.org). Локально у нас Node 24.21.0 с OpenSSL 3.6.4 (Homebrew, shared OpenSSL) — поведение SECLEVEL одинаковое (см. §2.2).
- Node-доки `tls`: «The default security level is 2»; `tls.DEFAULT_MIN_VERSION = 'TLSv1.2'`, `DEFAULT_MAX_VERSION = 'TLSv1.3'`; флаги `--tls-min-v1.0/1.1` только меняют дефолт, не отменяют SECLEVEL.
- Playwright: 1.64.x (октябрь 2026), требует Node ≥ 20 (⚠ вторичный источник); поддержка Node 26 **⚠ проверить** `engines` в npm перед фиксацией матрицы.
- Важно для архитектуры: глобальный `fetch` в Node использует **встроенную** копию undici; наш `Agent` из пакета `undici` к нему не подцепится. Поэтому во всех модулях импортируем `fetch`/`request` из пакета `undici`, а не глобальный.

---

## 1. HTTP: TLS-01, HSTS, HDR-01, HDR-02

### 1.1 TLS-01 — редирект http→https

Алгоритм (без авто-редиректов, `maxRedirections: 0`, ручная цепочка ≤ 5 хопов, записываем каждый хоп как evidence):

1. `GET http://<host>/` → ожидаем `301/308` (допустимо 302/307) с `Location: https://<тот же host>/…`.
2. То же для `http://<apex>/` и `http://www.<apex>/`, если отличаются от сканируемого хоста (каталог: «Startseite в меню ведёт на http-поддомен» — это ловит браузерный модуль TLS-03, но apex/www проверяем здесь).
3. Финальный ответ должен быть `https` и `2xx`; на нём же проверяем HSTS (§1.2). HSTS в ответе по `http://` игнорируется браузерами (RFC 6797 §8.1) — засчитывать нельзя.
4. Порт 443 недоступен / рукопожатие не прошло → фиксируем отдельно (это TLS-02), TLS-01 тогда `critical`.

Шкала Observatory (`redirection-*`): `missing` −20, `not-to-https` −20, `invalid-cert` −20, `not-to-https-on-initial-redirection` −10, `off-host-from-http` −5 (ломает требования HSTS preload — первый хоп должен быть на тот же хост).

| Состояние | Уровень | Обоснование |
|---|---|---|
| `http://` отдаёт 2xx, `https://` недоступен или сертификат невалиден (TLS-02) | **critical** | Сайт фактически без шифрования (T1_UNENCRYPTED) |
| `http://` отдаёт 2xx, `https://` работает, но редиректа нет | **warning** | Пользователь по http-ссылке остаётся на http; эскалация до `critical` допустима, если браузерный модуль видит форму на http-странице (Art. 32 DSGVO) — решение заказчика |
| Редирект есть, но первый хоп не на https или на другой хост | info | Нарушает условия preload, безопасности почти не вредит |
| Редирект через `<meta refresh>`/JS (по данным браузерного модуля) | warning | Для HTTP-клиента = «нет редиректа» |

### 1.2 HSTS

Парсим `Strict-Transport-Security` (RFC 6797): `max-age=<s>`, `includeSubDomains`, `preload`. Два заголовка или мусор → `invalid` (Observatory −20).

| Проверка | Порог | Уровень |
|---|---|---|
| Заголовка нет на https-ответе | — | **warning** (Observatory −20) |
| `max-age` < 15 552 000 (6 мес.) | Observatory −10 | info |
| `max-age` ≥ 31 536 000 + `includeSubDomains` + `preload` | требования hstspreload.org (плюс: валидный сертификат, редирект с http на тот же хост, HSTS на самих редиректах, все поддомены по https) | info «preload-ready» (положительное наблюдение) |
| `includeSubDomains` отсутствует | — | info |

Членство в Chromium preload list не проверяем по умолчанию (внешний запрос к hstspreload.org); можно опцией.

### 1.3 HDR-01 — набор заголовков

Оценивать на финальном https-ответе главной **и** страниц Impressum/Datenschutz (их всё равно скачивает LEGAL-модуль): заголовки часто различаются по маршрутам. Редирект-ответы оцениваем только на HSTS.

| Заголовок | Observatory (модификатор) | OWASP `headers_add.json` (18.10.2026) | Наш уровень при отсутствии | Примечания |
|---|---|---|---|---|
| Strict-Transport-Security | −20 / −10 / invalid −20 | `max-age=63072000; includeSubDomains` | **warning** | см. §1.2 |
| Content-Security-Policy | не реализован −25; `unsafe-inline` в script −20; `unsafe-eval` −10; только report-only −25 | `default-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests` | **info** при отсутствии; `info` при `unsafe-inline`/`unsafe-eval` | Для WordPress/TYPO3-сайтов строгий CSP нереалистичен; Observatory считает самым тяжёлым, но для DSGVO-тулзы это T3. Уровень требует отдельного решения |
| X-Frame-Options / CSP `frame-ancestors` | нет −20; через CSP +5 | `X-Frame-Options: deny` | **warning** | Засчитывать любой из двух; `ALLOW-FROM` устарел → info |
| X-Content-Type-Options | нет −5 | `nosniff` | info | дёшево исправить |
| Referrer-Policy | нет 0; `unsafe-url`/`no-referrer-when-downgrade`/`origin-when-cross-origin` −5; `no-referrer`/`same-origin`/`strict-origin*` +5 | `no-referrer` | нет → **info**; небезопасное значение → **warning** | Дефолт браузеров `strict-origin-when-cross-origin`; `unsafe-url` = утечка полного URL третьим сторонам — DSGVO-релевантно |
| Permissions-Policy | не оценивается | длинный список `camera=(), geolocation=(), …` | info | Только наличие + валидный синтаксис |
| Cross-Origin-Opener/Embedder/Resource-Policy | CORP +10 / −5 invalid | `same-origin`/`require-corp` | не включать в HDR-01 (шум) | Можно `info` в P2 |
| X-XSS-Protection | тест удалён из Observatory v2 ⚠ | не рекомендуется | если есть → info «veraltet» | |

Агрегация: HDR-01 — одна находка «fehlende Sicherheits-Header» со списком, уровень = max по элементам. Параллельно можно считать Observatory-подобный балл (100 − штрафы) и класть в evidence как `score` — это даёт заказчику понятную шкалу A–F.

### 1.4 HDR-02 — флаги cookies и версии в заголовках

Источник cookies для HDR-02 — `Set-Cookie` первых ответов HTTP-модуля (главная + 2 правовые страницы); у undici `request()` заголовок приходит массивом, у `fetch` — `headers.getSetCookie()`. Согласие/необходимость cookies здесь **не** оцениваем (это CONSENT-02 браузерного модуля) — только атрибуты.

Observatory (`cookies-*`): сессионная без `Secure` −40, сессионная без `HttpOnly` −30, любая без `Secure` −20, неверный `SameSite` −20, anti-CSRF без `SameSite` −20, без `Secure` но под HSTS −5/−10.

Эвристика «сессионная»: имя из списка (`PHPSESSID`, `JSESSIONID`, `ASP.NET_SessionId`, `wordpress_logged_in_*`, `wordpress_sec_*`, `fe_typo_user` (TYPO3), `SESS*`/`SSESS*` (Drupal), `laravel_session`, `connect.sid`, `session`, `sid`) или имя содержит `sess`/`login` (эвристика Observatory ⚠ проверить точную формулировку).

| Состояние | Уровень |
|---|---|
| Сессионная cookie без `Secure` или без `HttpOnly` | **warning** |
| Любая cookie без `Secure` на https-сайте | info |
| `SameSite=None` без `Secure` (браузеры отбрасывают) / невалидный SameSite | info |
| `SameSite` отсутствует | info (дефолт браузеров `Lax`) |
| `__Secure-`/`__Host-` префикс с нарушением требований | info |
| `Server`/`X-Powered-By`/`X-AspNet-Version`/`X-Generator`/`X-Powered-By-Plesk`/`X-Php-Version` с версией (`\d+\.\d+`) | info; версия передаётся в VULN (PHP EOL) |

OWASP `headers_remove.json` содержит 88 заголовков-«болтунов»; берём подмножество ~12 (выше) — остальное шум.

### 1.5 Библиотеки для §1

| Задача | Рекомендация | Лицензия / живость |
|---|---|---|
| HTTP-клиент | `undici` 8.12.3 (19.10.2026) | MIT · ядро Node |
| Парсинг Set-Cookie | `set-cookie-parser` 3.2.1 (21.10.2026) | MIT · поддерживается |
| Cookie-jar (не нужен для http-модуля) | `tough-cookie` 6.0.2 | BSD-3 · только если понадобится сессия |
| Парсинг CSP/HSTS/Permissions-Policy | **пишем сами** (грамматики тривиальны; Observatory-правила — наши) | — |
| Шкала/правила | собственная таблица на основе `mdn/mdn-http-observatory` `charts.js` (MPL-2.0 ⚠ лицензию репозитория проверить — берём только числа, не код) | — |

---

## 2. TLS: TLS-02 и TLS-04

### 2.1 TLS-02 — сертификат, цепочка, имя, срок

Инструменты есть в ядре Node, библиотеки не нужны:

- `tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })` → `socket.authorized`, `socket.authorizationError`, `socket.getPeerCertificate(true)` (цепочка через `issuerCertificate`), `getProtocol()`, `getCipher()`.
- `new crypto.X509Certificate(peer.raw)` → `subject`, `issuer`, `subjectAltName`, `validFromDate/validToDate`, `fingerprint256`, `checkHost(name)`, `checkIssued(issuerCert)`, `ca`.

Экспериментально подтверждённые значения `authorizationError` (Node 24.21.0):

| Ситуация | `authorized` | `authorizationError` | Поведение браузера | Уровень |
|---|---|---|---|---|
| Всё валидно | true | `null` | ОК | — |
| Цепочка доверенная, имя не совпадает (кейс хостера `*.alfahosting-server.de`) | false | `ERR_TLS_CERT_ALTNAME_INVALID` | Блокирующая страница | **critical** |
| Самоподписанный | false | `DEPTH_ZERO_SELF_SIGNED_CERT` | Блокирующая страница | **critical** |
| Самоподписанный **и** имя не совпадает | false | `DEPTH_ZERO_SELF_SIGNED_CERT` — **имя не проверяется** | Блокировка | critical; несовпадение имени добавляем сами через `X509Certificate.checkHost(host) === undefined` |
| Истёк | false | `CERT_HAS_EXPIRED` | Блокировка | **critical** |
| Не хватает промежуточного | false | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | Chrome/Edge/Safari достроят цепочку (AIA), Firefox — через intermediate preloading; старые Android — ошибка | **warning** «Zertifikatskette unvollständig» |
| Неизвестный корень | false | `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_GET_ISSUER_CERT` | Блокировка | critical (с оговоркой ниже) |
| Истекает | true | — | ОК | < 14 дней → warning, < 30 → info |

Оговорки:
- Корневое хранилище Node = снимок Mozilla NSS на момент релиза Node; свежие корни могут отсутствовать → ложный `critical`. Смягчение: флаг `--use-system-ca` (Node 22.15+/23.8+ ⚠ версия) опцией, и в тексте находки «laut Mozilla-Root-Store der Node-Version X».
- Node не делает AIA-fetching → неполная цепочка видна как ошибка; это правильно репортить как `warning`, Chrome не заблокирует.
- Проверяем только IP, который выбрал `dns.lookup`; multi-IP/CDN — отдельная оговорка в evidence (`connectedIp`).
- TLS-сессия нужна одна: из неё же берём `getProtocol()` для позитивной части TLS-04 (что сайт умеет 1.2/1.3).
- OCSP/CRL-проверку не делаем (нет в ядре без большой работы; браузеры тоже почти не делают).

### 2.2 TLS-04 — принимает ли сервер TLS 1.0/1.1

**В Node это возможно.** Контекст: OpenSSL 3.5 (`SSL_CTX_set_security_level.pod`): «Level 1: … SSLv3, TLS 1.0, TLS 1.1 and DTLS 1.0 are all disabled at this level»; дефолт уровня — 2 (там же и в Node-доках). Поэтому клиент должен явно опустить уровень в cipher-строке.

Локальный эксперимент (Node 24.21.0, OpenSSL 3.6.4; сервер и клиент в одном процессе):

| Кейс | Клиент | Сервер | Результат |
|---|---|---|---|
| A | `minVersion:'TLSv1', maxVersion:'TLSv1', ciphers:'DEFAULT@SECLEVEL=0'` | принимает TLS 1.0 | OK, `getProtocol()==='TLSv1'`, `ECDHE-RSA-AES256-SHA` |
| B | то же для `TLSv1.1` | принимает TLS 1.1 | OK, `TLSv1.1` |
| C | `maxVersion:'TLSv1'` **без** SECLEVEL | принимает TLS 1.0 | `ERR_SSL_NO_PROTOCOLS_AVAILABLE` — ошибка **нашей** конфигурации |
| D/E | как A/B | только TLS ≥ 1.2 (дефолт Node) | `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION` — сервер отверг |
| F | дефолт | дефолт | `TLSv1.3` |

Классификация результатов пробы для TLS 1.0 и 1.1 (2 соединения, каждое с SNI):

| Исход | Трактовка |
|---|---|
| Рукопожатие прошло, `getProtocol()` = запрошенная версия | **принимает** → warning (каталог: T3) |
| `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`, `ERR_SSL_UNSUPPORTED_PROTOCOL`, `ERR_SSL_WRONG_VERSION_NUMBER` | **не принимает** |
| `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE` | **неясно**: версия возможно принимается, но нет общего шифра (например, сервер только RC4 — у Node нет legacy provider) → `info` «nicht eindeutig» |
| `ECONNRESET`/таймаут | неясно (middlebox/WAF) → не репортить |
| `ERR_SSL_NO_PROTOCOLS_AVAILABLE` | баг сканера — тест на это обязателен |

Ограничения Node-подхода: (1) нужна `ciphers:'DEFAULT@SECLEVEL=0'` (можно `ALL:@SECLEVEL=0`, чтобы включить 3DES/`AES128-SHA`); (2) RC4 и экспортные шифры недоступны → редкий «только RC4»-сервер даст handshake_failure; (3) SSLv3 обычно выкомпилирован (`no-ssl3`) → SSLv3 не проверяем; (4) только один IP; (5) никакой оценки стойкости шифров, Heartbleed/ROBOT и т. п. — вне scope. Глобальный флаг `--tls-cipher-list=DEFAULT@SECLEVEL=0` **не использовать** — ломает TLS 1.3 (nodejs/node#43419) и опускает безопасность всего процесса.

Альтернатива «пишем сами» (рекомендую как план Б или даже план А): сырой ClientHello через `net.Socket`: record `0x16 0x03 0x01`, `client_version` 0x0301/0x0302, список из ~15 legacy-наборов (включая RC4/3DES), SNI-расширение; читаем первый record: `0x16 … 0x02` (ServerHello с `server_version`) = принимает; `0x15` Alert `protocol_version (70)`/`handshake_failure (40)` = нет/неясно. Не зависит от сборки OpenSSL, не завершает рукопожатие (ключевой обмен не нужен), ~150 строк, юнит-тесты на записанных байтах. Так делают testssl.sh (socket-режим) и tls-scan.

Внешние инструменты — только как опциональный `--external`:

| Инструмент | Лицензия | Живость | Что даёт сверх | Минусы |
|---|---|---|---|---|
| testssl.sh | GPL-2.0 (репо `testssl/testssl.sh`, push 28.10.2026, ветка 3.3dev) | активен | полный аудит протоколов/шифров/уязвимостей, JSON-вывод | bash + openssl-бинарь, 1–3 мин на хост, GPL — только как отдельный процесс/Docker |
| sslyze | AGPL-3.0 (push 28.10.2026) | активен | свои сборки OpenSSL с legacy, точный | Python, AGPL — только вызов процесса, не линковка |

Частая причина TLS-04 в практике: Cloudflare-зоны по умолчанию имеют Minimum TLS Version = 1.0 (⚠ вторичные источники; официальная дока дефолт не называет) → текст находки должен подсказывать «CDN-Einstellung prüfen».

---

## 3. DNS: SPF, DMARC, DKIM, CAA, DNSSEC, отсутствие MX

Общие правила: все почтовые проверки — на **регистрируемом домене** сканируемого хоста (eTLD+1 через `tldts`); если сканируемый хост — поддомен с собственным MX, проверяем и его. Резолвер: `new dns.Resolver({ timeout: 3000, tries: 2 })`, при необходимости `setServers()`; все запросы через один DNS-клиент с журналом (evidence = имя, тип, ответ, резолвер).

### 3.1 SPF (RFC 7208)

Парсим TXT на домене: ровно одна запись `v=spf1` (две → permerror); механизмы `all, include, a, mx, ptr, ip4, ip6, exists`, модификаторы `redirect=`, `exp=`; квалификаторы `+ - ~ ?`. Статический анализ (не оценка для конкретного IP):

- Счётчик DNS-запросов: `include`, `a`, `mx`, `ptr`, `exists`, `redirect` — **≤ 10** (§4.6.4); `mx` дополнительно ≤ 10 MX-имён; void lookups (NXDOMAIN/пусто) **≤ 2**. Рекурсия по `include`/`redirect` с защитой от циклов, глубина ≤ 10.
- Тип RR 99 (SPF) — устарел, не смотрим.

| Состояние | Уровень | Текст (ориентир) |
|---|---|---|
| Записи нет (домен принимает почту, см. §3.6) | **warning** | «kein SPF-Eintrag» |
| `+all` | **warning** (в тексте — «schwerwiegend»; `critical` не даём, T3) | «erlaubt beliebige Absender» |
| `?all` | warning | neutral = фактически нет политики |
| `~all` и нет DMARC `p=quarantine/reject` | warning (каталог: 32 из 80) | «softfail ohne DMARC-Durchsetzung» |
| `~all` и DMARC `p≠none` | info | провайдеры (Google) сами рекомендуют `~all` + DMARC |
| `-all` | — | |
| > 10 lookups / > 2 void / цикл / синтаксис / 2 записи | warning | «permerror – SPF wird von Empfängern ignoriert» |
| `ptr` | info | deprecated |
| `include` на несуществующий домен | warning | |

### 3.2 DMARC — RFC 9989 (май 2026), RFC 9990 (aggregate), RFC 9991 (failure)

Обнаружение: TXT на `_dmarc.<host>`; если нет — **DNS Tree Walk** (RFC 9989 §4.10): вверх по меткам, ≤ 8 запросов, остановка на `psd=y/n`. Практически: пройти от хоста до eTLD+1 (`tldts`) — 2–4 запроса; PSL оставить как контроль совместимости с RFC 7489-получателями.

Теги: `v, p, sp, np, psd, t, rua, ruf, adkim, aspf, fo` (реестр §4.7); удалены `pct, rf, ri` (Appendix C.5.2); `pct` — «historic», в живых записях встречается часто → парсим, `pct<100` → info. `t=y` ≈ старый `pct=0`.

| Состояние | Уровень |
|---|---|
| Записи нет (ни на хосте, ни по tree walk) | **warning** (каталог: 28/80) |
| `p=none` | **warning** (каталог: 26/80); текст «Monitoring-Modus, keine Durchsetzung» |
| `p=quarantine` | — (можно info «teilweise Durchsetzung») |
| `p=reject` | — |
| `pct<100` / `t=y` | info «Testmodus» |
| `sp=none` или `np=none` при `p=reject` | info |
| `rua` отсутствует | info |
| `rua` на чужой домен без `<domain>._report._dmarc.<ruadomain>` (1 доп. запрос) | info |
| две записи / синтаксис / нет `v=DMARC1` первым | warning «ungültig» |

### 3.3 DKIM (RFC 6376; ed25519 — RFC 8463) — селекторы

Запрос: TXT `<selector>._domainkey.<domain>` (CNAME, как у IONOS → `s1.dkim.ionos.com`, резолвер разворачивает сам). Запись валидна, если есть `p=` непустое (`p=` пустое = ключ отозван); `k=rsa` ключ < 1024 бит → warning (RFC 8301).

Порядок проверки — по MX-подсказке, затем generic, затем остальные провайдерские. Бюджет **≤ 40 запросов**, параллельно 8, таймаут 3 с, общий ≤ 5 с.

| Провайдер / группа | Селекторы | Подтверждение |
|---|---|---|
| Generic | `default`, `dkim`, `mail`, `email`, `k1`, `k2`, `s1`, `s2`, `selector1`, `selector2`, `dkim1`, `dkim2`, `key1`, `smtp`, `mx` | списки инструментов (captaindns, suped) |
| Google Workspace (MX `*.google.com`) | `google` | да |
| Microsoft 365 (MX `*.mail.protection.outlook.com`) | `selector1`, `selector2` | да |
| IONOS / 1&1 (MX `mx0*.ionos.de`, `*.kundenserver.de`) | `s1-ionos`, `s2-ionos` (+ аккаунтный `s<digits>` — не угадать) | дока IONOS (через вторичный источник) |
| Strato (MX `*.rzone.de`) | `strato-dkim-0002`, `strato-dkim-0003` (ed25519) | ⚠ только форумы (administrator.de, Sophos) |
| mailbox.org | `MBO0001`…`MBO0004` | ⚠ вторичный источник |
| All-Inkl (MX `*.kasserver.com`) | **не найдено** | ⚠ снять с реальных писем |
| Hetzner (konsoleH, MX `mail.your-server.de`) | **не найдено** | ⚠ снять с реальных писем |
| web.de/GMX Business, Posteo | не найдено | ⚠ |
| Mailchimp / Mandrill | `k1`, `k2`, `k3` / `mte1`, `mte2` (`mandrill` legacy) | да |
| Brevo (ex-Sendinblue) | `brevo1`, `brevo2`; `mail`, `sendinblue` legacy | да |
| HubSpot | `hs1`, `hs2` (варианты `hs1a`) | да |
| SendGrid | `s1`, `s2`, `smtpapi` legacy | да |
| Mailgun | `pdk1`, `pdk2`, `smtp`, `mg`, `k1` | частично |
| Zoho / Proton / iCloud | `zoho`, `zmail` / `protonmail`, `protonmail2`, `protonmail3` / `sig1` | да |
| Constant Contact / Klaviyo | `ctct1`, `ctct2` / `km1`, `km2` | да |
| CleverReach, rapidmail, Mailjet, Newsletter2Go | **не подтверждены** | ⚠ |
| Amazon SES, Postmark (`<date>pm`), HubSpot-аккаунтные | случайные → **необнаружимы** | — |

Уровни MAIL-03 (каталог: 14/80, T3):

| Состояние | Уровень |
|---|---|
| MX указывает на провайдера с известными селекторами (Google, M365, IONOS, Strato ⚠) и его селекторы пусты | **warning** «DKIM für <Provider> nicht eingerichtet» |
| MX неизвестен/свой, ни один из N селекторов не найден | **info** «unter N gängigen Selektoren nicht gefunden» (не «fehlt») |
| Найден, но `p=` пуст или ключ < 1024 бит | warning |
| Найден ≥ 1 валидный | — (перечислить селекторы в evidence) |

### 3.4 CAA (RFC 8659)

`dns.resolveCaa()` есть в Node с 15.0/14.17. Проверяем на eTLD+1 (CAA ищется вверх по дереву, но для регистрируемого домена это и есть точка). `issue`/`issuewild`; отсутствие → `info` (DNS-01, P2). Совпадение CA в сертификате с CAA не проверяем (нет нормализованной таблицы issuer→CAA-строка без ручной поддержки).

### 3.5 DNSSEC

Факт: `node:dns` (c-ares) не отдаёт AD-флаг, не ставит DO-бит и не знает типы DS/DNSKEY/RRSIG (nodejs/node#14475, с 2017 без движения; c-ares PR закрыт). Варианты:

| Способ | Что даёт | Приватность | Библиотека |
|---|---|---|---|
| Сырой DNS (UDP→TCP fallback) к **системному** резолверу, EDNS0 с DO=1, читаем `AD` и запрашиваем `DS` | Наличие DS у родителя = «signiert»; AD=1 только если системный резолвер валидирует (systemd-resolved `DNSSEC=yes`, Unbound, Quad9 в настройках) | Данные не покидают текущую инфраструктуру | `dns-packet` 5.6.1 (MIT; последний релиз 08/2023 — стабильный, зависимость многих пакетов) |
| DoH wire-format (RFC 8484) к валидирующему резолверу: `POST application/dns-message` через undici | Надёжный AD | Домен уходит третьей стороне → **opt-in** `--doh <url>` | `dns-packet` + undici; `allowH2: true` (Quad9 с 15.12.2025 только HTTP/2 ⚠) |
| DoH JSON (Google/Cloudflare `AD: true/false`) | Проще | то же | не нужно |
| Полная локальная валидация (getdns) | — | — | `getdns` npm мёртв (2021) — нет |

Резолверы для opt-in: Quad9 `https://dns.quad9.net/dns-query` (швейцарский фонд, валидирует, блокирует вредоносные домены — для нас нейтрально); dns0.eu (французская НКО) — **⚠ эндпойнт не удалось проверить** (домен не резолвился из песочницы); Cloudflare `https://cloudflare-dns.com/dns-query`, Google `https://dns.google/dns-query` — США, только по явному выбору.

Уровни: DS нет → info «DNSSEC nicht aktiviert» (DNS-01); DS есть, но AD=0 от **валидирующего** резолвера → warning «DNSSEC-Kette defekt» (риск SERVFAIL) — только при DoH/известном валидирующем резолвере, иначе не судим.

### 3.6 Нет MX — что делать с MAIL-*

| Состояние DNS | Трактовка (RFC 5321 §5.1, RFC 7505) | MAIL-01/02 | MAIL-03 |
|---|---|---|---|
| MX есть | почтовый домен | по таблицам выше | да |
| MX нет, A/AAAA есть | implicit MX → домен **может** принимать почту; для спуфинга важен только From-домен | уровни как обычно, в тексте «kein MX, implizit über A-Record» | да |
| Null MX `MX 0 .` | домен явно без почты | ожидаем `v=spf1 -all` и DMARC `p=reject` (best practice M3AAWG); если их нет → **info** вместо warning | не применимо |
| MX нет, A/AAAA нет (чистый apex без веб-хоста — редко) | почта невозможна | «nicht anwendbar» | нет |
| MX есть, но все цели не резолвятся | сломанная почта | info отдельно | да |

### 3.7 Библиотеки для §3

| Задача | Рекомендация | Почему |
|---|---|---|
| eTLD+1 / organizational domain | `tldts` 7.4.19 (20.10.2026, MIT) | `psl` 1.15.0 обновлялся 12/2024 — отстаёт |
| SPF-парсер и счётчик lookups | **пишем сами** (~200 строк) | `spf-parse` 1.0.4 — 2017 г.; `mailauth` проверяет SPF для IP, а не статически |
| DMARC: парсер + tree walk | **пишем сами**; `mailauth` 8.0.4 (22.10.2026, MIT, Node ≥ 20.18) — опционально для DKIM-ключей/DMARC-helpers | `dmarc-parse` 1.2.1 — 2020 г.; поддержка RFC 9989 tree walk в mailauth ⚠ проверить |
| DKIM-ключ: парсинг `v=DKIM1; k=; p=`, длина ключа | свой парсер + `crypto.createPublicKey` для длины | тривиально |
| Сырые DNS-пакеты (DO/AD, DS) | `dns-packet` 5.6.1 (MIT) | стандарт де-факто; `dns2` 3.1.1 (07/2026, MIT) — альтернатива, но DO-бит ⚠ проверить |
| DoH | undici + `dns-packet` (≈ 50 строк) | `dohdec` 8.0.0: в npm-метаданных MIT, в README MPL-2.0 — **конфликт лицензий ⚠**, не брать |

---

## 4. FILE-01 и ADMIN-01

### 4.1 Фиксированный список путей (≈ 30 запросов + 3 базлайна)

Правило: путь засчитывается **только** при совпадении сигнатуры/магических байт **и** отличии от soft-404-базлайна. Без сигнатуры — ничего не репортим (даже `200`).

| Группа | Путь | Сигнатура (первые ≤ 4 KiB) | Уровень |
|---|---|---|---|
| VCS | `.git/HEAD` | `^ref: refs/` или `^[0-9a-f]{40}\s*$` | **critical** (каталог: T0) |
| | `.git/config` | `[core]` + `repositoryformatversion` | critical |
| | `.svn/wc.db` | магия `SQLite format 3\0` | critical |
| Секреты | `.env`, `.env.bak` | ≥ 2 строк `^[A-Z][A-Z0-9_]*=`; маркеры `DB_PASSWORD|APP_KEY|SECRET|TOKEN` | critical |
| | `wp-config.php.bak`, `.old`, `.save`, `.orig`, `~`, `.txt` | `define\(\s*'DB_(NAME|USER|PASSWORD)` | critical |
| | `configuration.php.bak` (Joomla) | `public \$password` | critical |
| | `.htpasswd` | `^[^:\s]+:(\$apr1\$|\$2y\$|\{SHA\})` | critical |
| | `docker-compose.yml` | `^services:` + `PASSWORD` | warning |
| Дампы/архивы | `backup.zip`, `<host>.zip`, `www.zip`, `site.zip` | `50 4B 03 04` и размер > 1 KiB | critical |
| | `backup.tar.gz`, `backup.sql.gz` | `1F 8B` | critical |
| | `backup.sql`, `db.sql`, `dump.sql`, `database.sql`, `<host>.sql` | `-- MySQL dump|-- phpMyAdmin SQL Dump|CREATE TABLE|INSERT INTO` | critical |
| Отладка | `phpinfo.php`, `info.php` | `phpinfo\(\)|<title>PHP \d` | warning |
| | `wp-content/debug.log`, `error_log` | `^\[\d{2}-[A-Z][a-z]{2}-\d{4} .*\] PHP ` | warning |
| | `server-status` | `Apache Server Status` | warning |
| Метаданные | `.DS_Store` | магия `00 00 00 01 42 75 64 31` («Bud1») | info (раскрывает имена файлов) |
| | `composer.lock` | `"packages"` + `"name":` | info; версии → в VULN |
| Листинг | `wp-content/uploads/` | `<title>Index of /` | info |

Не включаем в MVP: `.ssh/id_rsa`, `.vscode/sftp.json`, `.idea/*`, `adminer.php`, `phpmyadmin/` (последние два — скорее ADMIN), любые словари.

### 4.2 Soft-404 — отличить реальный файл от «всё отдаёт 200»

1. Базлайн: 3 запроса к заведомо несуществующим путям той же формы — `/<rand16>`, `/<rand16>.php`, `/.<rand16>` (дот-файл: WAF/Apache часто отвечают 403 на `.*`). Запоминаем статус, `Content-Type`, длину, нормализованный текст (без цифр/дат/nonce), simhash или `sha256`.
2. Кандидат — только если: статус `200`/`206`; тело не похоже на базлайн (длина отличается > 10 % **и** similarity < 0.9); `Content-Type` правдоподобен (для `.git/HEAD` — `text/plain`/`octet-stream`, не `text/html`); сработала сигнатура из таблицы.
3. Редирект (3xx, в т. ч. на логин/главную), `401/403/404/410` → «не найдено». HTML с `<title>` главной → базлайн.
4. Для `.git/HEAD` дополнительный подтверждающий запрос не нужен (сигнатура уникальна); для архивов — магия + размер.

### 4.3 Не скачивать секреты

- `GET` с `Range: bytes=0-4095`; сервер проигнорировал → читаем ≤ 4 KiB и `body.destroy()`. HEAD не используем (многие серверы отвечают 200/405 на всё).
- В evidence: путь, статус, `Content-Type`, `Content-Length`, имя сработавшей сигнатуры, `sha256` первых 4 KiB, **одна** строка-подтверждение после редактирования: `(?i)(password|passwd|pwd|secret|token|key|dsn|auth)\s*[=:]\s*\S+` → `$1=«redacted»`; для дампов — только заголовок (`-- MySQL dump 10.x`). Тело никогда не пишется ни в JSON, ни в HTML.
- Опции: `--no-files`, `--files-allowlist`, лимит 4 KiB неотключаем.

### 4.4 Почему это не «перебор» по смыслу ТЗ (и что с законом)

- Перебор (fuzzing) — тысячи словарных путей/параметров; у нас документированный список ≤ 30 общеизвестных имён, GET без аутентификации, без манипуляций параметрами, с лимитом частоты и честным UA — ровно то, что сделал бы браузер при вводе URL. Это та же категория, что `/.well-known/security.txt` или `/robots.txt`.
- § 202a StGB требует «Überwindung einer Zugangssicherung»; её нет, если сервер отдаёт файл любому. Но дело **«Modern Solution»** (AG Jülich: штраф 3 000 €, 01/2024; LG Aachen подтвердил 04.11.2024; OLG Köln подтвердил 07/2025; BVerfG жалобу не принял — ⚠ даты по вторичным источникам) показывает, что суды могут видеть «Sicherung» там, где айтишник её не видит (там — захардкоженный пароль). Отсюда правила §4.3: не читать и не хранить содержимое секретов, усечение и редактирование — технические, не отключаемые.
- Реформа § 202a (Referentenentwurf BMJ от 04.11.2024, новый Abs. 3 для Sicherheitsforschung) — по состоянию на позиции в Lobbyregister от 08/2026 **не принята** ⚠ проверить актуальный статус в Bundestag. Пока — дисклеймер в README: сканировать только свои сайты или по поручению; это зона заказчика (DSGVO/право).

### 4.5 ADMIN-01 — WordPress

Включается только если VULN-01 определил WordPress. Три GET-запроса:

| Запрос | Что показывает | Пассивность |
|---|---|---|
| `GET /wp-json/wp/v2/users` | список пользователей, у которых есть опубликованные записи (поведение ядра `WP_REST_Users_Controller` для неаутентифицированных ⚠ точная формулировка — в доках REST API не описана); поля `name`, `slug`, `description`, `avatar_urls`; `slug` обычно = логин | обычный публичный REST-эндпойнт |
| `GET /?author=1` без редиректов | `301 → /author/<slug>/` раскрывает логин | обычная ссылка |
| `GET /xmlrpc.php` | `405` + «XML-RPC server accepts POST requests only.» = интерфейс включён | GET; `POST system.listMethods` не делаем |
| `GET /wp-login.php` | `200` = форма входа доступна | только наличие; **никаких** попыток входа |

Уровни: пользователи раскрыты **и** `xmlrpc.php` активен → warning (усиление brute-force через `system.multicall`); только xmlrpc → info; только пользователи → info, но с отдельной формулировкой «veröffentlicht Namen/Logins von Benutzerkonten» — поле `name` часто содержит реальные имена сотрудников, это уже близко к DSGVO (Datenminimierung), окончательная формулировка — за заказчиком; `wp-login.php` доступен → не репортить (нормально), либо info при наличии первых двух.

---

## 5. VULN-01/02: CMS, плагины, JS-библиотеки, уверенность версии

### 5.1 Детект и версии

Главный принцип: **сначала то, что уже скачано** (HTML главной и правовых страниц, заголовки, тела скриптов из Playwright-перехвата), потом — минимальные целевые запросы с жёстким cap.

| Система | Признаки (0 запросов) | Версия (доп. запросы) | Уверенность |
|---|---|---|---|
| WordPress | `/wp-content/`, `/wp-includes/`, `<meta name="generator" content="WordPress 6.x">`, `?ver=6.x.y` на `wp-includes/*` (ядро подставляет свою версию), `wp-emoji-release.min.js?ver=`, `<link rel="https://api.w.org/">` | `/readme.html` (`Version 6.x`), `/feed/` → `<generator>https://wordpress.org/?v=6.x.y</generator>` (1–2 запроса) | exact при readme/feed/`?ver=` ядра; range при одном meta без patch |
| WP-плагины | slug из `/wp-content/plugins/<slug>/…`; `?ver=` на ассетах плагина (Elementor, CF7, Revolution Slider, WPBakery подставляют **свою** версию; другие — версию WP или cache-buster) | `/wp-content/plugins/<slug>/readme.txt` → `Stable tag:` (1 запрос на плагин, cap 20, приоритет — плагины из каталога: Elementor, Contact Form 7, Borlabs, Slider Revolution, WPBakery); премиум-плагины без readme → только `?ver=` | exact при readme; `?ver=` плагина = exact для известных (список), иначе range; только slug → unknown |
| WP-темы | `/wp-content/themes/<slug>/` | `style.css` → заголовок `Version:` (стандарт WP, Divi тоже) — 1 запрос | exact |
| Elementor | `<meta name="generator" content="Elementor 3.x.y; features: …">` | — | exact |
| TYPO3 | `/typo3conf/`, `/typo3temp/`, `/fileadmin/`, `/_assets/<hash>/` (v12+), `<meta name="generator" content="TYPO3 CMS">` (без версии) | точной версии публично нет; мажор по структуре путей (`_assets` ⇒ ≥ 12) | range (мажор) / unknown |
| Joomla | `<meta name="generator" content="Joomla! - Open Source Content Management">`, `/media/system/js/`, `/components/com_*` | `/administrator/manifests/files/joomla.xml` → `<version>` (часто не заблокирован) — 1 запрос | exact / range |
| Drupal | заголовок `X-Generator: Drupal 10 (https://www.drupal.org)`, `/core/misc/drupal.js`, `/sites/default/files/` | `/CHANGELOG.txt` (только D7) — 1 запрос | range (мажор) |
| Next.js | `X-Powered-By: Next.js` (если не отключён), `/_next/static/`, `__NEXT_DATA__`/`self.__next_f` | версия — в браузере `window.next?.version` (⚠ проверить для App Router) → браузерный модуль; статически — редко | exact (браузер) / unknown |
| Nuxt / Angular / React | `/_nuxt/`, `window.__NUXT__`; `ng-version="17.x"` в DOM; React — только наличие | Angular — exact из атрибута | — |
| PHP | `X-Powered-By: PHP/8.1.2` | — | exact |
| jQuery и JS-библиотеки | подход retire.js: regex по имени файла (`jquery-3.4.1.min.js`), по содержимому (`/*! jQuery v3.4.1`), хэши, runtime-функция (`jQuery.fn.jquery`) — по телам скриптов из Playwright | 0 запросов | exact |

### 5.2 Уверенность версии → уровень

| Уверенность | Как получена | Влияние на уровень из каталога |
|---|---|---|
| **exact** | readme/style.css/feed/`?ver=` известного компонента/runtime/хэш | уровень по каталогу (`critical` при RCE/upload/SQLi/auth-bypass без входа или CISA KEV; иначе `warning`) |
| **range** | только мажор/минор (meta без patch, `X-Generator`, структура путей) | уровень **−1 ступень** (critical → warning, warning → info), текст «Version nicht eindeutig (≥ x.y)»; CVE перечисляем только если **весь** диапазон уязвим |
| **unknown** | только факт наличия компонента | **info** «erkannt, Version unbekannt», CVE не упоминаем |

Дополнительное дешёвое правило — **EOL мажора** без привязки к CVE → warning «keine Sicherheitsupdates mehr»: PHP ≤ 8.1 (8.1 EOL 31.12.2025 ⚠), TYPO3 ≤ 12 (12.4 LTS: бесплатная поддержка закончилась **30.04.2026**; ELTS платный до 10/2027–04/2030 ⚠ источники расходятся), TYPO3 11 (10/2024), Joomla 3 (08/2023), Joomla 4 (⚠ 10/2025), Drupal 7 (⚠ 01/2025), jQuery 1.x/2.x. Источник дат — `endoflife.date` (API JSON; лицензия данных ⚠ проверить) или ручная таблица в репозитории.

Пример из каталога: jQuery 3.4.1 → CVE-2020-11023 (XSS, исправлено в 3.5.0) — в CISA KEV с **23.01.2025** → по правилу каталога `critical`, хотя CVSS 6.1. Стоит обсудить с заказчиком: KEV-правило даёт `critical` на половине WordPress-сайтов (ядро WP до 2024 поставляло jQuery 3.6/3.7 — не затронуто, но старые темы — да).

### 5.3 Источники уязвимостей (кратко; детально — в соседнем ресёрче)

| Экосистема | Источник | Условия |
|---|---|---|
| JS-библиотеки | retire.js `repository/jsrepository-v4.json` … `v6.json` (репо `RetireJS/retire.js`, Apache-2.0); какой формат читает CLI 6.1.0 (06.10.2026) — ⚠ | бесплатно, CDN raw.githubusercontent |
| npm-пакеты (Next.js, jQuery как пакет) | OSV.dev API `POST /v1/query` `{package:{ecosystem:'npm',name},version}` | бесплатно, без ключа |
| Composer (TYPO3 `typo3/cms-core`, Drupal `drupal/core`, Joomla `joomla/joomla-cms`) | OSV.dev, экосистема `Packagist` | бесплатно |
| WordPress ядро/плагины/темы | Wordfence Intelligence (бесплатно, v3 требует бесплатный API-ключ, записи несут `license_url` Community Edition — требования атрибуции ⚠ страница не открылась); WPScan API (free: 25 запросов/день, non-commercial — не подходит для CI) ; wpvulnerability.com ⚠ | в OSV WordPress-плагинов **нет** |
| «Эксплуатируется в дикой природе» | CISA KEV JSON (`known_exploited_vulnerabilities.json`) | public domain ⚠ |

### 5.4 Библиотеки для §5

| Задача | Рекомендация | Лицензия |
|---|---|---|
| Отпечатки CMS | **пишем сами** (10–15 систем из немецкой практики: WP, TYPO3, Joomla, Drupal, Shopware, Contao, Next/Nuxt, Wix, Jimdo, Squarespace, Shopify) | — |
| Wappalyzer-данные | `enthec/webappanalyzer` — **GPL-3.0** (push 19.10.2026) → несовместимо с Apache-2.0 при включении в дистрибутив; `wappalyzer` npm 7.0.3 — deprecated | нет |
| JS-библиотеки | `retire` 6.1.0 (Apache-2.0) — брать **данные** (`jsrepository`), матчинг писать свой (extractors `filename/filecontent/hashes/func` — простые) | Apache-2.0 |
| Семвер-диапазоны | `semver` (ISC) | ISC |

---

## 6. SEC-01 security.txt и LEGAL-02 устаревшие законы

### 6.1 SEC-01 — RFC 9116

Проверка (2 запроса): `GET /.well-known/security.txt`, при 404 — `GET /security.txt` (legacy; при наличии обоих приоритет у `.well-known`). Условия валидности: HTTPS; `200`; `Content-Type: text/plain` (`charset=utf-8`); не HTML (soft-404 из §4.2); парсинг `Field: value` с комментариями `#`.

| Поле | Требование RFC 9116 | Проверка |
|---|---|---|
| `Contact` | **MUST**, ≥ 1, URI (`mailto:`, `https:`, `tel:`) | отсутствует → «ungültig» |
| `Expires` | **MUST**, ровно 1, RFC 3339 (`2027-03-01T00:00:00.000Z`); RECOMMENDED < 1 года вперёд | отсутствует/дубль/непарсится → «ungültig»; в прошлом → «abgelaufen»; > 1 года → примечание |
| `Canonical` | MAY, повторяемое; если есть — URL, по которому получили файл, должен быть в списке | иначе «Canonical passt nicht» |
| `Preferred-Languages` | MAY, ≤ 1 | дубль → «ungültig» |
| `Encryption`, `Policy`, `Acknowledgments`, `Hiring` | MAY | только фиксируем |
| PGP-cleartext подпись | RECOMMENDED | фиксируем наличие, не проверяем |

Уровни (каталог: «только info»): нет → info; есть, но невалиден/просрочен → info с деталями. Библиотека не нужна (~60 строк + тесты на примерах из RFC).

### 6.2 LEGAL-02 — ссылки на устаревшие законы в Impressum/Datenschutzerklärung

Вход: текст страниц Impressum и Datenschutz (URL находит LEGAL-01 в браузерном модуле; текст извлекаем из HTML без скриптов/стилей, нормализуем пробелы и `§`/`§§`, `Abs.`/`Absatz`). Исключаем совпадения с «историческим» контекстом (в 40 символах до: `ehemals|früher|vormals|alt(e|er|en)|bisher|ersetzt`).

| Регулярка (упрощённо, `iu`) | Что устарело | Актуально с | Текст находки |
|---|---|---|---|
| `§\s*5\s*(Abs\.?\s*\d\s*)?TMG\b`, `\bTMG\b`, `Telemediengesetz` | TMG | § 5 **DDG**, 14.05.2024 | «Verweis auf TMG – seit 14.05.2024 gilt das DDG» |
| `§\s*55\s*(Abs\.?\s*2\s*)?RStV\b`, `\bRStV\b`, `Rundfunkstaatsvertrag` | RStV | § 18 Abs. 2 **MStV**, 07.11.2020 | «Verweis auf § 55 RStV – heute § 18 Abs. 2 MStV» |
| `§\s*13\s*TMG` | Datenschutz-норма TMG | Art. 13 DSGVO / § 25 TDDDG | |
| `\bTTDSG\b`, `Telekommunikation-Telemedien-Datenschutz-Gesetz` | TTDSG (часто `§ 25 TTDSG` в cookie-разделах) | **TDDDG**, 14.05.2024 | |
| `ec\.europa\.eu/consumers/odr`, `OS-Plattform`, `Online-Streitbeilegung` | ссылка на ODR-платформу ЕС | платформа закрыта **20.07.2025** (Verordnung (EU) 2024/3228) | «Hinweis auf eingestellte OS-Plattform» (⚠ если есть старая Unterlassungserklärung, ссылка может быть обязательной — поэтому только info) |
| `Privacy[\s-]?Shield` без `Data Privacy Framework` | EU-US Privacy Shield | недействителен с 16.07.2020 (EuGH C‑311/18) | |
| `Safe[\s-]?Harbor` | Safe Harbor | недействителен с 06.10.2015 (C‑362/14) | |

Все — `info` (каталог: P2, «редко»). Ложные срабатывания: страницы юристов/статьи, цитирующие историю закона → исключающий контекст выше + ограничение на страницы Impressum/Datenschutz.

---

## 7. Вежливость и общий HTTP-клиент

### 7.1 Параметры по умолчанию

| Параметр | Значение | Обоснование |
|---|---|---|
| Конкуррентность на хост | 3 (DNS: 8) | один сайт, часто shared-hosting |
| Частота | ≤ 4 req/s на хост (token bucket), пауза 250 мс между FILE-01 запросами | не похоже на сканер уязвимостей |
| Таймауты | undici `connect.timeout` 5 s, `headersTimeout` 10 s, `bodyTimeout` 15 s; общий на запрос 20 s; общий бюджет http-модулей 90 s | |
| Ретраи | 1 повтор на сетевые ошибки/`429`/`502-504` с backoff 500 мс → 2 s, уважаем `Retry-After`; `4xx` не повторяем; FILE-01 не повторяем вовсе | undici `interceptors.retry` |
| Редиректы | по умолчанию **не** следовать (`maxRedirections: 0`), следовать вручную только в TLS-01 и при загрузке страниц (≤ 5) | нужна цепочка как evidence |
| Лимит тела | 2 MiB для HTML, 4 KiB для FILE-01, 64 KiB для readme/style.css | |
| User-Agent | `dsgvo-check/<ver> (+https://github.com/<org>/dsgvo-check; passive DSGVO/security check)` ; `Accept-Language: de-DE,de;q=0.9,en;q=0.5` | ТЗ: честный UA со ссылкой на репозиторий |
| robots.txt | уважаем `Disallow` для **обхода страниц** (браузерный модуль); фиксированные пути FILE/SEC/ADMIN/VULN не подчиняем robots (он не для этого; `.git` там часто «запрещён»), но документируем | |
| Бюджет запросов за скан | HTTP ≈ 120 (TLS-01 ≤ 8, заголовки 3, FILE ≈ 33, ADMIN 3, VULN ≤ 25, SEC 2, LEGAL 2) + TLS-сокетов 3 + DNS ≤ 70 (SPF ≤ 12, DMARC ≤ 8, DKIM ≤ 40, MX/A/CAA/DS ≈ 6) | печатаем в отчёте «Anzahl Anfragen» |
| Повтор прогонов | `--dry-run` печатает план запросов без выполнения | для аудита сканера |

### 7.2 Общий клиент

Один модуль `http/client.ts`, который получают все проверки через контекст:

```ts
// иллюстрация, не код проекта
const agent = new Agent({ connect: { timeout: 5_000 }, headersTimeout: 10_000, bodyTimeout: 15_000, allowH2: true })
  .compose(interceptors.retry({ maxRetries: 1, statusCodes: [429, 502, 503, 504] }),
           interceptors.dns({ maxTTL: 60_000 }));
// redirect-интерсептор не включаем глобально: цепочку редиректов собираем сами (TLS-01).
```

Обязанности клиента: per-host `p-limit`/`p-queue` + token bucket; единый UA/Accept-Language; `maxBodyBytes` с `Range`; журнал `{ts, method, url, status, headers, bytes, durationMs, connectedIp, tlsProtocol}` → evidence и статистика; `rawHeaders` (дубликаты `Set-Cookie`); доступ к `tls.TLSSocket` через `connect`-хук для TLS-02 (или отдельное `tls.connect` — проще). Playwright и клиент — **разные** стеки; результаты складываем в общий `EvidenceStore` (запросы браузера, тела скриптов, cookies), чтобы VULN/JS-библиотеки не качали повторно.

Почему не `got`/`ky`/`axios`: undici — то, что Node использует сам; даёт сырые заголовки, HTTP/2, interceptors, пулинг; `got` 16 хорош, но дублирует функциональность и добавляет слой над тем же undici.

---

## 8. Сводная таблица библиотек (npm registry, 30.10.2026)

| Пакет | Версия / дата | Лицензия | Вердикт |
|---|---|---|---|
| `undici` | 8.12.3 / 2026-10-19 | MIT | **да** — общий клиент, DoH |
| `tldts` | 7.4.19 / 2026-10-20 | MIT | **да** — eTLD+1 |
| `set-cookie-parser` | 3.2.1 / 2026-10-21 | MIT | да (HDR-02) |
| `dns-packet` | 5.6.1 / 2023-08-25 | MIT | да (DO/AD, DS, DoH); стабилен, но давно без релизов ⚠ |
| `p-limit` / `p-queue` | 7.3.3 / 2026-09-18 · 10.0.0 / 2026-10-12 | MIT | да (одно из двух) |
| `semver` | — | ISC | да (VULN) |
| `mailauth` | 8.0.4 / 2026-10-22 | MIT | опционально (DKIM-ключи, DMARC-helpers); SPF-статику пишем сами |
| `retire` (данные) | 6.1.0 / 2026-10-06 | Apache-2.0 | данные — да; CLI не нужен |
| `@peculiar/x509` | 3.1.0 / 2026-10-27 | MIT | не нужен — хватает `crypto.X509Certificate` |
| `node-forge` | 1.4.2 | BSD-3/GPL-2 | нет |
| `tough-cookie` | 6.0.2 | BSD-3 | нет (пока) |
| `psl` | 1.15.0 / 2024-12 | MIT | нет (tldts свежее) |
| `spf-parse` / `dmarc-parse` / `dkim` | 2017 / 2020 / 2022 | MIT | нет — мертвы |
| `dohdec` | 8.0.0 / 2026-03 | MIT в npm vs MPL-2.0 в README ⚠ | нет |
| `dns2` | 3.1.1 / 2026-07 | MIT | запасной вариант |
| `wappalyzer` / `enthec/webappanalyzer` | deprecated / GPL-3.0 | — | нет |
| `got` / `ky` / `axios` | 16.2.0 / 2.2.0 / 1.21.0 | MIT | нет (дублируют undici) |
| `bottleneck` | 2.19.5 / 2019 | MIT | нет (устарел) |
| testssl.sh / sslyze | внешние | GPL-2.0 / AGPL-3.0 | только опциональный внешний процесс, после MVP |

«Пишем сами»: парсеры SPF/DMARC/DKIM-записей, CSP/HSTS/Permissions-Policy, security.txt, сырой DNS (поверх dns-packet), soft-404-детектор, сигнатуры FILE-01, отпечатки CMS, retire-матчинг, (опционально) сырой TLS ClientHello.

---

## Источники

| URL | Что подтверждает |
|---|---|
| https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | даты LTS/Maintenance Node 22/24/26/27 |
| https://nodejs.org/api/tls.html · https://raw.githubusercontent.com/nodejs/node/main/doc/api/tls.md | SECLEVEL=2 по умолчанию, пример `DEFAULT@SECLEVEL=0` + `minVersion:'TLSv1'`, `DEFAULT_MIN_VERSION='TLSv1.2'`, `authorized/authorizationError`, `getPeerCertificate`, `getProtocol()` |
| https://raw.githubusercontent.com/openssl/openssl/openssl-3.5/doc/man3/SSL_CTX_set_security_level.pod | «If not set then 2 is used»; Level 1 отключает SSLv3/TLS 1.0/1.1 |
| https://github.com/nodejs/node/issues/43419 · https://github.com/nodejs/node/pull/49236 | глобальный `--tls-cipher-list=…SECLEVEL=0` ломает TLS 1.3; нужна клиентская опция |
| Локальный эксперимент (scratchpad `tlsprobe/probe.mjs`, `cert.mjs`, Node 24.21.0 / OpenSSL 3.6.4) | коды `ERR_SSL_NO_PROTOCOLS_AVAILABLE`, `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`, `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`; имя не проверяется при ошибке цепочки |
| https://nodejs.org/api/dns.html | `resolveCaa` с v15.0/14.17; `Resolver({timeout,tries})`; нет упоминаний DNSSEC/AD |
| https://github.com/nodejs/node/issues/14475 | отсутствие DNSSEC в node:dns (c-ares) |
| https://raw.githubusercontent.com/mdn/mdn-http-observatory/main/src/grader/charts.js · https://developer.mozilla.org/en-US/observatory/docs/tests_and_scoring | модификаторы Observatory, шкала A+…F (100 базовых, бонусы при ≥ 90) |
| https://raw.githubusercontent.com/OWASP/www-project-secure-headers/master/ci/headers_add.json · …/headers_remove.json · https://owasp.org/www-project-secure-headers/ | рекомендуемые значения (18.10.2026), список удаляемых заголовков, Apache-2.0 |
| https://hstspreload.org/ | требования preload (max-age ≥ 31536000, includeSubDomains, preload, редирект на тот же хост, HSTS на редиректах) |
| https://www.rfc-editor.org/rfc/rfc9989.txt · https://datatracker.ietf.org/doc/rfc9989/history/ | DMARCbis: май 2026, Proposed Standard, obsoletes 7489/9091, теги `np/psd/t`, удалены `pct/rf/ri`, Tree Walk ≤ 8 |
| https://www.rfc-editor.org/rfc/rfc9116.txt | security.txt: расположение, HTTPS, text/plain, `Contact`/`Expires` обязательны, < 1 года |
| https://www.rfc-editor.org/rfc/rfc7208 · rfc7505 · rfc8659 · rfc6376 · rfc8301 · rfc8484 · rfc6797 | SPF-лимиты, Null MX, CAA, DKIM, минимальная длина ключа, DoH, HSTS (общеизвестные нормы, не перепроверялись отдельно) |
| https://thehackernews.com/2025/01/cisa-adds-five-year-old-jquery-xss-flaw.html · https://securityaffairs.com/173388/ | CVE-2020-11023 в CISA KEV 23.01.2025, fix jQuery 3.5.0 |
| https://api.github.com/repos/RetireJS/retire.js/contents/repository | файлы `jsrepository-v4/v5/v6.json`, `npmrepository.json` |
| https://api.github.com/repos/enthec/webappanalyzer | GPL-3.0, активен (19.10.2026) |
| https://api.github.com/repos/nabla-c0d3/sslyze · https://api.github.com/repos/testssl/testssl.sh | AGPL-3.0 / GPL-2.0, оба активны (28.10.2026) |
| npm registry (`registry.npmjs.org/<pkg>`) | версии/даты/лицензии всех пакетов из §8; README dohdec (MPL-2.0) и mailauth |
| Context7 `/nodejs/undici` (Interceptors.md, Errors.md) | `interceptors.redirect/retry/dns`, таймауты Agent |
| https://quad9.net/doh-quad9-dns-servers/ · https://quad9.net/support/faq/ | Quad9 DoH endpoint, DNSSEC-валидация |
| https://developers.google.com/speed/public-dns/docs/doh/json | JSON DoH с полем `AD` |
| https://www.ihk-muenchen.de/ratgeber/recht/internetrecht/impressum/ · https://www.mth-partner.de/… · https://www.wbs.legal/… | § 5 DDG с 14.05.2024 вместо § 5 TMG; § 18 Abs. 2 MStV вместо § 55 Abs. 2 RStV |
| https://eur-lex.europa.eu/eli/reg/2024/3228/oj · https://www.ihk.de/schwaben/… | ODR-платформа закрыта 20.07.2025 |
| https://borncity.com/blog/2024/11/11/modern-solution/ · https://heise.de/-10663687 | ход дела Modern Solution (вторичные источники) |
| https://netzpolitik.org/2024/hacker-paragrafen-… · Lobbyregister (Stellungnahmen 08/2026) | реформа § 202a: Referentenentwurf 04.11.2024, не завершена |
| https://news.typo3.com/article/typo3-v12-lts-end-of-free-support · https://typo3.com/products-services/extended-support-elts/v124 | TYPO3 12.4 бесплатная поддержка до 30.04.2026; ELTS |
| https://hub.docker.com/r/wpscanteam/wpscan · https://techearl.com/wpscan-usage-man-page | WPScan free 25 запросов/день |
| https://www.wordfence.com/blog/2023/03/wordfence-intelligence-… | Wordfence Intelligence — бесплатный доступ (детали лицензии ⚠) |
| https://www.captaindns.com/en/tools/email-authentication/dkim-selector-discovery · https://www.suped.com/guides/dkim/… · https://administrator.de/forum/dkim-problem-6565711127.html · https://community.sophos.com/…/142251 · https://dmarcreport.com/blog/how-to-set-up-dkim-for-your-domain-in-ionos/ | списки DKIM-селекторов; IONOS `s1-ionos/s2-ionos`; Strato `strato-dkim-0002/0003` (форумы) |

## Открытые вопросы

1. **Уровень CSP в HDR-01**: Observatory даёт −25 (самый тяжёлый штраф), я предлагаю `info` для WordPress-реальности. Нужно решить: единый уровень или адаптивный (строже для не-CMS сайтов).
2. **TLS-01 critical vs warning** при «http отдаёт 200, https исправен» — нужна ли эскалация по наличию формы (браузерный модуль)?
3. **TLS-04: Node-клиент с SECLEVEL=0 или сырой ClientHello?** Node-вариант проверен и прост, но слеп к RC4-only и зависит от сборки OpenSSL; сырой — независим, но ~150 строк своего TLS-парсинга.
4. **DKIM-селекторы немецких хостеров** (All-Inkl, Hetzner, Strato, mailbox.org, CleverReach, rapidmail, Mailjet) — подтвердить по `DKIM-Signature` реальных писем / 10 сайтов заказчика до этапа 3.
5. **DoH по умолчанию выключен** — согласны ли все, что DNS-01 (AD-флаг) по умолчанию опирается на системный резолвер и часто даст «nicht prüfbar»?
6. **MAIL-* при Null MX / отсутствии MX** — принять матрицу §3.6?
7. **FILE-01: список путей** — список можно сократить или расширить; предел «≤ 30 путей» и неотключаемое усечение 4 KiB — принципиальны.
8. **ADMIN-01 формулировка про имена сотрудников** (Datenminimierung) — зона заказчика.
9. **KEV-правило = critical** на jQuery < 3.5.0 даёт много `critical` — оставить как в каталоге или ввести `warning` при отсутствии других признаков эксплуатируемости?
10. **Версия Playwright ↔ Node 26** — проверить `engines` перед фиксацией CI-матрицы; при проблемах основной остаётся Node 24.
11. **Лицензии данных**: Wordfence Community Edition (атрибуция), endoflife.date, mdn-http-observatory (берём только числа) — проверить до релиза.
12. **Статус реформы § 202a StGB** на 10/2026 — уточнить у заказчика/юриста; влияет на тон README и дисклеймера.
