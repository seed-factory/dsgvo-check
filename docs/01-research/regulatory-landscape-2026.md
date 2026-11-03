# Регуляторный ландшафт для `dsgvo-check` — Rechtsstand 30.10.2026


> Этап 0: исследовательский анализ.
> Документ — вход для дизайна проверок, уровней и немецких формулировок. Это не юридическая консультация (keine Rechtsberatung); финальные тексты находок и дисклеймер готовит заказчик.

**Легенда достоверности** (ставится у каждого факта, где это существенно):

- ✅ — проверено в этой сессии по первоисточнику: текст нормы на gesetze-im-internet.de, PDF DSK/EDPB/BSI, пресс-релиз EuGH, живой ответ API.
- 🔶 — официальная страница без чтения полного текста или ≥2 согласованных вторичных источника (юрфирмы, IHK, отраслевые СМИ).
- ⚠ проверить — один источник, противоречия между источниками или знание «по памяти».

---

## Коротко

1. **Действующая база по cookies не менялась по существу с 2021 года.** § 25 TDDDG (это бывший TTDSG, переименован с 14.05.2024 ✅) плюс Art. 6/7 DSGVO. Impressum — § 5 DDG (заменил § 5 TMG с 14.05.2024 ✅). Главный машинно-применимый ориентир для CONSENT-* — **DSK OH Digitale Dienste v1.2 (11/2024)** ✅. EinwV (PIMS) действует с 01.04.2025 🔶, но участие в ней **добровольное** (§ 18 Abs. 1 EinwV ✅). На баннеры она практически не влияет.
2. **Digital Omnibus — пока не закон, и в горизонте 12 месяцев проверки CONSENT-* он не изменит.** Комиссия (19.11.2025, COM(2025) 837) предлагала перенести cookies в DSGVO (Art. 88a) и обязать уважать браузерные сигналы (Art. 88b). Совет 18.06.2026 вычеркнул 88b 🔶, а мандат от 21.10.2026 (по вторичным источникам 🔶) возвращает правила в Art. 5(3) ePrivacy-RL: закрытый список исключений, отказ одним кликом, повторный запрос не раньше чем через 4 месяца. Комитеты ЕП не голосовали ✅ (ожидается начало 2027 ⚠). При директивной модели добавляется 24 месяца на транспозицию, так что реальная смена правил в DE — около 2029 ⚠ (прогноз).
3. **CONSENT-04 нужно переформулировать.** По DSK Rn. 124–125 ✅ отказ на первом уровне обязателен, когда баннер **блокирует** использование сайта; на практике это «sehr häufig». Rn. 137 ✅: кнопка «Einstellungen oder Ablehnen» отказом не считается. VG Hannover 10 A 5385/22 (19.03.2025) и OLG Köln 6 U 80/23 (19.01.2024) 🔶 эту линию подтверждают. Детектор должен различать блокирующий и неблокирующий баннер (desktop и mobile) и смотреть на подпись и равноценность кнопок.
4. **Покрытие CONSENT-01/02 нужно расширить.** Сюда входят Web Storage (DSK Rn. 21 ✅), пиксели, URL-трекинг и cookieless-пинги (EDPB Guidelines 2/2023 v2.0, 07.10.2024, Rn. 47–55 ✅), а также загрузка GTM до согласия (VG Hannover 🔶). First-party и server-side трекинг надо распознавать по сигнатуре запроса, а не только по стороннему домену. Server-to-server передачу (CAPI, Measurement Protocol) пассивный сканер не видит; в отчёте это надо прямо назвать.
5. **Для EMBED-01…05 основная опора — Art. 6 DSGVO** (раскрытие IP третьему лицу; DSK Rn. 101 ✅ прямо называет шрифты, карты и видео), а § 25 добавляется, когда есть запись в хранилище. По Google Fonts есть единственное решение LG München I (3 O 17493/20, 100 €) 🔶 и волна злоупотреблений: искусственно созданный «ущерб» не возмещается (LG München I 4 O 13063/22 🔶; EuGH C-526/24 Brillen Rottler, 19.03.2026 ✅). Значит, EMBED-01 по умолчанию — `warning`, без «Abmahn»-риторики.
6. **Какие находки «стреляют».** Конкуренты могут преследовать нарушения DSGVO через UWG (EuGH C-21/23 🔶; BGH I ZR 222/19 и I ZR 223/19 от 27.03.2025 🔶). Против компаний до 250 сотрудников возмещение расходов на абмахнунг исключено (§ 13 Abs. 4 Nr. 2 UWG ✅). По Art. 82 нужен реальный ущерб (C-300/21 🔶), но потеря контроля уже считается ущербом, суды присуждают около 100 € (BGH VI ZR 10/24 🔶). Вывод: доказательная база важнее громких формулировок, а сам инструмент не должен превращаться в генератор абмахнунгов.
7. **У security-проверок есть нормативная опора, но разной силы.** TLS-01/02/04 опираются прямо на § 19 Abs. 4 TDDDG: «Stand der Technik» и «als sicher anerkanntes Verschlüsselungsverfahren» ✅. Пороговые значения берём из BSI TR-02102-2 (редакция 2026-01): TLS 1.3 предпочтителен, TLS 1.2 допустим до конца 2031 года, TLS 1.0/1.1 не рекомендованы ✅. HDR-01 (CSP, Permissions-Policy и т. п.) — только «Stand der Technik», конкретной нормы нет, поэтому `info`/`warning`. NIS2UmsuCG (в силе с 06.12.2025 🔶, § 30 BSIG ✅) касается только NIS2-субъектов.
8. **MAIL-02 в текущем виде противоречит BSI.** По BSI TR-03182 v1.0 (24.01.2024 ✅) `~all` (SoftFail) **допустим**. DMARC обязателен (MUST); `p=reject` — SHOULD, `quarantine` или `reject` ожидается. Поэтому `~all` при DMARC `quarantine`/`reject` понижаем до `info`. Стоит добавить проверку неиспользуемых доменов (Null MX + `-all` + DMARC `reject`, TR-03182-11-M ✅).
9. **BFSG (с 28.06.2025 ✅) касается только B2C-«Dienstleistungen im elektronischen Geschäftsverkehr»**, Kleinstunternehmen для услуг исключены (§ 3 Abs. 3 BFSG ✅). Сканер не знает ни размер компании, ни модель B2C, поэтому BFSG-01 — `info` с оговоркой о применимости. Отдельный детектируемый пункт: «Informationen zur Barrierefreiheit» (§ 14 Abs. 1 Nr. 2 BFSG + Anlage 3 ✅).
10. **VULN.** CRA (репортинг с 11.09.2026 🔶) обязывает производителей, а не операторов сайтов. Нормативная опора VULN — Art. 32 DSGVO и § 19 Abs. 4 TDDDG. EUVD (с 13.05.2025 🔶) отдаёт публичный API без ключа, включая список exploited ✅. Явной лицензии на данные EUVD мы не нашли (⚠ проверить; ENISA Legal Notice разрешает переиспользование с указанием источника ✅). **Архитектурно**: у каждой проверки есть `legalBasis[]` с датами и статусом нормы; ruleset версионируется по Rechtsstand; детектирование отделено от присвоения уровня; справочники вендоров, CMP и устаревших норм — данные, а не код.

---

## 1. Национальная база: TDDDG, DDG, EinwV

| Норма | Суть для сканера | Дата / статус | Влияние на проверки |
|---|---|---|---|
| **§ 25 TDDDG** (Endeinrichtungen) | Хранение или чтение информации в устройстве — только с согласия. Исключения: передача сообщения; «unbedingt erforderlich» для «vom Nutzer ausdrücklich gewünschten digitalen Dienst». Норма технологически нейтральна, персональные данные не требуются | ✅ TTDSG от 23.06.2021 действует с 01.12.2021; переименован в TDDDG ст. 8 G v. 6.5.2024 (BGBl. 2024 I Nr. 149) mWv **14.05.2024**. Последнее изменение — Art. 3 G v. 10.3.2026 (BGBl. 2026 I Nr. 64), содержание ⚠ проверить | CONSENT-01/02/05/06: в `legalBasis` писать «§ 25 Abs. 1 TDDDG», не «TTDSG». LEGAL-02: «TTDSG» в Datenschutzerklärung — устаревшая ссылка (`info`) |
| **§ 19 Abs. 4 TDDDG** | Anbieter digitaler Dienste обязаны «soweit technisch möglich und wirtschaftlich zumutbar» защищать технику от несанкционированного доступа; меры «müssen den Stand der Technik berücksichtigen»; «insbesondere die Anwendung eines als sicher anerkannten Verschlüsselungsverfahrens» ✅ | действует | **Главная немецкая опора** для TLS-01/02/04, HDR-02 (флаг Secure) и частично VULN/FILE. Формулировка: «Stand der Technik i. S. v. § 19 Abs. 4 TDDDG nicht erkennbar umgesetzt» без вывода о нарушении |
| **§ 26 TDDDG + EinwV** | Признанные «Dienste zur Einwilligungsverwaltung» (PIMS). Признаёт BfDI (§ 8 EinwV), ведёт реестр (§ 13). Подключение для сайтов **freiwillig** (§ 18 Abs. 1 ✅); при подключении настройки пользователя «berücksichtigen» (§ 19 ✅); браузеры «sollen» не подавлять сигнал (§ 17 ✅) | EinwV V. v. 06.02.2025, BGBl. 2025 I Nr. 32, в силе с **01.04.2025** 🔶. Первый признанный сервис — «Consenter», 17.10.2025 (⚠ один источник, e-recht24). В августе 2026 BfDI призывала ЕС к машиночитаемой системе согласий (⚠ один источник) | Баннеры остаются. Новый **CONSENT-08 (P2, только `info`)**: «Anerkannter Einwilligungsverwaltungsdienst eingebunden: ja/nein». Нарушением отсутствие PIMS не является |
| **§ 5 DDG** (Impressum) | Для «geschäftsmäßige, in der Regel gegen Entgelt angebotene digitale Dienste» данные должны быть «leicht erkennbar und unmittelbar erreichbar … ständig verfügbar» ✅. Перечень: имя/адрес, правовая форма и представитель, e-mail, реестр и номер, USt-IdNr. и др. ✅ | DDG от 06.05.2024 (BGBl. 2024 I Nr. 149) ✅, в силе с 14.05.2024. Изменён G v. 12.5.2026 (BGBl. 2026 I Nr. 138), содержание ⚠ проверить | LEGAL-01: проверять доступность с каждой страницы. Практика «≤ 2 клика» — BGH I ZR 228/03, 20.07.2006 (⚠ по памяти). LEGAL-02: «§ 5 TMG» → «§ 5 DDG» |
| **§ 18 MStV** (бывш. § 55 RStV) | Дополнительные требования для журналистско-редакционных предложений (V.i.S.d.P.) | MStV действует с 07.11.2020 (⚠ по памяти) | LEGAL-02: «§ 55 RStV» — устаревшая ссылка |
| **ePrivacy-Verordnung** (2017/0003(COD)) | Проект отозван | Отзыв опубликован в OJ 06.10.2025 🔶 (EUR-Lex procedure) | Ждать «ePrivacy-VO» не нужно; правовая база — ePrivacy-RL 2002/58/EG + § 25 TDDDG |

**Вывод для дизайна.** Национальная правовая база стабильна. Подвижны только интерпретация (DSK, суды) и проект ЕС (раздел 2). В `legalBasis` хранить и норму, и редакцию: `TDDDG §25 Abs.1 (idF ab 14.05.2024)`.

---

## 2. EU Digital Omnibus (данные/DSGVO/ePrivacy)

### 2.1 Что предложила Комиссия (19.11.2025)

- Процедура **2025/0360(COD)**, документ **COM(2025) 837** ✅ (EP Legislative Train).
- **Art. 88a DSGVO (новый)** 🔶 (Osborne Clarke, Sealmetrics; официальный текст в этой сессии не читали):
  - согласие остаётся правилом;
  - закрытый список исключений: (a) передача сообщения, (b) явно запрошенный сервис, (c) **агрегированное измерение аудитории контролёром исключительно для себя**, (d) безопасность;
  - отказ «with a single-click button or equivalent means»;
  - после отказа нельзя повторно запрашивать согласие для той же цели **≥ 6 месяцев**;
  - применение — через 6 месяцев после вступления в силу (⚠ разночтения).
- **Art. 88b DSGVO (новый)** 🔶:
  - контролёры принимают автоматизированные машиночитаемые сигналы согласия и отказа;
  - media service providers освобождены;
  - стандарты разрабатывают европейские органы стандартизации;
  - сайты обязаны уважать сигналы через ~24 месяца, браузеры (не SME) должны их поддерживать через ~48 месяцев (⚠ сроки в источниках расходятся).
- Определение персональных данных предлагалось сделать «субъективным», вслед за EuGH C-413/23 P EDPS/SRB от 04.09.2025 🔶.

### 2.2 Статус на 30.10.2026

| Институт | Состояние | Достоверность |
|---|---|---|
| EDPB/EDPS | Joint Opinion 2/2026 от 10.02.2026: цель снизить «consent fatigue» поддерживают, против изменения определения персональных данных | 🔶 |
| Совет | 26.06.2026 голосование Coreper под кипрским председательством **отменено** ✅ (EP). 5-й компромисс (18.06.2026) **удалил Art. 88b**, Art. 88a с правилом 6 месяцев оставил 🔶 (ppc.land; Heuking: «im Juni 2026 gestrichen»). **21.10.2026 — мандат Совета** (пресс-релиз «Council agrees position…» 🔶; сайт Consilium отдаёт 403 бот-защитой, полный текст не прочитан) | 🔶 |
| Содержание мандата 21.10.2026 (по cookies) | Art. 88a и 88b удалены. Переписан **Art. 5(3) ePrivacy-RL**. Закрытый список из 6 исключений: передача; явно запрошенный сервис с функциональностью (язык, корзина); анонимное first-party измерение аудитории; медиаизмерение по Art. 24 EMFA; обновления безопасности; измерение контекстной рекламы без профилирования. **Отказ одним кликом**. Повторный запрос — **через 4 месяца** (досрочно — при смене цели или удалении cookies). Обязанность поддерживать браузерные сигналы снята, вместо неё через 12 месяцев отчёт Комиссии о PET. Компетенция — GDPR-надзор. Транспозиция 24 месяца | 🔶 (euinternetpolicy 23.10.2026, nicfab 21.10.2026, Heuking 23.10.2026). **Номер документа ⚠**: 13886/26 или 14756/26 — источники расходятся |
| Европарламент | ITRE+LIBE совместно; докладчики Aura Salla (EPP) и Marina Kaljurand (S&D). Draft report 22.06.2026, обсуждение 13.07.2026, > 1 750 поправок. **Голосования в комитете нет**; страница обновлена 20.09.2026 | ✅ (EP) |
| Сроки | Голосование в комитете ЕП ожидается «early 2027» ⚠. Затем трилог. Heuking: вступление «nicht vor 2027» 🔶. В DE изменения применятся при директивной модели после транспозиции (24 мес.), при модели регламента — через 6 месяцев | прогноз ⚠ |
| Часть omnibus по ИИ | По вторичным данным уже принята как Regulation (EU) 2026/1744 | ⚠ проверить; для сканера нерелевантно |

### 2.3 Что Omnibus может изменить в проверках (горизонт 1–2 года)

| Проверка | Возможное изменение | Вероятность до конца 2027 | Что делать сейчас |
|---|---|---|---|
| CONSENT-01/02, TRACK-01 | Анонимное first-party измерение аудитории (self-hosted Matomo без ID, серверная статистика) станет исключением. Сейчас в DE такого исключения нет: DSK Rn. 77 ✅ считает аналитику «nicht per se» частью базового сервиса | Низкая (не вступит в силу) | Хранить категорию цели (`purpose: audience_measurement_first_party`) отдельно от уровня, чтобы профиль мог её «освободить» |
| CONSENT-04 | Отказ одним кликом станет **прямой нормой**, а не только толкованием DSK/судов | Низкая (в силе), высокая (в тексте любого компромисса) | Детектор отказа на первом уровне делать уже сейчас |
| CONSENT-05/новый CONSENT-07 | Повторный запрос после отказа (4 или 6 месяцев) — проверяемо повторным визитом с сохранённым состоянием | Низкая | Параметр профиля `rePromptCooldownDays`; по умолчанию сейчас 0 (нормы нет), только `info` |
| Браузерные сигналы (GPC/ADPC) | 88b удалён Советом; ЕП может вернуть (коалиция из 19 НКО требует 🔶) | Низкая | Не делать отсутствие поддержки сигналов нарушением. Опционально: `info`, если сайт игнорирует `Sec-GPC` (⚠ правовой опоры в DE нет) |
| EMBED-* / определение ПД | Совет сохраняет действующее определение ПД 🔶, поэтому аргумент «IP — персональные данные» (Breyer C-582/14) остаётся | Низкая | Тексты EMBED опирать на DSK Rn. 101, а не на спор об идентифицируемости |
| Pay-or-Okay | Отказ одним кликом может войти в конфликт с моделью Pur-Abo (Heuking 🔶) | Низкая | Распознавать Pay-or-Okay отдельно (раздел 3) |

---

## 3. Позиции надзорных органов (DSK, BfDI, LfDI, EDPB)

Общая база, прочитанная в этой сессии ✅:

- **DSK OH Digitale Dienste v1.2 (Stand: November 2024).**
  - Rn. 21: технологическая нейтральность, Web Storage.
  - Rn. 23: fingerprinting.
  - Rn. 58–60: отказ не должен требовать больше усилий.
  - Rn. 74–77: базовый сервис и дополнительные функции; карты, чаты, видео и аналитика не «ausdrücklich gewünscht» при первом визите.
  - Rn. 80–84: время установки cookie, UID в consent-cookie не нужен.
  - Rn. 101: сторонний контент («Schriftarten, Skripte, Stadtpläne, Videos…») требует основания по Art. 6.
  - Rn. 121–137: баннер.
- **EDPB Guidelines 2/2023 v2.0** (07.10.2024): Rn. 47–51 — пиксели и URL-трекинг; Rn. 54–55 — трекинг только по IP.

| Тема | Позиция и источник | Достоверность | Последствие для проверки |
|---|---|---|---|
| **«Nur essenzielle»/«Ablehnen» на первом уровне** | DSK Rn. 124: обязательно, «wenn Nutzer:innen mit dem Einwilligungsbanner interagieren müssen, um den Besuch … fortzusetzen». На мобильных баннер также не должен блокировать контент. Rn. 125: «sehr häufig» условия выполнены. Rn. 135: равноценность по размеру, цвету, контрасту и шрифту. Rn. 137: «Einstellungen oder Ablehnen» недостаточно. EDPB Cookie Banner Taskforce (18.01.2023): большинство DPA требует reject на первом уровне 🔶 | ✅ / 🔶 | CONSENT-04 (см. матрицу) |
| **Доступ к Impressum и Datenschutz** | DSK Rn. 121: «Der Zugriff auf Impressum und Datenschutzerklärung darf durch das Einwilligungsbanner nicht behindert werden» | ✅ | LEGAL-01: проверять кликабельность ссылок при открытом баннере (точка клика не перекрыта оверлеем) |
| **Google Fonts / Adobe Fonts / CDN-шрифты** | DSK Rn. 101: шрифты с чужих серверов — раскрытие ПД, нужно основание по Art. 6. LG München I 3 O 17493/20: отсутствие законного интереса, так как шрифты можно хостить локально 🔶 | ✅ / 🔶 | EMBED-01 = `warning`; рекомендация — «lokal einbinden»; без вывода о нарушении |
| **Google Maps (iframe, JS API, static tiles)** | DSK Rn. 74–76: «Kartendienste» — дополнительный сервис, при первом визите не желаем, нужна «weitere Handlung» (two-click) | ✅ | EMBED-02 = `warning`; static tiles тоже передают IP — `warning` (или `info` в профиле `lenient`) |
| **YouTube / youtube-nocookie** | Отдельного решения DSK/LfDI не нашли. По DSK Rn. 101 видео — сторонний контент. Режим `nocookie` не убирает обращение к Google; запись в localStorage — ⚠ проверить фикстурой | ✅ (общий принцип) / ⚠ | EMBED-03: `nocookie` классифицировать **так же**, но с пометкой «erweiterter Datenschutzmodus erkannt»; превью `i.ytimg.com` = загрузка до согласия |
| **reCAPTCHA** | DSK Rn. 74/83: системы «nutzerorientierter Betrugsprävention» можно отнести к базовому сервису, но **не** для «Sicherheit von Websites oder Diensten Dritter». С **02.04.2026** Google — **процессор** (Cloud DPA) 🔶 (Google FAQ, heise). Omnibus (Комиссия и Совет) добавляет исключение по безопасности | ✅ / 🔶 | EMBED-04: на странице с формой — `info`; на всех страницах / v3 site-wide — `warning`. PRIV-02: формулировки политики вида «Google ist eigenständiger Verantwortlicher» после 02.04.2026 устарели (`info`) |
| **Google Consent Mode v2** | Официальной позиции DSK/LfDI не нашли ⚠. Из принципов: в Advanced mode до согласия уходят «cookieless pings» — это «gaining access» по EDPB 2/2023 Rn. 51 ✅ и «keine Inhalte von fremden Servern» по DSK Rn. 121 ✅. Basic mode ничего не грузит до согласия 🔶 | ⚠ (выведено) | CONSENT-01: пинги с `gcs=G100` до клика = `warning`. CONSENT-06: `gcs=G1x1/G11x` при отказе в CMP = `critical`. Кодировку `gcs`/`gcd` проверить фикстурами ⚠ |
| **Server-side tagging** | Позиции DPA не нашли ⚠. Из принципов: § 25 технологически нейтрален (DSK Rn. 21 ✅); first-party cookie, который читает sGTM, — та же «Speicherung»; передача ID в США с сервера — Kapitel V DSGVO | ⚠ (выведено) | CONSENT-01/02: детектировать **по сигнатуре** (`/g/collect?…tid=G-`, `gtm.js?id=GTM-` с first-party хоста, CNAME-cloaking), не по чужому домену. В отчёте: «serverseitige Weiterleitung passiv nicht prüfbar» |
| **Google Tag Manager** | VG Hannover 10 A 5385/22: загрузка `gtm.js` с серверов Google — доступ и передача, «in no way necessary», нужно согласие 🔶 (TCI) | 🔶 | CONSENT-01: GTM до согласия = `warning` (сам по себе), `critical` — если через него грузятся трекеры |
| **CDN-инфраструктура** (jsDelivr, cdnjs, CMP-скрипт с Akamai) | VG Wiesbaden 6 L 738/21.WI (01.12.2021) запретил Cookiebot из-за Akamai; VGH Kassel 10 B 2486/21 (17.01.2022) решение отменил 🔶 (мотивы ⚠) | 🔶 / ⚠ | Чистые CDN/статические ресурсы = `info` («Drittanbieter-Ressource»). Не `critical`, иначе ложные тревоги массовые |
| **Pay-or-Okay (Pur-Abo)** | DSK Beschluss 22.03.2023: допустимо при равноценной альтернативе, согласие гранулярно по целям 🔶. EDPB Opinion 08/2024 — только для крупных платформ (⚠ дата по памяти: 17.04.2024). Общие EDPB-руководства по consent-or-pay в работе (⚠) | 🔶 / ⚠ | Новый детект «Pay-or-Okay erkannt» = `info`. CONSENT-04 к такому баннеру **не применять** (нет кнопки отказа по замыслу); CONSENT-01/02 до выбора — применять |
| **Consent-cookie с UID** | DSK Rn. 84: для доказательства согласия долгоживущий UID не нужен | ✅ | CONSENT-02: cookie CMP с UID и сроком > 1 года — `info` |
| **BfDI** | Компетентна по EinwV (§ 8). Ведёт реестр. Публично продвигает машиночитаемые согласия (август 2026, ⚠ один источник) | ✅ / ⚠ | Только CONSENT-08 (info) |

---

## 4. Судебная практика (опорные дела 2019–2022 и свежие 2023–2026)

| Дело | Дата | Суть | Достоверность | Значение для `dsgvo-check` |
|---|---|---|---|---|
| EuGH C-673/17 *Planet49* | 01.10.2019 | Предустановленная галочка — не согласие; § 25-согласие нужно независимо от ПД | 🔶 | CONSENT-01/02: опорная ссылка |
| BGH I ZR 7/16 *Cookie-Einwilligung II* | 28.05.2020 | Национальная реализация Planet49 | ⚠ по памяти | то же |
| VG Wiesbaden 6 L 738/21.WI → VGH Kassel 10 B 2486/21 | 01.12.2021 / 17.01.2022 | Запрет Cookiebot/Akamai (США) → решение отменено | 🔶 (мотивы ⚠) | CDN не повышать до critical |
| LG München I 3 O 17493/20 | 20.01.2022 | Динамические Google Fonts без согласия: Unterlassung (§§ 823, 1004 BGB) + 100 € по Art. 82 | 🔶 | EMBED-01: единичное решение LG, не прецедент |
| Ermittlungen GenStA Berlin против абмахнеров по Google Fonts | 12/2022 | Обыски, арест активов на 346 000 €; 420 заявлений | 🔶 (borncity) | Итог уголовного дела ⚠ не найден |
| LG München I 4 O 13063/22 | 30.03.2023 | Нет ни Unterlassung, ни компенсации при массовых «Google-Fonts-Schreiben» (≥ 217 540 писем); злоупотребление | 🔶 | Не дизайн «под абмахнунг» |
| EuGH C-300/21 *Österreichische Post* | 04.05.2023 | Само нарушение ≠ ущерб; порога серьёзности нет; размер — по нац. праву | 🔶 | Формулировки без «Schaden», только факты |
| OLG Köln 6 U 58/23 (Telekom) | 03.11.2023 | Передача IP/данных устройства в Google (США) без надлежащего основания — незаконна | 🔶 | TRACK-01/«Drittland»-аннотации |
| OLG Köln 6 U 80/23 (wetteronline, иск VZ NRW) | 19.01.2024 | Нет равноценного отказа (отказ на 2-м уровне), «Akzeptieren & Schließen X» вводит в заблуждение → нарушение § 25 TTDSG + Art. 4 Nr. 11 DSGVO | 🔶 (PDF у VZ NRW) | CONSENT-04: сигнатура «X = Akzeptieren» → отдельная находка |
| EuGH C-604/22 *IAB Europe* | 07.03.2024 | TC-String — ПД; IAB — совместный контролёр в части TC-String | 🔶 | CONSENT-06: TCF-строку в отчёте не хранить целиком (минимизация) |
| EuGH C-21/23 *Lindenapotheke* | 04.10.2024 | DSGVO не препятствует искам конкурентов по UWG | 🔶 (Curia PM 159/24) | Пользователи будут применять отчёты в спорах → нужна точная доказательная база |
| BGH VI ZR 10/24 (Scraping) | 18.11.2024 | Даже кратковременная потеря контроля = ущерб по Art. 82; ориентир ~100 € | 🔶 | см. выше |
| BGH I ZR 222/19, I ZR 223/19 | 27.03.2025 | Art. 9 DSGVO = Marktverhaltensregel (§ 3a UWG), конкурент вправе требовать Unterlassung | 🔶 | Распространится ли на § 25 TDDDG/Art. 6 — ⚠ открыто |
| VG Hannover 10 A 5385/22 (NOZ vs LfD Niedersachsen) | 19.03.2025 | Распоряжение LfD законно: при «Alle akzeptieren» на первом уровне нужен равноценный «Alle ablehnen»; GTM требует согласия; повторный показ баннера после отказа | 🔶 | CONSENT-01 (GTM), CONSENT-04, новый CONSENT-07 |
| EuG T-553/23 *Latombe* | 03.09.2025 | DPF (Durchführungsbeschluss (EU) 2023/1795) устоял. Апелляция подана 31.10.2025 и **pending** (Microsoft вступил 06/2026) | 🔶; номер апелляции ⚠ | Аннотации «USA (DPF)» — данные, а не код |
| EuGH C-413/23 P *EDPS/SRB* | 04.09.2025 | Псевдонимизированные данные могут не быть ПД для получателя | 🔶 | EMBED/IP-аргументы не строить на «всегда ПД» |
| EuGH C-655/23 *Quirin Privatbank* | 04.09.2025 | Негативные чувства (досада, беспокойство) могут быть ущербом; Unterlassung — по нац. праву | 🔶 | — |
| EuGH C-526/24 *Brillen Rottler* | 19.03.2026 | Первый запрос по Art. 15 может быть «exzessiv»/злоупотреблением, если цель — искусственно создать предпосылки для компенсации. Публичные данные о серийных исках учитываются. Нет компенсации, если «ihr eigenes Verhalten die entscheidende Ursache für den Schaden ist» | ✅ (Curia PM 38/26) | Аргумент против «краулер-исков»: инструмент не должен облегчать такие схемы (раздел 5) |

**Выводы для проверок из практики**

- CONSENT-04 опирается на устойчивую линию: DSK + VG Hannover + OLG Köln + EDPB-Taskforce. Риски — в ложных срабатываниях, а не в правовой базе.
- EMBED-01 стоит на одном решении LG и сопровождается историей злоупотреблений. Уровень `warning`, текст нейтральный.
- Передачи в третьи страны после DPF (2023) и Latombe (2025) нельзя автоматически маркировать как незаконные. Нужна аннотация вендора (DPF да/нет, дата проверки).

---

## 5. Abmahn-механика и что она значит для отчёта

| Механизм | Норма | Статус | Следствие для дизайна |
|---|---|---|---|
| Иск конкурента | § 8 Abs. 3 Nr. 1 UWG ✅ + § 3a UWG; C-21/23; BGH 27.03.2025 | действует | Каждая находка должна воспроизводиться (HAR, скриншот, время, UA) |
| Нет возмещения расходов против SME | § 13 Abs. 4 UWG ✅: исключено (1) за нарушения информационных обязанностей в «elektronischen Geschäftsverkehr oder in digitalen Diensten» и (2) за «sonstige Verstöße» против DSGVO/BDSG у компаний < 250 сотрудников | действует | Экономика массовых абмахнунгов слабее, но Unterlassung остаётся |
| Verbraucherverbände | UKlaG (иски VZ NRW по cookie-баннерам: OLG Köln) | действует (норму UKlaG ⚠ не сверяли) | — |
| Компенсация Art. 82 | C-300/21, BGH VI ZR 10/24, C-526/24 | действует | Отчёт не должен утверждать, что ущерб есть |

**Требования к продукту, вытекающие из этого** (уточняют ТЗ «Юридические выводы в отчёте — нельзя»):

1. В текстах только факты: «festgestellt», «vor Einwilligung geladen», «nicht gefunden in der Datenschutzerklärung». Не использовать «Verstoß», «rechtswidrig», «abmahnfähig», «Schadensersatz».
2. Нет режима «Abmahn-Export» (шаблонов писем, расчёта сумм). Массовое сканирование по спискам доменов не поощрять: rate limit по умолчанию, честный UA со ссылкой на репозиторий (уже в ТЗ).
3. В дисклеймер добавлять **Rechtsstand** и версию ruleset: «Prüfstand 30.10.2026, Regelwerk 2026.10».
4. FILE-01: не скачивать и не хранить содержимое `.env`/`.git` — только факт доступности и сигнатуру (первые байты/заголовок). Причина: риск по § 202a/§ 202c StGB и обработка чужих секретов (⚠ правовую оценку дать юристу заказчика).

---

## 6. BFSG (Barrierefreiheitsstärkungsgesetz)

| Аспект | Факт | Достоверность |
|---|---|---|
| Применение | Услуги, «die für Verbraucher nach dem 28. Juni 2025 erbracht werden», в т. ч. **«Dienstleistungen im elektronischen Geschäftsverkehr»** (§ 1 Abs. 3 Nr. 5) | ✅ |
| Определение | § 2 Nr. 26: digitale Dienste (§ 1 Abs. 4 Nr. 1 DDG) через сайты/приложения, «auf individuelle Anfrage eines Verbrauchers im Hinblick auf den Abschluss eines Verbrauchervertrags» → **B2C, направленные на заключение договора** | ✅ |
| Исключения | § 3 Abs. 3: Kleinstunternehmen, оказывающие услуги (< 10 сотрудников **и** оборот или баланс ≤ 2 млн €, § 2 Nr. 17). § 1 Abs. 4: старые записанные медиа и офисные файлы до 28.06.2025, онлайн-карты (с условиями) и др. | ✅ |
| Обязанности | § 14 Abs. 1: требования BFSGV + **«Informationen nach Anlage 3»** в доступной форме (на практике — «Erklärung/Informationen zur Barrierefreiheit») | ✅ |
| Технический стандарт | BFSGV → гармонизированный стандарт EN 301 549 (≈ WCAG 2.1 AA). Обновление EN 301 549 под EAA/WCAG 2.2 — ⚠ статус публикации в OJ не подтверждён | ⚠ |
| Надзор | Marktüberwachungsbehörden der Länder (§ 20). Центральная MLBF в Магдебурге — ⚠ статус не проверяли | ✅ / ⚠ |
| Абмахнунги | Первые с 08/2025 (одна серия) 🔶 (Heuking 19.08.2025, Händlerbund). Судебных решений по BFSG как Marktverhaltensregel не найдено ⚠ | 🔶 / ⚠ |

**Связь с BFSG-01 и предложения**

- **BFSG-01 по умолчанию `info`**: сканер не знает, B2C ли это, ведёт ли страница к заключению договора и не Kleinstunternehmen ли оператор. Флаг `--profile bfsg` или `--b2c-shop` переводит находки в `warning`.
- axe-core автоматически ловит лишь часть критериев WCAG. В отчёте: «automatisiert geprüft: Teilmenge; keine Konformitätsaussage». Набор тегов (`wcag2a`, `wcag2aa`, `wcag21aa`, позже `wcag22aa`) хранить в конфиге ruleset.
- **Новый BFSG-02 (P2, `info`)**: «Informationen zur Barrierefreiheit (§ 14 Abs. 1 Nr. 2 BFSG i. V. m. Anlage 3) nicht gefunden». Детект: ссылка или страница «Barrierefreiheit», «Barrierefreiheitserklärung», «Erklärung zur Barrierefreiheit».

---

## 7. Security: NIS2-Umsetzung, Art. 32 DSGVO, «Stand der Technik», BSI

### 7.1 Нормативная лестница (от сильной опоры к слабой)

| Уровень | Норма | На кого распространяется | Что даёт сканеру |
|---|---|---|---|
| Прямая норма | **§ 19 Abs. 4 TDDDG** ✅: Stand der Technik и «als sicher anerkanntes Verschlüsselungsverfahren» | Все «geschäftsmäßig angebotene digitale Dienste» | TLS-01/02/04, Secure-флаг cookies (HDR-02), FILE-01, VULN |
| Общая норма | **Art. 32 DSGVO** (Stand der Technik, TOM) | Все контролёры | VULN, HDR-01 (косвенно). Для e-mail-транспорта — DSK OH «Maßnahmen zum Schutz personenbezogener Daten bei der Übermittlung per E-Mail» (2021, ⚠ актуальную редакцию не сверяли) |
| Сектор NIS2 | **NIS2UmsuCG** (BSIG n. F.), опубликован 05.12.2025, в силе **06.12.2025** 🔶. § 30 BSIG ✅: меры «sollen den Stand der Technik einhalten», в т. ч. Nr. 8 «Konzepte und Prozesse für den Einsatz von kryptographischen Verfahren». § 28 ✅: besonders wichtige (≥ 250 сотр. или > 50 млн € оборота и > 43 млн € баланса в секторах Anlage 1) и wichtige Einrichtungen. Регистрация в BSI (срок 06.03.2026, льгота до 31.07.2026 — ⚠ один источник) | ~29 500 организаций 🔶 | Не применять как общую норму к «любому сайту». Опционально `--profile nis2`: ссылаться на § 30 BSIG в тексте TLS/VULN |
| Технические стандарты | **BSI TR-02102-2** (TLS), версия **2026-01** от 27.01.2026 ✅: «TLS 1.3 should be used in preference»; TLS 1.2 рекомендован «until the end of 2031»; «TLS 1.0 and TLS 1.1 are not recommended (RFC 8996)». **BSI TR-03116-4** (Bund, 2025-07 🔶 ⚠) | Рекомендации (для Bund — обязательны) | Пороги TLS-04 |
| Технические стандарты | **BSI TR-03182 E-Mail-Authentifizierung v1.0** (24.01.2024) ✅: SPF MUST, «SoftFail or Fail» — оба соответствуют; Pass/Neutral (`+all`, `?all`) — нет. DMARC MUST, «SHOULD require … reject», «expects either quarantine or reject». Хотя бы один RUA обязателен; обработка отчётов «within the EU». DKIM MUST, RSA ≥ 1024 и ≤ 2048 бит, ротация ~3 месяца. DNSSEC SHOULD. **Unused Domains: Null MX + SPF fail-all + DMARC reject** (MUST). Адресат — e-mail-провайдеры (MHS) | Рекомендация для провайдеров; де-факто «Stand der Technik» | MAIL-01/02/03, DNS-01, новый MAIL-04 |
| Технические стандарты | BSI TR-03108 (Sicherer E-Mail-Transport, DANE/MTA-STS) 🔶 | то же | Возможный MAIL-05 (P2) |
| Best practice | OWASP Secure Headers, IT-Grundschutz (APP.3.x, ⚠ редакция; анонсирован «Grundschutz++») | — | HDR-01 только `info`/`warning` |

### 7.2 Рекомендации по уровням для HDR/TLS/MAIL

| ID | Предложение | Обоснование |
|---|---|---|
| TLS-01 | `critical`, если на HTTP есть формы или передаются данные. Иначе `warning` | § 19 Abs. 4 S. 3 TDDDG ✅ |
| TLS-02 | `critical` (браузер блокирует; шифрования де-факто нет) | то же |
| TLS-03 | Активный mixed content (script/iframe) — `warning`, пассивный (img) — `info` | Браузеры блокируют активный |
| TLS-04 | TLS 1.0/1.1 принимается — `warning`. Нет TLS 1.3 — `info`. TLS 1.2 до 2031 — ок | TR-02102-2 2026-01 ✅ |
| HDR-01 | Нет HSTS на HTTPS-сайте — `warning` (связка с TLS-01). Нет CSP / Permissions-Policy / nosniff / frame-ancestors — `info`. Нет Referrer-Policy при сторонних запросах — `info` (минимизация, Art. 5(1)(c) — утечка полных URL третьим лицам) | Конкретной нормы нет |
| HDR-02 | Сессионная cookie без `Secure` на HTTPS — `warning`. Без `HttpOnly`/`SameSite` — `info`. Версии в заголовках — `info` | § 19 Abs. 4 |
| MAIL-01 | Нет DMARC — `warning`. `p=none` — `warning` с текстом «BSI TR-03182 erwartet quarantine oder reject». RUA на провайдера вне ЕС — `info` (TR-03182: отчёты — ПД, обработка в ЕС) | TR-03182-06-M ✅ |
| MAIL-02 | Нет SPF — `warning`. `+all`/`?all` — `warning`. **`~all` при DMARC quarantine/reject — `info`/pass**. `~all` без DMARC-enforcement — `warning` (защиты по сути нет). > 10 DNS-lookup — `warning` (RFC 7208, запись невалидна) | TR-03182-01-M ✅ (SoftFail допустим) |
| MAIL-03 | Пассивно перебор селекторов неполон → **только `info`**: «auf gängigen Selektoren nicht gefunden». RSA < 1024 бит — `warning` | TR-03182-03-M ✅ |
| MAIL-04 (новый, P1/P2) | Домен без MX (не отправляет почту) без Null MX / `v=spf1 -all` / DMARC `reject` — `info`/`warning` | TR-03182-11-M ✅ |
| DNS-01 | Нет DNSSEC/CAA — `info` | TR-03182: DNSSEC SHOULD ✅ |

---

## 8. EUVD (ENISA) и Cyber Resilience Act — релевантность для VULN

| Инструмент | Факт | Достоверность | Релевантность |
|---|---|---|---|
| **EUVD** | Запущена 13.05.2025 по Art. 12(2) NIS2 🔶. Публичный API без ключа: `GET https://euvdservices.enisa.europa.eu/api/lastvulnerabilities` и `/api/exploitedvulnerabilities` отвечают 200 + JSON с ID вида `EUVD-2026-…` (проверено 30.10.2026) ✅. ENISA стала CVE Root (03/2026, ⚠ один источник) | ✅ / 🔶 | **Кандидат во вторичный источник exploited-статуса** (аналог KEV) и фолбэк при сбоях NVD/CVE. Лицензия на данные EUVD явно не найдена. ENISA Legal Notice: «reproduction … provided the source is acknowledged, unless stated otherwise» ✅ → ⚠ запросить у ENISA или найти terms EUVD до использования в Apache-2.0-проекте |
| **Устойчивость CVE/NVD** | В 04/2025 CISA в последний момент продлила контракт MITRE на 11 месяцев (до 16.03.2026) 🔶; дальнейший статус ⚠ не подтверждён | 🔶 / ⚠ | Архитектура VULN должна быть **мульти-источниковой** (адаптеры OSV/NVD/KEV/EUVD), с кешированием и метаданными источника в evidence |
| **CRA** (Regulation (EU) 2024/2847) | Обязанность производителей сообщать об активно эксплуатируемых уязвимостях и тяжёлых инцидентах через ENISA Single Reporting Platform — **с 11.09.2026**, включая продукты, уже находящиеся на рынке; полное применение — 11.12.2027 🔶 | 🔶 | Для **операторов сайтов обязанностей нет** (сайт или SaaS — не «product with digital elements», кроме remote data processing решений; ⚠ детали). Косвенно: больше и раньше данных об exploited-уязвимостях в EUVD. Для VULN-уровней CRA **не опора**: опора — Art. 32 DSGVO / § 19 Abs. 4 TDDDG |
| **CRA для самого `dsgvo-check`** | Свободное OSS без коммерческой деятельности исключено. При монетизации (seed-factory: платные аудиты, поддержка) возможна роль «manufacturer» или «open-source software steward» | ⚠ | Открытый вопрос к заказчику (см. ниже) |
| **SEC-01** (`security.txt`, RFC 9116) | CRA Annex I требует CVD-политику от производителей, не от сайтов | ⚠ | Оставить `info` |

**VULN-уровни (каталог) с правовой точки зрения.** `critical` для KEV/EUVD-exploited — разумный операционный критерий. В тексте: «Version X erkannt; für diese Version ist eine aktiv ausgenutzte Schwachstelle (Quelle: CISA KEV/EUVD, Stand …) bekannt». Указывать уверенность детекта версии: backport-патчи в дистрибутивах дают ложные срабатывания.

---

## 9. Сводная матрица: проверка → правовая опора → что поменять

| ID | Опора (Rechtsstand 10/2026) | Изменение детектирования | Уровень (предложение) | Суть формулировки (DE) |
|---|---|---|---|---|
| PRIV-01 | Art. 13 Abs. 1 lit. e/f DSGVO (Empfänger **oder Kategorien**) | Если политика называет только категории («Hosting-Dienstleister»), отсутствие имени вендора — не обязательно пробел. Совпадение по алиасам (Google Fonts / Google Webfonts / fonts.googleapis) | `warning`; `info`, если найдена подходящая категория | «Dienst X geladen; namentlich in der Datenschutzerklärung nicht gefunden» |
| PRIV-02 | Art. 5(1)(a), Art. 13 DSGVO; § 5 UWG (Irreführung) | Справочник паттернов утверждений («Google Fonts lokal», «keine Cookies», «Privacy Shield»; после 02.04.2026 — «Google … eigenständiger Verantwortlicher» для reCAPTCHA) | `critical` только при прямом противоречии с сетевым доказательством; иначе `warning` | «Aussage „…“ in der Datenschutzerklärung; beobachtet: Anfrage an … » |
| CONSENT-01 | § 25 Abs. 1 TDDDG; DSK Rn. 121–122; EDPB 2/2023 Rn. 51; VG Hannover (GTM) | + пиксели/URL-трекинг, cookieless pings, first-party/sGTM по сигнатуре, CNAME-cloaking. Классы: tracking/ads → `critical`; tag manager → `warning`; embeds → EMBED-*; CDN/статические ресурсы → `info` | см. слева | «Vor einer Auswahl im Banner: Anfrage an <Host> (Kategorie <…>)» |
| CONSENT-02 | § 25 TDDDG; DSK Rn. 21, 80–84 | + localStorage/sessionStorage/IndexedDB; известные tracking-cookies (`_ga`, `_fbp`, `_gcl_au`) → `critical`; неизвестные persistent third-party → `warning`; CMP-cookie с UID → `info` | см. слева | «Vor Einwilligung gespeichert: <Name> (<Domain>, Laufzeit …)» |
| CONSENT-03 | как CONSENT-01 | Композиция: «нет баннера» + находки, которые требуют согласия. Если есть только CDN/шрифты — это EMBED-01, а не CONSENT-03 | `critical` при трекерах, иначе `warning` | «Kein Einwilligungsbanner erkannt; einwilligungsbedürftige Dienste festgestellt: …» |
| CONSENT-04 | DSK Rn. 58–60, 124–137; VG Hannover; OLG Köln 6 U 80/23; EDPB Taskforce | (1) Баннер блокирует? (оверлей, `inert`/`aria-modal`, scroll lock, перекрытие контента) на desktop **и** mobile; (2) кнопка отказа на 1-м уровне со словарём («Ablehnen», «Alle ablehnen», «Nur notwendige/essenzielle», «Weiter ohne Einwilligung»), антисловарь («Einstellungen», «Verbergen», «Schließen», «X» = accept); (3) равноценность (площадь, контраст) — только как доп. evidence; (4) Pay-or-Okay — исключение; (5) неизвестный CMP → `info` «Banner nicht erkannt» (ТЗ) | Блокирующий без отказа — `warning`; «X» = Akzeptieren — `warning`; неблокирующий — `info`; неравноценный вид — `info` | «Erste Banner-Ebene: Schaltfläche zum Ablehnen nicht gefunden; Banner verdeckt Inhalte (Viewport …)» |
| CONSENT-05 | § 25 TDDDG; Art. 7 Abs. 3 DSGVO | После «Ablehnen»: трекинговые запросы с ID → `critical`; cookieless pings (`gcs=G100`) → `warning` | см. слева | «Nach Ablehnung weiterhin Anfragen an …» |
| CONSENT-06 | § 25 TDDDG; EuGH C-604/22 (TCF) | Сверка состояния CMP (API/cookie/TCF) с `gcs`/`gcd`/`dataLayer consent default`; TC-String хранить в виде хеша или усечённым | `critical` при granted vs отказ | «CMP meldet analytics=denied; an Google übermittelt: granted» |
| CONSENT-07 (новый) | DSK Rn. 58–59; VG Hannover (повторный показ); будущий cooldown Omnibus (4/6 мес.) | Отказ → переход на 2-ю страницу → баннер снова показан? | `info` (сейчас), параметр профиля | «Banner nach Ablehnung erneut angezeigt» |
| CONSENT-08 (новый) | § 26 TDDDG, EinwV | Детект интеграции признанного PIMS | `info` | — |
| TRACK-01 | — (инвентарь) | Справочник вендоров: категория, DPF-статус, роль, дата проверки | `info` (уровень дают CONSENT-*) | — |
| EMBED-01 | Art. 6 DSGVO; DSK Rn. 101; LG München I 3 O 17493/20 | + Adobe Fonts (`use.typekit.net`, пиксель `p.typekit.net` ⚠ проверить фикстурой), Bunny/других CDN-шрифтов | `warning` | «Schriftarten von <Host> geladen (IP-Übermittlung an Dritte)» |
| EMBED-02 | Art. 6; § 25 при storage; DSK Rn. 74–76 | iframe/JS API/static tiles раздельно | `warning` | «Kartendienst vor Interaktion geladen» |
| EMBED-03 | то же | `youtube-nocookie` = YouTube + пометка; превью `i.ytimg.com` | `warning` | «Videodienst vor Interaktion geladen (erweiterter Datenschutzmodus: ja/nein)» |
| EMBED-04 | Art. 6; DSK Rn. 74/83; Google — процессор с 02.04.2026 | Есть ли форма на странице? v2/v3/Enterprise | Нет формы — `warning`; есть форма — `info` | «reCAPTCHA auf Seiten ohne Formular geladen» |
| EMBED-05 | Art. 6; § 25 | Каталог виджетов | `warning` | — |
| MAIL-01…03, DNS-01 | BSI TR-03182 v1.0; Art. 32 | см. § 7.2 | см. § 7.2 | Ссылка «BSI TR-03182» в тексте |
| HDR-01/02, TLS-01…04 | § 19 Abs. 4 TDDDG; TR-02102-2 2026-01 | см. § 7.2 | см. § 7.2 | «Stand der Technik (BSI TR-02102-2, Version 2026-01)» |
| LEGAL-01 | § 5 DDG; Art. 13 DSGVO; DSK Rn. 121 | + проверка «не перекрыто баннером»; доступность с каждой просканированной страницы; ссылка ≠ `#`/`javascript:` | Нет обоих — `critical`; нет одного — `warning`; перекрыто баннером — `warning` | «Link „Impressum“ auf <URL> nicht gefunden / durch Banner verdeckt» |
| LEGAL-02 | см. ниже | Словарь устаревших ссылок с `validFrom` | `info`; OS-Link — `warning` | «Verweis auf § 5 TMG; seit 14.05.2024 gilt § 5 DDG» |
| BFSG-01/02 | BFSG § 1, 2, 3, 14 | см. § 6 | `info` (профиль → `warning`) | «automatisierte Teilprüfung, keine Konformitätsaussage» |
| VULN-01/02 | Art. 32 DSGVO; § 19 Abs. 4 TDDDG | Мульти-источник; уверенность детекта версии | по каталогу (KEV/EUVD-exploited → `critical`) | См. § 8 |
| FILE-01 | § 19 Abs. 4 TDDDG; Art. 32 | Не сохранять содержимое; HEAD/диапазон байт | `critical` | «Datei öffentlich abrufbar: /.env (Inhalt nicht gespeichert)» |
| ADMIN-01 | Art. 32; Art. 5(1)(f) | `/wp-json/wp/v2/users` раскрывает логины/имена — граница «пассивности» (публичный GET) ⚠ согласовать | `warning`/`info` | — |

**Словарь для LEGAL-02** (обновляемые данные):

| Паттерн | Актуально | С какой даты | Достоверность |
|---|---|---|---|
| «§ 5 TMG», «Telemediengesetz» | § 5 DDG | 14.05.2024 | ✅ |
| «TTDSG», «§ 25 TTDSG» | TDDDG | 14.05.2024 | ✅ |
| «§ 55 RStV», «Rundfunkstaatsvertrag» | § 18 MStV | 07.11.2020 | ⚠ по памяти |
| Ссылка на OS-Plattform `ec.europa.eu/consumers/odr`, «Art. 14 Abs. 1 ODR-VO» | Платформа отключена, обязанность ссылаться отпала; § 36 VSBG остаётся | 20.07.2025 | 🔶 (IHK, Händlerbund). Номер отменяющего регламента (EU) 2024/3228 — ⚠ проверить |
| «EU-US Privacy Shield» как основание передачи | Признан недействительным (EuGH C-311/18 *Schrems II*); сейчас DPF | 16.07.2020 | ⚠ по памяти (общеизвестно) |
| Кандидат: «Widerrufsbutton» (§ 356a BGB) не найден на B2C-shop | Обязательная электронная функция отзыва | 19.06.2026 | 🔶 (Noerr: BGBl. 2026 I Nr. 28 ⚠) — P2, требует распознавания магазина |

---

## 10. Что может устареть за год (и как заложить это в архитектуру)

### 10.1 Проверки с «подвижной» правовой базой

| Область | Затронутые ID | Что в движении | Триггер / ориентир | Изменится ли в ≤ 12 мес. | Как заложить |
|---|---|---|---|---|---|
| Cookie-правила (Omnibus) | CONSENT-01…07, TRACK-01 | Перенос в ePrivacy-RL 5(3) или в DSGVO 88a; исключения (first-party measurement, контекстная реклама); один клик; cooldown 4/6 мес. | Голосование ЕП (начало 2027 ⚠), трилог, транспозиция | Низкая вероятность вступления; высокая — что текст ещё изменится | Профили права: `de-2026` (default) и `eu-omnibus-preview` (opt-in, пометка «Entwurf»); исключения как данные по цели |
| Браузерные сигналы / PIMS | CONSENT-08, будущий GPC-чек | 88b удалён Советом, ЕП может вернуть; EinwV добровольна | трилог | Низкая | Только `info`; GPC-тест — опциональный режим |
| Определение ПД | EMBED-*, CONSENT-02 | C-413/23 P; Совет сохраняет определение и добавляет норму о псевдонимизации | трилог | Низкая | Тексты без утверждения «personenbezogen», где хватает DSK Rn. 101 |
| Передача в третьи страны (DPF) | TRACK-01, EMBED-*, «Drittland» | Апелляция Latombe в EuGH | Решение — дата неизвестна ⚠ | Средне-низкая | В справочнике вендоров `transfer: {mechanism: DPF, verifiedAt}`; один флаг меняет все тексты |
| Роли и условия вендоров | EMBED-04, PRIV-01/02 | reCAPTCHA → процессор (02.04.2026); прочие вендоры меняют terms | постоянно | **Высокая** | Справочник вендоров с `effectiveFrom` и источником, обновляется без релиза ядра |
| Толкование DSK/EDPB | CONSENT-04 (уровни), Pay-or-Okay | Возможная OH v1.3; EDPB consent-or-pay guidelines (в плане ⚠) | не известно | Средняя | Severity-policy отдельно от детекта |
| Судебная практика | Все T1 | § 25/Art. 6 как Marktverhaltensregel; размер Art. 82 | постоянно | Средняя | Версионированные шаблоны текстов |
| TLS-криптография | TLS-04 | TR-02102-2 обновляется ежегодно (2026-01: TLS 1.2 до 2031, PQC-миграция) | каждый январь | Высокая (документ), низкая (влияние) | Пороги в ruleset с `source: TR-02102-2@2026-01` |
| E-mail-аутентификация | MAIL-* | TR-03182 v1.0 (2024) может обновиться | ⚠ | Низко-средняя | Правила как данные |
| Доступность | BFSG-01 | Гармонизированный стандарт и WCAG 2.2 | ⚠ | Средняя | Набор axe-тегов в ruleset |
| Переименования и новые нормы | LEGAL-02 | Изменения DDG/TDDDG 2026 (содержание ⚠); Widerrufsbutton | — | Средняя | Словарь паттернов с `validFrom` |
| Источники VULN | VULN-* | Финансирование CVE, зрелость EUVD, отчётность CRA | — | Средняя | Адаптеры источников, метаданные в evidence |
| (вне скоупа) AI Act Art. 50 — раскрытие чат-ботов | возможный EMBED-чек | Дата применения 02.08.2026; возможный сдвиг AI-omnibus ⚠ | ⚠ | — | Не делать в MVP |

### 10.2 Архитектурные принципы (для ТЗ «расширяемость без правок ядра»)

1. **Наблюдение отдельно от оценки.** Модуль проверки выдаёт `observations` с evidence (запрос, cookie, DOM-факт, DNS-запись). Отдельный слой `assessment` по **правовому профилю** превращает их в findings с уровнем. Детект меняется редко, оценка — с правом. Так Omnibus, DSK или новое решение суда обновляют профиль, а не код проверки.
2. **У каждой находки есть `legalBasis[]`** — машиночитаемо, с датами и статусом. Пример:

   ```yaml
   # illustrative, not final schema
   id: CONSENT-04
   rulesetVersion: 2026.10.0          # CalVer по Rechtsstand, независимо от semver CLI
   legalBasis:
     - ref: "TDDDG §25 Abs.1"
       kind: statute                  # statute | eu_regulation | eu_directive | guidance | case | standard | proposal
       jurisdiction: DE
       status: in_force               # in_force | proposed | withdrawn | guidance
       validFrom: 2024-05-14
       source: https://www.gesetze-im-internet.de/ttdsg/__25.html
       verifiedAt: 2026-10-30
     - ref: "DSK OH Digitale Dienste v1.2 Rn. 124-137"
       kind: guidance
       status: guidance
       verifiedAt: 2026-10-30
     - ref: "VG Hannover 10 A 5385/22 (19.03.2025)"
       kind: case
       verifiedAt: 2026-10-30
   watch:                              # что отслеживать
     - "EU Digital Omnibus 2025/0360(COD)"
   reviewBy: 2027-04-30
   ```

3. **Ruleset версионируется отдельно от CLI.** JSON-отчёт содержит `rulesetVersion`, `legalProfile` и `rechtsstand`, HTML-отчёт выводит «Prüfstand / Rechtsstand» рядом с дисклеймером. Для CI отчёт детерминирован: уровень зависит только от (observation, profile, config).
4. **Данные, а не код**: справочник вендоров (домен → вендор, категория цели, роль, DPF, `verifiedAt`), сигнатуры CMP, словарь устаревших норм, пороги криптографии, axe-теги. Обновляются PR в data-пакет. Фикстуры на каждую запись — для детектируемых.
5. **Защита от устаревания**: CI проекта предупреждает (а для статуса `proposed`/`guidance` — падает), если `reviewBy` прошёл или `verifiedAt` старше N месяцев. Чек-лист мониторинга: Omnibus (EP OEIL 2025/0360), апелляция Latombe, DSK OH, TR-02102-2, TR-03182, условия Google (reCAPTCHA/Maps/Fonts), EUVD terms.
6. **Шаблоны немецких текстов версионируются** (`templateVersion`) и ссылаются на `legalBasis.ref`. `id` и `crmCode` в JSON стабильны (контракт ТЗ), а текст может меняться.
7. **Профили**: `de-2026` (по умолчанию), `de-2026-strict` (например, EMBED static tiles и HDR → `warning`), `bfsg` (B2C), `nis2`, `eu-omnibus-preview` (не для CI-гейтинга, пометка «Entwurf, nicht geltendes Recht»).

---

## Источники

Первоисточники, прочитанные в этой сессии (✅):

| URL | Что подтверждает |
|---|---|
| https://www.gesetze-im-internet.de/ttdsg/__25.html | Текст § 25 TDDDG |
| https://www.gesetze-im-internet.de/ttdsg/__19.html | § 19 Abs. 4 TDDDG: Stand der Technik и шифрование |
| https://www.gesetze-im-internet.de/ttdsg/__26.html | § 26 TDDDG (PIMS) |
| https://www.gesetze-im-internet.de/ttdsg/BJNR198210021.html | Переименование mWv 14.05.2024 (Art. 8 G v. 6.5.2024 I Nr. 149); изменение G v. 10.3.2026 I Nr. 64 |
| https://www.gesetze-im-internet.de/ddg/__5.html | § 5 DDG (Impressum) |
| https://www.gesetze-im-internet.de/ddg/BJNR0950B0024.html | DDG от 06.05.2024, BGBl. 2024 I Nr. 149; изменения 2026 |
| https://www.gesetze-im-internet.de/einwv/ (§§ 1, 4, 7, 17–20) | Структура EinwV; § 18 Abs. 1 — добровольность |
| https://www.gesetze-im-internet.de/bfsg/__1.html, `__2.html`, `__3.html`, `__14.html`, `__20.html` | Сфера BFSG, определения, исключение Kleinstunternehmen, § 14, надзор |
| https://www.gesetze-im-internet.de/bsig_2025/__28.html, `__30.html` | Категории NIS2-субъектов, Stand der Technik |
| https://www.gesetze-im-internet.de/uwg_2004/__8.html, `__13.html` | Активная легитимация; § 13 Abs. 4 UWG |
| https://datenschutzkonferenz-online.de/media/oh/OH_Digitale_Dienste.pdf | DSK OH v1.2 (11/2024), Rn. 21, 58–60, 74–86, 101, 121–137 |
| https://edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf | EDPB Guidelines 2/2023 v2.0 (07.10.2024), Rn. 47–55 |
| https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/TechGuidelines/TR03182/BSI-TR-03182.pdf | TR-03182 v1.0 (24.01.2024): SPF/DKIM/DMARC/Unused Domains |
| https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/TechGuidelines/TG02102/BSI-TR-02102-2.pdf | TR-02102-2 версия 2026-01: TLS 1.3/1.2 (до 2031)/1.0–1.1 |
| https://curia.europa.eu/site/upload/docs/application/pdf/2026-03/cp260038de.pdf | EuGH C-526/24 Brillen Rottler (19.03.2026), PM 38/26 |
| https://www.europarl.europa.eu/legislative-train/theme-a-new-plan-for-europe-s-sustainable-prosperity-and-competitiveness/file-digital-package | 2025/0360(COD), COM(2025) 837, докладчики, сроки ЕП, отмена Coreper 26.06; обновлено 20.09.2026 |
| https://euvdservices.enisa.europa.eu/api/lastvulnerabilities, `/api/exploitedvulnerabilities` | Публичный API EUVD (живой ответ 30.10.2026) |
| https://www.enisa.europa.eu/about-enisa/legal-notice | Общие условия переиспользования материалов ENISA |

Вторичные или официальные без полного текста (🔶) и единичные источники (⚠):

| URL | Что подтверждает |
|---|---|
| https://www.consilium.europa.eu/en/press/press-releases/2026/10/21/digital-rulebook-council-agrees-position-to-simplify-data-protection-privacy-and-cyber-reporting-rules/ | Факт мандата Совета 21.10.2026 (страница закрыта бот-защитой, заголовок — по поиску) |
| https://euinternetpolicy.wordpress.com/2026/10/23/the-councils-digital-omnibus-mandate-what-it-would-change-in-the-gdpr/ | Содержание мандата по cookies (6 исключений, 4 мес., без 88b), doc 14756/26 |
| https://www.nicfab.eu/en/posts/digital-omnibus-council/ | Мандат 21.10.2026 (doc 13886/26 — расхождение) |
| https://www.heuking.de/de/news-events/newsletter-fachbeitraege/artikel/cookie-einwilligung-nach-dem-digital-omnibus-geplante-aenderungen-und-technische-umsetzung.html | Немецкая юрфирма 23.10.2026: позиция Совета, 4 мес., удаление сигналов в 06/2026 |
| https://ppc.land/eu-council-drops-cookie-signal-after-google-lobbying-eur-40-50-bn-at-stake/ | Компромисс 18.06.2026 удалил 88b, 88a с 6 мес. остался |
| https://www.osborneclarke.com/insights/digital-omnibus-reshapes-eu-cookie-rules-leaves-banner-fatigue-largely-intact | Содержание 88a/88b в предложении Комиссии |
| https://docs.sealmetrics.com/compliance/omnibus/cookies-eprivacy | Детали 88a(3)/(4), 88b(3)/(5)/(7) (вендорский источник) |
| https://edps.europa.eu/data-protection/our-work/publications/edps-edpb-joint-opinions/2026-02-10-edpb-edps-joint-opinion-digital-omnibus | EDPB-EDPS Joint Opinion 2/2026 (10.02.2026) |
| https://eur-lex.europa.eu/procedure/DE/2017_3 | Отзыв ePrivacy-VO (06.10.2025) |
| https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf | Cookie Banner Taskforce (18.01.2023) |
| https://www.datenschutzkonferenz-online.de/media/pm/DSK_Beschluss_Bewertung_von_Pur-Abo-Modellen_auf_Websites.pdf | DSK Beschluss Pur-Abo (22.03.2023) |
| https://www.ihk.de/hannover/hauptnavigation/recht/aktuell3/-alles-ablehnen-schaltflaeche-ist-pflicht-6562568 | VG Hannover 10 A 5385/22 — «Alles ablehnen» |
| https://www.tcilaw.de/en/german-court-google-tag-manager-only-permissible-with-consent/ | VG Hannover — GTM, повторный показ баннера |
| https://www.verbraucherzentrale.nrw/sites/default/files/2024-01/olg-koln-vom-19.01.2024_6-u-80_23_geschwarzt.pdf | OLG Köln 6 U 80/23 |
| https://www.verbraucherzentrale.nrw/urteilsdatenbank/digitale-welt/klauselkontrolle-bei-cookiebannern-und-drittstaatenstransfer-83922 | OLG Köln 6 U 58/23 (Telekom) |
| https://www.ra-plutte.de/lg-muenchen-dynamische-einbindung-google-web-fonts-ist-dsgvo/ | LG München I 3 O 17493/20 |
| https://ohn.haendlerbund.de/recht/urteile-entscheidungen/138187-urteil-zu-google-fonts-abmahnungen-ohrfeige-fuer-massenabmahner | LG München I 4 O 13063/22 (злоупотребление) |
| https://borncity.com/blog/?p=276222 | Обыски GenStA Berlin по делу Google-Fonts-абмахнеров |
| https://rewis.io/urteile/urteil/bri-17-01-2022-10-b-248621/ | VGH Kassel 10 B 2486/21 |
| https://curia.europa.eu/jcms/upload/docs/application/pdf/2024-10/cp240159en.pdf | EuGH C-21/23 (04.10.2024) |
| https://www.beck-aktuell.de/heute-im-recht/rechtsprechung/bgh-izr22219-medikamente-online-bestellen-gesundheitsdaten-dsgvo-einwilligung-2025-03-27 | BGH I ZR 222/19 (27.03.2025) |
| https://www.anwalt24.de/urteile/bgh/2024-11-18/vi-zr-10_24 | BGH VI ZR 10/24 |
| https://huntonak.com/privacy-and-information-security-law/cjeu-determines-that-a-mere-infringement-of-the-gdpr-is-not-sufficient-to-require-compensation | EuGH C-300/21 (04.05.2023) |
| https://www.otto-schmidt.de/news/wirtschaftsrecht/quirin-privatbank-unterlassungs-und-schadensersatzanspruche-nach-der-dsgvo-2025-09-05.html | EuGH C-655/23 |
| https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2025/09/pseudonymized-data-after-edps-v-srb.html | EuGH C-413/23 P |
| https://dataprotectionauthority.be/iab-europe-case-the-cjeu-answers-the-questions-referred-for-a-preliminary-ruling | EuGH C-604/22 |
| https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20251201-european-court-of-justice-to-review-challenge-to-eu-us-data-privacy-framework | Апелляция Latombe (pending) |
| https://docs.cloud.google.com/recaptcha/docs/faq ; https://heise.de/-11169180 | reCAPTCHA — процессор с 02.04.2026 |
| https://www.ihk.de/nordwestfalen/wirtschaftsspiegel-online/praxis-und-ratgeber/eu-stellt-online-streitschlichtung-ein-6505586 | Отключение OS-Plattform 20.07.2025 |
| https://www.noerr.com/de/insights/umsetzungsgesetz-zum-widerrufsbutton-veroeffentlicht | § 356a BGB с 19.06.2026 |
| https://www.usd.de/nis2umsucg-offiziell-in-kraft/ ; https://www.taylorwessing.com/de/insights-and-events/insights/2025/11/germanys-implementation-of-nis2 | NIS2UmsuCG в силе с 06.12.2025 |
| https://www.greenbone.net/en/blog/bsi-standards-tls-ssh-tr03116-4-tr02102-4/ | TR-03116-4 редакция 2025-07 (⚠) |
| https://www.heuking.de/de/news-events/newsletter-fachbeitraege/artikel/das-barrierefreiheitsstaerkungsgesetz-bfsg-teil-2-die-ersten-bfsg-abmahnungen-im-e-commerce.html | Первые BFSG-абмахнунги |
| https://digital-strategy.ec.europa.eu/en/news/eu-launches-european-vulnerability-database-boost-its-digital-security | Запуск EUVD 13.05.2025 |
| https://digital-strategy.ec.europa.eu/en/policies/cra-reporting ; https://www.mccannfitzgerald.com/knowledge/data-privacy-and-cyber-risk/cyber-resilience-act-reporting-obligations-apply-from-11-september-2026 | Отчётность CRA с 11.09.2026 |
| https://therecord.media/cisa-extends-cve-program-contract-with-mitre | Продление контракта CVE/MITRE до 03/2026 |
| https://www.e-recht24.de/tracking-cookies/13475-cookie-verordnung.html | EinwV в силе с 01.04.2025; Consenter признан 17.10.2025 (⚠ один источник) |
| https://www.haufe.de/recht/weitere-rechtsgebiete/wirtschaftsrecht/bundesverordnung-zur-cookie-einwilligung-einwv_210_635192.html | EinwV (дата и BGBl) |

---

## Открытые вопросы

1. **Точный текст мандата Совета** (номер документа 13886/26 или 14756/26; формулировки исключений и cooldown) — полный текст не прочитан: Consilium закрыт бот-защитой. Нужен ли нам `eu-omnibus-preview` уже в MVP, или достаточно данных в `watch`?
2. **CONSENT-04 для неблокирующих баннеров** (DSK Rn. 124): `info` или `warning`? Решение за заказчиком. Предлагаю `info`, чтобы не спорить с DSK.
3. **Cookieless pings Consent Mode v2 (Advanced)**: позиции немецкого надзора не нашли. Согласовать `warning` (наше предложение) или `critical`.
4. **Размер и тип компании влияют на применимость** (BFSG-исключение, § 13 Abs. 4 UWG, NIS2). Нужны ли CLI-флаги (`--b2c-shop`, `--employees`), или ограничиваемся пометкой «Anwendbarkeit prüfen»?
5. **Лицензия данных EUVD** — запросить у ENISA или найти terms EUVD до включения в проект Apache-2.0.
6. **Аннотация «передача за пределы ЕС»**: GeoIP/ASN неточны (anycast, EU-сущности US-компаний). Заказчик хочет показывать «Serverstandort», «Anbieter-Sitz» или DPF-статус? Предлагаю DPF-статус вендора плюс GeoIP как вспомогательное поле.
7. **CRA для самого `dsgvo-check`**: если seed-factory монетизирует инструмент или сервис вокруг него, нужна оценка роли (manufacturer или steward).
8. **Границы «пассивности»** для FILE-01/ADMIN-01 (§ 202a/§ 202c StGB, запросы к `/wp-json/wp/v2/users`) — нужна оценка юриста заказчика.
9. **Содержание изменений TDDDG (10.03.2026) и DDG (25.03.2026; 12.05.2026)** — затрагивают ли они § 5 DDG или § 25 TDDDG? Не проверено.
10. **Итог уголовного дела в Берлине** против Google-Fonts-абмахнеров и судебные решения по BFSG как Marktverhaltensregel — не найдены.
11. Может ли DSK выпустить OH v1.3 после мандата Совета, и стоит ли подписаться на её рассылку или Tätigkeitsberichte LfD как источник для `watch`?
