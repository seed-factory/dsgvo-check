# Раунд 1 — сводка решений и вопросов исследователей (Claude Opus 5.5 / Fable 5.1)

Машинная выжимка из структурированных ответов агентов раунда 1. Полные отчёты — в `docs/01-research/`.

## legal-map (fable) — `docs/01-research/legal-basis-map.md`

Правовая карта всех 33 проверок каталога (P0/P1/P2) записана в docs/01-research/legal-basis-map.md. Ядро (CONSENT-*, TRACK-01, EMBED-*) опирается на § 25 TDDDG + Art. 4 Nr. 11/6/7 DSGVO с устоявшейся линией Planet49 → BGH I ZR 7/16 → DSK OH Digitale Dienste v1.2 (11/2024) → EDPB TF Report (17.01.2023) → EDPB Guidelines 2/2023 v2.0; спорные зоны: Ablehnen на первом уровне при неблокирующем баннере (DSK Rn. 124–125 vs OLG Köln 6 U 80/23 и VG Hannover 10 A 5385/22), reCAPTCHA, шрифты как § 25-событие, Pur-Abo. Security-проверки имеют лишь косвенную базу (Art. 32/25, § 19 Abs. 4 TDDDG, BSI TR) без судебной практики — максимум warning. Для каждой проверки дана граница «факт vs. оценка» и немецкий шаблон в стиле «nicht gefunden», плюс таблица запрещённых формулировок и черновик дисклеймера. Разобраны RDG (BGH Smartlaw: статические тексты ок, per-site правовые выводы и LLM-генерация — риск), §§ 202a/202c/303b (Modern Solution до BVerfG 2025, реформа буксует → FILE-01 opt-in, без сохранения тела), ответственность OSS (Apache-2.0 vs §§ 521/599/309 BGB, CRA, PLD), § 824 BGB. DPF на 30.10.2026: 2023/1795 в силе, T-553/23 отклонён 03.09.2025, апелляция C-703/25 P pending, после Trump v. Slaughter (29.06.2026) EDPB 31.07.2026 запросил пересмотр; GeoIP — атрибут находки, не вывод. Зафиксированы подвижки: ePrivacy-VO отозвана (ABl. 06.10.2025), Digital Omnibus — Совет 21.10.2026 отказался от Art. 88a/88b.

**Ключевые решения**

- **Модель находки** (high): Три слоя: observation (факт+evidence) → classification (категория, версия базы, confidence, 'unknown' как класс) → legalNote (статический текст по checkId в data/legal/<id>.de.md, вычитанный заказчиком). Никакой генерации правовых оценок под конкретный сайт (RDG/Smartlaw-логика).
- **Статус 'Ablehnen' на первом уровне (CONSENT-04)** (high): Считать требование равноценной Ablehnoption устоявшимся только когда баннер блокирует взаимодействие (OLG Köln 6 U 80/23, VG Hannover 10 A 5385/22, DSK Rn. 124–125/134–137, EDPB TF Type A). Фиксировать факт блокировки, тексты и геометрию кнопок; неблокирующий баннер и Pur-Abo — info + ручная проверка; нераспознанный CMP — строго info 'Banner nicht erkannt'.
- **Severity для security-проверок** (high): HDR-*, MAIL-*, TLS-03/04, DNS-01, SEC-01, HDR-02, PERF-01 — технические стандарты без судебной практики: максимум warning, DNS-01/SEC-01/PERF-01 — info; слово 'Verstoß' исключено. critical только у P0 с устоявшейся базой и у FILE-01 при подтверждённом формате.
- **Передача за пределы ЕС** (high): Не вводить отдельную проверку TRANSFER-01; добавить атрибут thirdCountrySignal (IP, ASN, GeoIP-DB+дата, certOrg, DPF-lookup с качеством совпадения) к CONSENT-01/TRACK-01/EMBED-*. Страна не влияет на severity. Статус DPF — в версионируемом data/legal/context.json с датой проверки.
- **FILE-01 и граница § 202a StGB** (high): Opt-in, короткий согласованный список путей, один GET с лимитом размера, без рекурсии, сравнение только первых байт с ожидаемым форматом, тело не сохранять и не выводить, найденные секреты никогда не использовать. Честный User-Agent, rate limit, не обходить bot-блоки/CAPTCHA (BGH Screen Scraping I ZR 224/12).
- **Формулировки отчёта** (high): Принять список запрещённых формулировок (verstößt/rechtswidrig/unzulässig/ohne Einwilligung/Tracker/Datenübermittlung in die USA/Datenleck/Abmahngefahr/konform/bestanden) и правило 'отсутствие находки ≠ соответствие'; использовать фазы 'vor Interaktion mit dem Banner' вместо правовых статусов; каждая находка несёт URL, время UTC, точку наблюдения, UA, версии баз (защита от § 824 BGB).
- **Версионирование правового контекста** (medium): Правовая база движется (TDDDG/DDG 05/2024, EinwV 04/2025, ePrivacy-VO отозвана 10/2025, Digital Omnibus в Совете 10/2026, DPF под апелляцией C-703/25 P и после Trump v. Slaughter). Хранить статус/даты в data/legal/context.json и выводить в отчёт как 'Rechtlicher Kontext (Stand …)', не как оценку.
- **EMBED-04 reCAPTCHA** (medium): Квалифицировать как спорную: DSK Rn. 74 допускает IT-Sicherheit как Basisdienst, CNIL/Cityscoot (16.03.2023) требует Einwilligung. Сканер фиксирует 'загружено на k страницах без формы', оценку 'erforderlich' не делает; severity не выше warning.
- **Дисклеймер и ответственность OSS** (medium): Использовать черновик дисклеймера из раздела 3.3; в README честно указать, что Apache-2.0 §§ 7–8 по немецкому праву не исключают ответственность за Vorsatz/grobe Fahrlässigkeit (§§ 521/599, 309 Nr. 7 BGB); отдельно оценить с юристом заказчика, делает ли коммерческое использование проект 'Hersteller/Steward' по CRA и PLD.

**Открытые вопросы**

- crmCode: для P2 не задан; EMBED-03 помечен T1_MAPS_BEFORE_CONSENT, CONSENT-06 — T1_TRACKER_BEFORE_CONSENT — ошибки каталога или намеренная агрегация?
- Rechtskraft OLG Köln 6 U 80/23 и исход Berufung LG Rostock 3 O 762/19 не найдены — влияет на метку 'устоявшаяся' у CONSENT-04.
- Статус C-703/25 P (слушание/Schlussanträge) и ответ Комиссии на письмо EDPB от 31.07.2026 неизвестны — кто обновляет legalContext.dpf и как часто?
- Исход Digital Omnibus (einwilligungsfreie Reichweitenmessung в Art. 5(3) ePrivacy) — нужен ли 'legal profile by date' для CONSENT-02/TRACK-01?
- CRA/PLD: делает ли коммерческое использование заказчиком проект 'Hersteller' или 'open-source software steward'; дата применения Art. 24 CRA для stewards расходится в источниках (11.09.2026 vs 11.12.2027).
- RDG-позиция заказчика при продаже аудитов с правовыми выводами (§ 5 RDG Nebenleistung) — определяет, какие тексты он добавит в отчёт.
- FILE-01: согласовать список путей, лимиты, opt-in и предупреждение в README; нужен ли вообще в MVP (0 находок в 80 аудитах, риск по Modern Solution).
- TLS-04: активный handshake-probe vs 'только пассивные проверки' ТЗ — зафиксировать как допустимое исключение в ADR.
- Pur-Abo/'Pay or Okay'-баннеры без Ablehnen, но с Abo-альтернативой — info + ручная проверка?
- PIMS/EinwV: распознавать ли запрос PIMS-сигнала, чтобы не считать отсутствием баннера; какой признанный сервис реально существует (⚠ 'Consenter', 17.10.2025).
- § 18 MStV: эвристика 'journalistisch-redaktionell' или общий info-Hinweis в LEGAL-01?
- GeoIP-база: GeoLite2 (EULA, аккаунт, ограничения редистрибуции в Docker-образе) vs DB-IP Lite (CC BY 4.0, атрибуция).
- DPF List: есть ли официальный CSV/API; иначе ручная версионированная выгрузка в репо.
- Хранить ли скриншоты баннеров (UrhG, personenbezogene Daten в UI) и с каким сроком.
- Политика использования против массовых Abmahnungen (прецедент Google-Fonts-Welle) — только README/Code of Conduct, лицензия запретить не может.
- Немецкие шаблоны раздела 2 и дисклеймер 3.3 — на вычитку заказчику к этапу 3.

**Не подтверждено**

- Az. решений OLG Köln (07/2025) и BVerfG (09/2025) по Modern Solution — только вторичные источники (heise, borncity).
- Номер решения CNIL по Cityscoot (SAN-2023-…) — дата 16.03.2023 и сумма 125 000 € подтверждены, номер нет.
- Утверждение, что VG Hannover 10 A 5385/22 признал Google Tag Manager einwilligungspflichtig — из вторичных источников, текст решения не читался.
- Rechtskraft OLG Köln 6 U 80/23 (Revision nicht zugelassen; Nichtzulassungsbeschwerde неизвестна) и исход Berufung LG Rostock 3 O 762/19.
- Первоисточник письма EDPB от 31.07.2026 к Комиссару McGrath — только IAPP/Hunton.
- Детали мандата Совета по Digital Omnibus от 21.10.2026 (удаление Art. 88a/88b, 6 исключений, 4 месяца) — только ppc.land/nicfab, официальный текст Совета не читался.
- BSI TR-02102-2: текущая версия 2024-1 подтверждена, точные формулировки о допустимости TLS 1.2 не проверены.
- CRA: дата применения обязанностей stewards (Art. 24) — источники расходятся; текст Erwägungsgrund 18 не читался напрямую.
- BfDI-признание первого PIMS-сервиса ('Consenter', 17.10.2025) — один вторичный источник.
- Из общих знаний без повторной сверки в сессии: Planet49 C-673/17, Fashion ID C-40/17, BGH I ZR 7/16, Breyer C-582/14, IAB Europe C-604/22, Österreichische Post C-154/21, Meta/Bundeskartellamt C-252/21, Schrems II C-311/18, Lindenapotheke C-21/23 (дата EuGH), Durchführungsbeschluss 2023/1795, BGH I ZR 228/03, BVerfG 2 BvR 2233/07, BGH VI ZR 10/24, § 13 Abs. 4 UWG, BFSG 28.06.2025, DDG 14.05.2024, MStV 07.11.2020, WP260 rev.01, EDPB Guidelines 05/2021, RFC 8996/9116/8659, PLD 2024/2853, DSB-Österreich и CNIL по Google Analytics, Knuddels-Bußgeld, Consent Mode v2 (03/2024), применение §§ 521/599/309 Nr. 7 BGB к FOSS.
- Bußgeld-Tatbestand для Impressum в DDG (бывш. § 16 TMG, до 50 000 €) — точный параграф DDG не проверен.
- URL MaxMind GeoLite2 EULA указан по памяти; содержание EULA подтверждено через scancode-licensedb и maxmind.com.
- Исход уголовного дела против берлинского Abmahnanwalt (Google Fonts) — после Durchsuchungen 12/2022 ничего не найдено.

## reg-landscape (opus) — `docs/01-research/regulatory-landscape-2026.md`

Основа правил по cookies в Германии не изменилась. Действуют § 25 TDDDG (с 14.05.2024 это переименованный TTDSG), § 5 DDG и DSGVO. Главный практический ориентир — DSK OH Digitale Dienste v1.2. EinwV в силе с 01.04.2025, но участие в ней добровольное.

Digital Omnibus пока не закон. Комиссия предложила Art. 88a и 88b. Совет в мандате от 21.10.2026 (данные из вторичных источников) их удалил и вернул правила в Art. 5(3) ePrivacy. По этому мандату отказ даётся одним кликом, повторный запрос допустим через 4 месяца, обязательных браузерных сигналов нет. Комитеты ЕП ещё не голосовали. За 12 месяцев проверки CONSENT-* из-за этого не изменятся.

Что поменять в проверках:
- CONSENT-04: учитывать DSK Rn. 124, по которой отказ на первом уровне обязателен только при блокирующем баннере.
- CONSENT-01/02: добавить Web Storage, пиксели, sGTM и GTM.
- EMBED-01: уровень `warning`.
- MAIL-02: SPF `~all` допустим по BSI TR-03182.

Для TLS прямая опора — § 19 Abs. 4 TDDDG, пороги берём из BSI TR-02102-2 2026-01. Заголовкам безопасности соответствует только «Stand der Technik», конкретной нормы нет.

BFSG-01 по умолчанию `info`. CRA на операторов сайтов не распространяется. EUVD — кандидат в источники данных, но лицензию нужно проверить.

Архитектура: у каждой проверки `legalBasis[]` с датами, ruleset версионируется по Rechtsstand, детект отделён от оценки уровня.

**Ключевые решения**

- **CONSENT-04: отказ на первом уровне** (high): Различать блокирующий и неблокирующий баннер (desktop и mobile). Блокирующий без кнопки отказа или с «Einstellungen oder Ablehnen» — warning. «X» = Akzeptieren — warning. Неблокирующий баннер — info. Неизвестный CMP — info «Banner nicht erkannt». Pay-or-Okay — отдельный info, CONSENT-04 к нему не применять. Основания: DSK Rn. 124–137, VG Hannover 10 A 5385/22, OLG Köln 6 U 80/23
- **CONSENT-01/02: охват детекта** (high): Добавить localStorage, sessionStorage и IndexedDB (DSK Rn. 21), пиксели, URL-трекинг и cookieless pings (EDPB 2/2023 Rn. 51), загрузку GTM до согласия (VG Hannover), first-party и server-side трекинг по сигнатуре payload. Классы: tracking/ads — critical; tag manager — warning; CDN/static — info. В отчёте указывать, что server-to-server передачу пассивно проверить нельзя
- **Digital Omnibus** (high): Ядро проверок не перестраивать. Исключения хранить как данные по категории цели. Завести opt-in профиль eu-omnibus-preview с пометкой «Entwurf» и параметром cooldown (сейчас 0). Отслеживать 2025/0360(COD)
- **EMBED-01..05: уровни и формулировки** (medium): По умолчанию warning (основание — Art. 6 DSGVO и DSK Rn. 101), без «Abmahn»-риторики. youtube-nocookie классифицировать как YouTube, с пометкой о режиме. reCAPTCHA: на странице без формы — warning, на странице с формой — info. Учесть, что с 02.04.2026 Google выступает для reCAPTCHA процессором
- **MAIL-01/02/03 по BSI TR-03182** (high): SPF ~all при DMARC quarantine/reject — info. +all или ?all — warning. Отсутствие DMARC или p=none — warning со ссылкой на TR-03182. DKIM — только info («auf gängigen Selektoren nicht gefunden»). Новый MAIL-04 для неиспользуемых доменов: Null MX + -all + DMARC reject
- **TLS/HDR: нормативная опора и уровни** (high): TLS-01/02 опираются на § 19 Abs. 4 TDDDG: при формах critical, иначе warning. TLS-04: TLS 1.0/1.1 — warning по TR-02102-2 2026-01. HDR-01: отсутствие HSTS — warning, остальные заголовки — info как «Stand der Technik». NIS2/§ 30 BSIG только в профиле nis2
- **BFSG-01/02** (high): По умолчанию info с оговоркой о применимости (B2C-e-commerce, исключение Kleinstunternehmen) и пометкой, что автоматическая проверка частичная. Профиль bfsg переводит находки в warning. Новый BFSG-02: не найдены «Informationen zur Barrierefreiheit» (§ 14 Abs. 1 Nr. 2 BFSG)
- **LEGAL-01/02** (high): LEGAL-01: проверять, что ссылки на Impressum и Datenschutz не перекрыты баннером (DSK Rn. 121), и их доступность с каждой страницы. LEGAL-02: словарь устаревших ссылок с validFrom — TMG→DDG, TTDSG→TDDDG, RStV→MStV, OS-Plattform (с 20.07.2025), Privacy Shield
- **Анти-абмахн дизайн** (medium): Только фактические формулировки, без «Verstoß» и «Schaden». Никакого экспорта под абмахнунги. Rechtsstand и rulesetVersion в дисклеймере. FILE-01 не сохраняет содержимое найденных файлов. Основания: C-526/24, LG München I 4 O 13063/22, § 13 Abs. 4 UWG
- **Архитектура правовой базы** (high): Слой observation отделён от assessment по правовому профилю. legalBasis[] со статусом, validFrom, verifiedAt и reviewBy. rulesetVersion по CalVer в JSON. Справочники вендоров, CMP и норм как data-пакеты. CI-проверка устаревания legalBasis
- **VULN: источники и CRA** (medium): Мульти-источниковые адаптеры (OSV/NVD/KEV/EUVD) с метаданными в evidence. EUVD — для статуса exploited, но только после выяснения лицензии. CRA не использовать как опору для VULN-уровней; опора — Art. 32 DSGVO и § 19 Abs. 4 TDDDG

**Открытые вопросы**

- Точный текст мандата Совета от 21.10.2026 (номер 13886/26 или 14756/26; формулировки исключений и cooldown) и сроки голосования ЕП
- Уровень CONSENT-04 для неблокирующих баннеров: info или warning (решение заказчика)
- Уровень для cookieless pings Consent Mode v2 Advanced: позиции немецкого надзора нет
- Нужны ли CLI-флаги о размере и типе компании (BFSG, § 13 Abs. 4 UWG, NIS2), или достаточно пометки «Anwendbarkeit prüfen»
- Лицензия данных EUVD для Apache-2.0-проекта: запросить у ENISA
- Как подавать «передачу за пределы ЕС»: GeoIP, сиденье вендора или DPF-статус
- Распространяется ли CRA на dsgvo-check при монетизации через seed-factory
- Границы пассивности FILE-01/ADMIN-01 с точки зрения §§ 202a/202c StGB
- Содержание изменений TDDDG (10.03.2026) и DDG (2026): затронуты ли § 5 DDG и § 25 TDDDG
- Итог уголовного дела в Берлине против Google-Fonts-абмахнеров; судебные решения по BFSG как Marktverhaltensregel
- Применим ли BGH 27.03.2025 (Art. 9 как Marktverhaltensregel) к § 25 TDDDG и Art. 6 DSGVO

**Не подтверждено**

- Содержание мандата Совета 21.10.2026 по cookies (6 исключений, 4 месяца, удаление 88a/88b) — только вторичные источники; номер документа противоречив
- Сроки применения Art. 88a/88b в предложении Комиссии (6/24/48 месяцев) — вендорские и вторичные источники
- Голосование ЕП в комитете «early 2027» и прогноз применения в DE около 2029
- AI-omnibus принят как Regulation (EU) 2026/1744
- Первый признанный EinwV-сервис «Consenter» (17.10.2025) и призыв BfDI в августе 2026 — единичные источники
- EinwV BGBl. 2025 I Nr. 32 и вступление 01.04.2025 — вторичные источники
- Содержание изменений TDDDG (G v. 10.3.2026) и DDG (G v. 25.3.2026, 12.5.2026)
- BGH I ZR 7/16 (28.05.2020), BGH I ZR 228/03 (20.07.2006), MStV с 07.11.2020, Schrems II C-311/18 (16.07.2020) — по памяти
- Мотивы отмены VGH Kassel 10 B 2486/21
- Номер апелляционного дела Latombe в EuGH
- Дата EDPB Opinion 08/2024 (17.04.2024) и статус EDPB-руководств по consent-or-pay
- Кодировка параметров gcs/gcd Google Consent Mode и запись youtube-nocookie в localStorage — проверить фикстурами
- Пиксель p.typekit.net у Adobe Fonts
- BSI TR-03116-4 редакция 2025-07; актуальная редакция DSK OH по шифрованию e-mail; редакция IT-Grundschutz APP.3.x
- Статус EN 301 549 под EAA/WCAG 2.2 и статус MLBF
- Номер регламента (EU) 2024/3228 об отключении ODR-платформы; BGBl. 2026 I Nr. 28 для § 356a BGB
- Регистрация NIS2 (срок 06.03.2026, льгота до 31.07.2026); число ~29 500 организаций
- Лицензия данных EUVD; ENISA как CVE Root; статус финансирования CVE/MITRE после 03/2026
- Итог уголовного дела GenStA Berlin против Google-Fonts-абмахнеров
- Применимость CRA к SaaS/remote data processing и к самому dsgvo-check

## prior-art (opus) — `docs/01-research/prior-art.md`

Ни один аналог не закрывает P0 целиком. По consent-части ближе всех Slashgear/gdpr-cookie-scanner (TS + Playwright, MIT, exit 0/1/2, шаблоны GitHub и GitLab), но он ориентирован на Францию и гейтит по общей оценке. По доказательной базе ближе всех EDPS WEC v4.6.0 (TS + Puppeteer, EUPL-1.2): кнопки не кликает, порогов нет. Безопасность и почту покрывают Internet.nl, ZAP baseline, MDN Observatory и testssl.sh. PRIV-01/02, CONSENT-06, немецкие LEGAL-01/02 и crmCode нет ни у кого. Главная находка: DuckDuckGo autoconsent (MPL-2.0, v17.1.0, 913 правил) покрывает все 7 CMP из каталога и умеет распознавать немецкие кнопки. Но его opt-out может пройти через «Speichern», поэтому вердикт CONSENT-04 нужно делать своими адаптерами. Трекер-базы Disconnect, Tracker Radar и Ghostery под CC BY-NC-SA, включать их нельзя. Wappalyzer-форки под GPL-3.0. Модель гейтинга берём у ZAP, модель доказательств у WEC; exit 2 у ZAP означает другое, чем у нас. Позиционирование: пассивный Apache-2.0 CI-гейт для немецких сайтов — что уходит до и после «Ablehnen», сверка с Datenschutzerklärung и Impressum, базовая безопасность, JSON с crmCode, без юридических выводов. Есть коллизия имени dsgvo-check на GitHub; в npm имя свободно.

**Ключевые решения**

- **Распознавание CMP и выполнение отказа** (high): Подключить @duckduckgo/autoconsent (MPL-2.0) как немодифицированную npm-зависимость для detect и opt-out; вердикт CONSENT-04 «отказ на первом уровне» делать своими адаптерами для 7 CMP; нераспознанный баннер — info «Banner nicht erkannt»
- **Модель CI-гейтинга** (high): Взять модель ZAP baseline: правила по ID с fail/warn/ignore, URL-исключения, suppressions с причиной и сроком. В README явно описать, что exit 2 у нас = сбой сканера, а не warn, как у ZAP
- **Доказательная модель и отчёт** (high): Как у WEC: collect → сырой inspection JSON → отчёт; классифицировать ошибки навигации; показывать покрытие (failed_pages, skipped_links); не слать префлайт-запросы к третьим сторонам
- **Данные о трекерах и cookies** (high): Свой немецкий каталог сервисов (домены, юрлицо, страна или DPF, алиасы для политики, crmCode) + third-party-web (MIT) + Open Cookie Database (Apache-2.0). CC BY-NC-SA-листы (Disconnect, Tracker Radar, Ghostery) не использовать; EasyPrivacy — только опционально, после юр. проверки
- **VULN-01/02** (medium): retire.js (Apache-2.0) для JS-библиотек + свой узкий детект WP и TYPO3 вместо GPL-данных Wappalyzer; уязвимости из Wordfence Intelligence v3, OSV и CISA KEV (CC0); WPScan только с токеном пользователя
- **TLS-04** (medium): Опционально запускать testssl.sh (GPL-2.0) отдельным процессом, как WEC; своя Node-проба TLS 1.0 под вопросом из-за OpenSSL 3
- **Заголовки и MAIL/DNS** (medium): Своя реализация на семантике MDN Observatory и Internet.nl; Observatory не тянуть зависимостью (в зависимостях сервер и БД). DKIM через _domainkey только как info с оговоркой
- **FILE-01** (high): Не больше 10 путей из nuclei-templates (MIT) с анти-soft-404-матчерами, по одному запросу на путь; экстракторы секретов не переносить, тело ответа не сохранять
- **Позиционирование** (high): Отличаемся немецким фокусом, сверкой «политика vs реальность» (PRIV-01/02), CONSENT-06, privacy + security + mail в одном JSON со стабильными ID и crmCode и лицензией Apache-2.0. Связка Playwright + CI уже не уникальна

**Открытые вопросы**

- Оставляем имя dsgvo-check, несмотря на одноимённый репозиторий на GitHub без лицензии? Публикуем в npm без scope или со scope?
- Можно ли поставлять или скачивать при запуске EasyPrivacy (GPL-3.0 или CC BY-SA 3.0) в Apache-2.0-проекте, учитывая sui generis права на базы данных в ЕС?
- testssl.sh (GPL-2.0) — включаем в Docker-образ или делаем свою пробу TLS-04?
- Устраивают ли условия Wordfence Intelligence v3 (атрибуция на запись) для VULN по WP-плагинам? Исключаем ли WPScan?
- Точный критерий CONSENT-04: берём формулировку BayLDA? Как классифицировать «Verbergen», X, ссылку вместо кнопки и визуальную асимметрию?
- Отправлять исправления немецких CMP-правил в autoconsent upstream? Связаться ли с автором Slashgear?
- Нужен ли экспорт, совместимый с WEC inspection.json, для передачи надзорным органам и юристам?
- Нужна ли сводная оценка (grade/score) или достаточно уровней по ID и --fail-on?
- Метод «передачи за пределы ЕС»: по владельцу и статусу DPF, без IP-геолокации — согласовать с заказчиком
- Какие продукты 2B Advice и IHK/LfDI имел в виду заказчик? Публичных сканеров не нашли

**Не подтверждено**

- EDPB WAT: в package.json лицензия EUPL-1.0, EDPB указывает EUPL-1.2; не проверено, умеет ли WAT ручную запись consent-flow, Lighthouse и BFSG
- ID пассивных правил ZAP (10038, 10020, 10021, 10035, 10063, 10010, 10011, 10054, 10036, 10037, 10040, 10003) — по памяти, не сверены с zaproxy.org/docs/alerts
- testssl.sh: проверка CAA, флагов cookies и баннеров в секции заголовков; семантика exit-кодов
- Что Nuclei проверяет по DMARC/SPF/security.txt/ADMIN-01 (конкретные шаблоны) и поведение его exit-кода
- retire.js --exitwith по умолчанию 13
- Как Slashgear распознаёт немецкие CMP и покрывает ли EMBED-*
- consentcrawl: тестирует ли отказ, а не только принятие; версия на PyPI
- Лицензия бэкенда webbkoll; детали функций PrivacyScore (по памяти)
- Условия WPScan API (25 запросов в день, коммерческая лицензия) и владелец (Automattic)
- Полные условия Wordfence Intelligence v3 о повторном распространении
- Покрывает ли Consent-O-Matic CCM19, Real Cookie Banner и CookieHub под другими именами файлов
- Название инструмента noyb «WeComply»; позиция AEPD (Испания) по отказу на втором уровне — только по вторичным источникам
- Функции website-check.de, Hugo Check, Passiro и Dr. DSGVO не изучены
- Осуществимость своей Node-пробы TLS 1.0 при ограничениях OpenSSL 3
- Lighthouse CI как механизм гейтинга не проверялся

## data-licenses (fable) — `docs/01-research/data-sources-and-licenses.md`

Все крупные базы трекеров (DuckDuckGo Tracker Radar, Disconnect, Ghostery TrackerDB — CC BY-NC-SA 4.0; cookiedatabase.org — CC BY-NC-ND) закрыты для платных аудитов seed-factory даже в режиме «тянуть при запуске». Пермиссивная замена есть: third-party-web (MIT, 2 143 сущности), Open Cookie Database (Apache-2.0), AdGuard cname-trackers (MIT), EasyPrivacy/EasyList по ветке CC BY-SA 3.0 через @ghostery/adblocker (MPL-2.0). CMP: @duckduckgo/autoconsent (MPL-2.0, 17.1.0 от 30.10.2026) покрывает все 7 нужных CMP; Consent-O-Matic (MIT) — 4/7 и год без коммитов; для CONSENT-04 нужен свой слой семантики кнопок первого уровня. PSL — tldts (MIT). GeoIP: MaxMind GeoLite2 не вшивать (EULA 12.02.2026: 30-дневное уничтожение, flow-down), по умолчанию DB-IP Lite (CC BY 4.0, без аккаунта) + iptoasn (PDDL); GeoIP ≠ Drittlandtransfer — нужен собственный каталог получателей. Уязвимости: WPScan и Patchstack API — нельзя без договора; WPVulnerability (CC0, без ключа) + Wordfence v3 (бесплатный ключ) для WP; retire.js (Apache-2.0) для JS; OSV/GHSA для TYPO3/Drupal/Composer; CISA KEV (CC0) ∪ CVSS AV:N/PR:N ∪ EUVD exploited → critical. Форки Wappalyzer — GPL-3.0, в Apache-2.0-репо не вендорить; MVP на собственных отпечатках. Самим вести: каталог сервисов с немецкими алиасами (PRIV-01, crmCode), семантику CMP, allowlist cookie, отпечатки, adequacy.json, файл атрибуций.

**Ключевые решения**

- **Классификация сторонних доменов** (high): Основа — собственный каталог сервисов (Apache-2.0) + third-party-web (MIT) как fallback + EasyPrivacy/EasyList Germany через @ghostery/adblocker (кэш при запуске, атрибуция EasyList authors) + Open Cookie Database (Apache-2.0) + cname-trackers (MIT). Tracker Radar, Disconnect, TrackerDB, cookiedatabase.org, Cookiepedia — не использовать (NC/проприетарно).
- **Правила CMP** (high): @duckduckgo/autoconsent (MPL-2.0) как движок detect/optOut — покрывает Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub; поверх — собственный cmp-semantics.json (reject/accept/settings первого уровня, немецкие подписи) для CONSENT-04. Consent-O-Matic — только референс. IAB cmp-list не вендорить, читать __tcfapi на странице.
- **Public Suffix List** (high): tldts (MIT, PSL внутри под MPL-2.0); allowPrivateDomains для хостинговых доменов; CNAME-cloaking через dns.resolveCname + cname-trackers.
- **GeoIP и передача за пределы ЕС** (medium): По умолчанию DB-IP Lite Country+ASN (CC BY 4.0, загрузка при update/сборке, ссылка-атрибуция в отчёте) + iptoasn (PDDL) для ASN→организация; MaxMind GeoLite2 и IPinfo Lite — только опционально по ключу пользователя, не в репо/образе. В отчёте два поля: страна/ASN IP (доказательство) и страна получателя из каталога сервисов; собственный adequacy.json; DPF-статус — ручное поле.
- **База уязвимостей для VULN-01/02** (medium): WordPress: WPVulnerability.net (CC0, без ключа) по умолчанию + Wordfence Intelligence v3 (бесплатный ключ, free for commercial) опционально; JS: retire.js jsrepository (Apache-2.0, вендорить+обновлять); TYPO3/Drupal/Joomla/Composer: OSV.dev API (+опц. офлайн-снапшот Packagist/npm); critical = KEV (CC0, вендорить снапшот) ∪ CVSS AV:N/PR:N/UI:N high impact ∪ EUVD exploited (opt-in). WPScan и Patchstack — нельзя без договора; NVD — только обогащение.
- **Фингерпринтинг версий** (high): Собственный набор отпечатков CMS/плагинов под Apache-2.0 (писать с нуля) + экстракторы retire.js; форки Wappalyzer (GPL-3.0) не вендорить, максимум opt-in загрузка в кэш; js-library-detector (MIT) опционально.
- **Политика лицензий в репозитории** (high): В репо и Docker-образе только CC0/PDDL/MIT/Apache/CC BY; CC BY-SA и GPL — только в кэше пользователя отдельными файлами, не сливать с каталогом; NC — никогда; собственный каталог формировать из своих аудитов и документации вендоров (§87a UrhG), THIRD_PARTY_NOTICES.md и атрибуции в футере отчёта, манифест снапшотов с датой в report.meta.datasets.

**Открытые вопросы**

- Wordfence Intelligence v3: прочитать Terms (26.01.2026) живым браузером — коммерческое использование, текст атрибуции, rate-limit полной выгрузки, стабильность схемы
- ENISA EUVD: официальные условия использования API/данных (страница /apidoc рендерится JS); запросить ENISA
- AdGuard companiesdb: правомерность CC BY-SA 4.0 при NC-источнике TrackerDB — уточнить у AdGuard
- IAB cmp-list.json: можно ли кэшировать нерегистрированному инструменту; вероятно снимается чтением __tcfapi('ping')
- NVD: подтвердить точный текст ToU/notice и лимиты 5/50 req/30 s на nvd.nist.gov (страница за JS-челленджем)
- IP2Location LITE: противоречие CC BY-SA 4.0 (блог) vs «not permitted to redistribute» (Terms)
- GeoLite2 EULA: юридическая оценка заказчика, допускает ли §3/§6.1 включение в публичный Docker-образ
- §87a UrhG: согласовать правило формирования собственного каталога только из своих аудитов и первичных источников
- DPF/C-703/25 P: формулировка в отчёте для US-получателей при неопределённости апелляции
- WPVulnerability: полная схема ответа (cvss/impact, данные Patchstack), договорённость о reasonable use/донате для коммерческого использования
- retire.js: какой jsrepository-vN.json потребляет CLI 6.x, отличия v6 от v4; достаточно ли 76 библиотек для топа VULN-02
- GPL-данные при запуске (AdGuard filters, Wappalyzer-форки): исключить полностью или допустить opt-in загрузку в кэш
- Политика частоты загрузки EasyList для инструмента, запускаемого в CI многими клиентами
- Лицензия контента drupal.org/typo3.org для цитирования advisories в отчёте

**Не подтверждено**

- Текст Wordfence Intelligence Terms and Conditions и формулировка «free for personal and commercial use» для v3 — сайт отдаёт боту пустой ответ (202); известно по поисковой выдаче и стороннему клиенту; дата отключения v1/v2 (09.03.2026) и размер фида ~158 МБ/42,5 тыс. записей — вторичные источники
- Условия использования API ENISA EUVD; эндпоинты /api/enisaid и /api/vulnerability — по community-OpenAPI
- Лимиты NVD (5/30 s без ключа, 50/30 s с ключом, sleep 6 s), дата отключения JSON-фидов и точный текст notice — по вторичным источникам (страницы nvd.nist.gov за JS-челленджем)
- Лицензия IP2Location LITE — противоречие между блогом (CC BY-SA 4.0) и страницей Terms
- Актуальный перечень решений ЕС об адекватности на октябрь 2026 (UK-продление, Бразилия) и статус апелляции C-703/25 P после июня 2026
- Распределение Google Fonts/Maps/reCAPTCHA/YouTube по категориям в third-party-web (не проверял по записям)
- Имена npm-пакетов sapics/ip-location-db; политика частоты загрузок серверов EasyList
- Полная схема ответа WPVulnerability (наличие cvss/impact, включение Patchstack); ToS api.wordpress.org и TER REST API
- Лицензия контента drupal.org и typo3.org; формат JSON-feed Joomla VEL (редирект)
- Какой CVE jQuery из CISA KEV имелся в виду в каталоге проверок (VULN-02, jQuery 3.4.1)
- Точное содержание v3-схемы Wordfence (перечислены поля по v2-документации)

## browser (opus) — `docs/01-research/browser-automation.md`

Отчёт по браузерной части готов. Версии на 2026-10-30: Playwright 1.64.1, Chromium 156.0.8078.4 (Chrome for Testing и headless shell).

Главный риск — CMP ведут себя для сканера иначе, чем для человека. По исходникам Borlabs 3.5 (cookiesForBots), Real Cookie Banner (accept-all-for-bots, по умолчанию включён), Complianz и Cookiebot (isSpider → setOutOfRegion) для бота принимают всё. Это даёт ложные CONSENT-01/03.

Честный UA со ссылкой (и само имя dsgvo-check через `check\b`) распознают как бота isbot и RCB. Дефолтный HeadlessChrome распознают isbot, RCB и Usercentrics.

Второй риск — гео. GitLab-раннеры в us-east1. Usercentrics, Cookiebot и Complianz вне ЕС не показывают баннер или показывают другой.

Эксперимент (Docker и Chrome 156) подтвердил:
- headless-shell оставляет HeadlessChrome в Sec-CH-UA даже после подмены UA;
- beacons на pagehide до сервера доходят, но Playwright их не видит;
- в newContext() Chrome вообще не делает preconnect, в persistent-профиле делает;
- 3P cookies и CHIPS работают;
- Chromium sandbox в Docker с дефолтным seccomp не поднимается.

Рекомендации:
- основа — события context.on, CDP добавочно, page.route не использовать;
- свой алгоритм ожидания тишины вместо networkidle;
- фазы A, A′, B, C, каждая в свежем профиле;
- 7 своих адаптеров CMP, autoconsent только как помощник;
- детекторы SCAN-BOTMODE и SCAN-GEO;
- декодирование gcs/gcd с учётом region;
- CfT new headless в своём slim-образе без root.

**Ключевые решения**

- **Захват сети** (high): Основа — context.on('request'/'response'/'requestfinished'/'requestfailed') с подпиской до первой навигации. CDP-сессия добавочно: initiator, ExtraInfo (blockedCookies, cookiePartitionKey), Preload. page.route для наблюдения не использовать: отключает HTTP-кэш. Пробелы (beacons на выгрузке, preconnect) закрывать NetLog и разбором DOM и Link-заголовков.
- **Ожидание загрузки** (high): Вместо networkidle (DISCOURAGED): domcontentloaded, затем load (не фатально), MIN_DWELL 6 с, окно тишины 2 с при inflight ≤ 1, HARD_CAP 20 с. Флаг quietNotReached пишется в evidence. Параметры откалибровать на 10 эталонных сайтах.
- **Режим браузера** (medium): По умолчанию CfT new headless (channel:'chromium'): headless-shell отдаёт HeadlessChrome в Sec-CH-UA даже после подмены UA (проверено). Shell — опция --engine shell.
- **Профиль на фазу** (medium): Каждая фаза (A до согласия, A′ нейтральная интерактивность, B после отказа, C после принятия) в свежем временном профиле launchPersistentContext. newContext() ведёт себя как Incognito: preconnect не выполняется (проверено). Финализировать замером.
- **User-Agent** (medium): Реальный Chrome UA с версией движка плюс токен продукта, без HeadlessChrome. Обязателен рантайм-детектор бот-режима CMP (Cookiebot.isSpider/isOutOfRegion, consent-cookie без клика) → понижение до SCAN-BOTMODE. Оставлять ли ссылку на репозиторий в UA браузера — решает заказчик: isbot и RCB распознают её как бота.
- **Гео** (high): Всегда читать гео-сигналы CMP: CookieConsent=-1, gdprApplies, __ucCmp.isConsentRequired(), complianz.region, Borlabs GeoIP. Нет баннера + гео-сигнал → SCAN-GEO вместо CONSENT-03. Плюс --proxy и self-hosted runner в ЕС. Недокументированный ?uc_cmp_country=DE (Cookiebot и Usercentrics v3) — только опцией.
- **CMP и CONSENT-04** (high): Собственные адаптеры для 7 CMP: JS-API только для чтения, клик только через locator.click() без force. Тройная проверка эффекта: UI закрылся, состояние CMP или consent-cookie = отказ, нет трекеров. Неизвестный баннер или низкая уверенность → info «Banner nicht erkannt». autoconsent 17.1.0 (MPL-2.0) — только детекция, эвристики и селекторы: его opt-out бывает через API, второй уровень или cosmetic.
- **Consent Mode v2** (medium): Default читать из dataLayer с учётом region (оценка для DE). gcs (G1xy) и gcd декодировать побитово: idx>>2 = default, idx&3 = update; 1 = не задано, 2 = denied, 3 = granted. sGTM и tag gateway распознавать по путям /g/collect, gtm.js/gtag с first-party хоста, server_container_url и FPID.
- **Обход сайта** (medium): По умолчанию 6 страниц: стартовая, Impressum, Datenschutz, Kontakt и 2 по ключевым словам или sitemap. Навигации последовательно с паузой ≥ 1.5 с, 429/Retry-After соблюдать, счётчик собственных запросов в отчёте. robots.txt — для дополнительных страниц. Бюджет 2.5–4 мин. LEGAL-01 — на каждой посещённой странице, включая '#'-ссылки и перекрытие баннером.
- **Docker и PDF** (medium): Свой slim-образ: только Chromium, не-root, tini, шрифты; режим --sandbox auto с честным fallback на --no-sandbox, потому что с дефолтным seccomp sandbox не поднимается (проверено). Отчёт — self-contained HTML без внешних шрифтов и CDN. PDF через page.pdf (tagged, outline) отдельным шагом из JSON.

**Открытые вопросы**

- Ссылка на репозиторий обязательно в UA браузера (принимаем бот-режим у RCB и isbot) или достаточно UA HTTP-проб плюс --contact e-mail в заголовке From?
- Менять ли рабочее имя dsgvo-check: срабатывает `check\b` в isbot и RCB?
- Делать ли --proxy или ЕС-раннер обязательными для строгого режима --fail-on critical? Как оценивать CONSENT-03/04 без ЕС-выхода?
- Находки фазы A′ (скролл, мышь, без клика) приравнивать к CONSENT-01 или давать отдельный уровень?
- Разрешать ли CONSENT-04 уровня critical по эвристике для неизвестных CMP (score ≥ 0.8) или только warning?
- Уровень и ID для Advanced Consent Mode (cookieless pings до согласия)?
- Код выхода, если сайт недоступен или заблокирован WAF: 2 или отдельная находка?
- Соблюдать ли robots.txt для дополнительных страниц по умолчанию?
- Persistent-профиль на фазу или newContext() — решить по замеру на 10 эталонных сайтах.
- Нужен ли PDF/A? Включать ли HAR и скриншоты в артефакты CI по умолчанию?

**Не подтверждено**

- Регионы GitHub-hosted runners: официально не документированы, есть только ответ в Community от 2021 года (5 регионов Azure в США)
- Как Usercentrics v3 применяет isUserBot (скрыть баннер или принять всё); бот- и гео-логика CCM19 и CookieHub; JS-API CCM19
- Учитывает ли сервер Cookiebot и Usercentrics параметр uc_cmp_country (в коде он есть, в документации нет); sessionStorage-override у Usercentrics v2
- Опция «Cookies for Bots» в Borlabs v2 (известна по вторичным источникам); Country Bypass и гео-решения Real Cookie Banner Pro
- Причина отсутствия preconnect в newContext() (предположительно off-the-record-профиль); dns-prefetch в NetLog не наблюдался
- Ловит ли трюк с bringToFront() beacons на visibilitychange
- Какие origin-ы попадают в storageState().origins (third-party iframes); чтение закрытого shadow DOM через CDP DOM.getDocument(pierce)
- Seccomp-профиль Playwright на linux/amd64 (в OrbStack/arm64 контейнер не стартовал); нужен ли --ipc=host при --disable-dev-shm-usage
- Размер собственного slim-образа (известны только архивы браузеров: 200 и 126 МБ)
- Спецификация gcd: официальной от Google нет, семантика букв — по сообществу и шаблону analytics-debugger
- Набор cookies sGTM (FPID/FPLC/FPAU) и список эндпоинтов Google tag gateway
- Дословный текст EDPB Guidelines 05/2020, Rn. 86 (скролл); PDF в headed-режиме; PDF/A
- serverAddr() за HTTP-прокси возвращает адрес прокси (предположение)

## net-dns-tls (fable) — `docs/01-research/http-dns-tls-mail.md`

Ресёрч не-браузерных проверок dsgvo-check записан в docs/01-research/http-dns-tls-mail.md. Главное: (1) Node 26 — Active LTS с 28.10.2026, Node 24 — Maintenance; целимся на engines>=24, CI 24+26; всё нужное есть в ядре (undici, X509Certificate, resolveCaa). (2) HDR-01: шкала MDN Observatory (модификаторы из charts.js) + значения OWASP headers_add.json; CSP предлагаю только info, Referrer-Policy с unsafe-значением — warning как DSGVO-утечка. (3) TLS-02 без библиотек через tls.connect + authorizationError + X509Certificate; экспериментально выявлено, что при ошибке цепочки Node не проверяет имя — checkHost делаем сами; неполная цепочка — warning. (4) TLS-04 в Node работает с ciphers 'DEFAULT@SECLEVEL=0' (OpenSSL 3.5 default SECLEVEL=2) — подтверждено локальным тестом с кодами ошибок; альтернатива — сырой ClientHello; testssl.sh/sslyze (GPL/AGPL) только внешним процессом. (5) DMARC теперь RFC 9989 (май 2026): tree walk, теги np/psd/t, удалены pct/rf/ri. (6) DKIM: ~40 селекторов с MX-приоритетом; немецкие хостеры (All-Inkl, Hetzner, Strato) не подтверждены. (7) DNSSEC: node:dns без AD — dns-packet + сырой DNS/DoH (opt-in). (8) FILE-01: фиксированный список ~30 путей, сигнатуры, soft-404-базлайн, Range 4 KiB, редактирование; юридический контекст Modern Solution. (9) VULN: уверенность exact/range/unknown с понижением уровня; webappanalyzer GPL-3 не брать. (10) LEGAL-02 регулярки: TMG→DDG, RStV→MStV, TTDSG→TDDDG, ODR-платформа закрыта 20.07.2025.

**Ключевые решения**

- **Платформа Node.js** (high): engines.node >= 24, CI-матрица Node 24 (Maintenance) + Node 26 (Active LTS с 28.10.2026); импортировать fetch/request из пакета undici, а не глобальный fetch
- **Общий HTTP-клиент** (high): undici Agent с interceptors retry/dns, ручные редиректы, per-host p-limit + token bucket (≤4 req/s, конкуррентность 3), таймауты 5/10/15 s, лимит тела, честный UA, журнал запросов как источник evidence; got/ky/axios не нужны
- **HDR-01 правила оценки** (medium): Порядок важности по модификаторам MDN Observatory (HSTS −20, XFO −20, CSP −25, nosniff −5, Referrer-Policy 0/−5), значения из OWASP headers_add.json; уровни: HSTS/frame-ancestors отсутствуют → warning, CSP/nosniff/Permissions-Policy отсутствуют → info, Referrer-Policy unsafe-url → warning
- **TLS-02 реализация** (high): Ядро Node: tls.connect(rejectUnauthorized:false) + authorizationError + crypto.X509Certificate; отдельно checkHost (Node не проверяет имя при ошибке цепочки); истёк/самоподписан/имя не совпадает → critical, неполная цепочка → warning
- **TLS-04 (TLS 1.0/1.1)** (high): Проверять из Node с ciphers 'DEFAULT@SECLEVEL=0' и min/maxVersion; успех → принимает, ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION → не принимает, handshake_failure → неясно; план Б — сырой ClientHello; testssl.sh/sslyze только опционально после MVP
- **DMARC** (high): Реализовать по RFC 9989 (DNS Tree Walk ≤8 запросов, теги np/psd/t), парсить историческое pct как info; нет записи или p=none → warning
- **SPF** (high): Свой статический парсер со счётчиком ≤10 lookups и ≤2 void; +all/?all/нет записи → warning; ~all → warning без DMARC-enforcement, info с ним
- **DKIM-селекторы** (medium): ≤40 TXT-запросов, порядок по MX; отсутствие при известном провайдере (Google/M365/IONOS) → warning, иначе info «unter N Selektoren nicht gefunden»; немецкие хостеры дособрать из реальных писем
- **DNSSEC из Node** (medium): dns-packet + сырой DNS к системному резолверу с DO-битом (DS и AD), DoH к Quad9/др. только opt-in из-за приватности; dohdec не брать (конфликт лицензий MIT/MPL)
- **FILE-01** (high): Фиксированный список ~30 путей с сигнатурами/магическими байтами, soft-404-базлайн из 3 случайных путей, Range 0-4095 + destroy, редактирование секретов, тело не сохраняется, флаг --no-files
- **ADMIN-01** (high): Только если WP обнаружен: GET /wp-json/wp/v2/users, /?author=1 (без редиректа), /xmlrpc.php; пользователи+xmlrpc → warning, иначе info; без попыток входа
- **VULN уверенность версии** (medium): exact/range/unknown; range понижает уровень на ступень, unknown → только info без CVE; readme.txt Stable tag и style.css Version для WP; retire.js данные для JS; EOL-мажор → warning
- **Отпечатки CMS** (high): Свой минимальный набор; enthec/webappanalyzer (GPL-3.0) и deprecated wappalyzer не использовать в Apache-2.0 проекте
- **SEC-01 и LEGAL-02** (high): security.txt по RFC 9116 своим парсером (Contact, Expires обязательны) — всё info; LEGAL-02 регулярки TMG→DDG, RStV→MStV, TTDSG→TDDDG, ODR-платформа (закрыта 20.07.2025), Privacy Shield — info с исключением исторического контекста

**Открытые вопросы**

- Уровень для отсутствующего CSP в HDR-01: info (моё предложение) или warning по Observatory (−25)?
- TLS-01 при «http отдаёт 200, https исправен»: warning или эскалация до critical при наличии формы на странице?
- TLS-04: Node-клиент с SECLEVEL=0 или сырой ClientHello как основная реализация?
- DKIM-селекторы All-Inkl, Hetzner, Strato, mailbox.org, CleverReach, rapidmail, Mailjet — подтвердить по реальным письмам до этапа 3
- Принять ли отключённый по умолчанию DoH (DNS-01 часто даст «nicht prüfbar» на системном резолвере)?
- Матрица MAIL-* при Null MX / отсутствии MX (§3.6) — согласовать
- Состав списка FILE-01 (≤30 путей) — сократить/расширить?
- Формулировка ADMIN-01 про раскрытие имён сотрудников — зона заказчика
- KEV-правило = critical для jQuery <3.5.0 даёт много critical — оставить или смягчить?
- Поддержка Node 26 текущим Playwright (1.64.x) — проверить engines
- Лицензии данных: Wordfence Community Edition (атрибуция), endoflife.date, mdn-http-observatory
- Актуальный статус реформы § 202a StGB на 10/2026

**Не подтверждено**

- OpenSSL 3.5.8 в официальных сборках Node 24.21.0/26.8.2 — вторичный источник; локально Node 24.21.0 был с OpenSSL 3.6.4 (Homebrew)
- Playwright требует Node ≥20 и поддерживает Node 26 — вторичный источник, engines не проверены
- Strato DKIM-селекторы strato-dkim-0002/0003 и mailbox.org MBO0001–0004 — только форумы/блоги
- DKIM-селекторы All-Inkl, Hetzner, CleverReach, rapidmail, Mailjet, web.de/GMX, Posteo — не найдены
- dns0.eu DoH-эндпойнт и политика — страница не открылась из песочницы
- Quad9 отключил HTTP/1.1 для DoH с 15.12.2025 — вторичный источник
- Cloudflare Minimum TLS Version по умолчанию 1.0 — вторичные источники, официальная дока дефолт не называет
- Даты по делу Modern Solution (LG Aachen 04.11.2024, OLG Köln 07/2025, BVerfG) — по borncity/heise, оригиналы решений не проверены
- Статус реформы § 202a StGB на 10/2026 — только Stellungnahmen 08/2026 в Lobbyregister
- Wordfence Intelligence: требование атрибуции Community Edition и API-ключ для v3 — страницы не открылись
- Поведение /wp-json/wp/v2/users для неаутентифицированных (только авторы с публикациями) — по коду ядра WP, в доках REST API не описано
- window.next.version как источник версии Next.js для App Router
- Формат jsrepository (v4/v5/v6), который читает retire 6.1.0
- Эвристика Observatory «сессионная cookie» (имя содержит sess/login) — точная формулировка
- EOL-даты Joomla 4 (10/2025), Drupal 7 (01/2025), PHP 8.1 (31.12.2025); расхождение источников по сроку TYPO3 12.4 ELTS (10/2027 vs 04/2030)
- Лицензия mdn-http-observatory (MPL-2.0?) и данных endoflife.date
- Поддержка RFC 9989 tree walk в mailauth; поддержка DO-бита в dns2
- --use-system-ca доступен с Node 22.15+/23.8+ — версия не проверена
- Удаление теста X-XSS-Protection в Observatory v2

## engineering (opus) — `docs/01-research/engineering-ci-distribution.md`

Engineering research for dsgvo-check. Versions checked against the registries on 2026-10-30.

**Stack.**
- Node 24 in the Docker image and the Action. Node 26 became Active LTS on 2026-10-28. CI runs Node 22/24/26.
- TypeScript 7.0.2 (native tsc). typescript-eslint is incompatible with it: peer typescript <6.1.
- Playwright 1.64.1 via playwright-core, pnpm 11, Vitest 5, Biome 2.6, plus oxlint-tsgolint for promise rules.

**Architecture.** collectors → JSON artifacts → pure-function checks → reporters, following the Lighthouse model.
- Checks are tested without a browser.
- A new check is a folder plus one line in the checks layer, with a completeness test.

**Tests, four levels.**
- L1: unit tests on recorded artifacts.
- L2: Chromium inside `docker --network none`, with host-resolver-rules, a test CA and dns2.
- L3: e2e for the CLI, the image and the Action.
- L4: nightly canary in a private repo.

**Report.** zod 4 → JSON Schema 2020-12 checked by Ajv. Independent semver, fingerprint over a stable key. SARIF and GitLab Code Quality are out of the MVP (both need a file path and line); JUnit is in.

**CI.** The GitHub Action is composite and runs `docker run` on a digest-pinned image. A Docker action must run as root, which disables the Chromium sandbox. GitLab gets a Catalog component plus `include:remote` with `integrity`.

**Security.** Flip Playwright's defaults to `chromiumSandbox: true` and `acceptDownloads: false`. Block private networks. Ship a static HTML report with CSP. Sanitize logs. Redact cookie values and FILE-01 bodies.

**Accuracy risks.** Bot-detection and geo-targeting in CMPs.

**Releases.** release-please v5, npm OIDC with staged publishing, attest/SBOM, Renovate.

**Ключевые решения**

- **Runtime и версии** (high): Node 24 в образе/Action (Playwright-образ и GitHub JS-actions на 24), CI-матрица 22/24/26, engines >=22.12; Playwright через playwright-core@1.64.1 с точным пином
- **TypeScript и линт** (medium): TS 7.0.2 (tsc для typecheck/emit, isolatedDeclarations) + Biome 2.6 + oxlint-tsgolint для no-floating-promises; TS 6.0.3 как fallback, если нужен typescript-eslint (peer <6.1.0)
- **Пакетный менеджер** (medium): pnpm 11.x (supply-chain дефолты: minimumReleaseAge 1 день, strictDepBuilds); не 12.x (Rust-переписывание, 2 месяца); не полагаться на Corepack (не поставляется с Node 25+)
- **Архитектура и расширяемость** (high): collectors → versioned JSON artifacts → pure checks → reporters; явный реестр в слое checks + тест полноты (фикстуры violation/clean, сообщения de/en, crmCode); внешние плагины только явным opt-in (P2)
- **Структура репозитория** (medium): pnpm-workspace с одним публикуемым пакетом dsgvo-check + приватные fixture-server/test-utils; action.yml в корне; отдельные репо: example (красная сборка), GitLab-компонент на gitlab.com, приватная канарейка
- **Тестовая стратегия** (high): Vitest 5; L1 артефакты без браузера; L2 Chromium в docker --network none с --host-resolver-rules и единой картой хостов для Chromium и Node-резолвера, тестовый CA, dns2; golden JSON через toMatchFileSnapshot + Ajv-контракты; канарейка non-gating в приватном репо
- **Схема отчёта** (high): zod 4 → JSON Schema 2020-12 (закоммичена, CI-drift-check), Ajv 8 в контрактных тестах, schemaVersion semver независим от тула, открытые enum для evidence.type, fingerprint = sha256(JCS{checkId, scope eTLD+1, key}), suppress с обязательными reason+expires
- **Форматы вывода** (medium): MVP: JSON, консоль, GitHub Job Summary; P1: статичный HTML без JS, JUnit; P2: SARIF, GitLab Code Quality (оба требуют путь+строку), PDF
- **GitHub Action** (high): Composite-action, оборачивающий docker run образа по digest с --user non-root, seccomp, cap-drop ALL, no-new-privileges, read-only, лимиты; inputs только через env; Docker-action отвергнута (root обязателен → нет sandbox)
- **GitLab** (high): CI/CD Catalog component на gitlab.com (entrypoint: [""], junit-артефакт) + include:remote с integrity (GitLab ≥17.9) для self-managed
- **Docker-образ и установка браузера** (medium): Свой node:24-slim + Chromium (headless shell или CfT), multi-arch нативно, GHCR; в npm-режиме браузер ставится командой dsgvo-check install, без postinstall
- **Релизы и supply chain** (high): release-please v5 (extra-files для action.yml/шаблонов), npm Trusted Publishing + staged publishing с 2FA, actions/attest@v4 push-to-registry или cosign v3, SBOM (pnpm sbom + BuildKit), Renovate с группой Playwright, OpenSSF Scorecard, actions по SHA
- **Безопасность сканера** (high): chromiumSandbox: true (fallback с предупреждением, --require-sandbox), acceptDownloads: false, минимальный env браузера, блок private/link-local/IMDS при публичной цели, статичный HTML с CSP и без внешних ресурсов, санитизация ANSI/bidi/workflow-команд, хеши вместо значений cookies, FILE-01 без тел
- **Достоверность сканирования** (medium): UA = обычный Chrome UA + 'dsgvo-check/x.y (+URL)' без bot/crawler/Headless; locale de-DE, TZ Europe/Berlin; опция --proxy для EU-egress; поле scan.egress в отчёте
- **Локализация** (medium): data/messages/{de,en}.yaml с ICU MessageFormat 1 (intl-messageformat), компиляция в JSON; L0-тесты паритета ключей/плейсхолдеров и стоп-слов юридических выводов для de; CODEOWNERS заказчику

**Открытые вопросы**

- Где хостится основной репозиторий и есть ли группа на gitlab.com для Catalog-компонента; нужна ли поддержка self-managed GitLab?
- Headless shell или new headless (channel 'chromium'): достоверность против размера образа — замерить на 10 сайтах заказчика
- Обязателен ли EU-egress для доказательных прогонов (геотаргетинг CMP)?
- Подтверждает ли заказчик правило exit-кода 2 при ошибке любой проверки (никогда не зелёный, если не всё проверено)?
- Является ли crmCode частью публичного контракта схемы; смена маппинга — minor или major?
- Язык по умолчанию консоли/отчёта (всегда de или по LANG) и рендерить ли тексты в JSON
- Канарейка: согласие владельцев 10 сайтов, кто размечает mustFind/mustNotFind, где хранить отчёты
- Достаточно ли хешей значений cookies и маскированных query-параметров для доказательной базы аудита
- Лицензия немецких текстов находок/дисклеймера и DCO/CLA
- Нужен ли листинг в GitHub Marketplace
- Поддерживать ли npm-режим на Windows/macOS
- Политика пересборки образа: перезапись версионных тегов или теги с датой
- Sandbox по умолчанию: fallback с предупреждением или fail-closed

**Не подтверждено**

- Поддержка переназначения порта (MAP host ip:port) именно в --host-resolver-rules Chromium
- Доверие chromium-headless-shell к тестовому CA, добавленному в NSS DB (~/.pki/nssdb)
- Применение Set-Cookie из route.fulfill() к cookies контекста
- Возможность поднять TLS 1.0-сервер и клиент в Node 24/26 с ciphers DEFAULT@SECLEVEL=0
- Передаются ли ACTIONS_RUNTIME_* токены в контейнер Docker-action на GitHub-hosted раннерах
- Поддержка Debian 13 (trixie) командой playwright install --with-deps; итоговый размер своего образа (оценка 300–450 МБ сжатого)
- Работа Chromium user-namespace sandbox в контейнерах на хостах Ubuntu 24.04 (AppArmor-ограничения userns)
- Регион GitHub-hosted раннеров (только community-обсуждения) и поведение Cookiebot для краулеров (первоисточник вернул 403)
- Поддержка OIDC trusted publishing в pnpm publish; с какой версии есть pnpm sbom
- Полнота declaration emit в TS 7.0 (vs tsdown); детали TS 7 breaking changes взяты из вторичных источников (InfoQ, Visual Studio Magazine)
- Совместимость immutable releases с загрузкой ассетов release-please (draft → publish)
- Актуальность флага --force-webrtc-ip-handling-policy и поведение Local Network Access в headless
- Корректность ::stop-commands:: (не перепроверено в этой сессии)
- spec:inputs для include:remote в GitLab
- Год релиза scorecard-action v2.5.0 (страница показывает только '12 Oct')
- Предустановленный Google Chrome на GitHub-hosted Ubuntu-раннерах
- Удаление Corepack из Node 25+ подтверждено частично (TSC PR и редирект страницы docs; часть деталей через зеркала)

