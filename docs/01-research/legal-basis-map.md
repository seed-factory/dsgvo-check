# dsgvo-check — правовая карта проверок (черновик для ревью DSGVO-экспертом)

Статус: черновик участника консенсус-панели (Claude Fable 5.1), 2026-10-30. Не юридическое заключение. Все номера дел, даты и версии, которые не удалось подтвердить по первоисточнику в этой сессии, помечены «⚠ проверить»; список того, что взято из общих знаний без повторной сверки, вынесен в конец раздела «Источники».

Входные документы: `specs/dsgvo-check_idea.md`, `specs/dsgvo-check_TZ.md`, `specs/dsgvo-check_katalog-proverok.md`, `docs/consensus/round-1/codex-gpt-6.1-terra_redteam-qa.md`.

---

## Коротко

1. **Ядро каталога (CONSENT-01…06, TRACK-01, EMBED-01…05) стоит на § 25 TDDDG + Art. 4 Nr. 11, 6, 7 DSGVO.** Линия устоявшаяся: EuGH *Planet49* (C-673/17) → BGH *Cookie-Einwilligung II* (I ZR 7/16) → § 25 TTDSG/TDDDG → DSK *OH Digitale Dienste* v1.2 (11/2024) → EDPB Cookie Banner Taskforce Report (17.01.2023) → EDPB Guidelines 2/2023 v2.0 (07.10.2024). Спорные зоны: обязательность «Ablehnen» на первом уровне (DSK Rn. 124–125: «nicht generell erforderlich», но «sehr häufig» обязательна, когда баннер блокирует страницу), reCAPTCHA как «Sicherheitskomponente», шрифты/статичные тайлы как § 25-событие vs. только Art. 6, «cookieless pings» Consent Mode.
2. **Сканер фиксирует факты, не нарушения.** Он видит запрос, cookie, DOM, заголовок, DNS-запись. Он не видит «unbedingt erforderlich», Rechtsgrundlage, Auftragsverarbeitungsvertrag, DPF-покрытие конкретного сервиса, роль получателя (Controller/Processor), место обработки. Отсюда трёхслойная модель находки: *Beobachtung* (факт с доказательством) → *Klassifikation* (категория из версионированной базы + уверенность) → *Rechtshinweis* (статический, одинаковый для всех сайтов текст с нормами). Правовой вывод о конкретном сайте — никогда.
3. **Сам EDPB признаёт пределы инструментов:** TF-Report, para 29 — существующие инструменты «do not allow to check the nature of the cookies but only to list the cookies placed». Наша база классификации — вспомогательный слой, не доказательство; «unknown» обязателен как класс.
4. **Безопасностные проверки (HDR, TLS, MAIL, VULN, DNS, SEC, FILE, ADMIN, HDR-02) имеют лишь косвенную правовую привязку:** Art. 32, 25 DSGVO и § 19 Abs. 4 TDDDG («als sicher anerkanntes Verschlüsselungsverfahren», «Stand der Technik»), BSI TR-02102-2 / TR-03108, для крупных организаций BSIG-neu (NIS2UmsuCG в силе с 06.12.2025). Судебной практики по заголовкам безопасности или SPF/DMARC нет. Эти находки — технические наблюдения с уровнем info/warning; слово «Verstoß» исключено. Для MAIL-* правовая связь с DSGVO самая слабая.
5. **RDG.** По логике BGH *Smartlaw* (I ZR 113/20, 09.09.2021) автоматический отчёт с фактами и общими правовыми Hinweisen сопоставим с Formularbuch — не Rechtsdienstleistung. Граница пересекается, когда текст делает индивидуальную правовую оценку («Ihre Website verstößt gegen § 25 TDDDG») — особенно если такой текст генерируется под сайт (LLM). Для заказчика, продающего аудиты, вопрос § 5 RDG (Nebenleistung) — отдельный, его должен закрыть его юрист.
6. **StGB.** GET к публично отдаваемому URL без Überwindung einer Zugangssicherung — не § 202a. Но *Modern Solution* (AG Jülich 01/2024 → LG Aachen 11/2024 → OLG Köln 07/2025, BVerfG Nichtannahme 09/2025 ⚠ Az.) показывает широкое толкование «besondere Sicherung», а реформа §§ 202a/b (RefE BMJ 11/2024) истекла с легислатурой; правительственного проекта на 10/2026 нет. Следствие для FILE-01: короткий документированный список путей, без рекурсии, без сохранения тела ответа, без использования найденного; § 202c — dual-use-инструменты легальны (BVerfG 2009), если назначение не преступное. § 303b — только при erhebliche Störung: rate limit и честный User-Agent снимают вопрос.
7. **Передача за пределы ЕС.** Технически устанавливаемо: IP/ASN/GeoIP хоста с точки наблюдения сканера, организация по RDAP/сертификату, наличие имени организации в DPF List. Не устанавливаемо: место обработки (anycast/CDN), договоры (SCC/AVV), роль получателя, покрытие конкретного сервиса сертификацией. GeoIP — атрибут находки, не отдельный вывод и не severity. Статус DPF на 30.10.2026: решение (EU) 2023/1795 в силе; T-553/23 *Latombe* отклонён 03.09.2025; апелляция C-703/25 P подана 31.10.2025, pending; после *Trump v. Slaughter* (US Supreme Court, 29.06.2026, отмена Humphrey's Executor для FTC) EDPB 31.07.2026 запросил у Комиссии пересмотр — ответа нет. Нельзя зашивать «US = unzulässig» или «DPF = alles gut».
8. **Правовая база движется, нужна версионируемая таблица Rechtslage в репо.** TTDSG → TDDDG и TMG → DDG (14.05.2024); EinwV (§ 26 TDDDG) в силе с 01.04.2025; ePrivacy-Verordnung официально отозвана (OJ 06.10.2025, C/2025/5423); Digital Omnibus: Комиссия 19.11.2025 предложила перенести cookie-правила в Art. 88a/88b DSGVO, Совет в мандате от 21.10.2026 от этого отказался и оставил Art. 5(3) ePrivacy с новыми исключениями (в т.ч. агрегированная Reichweitenmessung), Парламент позицию не принял. Если пройдёт — часть CONSENT-логики для first-party-аналитики изменится.
9. **Формулировки.** Запрещены «verstößt gegen», «rechtswidrig», «unzulässig», «nicht DSGVO-konform», «Abmahngefahr», «Bußgeld droht», «Datenleck», «manipulativ», а также зелёные «konform/bestanden» — отсутствие находки ≠ соответствие. Для каждой проверки ниже даны 1–2 немецких предложения-шаблона в стиле «nicht gefunden».
10. **§ 824 BGB / § 4 Nr. 2 UWG.** Неверное утверждение факта о чужом сайте («hat ein Datenleck») может быть actionable. Ещё один аргумент за чистую фактологию, указание методики, времени и точки наблюдения, и за то, чтобы отчёты по чужим сайтам не публиковались.

---

## 0. Легенда и метод

| Метка | Значение |
|---|---|
| **устоявшаяся** | Единая линия EuGH/BGH + надзорных органов (EDPB/DSK); отклоняющиеся решения единичны |
| **спорная** | Расходятся суды и/или надзорные органы, либо позиция ещё не проверена судами |
| **одиночная** | Одно решение/позиция одного органа без подтверждения выше |
| **тех. стандарт** | Нет правовой нормы, предписывающей именно эту меру; привязка только через Art. 32 DSGVO / § 19 TDDDG «Stand der Technik» и технические стандарты (BSI, RFC, OWASP) |

Терминология норм: DSGVO/DS-GVO (GDPR), TDDDG (бывш. TTDSG; официальное название «Telekommunikation-Digitale-Dienste-Datenschutz-Gesetz»; URL на gesetze-im-internet.de по-прежнему `/ttdsg/`), DDG (бывш. TMG), MStV (бывш. RStV), BFSG, UWG, RDG, StGB.

---

## 1. Нормативный каркас (справочник для всех таблиц)

| Норма | Содержание (кратко) | Для каких проверок |
|---|---|---|
| **§ 25 Abs. 1 TDDDG** | Speicherung/Zugriff на Endeinrichtung только с Einwilligung «auf der Grundlage von klaren und umfassenden Informationen»; требования к Einwilligung — по DSGVO | CONSENT-*, TRACK-01, EMBED-* (где есть cookies/Storage/JS-Auslesen) |
| **§ 25 Abs. 2 Nr. 1, 2 TDDDG** | Исключения: передача сообщения; «unbedingt erforderlich» для «ausdrücklich gewünschten digitalen Dienst» | Классификация «notwendig» vs. остальное |
| **§ 26 TDDDG + EinwV** (в силе 01.04.2025) | Anerkannte Dienste zur Einwilligungsverwaltung (PIMS); признание через BfDI; добровольны | Edge-case для CONSENT-03/04: сайт может опираться на PIMS-сигнал |
| **§ 19 Abs. 4 TDDDG** | Технические и организационные меры против unerlaubten Zugriff и Störungen, «Stand der Technik», «insbesondere die Anwendung eines als sicher anerkannten Verschlüsselungsverfahrens» | TLS-*, HDR-*, VULN-*, FILE-01, ADMIN-01 |
| **Art. 4 Nr. 11, Art. 7 DSGVO** | Einwilligung: freiwillig, informiert, unmissverständlich, aktiv; Widerruf so einfach wie Erteilung (Art. 7 Abs. 3) | CONSENT-04/05/06 |
| **Art. 5 Abs. 1 lit. a, Abs. 2 DSGVO** | Rechtmäßigkeit, Treu und Glauben, Transparenz; Rechenschaftspflicht | PRIV-*, CONSENT-* |
| **Art. 6 Abs. 1 DSGVO** | Rechtsgrundlagen для последующей обработки (после § 25-события) — Einwilligung или lit. f; EDPB TF para 24: для самого § 25/Art. 5(3)-события legitimes Interesse не Rechtsgrundlage | TRACK-01, EMBED-* |
| **Art. 12, 13 DSGVO** | Informationspflichten: Empfänger/Kategorien (13 Abs. 1 lit. e), Drittlandübermittlung (lit. f), Rechtsgrundlage (lit. c) | PRIV-01/02, LEGAL-01/02 |
| **Art. 25, 32 DSGVO** | Privacy by Design/Default; Sicherheit der Verarbeitung «Stand der Technik» | Все security-проверки |
| **Art. 26 DSGVO** | Gemeinsame Verantwortlichkeit (EuGH *Fashion ID*) | TRACK-01, EMBED-05 |
| **Art. 44 ff. DSGVO** | Drittlandübermittlung: Angemessenheitsbeschluss (DPF 2023/1795), SCC, Art. 49 | Атрибут «Server-Standort/Empfänger» |
| **§ 5 DDG** | Allgemeine Informationspflichten (Impressum): «leicht erkennbar, unmittelbar erreichbar und ständig verfügbar» | LEGAL-01/02 |
| **§ 18 MStV** | Дополнительные Informationspflichten для journalistisch-redaktionell gestaltete Angebote (Verantwortlicher) | LEGAL-01 (нельзя автоматически определить применимость) |
| **BFSG** (в силе 28.06.2025) | Barrierefreiheit для определённых B2C-продуктов/услуг, в т.ч. «Dienstleistungen im elektronischen Geschäftsverkehr»; исключение для Kleinstunternehmen (услуги) | BFSG-01 |
| **§ 3a UWG, § 8 Abs. 3 UWG, § 13 Abs. 4 UWG** | DSGVO и § 5 DDG как Marktverhaltensregeln → Mitbewerber могут требовать Unterlassung (EuGH *Lindenapotheke* C-21/23, BGH I ZR 222/19, 223/19 vom 27.03.2025); лимит на Abmahnkosten за Informationspflichten (⚠ точный объём § 13 Abs. 4) | Контекст риска, не объект проверки |
| **§ 2, § 3, § 5 RDG** | Rechtsdienstleistung = Tätigkeit in konkreten fremden Angelegenheiten mit rechtlicher Prüfung des Einzelfalls; разрешена только по закону; Nebenleistung | Раздел 4 |
| **§§ 202a, 202c, 303b StGB** | Ausspähen von Daten (с Überwindung der Zugangssicherung), Vorbereiten, Computersabotage | Раздел 4, FILE-01, TLS-04 |
| **§ 824 BGB, § 4 Nr. 2 UWG** | Kreditgefährdung / Herabsetzung durch unwahre Tatsachenbehauptungen | Формулировки отчёта |

Ключевые позиции надзорных органов, на которые опираются таблицы:

- **DSK, Orientierungshilfe für Anbieter:innen von digitalen Diensten (OH Digitale Dienste), Version 1.2, Stand November 2024** — актуальная редакция бывшей OH Telemedien; Rn. 8: «ergänzt die EDSA Guidelines 2/2023»; Rn. 24: активное чтение свойств устройства через JS = Zugriff; Rn. 73–74: гранулярная оценка по функциям, Basisdienst vs. Zusatzdienste (в списке Zusatzdienste прямо названы Kartendienste, Videos und Audios, Chatboxen, Kontaktformulare, Werbung, CMP); Rn. 74: Betrugsprävention/IT-Sicherheit могут относиться к Basisdienst; Rn. 78: «unbedingt erforderlich» = технически, не экономически; Rn. 87–90: DSK намеренно не даёт общего утверждения, что «Reichweitenmessung» возможна без Einwilligung; Rn. 101: Einbindung von Drittinhalten (Schriftarten, Skripte, Stadtpläne, Videos…) = Offenlegung an Drittserver → нужна Rechtsgrundlage nach Art. 6; Rn. 124–125: Ablehnfunktion на первом уровне «nicht generell erforderlich», но при блокирующем баннере «sehr häufig» обязательна; Rn. 127: Nudging допустим до границы wirksame Einwilligung; Rn. 134–137: Ablehnoption gleichwertig (Größe, Farbe, Kontrast, Schriftbild), кнопка «Einstellungen oder Ablehnen» на второй уровень — недостаточна; Fn. 58: DSK Anwendungshinweise zum DPF.
- **EDPB, Report of the work undertaken by the Cookie Banner Taskforce, adopted 17.01.2023** — Type A (нет reject на первом уровне): «vast majority» считает отсутствие reject-опции на любом уровне, где есть accept, нарушением; «few authorities» — нет. Type B: pre-ticked — недействительно (единогласно). Type C: ссылка вместо кнопки / вне баннера без визуальной поддержки — недействительно. Type D/E: цвета — case-by-case, кроме нечитаемого контраста. Type H: § 25-событие нельзя опереть на legitimes Interesse; при нарушении Art. 5(3) последующая обработка не может быть DSGVO-konform. Type I: «essential»-классификация — инструменты лишь перечисляют cookies. Type K: Widerruf so einfach wie Erteilung.
- **EDPB Guidelines 2/2023 on Technical Scope of Art. 5(3) ePrivacy Directive, Version 2.0, 07.10.2024** — широкое понимание «gaining access»: pixel/URL-tracking, fingerprinting, инструкция браузеру отправить информацию; важно для вопроса, является ли загрузка стороннего ресурса § 25-событием.
- **EDPB Guidelines 05/2020 on consent v1.1**, **Guidelines 3/2022 Dark patterns**, **Opinion 08/2024 Consent or Pay** (17.04.2024, для large online platforms), **DSK Beschluss Pur-Abo-Modelle** (22.03.2023), **WP29 Opinion 04/2012 (WP 194)** — критерии «strictly necessary».

---

## 2. Правовая карта проверок

### 2.1 P0 — нормы, решения, статус

| ID | Что ловим | Нормы | Ключевые решения / позиции | Статус |
|---|---|---|---|---|
| **PRIV-01** | Сервис работает, но не упомянут в Datenschutzerklärung | Art. 13 Abs. 1 lit. e (Empfänger oder Kategorien von Empfängern), lit. f (Drittland), lit. c (Rechtsgrundlage); Art. 12 Abs. 1; Art. 5 Abs. 1 lit. a, Abs. 2 | WP29/EDPB Transparency Guidelines WP260 rev.01 (⚠ не перепроверено): названные получатели предпочтительны, категории допустимы при достаточной детализации; EuGH *Österreichische Post* C-154/21 (12.01.2023, Art. 15: конкретные Empfänger по запросу) — тенденция к конкретности; DSK OH Rn. 101: Rechenschaftspflicht требует задокументировать Rechtsgrundlage для каждого Drittinhalt | Обязанность информировать — **устоявшаяся**; обязанность называть каждый сервис поимённо — **спорная** (категории vs. Namen) |
| **PRIV-02** | Политика утверждает обратное наблюдаемому | Art. 5 Abs. 1 lit. a (Transparenz, Treu und Glauben), Art. 12, 13; UWG § 5 (Irreführung) как возможный, но спорный путь | Прямых решений по «falsche Datenschutzerklärung» нет; LG München I 3 O 17493/20 (Google Fonts) — контекст для именно этого примера | Факт противоречия — сильное доказательство; квалификация как UWG-Irreführung — **спорная** |
| **CONSENT-01** | Сторонние запросы до любого клика по баннеру | § 25 Abs. 1 TDDDG (если Speicherung/Zugriff); Art. 6 Abs. 1 для Offenlegung IP/UA третьему серверу; Art. 44 ff. при третьей стране | EuGH *Planet49* C-673/17 (01.10.2019): Einwilligung требуется независимо от Personenbezug; BGH I ZR 7/16 (28.05.2020); EDPB TF para 7: «no cookies which require consent can be set without a consent»; VG Hannover 10 A 5385/22 (19.03.2025): по сообщениям — Google Tag Manager сам требует Einwilligung (⚠ деталь из вторичных источников); DSK OH Rn. 24 (JS-Auslesen = Zugriff), Rn. 101 | Для cookies/Storage/JS-Fingerprint — **устоявшаяся**; для «чистого» запроса ресурса без Speicherung/Zugriff — **спорная** (EDPB 2/2023 широко, суды не проверяли) |
| **CONSENT-02** | Не-необходимые cookies до согласия | § 25 Abs. 1, Abs. 2 Nr. 2 TDDDG; WP29 04/2012 (исключения: Session, Load-Balancing, UI-Präferenzen, Consent-Status, Auth, Security); DSK OH Rn. 78–83 (Wann/Wie lange/Was/Für wen) | *Planet49*; BGH I ZR 7/16; EDPB TF Type I (неверная «essential»-классификация); DSK OH Rn. 87–90 (Reichweitenmessung не автоматически notwendig) | **Устоявшаяся** по принципу; классификация конкретного cookie — всегда Einzelfall |
| **CONSENT-03** | Сторонние сервисы есть, баннера нет | § 25 Abs. 1 TDDDG; Art. 6, 13 | Те же; DSK OH Rn. 73–74 (гранулярно по функциям) | **Устоявшаяся**, если сервисы не unbedingt erforderlich; определение «erforderlich» — вне сканера |
| **CONSENT-04** | Нет равноценного отказа на первом уровне | Art. 4 Nr. 11, Art. 7 Abs. 3, Art. 5 Abs. 1 lit. a DSGVO; § 25 Abs. 1 TDDDG; UWG § 3a (Verbraucherverbände/Mitbewerber) | OLG Köln 6 U 80/23 (19.01.2024, wetteronline.de; VZ NRW): первая ступень «Akzeptieren»/«Einstellungen»/«X = Akzeptieren & Schließen» — нет gleichwertige Ablehnung, Einwilligung unfreiwillig; Revision nicht zugelassen (Rechtskraft ⚠); VG Hannover 10 A 5385/22 (19.03.2025, NOZ; LfD Nds.): Klage gegen Anordnung abgewiesen, «Alle akzeptieren»+«Einstellungen» = unzulässiges Hinlenken; LG Rostock 3 O 762/19 (15.09.2020): pre-ticked + «невидимая» reject-кнопка (Berufung ⚠); CNIL vs. Google/Facebook 31.12.2021 (150 M€/60 M€: refuser aussi facile qu'accepter); EDPB TF Type A («vast majority»); DSK OH Rn. 124–125, 134–137 | Требование gleichwertige Ablehnoption, когда баннер блокирует взаимодействие — **устоявшаяся** (суды + DSK + EDPB-большинство). Абсолютная обязанность кнопки на первом уровне при неблокирующем баннере — **спорная** (DSK: «nicht generell»). Pur-Abo как альтернатива — **спорная** (DSK 2023, EDPB 08/2024 только для крупных платформ) |
| **TRACK-01** | Аналитика и рекламные пиксели | § 25 TDDDG; Art. 6 Abs. 1 lit. a (lit. f для personalisierte Werbung отклонён EuGH *Meta/Bundeskartellamt* C-252/21, 04.07.2023 ⚠ Rn.); Art. 26 (EuGH *Fashion ID* C-40/17, 29.07.2019: Einbindung eines Plugins → gemeinsame Verantwortlichkeit для Erhebung/Übermittlung); Art. 44 ff. | Austrian DSB (12/2021) и CNIL (02/2022) по Google Analytics — pre-DPF (⚠ номера решений); EDPB TF Type H | **Устоявшаяся**: Einwilligung vor Laden; детали (Consent Mode, server-side tagging) — **спорные** |
| **EMBED-01** | Шрифты с внешних серверов | Art. 6 Abs. 1 (Offenlegung IP an Google/Adobe; EuGH *Breyer* C-582/14: dynamische IP = personenbezogen); § 25 TDDDG — спорно (нет Speicherung; «Zugriff» по EDPB 2/2023 возможно); Art. 44 ff. | LG München I 3 O 17493/20 (20.01.2022): Unterlassung + 100 € Schadensersatz, kein berechtigtes Interesse, т.к. lokale Einbindung möglich; LG München I 4 O 13063/22 (30.03.2023): negative Feststellungsklage gegen Massenabmahnung erfolgreich; GStA Berlin 12/2022: Durchsuchungen wegen Abmahnbetrug (исход ⚠); DSK OH Rn. 101 (Schriftarten как Drittinhalt → Art. 6) | Решение — **одиночное**, но согласуется с позицией DSK; Schadensersatz-часть широко отвергнута другими судами; квалификация как § 25-событие — **спорная** |
| **EMBED-02** | Карты до согласия | § 25 TDDDG (Google Maps iframe/JS ставит cookies: NID u.a.); Art. 6; Art. 44 ff.; DSK OH Rn. 74 (Kartendienste = Zusatzdienst), Rn. 101 (Stadtpläne), Rn. 123 (Inhalte von fremden Servern erst nach Einwilligung laden) | Судебных решений именно по Maps нет; позиция DSK последовательна; практика «Zwei-Klick» общепринята | Позиция надзора — **устоявшаяся**; судебная практика — отсутствует; статичные тайлы без cookies — только Art. 6, **спорно** |
| **MAIL-01** | DMARC нет / `p=none` | Art. 32 (Integrität/Authentizität при почтовой коммуникации с Betroffenen) — косвенно; BSI TR-03108-1; § 30 BSIG-neu только для besonders wichtige/wichtige Einrichtungen | Решений нет. Требования Google/Yahoo/Microsoft к отправителям (2024) — коммерческие, не правовые | **Тех. стандарт**; правовая связь с DSGVO слабая |
| **MAIL-02** | SPF нет / `~all` | Как MAIL-01 | — | **Тех. стандарт** |
| **HDR-01** | Нет заголовков безопасности | Art. 32, 25 DSGVO; § 19 Abs. 4 TDDDG; OWASP Secure Headers; BSI | Решений нет | **Тех. стандарт** |
| **TLS-01** | http не уводит на https | § 19 Abs. 4 S. 2 TDDDG («als sicher anerkanntes Verschlüsselungsverfahren»); Art. 32 Abs. 1 lit. a (Verschlüsselung), Art. 25; BSI TR-02102-2 (Version 2024-1 ⚠: TLS 1.3 bevorzugt, 1.2 zulässig) | Bußgelder nach Art. 32 существуют (напр. LfDI BW 2018, Knuddels, Klartext-Passwörter — ⚠ не TLS); Aufsichtsbehörden прямо называют Transportverschlüsselung обязательной для Formulare | **Устоявшаяся** как Pflicht zur Transportverschlüsselung при Erhebung personenbezogener Daten; для чисто статичной страницы без Formular — **спорно** |
| **TLS-02** | Сертификат чужой / невалиден / истекает | Как TLS-01 | — | Как TLS-01 |
| **LEGAL-01** | Нет Impressum или Datenschutzerklärung | § 5 Abs. 1 DDG; § 18 MStV (если journalistisch-redaktionell); Art. 13 DSGVO; Bußgeld-Tatbestand im DDG (ehem. § 16 TMG, bis 50.000 € ⚠ § prüfen); UWG § 3a, § 13 Abs. 4 | BGH I ZR 228/03 (20.07.2006): «Impressum»/«Kontakt» как Linkbezeichnung ok, erreichbar über zwei Klicks genügt; § 5 TMG/DDG als Marktverhaltensregel — устоявшаяся UWG-практика; Datenschutzerklärung: EuGH *Lindenapotheke* + BGH 27.03.2025 — DSGVO-Informationspflichten тоже Marktverhaltensregeln | **Устоявшаяся** |

### 2.2 P0 — факт vs. оценка, шаблоны (DE)

Общие правила для всех шаблонов: указывать URL, фазу (`vor Interaktion` / `nach Ablehnen` / `kein Banner erkannt`), источник и версию классификатора, время и точку наблюдения; значения cookies не выводить; слово «Einwilligung» использовать только как описание наблюдаемого действия («vor Interaktion mit dem Banner»), не как правовую констатацию «ohne Einwilligung».

| ID | Техника показывает | Вне досягаемости сканера | Шаблон находки (DE, черновик) |
|---|---|---|---|
| **PRIV-01** | Запросы к хосту X; отсутствие строки/алиасов в извлечённом тексте политики | Упоминание по категориям; текст в PDF/картинке/другом языке; «wir nutzen nicht X»; Auftragsverarbeiter, которого не обязательно называть | «Auf [URL] wurden Anfragen an [Host] beobachtet (Dienst laut Signaturdatenbank v[X]: [Name]). Im unter [Policy-URL] verarbeiteten Text wurde keine Nennung von „[Name]“ oder der bekannten Aliasse gefunden (Stand [Datum]). Eine Nennung nach Kategorien oder an anderer Stelle wurde nicht bewertet.» |
| **PRIV-02** | Цитата из политики + противоречащее наблюдение | Контекст цитаты (старая версия, цитата, другой раздел), временная задержка между правкой текста и деплоем | «Die Datenschutzerklärung enthält die Aussage „[Zitat]“ ([Policy-URL], Abschnitt [..]). Auf [n] geprüften Seiten wurden Anfragen an [Host] beobachtet (Beispiel: [URL], Phase: [..]). Beide Beobachtungen werden ohne rechtliche Bewertung nebeneinandergestellt.» |
| **CONSENT-01** | Запросы к сторонним хостам до клика, с временными метками, инициатором (script/css/iframe) | Unbedingt erforderlich (CDN собственного JS, платёжный провайдер), AVV, DPF-покрытие, internes Hosting под сторонним доменом | «Vor einer Interaktion mit dem Einwilligungsbanner wurden [n] Anfragen an Drittanbieter-Hosts beobachtet, darunter [Host] (Kategorie laut Signaturdatenbank v[X]: [Analyse/Marketing/unbekannt], Konfidenz [..]). Ob die Einbindung für den aufgerufenen Dienst unbedingt erforderlich ist, wurde nicht bewertet.» |
| **CONSENT-02** | Имя/домен/путь/срок/флаги cookie, кто поставил (Set-Cookie или script), фаза | Назначение cookie (DSK Rn. 79: Wann/Wie lange/Was/Für wen оцениваются содержательно), first-party-прокси аналитики | «Vor einer Interaktion mit dem Banner wurde das Cookie „[Name]“ (Domain [..], Laufzeit [..], gesetzt durch [Set-Cookie von Host / Skript URL]) gespeichert. Klassifikation laut Datenbank v[X]: [Kategorie/unbekannt]. Der Cookie-Wert wurde nicht gespeichert.» |
| **CONSENT-03** | Отсутствие распознанного баннера в DOM/frames/shadow DOM при заданных viewport/locale/таймауте; одновременные сторонние запросы | Гео-/A-B-зависимый баннер, PIMS-сигнал (§ 26 TDDDG/EinwV), баннер после скролла, «unbedingt erforderlich» | «Auf den geprüften Seiten wurde kein Einwilligungsbanner erkannt (geprüft: DOM inkl. Frames und Shadow DOM, Viewport [..], Sprache [..], Wartezeit [..] s). Gleichzeitig wurden Anfragen an [Hosts] beobachtet. Ein nicht erkanntes Banner ist nicht gleichbedeutend mit einem fehlenden Banner.» |
| **CONSENT-04** | Тексты и роли кнопок первого уровня, их размер/контраст (измеримо), блокирует ли баннер (overlay, scroll-lock), что происходит после клика | «Gleichwertigkeit» как правовая оценка; Pur-Abo-альтернатива; неблокирующий баннер (DSK Rn. 124); незнакомый CMP → строго `info` | «Auf der ersten Ebene des erkannten Banners ([CMP], Version [..]) wurden die Schaltflächen „[A]“ und „[B]“ gefunden; eine Schaltfläche mit ablehnender Bezeichnung wurde auf dieser Ebene nicht gefunden. Das Banner blockiert die Interaktion mit der Seite: [ja/nein]; Flächenverhältnis der Schaltflächen: [..].» Для нераспознанного: «Banner nicht erkannt – die Ablehnoption konnte nicht geprüft werden.» (`info`) |
| **TRACK-01** | Сигнатура сервиса (хост/паттерн), страницы, фаза; связь с CONSENT-01 по общему доказательству | Договорная роль (Art. 26/28), серверная конфигурация (IP-Anonymisierung, Consent Mode), Rechtsgrundlage | «Auf [n] Seiten wurde der Dienst [Name] geladen (Signatur: [Host/Pattern], Kategorie laut Datenbank v[X]: [..]); Zeitpunkt relativ zur Banner-Interaktion: [vor/nach/kein Banner erkannt].» |
| **EMBED-01** | Запросы к fonts.googleapis.com / fonts.gstatic.com / use.typekit.net, инициирующий CSS, страницы, фаза | Возможность lokaler Einbindung (почти всегда есть, но это оценка), Einwilligung на второй ступени, Rechtsgrundlage | «Schriftdateien wurden von [Host] geladen (Seiten: [..]; Auslöser: [CSS-URL]; Phase: [..]). Ob eine lokale Einbindung möglich oder eine Rechtsgrundlage dokumentiert ist, wurde nicht bewertet.» |
| **EMBED-02** | Тип встраивания (iframe/JS API/Static Maps), хост, cookies, фаза | Zwei-Klick-Lösung с другим триггером, статичное изображение карты с собственного сервера | «Auf [URL] wurden Ressourcen des Kartendienstes [..] von [Host] geladen (Typ: [iframe/JS/Static-Tiles]; Phase: [..]). Dabei gesetzte Cookies: [Liste/keine].» |
| **MAIL-01** | TXT-запись `_dmarc.<domain>` с указанием резолвера и времени; различать NXDOMAIN/NODATA/SERVFAIL/timeout | Отправляет ли домен почту вообще; политика у провайдера; субдомены | «Für [domain] wurde kein DMARC-Eintrag unter _dmarc.[domain] gefunden / der DMARC-Eintrag enthält „p=none“ (Resolver [..], [Zeit]). Der Befund beschreibt die DNS-Konfiguration und trifft keine Aussage über den tatsächlichen Mailversand.» |
| **MAIL-02** | SPF TXT, Qualifier `~all`/`-all`/`?all`, число Lookups | Как MAIL-01 | «Für [domain] wurde kein SPF-Eintrag gefunden / der SPF-Eintrag endet auf „~all“ (Softfail).» |
| **HDR-01** | Наличие/отсутствие конкретных заголовков в ответе URL | Компенсирующие меры (meta CSP, WAF), риск-оценка | «In der Antwort von [URL] wurden folgende Header nicht gefunden: [Liste]. Vorhanden: [Liste]. Der Befund beschreibt die Antwort zum Prüfzeitpunkt und enthält keine Risikobewertung.» |
| **TLS-01** | Статус/редирект для `http://`, наличие HSTS | Обрабатываются ли на странице personenbezogene Daten | «http://[host]/ antwortete mit HTTP [200] ohne Weiterleitung auf https://; ein Strict-Transport-Security-Header wurde nicht gefunden.» |
| **TLS-02** | CN/SAN, срок, цепочка относительно указанного trust store | Обрабатываются ли personenbezogene Daten; внутренние/служебные хосты | «Das für https://[host] präsentierte Zertifikat ist für „[CN/SAN]“ ausgestellt und deckt [host] nicht ab / ist seit [Datum] abgelaufen / wird gegen die Vertrauensliste [Quelle, Stand] nicht als gültig erkannt.» |
| **LEGAL-01** | Наличие ссылок с известными метками на каждой посещённой странице, статус/содержимое целевой страницы, soft-404 | Доступность через иные метки/меню, § 18 MStV-применимость, полнота содержания Impressum (Art. 13-полнота) | «Auf [n] von [m] geprüften Seiten wurde kein Link mit der Bezeichnung „Impressum“ / „Datenschutz(erklärung)“ oder bekannten Varianten gefunden bzw. der Link führt auf „#“ / HTTP [..]. Geprüft: [Seitenliste], Viewport [..]. Ob die Angaben an anderer Stelle bereitgestellt werden, wurde nicht geprüft.» |

### 2.3 P1 — нормы, решения, статус

| ID | Что ловим | Нормы | Ключевые решения / позиции | Статус |
|---|---|---|---|---|
| **EMBED-03** | Видео до согласия (YouTube, i.ytimg.com) | § 25 TDDDG (YouTube-Embed ставит cookies/Storage, в т.ч. при `youtube-nocookie.com` частично ⚠); Art. 6; Art. 44 ff.; DSK OH Rn. 74 («Videos und Audios» = Zusatzdienst), Rn. 101, Rn. 123; EDPB 2/2023 | Судебных решений именно по YouTube-Embeds нет; практика Aufsichtsbehörden единодушна: Einwilligung vor Laden | Позиция надзора — **устоявшаяся**, суды — нет; Vorschaubild с i.ytimg.com без cookies — только Art. 6, **спорно** |
| **EMBED-04** | reCAPTCHA до согласия | § 25 Abs. 1 vs. Abs. 2 Nr. 2 (Sicherheitsfunktion; DSK OH Rn. 74: Betrugsprävention/IT-Sicherheit könnten zum Basisdienst gehören); Art. 6 Abs. 1 lit. f; Art. 44 ff. | CNIL vs. Cityscoot (16.03.2023, 125 000 €, ⚠ Nr. SAN-2023-…): reCAPTCHA ohne Einwilligung bei Login/Registrierung → Verstoß gegen Art. 82 Loi Informatique et Libertés (= Art. 5(3) ePrivacy); deutsche Aufsichtsbehörden (BayLDA FAQ ⚠) требуют Einwilligung | **Спорная**: безопасность как Basisdienst vs. масштаб передаваемых данных Google. Факт «на каждой странице, не только у формы» — сильный аргумент против «erforderlich», но это оценка |
| **EMBED-05** | Виджеты (Elfsight, Instagram-Feed) | § 25 TDDDG (cookies/localStorage виджета); Art. 6; Art. 26 (*Fashion ID*); Art. 44 ff. | *Fashion ID* C-40/17 для Social-Plugins; DSK OH Rn. 101 («Inhalte von Social-Media-Diensten») | Для Social-Plugins — **устоявшаяся**; для произвольных виджетов — Einzelfall |
| **CONSENT-05** | Запросы не прекращаются после отказа | § 25 Abs. 1 TDDDG (нет Einwilligung → нет Erlaubnis); Art. 7 Abs. 3, Art. 4 Nr. 11; Art. 5 Abs. 1 lit. a | Прямых решений нет; логически — чистый случай без Einwilligung; EDPB TF Type H para 24 | **Устоявшаяся** по принципу; технические исключения (CMP-Endpunkte, Requests, начатые до клика, Consent-Mode-«cookieless pings») — **спорные** |
| **CONSENT-06** | Consent Mode default `granted` | § 25 TDDDG; Art. 6; Art. 7 (Einwilligung muss vor Verarbeitung vorliegen); Googles eigene EEA-Anforderung (Consent Mode v2 seit 03/2024 ⚠ — vertraglich/technisch, nicht gesetzlich) | Решений нет | **Устоявшаяся** как следствие § 25 (default `granted` до клика = Tag feuert ohne Einwilligung); оценка «advanced mode» — **спорная** |
| **VULN-01** | Устаревшее ядро CMS с CVE | Art. 32 Abs. 1 lit. b, d; Art. 25; § 19 Abs. 4 TDDDG; Art. 33/34 при реальном Vorfall; § 30 BSIG-neu для in-scope | Bußgelder за veraltete Software у Aufsichtsbehörden есть (⚠ конкретные не проверялись); *Modern Solution* — контекст для сообщений об уязвимостях | **Устоявшаяся** как Pflicht zu Updates nach Stand der Technik; но привязка CVE к установке — всегда Einzelfall |
| **VULN-02** | Устаревшие плагины/библиотеки с CVE | Как VULN-01; CISA KEV как источник приоритизации (не правовой критерий) | — | Как VULN-01 |
| **MAIL-03** | DKIM не найден | Как MAIL-01 | — | **Тех. стандарт**; «не найден для проверенных селекторов» — единственно корректная формулировка |
| **TLS-03** | Смешанный контент | Art. 32; § 19 Abs. 4 TDDDG; браузеры блокируют active mixed content | — | **Тех. стандарт** |
| **TLS-04** | Старые версии TLS (1.0/1.1) | Art. 32; § 19 Abs. 4 TDDDG; BSI TR-02102-2 (2024-1 ⚠); RFC 8996 (deprecates TLS 1.0/1.1) | — | **Тех. стандарт**; активный handshake-probe — согласовать с «пассивным» режимом (см. раздел 4) |

### 2.4 P1 — факт vs. оценка, шаблоны (DE)

| ID | Техника показывает | Вне досягаемости | Шаблон (DE) |
|---|---|---|---|
| **EMBED-03** | Хост, тип ресурса (Thumbnail/Player/API), cookies/Storage, фаза | Zwei-Klick с нестандартным триггером; privacy-enhanced-Modus как «ausreichend» | «Auf [URL] wurden Ressourcen von [i.ytimg.com / www.youtube.com] geladen (Typ: [Vorschaubild/Player]; Phase: [..]). Dabei gesetzte Cookies/Storage-Einträge: [Liste/keine].» |
| **EMBED-04** | Скрипт reCAPTCHA, страницы с/без формы, фаза | Является ли Sicherheitsfunktion «unbedingt erforderlich»; есть ли Formular в скрытом состоянии | «Das Skript [www.google.com/recaptcha/…] wurde auf [n] Seiten geladen, davon [k] Seiten ohne erkanntes Formular (Phase: [..]). Die Zuordnung zu einer Sicherheitsfunktion wurde nicht bewertet.» |
| **EMBED-05** | Хост виджета, cookies/Storage, фаза | Договорная конструкция с провайдером виджета | «Das Widget [Name] wurde von [Host] geladen (Seiten: [..]; Phase: [..]); gesetzte Cookies/Storage-Einträge: [..].» |
| **CONSENT-05** | Запросы с меткой времени после клика и после перезагрузки; инициатор; отдельно CMP-эндпоинты | Назначение запроса (Analyse vs. technischer Ping), серверная обработка | «Nach Betätigung der Schaltfläche „[Text]“ und anschließendem Neuladen wurden [n] Anfragen an [Hosts] beobachtet, die nach dem Klick begonnen haben (Beispiel: [URL], +[t] ms). Anfragen an den Anbieter des Einwilligungsbanners sind gesondert ausgewiesen.» |
| **CONSENT-06** | Перехваченный вызов `gtag('consent','default',…)`/`dataLayer.push`, его параметры, время относительно тегов и CMP-состояния | Серверная конфигурация GTM, регионы, порядок обновления | «Vor einer Interaktion wurde ein Aufruf gtag('consent','default', …) mit [analytics_storage: 'granted'] beobachtet (Quelle: [Script-URL], [Zeit]). Der zeitgleich ausgelesene Status des Einwilligungsbanners lautete [denied/unbekannt].» |
| **VULN-01** | Строка версии и её источник (meta generator, readme, Pfad, Header), сопоставление с базой CVE (версия базы, дата) | Реальная установленная версия (Backports), Patch-Status, Ausnutzbarkeit, Netzwerkkontext | «Im Quelltext von [URL] wurde die Angabe „[WordPress 6.2.1]“ gefunden (Quelle: [meta generator]). Für diese Versionsangabe listet [Datenbank, Stand] [n] CVE, darunter [CVE-ID] (CISA KEV: [ja/nein]). Die tatsächlich installierte Version und die Ausnutzbarkeit wurden nicht verifiziert.» |
| **VULN-02** | Как VULN-01 для компонента | Как VULN-01 | «Die Datei [URL] enthält die Versionskennung „[jQuery 3.4.1]“. Für diese Version listet [Datenbank, Stand] [CVE-IDs]. Ob der betroffene Code-Pfad genutzt wird, wurde nicht geprüft.» |
| **MAIL-03** | Отсутствие TXT для проверенных селекторов | Нестандартные селекторы провайдера | «Für [domain] wurde unter den geprüften DKIM-Selektoren ([Liste]) kein Eintrag gefunden. Andere Selektoren wurden nicht geprüft.» |
| **TLS-03** | Список http-ресурсов на https-странице, тип | Upgrade-Insecure-Requests, блокировка браузером | «Auf der HTTPS-Seite [URL] wurden [n] Ressourcen über http:// angefordert (Typ: [img/script]; Beispiel: [URL]).» |
| **TLS-04** | Принят ли handshake конкретной версии (инструмент, SNI, IP, edge) | Разные edge-узлы/CDN, политика хостера | «Der Server [host]:443 ([IP]) hat einen Handshake mit TLS 1.0 angenommen (Prüfwerkzeug [..], SNI [host]). TLS 1.1: [angenommen/abgelehnt].» |

### 2.5 P2 — нормы, решения, статус

| ID | Что ловим | Нормы | Решения / позиции | Статус |
|---|---|---|---|---|
| **DNS-01** | Нет CAA / DNSSEC | Нет правовой нормы; RFC 8659 (CAA), CA/B Forum Baseline Requirements (CA обязаны проверять CAA); Art. 32 лишь отдалённо | — | **Тех. стандарт**, только `info` |
| **HDR-02** | Cookies без Secure/HttpOnly/SameSite; версии в заголовках | Art. 32; § 19 Abs. 4 TDDDG | — | **Тех. стандарт** |
| **ADMIN-01** | Публичные логины WP, открытый xmlrpc | Art. 32; Art. 5 Abs. 1 lit. c, f (Benutzernamen = personenbezogene Daten, Art. 4 Nr. 1); § 19 Abs. 4 TDDDG | — | **Тех. стандарт** + Art. 5-аспект для имён пользователей |
| **FILE-01** | Открытые `.git/`, `.env`, бэкапы | Art. 32; Art. 33/34 (Meldepflicht — решает Verantwortlicher, не сканер); § 19 Abs. 4 TDDDG; для сканера: §§ 202a/202c StGB, GeschGehG § 4 (если сохранить/использовать Geheimnisse) | *Modern Solution* (см. раздел 4) — риск для исследователей; BVerfG 2 BvR 2233/07 (18.05.2009, ⚠ дата/Az.) — § 202c и dual-use | **Устоявшаяся** как грубое нарушение Art. 32 при подтверждённой утечке; подтверждение без чтения содержимого — ограничено |
| **SEC-01** | Нет `security.txt` | RFC 9116 — рекомендация; нет закона; BSI/CERT-Bund рекомендуют | — | **Тех. стандарт**, только `info` |
| **LEGAL-02** | В Impressum/Datenschutzerklärung ссылки на старые законы (TMG, RStV, TTDSG) | § 5 DDG (с 14.05.2024), § 18 MStV (с 07.11.2020), TDDDG (с 14.05.2024); Art. 13 Abs. 1 lit. c (veraltete Rechtsgrundlage, напр. «§ 15 Abs. 3 TMG») | Устаревшее обозначение нормы само по себе не делает Impressum unvollständig (h.M. ⚠ без Nachweis); для Datenschutzerklärung — вопрос Transparenz | `info`; для Rechtsgrundlage-ссылок на TMG — возможно `warning` как Transparenz-Hinweis, **спорно** |
| **BFSG-01** | Базовая доступность (axe-core) | BFSG (28.06.2025) + BFSGV → EN 301 549 / WCAG 2.1 AA; Anwendungsbereich: B2C, bestimmte Dienstleistungen (E-Commerce, Bank, Telekom…); Ausnahme Kleinstunternehmen (Dienstleistungen); Marktüberwachung durch MLBF; Verbandsklage | Практики пока нет | Обязанность — **устоявшаяся** для in-scope; применимость к конкретному сайту сканер не определяет; автоматика покрывает лишь часть WCAG |
| **PERF-01** | Core Web Vitals (Lighthouse) | Нет правовой нормы | — | **Без правовой привязки**; маркировать явно «kein Rechtsbezug» |

### 2.6 P2 — факт vs. оценка, шаблоны (DE)

| ID | Техника показывает | Вне досягаемости | Шаблон (DE) |
|---|---|---|---|
| **DNS-01** | Наличие CAA; DS/RRSIG у валидирующего резолвера (secure/insecure/bogus) | — | «Für [domain] wurde kein CAA-Eintrag gefunden; DNSSEC: keine signierte Delegation festgestellt (validierender Resolver [..]). Hinweis: Für beide Mechanismen besteht keine gesetzliche Pflicht.» |
| **HDR-02** | Атрибуты Set-Cookie; заголовки `Server`/`X-Powered-By` | Компенсирующие меры | «Das Cookie „[Name]“ wurde ohne die Attribute [Secure/HttpOnly/SameSite] gesetzt. Der Header „X-Powered-By: [PHP/7.4]“ wurde in der Antwort von [URL] gefunden.» |
| **ADMIN-01** | Статус и количество записей `/wp-json/wp/v2/users` (содержимое не хранить), статус `xmlrpc.php` | Защита на уровне WAF/2FA, назначение аккаунтов | «Der Endpunkt /wp-json/wp/v2/users antwortete mit HTTP 200 und [n] Einträgen (Inhalte nicht gespeichert); /xmlrpc.php antwortete mit HTTP [..]. Es wurden keine Anmeldeversuche unternommen.» |
| **FILE-01** | Статус, Content-Type, размер, совпадение первых байт с ожидаемым форматом; soft-404-отсев | Полнота файла, актуальность секретов, реальная утечка | «Der Pfad [/.git/HEAD] antwortete mit HTTP 200 und einem Inhalt, der dem erwarteten Format ([ref: refs/heads/…]) entspricht (Content-Type [..], Größe [..] Bytes). Der Inhalt wurde nicht gespeichert; weitere Pfade wurden nicht abgerufen.» |
| **SEC-01** | Статус `/.well-known/security.txt` | — | «Unter /.well-known/security.txt wurde keine Datei gefunden (HTTP [..]). RFC 9116 ist eine Empfehlung ohne gesetzliche Verpflichtung.» |
| **LEGAL-02** | Найденные строки «§ 5 TMG», «RStV», «TTDSG», «§ 15 TMG» | Полнота и правильность самих Angaben | «Im Impressum / in der Datenschutzerklärung wurden Verweise auf „[§ 5 TMG]“ gefunden. Diese Vorschrift wurde am [14.05.2024] durch [§ 5 DDG] abgelöst. Die Nennung der alten Bezeichnung trifft für sich genommen keine Aussage über die Vollständigkeit der Angaben.» |
| **BFSG-01** | Нарушения правил axe-core с ID правила, элементами, страницами, уровнем WCAG | Anwendungsbereich BFSG (B2C? Kleinstunternehmen? Art der Dienstleistung), ручные WCAG-критерии | «axe-core v[..] meldete [n] Regelverletzungen (WCAG 2.1 [A/AA], z. B. [rule-id], [n] Elemente) auf [Seiten]. Ob der Dienst in den Anwendungsbereich des BFSG fällt, wurde nicht geprüft; automatisierte Tests erfassen nur einen Teil der WCAG-Kriterien.» |
| **PERF-01** | Метрики Lighthouse, крупнейшие ресурсы | — | «Lighthouse v[..]: LCP [..] s, größte Ressource [URL] ([..] MB). Informativer Hinweis ohne Rechtsbezug.» |

---

## 3. Формулировки: правила, запреты, дисклеймер

### 3.1 Принципы

1. **Три слоя в JSON и в тексте:** `observation` (факт + evidence), `classification` (категория, источник базы, версия, confidence), `legalNote` (статический текст по `checkId`, одинаковый для всех сайтов, с нормами и ссылками на позиции органов). Слой `legalNote` не ссылается на конкретный сайт и не содержит глаголов оценки.
2. **Отсутствие находки ≠ соответствие.** Статусы проверки `completed/partial/inconclusive/error/skipped`; никаких «bestanden», «konform», «✅ DSGVO-konform», «Score 92/100 DSGVO». Допустимо: «Keine Beobachtung» / «Nicht geprüft» / «Nicht auswertbar».
3. **Пассив и наблюдение:** «wurde beobachtet», «wurde gefunden / nicht gefunden», «antwortete mit», «enthält». Субъект — ресурс/запрос/заголовок, не «der Betreiber».
4. **Каждая находка несёт контекст воспроизводимости:** URL, время (UTC), точка наблюдения (ASN/страна сканера), User-Agent, viewport, locale, версия сканера и баз. Это одновременно защита от § 824 BGB (проверяемое утверждение факта) и требование Rechenschaft самого инструмента.
5. **Фаза вместо правового статуса:** `vor Interaktion mit dem Banner`, `nach Betätigung von „[Text]“`, `kein Banner erkannt` — вместо «ohne Einwilligung».
6. **Классификация с происхождением:** «Kategorie laut Signaturdatenbank v[X] (Quelle: [..]), Konfidenz [..]» — никогда «Tracker» как голая метка.
7. **Нераспознанный баннер** → `info: Banner nicht erkannt`, зависимые проверки `inconclusive` (требование ТЗ).

### 3.2 Запрещённые формулировки (черновик для стайлгайда)

| Запрещено | Почему | Заменить на |
|---|---|---|
| «verstößt gegen DSGVO/TDDDG/DDG», «Verstoß», «rechtswidrig», «illegal», «unzulässig», «nicht DSGVO-konform», «DSGVO-Verstoß» | Индивидуальная правовая оценка (RDG-риск, § 824 BGB) | «wurde beobachtet», «nicht gefunden», ссылка на статический Rechtshinweis |
| «ohne Einwilligung», «ohne Rechtsgrundlage» | Сканер не знает, есть ли Einwilligung/Rechtsgrundlage (PIMS, Vertrag, lit. f) | «vor Interaktion mit dem Banner», «Rechtsgrundlage wurde nicht bewertet» |
| «Tracker», «Tracking-Cookie», «Spionage», «Überwachung» как метка | Квалификация без доказательства назначения | «Dienst der Kategorie Analyse/Marketing laut Datenbank v[X]» |
| «Datenübermittlung in die USA / in ein Drittland» | GeoIP ≠ место обработки; роль получателя неизвестна | «Server-Standort laut GeoIP-Datenbank [X, Stand]: US» |
| «unbedingt erforderlich» / «nicht erforderlich» как вывод | Юридическая оценка (§ 25 Abs. 2 Nr. 2) | «Die Erforderlichkeit wurde nicht bewertet» |
| «manipulativ», «Dark Pattern», «täuschend», «irreführend» | Оценочные термины из Rechtsprechung | Измеримые факты: тексты кнопок, размеры, контраст, блокировка |
| «Datenleck», «Sicherheitslücke», «angreifbar», «verwundbar», «unsicher», «kritische Schwachstelle» | Утверждение факта о чужой системе без верификации | «Versionsangabe gefunden; Datenbank listet CVE …»; «Pfad antwortete mit HTTP 200» |
| «Abmahngefahr», «Bußgeld droht», «Haftungsrisiko», «Schadensersatzpflicht» | Прогноз правовых последствий = Rechtsberatung | Убрать; в общем дисклеймере — абстрактная ссылка на нормы |
| «Impressumspflicht verletzt», «fehlendes Impressum», «Datenschutzerklärung fehlt» | Сканер видел лишь посещённые страницы и метки | «Link … nicht gefunden auf [n] von [m] Seiten» |
| «sicher», «geschützt», «konform», «bestanden», «grün» | Negative proof невозможен | «Keine Beobachtung», «nicht geprüft» |
| «Google/Meta speichert…», «leitet weiter an…», «der Betreiber hat…» | Утверждения о поведении третьих лиц/намерениях | Описывать только наблюдаемый запрос |
| Любой генерируемый под сайт правовой текст (LLM-«Erklärung») | Выходит за рамки Smartlaw-логики (generisches Formular) | Статический текст по `checkId` |

### 3.3 Дисклеймер отчёта (черновик DE, на вычитку заказчику)

> **Hinweis zur Art dieses Berichts.** Dieser Bericht wurde automatisiert durch `dsgvo-check` v[..] am [Datum, UTC] aus [Netzwerk/ASN, Land] mit dem User-Agent „[..]“ erstellt. Er dokumentiert technische Beobachtungen (Netzwerkanfragen, Cookies, Seitenelemente, HTTP-Header, DNS-Einträge) zum Prüfzeitpunkt und ordnet sie anhand einer versionierten Signaturdatenbank (v[..]) Kategorien zu. Die zu den einzelnen Prüfungen genannten Rechtsvorschriften und Veröffentlichungen von Aufsichtsbehörden dienen der Orientierung; sie sind allgemeiner Natur und beziehen sich nicht auf die rechtliche Bewertung der geprüften Website. Der Bericht trifft keine Aussage darüber, ob die geprüfte Website geltendes Recht einhält oder verletzt; dies hängt von Umständen ab, die automatisiert nicht erfasst werden können (u. a. vertragliche Regelungen, Rechtsgrundlagen, Erforderlichkeit einzelner Funktionen, Standort der Datenverarbeitung). Das Fehlen einer Beobachtung bedeutet nicht, dass keine Beanstandung möglich wäre. Der Bericht ersetzt keine Rechtsberatung und keine Prüfung durch eine fachkundige Person. Beobachtete Werte von Cookies, Formularen und Dateiinhalten werden nicht gespeichert. Die Software wird unter der Apache License 2.0 ohne Gewährleistung bereitgestellt (Abschnitte 7 und 8 der Lizenz).

---

## 4. Правовые рамки самого инструмента

### 4.1 RDG и автоматизированные оценки

- **Норма.** § 2 Abs. 1 RDG: Rechtsdienstleistung — «jede Tätigkeit in konkreten fremden Angelegenheiten, sobald sie eine rechtliche Prüfung des Einzelfalls erfordert». § 3 RDG: разрешена только в объёме, предусмотренном законом; § 5 RDG — Nebenleistung к иной профессиональной деятельности.
- **BGH *Smartlaw*, Urteil vom 09.09.2021, I ZR 113/20.** Digitaler Vertragsdokumentengenerator (Frage-Antwort-Baum) — не Rechtsdienstleistung: провайдер не действует в конкретной фремден Angelegenheit, продукт сопоставим с Formularhandbuch, пользователь знает, что программа не заменяет Anwalt. Комментарий ограничивает вывод алгоритмами с предопределёнными деревьями решений (не ИИ-оценка) — ⚠ это чтение комментаторов, не ratio decidendi.
- **Перенос на dsgvo-check.** Фактический слой и статический `legalNote` по `checkId` → по той же логике generisches Hilfsmittel, не Rechtsdienstleistung. Риск возрастает, если: (a) текст делает вывод о конкретном сайте («verstößt», «unzulässig»); (b) текст генерируется индивидуально под сайт (LLM-объяснения); (c) инструмент предлагается как «Rechtsprüfung»/«Compliance-Gutachten». Архитектурное следствие: тексты — статические, версионированные, вычитанные заказчиком; никакой генерации правовых оценок per-site в MVP.
- **Отдельный вопрос заказчика.** Агентство, продающее «DSGVO-Audits» клиентам с правовыми выводами, само может оказывать Rechtsdienstleistung; защита через § 5 RDG (Nebenleistung zur Webentwicklung/IT-Sicherheit) — спорна и зависит от объёма. RDG как Marktverhaltensregel → Abmahnung durch Kammern/Wettbewerber возможна. Это вне скоупа инструмента, но влияет на тексты, которые заказчик добавит в отчёт.

### 4.2 Требования к дисклеймеру и ответственность авторов open source

- **Что должен содержать дисклеймер:** автоматизированный характер; время/точка наблюдения/UA; что фиксируется и что нет; «kein Rechtsrat»; отсутствие находки ≠ соответствие; версии баз и сканера; что не сохраняется (значения cookies, тела файлов); лицензия и отказ от гарантий. Черновик — в 3.3.
- **Apache-2.0 §§ 7, 8** (Disclaimer of Warranty, Limitation of Liability) действуют как договорная основа, но по немецкому праву: безвозмездная передача ПО обычно квалифицируется по аналогии с Schenkung/Leihe (§§ 521, 599 BGB: Haftung nur für Vorsatz und grobe Fahrlässigkeit — h.M. ⚠ без Nachweis), а AGB-Kontrolle (§ 309 Nr. 7 BGB) не позволяет исключить ответственность за Vorsatz/grobe Fahrlässigkeit и за Körperschäden. Практически остаточный риск мал, но полный отказ «не действует» — честная формулировка в README.
- **Cyber Resilience Act (VO (EU) 2024/2847):** в силе с 10.12.2024; Meldepflichten für Hersteller (Art. 14) применяются с 11.09.2026; полное применение 11.12.2027; обязанности «open-source software stewards» (Art. 24) — дата применения в источниках расходится (11.09.2026 vs 11.12.2027 ⚠). Непрямое правило: FOSS, предоставляемое вне коммерческой деятельности (Erwägungsgrund 18: нет монетизации, нет коммерческого намерения; хостинг на репозитории сам по себе не «Bereitstellung auf dem Markt»), вне сферы CRA. **Открытый вопрос:** использование инструмента заказчиком в платных аудитах и публикация под брендом seed-factory могут сделать его «Hersteller»/«Steward» — нужна оценка юристом заказчика.
- **Новая Produkthaftungsrichtlinie (EU) 2024/2853** (транспозиция до 09.12.2026 ⚠): ПО — продукт; FOSS вне коммерческой деятельности исключено. Тот же вопрос коммерческого использования.
- **Impressum:** для страницы проекта на seed-factory.com § 5 DDG применяется в любом случае; для чистого GitHub-репозитория обязанность спорна — README с ссылкой на Impressum заказчика снимает вопрос.

### 4.3 Граница пассивного сканирования (StGB, UWG, BGB)

| Действие сканера | Норма | Оценка | Проектное следствие |
|---|---|---|---|
| Загрузка публичных страниц браузером, клик по баннеру, навигация по ссылкам | § 202a StGB требует «besonders gesichert» + «Überwindung der Zugangssicherung» — отсутствует; BGH I ZR 224/12 (30.04.2014, Screen Scraping): автоматический доступ к публичным данным не per se wettbewerbswidrig, если не обходится техническая защита и не нарушается работа сайта | Допустимо | Честный User-Agent со ссылкой на репо; не обходить bot-блоки, CAPTCHA, 403; уважать robots.txt как политику (не правовая обязанность, но «good faith») |
| HEAD/GET к `/.git/HEAD`, `/.env`, `backup.zip` и т.п. (FILE-01) | § 202a: нет Überwindung при открытой отдаче; но *Modern Solution* (AG Jülich 17.01.2024, 3 000 € Geldstrafe; LG Aachen 11/2024; OLG Köln 07/2025 Revision verworfen ⚠ Az.; BVerfG Nichtannahme 09/2025 ⚠ Az.) — Passwort im Binary als «besondere Sicherung»; реформа §§ 202a/b (RefE BMJ 04.11.2024) не принята, нового правительственного проекта на 10/2026 нет, только Koalitionsvertrag-обещание и GI-Whitepaper (08/2026) | Серая зона при чтении *содержимого*; серьёзный риск при использовании найденного (Zugangsdaten) | Маленький документированный список путей; один GET, ограничение размера (напр. 4 KB), без рекурсии (`/.git/` не клонировать); сравнение только первых байт с форматом; тело не сохранять и не выводить; никогда не использовать найденные ключи; opt-in-флаг и явное предупреждение в README; согласовать список с заказчиком |
| TLS-04: handshake со старыми версиями | Не Zugriff auf Daten; несколько TCP-соединений | Допустимо | Лимит попыток, без cipher-перебора; описать в ADR «пассивный режим» |
| Высокая частота запросов | § 303b StGB (Computersabotage) требует erhebliche Störung; BGH Screen Scraping: сайт не должен заметно замедляться | Проблема только при реальной нагрузке | Rate limit по умолчанию, лимит страниц/параллелизма, никаких retry-штормов |
| Разработка и публикация сканера | § 202c StGB (Vorbereiten); BVerfG, Beschluss vom 18.05.2009, 2 BvR 2233/07 u.a. (⚠ Az.): dual-use-Tools страфбар только при объективном назначении для преступления | Compliance-сканер — не § 202c | Документировать назначение; не добавлять «exploit»-функции; не «bypass» баннеров/защит |
| Отчёт с утверждениями о чужом сайте | § 824 BGB (Kreditgefährdung), § 4 Nr. 2 UWG (Herabsetzung), § 186 StGB (üble Nachrede, для natürliche Personen) | Риск при неверных фактах/оценках | Только проверяемые факты с методикой; не публиковать отчёты о чужих сайтах; README: Nutzungshinweis против массовых Abmahnungen (прецедент Google-Fonts-Welle, где использовались Crawler) |
| Хранение данных чужих сайтов в отчёте | DSGVO (если personenbezogen): Impressum-данные (имена) — Art. 6 Abs. 1 lit. f для того, кто заказал скан собственного/клиентского сайта; значения cookies — идентификаторы синтетической сессии сканера, но могут быть связаны с IP сканера у третьих лиц; UrhG § 44a/§ 51 для HTML-фрагментов и скриншотов; GeschGehG § 4 при сохранении секретов из `.env` | Низкий риск при минимизации | Хэшировать/редактировать значения cookies, query-секреты, тела файлов до сериализации; скриншоты — только баннер/область, срок хранения; отчёты — локальные артефакты, не публичные |
| Сканирование без мандата (чужие сайты) | Правового запрета нет (публичный контент), но Interessenabwägung Art. 6 Abs. 1 lit. f для содержащихся в отчёте personenbezogenen Daten + репутационный риск | Допустимо для собственного анализа | README: инструмент предназначен для собственных/мандатных сайтов; для чужих — только непубличное использование |

### 4.4 Cookies-значения как возможные personenbezogene Daten

- EuGH *Breyer* C-582/14 (19.10.2016): динамический IP — personenbezogen при наличии законных средств идентификации; EuGH *IAB Europe* C-604/22 (07.03.2024): TC-String — personenbezogen; *Planet49*: Art. 5(3) ePrivacy не требует Personenbezug. Для § 25 это неважно, для нашего хранения — важно: значения `_ga`, `_fbp`, TC-Strings — идентификаторы, по которым Google/Meta могут связать сессию с IP сканера. Риск для реальных людей нулевой (сессия синтетическая), но правило «не хранить значения» устраняет вопрос и уже зафиксировано в round-1.
- Fingerprint находки — только имя/домен/путь/срок/флаги (как предложено в round-1), без значения.

---

## 5. «Передача данных за пределы ЕС»: что сканер может и чего не может

### 5.1 Технически устанавливаемо

| Сигнал | Как | Ограничения |
|---|---|---|
| IP-адрес(а), на которые резолвился сторонний хост | DNS-ответ из точки наблюдения | DNS-гео-стиринг: из другой страны ответ другой; ответ зависит от резолвера |
| ASN и организация IP | RDAP/WHOIS, ASN-база | Организация сети ≠ Verantwortlicher (Cloudflare/Akamai/AWS обслуживают кого угодно) |
| GeoIP-страна IP | GeoLite2 (MaxMind EULA: бесплатно, требуется аккаунт и лицензионный ключ с 12/2019; ограничения на редистрибуцию; старые копии удалять в 30 дней; коммерческая упаковка — платно) или DB-IP Lite (CC BY 4.0, атрибуция + ссылка «IP Geolocation by DB-IP»); IPinfo Lite — лицензия ⚠ | Anycast/CDN: IP «в EU» может терминировать TLS в EU и проксировать дальше; точность на уровне страны ~95–99 % для IPv4, хуже для IPv6 и мобильных сетей (⚠ зависит от базы) |
| Организация в сертификате TLS (O=) | Handshake | Часто CDN; EV-сертификаты редки |
| Юрлицо сервиса по сигнатуре | Собственная версионированная база сервис → юрлицо (Google LLC/Google Ireland Ltd, Meta Platforms Ireland Ltd и т.д.) | Контрактная сторона для EU-клиентов часто ирландская «дочка»; обработка всё равно может идти в США |
| Наличие организации в **Data Privacy Framework List** | dataprivacyframework.gov (поиск по имени; официальный CSV/API не подтверждён ⚠; есть отдельный реестр исключённых организаций) | Сопоставление по имени нечёткое (дочерние общества, DBA); сертификация имеет объём (HR / non-HR data) и статус (active/inactive); покрытие именно этого сервиса не видно |

### 5.2 Не устанавливаемо

- Место фактической обработки/хранения (Anycast, Edge, Backend-Replikation).
- Договорные механизмы: SCC (Art. 46), Auftragsverarbeitungsvertrag (Art. 28), Transfer Impact Assessment, Art. 49-Ausnahmen.
- Роль получателя (Controller / Processor / Joint Controller) и onward transfers.
- Является ли конкретный запрос «Übermittlung» в смысле Art. 44 (EDPB Guidelines 05/2021 Art. 3/Kapitel V, final 14.02.2023 ⚠: Offenlegung durch den Verantwortlichen an einen Empfänger im Drittland — при прямой загрузке браузером посетителя ответ, как правило, «да», но это уже правовая оценка).
- Политический тезис «EU-Hosting eines US-Anbieters ≠ sicher wegen CLOUD Act» — правовая/политическая оценка, не измерение.

### 5.3 Как не превратить GeoIP в юридический вывод

1. **Атрибут, не проверка.** Не вводить `TRANSFER-01` как самостоятельную находку с severity. Поле `thirdCountrySignal` у находок CONSENT-01/TRACK-01/EMBED-*: `{ ip, asn, asOrg, geoipCountry, geoipDb, geoipDbDate, certOrg, dpfLookup: { queriedName, matchQuality, status, checkedAt } | null }`.
2. **Severity не зависит от страны.** Факт «запрос до клика» — уже находка; страна её не повышает. Иначе сканер кодирует «US = unzulässig», что при действующем DPF неверно, а при его падении — тоже не автоматически верно (SCC).
3. **Формулировка:** «Anfragen an [Host] ([IP], AS[..] „[Org]“). GeoIP-Land laut [DB, Stand]: [US]. Der Server-Standort erlaubt keinen Rückschluss auf den Ort der Datenverarbeitung oder auf das Vorliegen eines Übermittlungsinstruments nach Art. 44 ff. DSGVO.» При DPF-совпадении: «Die Organisation „[Name]“ war am [Datum] in der Data Privacy Framework List geführt (Treffer: [exakt/unscharf]; Umfang: [..]). Ob der konkrete Dienst von dieser Zertifizierung erfasst ist, wurde nicht geprüft.»
4. **Версионировать статус DPF** в базе данных сканера (`legalContext.dpf.status`, дата проверки) и выводить его в отчёт как контекст, не как оценку.

### 5.4 Статус EU-US Data Privacy Framework на 30.10.2026

| Дата | Событие | Статус источника |
|---|---|---|
| 10.07.2023 | Durchführungsbeschluss (EU) 2023/1795 — Angemessenheit für zertifizierte US-Organisationen | подтверждено |
| 03.09.2025 | EuG, T-553/23 *Latombe/Kommission*: Klage abgewiesen (DPRC hinreichend unabhängig; Bulk-Collection-Grenzen zum Zeitpunkt des Beschlusses angemessen) | подтверждено (Pressemitteilung CURIA Nr. 106/25) |
| 31.10.2025 | Rechtsmittel beim EuGH, **C-703/25 P** (ABl. C/2025/6610 vom 22.12.2025; Verfahrenssprache Französisch; 4 Rechtsmittelgründe) | подтверждено; Hearing/Schlussanträge на 10/2026 не найдены — **pending** |
| 29.06.2026 | US Supreme Court, *Trump v. Slaughter* (6–3): For-cause-Schutz für FTC-Commissioner verfassungswidrig, *Humphrey's Executor* overruled; FTC — Enforcement-Säule des DPF | подтверждено (вторичные юридические источники) |
| 31.07.2026 | Brief der EDPB-Vorsitzenden an Kommissar McGrath: Prüfung, ob *Slaughter* den Angemessenheitsbeschluss berührt (кein Aufruf zur sofortigen Aufhebung) | подтверждено (IAPP, Hunton); первоисточник EDPB ⚠ |
| 09–10/2026 | Kommission «prüft»; noyb fordert «orderly exit»; einzelne Mitgliedstaaten prüfen; DPF bleibt in Kraft | по состоянию на сентябрь–октябрь 2026, вторичные источники |

Вывод для продукта: DPF действует, но стоит на двух оспариваемых опорах (апелляция + FTC-независимость). Любое «hard-coding» юридического статуса США в коде устареет. Статус должен жить в версионируемом файле данных с датой и источником, а отчёт — лишь воспроизводить его как контекст.

### 5.5 Смежные подвижки, влияющие на карту

- **ePrivacy-Verordnung** (COM(2017) 10): отзыв объявлен в Arbeitsprogramm 11.02.2025, одобрен Комиссией 16.07.2025, опубликован в ABl. 06.10.2025 (C/2025/5423). Действует ePrivacy-RL 2002/58 + § 25 TDDDG.
- **Digital Omnibus** (Vorschlag 19.11.2025): Art. 88a/88b DSGVO (Endgerätezugriff в DSGVO, Browser-Signale, 6-Monats-Sperre для повторного запроса). Rat (Coreper-Mandat 21.10.2026): Art. 88a/88b gestrichen, Cookie-Regeln bleiben in Art. 5(3) ePrivacy-RL mit ~6 einwilligungsfreien Zwecken (в т.ч. aggregierte Reichweitenmessung, Sicherheit), 4-Monats-Frist; Parlament — позиции нет (⚠ детали по вторичным источникам; Trilog не начат). Если примут: first-party-аналитика без cookies-профилей может стать einwilligungsfrei → классификатор CONSENT-02/TRACK-01 должен уметь «legal profile by date».
- **EinwV** (01.04.2025): anerkannte Einwilligungsverwaltungsdienste; по сообщениям, первый признан 17.10.2025 (⚠). Сканер должен уметь распознать, что сайт запрашивает PIMS-сигнал, и не считать его «отсутствием баннера».
- **NIS2UmsuCG** (06.12.2025, BSIG-neu): для besonders wichtige/wichtige Einrichtungen обязанности по Risikomanagement (§ 30) — усиливает правовую привязку security-проверок, но только для in-scope организаций, которые сканер не идентифицирует.

---

## 6. Сводные рекомендации для ТЗ/ADR (из правовой карты)

1. ADR «Модель доказательств» (round-1 № 1) дополнить тремя слоями и запретом генерации per-site правовых текстов (RDG).
2. `legalNote` хранить в `data/legal/<checkId>.de.md` с полями `norms[]`, `positions[]`, `status: settled|contested|single|technical`, `reviewedBy`, `reviewedAt` — заказчик вычитывает, PR-ревью фиксирует.
3. `data/legal/context.json`: статус DPF, Digital Omnibus, версии DSK/EDPB-документов с датами — выводится в отчёт как «Rechtlicher Kontext (Stand …)».
4. Для «тех. стандарт»-проверок (HDR, MAIL, DNS, SEC, TLS-03/04, HDR-02, PERF) дефолтный максимум — `warning`, для DNS-01/SEC-01/PERF-01 — `info`; `critical` только у `--fail-on`-релевантных P0 с устоявшейся базой и у FILE-01 при подтверждённом формате.
5. FILE-01 — opt-in, список путей и лимиты в ADR «Пассивный режим»; TLS-04 — лимит соединений там же.
6. Поле `thirdCountrySignal` как атрибут; никакой отдельной «Drittland»-проверки в MVP.
7. README: назначение (собственные/мандатные сайты), запрет на «bypass»-использование, Nutzungshinweis против массовых Abmahnungen, лицензия и честное объяснение пределов Haftungsausschluss.

---

## Источники

### Проверено в этой сессии (первоисточник или несколько независимых вторичных)

| URL | Что подтверждает |
|---|---|
| https://www.gesetze-im-internet.de/ttdsg/__25.html | Текст § 25 TDDDG; официальное название TDDDG; URL-slug `/ttdsg/` |
| https://www.gesetze-im-internet.de/ttdsg/__19.html | § 19 Abs. 4 TDDDG: «als sicher anerkanntes Verschlüsselungsverfahren», Stand der Technik |
| https://www.datenschutzkonferenz-online.de/media/oh/OH_Digitale_Dienste.pdf | DSK OH Digitale Dienste, Version 1.2, Stand November 2024: Rn. 8, 24, 73–74, 78–79, 87–90, 101, 123–127, 134–137; Fn. 58 (DPF-Anwendungshinweise); ссылка на DSK-Beschluss Pur-Abo 22.03.2023 |
| https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf | EDPB Cookie Banner TF Report, adopted 17.01.2023: Type A–K, paras 7–8, 14, 18, 24, 29, 34 |
| https://edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf | EDPB Guidelines 2/2023 v2.0, adopted 07.10.2024 (v1.0 14.11.2023) |
| https://www.verbraucherzentrale.nrw/sites/default/files/2024-01/olg-koln-vom-19.01.2024_6-u-80_23_geschwarzt.pdf ; https://www.wettbewerbszentrale.de/olg-koeln-zu-cookies-ablehnen-und-einwilligen-muessen-gleichrangig-sein/ | OLG Köln 19.01.2024, 6 U 80/23 (wetteronline.de): Inhalt, Revision nicht zugelassen |
| https://www.lfd.niedersachsen.de/download/217974 ; https://heise.de/-10390520 | VG Hannover 19.03.2025, 10 A 5385/22 (NOZ): Klage abgewiesen; LfD-Pressemitteilung 20.05.2025 |
| https://www.beck-aktuell.de/heute-im-recht/rechtsprechung/lg-rostock-tracking-cookies-mit-voreingestellter-einwilligung-nicht-erlaubt-2020-11-26 | LG Rostock 15.09.2020, 3 O 762/19; Berufung eingelegt |
| https://www.scl.org/12482-french-data-protection-regulator-fines-google-and-facebook-for-making-it-harder-to-refuse-cookies-than-to-accept-them/ | CNIL 31.12.2021: Google 150 M€, Facebook 60 M€ |
| https://cnil.fr/en/node/86038 ; https://www.edpb.europa.eu/news/national-news/2023/french-sa-fines-cityscoot-125-000eu_da | CNIL/Cityscoot 16.03.2023, 125 000 €, reCAPTCHA ohne Einwilligung |
| https://www.lto.de/recht/juristen/b/bgh-urteil-izr11320-vertragsgenerator-smartlaw-keine-unzulaessige-rechtsdienstleistung-rak-hamburg-rdg-legal-tech ; https://www.rak-hamburg.de/uploads/file/282565_Presseerkl%C3%A4rung%20vom%2009.09.2021.pdf | BGH 09.09.2021, I ZR 113/20 Smartlaw |
| https://www.heise.de/en/news/Federal-Constitutional-Court-rejects-appeal-in-Modern-Solution-case-10663687.html ; https://borncity.com/blog/2024/11/11/modern-solution/ ; https://borncity.com/blog/2024/01/18/amtsgericht-jlich-verurteilt-entdecker-der-modern-solutions-schwachstelle-zu-geldstrafe-jan-2024/ | Modern Solution: AG Jülich 01/2024 (3 000 €), LG Aachen 11/2024, OLG Köln 07/2025, BVerfG 09/2025 |
| https://www.bmjv.de/SharedDocs/Downloads/DE/Gesetzgebung/RefE/RefE_ComputerStrafR.pdf ; https://netzpolitik.org/2026/ethisches-hacken-raus-aus-der-grauzone/ ; https://load-ev.de/2026/09/06/gi-whitepaper-computerstrafrecht/ | RefE Computerstrafrecht 11/2024; Stillstand 2026; GI-Whitepaper |
| https://www.lto.de/recht/hintergruende/h/bgh-urteil-izr22412-screen-scraping-flugdaten-automatisiert-auslesen-ryanair-reiseportal | BGH 30.04.2014, I ZR 224/12 Screen Scraping |
| https://www.beck-aktuell.de/heute-im-recht/rechtsprechung/bgh-izr22219-medikamente-online-bestellen-gesundheitsdaten-dsgvo-einwilligung-2025-03-27 ; https://rewis.io/urteile/urteil/hhr-27-03-2025-i-zr-22319/ | BGH 27.03.2025, I ZR 222/19 und 223/19 (nach EuGH C-21/23) |
| https://www.ihk.de/bergische/recht-und-steuern/wettbewerbsrecht/google-fonts-5646176 ; https://ohn.haendlerbund.de/recht/urteile-entscheidungen/138187-urteil-zu-google-fonts-abmahnungen-ohrfeige-fuer-massenabmahner ; https://www.beck-aktuell.de/heute-im-recht/rechtsgeschehen/google-fonts-razzia-bei-berliner-abmahnanwalt-2022-12-22 | LG München I 20.01.2022, 3 O 17493/20; LG München I 30.03.2023, 4 O 13063/22; GStA Berlin 12/2022 |
| https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250106en.pdf | EuG T-553/23, Urteil 03.09.2025 |
| https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=OJ%3AC_202506610 ; https://digitalpolicyalert.org/event/35459-latombe-filed-appeal-against-general-court-dismissal-of-challenge-to-european-unionunited-states-data-protection-framework-adequacy-decision-in-latombe-v-commission | Rechtsmittel C-703/25 P, eingelegt 31.10.2025 |
| https://www.faegredrinker.com/en/insights/publications/2026/6/supreme-court-decides-trump-v-slaughter ; https://www.bakerbotts.com/thought-leadership/publications/2026/july/supreme-court-ends-for-cause-removal-protection-for-the-ftc-in-trump-v-slaughter | Trump v. Slaughter, 29.06.2026 |
| https://iapp.org/news/a/edpb-requests-review-of-eu-us-data-privacy-framework-following-trump-v-slaughter ; https://www.hunton.com/privacy-and-cybersecurity-law-blog/edpb-calls-for-review-of-eu-u-s-data-privacy-framework-after-u-s-supreme-court-decision-on-ftc-independence | EDPB-Brief 31.07.2026; DPF bleibt in Kraft |
| https://ppc.land/eu-council-agrees-4-month-cookie-re-ask-wait-for-digital-omnibus-talks/ ; https://www.nicfab.eu/en/posts/digital-omnibus-council/ ; https://ppc.land/digital-omnibus/ | Digital Omnibus: Vorschlag 19.11.2025; Rat-Mandat 21.10.2026; 88a/88b gestrichen |
| https://data.consilium.europa.eu/doc/document/ST-13873-2025-INIT/en/pdf ; https://eur-lex.europa.eu/procedure/DE/2017_3 | Rücknahme ePrivacy-VO: 16.07.2025 / ABl. 06.10.2025, C/2025/5423 |
| https://cms.law/de/deu/legal-updates/Das-Ende-der-Cookie-Banner-Dienste-zur-Einwilligungsverwaltung ; https://www.it-recht-kanzlei.de/cookies-einwilligungsverwaltung-verordnung.html | EinwV in Kraft 01.04.2025 |
| https://www.usd.de/nis2umsucg-offiziell-in-kraft/ ; https://www.taylorwessing.com/de/insights-and-events/insights/2025/11/germanys-implementation-of-nis2 | NIS2UmsuCG 06.12.2025 |
| https://www.hoganlovells.com/en/publications/eu-cyber-resilience-act-preparing-for-vulnerability-and-incident-reporting ; https://www.enisa.europa.eu/sites/default/files/2026-07/ENISA_CRA_SRP_Factsheet_v1.0_0.pdf ; https://digital-strategy.ec.europa.eu/en/policies/cra-open-source | CRA-Daten (11.09.2026 / 11.12.2027), FOSS-Ausnahme |
| https://www.maxmind.com/en/geolite2/eula ; https://scancode-licensedb.aboutcode.org/maxmind-geolite2-eula-2019.html ; https://db-ip.com/db/lite.php | GeoLite2 EULA (Account, Redistribution, 30-Tage-Löschung); DB-IP Lite CC BY 4.0 |
| https://edps.europa.eu/edps-inspection-software_en ; https://interoperable-europe.ec.europa.eu/collection/free-and-open-source-software/solution/website-evidence-collector | EDPS Website Evidence Collector, EUPL-1.2 |
| https://bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/TechGuidelines/TG02102/BSI-TR-02102-2.html | BSI TR-02102-2, Version 2024-1 |
| https://www.edpb.europa.eu/our-work-tools/our-documents/topic/consent_nb | EDPB Opinion 08/2024 (17.04.2024) |

### Из общих знаний, в этой сессии не перепроверено (⚠ сверить Az./даты перед финализацией)

EuGH *Planet49* C-673/17 (01.10.2019); EuGH *Fashion ID* C-40/17 (29.07.2019); BGH *Cookie-Einwilligung II* I ZR 7/16 (28.05.2020); EuGH *Breyer* C-582/14 (19.10.2016); EuGH *IAB Europe* C-604/22 (07.03.2024); EuGH *Österreichische Post* C-154/21 (12.01.2023); EuGH *Meta/Bundeskartellamt* C-252/21 (04.07.2023); EuGH *Schrems II* C-311/18 (16.07.2020); EuGH *Lindenapotheke* C-21/23 (04.10.2024); Durchführungsbeschluss (EU) 2023/1795 (10.07.2023); BGH I ZR 228/03 (20.07.2006, Impressum «zwei Klicks»); BVerfG 2 BvR 2233/07 u.a. (18.05.2009, § 202c); BGH VI ZR 10/24 (18.11.2024, Kontrollverlust); § 13 Abs. 4 UWG (Gesetz zur Stärkung des fairen Wettbewerbs, 12/2020); BFSG in Kraft 28.06.2025; DDG in Kraft 14.05.2024; MStV in Kraft 07.11.2020; WP29 Transparency Guidelines WP260 rev.01 (11.04.2018); EDPB Guidelines 05/2021 (final 14.02.2023); EDPB Guidelines 05/2020 v1.1; EDPB Guidelines 3/2022; WP29 Opinion 04/2012 (WP 194); RFC 8996, 9116, 8659; Produkthaftungsrichtlinie (EU) 2024/2853 (Transposition 09.12.2026); österreichische DSB-Entscheidung zu Google Analytics (12/2021–01/2022) und CNIL-Mahnung (02/2022); LfDI BW Bußgeld Knuddels (2018); Google Consent Mode v2-Anforderung (03/2024); §§ 521, 599, 309 Nr. 7 BGB-Anwendung auf FOSS (h.M.).

---

## Открытые вопросы

1. **crmCode:** для P2 не задан (round-1 предлагает `null`); EMBED-03 (Video) помечен `T1_MAPS_BEFORE_CONSENT`, CONSENT-06 — `T1_TRACKER_BEFORE_CONSENT`: ошибки каталога или намеренная агрегация? Нужен ответ заказчика до фиксации схемы.
2. **Rechtskraft OLG Köln 6 U 80/23** и исход Berufung по LG Rostock 3 O 762/19 — не найдены; влияет на метку «устоявшаяся» у CONSENT-04.
3. **C-703/25 P:** дата слушания/Schlussanträge неизвестна; **ответ Комиссии на письмо EDPB от 31.07.2026** — не найден. Кто и как часто обновляет `legalContext.dpf`?
4. **Digital Omnibus:** исход триалога определит, нужен ли «legal profile by date» для CONSENT-02/TRACK-01 (einwilligungsfreie Reichweitenmessung).
5. **CRA/PLD-статус проекта:** делает ли коммерческое использование заказчиком (аудиты, страница на seed-factory.com) его «Hersteller»/«Steward»? Дата применения Art. 24 для stewards расходится в источниках.
6. **RDG-позиция заказчика** при продаже аудитов с правовыми выводами (§ 5 RDG) — вне инструмента, но определяет, какие тексты он добавит в отчёт.
7. **FILE-01:** согласовать список путей, лимиты, opt-in и формулировку предупреждения в README; решить, нужен ли вообще в MVP с учётом *Modern Solution* и нулевой частоты в 80 аудитах.
8. **TLS-04:** активный handshake-probe vs. «только пассивные проверки» в ТЗ — зафиксировать в ADR как допустимое исключение с лимитом.
9. **Pur-Abo/«Pay or Okay»-баннеры:** как классифицировать первый уровень без кнопки «Ablehnen», но с «Abo»-альтернативой — `info` + ручная проверка?
10. **PIMS/EinwV:** распознавать ли запрос PIMS-сигнала (чтобы не считать отсутствием баннера); какой признанный сервис существует на практике (⚠ «Consenter», 17.10.2025).
11. **§ 18 MStV:** нужна ли эвристика «journalistisch-redaktionell» или оставить как общий `info`-Hinweis в LEGAL-01?
12. **GeoIP-база:** GeoLite2 (EULA, аккаунт, нельзя паковать в образ без условий) vs DB-IP Lite (CC BY 4.0, атрибуция) — выбор влияет на Docker-образ и README.
13. **DPF List:** есть ли официальный экспорт/API; иначе — ручная версионированная выгрузка в репо с датой.
14. **Хранение скриншотов баннеров** (UrhG, personenbezogene Daten в UI) — хранить ли вообще, и с каким сроком.
15. **Политика использования** против массовых Abmahnungen (прецедент Google-Fonts-Welle): лицензия Apache-2.0 запретить не может — только README/Code of Conduct и неудобный для Abmahnung формат (нет правовых выводов).
16. **Немецкие шаблоны** из раздела 2 и дисклеймер 3.3 — на вычитку заказчику к этапу 3 (ТЗ).
