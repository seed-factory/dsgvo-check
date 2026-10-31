# dsgvo-check — раунд 3, перекрёстная критика (Claude Fable 5.1, правовая линза)

Прочитано целиком: ТЗ, идея, каталог, четыре предложения раунда 2 (`claude-opus-5.5`, `claude-fable-5.1`, `codex-gpt-6.1-sol`, `codex-gpt-6.1-terra`), выжимка и критик раунда 1, red-team Terra; из полных отчётов — `legal-basis-map.md` §1–§5 и `regulatory-landscape-2026.md` §2–§6. Факты, на которые опираются оценки, перепроверены веб-поиском 30.10.2026 там, где это было возможно (список — в конце раздела 4); непроверенное помечено «⚠ проверить».

Линза: правовая корректность и формулировки (DSGVO, TDDDG, DDG, MStV, BFSG), актуальность правовой базы на октябрь 2026, места, где проверка/уровень/`crmCode`/текст подменяет юридический вывод, RDG, §§ 202a/202c StGB и § 824 BGB для самого инструмента, риск массовых Abmahnungen, минимизация персональных данных, третьи страны и DPF.

Сквозные обозначения: **Opus**, **Fable** (моё собственное предложение раунда 2 — критикую его так же, как остальные), **Sol**, **Terra**. Цитаты даны по номерам строк файлов `docs/consensus/round-2/*.md`.

---

## 1. Голосование по точкам решения

| ID | Точка решения | Мой выбор | Совпадает с | Уверенность | Обоснование |
|---|---|---|---|---|---|
| D01 | Объём релиза | Все 15 P0 **плюс CONSENT-05**; FILE-01 вне релиза (opt-in после); HTML в релизе | Opus, Fable, Terra, Sol (Sol: «A плюс CONSENT-05») | high | Без эффекта отказа CONSENT-04 показывает кнопку, но не выполняет исходное обещание идеи. FILE-01 — зона §§ 202a/202c StGB и GeschGehG при 0 находках из 80; не должен блокировать релиз. |
| D02 | Форматы отчёта | JSON (контракт), консоль, HTML без JS, JUnit + GitHub Job Summary; **PDF** командой `report --pdf` из того же HTML — в релиз, если укладывается в ≈1–2 PD (оценка Opus), иначе первый пост-релиз; SARIF/GitLab CQ — нет | Opus, Fable | medium | Именно PDF уходит клиентам и юристам: он должен нести дисклеймер, Messumgebung и Rechtsstand из нашего рендера, а не «печать браузера» без них. |
| D03 | Коды возврата | `2` только когда скан невозможен (недоступен, WAF/челлендж, глобальный таймаут, фатал, аргументы); ошибка одной проверки → `checks[].status=error`, exit по порогу, `--strict` → `2`; приоритет fatal(2) > 1 > 0; баннер не распознан → `info` + `inconclusive`, на код не влияет | Fable, Opus | high | `2` по ТЗ = «сканер сам упал»; DKIM-таймаут не должен красить CI этим кодом. Terra/Sol (2 при любой ошибке обязательной проверки) честны про покрытие, но ломают доверие к коду; компромисс — `--strict`. |
| D04 | Модель результата | Три оси: статус (`completed/partial/inconclusive/error/skipped/not_applicable`) ≠ severity ≠ confidence; без `pass/fail`; confidence **кэпит** уровень (Opus), а не отдельный `--min-confidence`; `SCAN-*` — отдельный массив `diagnostics`, не findings (Opus); дедупликация primary/linked (Fable) | Opus, Fable; по статусам — все четыре | high | Диагностика среды измерения не должна стоять в одном списке с находками о сайте и тем более нести `warning` (риск прочтения как дефекта сайта, см. ошибки Fable). Одна ось для пользователя — понятнее. |
| D05 | Архитектура | collectors → неизменяемый, уже отредактированный Snapshot → чистые checks → assess по ruleset-данным → gate → reporters; явный реестр + тест полноты; **`ProbeSpec`** (Opus) как единственный путь проверки к дополнительным запросам | Opus, Fable, Terra, Sol | high | `ProbeSpec` делает «активную» проверку архитектурно невозможной — ADR «Пассивный режим» выполняется кодом, а не дисциплиной; это прямая защита по §§ 202a/202c. |
| D06 | Структура репозитория | pnpm-workspace: один публикуемый пакет + приватные `fixture-server`/`test-utils`; отдельные репо: example, GitLab-component, **приватная** канарейка | Fable, Opus, Sol | high | Приватность канарейки — не удобство, а требование: отчёты о названных компаниях в публичных логах = Prangerwirkung. |
| D07 | Тулчейн | Node ≥ 24 (CI 24/26), TS 7, pnpm 11, Vitest 5, Biome 2.6 (+ oxlint-tsgolint), zod 4 → JSON Schema 2020-12 + Ajv, `playwright-core` 1.64.x пин, undici 8 | Fable, Opus | medium | Вне моей линзы; принимаю консенсус. Единственное правовое требование — лицензионный allowlist зависимостей в CI. |
| D08 | Фазы согласия | A, A′, B, C в свежих persistent-профилях **+ M** (мобильный первый уровень, только стартовая, без кликов) в релизе; B/C — стартовая + 2 страницы | Opus, Sol | medium | DSK OH Rn. 124 прямо упоминает mobile; «блокирует ли баннер» зависит от viewport, и вердикт CONSENT-04 только по desktop может быть неверен. Цена — одна навигация. Fable (мобильный после релиза) здесь проигрывает. |
| D09 | Обход сайта | 6 страниц (старт, Impressum, Datenschutzerklärung, Kontakt, 2 по ключевым словам/sitemap); robots для дополнительных страниц; `--timeout 8m`; scope = финальный хост + www/apex; LEGAL-01 строго «auf n von m geprüften Seiten» **и один переход через «Kontakt»/«Rechtliches»** до вывода «не найдено» | Fable, Opus, Sol | high | BGH I ZR 228/03: Impressum, достижимый за два клика (через «Kontakt»), достаточен — без этого перехода `critical` LEGAL-01 может противоречить BGH (см. раздел 4.11). |
| D10 | User-Agent и анти-бот | HTTP-пробы — полный UA со ссылкой на репозиторий (ТЗ буквально). Браузер — реальный Chrome UA + нейтральный токен без URL, прошедший CI-тест против `isbot` и регулярок CMP (Opus), **плюс** идентифицирующий заголовок `X-<Name>: <ver> (+<repo>)` на всех запросах (профиль `visitor` Fable), `From:` по `--contact`; детектор `SCAN-BOTMODE` обязателен; умолчание — решение заказчика [Б] | Opus, Fable | medium | Правовая «честность» (BGH Screen Scraping I ZR 224/12, virtuelles Hausrecht) требует идентифицируемости сканера, а не конкретной строки UA. Ложные CONSENT-01/02/03 на RCB-сайтах — больший правовой риск (§ 824 BGB), чем заголовок вместо UA. Sol/Terra настаивают на букве ТЗ — последовательно, но дорого для P0. |
| D11 | Гео | Гео-сигналы CMP → `SCAN-GEO` в `diagnostics`, затронутые проверки `inconclusive`; `--proxy`, `--assume-region`, `--require-eu-egress`; CONSENT-03 `critical` только без CMP-скрипта или при подтверждённом egress из **EWR**; в терминах и данных — EWR, не «EU» | Opus, Fable, Sol | high | DSGVO действует в EWR (NO/IS/LI); раннер в Осло правомерен, но терминология «EU egress» неточна. `warning` за гео-сигнал (Fable) роняет `--fail-on warning` на недостоверном измерении — прав Opus. |
| D12 | CMP | 7 собственных адаптеров (detect/state/firstLayer/reject/accept/verify); `high` = ≥ 2 независимых признака; `@duckduckgo/autoconsent` — пин, без модификаций, только детект вне семёрки/классификатор кнопок/справочник, инжект после окна фазы A (Opus); эвристика даёт только `info` «Banner nicht erkannt»; селекторы пишем сами, файлы правил не копируем | Opus, Fable, Sol, Terra | high | Вердикт только от адаптеров — буква ТЗ. Массовое копирование правил autoconsent — файловый copyleft MPL-2.0 и возможное извлечение из базы (§ 87a UrhG), см. 4.12. |
| D13 | Критерий CONSENT-04 | Таблица Opus 4.4 с классами Fable: CMP `high` + блокирует + нет reject на первом уровне → `critical`; «×»/«Verbergen»/«Schließen» = accept → `critical` (OLG Köln 6 U 80/23); reject есть, но не actionable → `warning`; **неблокирующий без reject → `info`** (DSK Rn. 124–125; `warning` в профиле `de-strict`); ссылка вместо кнопки → `warning` (EDPB TF Type C); Pay-or-Okay → `info` + ручная проверка; «равноценность» — только метрики в evidence | Opus (по `critical` — Fable) | medium | Для немецкого инструмента первичная линия — DSK: «nicht generell erforderlich» при неблокирующем баннере. EDPB-большинство строже — отсюда профиль. `warning` по умолчанию (Fable) кодирует спорную позицию как дефект. |
| D14 | Каталог сервисов | Свой Apache-2.0 каталог из экспорта аудитов заказчика + первичка вендоров (чек-лист § 87a UrhG в PR); `third-party-web` (MIT) fallback; Open Cookie Database (Apache-2.0); AdGuard `cname-trackers` (MIT); EasyPrivacy только opt-in кэш; NC — никогда; поля `provider`/`parent`/`dpfEntity` вместо `company/hqCountry` | Opus, Fable, Sol, Terra | high | Пермиссивных источников с нужной гранулярностью нет; NC закрыт для платных аудитов. Модель «получателя» надо исправить (4.2). |
| D15 | PRIV-01/02 | Извлекать Datenschutzerklärung в фазе B (баннер закрыт): видимый + скрытый текст, фреймы, ≤ 3 связанных документа; PDF → `inconclusive` в MVP (pdfjs — P1); уровни совпадения `named > company > domain > category`; отрицания и исторический контекст; `not-named` → `warning`, `category-only` → `info`, неполное извлечение → `inconclusive`; PRIV-02 — каталог утверждений с предикатом фазы, цитата ≤ 200 знаков, `critical` только при противоречии в фазе, о которой говорит утверждение | Opus, Fable, Sol | high | Art. 13 Abs. 1 lit. e допускает «Kategorien von Empfängern» → PRIV-01 никогда не `critical`. PRIV-02 с `crmCode` «MISLEADING» — самая близкая к § 5 UWG находка; нужна двухфазная доказательность. |
| D16 | Передача за пределы ЕС | Атрибут, не проверка; источник — каталог (`provider` = Vertragspartner для EWR-Kunden, `parent`, `dpfEntity {listed, checkedAt}`) + версионированный `data/legal/adequacy.json` (EWR + Angemessenheitsbeschlüsse с датами и сроками; UK — до 27.12.2031); GeoIP (DB-IP, CC BY) только `--network-attribution`; на уровень не влияет; в текстах нет слов «Empfänger»/«Übermittlung» | Opus, Fable, Sol, Terra | high | Все четыре согласны в принципе; ошибки — в деталях модели (4.2): «Google LLC (US)» как Empfänger для GA неверен (Vertragspartner в EWR — Google Ireland Ltd.). |
| D17 | VULN-01/02 | WPVulnerability (CC0) + retire.js (Apache-2.0) + OSV/GHSA с фильтром источников + CISA KEV (CC0); Wordfence только по ключу после чтения Terms ⚠; `critical` = версия `exact` ∧ (KEV ∨ pre-auth класс RCE/SQLi/upload/auth-bypass из каталога); **CVSS `AV:N/PR:N` сам по себе недостаточен** (Sol); `range` −1 ступень; `unknown` → `info`; офлайн/источник недоступен → `inconclusive` | Opus, Sol (Fable без оговорки Sol) | medium | Текст «T1_EXPLOITABLE_CVE» уже на грани утверждения факта о чужой системе (§ 824 BGB); уровень должен опираться на проверяемые критерии, не на вектор CVSS. |
| D18 | «Активные» запросы | Три класса O/T/E (Opus/Fable): T по умолчанию (DNS incl. DKIM ≤ 25 фиксированных селекторов, 2 TLS-handshake, `http://`-цепочки, `security.txt`, `readme.txt` cap 20); E (`FILE-01`, `ADMIN-01`) — `--exposure-probes` opt-in, ≤ 15 путей, список утверждает заказчик после правовой оценки, 4 KiB неотключаемо, тело не хранится, только сигнатура; non-features зафиксированы в ADR | Opus, Fable | high | DNS-запросы — публичные записи, не § 202a. FILE-01 после Modern Solution (BVerfG Nichtannahme 09/2025 подтверждена heise/borncity) — только opt-in; плюс GeschGehG § 4 при чтении секретов (4.7). |
| D19 | Severity security-проверок | T3 → максимум `warning`: HSTS / anti-framing / небезопасный Referrer-Policy → `warning`, CSP / nosniff / Permissions-Policy → `info`; MAIL-01 нет/`p=none` → `warning`; MAIL-02 по матрице с DMARC (BSI TR-03182); MAIL-03 `info` (`warning` только для документированных селекторов провайдера); TLS-04 `warning` (TR-02102-2 2026-01); TLS-02 invalid → `critical`; TLS-01 — градация Opus (`critical` только http-only или форма на http-странице, § 19 Abs. 4 TDDDG) | Fable, Opus | medium | Правовой опоры у заголовков нет («Stand der Technik»), потому не выше `warning`. TLS-01 `critical` за любой http-200 при исправном https (Fable) — overclaim для статичной страницы. |
| D20 | Минимизация evidence | Значения cookies/Storage/TC-String **не хранятся вообще** — имя/домен/путь/флаги/длина, без хешей (при необходимости корреляции — HMAC с одноразовым ключом, Sol); query по allowlist; POST-тела/HAR/тела FILE-01 — нет; скриншот только области баннера (по умолчанию вкл., решение заказчика); дополнительно: маскировать `mailto:` в DMARC/`security.txt`, ADMIN-01 — только счётчик, `--contact` не попадает в отчёт; retention CI-артефактов ≤ 14 дней | Opus, Sol, Terra | high | Хеш идентификатора — псевдонимизация, не анонимизация (логика *Breyer*, *IAB Europe*); дисклеймер «Werte werden nicht gespeichert» должен быть буквально правдой. Email-адреса в DNS/`security.txt` — персональные данные, которые никто кроме Sol не редактирует (4.3). |
| D21 | JSON-схема | zod → JSON Schema 2020-12, независимый semver; fingerprint v1 = `sha256(JCS{v, checkId, scope, variantGroup, subject})`; suppressions с обязательными `reason`+`expires`; baseline с учётом роста уровня (Opus); `crmCode: string \| null` **только в JSON** (не в HTML/PDF/консоли); `legalContext`, `ruleset.rechtsstand`, `diagnostics[]` | Opus, Fable | high | ТЗ требует `crmCode` в JSON — выполняем; но имена кодов («MISLEADING», «EXPLOITABLE», «BROKEN») — правовые оценки и не должны рендериться людям (4.1). |
| D22 | Тексты | Статические тексты по `checkId.variant` в ICU MF1 `de`/`en`; L0-тест стоп-слов для **de и en**; `draft: true` блокирует релиз (Terra); дисклеймер с условными абзацами (Opus), без флага отключения; `legalNote` — общий текст по `checkId` со статусом источника (`authority-consensus \| court-first-instance \| court-appellate \| contested \| technical`) и `reviewedAt`; lint «ни одной пользовательской строки вне `data/`» | Opus, Fable, Terra | high | ТЗ: «отчёт я доделаю, чтобы всё было в рамках права ЕС» — значит архитектурно код не должен уметь выдать текст, которого нет в данных заказчика. EN-версия попадёт к иностранным юристам — стоп-лист только для `de` (Fable, Opus) — дыра. |
| D23 | Тестирование | L0–L4; L1 пары (+ `inconclusive`) на каждый ID, записанные из L2; L2 офлайн через egress-прокси/тест-CA/dns2 в `--network none`; CMP-симуляторы своим кодом + CMP-лаборатория на лицензированных инсталляциях; приватная канарейка с письменным согласием владельцев; критерии приёмки: 0 ложных `critical` CONSENT-03/04 на корпусе и precision `critical` ≥ 0,9 (Opus) с оговоркой Sol о статистической силе 10 сайтов | Opus, Fable, Sol, Terra | high | Лаборатория закрывает пробел «10 сайтов к этапу 3». Согласие владельцев — не формальность: ночные сканы чужих сайтов без мандата — Interessenabwägung Art. 6 Abs. 1 lit. f при каждом прогоне. |
| D24 | Дистрибуция | Composite Action + `docker run` по digest с hardening; GitLab `include:remote` + `integrity` как контракт ТЗ, CI/CD-component вторым шагом; свой `node:24-slim` + Chrome for Testing, non-root; npm с явным `install`; Docker-action отвергнута | Fable, Opus, Sol | high | Docker-action = root = без sandbox при посещении недоверенных сайтов; Terra здесь в меньшинстве и неправ по риску. |
| D25 | Изоляция и HTML | Egress-прокси как SSRF-граница для браузера и undici; sandbox: `--sandbox auto` с `SCAN-SANDBOX-OFF` (diagnostic) и `--require-sandbox` для аудитов; HTML без JS, CSP `default-src 'none'`, URL текстом, L2-тест «ноль сети»; job без секретов/OIDC/docker.sock | Fable, Opus | medium | Fail-closed (Sol/Terra) безопаснее, но ломает GitLab shared runners; компромисс — громкий diagnostic и строгий режим для доказательных прогонов. |
| D26 | План 0–4 | Структура Opus (спайки С1–С6, release manifest, два трека) с **правовыми воротами**: подпись ruleset/`crmCode`-мэппинга — конец этапа 0; Impressum/Datenschutzerklärung для домена проекта и демо-сайта — этап 2; тексты + стоп-слова + лицензионный аудит — выход из этапа 3/4; оценка 100–135 PD (Opus/Terra), не 65–90 (Sol/Fable) | Opus, Terra | medium | Fable и Sol недооценивают стоимость PRIV-конвейера, 7 CMP, лаборатории и юридических итераций; правовые ворота ни у кого не стоят в плане явно. |
| D27 | Название | Оставить `dsgvo-check` рабочим, но до этапа 1 провести clearance (DPMA/EUIPO, домены, npm, GitHub) для 2–3 кандидатов и CI-бот-тест токена; переименовать, если clearance или бот-тест провалены либо имя входит в браузерный UA | Opus (частично), Fable | low | «DSGVO» описательно и слабо охраноспособно, но коллизия с чужим GitHub-репо и `check\b` в isbot — реальные издержки. Решение продуктовое; правовой минимум — clearance. |

---

## 2. Ошибки в предложениях

Обозначения: **[ошибка]** — фактическая/правовая/техническая неточность; **[спорно]** — защитимый выбор, с которым я не согласен; **[противоречие]** — внутренняя несогласованность.

### 2.1 Claude Opus 5.5

1. **[ошибка — правовая модель получателя]** Строка 465: `"recipient": { "company": "Google LLC", "hqCountry": "US", "dpf": { "listed": true } }`; строка 50: «атрибут `recipient` из нашего каталога (компания, страна головной организации, DPF-статус)». Для Google Analytics/Tag Manager Vertragspartner клиентов из EWR — Google Ireland Limited (IE); Google LLC — Konzernmutter и DPF-зертифицированный US-импортёр при onward transfer. Называть в отчёте «Empfänger: Google LLC (US)» — утверждение о договорной роли, которое сканер не видит и которое может быть ложным → § 824 BGB. Нужны раздельные поля `provider` (laut Katalog, Vertragspartner EWR), `parent`, `dpfEntity`; текст — «Anbieter laut Dienstekatalog: …», не «Empfänger». Та же ошибка у Fable (ниже).
2. **[ошибка — демо-сайт проекта]** Строки 806–809: публичная страница example-репо на GitHub Pages с `fonts.googleapis.com` и «Job 2 сканирует ту же страницу на GitHub Pages (настоящий HTTPS и сторонние запросы)». Публичная страница проекта, обслуживаемого в коммерческом контексте заказчика, сама раскрывает IP посетителей Google без согласия и без Datenschutzerklärung/Impressum — проект делает ровно то, что инструмент ловит (EMBED-01, LEGAL-01). Витрина должна либо грузить «шрифты» с собственного поддомена-имитатора, либо иметь Impressum (§ 5 DDG), Datenschutzerklärung и Zwei-Klick. См. 4.5.
3. **[спорно — `reject-as-link` → `info`]** Строка 375 со ссылкой на EDPB TF Type C. Отчёт Taskforce по Type C (ссылка вместо кнопки, без визуальной поддержки) констатирует недействительность согласия у большинства органов — это ближе к `warning`, чем к `info`. Не ошибка, но ссылка на Type C аргументирует против выбранного уровня.
4. **[спорно — «хосты CMP — не находка»]** Строка 588. Загрузка CMP-скрипта с CDN третьей страны была предметом VG Wiesbaden 6 L 738/21.WI (отменено VGH Kassel по иным мотивам ⚠). Инвентарный `info` «Consent-Provider-Ressource von [Host]» честнее, чем полное молчание; Fable даёт `info`.
5. **[неточность — RDG как основание]** Строка 30: правовую оценку не делаем «ТЗ, RDG (логика BGH Smartlaw), § 824 BGB». BGH *Smartlaw* I ZR 113/20 как раз признал генератор **не** Rechtsdienstleistung; RDG не запрещает статический текст — запрещает ТЗ и ограничивает § 824. Ссылка на RDG уместна только для сервиса заказчика (продажа аудитов), не для инструмента. Мелочь, но в ADR-001 формулировку стоит поправить.
6. **[ошибка — стоп-слова только для `de`]** Строка 686: «стоп-слова для `de`». EN-тексты рендерятся по `--lang en` и уйдут к иностранным клиентам/юристам; «violation», «illegal», «non-compliant», «tracker», «vulnerable», «data leak», «transfer to the US» — те же риски. L0-тест нужен для обоих языков.
7. **[спорно — LEGAL-01 `critical` без хопа через «Kontakt»]** Строка 600: «`critical`: ни на одной проверенной странице нет ссылки и фолбэк не нашёл документ». BGH I ZR 228/03: достижимость Impressum за два клика через «Kontakt» достаточна. Фолбэк `/impressum` частично спасает, но переход по «Kontakt»/«Rechtliches» обязателен до `critical`. См. 4.11.
8. **[нюанс — копирование селекторов autoconsent]** Строка 359: «MPL-2.0 разрешает брать селекторы; разметку «первый уровень» храним в своих файлах». Отдельные селекторы — факты; систематический перенос содержимого файлов правил — создание производного произведения (MPL file-level copyleft) и извлечение существенной части базы правил (§ 87a UrhG). Нужен принцип «пишем сами, autoconsent — референс», как у Fable.
9. **[противоречие — Diagnostic vs `SCAN-SANDBOX-OFF`/`SCAN-PRIVATE-REQUEST-BLOCKED`]** Диагностика объявлена «никогда не гейтит» (строка 414), но `--require-sandbox` даёт `2` (строка 550) — это нормально как опция, однако таблица 5.7 должна явно говорить, что `2` здесь — решение CLI, а не «уровень» диагностики. Уточнение, не ошибка.

Что у Opus верно и важно сохранить: разделение `Diagnostic`/`Finding`, `ProbeSpec`, кэп уровня по confidence, фаза M, условные абзацы дисклеймера, проверка имени против бот-регулярок **и** товарных знаков (К2), исправление по CVE-2025-29927 (fixed in 15.2.3 — подтверждаю).

### 2.2 Claude Fable 5.1 (моё предложение раунда 2)

1. **[ошибка — модель получателя и DPF в каждой находке]** Строка 36: «Empfänger laut Dienstekatalog: Google LLC (US); Angemessenheitsstatus laut adequacy.json Stand …»; строка 267: `"thirdCountrySignal": { "recipient": "Google LLC", "recipientCountry": "US", "adequacy": "DPF (Stand 2026-10-30, C-703/25 P anhängig)" }`. Три проблемы: (а) «Empfänger: Google LLC» для GA неверен (см. Opus №1); (б) «Angemessenheitsstatus: DPF» смешивает страновое решение об адекватности с DPF, которое покрывает только зертифицированные организации — корректно: «Organisation „Google LLC“ in der DPF-Liste geführt (Stand …)»; (в) строка «C-703/25 P anhängig» внутри каждой находки — правовой комментарий, которому место в `legalContext`, а не в evidence. Исправление — в D16.
2. **[ошибка/противоречие — `SCAN-*` как находки с уровнем `warning`]** Строки 387–397: `SCAN-BOTMODE` / `SCAN-GEO` / `SCAN-THROTTLED` / `SCAN-BLOCKED` (на подстранице) — `warning`. При `--fail-on warning` правило «порог учитывает primary-находки с confidence ≥ high» (строка 286) уронит CI из-за свойства **среды измерения**, а не сайта; в HTML они стоят в списке находок. Строка 324 пишет «порог не роняют» только про CONSENT-*, не про сами SCAN-*. Прав Opus: отдельный массив `diagnostics`, без severity.
3. **[спорно — TLS-01 `http-served` → `critical` без градации]** Строка 355. legal-basis-map §2.1 сам относит обязанность Transportverschlüsselung для чисто статичной страницы к спорным; Opus даёт `critical` только при http-only/невалидном https или форме на http-странице (§ 19 Abs. 4 TDDDG). Градация Opus точнее.
4. **[спорно — неблокирующий баннер без reject → `warning`]** Строка 219 и решение 14/№10. DSK Rn. 124–125 — «nicht generell erforderlich»; `warning` по умолчанию кодирует спорную позицию как дефект. Лучше `info` + профиль `de-strict` (D13).
5. **[ошибка — хеш значения cookie]** Строка 282: `valueSha256` (первые 12 hex). Это производная идентификатора; Sol и Terra правы, что хеш ≠ анонимизация. Для синтетической сессии сканера риск мал, но дисклеймер «Werte werden nicht gespeichert» должен быть буквально верен — хранить только длину, корреляцию делать HMAC с одноразовым ключом (Sol).
6. **[ошибка — демо-сайт на GitHub Pages грузит реальные Google Fonts]** Строка 488 (б). То же, что Opus №2.
7. **[ошибка — стоп-слова только для `de`]** Строка 446. То же, что Opus №6.
8. **[неточность — § 303b StGB как основание rate limit]** Строка 506: «§ 303b (rate limit)». § 303b Abs. 1 Nr. 2 требует Absicht, einem anderen Nachteil zuzufügen; для добросовестного сканера норма практически неприменима. Правильная опора для rate limit — гражданская: § 823 Abs. 1 BGB (eingerichteter und ausgeübter Gewerbebetrieb) и критерий BGH Screen Scraping «не мешать работе сайта».
9. **[спорно — `implied-consent` под CONSENT-03]** Строка 151: согласие, записанное без клика (Cookiebot `implied`), оформлено как класс CONSENT-03 («баннера нет»). Баннер есть, но согласие недействительно (*Planet49*) — это ближе к CONSENT-04 (`T1_CONSENT_BANNER_BROKEN` у обоих). Таксономию решает заказчик, но текущая привязка искажает смысл ID.
10. **[спорно — PRIV-02 «текст устарел» по reCAPTCHA]** Строка 344: «с 02.04.2026 Google — Auftragsverarbeiter; текст устарел → info». Смена роли подтверждена (Google FAQ, heise, 2b-advice), но является ли Google для конкретного оператора Auftragsverarbeiter, зависит от принятия Cloud-условий — вторичные источники расходятся. Допустимо только `info` с формулировкой «Rollenänderung zum 02.04.2026 — Formulierung prüfen», без слова «veraltet/falsch».
11. **[ошибка — незакрытые персональные данные в evidence]** Ни одно правило редактирования (строка 450) не покрывает `rua=mailto:`/`ruf=mailto:` в DMARC-записях, `Contact: mailto:` в `security.txt`, slug/имена из `/?author=1`. См. 4.3.
12. **[неточность — лицензия текстов заказчика]** Решение 14/№19: «Apache-2.0 для всего репо». Apache-2.0 — лицензия на ПО; немецкие тексты, `legal/*.md` и дисклеймер логичнее под CC BY 4.0 (или оставить за заказчиком с явным разрешением на распространение в составе репо). Иначе любая третья сторона вправе переиспользовать юридические тексты агентства.
13. **[неточность — «DE/EU egress», `--require-eu-egress`]** Строка 186. Правовая граница — EWR; Sol это отмечает правильно.

Что у Fable верно и важно сохранить: ruleset как данные с маппингом T0/T1/T3 → уровни, тест полноты реестра со стоп-словами, egress-прокси как единый механизм, детальный список сценариев CMP-симуляторов (а)–(з), `legalContext` с `verifiedAt/reviewBy`, non-features, `report.requestsIssued` как прозрачность для владельца сайта.

### 2.3 Codex GPT-6.1-Sol

1. **[спорно — `2` при исключении в любой включённой проверке, включая P1/P2]** Строка 368. Семантически честно, но превращает любой флейк в «сканер упал»; с точки зрения доверия к коду и ТЗ («сканер сам упал») — хуже компромисса `--strict`. Sol сам признаёт, что это «явное уточнение ТЗ» (строка 381) — тогда это блокер для заказчика, а не умолчание.
2. **[спорно — CONSENT-04 `warning` даже для блокирующего баннера]** Строка 400. Консервативно, но при каталоге «CONSENT-04 — P0, T1» и устоявшейся линии (DSK + OLG Köln + VG Hannover) `critical` для класса `blocking-no-first-level-reject` при CMP `high` обоснован. Как минимум — вынести решение заказчику явно.
3. **[неточность — месяц RFC 9989]** Строка 427: «опубликованному в мае 2026». Критик раунда 1 подтвердил существование RFC 9989 (obsoletes 7489/9091), но не месяц — оставить ⚠. Замечание Sol, что остановка Tree Walk на eTLD+1 не является полной реализацией (RFC использует PSD-теги, а не PSL), — верное и важное.
4. **[пробел — нет стоп-листа и модели `legalNote`]** Раздел 8 ограничивается «фактические тексты и рекомендации» и черновиком дисклеймера; ни списка запрещённых формулировок, ни статуса источников, ни механизма `draft` до вычитки. При линзе «формулировки» это существенный пробел — хотя сам дисклеймер Sol (строка 522) хорош.
5. **[пробел — третьи страны без данных]** Строка 507: «Автоматический live lookup DPF и полный список adequacy decisions в MVP не нужны». Но Sol же показывает «сведения об операторах» — без версионированных `adequacy`/DPF-данных любой `hqCountry: US` в отчёте читается как «Drittland» без контекста. Нужен хотя бы статический `adequacy.json` с датой.
6. **[неточность — URL § 25]** Строка 29 ссылается на `gesetze-im-internet.de/ttdsg/__25.html` — идентификатор старого закона; на 10/2026 проверить актуальный путь TDDDG ⚠. Мелочь, но в `legal/*.md` ссылки должны быть живыми.
7. **[спорно — отказ от fallback `--no-sandbox`]** Строка 641. Безопаснее, но делает GitLab shared runners нерабочими; решение заказчика (D25).

Что у Sol верно и важно сохранить: EWR vs EU; «хеш — не обезличивание», HMAC; состояния cookie `attempted/accepted/rejected/sent`; «CVSS AV:N/PR:N недостаточен»; маркировка Omnibus как мандата Совета (ST 14756/26 от 22.10.2026), а не действующего права; «статические шаблоны сами по себе не решают RDG»; трезвая оценка статистики 10 сайтов.

### 2.4 Codex GPT-6.1-Terra

1. **[спорно/риск — Docker-action для GitHub]** Строка 257. Docker-action выполняется от root → Chromium без sandbox при посещении недоверенных сайтов; три других предложения и engineering-ресёрч отвергают это обоснованно.
2. **[спорно — `2` при ошибке любой обязательной проверки]** Строка 156. См. Sol №1.
3. **[пробел — дисклеймер неполон]** Строка 240: «Dieser Bericht enthält technische Beobachtungen … stellt keine Rechtsberatung … dar». Нет: «Fehlen einer Beobachtung ≠ Beanstandungsfreiheit», Prüfzeitpunkt (UTC), Messumgebung/egress/UA, версии баз, что не сохраняется, Apache-2.0 §§ 7–8. Черновик legal-basis-map §3.3 полнее.
4. **[пробел — нет модели третьих стран]** Строки 12, 223: GeoIP опционален, «страна не повышает severity» — верно, но ни `provider`, ни DPF/adequacy-данных, ни формулировок; PRIV-01 при этом должен как-то называть сервис и его оператора.
5. **[пробел — правовая рамка инструмента]** Раздел 11 не упоминает RDG, §§ 202a/202c StGB, § 824 BGB, GeschGehG; все четыре слоя защиты есть в дизайне (минимизация, opt-in FILE/ADMIN, фактические формулировки), но без правовой привязки ADR «Пассивный режим» не аргументируем перед юристом заказчика.
6. **[неточность — «изменённые MPL-файлы»]** Строка 221: «с сохранением лицензий и исходников изменённых MPL-файлов». Верно по MPL-2.0, но противоречит остальным (и собственному) тезису «autoconsent без модификации»; если файлы меняются — это уже форк с file-level copyleft и обязанностью публикации изменений. Лучше не менять.
7. **[спорно — `retention-days: 7`]** Строка 282. Коротко и privacy-friendly; но аудит заказчика обычно длится дольше недели — 14 дней (Opus) реалистичнее при той же логике минимизации.

Что у Terra верно и важно сохранить: «флаг не заменяет разрешения владельца» (строка 11); «чистая фикстура = отсутствие сигнала, не юридическая чистота»; «хеш не анонимизация»; `--require-complete`; приоритет source-of-truth «запрос → ТЗ → каталог → идея → исследования»; «неполное покрытие не прятать».

---

## 3. Лучшие идеи для пересадки

**Из Opus**
1. `Diagnostic` как отдельная сущность: никогда не гейтит, не идёт в CRM, с `affects[]` (D04/D11).
2. `ProbeSpec` — декларативные дополнительные запросы с валидатором класса пассивности (`technical`/`exposure`), `maxBytes` неотключаем (D05/D18).
3. Кэп уровня по confidence (`medium` → ≤ `warning`, `low` → ≤ `info`) вместо второй оси гейтинга.
4. Репликация «до клика» в фазе B как второе независимое измерение против A/B-тестов и ротации.
5. Фаза M (мобильный первый уровень) и измеримое `blocking: {overlay, scrollLock, inert, coveredRatio}` в evidence.
6. Условные абзацы дисклеймера («Bildschirmfotos … enthalten» только при включённых скриншотах) — дисклеймер всегда правдив.
7. Выбор имени через CI-тест против `isbot`/регулярок CMP **и** проверку товарного знака (DPMA/EUIPO).

**Из Fable**
1. Уровни только в `ruleset/de-2026.yaml` по `(checkId, class)` + явный маппинг тиров `crmCode` T0 → `critical`, T1 → «critical-способный», T3 → ≤ `warning`.
2. Тест полноты реестра (L0): фикстуры, тексты de/en, ruleset для каждого `class`, `crmCode` или явный `null`, `legalNote`, стоп-слова.
3. `legalContext`/`legal/<ID>.de.md` с `status`, `reviewedBy/At`, `reviewBy`; CI падает при просрочке для `proposed/guidance`; data-релизы без кода.
4. Единый egress-прокси для браузера и undici: SSRF, лимиты, счётчик запросов, карта хостов в тестах.
5. Полный список сценариев CMP-симуляторов (а)–(з), включая бот-режим, гео и `close-equals-accept`.
6. Раздел «Messumgebung» и `scan.requestsIssued` («Anzahl Anfragen») — прозрачность для владельца сайта и защита по § 824 BGB.
7. Список non-features (без словарей, без реконструкции `.git`, без генератора Abmahnung, без рейтингов) как часть ADR.

**Из Sol**
1. EWR, а не «EU», как правовая граница; Kapitel V DSGVO как рамка для третьих стран.
2. «Хеш значения cookie — не анонимизация»; HMAC с непубликуемым одноразовым ключом для корреляции.
3. Состояния cookie `attempted/accepted/rejected/sent` и запрет сводить попытку, ответ и SW-ответ к одному факту «данные отправлены».
4. «CVSS `AV:N/PR:N` сам по себе недостаточен» для `critical` в VULN.
5. Omnibus — переговорный мандат Совета, не действующее освобождение; preview-профиль в MVP не нужен.
6. Честная статистика: 10 сайтов не доказывают precision 99 %; критерии приёмки формулировать как «нет известных ложных `critical`».
7. RFC 9989 Tree Walk без упрощения «стоп на eTLD+1».

**Из Terra**
1. «Флаг пользователя не создаёт разрешения владельца сайта» — обязательная фраза README/ADR для FILE/ADMIN.
2. `--require-complete` как явный строгий режим для аудитов.
3. Приоритет источников: «явное решение → ТЗ → каталог → идея → исследования».
4. Для каждого ID помимо пары — фикстуры `inconclusive`, `error` и контрпримеры «соседнего ложного finding».
5. Короткий retention CI-артефактов и «секреты не печатаются, не хешируются для публичного отчёта и не используются».

---

## 4. Глубокий разбор по правовой линзе

### 4.1 `crmCode` сам по себе — правовой вывод

Каталог заказчика кодирует выводы в именах: `T1_MISLEADING_CLAIM` (≈ Irreführung, § 5 UWG), `T1_EXPLOITABLE_CVE` (утверждение об эксплуатируемости чужой системы), `T1_CONSENT_BANNER_BROKEN`, `T1_UNENCRYPTED`, `T1_TRACKER_BEFORE_CONSENT` («Tracker» — из стоп-листа). ТЗ требует `crmCode` в JSON — это выполняем. Но все четыре предложения молчат о том, что `crmCode` **не должен рендериться** в консоли, HTML, PDF и Job Summary, и что в схеме он должен быть описан как «interne Taxonomie des Auftraggebers, keine rechtliche Einordnung». Иначе стоп-слова в `de.yaml` бессмысленны: тот же отчёт несёт «MISLEADING» и «EXPLOITABLE» крупными буквами. Предложение: `crmCode` только в `findings[]` JSON, `description` в схеме, L0-тест «HTML/консоль не содержат строк `T[0-9]_`».

### 4.2 «Получатель», DPF и адекватность: модель данных у всех неточна

- **Vertragspartner vs Konzernmutter.** Для Google Analytics, Tag Manager, Maps Platform, Fonts (где договора вообще нет) «Empfänger» в смысле Art. 13 Abs. 1 lit. e — не «Google LLC (US)». Для GA Vertragspartner EWR-клиентов — Google Ireland Limited; передача в США — onward transfer к Google LLC как DPF-зертифицированному импортёру. Отчёт, называющий «Empfänger: Google LLC (US)» (Fable стр. 36/267, Opus стр. 465), утверждает факт о договорной роли, который сканер не наблюдает. Модель: `provider {name, country}` (laut Katalog, для EWR-Kunden), `parent {name, country}`, `dpfEntity {name, listed, checkedAt, source}`, `processingLocation: "nicht feststellbar"`. Формулировка: «Anbieter laut Dienstekatalog v[X]: Google Ireland Ltd. (IE), Konzernmutter Google LLC (US); „Google LLC“ am [Datum] in der DPF-Liste geführt. Ort der Verarbeitung und Übermittlungsinstrument wurden nicht geprüft.»
- **DPF ≠ Angemessenheitsstatus страны.** DPF — Durchführungsbeschluss (EU) 2023/1795 для зертифицированных организаций; `adequacy.json` должен различать `country-adequacy` (CH, UK, JP, KR, IL, …) и `organisation-list` (DPF). UK: решения продлены 19.12.2025 до **27.12.2031** (подтверждено несколькими источниками) — ни одно предложение не содержит даты, а Fable предлагает «adequacy.json» без структуры сроков.
- **DPF-статус на 30.10.2026:** 2023/1795 в силе; T-553/23 отклонён 03.09.2025; апелляция **C-703/25 P** подана 31.10.2025 (ABl. C/2025/6610 от 22.12.2025), Microsoft вступил на стороне Комиссии 06/2026, решения/Schlussanträge не найдены — **pending**; письмо EDPB 31.07.2026 после *Trump v. Slaughter* — по вторичным источникам. Всё это — содержимое `legalContext`, не каждой находки.
- **EWR.** Терминология «EU egress»/«не-ЕС» (Fable) → «EWR».

### 4.3 Персональные данные в evidence, которые никто не редактирует

Все четыре редактируют cookies, токены, тела. Не покрыто:
- `rua=mailto:`/`ruf=mailto:` в DMARC (MAIL-01) и `Contact: mailto:` в `security.txt` (SEC-01) — адреса конкретных людей; в evidence оставлять домен или маску локальной части. Только Sol упоминает «DNS TXT с адресами минимизируем».
- `/?author=1` и `/wp-json/wp/v2/users` (ADMIN-01) — имена/slug сотрудников; счётчик вместо списка есть у Fable/Opus, но сам запрос — обработка персональных данных третьих лиц (Art. 6 Abs. 1 lit. f) и должен быть обоснован в README.
- Impressum-текст (LEGAL-02, PRIV через Impressum) — имена, адреса, телефоны Einzelunternehmer; выдержки ≤ 200 знаков только из нормативных ссылок, не из блока контактов.
- `X509 subject`/`O=` с личными именами (редко), `--contact <email>` оператора — не должен попадать в отчёт/артефакты.
- Скриншот баннера: `locator.screenshot()` области — хорошо; полностраничный — нет (фото команды, отзывы с именами).

### 4.4 Сканер как обработка персональных данных: Einzelunternehmer

Большинство немецких KMU из корпуса — Einzelunternehmen/Freiberufler: `mustermann-sanitaer.de` плюс Impressum = данные идентифицируемого физического лица. Отчёт о таком сайте — обработка персональных данных пользователем сканера (Verantwortlicher). Для собственных и мандатных сайтов — Vertrag/Art. 6 Abs. 1 lit. b/f без проблем; для чужих — Interessenabwägung lit. f и теоретически Art. 14 (с исключением Abs. 5 lit. b). Следствие для продукта: README-раздел «Datenschutzrechtliche Einordnung des Scans», отсутствие batch-режима (все четыре), приватность канареек и выдержек, и явный пункт в Nutzungshinweisen: «für eigene oder beauftragte Websites».

### 4.5 Сайт проекта и витрина: § 5 DDG и собственная Datenschutzerklärung

Opus предлагает `<project-domain>/scanner`, Opus и Fable — публичную витрину на GitHub Pages, которая грузит реальные `fonts.googleapis.com`. Проект, созданный по заказу коммерческого агентства, — «geschäftsmäßig»: § 5 DDG (Impressum) и Art. 13 (Datenschutzerklärung) применимы к домену проекта и к витрине. Витрина при этом раскрывает IP посетителей Google — классический EMBED-01 без согласия. Решение: витрина грузит «внешние» ресурсы со своего поддомена-имитатора (`fonts.demo.<domain>`), а реальные третьи стороны — только в локальном job; домен проекта получает Impressum заказчика и Datenschutzerklärung до этапа 2. Этого нет ни в одном плане.

### 4.6 RDG, `legalNote`, remediation и английский

- BGH *Smartlaw* (I ZR 113/20): generisches Hilfsmittel без прüфunga Einzelfalls — не Rechtsdienstleistung. Для инструмента риск минимален, если `legalNote` — общий текст по `checkId`, не зависящий от сайта. Риск несёт сервис заказчика (платные аудиты с выводами) — § 2 Abs. 1 RDG, защита через § 5 RDG спорна. Это зафиксировано в легал-мэпе и у Fable/Opus/Sol; Terra молчит.
- Статус `legalNote.status: settled` (Fable) для CONSENT-04 завышен: OLG Köln 6 U 80/23 — Revision nicht zugelassen, Nichtzulassungsbeschwerde не найдена (⚠ Rechtskraft не подтверждена); VG Hannover 10 A 5385/22 (19.03.2025) — первая инстанция, Berufung неизвестна ⚠; DSK OH v1.2 — Aufsichtsposition. Предлагаю словарь `authority-consensus | court-first-instance | court-appellate | contested | technical` вместо «settled».
- Remediation-тексты («Einwilligung vor dem Laden einholen») — формулировать технически («Consent-Gating/Zwei-Klick-Lösung prüfen»), без «Sie müssen/Sie sind verpflichtet».
- Стоп-лист для `en` обязателен (Opus/Fable — только `de`).
- Линт «ни одной пользовательской строки вне `data/messages`» — техническая гарантия обещания ТЗ «отчёт доделает заказчик».

### 4.7 §§ 202a/202c StGB, GeschGehG, § 303b — что верно, что нет

- **Modern Solution** (AG Jülich 01/2024 → LG Aachen 11/2024 → OLG Köln 07/2025 → BVerfG Nichtannahme 09/2025, Az. ⚠, только heise/borncity) — дело о доступе по **паролю** из бинарника; к открытому GET `/.env` без Zugangssicherung § 202a прямо не переносится. Серая зона — чтение *содержимого* с секретами. Дополнительная норма, которую никто не назвал: **§ 4 Abs. 1 Nr. 1 GeschGehG** (Erlangung eines Geschäftsgeheimnisses durch unbefugten Zugang/Kopieren) и § 23 GeschGehG — чтение первых 4 KiB `.env`/`wp-config.php.bak` попадает в её поле, если содержимое попадёт в отчёт или будет использовано. Следствие: сигнатура по магическим байтам/структуре без хранения; ТЗ-класс E только opt-in; README-предупреждение (Fable/Opus уже так).
- **§ 202c** (dual-use): BVerfG 2 BvR 2233/07 — назначение инструмента; список non-features и отсутствие exploit/bypass-функций — правильная защита (Fable/Opus).
- **§ 303b** требует Nachteilszufügungsabsicht — не основание для rate limit (ошибка Fable); основание — § 823 BGB и BGH Screen Scraping.
- Реформа § 202a на 10/2026 не принята (RefE 11/2024, Koalitionsvertrag, Stellungnahmen 08/2026) — проектировать «как есть».

### 4.8 § 824 BGB / § 4 Nr. 2 UWG / § 186 StGB: что именно защищает

§ 824 требует **unwahre Tatsachenbehauptung**; защита — проверяемость: Messumgebung, UTC, версии баз, `confidence`, `snapshotSha256`, «Momentaufnahme zum Prüfzeitpunkt». Все четыре это делают. Чего не хватает: (а) заголовок HTML «Momentaufnahme vom [UTC] — Ergebnisse können sich jederzeit ändern»; (б) запрет публикации отчётов о третьих лицах в README (есть у Opus/Fable); (в) корректные факты о получателях (4.2) — именно здесь наиболее вероятна «unwahre Tatsache». Для Einzelunternehmer дополнительно § 186 StGB (üble Nachrede) — ещё один аргумент за фактические формулировки.

### 4.9 Массовые Abmahnungen: правовой контекст и рычаги дизайна

Контекст, который стоит прописать в README/ADR: § 8c UWG (missbräuchliche Geltendmachung) и § 13 Abs. 4 UWG (нет возмещения Abmahnkosten за Informationspflichten и DSGVO-Verstöße у < 250 сотрудников), LG München I 4 O 13063/22 (злоупотребление Google-Fonts-Schreiben), Ermittlungen GenStA Berlin 12/2022 (исход ⚠), EuGH C-526/24 (⚠ ссылка на PM не подтверждена). Рычаги дизайна, по которым предложения сходятся и которые надо зафиксировать как non-features: нет batch-режима, нет экспорта «под претензию», нет публичных рейтингов, нет автоматических уведомлений, честная идентификация для блокировки владельцем, rate limit, дисклеймер без флага отключения, `crmCode` не в человекочитаемых отчётах, канарейка приватна. Apache-2.0 запрет использования не допускает — все четыре честно это признают.

### 4.10 Актуальность правовой базы на 30.10.2026 (проверено в этой сессии)

| Факт, используемый в предложениях | Статус |
|---|---|
| DSK OH Digitale Dienste v1.2 (11/2024), Rn. 121/124–125/134–137 | Версии 1.3/2.0 поиском не найдены — Rn. валидны ⚠ (сам текст Rn. 124 в этой сессии не перечитан; опираюсь на regulatory-отчёт, читавший PDF) |
| OLG Köln 6 U 80/23 (19.01.2024, wetteronline) | Подтверждено: Revision nicht zugelassen; Nichtzulassungsbeschwerde/Rechtskraft не найдены ⚠. Не путать с 6 U 85/23 → BGH I ZR 17/24 (20.02.2025), другое дело |
| VG Hannover 10 A 5385/22 (19.03.2025), GTM einwilligungspflichtig | Подтверждено вторичными источниками (tcilaw, borncity); один блог пишет 19.05.2025 ⚠; Berufung неизвестна ⚠ |
| DPF: C-703/25 P | Подана 31.10.2025, ABl. C/2025/6610; Microsoft вступил 06/2026; решения нет — pending |
| Digital Omnibus | Мандат Совета (Coreper 21.10.2026, ST 14756/26 от 22.10.2026) — переговорная позиция; Art. 88a/88b убраны, правила в Art. 5(3) ePrivacy-RL, 6 исключений, 4 месяца — по вторичным источникам ⚠; ЕП не голосовал. Для MVP ничего не меняет |
| Google reCAPTCHA → Auftragsverarbeiter с 02.04.2026 | Подтверждено (Google FAQ, heise, 2b-advice); договорный статус оператора не виден сканеру |
| UK adequacy | Продлено 19.12.2025 до 27.12.2031 (GDPR + LED) |
| Modern Solution / BVerfG | Nichtannahme 09/2025 подтверждена (heise/borncity), Az. ⚠ |
| CRA Art. 24 (stewards) | Применяется с **11.12.2027** (Art. 14 Meldepflichten — с 11.09.2026); закрывает ⚠ Fable |
| PLD (EU) 2024/2853 | Транспозиция до 09.12.2026 — по памяти ⚠ |
| RFC 9989 | Существует, obsoletes 7489/9091; месяц публикации ⚠ |
| BSI TR-02102-2 2026-01 | Подтверждено критиком раунда 1 |

### 4.11 LEGAL-01 `critical` против BGH I ZR 228/03

BGH (20.07.2006) допускает ссылки «Kontakt»/«Impressum» и достижимость за два клика. Fable и Opus дают `critical`, если ни на одной проверенной странице нет ссылки с меткой «Impressum/Datenschutz». Сайт со ссылкой «Kontakt» → страница с Impressum внизу формально соответствует BGH, но получит `critical` T1_OTHER. Исправление: при отсутствии прямых ссылок пройти один хоп по «Kontakt»/«Rechtliches»/«Über uns»-ссылкам (≤ 3 GET), и только затем `critical`; фолбэк `/impressum` (Opus) — дополнительно. Формулировка остаётся «auf n von m geprüften Seiten … nicht gefunden; über [Zwischenseite] erreichbar: ja/nein».

### 4.12 Данные и лицензии — правовые уточнения

- `@duckduckgo/autoconsent` (MPL-2.0) как немодифицированная зависимость — стандартно и безопасно; ⚠ Fable можно снять. Риск — в копировании файлов правил в свой формат: file-level copyleft и § 87a UrhG (база правил — Datenbank). Принцип: собственные селекторы, autoconsent — референс для перекрёстной проверки.
- Тексты заказчика: CC BY 4.0 (или явное разрешение), не Apache-2.0.
- Wordfence Terms (26.01.2026) не прочитаны ни одним участником — остаётся ⚠ до чтения живым браузером; EUVD — условия ENISA ⚠; DB-IP требует атрибуции в каждом отчёте с GeoIP; GHSA (CC BY 4.0) — атрибуция в футере.
- Экспорт из CRM заказчика для каталога — только собственные аудиты (§ 87a), без копирования чужих tracker-баз; чек-лист в PR (Fable/Opus).

### 4.13 Прочее по линзе

- Allowlist «technisch notwendig» (CMP-cookie, Session, CSRF) — сама по себе классификация по § 25 Abs. 2 Nr. 2; в HTML не писать «notwendig/essenziell», а «nicht bewertet (Allowlist v[X])».
- Фаза C («Alle akzeptieren») с ноутбука разработчика отправляет его IP трекерам — пометка в README; из CI — синтетическая сессия.
- Лаборатория CMP на free/trial-планах (Cookiebot free, Usercentrics trial) — проверить ToS на автоматизированные сканы собственного сайта ⚠; сканирование сайтов вендоров (Opus 9.5) — публичный контент, ToS не обязывают без акцепта (BGH Screen Scraping), но лучше ограничиться лабораторией.
- Названия уровней в HTML: «Befunde/Beobachtungen», не «Verstöße»; «Beleg», не «Beweis».

**Источники, проверенные в этой сессии (веб-поиск 30.10.2026):** verbraucherzentrale.nrw (PDF OLG Köln 6 U 80/23), wbs.legal, ra-plutte.de, rewis.io (6 U 85/23); eur-lex C/2025/6610, digitalpolicyalert.org, ieu-monitoring (Microsoft intervention), wilmerhale.com; ppc.land, relevantaudience.com, heuking.de (Omnibus); heise.de/-10663687, borncity.com (Modern Solution); tcilaw.de, borncity.com (VG Hannover); docs.cloud.google.com/recaptcha/docs/faq, heise.de/-11169180, 2b-advice.com (reCAPTCHA); freeths.co.uk, hunton.com, theregister.com (UK adequacy); springlex.eu (CRA Art. 71), bestpractices.linuxfoundation.org/cra. DSK OH v1.3/2.0 — не найдена.

---

## 5. Блокеры

По важности; всё — до начала этапа 1 (или явно помечено «до этапа 3»).

1. **Семантика `critical` и таблица уровней.** Заказчик подписывает: `critical` = уверенно установленный технический факт класса, приоритетного по ruleset (не «доказанное нарушение»); маппинг T0 → `critical`, T1 → «critical-способный», T3 → ≤ `warning`; спорные строки: CONSENT-04 неблокирующий (`info` vs `warning`), EMBED-01 (`warning`), TLS-01 градация, PRIV-01 ≤ `warning`, TRACK-01 (инвентарь vs владелец).
2. **Политика `crmCode`.** Только в JSON, не рендерится; `null` для P2/`SCAN-*`/`info`-вариантов; подтверждение/исправление кодов EMBED-03 (сейчас код карт) и CONSENT-06; переживёт ли импорт CRM `null` и смену маппинга.
3. **UA-профиль и имя продукта.** Решение (а) буквальная ссылка в браузерном UA с `inconclusive` на RCB/isbot-сайтах или (б) нейтральный токен + идентифицирующий заголовок; выбор имени с бот-тестом и clearance DPMA/EUIPO/домены/npm; домен проекта — с Impressum и Datenschutzerklärung.
4. **Модель третьих стран и текст о получателях.** Утвердить поля `provider/parent/dpfEntity`, структуру `adequacy.json` (EWR, страновые решения с датами, DPF-список), формулировки для US-получателей при pending C-703/25 P; GeoIP off by default. Юрист заказчика визирует тексты.
5. **Немецкие тексты, `legalNote`, дисклеймер, стоп-листы de/en.** Кто пишет, когда (ТЗ: к этапу 3), лицензия текстов (CC BY 4.0 vs Apache), правило «релиз блокируется при `draft: true`», словарь статусов источников. Без черновиков заказчика на этапе 1 используем черновики legal-basis-map §2.2/§3.3 с пометкой draft.
6. **Согласия и корпус.** Письменное согласие владельцев 10 сайтов (объём, частота, срок) — лучше к концу этапа 1; экспорт из 80 аудитов (домены → сервисы → crmCode) с подтверждением § 87a; бюджет и ToS CMP-лаборатории; витрина без реальных третьих сторон на публичной странице.
7. **Класс E (FILE-01/ADMIN-01).** Включать ли в MVP вообще; список путей (≤ 15) с правовой оценкой заказчика (§ 202a/§ 202c StGB, GeschGehG § 4); формулировки ADMIN-01 про раскрытие имён сотрудников.
8. **Коды возврата и покрытие.** Подтвердить: `2` только «скан невозможен»; ошибка одной проверки — по порогу с `--strict`; баннер не распознан — `info`+`inconclusive`; находки фазы A′ (скролл/мышь без клика) — тот же уровень, что A (Planet49, EDPB 05/2020 Rn. 86 ⚠ дословно).
9. **Минимизация и хранение.** Нет значений/хешей cookies; маскирование `mailto:` в DNS/`security.txt`; скриншот баннера по умолчанию (UrhG § 51 — оценить); retention 14 дней; HAR/trace только явно; публикация отчётов о третьих лицах запрещена README.
10. **Правовой статус самого проекта (до релиза, не до этапа 1).** RDG для платных аудитов заказчика (§ 5 RDG Nebenleistung), CRA (Hersteller vs OSS-steward, Art. 24 с 11.12.2027) и PLD при монетизации через seed-factory; лицензионное подтверждение Wordfence/EUVD/EasyList opt-in — оценка юристом заказчика, фиксируется в README и дисклеймере.
