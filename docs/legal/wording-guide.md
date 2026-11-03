# Formulierungsleitfaden: тексты находок, `legalNote` и дисклеймер


**Зачем этот документ и кому он нужен.** `dsgvo-check` выдаёт технические наблюдения о чужих сайтах, и каждая строка отчёта — потенциальное утверждение факта в смысле § 824 BGB. Этот документ фиксирует, как такие строки формулируются: какие слова запрещены и чем заменяются, как устроен шаблон находки, что означают статусы правового якоря и как выглядят черновики всех немецких текстов, которые DSGVO-эксперт заказчика вычитывает к этапу 3 ([ТЗ](../../specs/dsgvo-check_TZ.md), раздел «От нас»). Разработчикам он даёт готовые правила для L0-lint стоп-слов и теста полноты текстов; контракты результата и правил проверки описаны в [архитектуре](../02-architecture.md) и [спецификации проверок](../03-checks.md).

Все немецкие тексты ниже — **черновики** (`draft: true`, штамп «Textentwurf — Prüfung durch Auftraggeber ausstehend» в отчёте). Релиз 1.0 с неутверждённым `de` заблокирован; `en` выходит только вычитанным, иначе `--lang en` в 1.0 недоступен.

---

## 1. Принцип: факт, а не правовая оценка

### 1.1 Что сканер видит и чего не видит

Сканер наблюдает запрос, cookie, DOM-элемент, заголовок, DNS-запись, TLS-handshake и текст документа. Он не видит Rechtsgrundlage, Auftragsverarbeitungsvertrag, роль получателя (Verantwortlicher / Auftragsverarbeiter), Übermittlungsinstrument, место обработки, «unbedingt erforderlich» в смысле § 25 Abs. 2 Nr. 2 TDDDG и договорные отношения оператора с вендором. Поэтому каждая находка состоит из трёх слоёв, и только первый из них говорит о конкретном сайте:

| Слой | Поле отчёта | О чём говорит | Пример |
|---|---|---|---|
| Beobachtung | `findings[].messageId` + `params`, `evidence[]` | Измеренный факт: что, где, когда, в какой фазе, в каком состоянии (`delivery / result / provenance`, [архитектура](../02-architecture.md) §11.5) | «Vor einer Interaktion mit dem Einwilligungsbanner wurde eine Anfrage an `www.google-analytics.com` beobachtet (Phase A, Startseite)» |
| Klassifikation | `classification {source, datasetVersion}`, `confidence`, `provider`, `parent`, `dpfEntity` | Сопоставление с версионированной базой; всегда с происхождением и уверенностью | «Dienst laut Dienstekatalog v2026.10.1: Google Analytics 4, Kategorie Analyse, Konfidenz hoch» |
| Rechtlicher Kontext | `legalNoteId` → статический `legalNote` по `checkId` | Общий текст, одинаковый для всех сайтов: нормы, позиции надзора, статус якоря (раздел 4). Без глаголов оценки, без «Sie» | «§ 25 Abs. 1 TDDDG verlangt für das Speichern von oder den Zugriff auf Informationen in der Endeinrichtung eine Einwilligung …» |

Правило: слой «Beobachtung» никогда не содержит слов из раздела 2; слой «Rechtlicher Kontext» никогда не ссылается на проверяемый сайт. Индивидуальная правовая оценка («Ihre Website verstößt gegen § 25 TDDDG») не пишется ни в одном слое и не генерируется под сайт (в том числе LLM) — это non-feature продукта ([ТЗ](../../specs/dsgvo-check_TZ.md), раздел «От нас»).

### 1.2 Три правовые опоры принципа

| Опора | Что говорит | Следствие для текстов |
|---|---|---|
| **§ 2 Abs. 1, § 3 RDG; BGH *Smartlaw*, I ZR 113/20 (09.09.2021)** | Rechtsdienstleistung — «jede Tätigkeit in konkreten fremden Angelegenheiten, sobald sie eine rechtliche Prüfung des Einzelfalls erfordert». BGH признал digitaler Vertragsdokumentengenerator **не** Rechtsdienstleistung: провайдер не действует в конкретном чужом деле, продукт сопоставим с Formularhandbuch | Статический `legalNote` по `checkId` — generisches Hilfsmittel той же природы. Граница пересекается, если текст делает вывод о конкретном сайте или генерируется индивидуально. RDG — не основание самого запрета, основание — ТЗ и § 824 BGB; RDG касается платных аудитов заказчика (§ 5 RDG Nebenleistung — вопрос к юристу заказчика) |
| **§ 824 BGB, § 4 Nr. 2 UWG, § 186 StGB** | Unwahre Tatsachenbehauptung о чужом предприятии (Kreditgefährdung, Herabsetzung); для Einzelunternehmer — üble Nachrede | Защита — проверяемость: URL, UTC, фаза, Messumgebung, версия базы, `confidence`, «Momentaufnahme zum Prüfzeitpunkt». Самая вероятная «unwahre Tatsache» — утверждение о получателе данных: поэтому модель `provider / parent / dpfEntity` и запрет слов «Empfänger», «Übermittlung» |
| **ТЗ «Юридические выводы в отчёте — нельзя»** | «Формулировка „nicht gefunden in der Datenschutzerklärung“, а не „verstößt gegen DSGVO“»; нераспознанный баннер → `info` «Banner nicht erkannt» | Статусы проверки `completed / partial / inconclusive / not_applicable / skipped / error` без `pass/fail`; уровни `critical / warning / info` — приоритет по ruleset, не констатация нарушения (формулировку легенды уровней утверждает заказчик) |

### 1.3 «Отсутствие находки ≠ соответствие»

Отчёт никогда не содержит «bestanden», «konform», «✅», «Score», «grün», «sicher». Допустимые формулировки для отсутствия наблюдения:

| Ситуация | Статус проверки | Текст (de) | Текст (en) |
|---|---|---|---|
| Проверка выполнена, наблюдений нет | `completed` | «Keine Beobachtung auf den geprüften Seiten» | "No observation on the pages checked" |
| Выполнена частично | `partial` | «Auf {evaluated} von {planned} geplanten Seiten ausgewertet» | "Evaluated on {evaluated} of {planned} planned pages" |
| Данных недостаточно | `inconclusive` | «Nicht auswertbar: {reason}» | "Not assessable: {reason}" |
| Неприменима | `not_applicable` | «Nicht anwendbar: {reason}» | "Not applicable: {reason}" |
| Пропущена | `skipped` | «Nicht geprüft: {reason}» | "Not checked: {reason}" |
| Сбой | `error` | «Prüfung nicht abgeschlossen: {reason}» | "Check did not complete: {reason}" |

`{reason}` — текст ключа `reason.<id>` из 5.20; у этих статусов находки нет. Покрытие выводится как три числа «geplant / beobachtet / auswertbar»; «первый визит» утверждается только для стартовой страницы, остальные — «Folgeseite in derselben Sitzung».

---

## 2. Запрещённые слова и конструкции (de и en)

Таблица — источник для L0-lint. Lint прогоняет все строки `test/data/texts/{de,en}.yaml` и `test/data/legal/**` («ни одной пользовательской строки вне `test/data/`»), а также рендер HTML, консоли, JUnit и Job Summary на фикстурах. Режимы:

- `block` — любое вхождение (регистронезависимо, по границам слов) роняет L0;
- `label` — слово запрещено как самостоятельная метка/заголовок, разрешено только внутри перечисленных составных слов (колонка «Замена»);
- `quote` — разрешено только внутри поля `quote` с заполненным `source` (цитата нормы, решения или Datenschutzerklärung сайта).

Плейсхолдеры `{…}` и синтаксис ICU в шаблоне не проверяются (иначе `{note}` ловится правилом № 11 `Note`); подставленные значения проверяет рендер на фикстурах.

| # | Запрещено (de) | Запрещено (en) | Режим | Почему | Замена (de) | Замена (en) |
|---|---|---|---|---|---|---|
| 1 | `verstößt`, `Verstoß`, `verstoßen`, `rechtswidrig`, `illegal`, `unzulässig`, `nicht DSGVO-konform`, `DSGVO-Verstoß`, `Rechtsverletzung` | `violat(e\|es\|ed\|ion\|ions)`, `breach`, `unlawful`, `illegal`, `non-compliant`, `infringement` | `block` | Индивидуальная правовая оценка (§ 824 BGB; RDG-линия Smartlaw) | «wurde beobachtet», «wurde nicht gefunden», ссылка на `legalNote` | "was observed", "was not found", see legal context |
| 2 | `ohne Einwilligung`, `ohne Rechtsgrundlage`, `Einwilligung liegt (nicht) vor`, `einwilligungslos` | `without consent`, `without (a) legal basis`, `no consent (was) given` | `block` | Сканер не видит Einwilligung (PIMS, Vertrag, lit. f) и Rechtsgrundlage | «vor einer Interaktion mit dem Einwilligungsbanner», «nach Betätigung von „{button}“», «kein Banner erkannt»; CMP-Status `granted/denied` как измеренное состояние | "before any interaction with the consent banner", "after clicking “{button}”", "no banner recognised"; CMP state `granted/denied` |
| 3 | `Tracker`, `Tracking-Cookie`, `Spionage`, `Überwachung`, `Schnüffel-` | `tracker`, `tracking cookie`, `spyware`, `surveillance` | `label` | Квалификация без доказательства назначения | «Dienst der Kategorie Analyse/Marketing laut Dienstekatalog v{catalogVersion}», «Kennung laut Open Cookie Database v{ocdVersion}»; допустимо: «Tracking-Signatur» только в составе «First-party-Endpunkt mit Tracking-Signatur erkannt» | "service in category analytics/marketing per service catalogue v{catalogVersion}" |
| 4 | `Datenübermittlung in die USA`, `Übermittlung in ein Drittland`, `Empfänger`, `übermittelt an`, `Daten fließen` | `data transfer to the US`, `third-country transfer`, `recipient`, `transmits data to` | `block`; в `legalNote` — `quote` для Gesetzeswortlaut (Art. 13 Abs. 1 lit. e, f) | Роль получателя и Übermittlungsinstrument не наблюдаемы; «Empfänger: Google LLC (US)» — потенциально unwahre Tatsache | «Anbieter laut Dienstekatalog v{catalogVersion}: {provider} ({providerCountry}), Konzernmutter {parent} ({parentCountry}); „{dpfEntity}“ am {dpfCheckedAt} in der DPF-Liste geführt. Ort der Verarbeitung und Übermittlungsinstrument wurden nicht geprüft.» | "provider per service catalogue …; processing location and transfer mechanism were not checked" |
| 5 | `EU-Ausland`, `Nicht-EU`, `EU-Egress`, `außerhalb der EU` | `outside the EU`, `non-EU` | `block` | Релевантная зона — EWR, не EU | «EWR», «außerhalb des EWR», «Egress-Region laut Nutzerangabe: EWR» | "EEA", "outside the EEA" |
| 6 | `unbedingt erforderlich`, `nicht erforderlich`, `notwendig`, `essenziell`, `technisch notwendig` как вывод | `strictly necessary`, `(not) necessary`, `essential` as a verdict | `label` | Оценка по § 25 Abs. 2 Nr. 2 TDDDG; allowlist — не классификация | «Die Erforderlichkeit wurde nicht bewertet», «nicht bewertet (Allowlist v{allowlistVersion})»; допустимо в названии кнопки сайта внутри кавычек („Nur technisch notwendige“) | "necessity was not assessed", "not assessed (allowlist v{allowlistVersion})" |
| 7 | `manipulativ`, `Dark Pattern`, `täuschend`, `irreführend`, `Nudging`, `versteckt` | `manipulative`, `dark pattern`, `deceptive`, `misleading`, `nudging`, `hidden` | `block` | Оценочные термины из Rechtsprechung; вместо них — измеренные факты | «Schaltfläche „{label}“: Fläche {area} px², Kontrast {contrast}:1, Element `{tag}`», «blockiert die Seite: {blocking}» | "button “{label}”: area {area} px², contrast {contrast}:1, element `{tag}`" |
| 8 | `Datenleck`, `Sicherheitslücke`, `angreifbar`, `verwundbar`, `unsicher`, `kritische Schwachstelle`, `ausnutzbar`, `kompromittiert` | `data leak`, `vulnerable`, `exploitable`, `insecure`, `security hole`, `compromised` | `block` | Утверждение о состоянии чужой системы без верификации; `T1_EXPLOITABLE_CVE` остаётся только в JSON | «Versionsangabe „{version}“ gefunden; {database} (Stand {datasetDate}) listet {count} Einträge, darunter {cve}», «Pfad antwortete mit HTTP 200» | "version string “{version}” found; {database} (as of {datasetDate}) lists {count} entries" |
| 9 | `Abmahngefahr`, `abmahnfähig`, `Bußgeld droht`, `Haftungsrisiko`, `Schadensersatz`, `Schaden` | `risk of a fine`, `liability`, `damages`, `legal risk`, `harm` | `block` | Прогноз правовых последствий = Rechtsberatung; EuGH C-300/21: нарушение ≠ ущерб | Убрать. В дисклеймере — только абстрактная ссылка на нормы | Remove |
| 10 | `Impressumspflicht verletzt`, `fehlendes Impressum`, `Datenschutzerklärung fehlt`, `DKIM fehlt`, `DMARC fehlt`, `kein Impressum` | `missing imprint`, `no privacy policy`, `DKIM (is) missing` | `block` | Сканер видел только посещённые страницы, метки и проверенные селекторы | «auf {n} von {m} geprüften Seiten nicht gefunden; über {via} erreichbar: {reachable}», «unter {count} geprüften Selektoren nicht gefunden», «unter `_dmarc.{domain}` nicht gefunden» | "not found on {n} of {m} pages checked", "not found under {count} selectors checked" |
| 11 | `sicher`, `geschützt`, `konform`, `bestanden`, `erfüllt`, `in Ordnung`, `grün`, `Score`, `Note`, `✅` | `compliant`, `passed`, `secure`, `protected`, `safe`, `OK`, `score`, `grade` | `block` (`sicher` — `quote`: § 19 Abs. 4 S. 3 TDDDG «als sicher anerkanntes Verschlüsselungsverfahren») | Negative proof невозможен | «Keine Beobachtung», «nicht geprüft», «nicht auswertbar» | "no observation", "not checked", "not assessable" |
| 12 | `Google speichert`, `Meta verarbeitet`, `leitet weiter an`, `der Betreiber hat`, `der Anbieter will`, `absichtlich` | `Google stores`, `forwards to`, `the operator has`, `intentionally` | `block` | Утверждения о поведении или намерениях третьих лиц; субъект предложения — ресурс, запрос, заголовок | «Eine Anfrage an {host} wurde beobachtet», «Der Header {name} wurde in der Antwort von {url} nicht gefunden» | "a request to {host} was observed" |
| 13 | `Sie müssen`, `Sie sind verpflichtet`, `Pflicht`, `muss` в Hinweis | `you must`, `you are required to`, `is mandatory` | `block` в поле `hint` («Sie müssen», «Sie sind verpflichtet» — везде) | Remediation как Rechtsberatung | Технический Hinweis: «Consent-Gating oder Zwei-Klick-Lösung prüfen», «lokale Einbindung der Schriftdateien prüfen» | "check consent gating or two-click embedding" |
| 14 | `Beweis`, `beweist`, `nachgewiesen`, `Verstöße` как заголовок раздела | `proof`, `proves`, `violations` as a heading | `block` | «Beleg» и «Befund» — термины отчёта | «Beleg», «Befunde / Beobachtungen», «belegt durch» | "evidence", "findings / observations" |
| 15 | `Daten übertragen` (TLS-03), `Daten abgeflossen`; `gesendet` и `Antwort erhalten` вне ключей с таким условием | `data was transmitted`; `sent`, `response received` outside such keys | `block`; `gesendet`/`sent` — только в ключах allowlist, чьё условие требует `delivery: sent`; `Antwort erhalten` — `result: response` | Отправку доказывает только `delivery: sent`, ответ — `result: response`; `attempted`, `blocked-by-browser` и `provenance: service-worker / http-cache / memory-cache` — не новый сетевой обмен ([архитектура](../02-architecture.md) §11.5; CONSENT-01, TLS-03) | «Anfrage gestartet / gesendet / vom Browser blockiert», «Antwort erhalten», «aus Service Worker bzw. Cache bedient», «Mixed Content: {resolution}» | "request started / sent / blocked by the browser", "response received", "served from service worker or cache" |
| 16 | `veraltet`, `Text veraltet`, `falsch` о Datenschutzerklärung | `outdated`, `wrong` about a policy | `block` | Роль оператора и контекст цитаты сканеру не видны | «Formulierung prüfen: Rollenänderung zum 02.04.2026», «Verweis auf „{oldNorm}“ gefunden; abgelöst am {date} durch {newNorm}» | "wording to review: role change effective 02.04.2026" |
| 17 | `Einwilligung erteilt`, `Nutzer hat zugestimmt`, `Zustimmung erfolgt` | `consent (was) given`, `user agreed` | `block` | Вывод о волеизъявлении; наблюдаем только состояние CMP и клик коллектора | «CMP-Status laut {source}: granted (Herkunft: {origin})», «Schaltfläche „{button}“ wurde vom Scanner betätigt» | "CMP state per {source}: granted (origin: {origin})" |
| 18 | Строки `T[0-9]_[A-Z_]+` (`crmCode`) | то же | `block` во всех человекочитаемых форматах | Коды каталога содержат оценку («MISLEADING», «EXPLOITABLE», «BROKEN»); только JSON, описание в схеме «interne Taxonomie des Auftraggebers, keine rechtliche Einordnung» | — | — |
| 19 | `BFSG-konform`, `barrierefrei`, `WCAG-konform` | `BFSG-compliant`, `accessible`, `WCAG-compliant` | `block` | Применимость BFSG и ручные критерии WCAG не определяются | «axe-core v{axeVersion} meldete {count} Regelverletzungen (WCAG 2.1 {level})» | "axe-core v{axeVersion} reported {count} rule violations" |
| 20 | `personenbezogene Daten werden übertragen` как факт | `personal data is transferred` | `block` | Спор об идентифицируемости (C-413/23 P); для EMBED хватает DSK OH Rn. 101 | «IP-Adresse des Besuchers wird beim Laden an {host} offengelegt (technisch bedingt)» | "the visitor's IP address is disclosed to {host} when the resource loads (technically inherent)" |

Allowlist (слова, которые lint пропускает по контексту): `Einwilligungsbanner`, `Einwilligungsverwaltung`, `Einwilligungsverwaltungsdienst`, `Datenschutzerklärung`, `DSGVO`, `TDDDG`, `DDG`, названия кнопок сайта в типографских кавычках „…“, цитаты норм и решений в полях `quote` с `source`, «Ausnutzbarkeit» и «Übermittlungsinstrument» только в обороте «wurde(n) nicht geprüft» (и в дисклеймере), «Phase C übermittelt die IP-Adresse des prüfenden Rechners …» только в Messumgebung и Nutzungshinweise, axe-core-термин «violations» / «Regelverletzungen» только в BFSG-01 рядом с `axe-core v{axeVersion}`. Любое новое исключение — запись в allowlist с `reason` и ревью заказчика.

Lint-ошибка печатает ключ, язык, найденный паттерн и строку таблицы: `de.yaml CONSENT-01.tracking-completed.description: stopword #1 "Verstoß" (rule: block)`.

---

## 3. Разрешённые конструкции и шаблон находки

### 3.1 Словарь разрешённых глаголов и оборотов

| Что описываем | de | en |
|---|---|---|
| Сетевой факт | «wurde beobachtet», «eine Anfrage an {host} wurde gestartet / gesendet / vom Browser blockiert», «Antwort erhalten (HTTP {status})», «aus Service Worker bzw. Cache bedient» | "was observed", "a request to {host} was started / sent / blocked by the browser", "response received", "served from service worker or cache" |
| Отсутствие | «wurde nicht gefunden in …», «wurde auf {n} von {m} geprüften Seiten nicht gefunden» | "was not found in …", "was not found on {n} of {m} pages checked" |
| Ответ сервера | «antwortete mit HTTP {status}», «enthält», «endet auf „{qualifier}“» | "responded with HTTP {status}", "contains", "ends with “{qualifier}”" |
| Хранилище | «wurde gespeichert / vom Browser abgelehnt / nur versucht / mit einer Anfrage gesendet», «Cookie „{name}“ (Domain {domain}, Laufzeit {lifetime}, gesetzt durch {setter})» — без значения | "was stored / rejected by the browser / attempted only" |
| Фаза | «vor einer Interaktion mit dem Einwilligungsbanner» (A), «nach Mausbewegung und Scrollen ohne Klick» (A′), «nach Betätigung von „{button}“» (B/C), «auf dem mobilen Viewport 390×844» (M), «kein Banner erkannt» | "before any interaction with the consent banner", "after mouse movement and scrolling without a click", "after clicking “{button}”", "on the mobile viewport 390×844", "no banner recognised" |
| Классификация | «laut Dienstekatalog v{catalogVersion}», «laut Open Cookie Database v{ocdVersion}», «Konfidenz: hoch / mittel / niedrig», «unbekannter Host» | "per service catalogue v{catalogVersion}", "confidence: high / medium / low", "unknown host" |
| Получатель | «Anbieter laut Dienstekatalog: {provider} ({providerCountry}); Konzernmutter {parent} ({parentCountry}); „{dpfEntity}“ am {dpfCheckedAt} in der DPF-Liste geführt; Ort der Verarbeitung: nicht feststellbar» | "provider per service catalogue …; processing location: not determinable" |
| Граница измерения | «wurde nicht bewertet», «wurde nicht geprüft», «nicht feststellbar», «nicht eindeutig», «Nicht auswertbar: …» | "was not assessed", "was not checked", "not determinable", "not unambiguous" |
| Воспроизводимость | «Momentaufnahme vom {startedAt} UTC», «Messumgebung: {engine} {engineVersion}, Viewport {viewport}, Egress {egressMode}» (полный набор строк — 3.5) | "snapshot taken {startedAt} UTC" |
| Повторяемость | «in Phase B vor dem Klick erneut beobachtet: ja / nein» (`replicated`) | "observed again in phase B before the click: yes / no" |
| Повторный запуск по снимку | «Einschränkung: Lexikon seit dem Scan geändert (`lexicon-changed-since-scan`)» | "limitation: lexicon changed since the scan" |

Субъект предложения — ресурс, запрос, заголовок, запись, кнопка; не «der Betreiber», не «die Website» как действующее лицо, не «Google». Пассив допустим и предпочтителен. Чисел и единиц — максимум: байты, миллисекунды, пиксели, проценты, даты в ISO 8601 для `en` и `TT.MM.JJJJ` для `de`.

### 3.2 Шаблон находки: Beobachtung → Kontext → Hinweis zur manuellen Prüfung

Каждая находка в HTML, консоли и PDF рендерится по одному шаблону. В JSON те же части лежат в `messageId` + `params`, `legalNoteId` и `evidenceIds`.

```text
[Titel]                                   ← ≤ 70 знаков, без глаголов оценки
Beobachtung                               ← что, где, когда, в каком состоянии, с какой уверенностью
  • Seiten:   {pages}  (geplant {planned} / beobachtet {observed} / auswertbar {evaluated})
  • Phase:    {phase}   Zeitpunkt: {sinceMs} ms nach {anchor, select, action {dem Klick} other {der Navigation}}
  • Versand:  {delivery}   Antwort: {result}   Quelle: {provenance}   Wiederholt in B: {replicated}
  • Klassifikation: {category} laut {dataset} v{datasetVersion}, Konfidenz {confidence}
  • Einschränkungen: {limitations}
Belege                                    ← evidence[] по evidenceIds, ≤ 20, «{evidenceTruncated} weitere nicht angezeigt»
Rechtlicher Kontext                       ← legalNote по checkId: нормы, позиции, статус якоря (раздел 4), reviewedAt
Hinweis zur manuellen Prüfung             ← что проверить человеку; технически, без «Sie müssen»
```

Обязательные элементы слоя Beobachtung и их источник в снимке:

| Элемент | Поле | Правило формулировки |
|---|---|---|
| Was | `subject`, `serviceId`, `params.host` | Имя ресурса или сервиса в кавычках или `code`; значения cookies, TC-String, query-значения — никогда |
| Wo | `pages[]`, `coverage` | Всегда «auf {n} von {m} geprüften Seiten»; при одной странице — URL |
| Wann | `phases[]`, `tMs`, `navigationId`, `actionId?`, `scan.startedAt` | Фаза словами из 3.1; `{sinceMs}` = `tMs` запроса минус `tMs` навигации (`navigationId`) или действия (`actionId`) на монотонной шкале; вычисляется при рендере, в снимке не хранится ([архитектура](../02-architecture.md) §11.5) |
| Zustand | `request.delivery`, `request.result`, `request.provenance`; `cookie.state` | Три поля раздельно. `delivery`: «gestartet, Versand nicht bestätigt» (`attempted`) / «vom Browser blockiert» / «gesendet» (`sent`). `result`: «Antwort erhalten (HTTP {status})» / «fehlgeschlagen ({errorText})» / «abgebrochen» / «keine Antwort beobachtet» (`none`). `provenance`: «über das Netzwerk» / «aus Service Worker bzw. Cache bedient». Cookies: `attempted / accepted / rejected / sent`. «gesendet» — только при `delivery: sent`, «Antwort erhalten» — только при `result: response` (№ 15) |
| Herkunft классификации | `classification {source, datasetVersion}` | Имя базы и версия в каждом предложении о категории |
| Уверенность | `confidence` | «Konfidenz hoch / mittel / niedrig»; `medium` → уровень не выше `warning`, `low` → не выше `info` — текст уровня не повторяет |
| Ограничения | `limitations[]`, `diagnostics[]` | Тексты `limitation.<id>` и `reason.<id>` — в 5.20; диагностики `SCAN-*` выводятся отдельным блоком «Einschränkungen der Messung», не внутри находки |

### 3.3 Правила для Hinweis zur manuellen Prüfung

1. Называет **что проверить**, а не **что сделать по закону**: «prüfen, ob …», «abgleichen», «dokumentieren». Допустимые технические рекомендации: «Consent-Gating oder Zwei-Klick-Lösung prüfen», «lokale Einbindung prüfen», «DMARC-Richtlinie und Berichtsadresse prüfen».
2. Перечисляет, чего сканер **не** видел: Rechtsgrundlage, Auftragsverarbeitungsvertrag, Erforderlichkeit, вторая ступень баннера, PIMS-сигнал.
3. Один абзац ≤ 400 знаков, без ссылок на внешние сайты (URL в отчёте — текстом, не ссылками).
4. Для `info`-вариантов с ручной оценкой (`reject-as-link`, `nonblocking-no-reject`, `no-choice-at-first-layer`, `pur-abo`, `category-only`, `ambiguous-match`) Hinweis начинается словами «Manuelle Bewertung erforderlich:».

### 3.4 Заголовки и служебные тексты отчёта

| Место | de | en |
|---|---|---|
| Раздел находок | «Befunde» (подзаголовки по уровню: «Kritisch», «Warnung», «Hinweis») | "Findings" ("Critical", "Warning", "Info") |
| Раздел диагностик | «Einschränkungen der Messung» | "Measurement limitations" |
| Раздел окружения | «Messumgebung» | "Measurement environment" |
| Покрытие | «Abdeckung: geplant / beobachtet / auswertbar» | "Coverage: planned / observed / evaluated" |
| Шапка | «Momentaufnahme vom {startedAt} UTC — Ergebnisse können sich jederzeit ändern» | "Snapshot taken {startedAt} UTC — results may change at any time" |
| Нераспознанный баннер | «Banner nicht erkannt» / «CMP {cmp} erkannt, nicht unterstützt» | "Banner not recognised" / "CMP {cmp} recognised, not supported" |
| Подавление | «Unterdrückt bis {expires}: {reason}» | "Suppressed until {expires}: {reason}" |
| Baseline | «In Baseline enthalten (Stufe unverändert)» / «Stufe gegenüber Baseline gestiegen» | "In baseline (level unchanged)" / "Level increased versus baseline" |
| Черновик | «Textentwurf — Prüfung durch Auftraggeber ausstehend» | "Draft text — pending review by the client" |
| Футер HTML ([архитектура](../02-architecture.md) §13.5) | «Datensätze und Attribution»; строка на элемент `datasets[]`: «{name} (Stand {date}, Lizenz {license}, sha256 {sha256}): {attribution}»; атрибуция всех использованных CC BY-источников, для GHSA: «GitHub Advisory Database, Lizenz CC BY 4.0» | "Datasets and attribution"; GHSA: "GitHub Advisory Database, licensed under CC BY 4.0" |
| Уровни | «Kritisch / Warnung / Hinweis» — с пояснением в легенде: «Stufen folgen dem Regelwerk {rulesetVersion} (Rechtsstand {rechtsstand}) und stellen keine rechtliche Bewertung dar» | "Critical / Warning / Info — levels follow ruleset {rulesetVersion} … and are not a legal assessment" |

### 3.5 Строки раздела «Messumgebung»

Раздел строится из `scan.environment` ([архитектура](../02-architecture.md) §11.2 и §7.6); каждая строка выводится только при своём условии.

| Условие | de | en |
|---|---|---|
| всегда | «Messumgebung: {engine} {engineVersion}, Viewport {viewport}, Sprache de-DE, Zeitzone Europe/Berlin; Egress {egressMode}, Region {egressRegion} laut {egressSource}» | "Measurement environment: {engine} {engineVersion}, viewport {viewport}; egress {egressMode}, region {egressRegion} per {egressSource}" |
| `--proxy` и DNS-коллектор включён | «DNS-Abfragen direkt über Resolver {resolver}, nicht über den Proxy» | "DNS queries sent directly to resolver {resolver}, not via the proxy" |
| `--proxy` | «Zieladressen lokal geprüft; Proxy {proxy}» (`{proxy}` — схема, хост и порт, без учётных данных) | "Destination addresses checked locally; proxy {proxy}" |
| `--proxy` | «CDN-Knoten nach lokaler Namensauflösung gewählt, nicht nach der Egress-Region» | "CDN node selected by local name resolution, not by egress region" |
| фаза C выполнена | «Phase C übermittelt die IP-Adresse des prüfenden Rechners an Drittanbieter» | "Phase C discloses the scanning machine's IP address to third parties" |
| захват pagehide/keepalive недоступен | «Anfragen beim Verlassen der Seite (pagehide, keepalive) wurden nicht erfasst» | "Requests sent on page exit (pagehide, keepalive) were not captured" |

---

## 4. Статусы правового якоря

`legalNote` — один текст на `checkId` (не на вариант), хранится в `test/data/texts/{de,en}.yaml`, раздел `legalNotes`, по `legalNoteId` = `checkId` ([архитектура](../02-architecture.md) §9.4, §10.1, §13.4), имеет поля `status`, `reviewedAt`, `reviewBy`. Статус говорит о **прочности источника**, а не о тяжести находки: уровень задаёт ruleset `de-2026`, и связь статус → уровень в коде отсутствует. Отчёт выводит статус рядом с нормами, чтобы читатель видел, на чём стоит контекст.

| `status` | Значение | Типичные источники | Отображение в HTML (de) | Отображение (en) |
|---|---|---|---|---|
| `authority-consensus` | Единая линия надзорных органов (DSK, EDSA/EDPB, LfDI); судебной проверки может не быть | DSK OH Digitale Dienste v1.2 (11/2024 ⚠ проверить Rn.), EDPB Cookie Banner TF (17.01.2023), EDPB Guidelines 2/2023 v2.0 | «Position der Aufsichtsbehörden (einheitliche Linie)» | "Supervisory authorities' position (consistent line)" |
| `court-first-instance` | Решение первой инстанции (LG, VG, AG) без подтверждения выше | LG München I 3 O 17493/20 (20.01.2022); VG Hannover 10 A 5385/22 (19.03.2025; ⚠ Berufung неизвестна) | «Erstinstanzliche Entscheidung» | "First-instance court decision" |
| `court-appellate` | Решение Berufungs-, Revisions- или европейской инстанции (OLG, BGH, EuGH) | EuGH *Planet49* C-673/17; BGH I ZR 7/16; BGH I ZR 228/03; EuGH *Fashion ID* C-40/17; OLG Köln 6 U 80/23 (⚠ Rechtskraft) | «Obergerichtliche / höchstrichterliche Entscheidung» | "Appellate or supreme court decision" |
| `contested` | Расходятся суды и/или органы, либо вопрос не проверялся | reCAPTCHA как Sicherheitsfunktion; «reject-as-link»; Pur-Abo; cookieless pings; поимённое называние сервисов в DSE | «Rechtslage umstritten» | "Legal position contested" |
| `technical` | Правовой нормы, предписывающей именно эту меру, нет; привязка через Art. 32 DSGVO / § 19 Abs. 4 S. 2 TDDDG «Stand der Technik» и технические стандарты | BSI TR-02102-2 (2026-01), BSI TR-03182, RFC 8996, RFC 9116, RFC 8659, OWASP | «Technischer Standard, keine ausdrückliche Rechtsnorm» | "Technical standard, no explicit legal rule" |

Правила:

1. В `legalNote` каждое решение приводится с Az., датой и инстанцией; непроверенные факты несут пометку ⚠ и в черновике и снимаются только после первоисточника (juris, curia.europa.eu, пресс-релиз суда).
2. У `legalNote` один статус. Если у проверки две линии (CONSENT-04: блокирующий баннер — `court-appellate`, неблокирующий — `contested`), в тексте появляется абзац «Umstritten ist: …», а статус берётся по основному варианту `critical`.
3. `reviewBy` — дата следующей вычитки; CI предупреждает при просрочке. Для `contested` и `court-first-instance` срок — 6 месяцев, для остальных — 12.
4. Статус уровень не ограничивает: lint («T3 не выше `warning`») сверяет ruleset с `crmCode`, а не со статусом якоря. FILE-01 имеет статус `technical` и `critical`-вариант `sensitive-signature`.

Назначение статусов по проверкам (черновик, вычитывает заказчик):

| `checkId` | `status` | Правовой якорь |
|---|---|---|
| CONSENT-01 | `court-appellate` | § 25 Abs. 1 TDDDG; EuGH *Planet49* C-673/17; BGH I ZR 7/16. Абзац «Umstritten»: запрос ресурса без Speicherung/Zugriff; GTM по VG Hannover 10 A 5385/22 ⚠ |
| CONSENT-02 | `court-appellate` | § 25 Abs. 1, Abs. 2 Nr. 2 TDDDG; *Planet49*; BGH I ZR 7/16 |
| CONSENT-03 | `authority-consensus` | § 25 Abs. 1 TDDDG; Art. 6, 13 DSGVO; DSK OH Rn. 73–74 ⚠ |
| CONSENT-04 | `court-appellate` (блокирующий) | Art. 4 Nr. 11, Art. 7 DSGVO; § 25 TDDDG; DSK OH Rn. 124–125, 134–137 ⚠; OLG Köln 6 U 80/23 (19.01.2024, ⚠ Rechtskraft); VG Hannover 10 A 5385/22 ⚠. «Umstritten»: неблокирующий баннер, ссылка вместо кнопки (EDPB TF Type C ⚠), Pur-Abo |
| CONSENT-05 | `authority-consensus` | § 25 Abs. 1 TDDDG; Art. 7 Abs. 3, Art. 4 Nr. 11 DSGVO; EDPB TF Type H (berechtigtes Interesse ≠ Grundlage für § 25). «Umstritten»: cookieless pings |
| CONSENT-06 | `authority-consensus` | § 25 TDDDG; Art. 7 DSGVO. «Umstritten»: advanced mode |
| TRACK-01 | `court-appellate` | § 25 TDDDG; Art. 6 Abs. 1 lit. a; Art. 26 (EuGH *Fashion ID* C-40/17) |
| EMBED-01 | `court-first-instance` | Art. 6 DSGVO; LG München I 3 O 17493/20 (одиночное); DSK OH Rn. 101; «Umstritten»: § 25-событие |
| EMBED-02 | `authority-consensus` | § 25 TDDDG; Art. 6; DSK OH Rn. 74, 101, 123 ⚠ |
| EMBED-03 | `authority-consensus` | § 25 TDDDG; DSK OH Rn. 74, 123 |
| EMBED-04 | `contested` | § 25 Abs. 1 vs Abs. 2 Nr. 2 TDDDG; DSK OH Rn. 74; Rollenänderung Google 02.04.2026 |
| EMBED-05 | `contested` | § 25 TDDDG; Art. 26 (*Fashion ID*) для Social-Plugins, иные виджеты — Einzelfall |
| PRIV-01 | `contested` | Art. 13 Abs. 1 lit. e, f DSGVO; «Kategorien von Empfängern» допустимы |
| PRIV-02 | `contested` | Art. 5 Abs. 1 lit. a, Art. 12, 13 DSGVO; § 5 UWG в текст не выносится |
| LEGAL-01 | `court-appellate` | § 5 DDG; Art. 13 DSGVO; BGH I ZR 228/03 (20.07.2006, два клика); § 18 MStV — только упоминание |
| LEGAL-02 | `contested` | § 5 DDG; § 18 MStV; TDDDG; Art. 13 Abs. 1 lit. c |
| TLS-01, TLS-02 | `authority-consensus` | § 19 Abs. 4 S. 3 TDDDG; Art. 32 Abs. 1 lit. a; «Umstritten»: статичная страница без формы |
| TLS-03, TLS-04 | `technical` | Art. 32; § 19 Abs. 4 TDDDG; BSI TR-02102-2 (2026-01); RFC 8996 |
| HDR-01, HDR-02 | `technical` | Art. 32, 25 DSGVO; § 19 Abs. 4 TDDDG |
| MAIL-01, MAIL-02, MAIL-03 | `technical` | Art. 32 (косвенно); BSI TR-03108-1, TR-03182; RFC 7489, RFC 9989 (май 2026) |
| VULN-01, VULN-02 | `authority-consensus` | Art. 32 Abs. 1 lit. b, d; § 19 Abs. 4 TDDDG; CISA KEV — приоритизация, не норма |
| DNS-01, SEC-01 | `technical` | RFC 8659; RFC 9116; правовой нормы нет |
| ADMIN-01, FILE-01 | `technical` | Art. 32; Art. 5 Abs. 1 lit. c, f (имена); для сканера §§ 202a/202c StGB, § 4 GeschGehG |
| BFSG-01 | `technical` | BFSG + BFSGV, EN 301 549; применимость не определяется |
| PERF-01 | `technical` | Правовой нормы нет; текст «kein Rechtsbezug» |

---

## 5. Черновики текстов по `checkId` и вариантам (DRAFT)

**Формат.** `test/data/texts/de.yaml` и `test/data/texts/en.yaml`, ICU MessageFormat 1, ключ `checkId.variant` = `messageId`. Под ключом — поля `title`, `description` и `hint` (Hinweis zur manuellen Prüfung) по [архитектуре](../02-architecture.md) §11.4 и §13.4; в таблицах им соответствуют колонки «Titel», «Beschreibung» и «Hinweis zur manuellen Prüfung», `en`-таблицы дают `description` одной строкой. `legalNote` лежит в тех же файлах, в разделе `legalNotes`, по `legalNoteId` = `checkId` (§13.4). Плейсхолдеры `{…}` — из `findings[].params`; множественное число — через ICU `{count, plural, one {…} other {…}}`, в черновиках для краткости показана форма `other`; перечисления (`delivery`, `result`, `identifierKind`, `targetKind`, `kind`, `basis`, `transferred`, `detail`) — через `select` с обязательной ветвью `other`. Все записи этого раздела несут `draft: true`.

**Реестр ключей.** Канон вариантов и `messageId` — реестр [спецификации проверок](../03-checks.md) §2.1. Раздел 5 ему следует: у каждого `checkId.variant` реестра здесь ровно один ключ, других ключей находок нет; при переименовании в реестре ключи здесь переименовываются вслед за ним (03-checks §1). Уровень в скобках после ключа — значение ruleset по умолчанию из реестра, до overrides и кэпа confidence; текст его не повторяет. Исходы без находки (`inconclusive`, `error`, `skipped`, `not_applicable`) — не варианты: у них нет уровня, `messageId` и `crmCode`, а их тексты — ключи `reason.<id>` и `limitation.<id>` в 5.20 ([архитектура](../02-architecture.md) §9.1 и §11.3; 03-checks §2.1). Исключение — только два `locked`-варианта CONSENT-04 (`banner-not-recognized`, `cmp-not-supported`): находка `info` при статусе проверки `inconclusive`.

**Расхождения с реестром 03-checks — требуют правки 03-checks.** По именам и уровням вариантов расхождений нет. Три прежних отклонения guide теперь совпадают с реестром и правки 03-checks не требуют: LEGAL-01 — вариант `unresolved`; TLS-02 — два варианта срока, `certificate-expiring` (`warning`) и `certificate-expiry-approaching` (`info`), по двум порогам срока действия; MAIL-02 — вариант `ptr-mechanism` (`info`, [спецификация проверок](../03-checks.md) §3.11). Открытым остаётся одно расхождение по исходу без находки:

| # | Где в 03-checks | Что там | Что в guide | Основание | Нужная правка 03-checks |
|---|---|---|---|---|---|
| 1 | §2.1, строка CONSENT-05; §4, строка `inconclusive` таблицы «Уровень» | Один `reason` `reject-not-confirmed` на три основания: отказ не подтверждён, CMP не поддержан, захват pagehide недоступен | `reason.reject-not-confirmed` (ветки `default-only`, `no-decision`, `not-stored`, `cmp-unknown`) и отдельный `reason.pagehide-capture-unavailable` вместе с limitation того же имени (5.20) | [Спецификация проверок](../03-checks.md) §4, CONSENT-05: отказ подтверждается по состоянию CMP, независимо от сети. При недоступном захвате pagehide отказ подтверждён, и строка «Ablehnung nicht bestätigt» утверждала бы неверный факт (§ 824 BGB, раздел 1.2) | Добавить `pagehide-capture-unavailable` в столбец `reason` строки CONSENT-05 §2.1 и развести строку `inconclusive` в §4 на два `reason` |

Общие плейсхолдеры: `{url}` — страница; `{n}`/`{m}` — «auf n von m geprüften Seiten»; `{phase}` — фаза словами из 3.1; `{host}`; `{service}`; `{catalogVersion}`; `{confidence}`; `{delivery}`, `{result}`, `{provenance}` — словами из 3.2; `{sinceMs}` — вычисленное время от навигации или действия (3.2); `{startedAt}`.

### 5.1 CONSENT-01 — Drittanfragen vor Interaktion mit dem Banner

`legalNote` (`court-appellate`, draft): «§ 25 Abs. 1 TDDDG verlangt für das Speichern von Informationen in der Endeinrichtung und den Zugriff darauf eine Einwilligung auf Grundlage klarer und umfassender Informationen; Ausnahmen regelt § 25 Abs. 2 TDDDG. Der EuGH (C-673/17, *Planet49*, 01.10.2019) und der BGH (I ZR 7/16, 28.05.2020) verlangen eine aktive Einwilligung unabhängig vom Personenbezug. Für die weitere Verarbeitung gilt Art. 6 DSGVO. Umstritten ist, ob der bloße Abruf einer Drittressource ohne Speicherung oder Auslesen ein Vorgang nach § 25 TDDDG ist; das VG Hannover (10 A 5385/22, 19.03.2025; ⚠ Berufung unbekannt, Einzelheit nach Sekundärquellen) hat die Einbindung des Google Tag Managers als einwilligungsbedürftig angesehen.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `CONSENT-01.tracking-completed` (`critical`) | Analyse-/Marketing-Anfrage mit dauerhafter Kennung vor Interaktion | Vor einer Interaktion mit dem Einwilligungsbanner wurde auf {n} von {m} geprüften Seiten eine Anfrage an {host} mit dauerhafter Kennung ({identifierKind, select, stored-match {Abgleich mit gespeichertem Cookie bzw. Speicher} persistent-param {Parameter `{param}` laut Signatur im Dienstekatalog} other {Nutzerkennung im Parameter `{param}`}}) gesendet; Antwort erhalten (HTTP {status}; {phase}, Start {sinceMs} ms nach der Navigation). Dienst laut Dienstekatalog v{catalogVersion}: {service}, Kategorie {category}, Konfidenz {confidence}. Der Wert der Kennung wurde nicht gespeichert. In Phase B vor dem Klick erneut beobachtet: {replicated}. | Prüfen, ob der Dienst erst nach einer Auswahl im Banner geladen wird (Consent-Gating, Tag-Manager-Trigger). Rechtsgrundlage, Auftragsverarbeitungsvertrag und Erforderlichkeit wurden nicht bewertet. |
| `CONSENT-01.library-loaded` (`warning`) | Tag-Manager oder Bibliothek vor Interaktion geladen | Vor einer Interaktion wurde das Skript {scriptUrl} ({service} laut Dienstekatalog v{catalogVersion}) auf {n} von {m} geprüften Seiten geladen. Eine Anfrage mit Kennung an einen Analyse- oder Marketing-Endpunkt wurde in dieser Phase nicht beobachtet. | Prüfen, welche Tags der Container vor einer Auswahl im Banner auslöst; ein geladener Container ist nicht gleichbedeutend mit einem ausgelösten Tag. |
| `CONSENT-01.first-party-proxy` (`warning`, Konfidenz `medium`) | First-party-Endpunkt mit Tracking-Signatur erkannt | Vor einer Interaktion wurde auf {url} eine Anfrage an den eigenen Host {host} beobachtet, deren Pfad und Parameter der Signatur „{signature}“ ({service}) entsprechen. Serverseitige Weiterleitung ist passiv nicht feststellbar. | Konfiguration des serverseitigen Taggings (sGTM, Tag Gateway) und dessen Consent-Steuerung prüfen. |
| `CONSENT-01.cookieless-ping` (`warning`) | Anfrage ohne dauerhafte Kennung vor Interaktion | Vor einer Interaktion wurde auf {url} eine Anfrage an {host} ({service}) ohne dauerhafte Kennung gesendet ({identifierKind, select, per-load {nur ein pro Seitenaufruf erzeugter Zufallswert} other {keine Kennung erkannt}}; Consent-Mode-Parameter: {gcs}). | Konfiguration des Consent Mode (Basic vs. Advanced) prüfen; ob eine solche Anfrage ein Zugriff im Sinne von § 25 TDDDG ist, wurde nicht bewertet. |
| `CONSENT-01.third-party-resource` (`info`) | Drittanbieter-Ressource vor Interaktion geladen | Vor einer Interaktion wurde eine Ressource von {host} geladen (Kategorie laut Dienstekatalog v{catalogVersion}: {category}: CDN, Zahlungsdienst oder Einwilligungsanbieter). | Prüfen, ob die Ressource für den aufgerufenen Dienst benötigt wird; die Erforderlichkeit wurde nicht bewertet. |
| `CONSENT-01.unknown-host` (`info`) | Anfragen an nicht klassifizierte Hosts | Vor einer Interaktion wurden {count} Anfragen an {hostCount} Hosts beobachtet, die im Dienstekatalog v{catalogVersion} nicht enthalten sind: {hosts}. | Zweck und Anbieter der Hosts manuell zuordnen. |
| `CONSENT-01.request-not-completed` (`info`) | Anfrage gestartet, Versand oder Antwort nicht belegt | Eine Anfrage an {host} ({service}) wurde gestartet; Versand: {delivery, select, blocked-by-browser {vom Browser blockiert ({blockReason})} attempted {nicht bestätigt} other {gesendet}}; Antwort: {result, select, failed {fehlgeschlagen ({errorText})} aborted {abgebrochen} other {keine beobachtet}}. Ein beantworteter Austausch ist damit nicht belegt. | Blockierung (CSP, Browser-Einstellung, Consent-Tool) nachvollziehen. |

| Schlüssel | en (eine Zeile) |
|---|---|
| `CONSENT-01.tracking-completed` | A request to {host} ({service}, category {category}) carrying a persistent identifier (matched against a stored cookie or storage entry, or per catalogue signature) was sent and answered before any interaction with the consent banner on {n} of {m} pages checked. |
| `CONSENT-01.library-loaded` | The script {scriptUrl} ({service}) was loaded before any interaction; no identified analytics or marketing hit was observed in this phase. |
| `CONSENT-01.first-party-proxy` | A request to the site's own host {host} matched the signature “{signature}” ({service}) before any interaction; server-side forwarding cannot be determined passively. |
| `CONSENT-01.cookieless-ping` | A request to {host} ({service}) without a persistent identifier (per-load random value or none; Consent Mode parameters {gcs}) was sent before any interaction. |
| `CONSENT-01.third-party-resource` | A resource from {host} (category {category} per service catalogue v{catalogVersion}) was loaded before any interaction. |
| `CONSENT-01.unknown-host` | {count} requests to {hostCount} hosts not listed in service catalogue v{catalogVersion} were observed before any interaction. |
| `CONSENT-01.request-not-completed` | A request to {host} ({service}) was started but not answered (delivery: {delivery}; result: {result}); no answered exchange is evidenced. |

### 5.2 CONSENT-02 — Cookies und Speichereinträge vor Interaktion

`legalNote` (`court-appellate`, draft): «§ 25 Abs. 1 TDDDG erfasst Cookies, Web Storage und vergleichbare Speichertechniken unabhängig vom Personenbezug (EuGH C-673/17; BGH I ZR 7/16). § 25 Abs. 2 Nr. 2 TDDDG nimmt Speicherungen aus, die unbedingt erforderlich sind, damit der Anbieter einen vom Nutzer ausdrücklich gewünschten digitalen Dienst bereitstellen kann. Welche Einträge darunter fallen, ist eine Frage des Einzelfalls; die DSK (OH Digitale Dienste v1.2, Rn. 78–90 ⚠) stellt auf Zweck, Speicherdauer, Inhalt und Zugriffsberechtigte ab.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `CONSENT-02.tracking-identifier-stored` (`critical`) | Bekannte Analyse- oder Marketing-Kennung vor Interaktion gespeichert | Vor einer Interaktion mit dem Einwilligungsbanner wurde auf {url} der Eintrag „{name}“ ({storageKind}, Domain {domain}, Laufzeit {lifetime}, gesetzt durch {setter} von {setterHost}) vom Browser angenommen. Klassifikation laut {dataset} v{datasetVersion}: {category}, Dienst {service}. Der Wert wurde nicht gespeichert. | Prüfen, ob der setzende Dienst vor einer Auswahl im Banner ausgeführt wird. Zweck und Erforderlichkeit des Eintrags wurden nicht bewertet. |
| `CONSENT-02.unknown-third-party-persistent` (`warning`) | Nicht klassifizierter dauerhafter Drittanbieter-Eintrag | Vor einer Interaktion wurde der dauerhafte Eintrag „{name}“ (Domain {domain}, Laufzeit {lifetime}) gespeichert; er ist in Dienstekatalog v{catalogVersion} und Open Cookie Database v{ocdVersion} nicht enthalten. | Zweck des Eintrags beim Anbieter {domain} ermitteln. |
| `CONSENT-02.unknown-first-party-persistent` (`info`) | Nicht klassifizierter dauerhafter First-party-Eintrag | Vor einer Interaktion wurde der dauerhafte First-party-Eintrag „{name}“ (Pfad {path}, Laufzeit {lifetime}, gesetzt durch {setter}) gespeichert; eine Zuordnung in den verwendeten Datenbanken wurde nicht gefunden. | Zweck des Eintrags dokumentieren; Allowlist-Einträge gelten als „nicht bewertet (Allowlist v{allowlistVersion})“. |
| `CONSENT-02.cmp-cookie-with-uid` (`info`) | Einwilligungs-Cookie mit eindeutiger Kennung | Das Cookie „{name}“ des Einwilligungsbanners ({cmp}) enthält eine Kennung mit {length} Zeichen und einer Laufzeit von {lifetime}. Der Wert wurde nicht gespeichert. | Prüfen, ob die Kennung für den Nachweis der Einwilligung benötigt wird (DSK OH Rn. 84 ⚠). |
| `CONSENT-02.storage-rejected-or-attempted` (`info`) | Speicherversuch vom Browser abgelehnt | Ein Speicherversuch für „{name}“ (Domain {domain}) wurde beobachtet und vom Browser abgelehnt ({rejectReason}) oder nicht bestätigt. | Setzende Quelle ({setterHost}) prüfen. |

| Schlüssel | en |
|---|---|
| `CONSENT-02.tracking-identifier-stored` | The entry “{name}” ({storageKind}, domain {domain}, lifetime {lifetime}, set by {setter}) classified as {category} ({service}) was accepted by the browser before any interaction with the consent banner. |
| `CONSENT-02.unknown-third-party-persistent` | The persistent third-party entry “{name}” (domain {domain}) was stored before any interaction and is not listed in the databases used. |
| `CONSENT-02.unknown-first-party-persistent` | The persistent first-party entry “{name}” (path {path}) was stored before any interaction and could not be classified. |
| `CONSENT-02.cmp-cookie-with-uid` | The consent banner cookie “{name}” ({cmp}) contains an identifier of {length} characters with a lifetime of {lifetime}. |
| `CONSENT-02.storage-rejected-or-attempted` | A storage attempt for “{name}” (domain {domain}) was observed and rejected by the browser ({rejectReason}) or not confirmed. |

### 5.3 CONSENT-03 — Kein Einwilligungsbanner erkannt bei einwilligungsbedürftigen Diensten

`legalNote` (`authority-consensus`, draft): «Werden Dienste eingebunden, die Informationen in der Endeinrichtung speichern oder auslesen, setzt § 25 Abs. 1 TDDDG eine Einwilligung voraus; Art. 13 DSGVO verlangt Informationen über die Verarbeitung. Die DSK bewertet Dienste funktionsbezogen (OH Digitale Dienste v1.2, Rn. 73–74 ⚠). Ein nicht erkanntes Banner ist nicht gleichbedeutend mit einem fehlenden Banner; anerkannte Einwilligungsverwaltungsdienste (§ 26 TDDDG, EinwV) werden vom Scanner nicht ausgewertet.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `CONSENT-03.no-banner-strong-tracking` (`critical`, nur bei Egress-Region EWR laut Nutzerangabe) | Kein Banner erkannt; Analyse- oder Marketing-Kennung gespeichert | Auf der Startseite und {n} weiteren geprüften Seiten wurde kein Einwilligungsbanner erkannt (geprüft: Adapter für {cmpCount} CMP, Erkennung durch autoconsent v{autoconsentVersion}, Heuristik; DOM einschließlich Frames und Shadow DOM; Wartezeit bis {hardCapS} s; nach Mausbewegung und Scrollen erneut geprüft). Gleichzeitig wurden Anfragen an {hosts} mit gespeicherter Kennung beobachtet. Egress-Region laut Nutzerangabe: EWR. Geo- und Bot-Signale der CMP: keine. | Prüfen, ob ein Banner nur für bestimmte Regionen, nach Scrollen oder über einen Einwilligungsverwaltungsdienst ausgespielt wird. |
| `CONSENT-03.no-banner-consent-services` (`warning`) | Kein Banner erkannt; einwilligungsbedürftige Dienste geladen | Auf der Startseite und {n} weiteren geprüften Seiten wurde kein Einwilligungsbanner erkannt (Methode wie oben). Beobachtet wurden Dienste der Kategorien {categories} ({services}). Egress-Region: {egressRegion}. | Wie oben; zusätzlich Egress-Region des Scans berücksichtigen (siehe Messumgebung). |

| Schlüssel | en |
|---|---|
| `CONSENT-03.no-banner-strong-tracking` | No consent banner was recognised on the start page and {n} further pages while requests to {hosts} with stored identifiers were observed; egress region declared as EEA. |
| `CONSENT-03.no-banner-consent-services` | No consent banner was recognised on the start page and {n} further pages while services in categories {categories} were loaded. |

### 5.4 CONSENT-04 — Erste Ebene des Einwilligungsbanners

`legalNote` (`court-appellate` für blockierende Banner, draft): «Eine Einwilligung muss nach Art. 4 Nr. 11, Art. 7 DSGVO freiwillig, informiert und unmissverständlich sein. Die DSK (OH Rn. 124–125 ⚠) und das OLG Köln (6 U 80/23) verlangen eine der Zustimmung gleichwertige Ablehnmöglichkeit; Art. 7 Abs. 3 DSGVO betrifft den Widerruf. Nach der DSK (OH Digitale Dienste v1.2, Rn. 124–125, 134–137 ⚠) ist eine Ablehnmöglichkeit auf der ersten Ebene nicht generell erforderlich, sehr häufig aber dann, wenn das Banner die Nutzung der Seite blockiert. Das OLG Köln (6 U 80/23, 19.01.2024 ⚠ Rechtskraft) hat eine erste Ebene mit „Akzeptieren“, „Einstellungen“ und einem „×“, das als Annahme wirkte, als nicht gleichwertig angesehen; das VG Hannover (10 A 5385/22, 19.03.2025, ⚠ Rechtskraft) hat eine entsprechende Anordnung bestätigt. Umstritten ist die Bewertung nicht blockierender Banner, einer Ablehnung als Textlink (EDPB Cookie Banner Taskforce, Type C ⚠) und von Pur-Abo-Modellen (DSK-Beschluss 22.03.2023). Offen ist die Einordnung einer blockierenden ersten Ebene, die weder Annahme noch Ablehnung anbietet (DSK OH Rn. 125 ⚠).»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `CONSENT-04.blocking-no-reject` (`critical`) | Blockierendes Banner: Annahme möglich, keine Ablehn-Schaltfläche | Das Banner ({cmp} {cmpVersion}, Erkennung mit Konfidenz hoch) blockiert die Interaktion mit der Seite ({blockingMethod}; abgedeckter Anteil des Viewports {coveredRatio} %). Auf der ersten Ebene wurden die Schaltflächen {buttons} gefunden; die annehmende Schaltfläche „{acceptLabel}“ war bedienbar, eine bedienbare Schaltfläche mit ablehnender Bezeichnung wurde nicht gefunden. „Einstellungen“, „Später“, „Verbergen“ und „×“ wurden nicht als Ablehnung gewertet. Viewport: {viewport}. | Prüfen, ob eine gleichwertige Ablehnmöglichkeit auf der ersten Ebene vorgesehen ist; die Gleichwertigkeit (Größe, Farbe, Kontrast, Schriftbild) wurde nur gemessen, nicht bewertet. |
| `CONSENT-04.close-means-accept` (`critical`) | Schließen-Element wirkt laut CMP-Konfiguration als Annahme | Laut ausgelesener Konfiguration des Banners ({cmp}, Option `{configKey}`) wird das Element „{closeLabel}“ als Annahme aller Kategorien verarbeitet. Das Element ist auf der ersten Ebene sichtbar ({box}). | Konfiguration der Schließen-Funktion im CMP prüfen. |
| `CONSENT-04.reject-not-actionable` (`warning`) | Ablehn-Schaltfläche auf dem ersten Bildschirm nicht bedienbar | Die Schaltfläche „{rejectLabel}“ wurde gefunden, war beim ersten Bildschirm jedoch nicht bedienbar: {reason} (außerhalb des Viewports, überdeckt, ohne Größe, `inert`). Viewport: {viewport}. | Darstellung der Ablehn-Schaltfläche in Desktop- und Mobil-Layout prüfen. |
| `CONSENT-04.reject-ineffective` (`warning`) | Ablehnung ohne erkennbare Wirkung auf den CMP-Status | Nach Betätigung von „{rejectLabel}“ meldete das CMP ({cmp}) den Status {stateAfter} ({source}); nach dem Neuladen: {stateAfterReload}. Ein bestätigter Ablehnzustand (Herkunft {origin}, Entscheidung im CMP: {responded}) wurde nicht festgestellt. | Zuordnung der Schaltfläche zur CMP-Aktion prüfen. |
| `CONSENT-04.consent-without-action` (`warning`) | CMP meldet Status `granted` ohne Interaktion | Ohne Interaktion des Scanners meldete das CMP ({cmp}) den Status `granted` für {categories} ({source}, Herkunft {origin}). Bot-Signale der CMP: keine. | Standardzustand und Vorbelegung des CMP prüfen. |
| `CONSENT-04.reject-as-link` (`info`) | Ablehnung nur als Textlink | Auf der ersten Ebene wurde die Ablehnmöglichkeit als Textlink „{rejectLabel}“ gefunden (Element `{tag}`, Fläche {area} px², Kontrast {contrast}:1); die Annahme als Schaltfläche „{acceptLabel}“ (Fläche {acceptArea} px²). | Manuelle Bewertung erforderlich: visuelle Gleichwertigkeit der Ablehnmöglichkeit. |
| `CONSENT-04.nonblocking-no-reject` (`info`) | Nicht blockierendes Banner ohne Ablehn-Schaltfläche | Das Banner ({cmp}) blockiert die Interaktion mit der Seite nicht; auf der ersten Ebene wurden die Schaltflächen {buttons} ohne ablehnende Bezeichnung gefunden. | Manuelle Bewertung erforderlich: Gestaltung der ersten Ebene. |
| `CONSENT-04.no-choice-at-first-layer` (`info`) | Blockierendes Banner ohne Annahme- und Ablehnoption auf erster Ebene | Das Banner ({cmp}) blockiert die Interaktion mit der Seite ({blockingMethod}). Auf der ersten Ebene wurden nur die Schaltflächen {buttons} gefunden; eine bedienbare Schaltfläche mit annehmender oder ablehnender Bezeichnung wurde dort nicht gefunden. Viewport: {viewport}. | Manuelle Bewertung erforderlich: Gestaltung der ersten Ebene und Weg zur Auswahl auf weiteren Ebenen. |
| `CONSENT-04.pur-abo` (`info`) | Bezahlalternative auf der ersten Ebene erkannt | Auf der ersten Ebene wurde neben „{acceptLabel}“ eine Bezahlalternative „{payLabel}“ ({price}) erkannt. Weitere Varianten dieser Prüfung werden unverändert ausgewertet. | Manuelle Bewertung erforderlich: Pur-Abo-Modell (DSK-Beschluss 22.03.2023). |
| `CONSENT-04.banner-not-recognized` (`info`, `locked`, Status `inconclusive`, `crmCode: null`) | Banner nicht erkannt | Ein Kandidat für ein Einwilligungsbanner wurde durch {method} erkannt, konnte aber keinem unterstützten CMP mit ausreichender Konfidenz zugeordnet werden. Die Ablehnoption wurde nicht geprüft. Gemessene Merkmale: {buttons}, blockiert: {blocking}. | Manuelle Prüfung anhand der gemessenen Merkmale und, falls vorhanden, des Bildschirmfotos. |
| `CONSENT-04.cmp-not-supported` (`info`, `locked`, Status `inconclusive`, `crmCode: null`) | CMP {cmp} erkannt, nicht unterstützt | Das CMP {cmp} wurde erkannt ({method}), wird in dieser Version jedoch nicht ausgewertet; Version außerhalb des bekannten Bereichs: {versionOutOfRange}. | Manuelle Prüfung der ersten Ebene. |

| Schlüssel | en |
|---|---|
| `CONSENT-04.blocking-no-reject` | The banner ({cmp}) blocks interaction with the page ({blockingMethod}); its first layer ({buttons}) offers the actionable accept button “{acceptLabel}” but no actionable reject button. |
| `CONSENT-04.close-means-accept` | Per the CMP configuration read ({configKey}), the close element “{closeLabel}” is processed as acceptance of all categories. |
| `CONSENT-04.reject-not-actionable` | The reject button “{rejectLabel}” was found but was not actionable on the first screen ({reason}). |
| `CONSENT-04.reject-ineffective` | After clicking “{rejectLabel}” the CMP reported state {stateAfter}; after reload: {stateAfterReload}; no confirmed rejection state (origin {origin}, decision recorded by the CMP: {responded}) was established. |
| `CONSENT-04.consent-without-action` | Without any interaction the CMP reported `granted` for {categories} (source {source}, origin {origin}). |
| `CONSENT-04.reject-as-link` | The reject option is a text link “{rejectLabel}” ({area} px², contrast {contrast}:1) next to the accept button “{acceptLabel}” ({acceptArea} px²); manual assessment required. |
| `CONSENT-04.nonblocking-no-reject` | The non-blocking banner's first layer shows {buttons} without a reject button; manual assessment required. |
| `CONSENT-04.no-choice-at-first-layer` | The blocking banner ({cmp}) shows only {buttons} on its first layer, with neither an actionable accept nor an actionable reject button; manual assessment required. |
| `CONSENT-04.pur-abo` | A paid alternative “{payLabel}” ({price}) was recognised on the first layer; manual assessment required. |
| `CONSENT-04.banner-not-recognized` | Banner not recognised: a banner candidate was detected by {method} but could not be attributed to a supported CMP; the reject option was not checked. |
| `CONSENT-04.cmp-not-supported` | CMP {cmp} recognised but not supported in this version; the first layer was not evaluated. |

Ограничения CONSENT-04 без находки — `limitation.screenshot-skipped` и `limitation.lexicon-changed-since-scan` (5.20).

### 5.5 TRACK-01 — Inventar der Analyse- und Marketingdienste

`legalNote` (`court-appellate`, draft): «Analyse- und Marketingdienste speichern oder lesen in der Regel Informationen in der Endeinrichtung (§ 25 TDDDG) und verarbeiten personenbezogene Daten (Art. 6 Abs. 1 DSGVO). Bei der Einbindung von Drittdiensten kann eine gemeinsame Verantwortlichkeit nach Art. 26 DSGVO bestehen (EuGH C-40/17, *Fashion ID*, 29.07.2019). Dieser Befund ist ein Inventar; die Bewertung des Zeitpunkts erfolgt in den verknüpften Befunden CONSENT-01, -02, -05 und -06.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `TRACK-01.service-inventory` (`info`) | Dienst {service} geladen | Der Dienst {service} (Signatur {signature}, Kategorie {category} laut Dienstekatalog v{catalogVersion}) wurde auf {n} von {m} geprüften Seiten beobachtet. Stufe: {stage} (geladen / initialisiert / Ereignis gesendet). Zeitpunkt relativ zur Banner-Interaktion: {timing}. Verknüpfte Befunde: {related}. Anbieter laut Dienstekatalog: {provider} ({providerCountry}); Konzernmutter {parent} ({parentCountry}); „{dpfEntity}“ am {dpfCheckedAt} in der DPF-Liste geführt: {dpfListed}. Ort der Verarbeitung und Übermittlungsinstrument wurden nicht geprüft. | Inventar mit der Datenschutzerklärung und der Consent-Konfiguration abgleichen. |

| Schlüssel | en |
|---|---|
| `TRACK-01.service-inventory` | The service {service} ({category}) was observed on {n} of {m} pages checked; stage {stage}, timing relative to banner interaction: {timing}; provider per catalogue {provider} ({providerCountry}), processing location not checked. |

### 5.6 EMBED-01 — Schriftdateien von externen Hosts

`legalNote` (`court-first-instance`, draft): «Beim Laden von Schriftdateien von fremden Servern wird dem Anbieter die IP-Adresse des Besuchers offengelegt; nach Auffassung der DSK (OH Digitale Dienste v1.2, Rn. 101 ⚠) bedarf die Einbindung von Drittinhalten wie Schriftarten einer Rechtsgrundlage nach Art. 6 DSGVO. Das LG München I (3 O 17493/20, 20.01.2022) hat in einem Einzelfall einen Unterlassungsanspruch bejaht; das LG München I (4 O 13063/22, 30.03.2023) hat massenhafte außergerichtliche Schreiben zu diesem Thema als missbräuchlich bewertet. Ob das Laden einer Schriftdatei zugleich ein Vorgang nach § 25 TDDDG ist, ist umstritten.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `EMBED-01.fonts-loaded` (`warning`) | Schriftdateien von {host} geladen | Auf {n} von {m} geprüften Seiten wurden {count} Schriftdateien oder Stylesheets von {host} geladen ({phase}; Auslöser: {initiator}). Anbieter laut Dienstekatalog v{catalogVersion}: {provider} ({providerCountry}){eeaNote}. Nach Betätigung von „{rejectLabel}“ erneut geladen: {afterReject}. | Lokale Einbindung der Schriftdateien prüfen; ob eine Rechtsgrundlage dokumentiert ist, wurde nicht bewertet. |
| `EMBED-01.preconnect-only` (`info`) | Nur Vorverbindung zu einem Schrift-Host | Auf {url} wurde `<link rel="{rel}">` zu {host} gefunden; Schriftdateien wurden von diesem Host nicht geladen. | Prüfen, ob die Vorverbindung noch benötigt wird. |

`{eeaNote}` — пометка каталога для провайдера в EWR (например, `fonts.bunny.net`): «; Sitz laut Dienstekatalog im EWR»; иначе пусто.

| Schlüssel | en |
|---|---|
| `EMBED-01.fonts-loaded` | {count} font files or stylesheets were loaded from {host} on {n} of {m} pages checked ({phase}); provider per catalogue {provider} ({providerCountry}). |
| `EMBED-01.preconnect-only` | Only a `<link rel="{rel}">` to {host} was found on {url}; no font files were loaded from this host. |

### 5.7 EMBED-02 — Kartendienst vor Interaktion geladen

`legalNote` (`authority-consensus`, draft): «Kartendienste gehören nach Auffassung der DSK zu den Zusatzdiensten, die beim ersten Aufruf nicht ausdrücklich gewünscht sind (OH Digitale Dienste v1.2, Rn. 74 ⚠); Inhalte fremder Server sollen erst nach einer Einwilligung geladen werden (Rn. 123 ⚠). Setzt der Dienst Cookies oder Speichereinträge, gilt § 25 Abs. 1 TDDDG; die Offenlegung der IP-Adresse bedarf einer Rechtsgrundlage nach Art. 6 DSGVO.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `EMBED-02.maps-loaded` (`warning`) | Kartendienst {service} auf {url} geladen | Auf {url} wurden Ressourcen des Kartendienstes {service} von {host} geladen (Typ: {embedType}: iframe, JavaScript-API, statische Karte oder Kacheln; {phase}). Dabei gespeicherte Einträge werden unter CONSENT-02 ausgewiesen: {relatedStorage}. Anbieter laut Dienstekatalog v{catalogVersion}: {provider} ({providerCountry}). | Zwei-Klick-Lösung oder statisches Vorschaubild vom eigenen Server prüfen. |

| Schlüssel | en |
|---|---|
| `EMBED-02.maps-loaded` | Resources of the map service {service} were loaded from {host} on {url} (type {embedType}, {phase}); related storage entries are listed under CONSENT-02. |

### 5.8 PRIV-01 — Dienst geladen, in der Datenschutzerklärung nicht gefunden

`legalNote` (`contested`, draft): «Art. 13 Abs. 1 lit. e DSGVO verlangt die Angabe der „Empfänger oder Kategorien von Empfängern“ (Gesetzeswortlaut), lit. f Angaben nach Art. 44 ff. DSGVO; im Befundtext werden diese Begriffe nicht verwendet. Ob jeder eingesetzte Dienst namentlich zu nennen ist oder eine Nennung nach Kategorien genügt, ist nicht abschließend geklärt; der EuGH (C-154/21, 12.01.2023) hat für das Auskunftsrecht eine Tendenz zur konkreten Nennung erkennen lassen. Der Befund beschreibt das Ergebnis eines Textabgleichs und bewertet die Vollständigkeit der Datenschutzerklärung nicht.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `PRIV-01.not-named` (`warning`) | {service} in der Datenschutzerklärung nicht gefunden | Der Dienst {service} wurde auf {n} von {m} geprüften Seiten geladen ({phases}). Im unter {policyUrl} ausgewerteten Text ({partCount} Abschnitte, Vollständigkeit laut Manifest: {complete}) wurde keine Nennung von „{service}“, des Anbieters „{provider}“ oder der Domains {domains} gefunden (Alias-Liste laut Dienstekatalog v{catalogVersion}, Stand {startedAt}). Nennungen nach Kategorien wurden gesondert geprüft: {categoryMatch}. | Prüfen, ob der Dienst an anderer Stelle oder unter anderer Bezeichnung genannt wird und ob die Nennung nach Kategorien gewollt ist. |
| `PRIV-01.category-only` (`info`) | {service} nur als Kategorie genannt | Für den geladenen Dienst {service} wurde im Text unter {policyUrl} keine Nennung des Produkts oder Anbieters, aber eine Nennung der Kategorie „{categoryTerm}“ gefunden (Abschnitt {section}). | Manuelle Bewertung erforderlich: Reicht die Nennung nach Kategorien für diesen Dienst aus. |
| `PRIV-01.ambiguous-match` (`info`) | Nennung nur in nicht sichtbarem Text oder mit unklarer Verneinung | Eine Nennung von „{service}“ wurde nur in {partOrigin} (ausgeblendeter Bereich) oder in einem Satz mit nicht eindeutig zuordenbarer Verneinung gefunden: „{quote}“ ({policyUrl}, Abschnitt {section}). | Manuelle Bewertung erforderlich: Kontext der Fundstelle. |

| Schlüssel | en |
|---|---|
| `PRIV-01.not-named` | The service {service} was loaded on {n} of {m} pages checked, but neither the service, its provider “{provider}” nor the domains {domains} were found in the text evaluated at {policyUrl}. |
| `PRIV-01.category-only` | For the loaded service {service} only the category term “{categoryTerm}” was found at {policyUrl}; manual assessment required. |
| `PRIV-01.ambiguous-match` | A mention of “{service}” was found only in text not displayed on the page or in a sentence with an ambiguous negation: “{quote}”; manual assessment required. |

PDF, неполный manifest и язык вне de/en — не находка, а статус `inconclusive` с `reason.pdf-not-evaluated`, `reason.document-incomplete` или `reason.language-unsupported` (5.20). Если баннер не удалось закрыть отказом, а manifest полон, PRIV-01 остаётся `completed` или `partial` с `limitation.banner-open` (5.20), а не `inconclusive`.

### 5.9 PRIV-02 — Aussage der Datenschutzerklärung und gegenläufige Beobachtung

`legalNote` (`contested`, draft): «Art. 5 Abs. 1 lit. a DSGVO verlangt eine Verarbeitung nach Treu und Glauben und in transparenter Weise; Art. 12 und 13 DSGVO regeln die Informationspflichten. Ob eine unzutreffende Aussage in der Datenschutzerklärung zugleich eine Irreführung nach § 5 UWG ist, ist umstritten und wird hier nicht bewertet. Der Befund stellt eine Aussage des Dokuments und eine technische Beobachtung nebeneinander.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `PRIV-02.contradiction-replicated` (`critical`) | Aussage „{claimShort}“ und gegenläufige Beobachtung in derselben Phase | Die Datenschutzerklärung enthält die Aussage „{quote}“ ({policyUrl}, Abschnitt {section}; Aussage-Typ {claimId}, Erkennung mit Konfidenz hoch). In der Phase, auf die sich die Aussage bezieht ({phase}), wurde Folgendes beobachtet: {observation} — auf {n} Seiten bzw. in Phase A und in Phase B vor dem Klick. Beide Beobachtungen werden ohne rechtliche Bewertung nebeneinandergestellt. | Aktualität des Textes und Konfiguration des Dienstes abgleichen; Zeitpunkt der letzten Textänderung berücksichtigen. |
| `PRIV-02.contradiction-single` (`warning`) | Aussage „{claimShort}“ und gegenläufige Beobachtung (einmalig) | Wie oben; die gegenläufige Beobachtung wurde nur einmal ({url}, {phase}) festgestellt. | Wie oben. |
| `PRIV-02.wording-to-review` (`info`) | Formulierung prüfen: {topic} | Die Datenschutzerklärung enthält die Formulierung „{quote}“ ({policyUrl}, Abschnitt {section}). Hinweis: {note} (Privacy Shield wurde 2020 für ungültig erklärt; Google reCAPTCHA wird seit 02.04.2026 als Auftragsverarbeiter angeboten – Rollenänderung, Formulierung prüfen). | Formulierung mit dem aktuellen Vertragsstand des Anbieters abgleichen. |

| Schlüssel | en |
|---|---|
| `PRIV-02.contradiction-replicated` | The privacy policy states “{quote}” ({policyUrl}); in the phase the statement refers to ({phase}) the following was observed repeatedly: {observation}. Both are presented side by side without legal assessment. |
| `PRIV-02.contradiction-single` | The privacy policy states “{quote}”; a contrary observation was made once ({url}, {phase}). |
| `PRIV-02.wording-to-review` | Wording to review: “{quote}” ({policyUrl}) — {note}. |

Неоднозначная формулировка — не находка, а статус `inconclusive` с `reason.claim-ambiguous` (5.20). Исторический или условный контекст («früher», «außer») и другой продукт находки не дают ([спецификация проверок](../03-checks.md) §3.2).

### 5.10 LEGAL-01 — Impressum und Datenschutzerklärung: Auffindbarkeit

`legalNote` (`court-appellate`, draft): «§ 5 Abs. 1 DDG verlangt, dass die Anbieterangaben leicht erkennbar, unmittelbar erreichbar und ständig verfügbar gehalten werden; Art. 13 DSGVO verlangt Informationen zur Datenverarbeitung. Der BGH (I ZR 228/03, 20.07.2006) hält eine Erreichbarkeit über zwei Klicks, auch über eine Seite „Kontakt“, für ausreichend. Nach der DSK darf das Einwilligungsbanner den Zugriff auf Impressum und Datenschutzerklärung nicht behindern (OH Digitale Dienste v1.2, Rn. 121 ⚠). Ob zusätzlich § 18 MStV (journalistisch-redaktionelle Angebote) anwendbar ist, wird vom Scanner nicht bestimmt.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `LEGAL-01.document-not-found` (`critical`) | {docType} nicht gefunden | Auf {n} von {m} geprüften Seiten wurde kein Link mit der Bezeichnung „{docType}“ oder bekannten Varianten ({labelsChecked}) gefunden; über die Zwischenseiten {viaPages} erreichbar: nein; Fallback-Pfade {fallbackPaths}: HTTP {fallbackStatus}. Geprüft: {pages}, Viewport {viewport}; Abdeckung geplant {planned} / beobachtet {observed} / auswertbar {evaluated}. | Prüfen, ob die Angaben unter anderer Bezeichnung oder an anderer Stelle bereitgestellt werden. |
| `LEGAL-01.links-broken` (`critical`) | Alle Links zu {docType} führen auf Fehlerseiten | Die gefundenen Links zu „{docType}“ ({linkCount}) führten auf HTTP {statuses} oder auf Seiten ohne erkennbaren Inhalt (Soft-404: {soft404}). | Linkziele prüfen. |
| `LEGAL-01.link-missing-on-some-pages` (`warning`) | Link zu {docType} auf {k} von {m} Seiten nicht gefunden | Ein Link zu „{docType}“ wurde auf {found} Seiten gefunden, auf {k} von {m} geprüften Seiten nicht: {pagesMissing}. | Fußzeile und Navigation dieser Seitenvorlagen prüfen. |
| `LEGAL-01.reachable-via-intermediate` (`warning`, Konfidenz `medium`) | {docType} nur über Zwischenseite oder Standardpfad erreichbar | Auf den geprüften Seiten wurde kein direkter Link gefunden; „{docType}“ ist über {viaPage} erreichbar: ja (zwei Klicks) bzw. unter dem Standardpfad {fallbackPath} (HTTP 200). | Direkten Link in der Fußzeile prüfen. |
| `LEGAL-01.footer-covered-by-banner` (`warning`) | Fußzeile durch Einwilligungsbanner überdeckt | Bei geöffnetem Banner ({cmp}) war der Link „{label}“ an Position {box} überdeckt ({coveredBy}); innerhalb des Banners wurden keine Links zu Impressum oder Datenschutzerklärung gefunden. | Verlinkung von Impressum und Datenschutzerklärung im Banner prüfen. |
| `LEGAL-01.unresolved` (`info`) | Linkziel für {docType} nicht auflösbar | Der Link „{label}“ verweist auf `{href}` (Anker oder Skript); ein Modal mit Inhalt wurde nach dem Klick nicht gefunden, eine SPA-Route wurde nicht aufgelöst. | Manuelle Prüfung des Linkverhaltens. |

| Schlüssel | en |
|---|---|
| `LEGAL-01.document-not-found` | No link labelled “{docType}” or a known variant was found on {n} of {m} pages checked; not reachable via {viaPages}; fallback paths returned HTTP {fallbackStatus}. |
| `LEGAL-01.links-broken` | All {linkCount} links to “{docType}” led to HTTP {statuses} or soft-404 pages. |
| `LEGAL-01.link-missing-on-some-pages` | A link to “{docType}” was not found on {k} of {m} pages checked. |
| `LEGAL-01.reachable-via-intermediate` | “{docType}” was reachable only via {viaPage} or the default path {fallbackPath}. |
| `LEGAL-01.footer-covered-by-banner` | With the banner open, the link “{label}” was covered by {coveredBy}; the banner itself contained no legal links. |
| `LEGAL-01.unresolved` | The link “{label}” points to `{href}`; no modal content or resolved route was found after clicking. |

### 5.11 MAIL-01 — DMARC

`legalNote` (`technical`, draft): «Eine ausdrückliche gesetzliche Pflicht zu DMARC besteht nicht. Die Authentizität von E-Mail-Kommunikation ist ein Aspekt der Sicherheit der Verarbeitung nach Art. 32 DSGVO; die BSI-Richtlinien TR-03108-1 und TR-03182 beschreiben DMARC als Stand der Technik. Der Befund beschreibt die DNS-Konfiguration und trifft keine Aussage über den tatsächlichen Mailversand.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `MAIL-01.record-not-found` (`warning`) | Kein DMARC-Eintrag unter `_dmarc.{domain}` | Unter `_dmarc.{domain}` wurde kein TXT-Eintrag mit `v=DMARC1` gefunden (Resolver {resolver}, {startedAt} UTC, Antwort {rcode}); Tree Walk nach RFC 9989 bis {walkedTo}: kein Eintrag. | DMARC-Richtlinie beim Betreiber der Domain prüfen; Null-MX-Status: {nullMx}. |
| `MAIL-01.policy-none` (`warning`) | DMARC-Eintrag mit `p=none` | Der DMARC-Eintrag für {domain} enthält `p=none` ({record}). | Übergang zu `quarantine` oder `reject` nach Auswertung der Berichte prüfen. |
| `MAIL-01.record-invalid` (`warning`) | DMARC-Eintrag nicht auswertbar | Der TXT-Eintrag unter `_dmarc.{domain}` konnte nicht als DMARC-Eintrag ausgewertet werden: {parseError} ({recordCount} Einträge gefunden). | Syntax des Eintrags prüfen. |
| `MAIL-01.weak-option` (`info`) | DMARC-Option mit eingeschränkter Wirkung | Der DMARC-Eintrag für {domain} enthält {option} (`sp=none`, `t=y`, keine `rua`-Adresse, Null-MX ohne `p=reject`). Berichtsadressen werden maskiert dargestellt: {ruaMasked}. | Option gegen die gewünschte Richtlinie prüfen. |
| `MAIL-01.legacy-pct` (`info`) | DMARC-Eintrag mit Legacy-Tag `pct={pct}` | Der DMARC-Eintrag für {domain} enthält `pct={pct}` ({record}). Das Tag stammt aus RFC 7489 und ist in RFC 9989 entfallen; die übrige Auswertung folgt RFC 9989. | Verwendung des Tags `pct` gegen RFC 9989 prüfen. |

`{record}` — запись с замаскированными до домена `mailto:` в `rua`/`ruf`.

| Schlüssel | en |
|---|---|
| `MAIL-01.record-not-found` | No TXT record with `v=DMARC1` was found under `_dmarc.{domain}` (resolver {resolver}, {rcode}); tree walk per RFC 9989 found no record. |
| `MAIL-01.policy-none` | The DMARC record for {domain} contains `p=none`. |
| `MAIL-01.record-invalid` | The TXT record under `_dmarc.{domain}` could not be parsed as a DMARC record: {parseError}. |
| `MAIL-01.weak-option` | The DMARC record for {domain} contains {option}. |
| `MAIL-01.legacy-pct` | The DMARC record for {domain} contains the legacy tag `pct={pct}` (RFC 7489), which RFC 9989 removed. |

### 5.12 MAIL-02 — SPF

`legalNote`: wie MAIL-01 (`technical`); zusätzlich: «BSI TR-03182 lässt `~all` (SoftFail) zu, wenn DMARC mit `quarantine` oder `reject` wirkt.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `MAIL-02.record-not-found` (`warning`) | Kein SPF-Eintrag für {domain} | Für {domain} wurde kein TXT-Eintrag mit `v=spf1` gefunden (Resolver {resolver}, {startedAt} UTC). | SPF-Eintrag beim Betreiber der Domain prüfen. |
| `MAIL-02.permissive-qualifier` (`warning`) | SPF-Eintrag endet auf `{qualifier}` | Der SPF-Eintrag für {domain} endet auf `{qualifier}` (`+all` oder `?all`): {record}. | Abschluss-Qualifier prüfen. |
| `MAIL-02.record-invalid` (`warning`) | SPF-Eintrag nicht auswertbar | Für {domain} wurden {recordCount} SPF-Einträge gefunden bzw. der Eintrag erzeugt einen Permerror: {parseError} (DNS-Lookups: {lookupCount} von 10, Void-Lookups: {voidCount}). | Syntax und Anzahl der Einträge prüfen. |
| `MAIL-02.softfail-without-enforcement` (`warning`) | `~all` ohne wirksame DMARC-Richtlinie | Der SPF-Eintrag endet auf `~all`; die DMARC-Richtlinie für {domain} lautet {dmarcPolicy} (keine oder `none`). | SPF und DMARC gemeinsam prüfen (BSI TR-03182). |
| `MAIL-02.softfail-with-enforcement` (`info`) | `~all` bei wirksamer DMARC-Richtlinie | Der SPF-Eintrag endet auf `~all`; DMARC für {domain}: `p={dmarcPolicy}`. | Zusammenspiel von SPF und DMARC-Richtlinie dokumentieren. |
| `MAIL-02.ptr-mechanism` (`info`) | SPF-Eintrag enthält den Mechanismus `ptr` | Der SPF-Eintrag für {domain} enthält den Mechanismus `ptr` ({record}); RFC 7208 empfiehlt ihn nicht. | Ersatz von `ptr` durch `ip4`, `ip6` oder `include` prüfen. |

| Schlüssel | en |
|---|---|
| `MAIL-02.record-not-found` | No TXT record with `v=spf1` was found for {domain}. |
| `MAIL-02.permissive-qualifier` | The SPF record for {domain} ends with `{qualifier}`. |
| `MAIL-02.record-invalid` | {recordCount} SPF records were found or the record produces a permerror: {parseError}. |
| `MAIL-02.softfail-without-enforcement` | The SPF record ends with `~all` while the DMARC policy for {domain} is {dmarcPolicy}. |
| `MAIL-02.softfail-with-enforcement` | The SPF record ends with `~all` with DMARC `p={dmarcPolicy}` in place. |
| `MAIL-02.ptr-mechanism` | The SPF record for {domain} contains the `ptr` mechanism, which RFC 7208 does not recommend. |

### 5.13 HDR-01 — Sicherheitsrelevante HTTP-Header

`legalNote` (`technical`, draft): «Art. 32 und Art. 25 DSGVO sowie § 19 Abs. 4 TDDDG verlangen technische Maßnahmen nach dem Stand der Technik; welche HTTP-Header dazu gehören, ergibt sich aus technischen Empfehlungen (OWASP, BSI), nicht aus einer ausdrücklichen Rechtsnorm. Der Befund beschreibt die Antwort zum Prüfzeitpunkt und enthält keine Risikobewertung.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `HDR-01.hsts-missing` (`warning`) | `Strict-Transport-Security` nicht gefunden | In der Antwort von {url} (HTTPS, nach {redirects} Weiterleitungen) wurde der Header `Strict-Transport-Security` nicht gefunden; HSTS-Preload-Liste: {preload}. | Header auf allen HTTPS-Antworten prüfen. |
| `HDR-01.anti-framing-missing` (`warning`) | Kein Schutz gegen Einbettung in Frames | In der Antwort von {url} wurden weder `X-Frame-Options` noch eine `Content-Security-Policy` mit `frame-ancestors` als HTTP-Header gefunden. Eine `frame-ancestors`-Angabe in einem `<meta>`-Element wird von Browsern nicht ausgewertet und wurde nicht berücksichtigt. | Einbettungsschutz per HTTP-Header prüfen. |
| `HDR-01.referrer-policy-permissive` (`warning`) | `Referrer-Policy: {value}` | In der Antwort von {url} wurde `Referrer-Policy: {value}` gefunden (`unsafe-url` oder `no-referrer-when-downgrade`). | Referrer-Richtlinie prüfen. |
| `HDR-01.header-missing` (`info`) | Header `{name}` nicht gefunden | In der Antwort von {url} wurde der Header `{name}` nicht gefunden (`Content-Security-Policy`, `X-Content-Type-Options`, `Permissions-Policy` oder `Referrer-Policy`). Vorhandene sicherheitsrelevante Header: {present}. | Header-Konfiguration prüfen. |

| Schlüssel | en |
|---|---|
| `HDR-01.hsts-missing` | The response from {url} did not include `Strict-Transport-Security`; preload list: {preload}. |
| `HDR-01.anti-framing-missing` | The response from {url} included neither `X-Frame-Options` nor a CSP `frame-ancestors` HTTP header. |
| `HDR-01.referrer-policy-permissive` | The response from {url} included `Referrer-Policy: {value}`. |
| `HDR-01.header-missing` | The response from {url} did not include the header `{name}`. |

### 5.14 TLS-01 — Erreichbarkeit über `http://`

`legalNote` (`authority-consensus`, draft): «§ 19 Abs. 4 S. 3 TDDDG nennt als technische Maßnahme insbesondere die Anwendung eines als sicher anerkannten Verschlüsselungsverfahrens; Art. 32 Abs. 1 lit. a DSGVO nennt die Verschlüsselung personenbezogener Daten. Aufsichtsbehörden sehen die Transportverschlüsselung bei der Erhebung personenbezogener Daten über Formulare als erforderlich an. Umstritten ist die Bewertung rein statischer Seiten ohne Formular.»

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `TLS-01.https-unavailable` (`critical`) | Inhalt über `http://` ausgeliefert, `https://` nicht nutzbar | `http://{host}/` antwortete mit HTTP {status} und {bytes} Bytes Inhalt; `https://{host}/` war nicht erreichbar oder lieferte ein nicht gültiges Zertifikat ({httpsResult}). | HTTPS-Konfiguration des Hosts prüfen. |
| `TLS-01.form-on-http-page` (`critical`) | Formular auf einer `http://`-Seite | Auf {url} (über `http://` geladen) wurde ein Formular mit {fieldCount} Eingabefeldern gefunden (Ziel: `{action}`). | Umleitung auf HTTPS und Formularziel prüfen. |
| `TLS-01.no-redirect` (`warning`) | `http://` antwortet ohne Weiterleitung auf `https://` | `http://{host}/` antwortete mit HTTP {status} ohne Weiterleitung, obwohl `https://{host}/` erreichbar ist; `Strict-Transport-Security` wurde nicht gefunden. | Serverseitige Weiterleitung (301/308) prüfen. |
| `TLS-01.client-side-redirect-only` (`warning`) | Weiterleitung nur per JavaScript oder `<meta>` | `http://{host}/` lieferte HTTP {status} mit einer Weiterleitung per {method} statt einer HTTP-Weiterleitung. | Serverseitige Weiterleitung prüfen. |
| `TLS-01.redirect-chain-detail` (`info`) | Weiterleitungskette mit Zwischenschritt | Die Weiterleitung von `http://{host}/` führte zunächst auf {firstHop} ({hopScheme}); Ziel nach {hops} Schritten: {finalUrl}. Links im Menü auf eigene `http://`-Hosts: {httpLinks}. | Weiterleitungskette und Menülinks prüfen. |

| Schlüssel | en |
|---|---|
| `TLS-01.https-unavailable` | `http://{host}/` served content (HTTP {status}, {bytes} bytes) while `https://{host}/` was unavailable or presented an invalid certificate. |
| `TLS-01.form-on-http-page` | A form with {fieldCount} input fields was found on {url}, which was loaded over `http://`. |
| `TLS-01.no-redirect` | `http://{host}/` responded with HTTP {status} without redirecting to `https://`; no HSTS header found. |
| `TLS-01.client-side-redirect-only` | `http://{host}/` redirects only via {method}, not via an HTTP redirect. |
| `TLS-01.redirect-chain-detail` | The redirect from `http://{host}/` first led to {firstHop}; final target after {hops} hops: {finalUrl}. |

### 5.15 TLS-02 — Zertifikat

`legalNote`: wie TLS-01 (`authority-consensus`).

Для IP-цели (`tls.ipTarget`, проверка `checkIP`, без SNI) вместо `{host}` выводится «IP-Adresse {ip}»: в ICU — `{targetKind, select, ip {IP-Adresse {ip}} other {{host}}}`; ниже сокращённо `{target}`. Порог срока — относительно срока действия L: `warning` при остатке < min(14 д, 25 % L), `info` при < min(30 д, 50 % L), при L ≤ 10 д находки о сроке нет.

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `TLS-02.certificate-invalid` (`critical`) | Zertifikat für {target} nicht gültig: {reasonShort} | Das für {target} ({connectedIp}) präsentierte Zertifikat ist für „{subjectNames}“ ausgestellt und deckt {target} nicht ab / ist seit {notAfter} abgelaufen / ist selbst signiert / wird gegen die Vertrauensliste {trustStore} (Stand {trustStoreDate}) nicht als gültig erkannt ({authorizationError}). Browserbasierte Prüfungen wurden übersprungen (`tls-blocked`). | Zertifikat und Serverkonfiguration prüfen. |
| `TLS-02.chain-incomplete` (`warning`) | Zertifikatskette unvollständig | Der Server {target} lieferte {chainLength} Zertifikate; das Zwischenzertifikat „{missingIssuer}“ fehlt in der Kette. | Vollständige Kette ausliefern. |
| `TLS-02.certificate-expiring` (`warning`) | Zertifikat noch {days} Tage gültig | Das Zertifikat für {target} ist gültig bis {notAfter}: Restlaufzeit {days} Tage bei Gesamtlaufzeit {lifetimeDays} Tage (ab Prüfzeitpunkt). | Verlängerung prüfen. |
| `TLS-02.certificate-expiry-approaching` (`info`) | Zertifikat noch {days} Tage gültig | Wie `certificate-expiring`. | Automatische Verlängerung prüfen. |

| Schlüssel | en |
|---|---|
| `TLS-02.certificate-invalid` | The certificate presented for {target} is not valid for it, has expired on {notAfter}, is self-signed or is not trusted against {trustStore} ({authorizationError}). |
| `TLS-02.chain-incomplete` | The server {target} delivered an incomplete certificate chain; the intermediate “{missingIssuer}” is missing. |
| `TLS-02.certificate-expiring` | The certificate for {target} is valid until {notAfter}: {days} days remaining of a total lifetime of {lifetimeDays} days. |
| `TLS-02.certificate-expiry-approaching` | As `certificate-expiring`. |

Handshake без установленной причины — не находка, а статус `inconclusive` с `reason.handshake-inconclusive` (5.20). Браузерные проверки при невалидном сертификате получают `skipped` с `reason.tls-blocked` (5.20).

### 5.16 CONSENT-05 — Anfragen nach bestätigter Ablehnung

`legalNote` (`authority-consensus`, draft): «§ 25 Abs. 1 TDDDG knüpft das Speichern von Informationen in der Endeinrichtung und den Zugriff darauf an eine Einwilligung im Sinne von Art. 4 Nr. 11 DSGVO; Art. 7 Abs. 3 DSGVO betrifft den Widerruf einer erteilten Einwilligung. Nach Auffassung der EDPB Cookie Banner Taskforce (Type H) kann das Speichern oder Auslesen nicht auf ein berechtigtes Interesse gestützt werden. Umstritten ist die Bewertung von Anfragen ohne Kennung im Consent Mode.»

`{kind}` — вид наблюдения для ветки `select` (03-checks §4): `request` — новый хит с устойчивым идентификатором, `storage` — новая принятая трекинговая запись.

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `CONSENT-05.tracking-after-reject` (`critical`) | {kind, select, storage {Analyse-/Marketing-Eintrag nach bestätigter Ablehnung gespeichert} other {Anfrage mit dauerhafter Kennung nach bestätigter Ablehnung}} | Nach Betätigung von „{rejectLabel}“ war die Ablehnung laut CMP bestätigt (Status nach dem Klick geändert, Entscheidung im CMP vermerkt, alle optionalen Kategorien `denied`, nach dem Neuladen gespeichert). {kind, select, storage {Danach wurde auf {url} der Eintrag „{name}“ ({storageKind}, Domain {domain}) nach dem Klick vom Browser angenommen; Klassifikation laut {dataset} v{datasetVersion}: {category}. Der Wert wurde nicht gespeichert.} other {Danach wurde auf {url} eine nach dem Klick gestartete Anfrage an {host} ({service}) mit dauerhafter Kennung gesendet ({sinceMs} ms nach dem Klick). Anfragen des Einwilligungsbanners zur Aktualisierung des Status sind ausgenommen.}} | Consent-Steuerung des Dienstes bzw. der setzenden Quelle nach Ablehnung prüfen. |
| `CONSENT-05.cookieless-ping-after-reject` (`warning`) | Anfrage ohne dauerhafte Kennung nach Ablehnung | Nach bestätigter Ablehnung wurde eine Anfrage an {host} ohne dauerhafte Kennung gesendet (Consent-Mode-Parameter: {gcs}, `denied`). | Consent-Mode-Konfiguration prüfen. |
| `CONSENT-05.connect-only-after-reject` (`info`) | Nur Verbindungsaufbau zu {host} nach Ablehnung | Nach bestätigter Ablehnung wurde im Proxy-Protokoll ein Verbindungsaufbau (CONNECT) zu {host} ohne beobachtete HTTP-Anfrage protokolliert. | Vorverbindungen (preconnect) prüfen. |

Подтверждённый отказ: `origin: action` после клика, `decision.responded: true`, все необязательные категории `denied`, после reload — `origin: stored` ([архитектура](../02-architecture.md) §8.8 и §11.5). Неподтверждённый отказ (в том числе только default-denied) и нераспознанный CMP — не вариант, а статус `inconclusive` с `reason.reject-not-confirmed` (5.20); при установленных условиях отдельно выдаётся `CONSENT-04.reject-ineffective`. Если отказ подтверждён, но захват pagehide/keepalive недоступен, — `inconclusive` с `reason.pagehide-capture-unavailable` и `limitation.pagehide-capture-unavailable` (расхождение 1 с реестром, начало раздела 5).

| Schlüssel | en |
|---|---|
| `CONSENT-05.tracking-after-reject` | {kind, select, storage {After the confirmed rejection the entry “{name}” ({storageKind}, domain {domain}), classified as {category}, was accepted by the browser after the click.} other {After clicking “{rejectLabel}” (rejection confirmed by the CMP and persisted after reload) a request to {host} ({service}) carrying a persistent identifier was started and sent after the click.}} |
| `CONSENT-05.cookieless-ping-after-reject` | After the confirmed rejection a request to {host} without a persistent identifier (Consent Mode parameters {gcs}) was sent. |
| `CONSENT-05.connect-only-after-reject` | After the confirmed rejection only a CONNECT to {host} without an observed HTTP request was logged by the proxy. |

### 5.17 P1-Prüfungen (Etappe 3б)

Варианты P1 — все варианты реестра §2.1. Исходы без находки — в 5.20: CONSENT-06 `reason.not-observable`, VULN-01 и VULN-02 `reason.source-unavailable`, TLS-04 `reason.handshake-inconclusive`. VULN-01 и VULN-02 делят набор вариантов (реестр §2.1, сноска ³); `{basis}` в `critical`-варианте — `kev` (запись в CISA KEV) или `preauth` (класс advisory без входа: RCE, SQL-Injection, Upload, Auth-Bypass).

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `EMBED-03.video-loaded` (`warning`) | Videodienst {service} auf {url} geladen | Auf {url} wurden Ressourcen von {host} geladen (Typ: {embedType}: Player, iframe oder Vorschaubild; {phase}). Für `youtube-nocookie.com`: erweiterter Datenschutzmodus erkannt (Attribut `{attribute}`). Vorschaubild ≠ Wiedergabe: {thumbnailOnly}. Speichereinträge werden unter CONSENT-02 ausgewiesen. | Zwei-Klick-Lösung oder lokales Vorschaubild prüfen. |
| `EMBED-04.captcha-without-form` (`warning`) | {service} auf Seiten ohne sichtbares Formular geladen | Das Skript {scriptUrl} ({service}: reCAPTCHA, hCaptcha, Turnstile oder Friendly Captcha) wurde auf {n} Seiten geladen, davon {k} ohne erkanntes sichtbares Formular ({phase}; Stufe: {stage}). Die Zuordnung zu einer Sicherheitsfunktion wurde nicht bewertet. | Einbindung nur auf Seiten mit Formular prüfen. |
| `EMBED-04.captcha-with-form` (`info`) | {service} auf Seite mit Formular geladen | Das Skript {scriptUrl} ({service}) wurde auf {url} mit erkanntem Formular geladen ({phase}). Hinweis: Google bietet reCAPTCHA seit 02.04.2026 als Auftragsverarbeiter an; der Vertragsstand des Betreibers ist nicht erkennbar. | Rolle des Anbieters und Erforderlichkeit dokumentieren (nicht bewertet). |
| `EMBED-05.widget-loaded` (`warning`) | Widget {service} auf {url} geladen | Auf {url} wurde das Widget {service} von {host} geladen (Pfad-Signatur {signature}, {phase}). Speichereinträge werden unter CONSENT-02 ausgewiesen. | Nachladen des Widgets nach Auswahl im Banner prüfen. |
| `CONSENT-06.google-granted-despite-denied` (`critical`) | Consent Mode: `granted` an Google trotz `denied` im CMP | Vor Interaktion bzw. nach Betätigung von „{rejectLabel}“ meldete das CMP ({cmp}) `denied` für {categories}; die Anfrage an {host} enthielt `{param}={value}` (Decoder-Version {decoderVersion}: `granted`). | Zuordnung CMP → Consent Mode prüfen. |
| `CONSENT-06.default-granted` (`warning`) | Consent-Mode-Standard `granted` vor Interaktion | Vor einer Interaktion wurde `gtag('consent','default', …)` mit `{param}: 'granted'` beobachtet (Quelle {scriptUrl}, Region {region}); eine Anfrage mit Kennung wurde in dieser Phase nicht beobachtet. | Standardzustand des Consent Mode prüfen. |
| `CONSENT-06.hit-before-default` (`warning`) | Anfrage vor dem Consent-Mode-Standard | Eine Anfrage an {host} wurde {deltaMs} ms vor dem ersten `consent default`-Befehl beobachtet. | Ladereihenfolge der Skripte prüfen. |
| `VULN-01.version-listed-kev-or-preauth` (`critical`) | Versionsangabe {product} {version}: {basis, select, kev {Eintrag in CISA KEV} other {Advisory-Klasse ohne Anmeldung}} | Im Quelltext von {url} wurde die Angabe „{product} {version}“ gefunden (Quelle: {source}; Genauigkeit: exakt). {database} (Stand {datasetDate}) listet für diese Version {count} Einträge, darunter {cve} ({basis, select, kev {CISA KEV, Katalogversion {kevVersion}} other {Klasse laut Advisory: {advisoryClass}, ohne Anmeldung}}). Die tatsächlich installierte Version, Backports und die Ausnutzbarkeit wurden nicht geprüft. | Installierte Version und Patch-Stand im Backend abgleichen. |
| `VULN-01.version-listed` (`warning`) | Versionsangabe {product} {version}: Einträge in {database} | Wie oben; kein Eintrag in CISA KEV und keine Advisory-Klasse RCE, SQL-Injection, Upload oder Auth-Bypass ohne Anmeldung. Genauigkeit der Versionsangabe: {versionConfidence} (bei „Bereich“ eine Stufe niedriger eingeordnet). | Wie oben. |
| `VULN-01.eol-major` (`warning`) | {product} {major}: Hauptversion ohne Herstellerpflege | Die gefundene Hauptversion {major} von {product} wird laut {eolSource} (Stand {eolDate}) nicht mehr mit Sicherheitsaktualisierungen versorgt. | Aktualisierungsplanung prüfen. |
| `VULN-01.version-unknown` (`info`) | {product} erkannt, Version nicht bestimmbar | {product} wurde anhand von {fingerprint} erkannt; eine Versionsangabe wurde nicht gefunden. CVE-Einträge werden ohne Version nicht zugeordnet. | Version im Backend prüfen. |
| `VULN-02.version-listed-kev-or-preauth` (`critical`) | {component} {version}: {basis, select, kev {Eintrag in CISA KEV} other {Advisory-Klasse ohne Anmeldung}} | Die Datei {url} enthält die Versionskennung „{component} {version}“ (Quelle: {source}: Dateiinhalt, Hash, `Stable tag`, `?ver=`; Genauigkeit {versionConfidence}). {database} (Stand {datasetDate}) listet {cve} ({basis, select, kev {CISA KEV: ja} other {Klasse laut Advisory: {advisoryClass}, ohne Anmeldung}}). Ob der betroffene Code-Pfad genutzt wird, wurde nicht geprüft. Hinweis zur Einordnung clientseitiger Bibliotheken: siehe Regelwerk {rulesetVersion}. | Komponente aktualisieren oder betroffene Funktion prüfen. |
| `VULN-02.version-listed` (`warning`) | {component} {version}: Einträge in {database} | Wie oben, jedoch kein Eintrag in CISA KEV und keine Advisory-Klasse RCE, SQL-Injection, Upload oder Auth-Bypass ohne Anmeldung; bei nur `Stable tag` oder `?ver=` als Bereich eingeordnet. | Wie oben. |
| `VULN-02.eol-major` (`warning`) | {component} {major}: Hauptversion ohne Herstellerpflege | Die in {url} gefundene Hauptversion {major} von {component} wird laut {eolSource} (Stand {eolDate}) nicht mehr mit Sicherheitsaktualisierungen versorgt. | Aktualisierungsplanung der Komponente prüfen. |
| `VULN-02.version-unknown` (`info`) | {component} erkannt, Version nicht bestimmbar | {component} wurde erkannt (gleichnamige oder gebündelte Kopie: {bundled}); eine eindeutige Version wurde nicht bestimmt. | Version im Build prüfen. |
| `MAIL-03.selectors-not-found` (`info`) | DKIM: unter {count} geprüften Selektoren nicht gefunden | Für {domain} wurde unter den geprüften DKIM-Selektoren ({selectors}: angegeben, anbieterdokumentiert nach MX {mxProvider}, generisch) kein Eintrag `<selector>._domainkey.{domain}` gefunden. Andere Selektoren wurden nicht geprüft; die Signaturdomain kann von der Webdomain abweichen. | Verwendeten Selektor beim Mailanbieter erfragen und mit `--dkim-selector` erneut prüfen. |
| `MAIL-03.key-too-short` (`warning`) | DKIM-Schlüssel mit {bits} Bit | Der Eintrag `{selector}._domainkey.{domain}` enthält einen RSA-Schlüssel mit {bits} Bit (< 1024). | Schlüssel erneuern. |
| `MAIL-03.given-selector-missing` (`warning`) | Angegebener Selektor `{selector}` nicht gefunden oder zurückgezogen | Für den mit `--dkim-selector` angegebenen Selektor wurde kein Eintrag gefunden bzw. der Eintrag enthält ein leeres `p=` (Schlüssel zurückgezogen). | Selektor und Rotation prüfen. |
| `TLS-03.active-mixed-content-blocked` (`warning`) | Gemischter Inhalt: aktive Ressource vom Browser blockiert | Auf der HTTPS-Seite {url} wurde die aktive Ressource `{sourceUrl}` ({resourceType}) über `http://` angefordert; der Browser hat die Anfrage blockiert. | Ressource über HTTPS bereitstellen und Referenz auf `https://` umstellen. |
| `TLS-03.passive-upgrade-failed` (`warning`) | Gemischter Inhalt: Upgrade auf HTTPS fehlgeschlagen | Auf der HTTPS-Seite {url} wurde die passive Ressource `{sourceUrl}` ({resourceType}) über `http://` referenziert; das automatische Upgrade auf HTTPS schlug fehl. Abruf über `http://` laut Browser: {transferred, select, true {ja} other {nein}}. | Ressource über HTTPS bereitstellen und Referenz auf `https://` umstellen. |
| `TLS-03.form-action-http` (`warning`) | Formularziel über `http://` | Auf der HTTPS-Seite {url} verweist ein Formular auf `{action}` (`http://`). | Formularziel prüfen. |
| `TLS-03.passive-auto-upgraded` (`info`) | Passiver gemischter Inhalt automatisch aufgewertet | Die Ressource `{sourceUrl}` wurde im Quelltext über `http://` referenziert und vom Browser über HTTPS geladen. | Referenz bereinigen. |
| `TLS-04.legacy-protocol-accepted` (`warning`) | Server akzeptiert {protocol} | Der Server {host}:443 ({connectedIp}, SNI {host}) hat einen Handshake mit {protocol} angenommen (Prüfmethode: {method}). TLS 1.1: {tls11}. BSI TR-02102-2 (2026-01) und RFC 8996 raten von TLS 1.0 und 1.1 ab. | Protokollkonfiguration prüfen; bei CDN alle Edge-Knoten berücksichtigen. |

| Schlüssel | en |
|---|---|
| `EMBED-03.video-loaded` | Resources of {service} were loaded from {host} on {url} (type {embedType}, {phase}); thumbnail only: {thumbnailOnly}. |
| `EMBED-04.captcha-without-form` | The script {scriptUrl} ({service}) was loaded on {n} pages, {k} of them without a recognised visible form. |
| `EMBED-04.captcha-with-form` | The script {scriptUrl} ({service}) was loaded on {url} together with a recognised form; Google offers reCAPTCHA as a processor since 02.04.2026. |
| `EMBED-05.widget-loaded` | The widget {service} was loaded from {host} on {url} ({phase}). |
| `CONSENT-06.google-granted-despite-denied` | The CMP reported `denied` for {categories} while the request to {host} carried `{param}={value}` decoded as `granted`. |
| `CONSENT-06.default-granted` | `gtag('consent','default', …)` with `{param}: 'granted'` was observed before any interaction. |
| `CONSENT-06.hit-before-default` | A request to {host} was observed {deltaMs} ms before the first `consent default` command. |
| `VULN-01.version-listed-kev-or-preauth` | The version string “{product} {version}” was found on {url}; {database} lists {cve} ({basis, select, kev {in CISA KEV} other {advisory class {advisoryClass} without authentication}}); the installed version and exploitability were not verified. |
| `VULN-01.version-listed` | The version string “{product} {version}” was found; {database} lists {count} entries, none in CISA KEV. |
| `VULN-01.eol-major` | Major version {major} of {product} no longer receives security updates per {eolSource}. |
| `VULN-01.version-unknown` | {product} was recognised but no version string was found. |
| `VULN-02.version-listed-kev-or-preauth` | {url} contains the version string “{component} {version}”; {database} lists {cve} ({basis, select, kev {in CISA KEV} other {advisory class {advisoryClass} without authentication}}); use of the affected code path was not checked. |
| `VULN-02.version-listed` | {url} contains the version string “{component} {version}”; {database} lists {count} entries. |
| `VULN-02.eol-major` | Major version {major} of {component} found in {url} no longer receives security updates per {eolSource}. |
| `VULN-02.version-unknown` | {component} was recognised but its version could not be determined. |
| `MAIL-03.selectors-not-found` | No DKIM record was found for {domain} under the {count} selectors checked ({selectors}); other selectors were not checked. |
| `MAIL-03.key-too-short` | The DKIM record `{selector}._domainkey.{domain}` contains an RSA key of {bits} bits. |
| `MAIL-03.given-selector-missing` | No record was found for the selector `{selector}` given on the command line, or its key is revoked (empty `p=`). |
| `TLS-03.active-mixed-content-blocked` | On the HTTPS page {url} the active resource `{sourceUrl}` was requested over `http://` and blocked by the browser. |
| `TLS-03.passive-upgrade-failed` | On the HTTPS page {url} the passive resource `{sourceUrl}` was referenced over `http://` and the automatic HTTPS upgrade failed; fetched over `http://` per browser: {transferred}. |
| `TLS-03.form-action-http` | A form on the HTTPS page {url} posts to `{action}` over `http://`. |
| `TLS-03.passive-auto-upgraded` | The resource `{sourceUrl}` is referenced over `http://` and was auto-upgraded to HTTPS by the browser. |
| `TLS-04.legacy-protocol-accepted` | The server {host}:443 accepted a {protocol} handshake (method {method}); TLS 1.1: {tls11}. |

### 5.18 P2-Prüfungen (nach dem Release; `crmCode: null`)

| Schlüssel | Titel (de) | Beschreibung (de) | Hinweis zur manuellen Prüfung (de) |
|---|---|---|---|
| `DNS-01.caa-not-found` (`info`) | Kein CAA-Eintrag für {domain} | Für {domain} wurde bis {walkedTo} kein CAA-Eintrag gefunden (Resolver {resolver}). Für CAA besteht keine gesetzliche Pflicht (RFC 8659). | Festlegung der zulässigen Zertifizierungsstellen prüfen. |
| `DNS-01.dnssec-unsigned` (`info`) | Keine signierte Delegation für {domain} | Beim Elternteil von {domain} wurde kein DS-Eintrag gefunden; DNSSEC-Validierung: {validation} (nur bei vertrauenswürdigem validierendem Resolver bewertet). | DNSSEC-Signierung beim Registrar prüfen. |
| `DNS-01.dnssec-bogus` (`warning`) | DNSSEC-Validierung fehlgeschlagen (bogus) | Der validierende Resolver {resolver} meldete für {domain} den Status bogus ({detail}). | Signaturen und DS-Einträge prüfen. |
| `HDR-02.session-cookie-attributes` (`warning`) | Sitzungs-Cookie „{name}“ ohne {missingAttributes} | In der Antwort von {url} wurde das Cookie „{name}“ (Rolle laut Muster: Sitzung) ohne die Attribute {missingAttributes} (`Secure`, `HttpOnly`) gesetzt. Der Wert wurde nicht gespeichert. | Cookie-Attribute in der Anwendungskonfiguration prüfen. |
| `HDR-02.cookie-attributes` (`info`) | Cookie „{name}“ ohne {missingAttributes} | In der Antwort von {url} wurde das Cookie „{name}“ (keine Sitzungsrolle laut Muster) ohne die Attribute {missingAttributes} (`Secure`, `HttpOnly`) gesetzt. Der Wert wurde nicht gespeichert. | Cookie-Attribute prüfen; ob `HttpOnly` für dieses Cookie vorgesehen ist, wurde nicht bewertet. |
| `HDR-02.cookie-samesite-missing` (`info`) | Cookie „{name}“ ohne `SameSite` | Das Cookie „{name}“ wurde ohne `SameSite`-Attribut gesetzt ({url}). | Attribut ergänzen. |
| `HDR-02.version-header` (`info`) | Versionsangabe im Header `{name}` | In der Antwort von {url} wurde `{name}: {value}` gefunden. Die Angabe wird als Signal an VULN weitergegeben. | Header-Ausgabe prüfen. |
| `ADMIN-01.users-and-xmlrpc-exposed` (`warning`) | Benutzerliste abrufbar und XML-RPC erreichbar | `{usersEndpoint}` antwortete mit HTTP 200 und {userCount} Einträgen (Inhalte nicht gespeichert); `/xmlrpc.php` antwortete mit HTTP {xmlrpcStatus}. Es wurden keine Anmeldeversuche und keine XML-RPC-Aufrufe unternommen. | Zugriff auf Benutzerendpunkte und XML-RPC prüfen. |
| `ADMIN-01.partial-exposure` (`info`) | {exposedItem} erreichbar | {exposedItem} antwortete mit HTTP {status} ({detail}: Anzahl der Einträge oder Weiterleitungsverhalten von `/?author=1`). Es wurden keine Anmeldeversuche unternommen. | Konfiguration prüfen. |
| `FILE-01.sensitive-signature` (`critical`, opt-in `--exposure-probes`) | Pfad `{path}` antwortet mit Inhalt des Formats {signature} | Der Pfad `{path}` antwortete mit HTTP 200; die ersten {bytesRead} Bytes entsprechen dem Format {signature} (Zugangsdaten-, VCS-Konfigurations- oder Datenbank-Dump-Signatur) und unterscheiden sich von der Soft-404-Referenz. Der Inhalt wurde nicht gespeichert und nicht verwendet; weitere Pfade wurden nicht abgerufen. | Erreichbarkeit des Pfads und Inhalt serverseitig prüfen; Meldepflichten nach Art. 33/34 DSGVO bewertet der Verantwortliche. |
| `FILE-01.exposed-file` (`warning`) | Pfad `{path}` erreichbar | Der Pfad `{path}` (`.git/HEAD`, `phpinfo`, `debug.log`) antwortete mit HTTP 200 und einem Inhalt, der dem erwarteten Format entspricht ({bytesRead} Bytes gelesen, nicht gespeichert). | Zugriff auf den Pfad prüfen. |
| `FILE-01.minor-file` (`info`) | Datei `{path}` erreichbar | Der Pfad `{path}` (`.DS_Store`) antwortete mit HTTP 200 ({bytesRead} Bytes gelesen, nicht gespeichert). | Datei entfernen. |
| `SEC-01.security-txt-not-found` (`info`) | Keine `security.txt` gefunden | Unter `/.well-known/security.txt` und `/security.txt` wurde keine Datei gefunden (HTTP {status}). RFC 9116 ist eine Empfehlung ohne gesetzliche Verpflichtung. | Kontaktangabe für Sicherheitsmeldungen prüfen. |
| `SEC-01.security-txt-incomplete` (`info`) | `security.txt` ohne {missingField} oder abgelaufen | Die Datei unter {url} enthält kein Feld `{missingField}` bzw. `Expires: {expires}` liegt in der Vergangenheit. Kontaktadressen werden maskiert dargestellt. | Datei aktualisieren. |
| `LEGAL-02.outdated-reference` (`info`) | Verweis auf „{oldNorm}“ gefunden | Im {docType} unter {url} wurde der Verweis „{oldNorm}“ gefunden (Auszug ≤ 200 Zeichen: „{quote}“). Diese Bezeichnung wurde am {validFrom} durch „{newNorm}“ abgelöst (TMG → DDG und TTDSG → TDDDG: 14.05.2024; RStV → MStV: 07.11.2020; OS-Plattform eingestellt: 20.07.2025). Die Nennung der alten Bezeichnung trifft für sich genommen keine Aussage über die Vollständigkeit der Angaben. | Verweise aktualisieren. |
| `BFSG-01.axe-rule-observed` (`info`, `gating: false`) | axe-core: {count} Regelverletzungen ({ruleId}) | axe-core v{axeVersion} meldete auf {n} Seiten {count} Verletzungen der Regel `{ruleId}` (WCAG {wcagLevel}; Beispiel: {selector}). Unvollständige Prüfungen (`incomplete`): {incompleteCount}. Ob der Dienst in den Anwendungsbereich des BFSG fällt, wurde nicht geprüft; automatisierte Tests erfassen nur einen Teil der Kriterien. | Manuelle Prüfung der betroffenen Elemente. |
| `PERF-01.lab-metrics` (`info`, `gating: false`) | Lighthouse-Laborwerte (einmalig) | Lighthouse v{lighthouseVersion}: LCP {lcp} s, CLS {cls}, TBT {tbt} ms; größte Ressource {largestResource} ({sizeMb} MB). Laborwert, einmalig gemessen; kein Rechtsbezug. | Ressourcen und Ladeverhalten prüfen. |

| Schlüssel | en |
|---|---|
| `DNS-01.caa-not-found` | No CAA record was found for {domain}; CAA is not legally required (RFC 8659). |
| `DNS-01.dnssec-unsigned` | No DS record was found at the parent of {domain}; validation status: {validation}. |
| `DNS-01.dnssec-bogus` | The validating resolver {resolver} reported DNSSEC status bogus for {domain}. |
| `HDR-02.session-cookie-attributes` | The session cookie “{name}” was set without {missingAttributes} in the response from {url}. |
| `HDR-02.cookie-attributes` | The cookie “{name}” (no session role per pattern) was set without {missingAttributes} in the response from {url}. |
| `HDR-02.cookie-samesite-missing` | The cookie “{name}” was set without a `SameSite` attribute. |
| `HDR-02.version-header` | The response from {url} included `{name}: {value}`. |
| `ADMIN-01.users-and-xmlrpc-exposed` | `{usersEndpoint}` responded with HTTP 200 and {userCount} entries (contents not stored); `/xmlrpc.php` responded with HTTP {xmlrpcStatus}; no login attempts were made. |
| `ADMIN-01.partial-exposure` | {exposedItem} responded with HTTP {status} ({detail}); no login attempts were made. |
| `FILE-01.sensitive-signature` | The path `{path}` responded with HTTP 200 and the first {bytesRead} bytes match the format {signature}; contents were not stored or used. |
| `FILE-01.exposed-file` | The path `{path}` responded with HTTP 200 with content matching the expected format ({bytesRead} bytes read, not stored). |
| `FILE-01.minor-file` | The path `{path}` responded with HTTP 200 ({bytesRead} bytes read, not stored). |
| `SEC-01.security-txt-not-found` | No file was found at `/.well-known/security.txt` or `/security.txt` (HTTP {status}); RFC 9116 is a recommendation. |
| `SEC-01.security-txt-incomplete` | The file at {url} lacks `{missingField}` or its `Expires` date lies in the past. |
| `LEGAL-02.outdated-reference` | The {docType} at {url} refers to “{oldNorm}”, replaced on {validFrom} by “{newNorm}”; this alone says nothing about the completeness of the information. |
| `BFSG-01.axe-rule-observed` | axe-core v{axeVersion} reported {count} violations of rule `{ruleId}` (WCAG {wcagLevel}) on {n} pages; BFSG applicability was not checked. |
| `PERF-01.lab-metrics` | Lighthouse v{lighthouseVersion}: LCP {lcp} s, CLS {cls}, TBT {tbt} ms; single lab measurement, no legal relevance. |

### 5.19 Diagnosen `SCAN-*` (Block «Einschränkungen der Messung»)

Диагностики не имеют уровня и `crmCode`, не гейтят (кроме `--strict`) и выводятся отдельным блоком; поле `affects[]` перечисляет затронутые проверки.

| Code | de | en |
|---|---|---|
| `SCAN-GEO` | Das Einwilligungsbanner ({cmp}) hat ein Regionssignal gemeldet ({signal}); die betroffenen Prüfungen ({affects}) wurden als nicht auswertbar eingestuft. Egress-Region des Scans: {egressRegion} ({egressSource}). | The consent banner ({cmp}) reported a region signal ({signal}); affected checks ({affects}) are not assessable. Scan egress region: {egressRegion}. |
| `SCAN-BOTMODE` | Das Einwilligungsbanner ({cmp}) hat den Scanner als automatisierten Zugriff behandelt ({signal}); die betroffenen Prüfungen ({affects}) wurden als nicht auswertbar eingestuft. | The consent banner ({cmp}) treated the scanner as automated traffic ({signal}); affected checks are not assessable. |
| `SCAN-BLOCKED` | Die Startseite antwortete mit einer Zugangsprüfung oder HTTP {status} ({detail}); der Scan wurde nicht durchgeführt. | The start page responded with a challenge or HTTP {status}; the scan was not performed. |
| `SCAN-UNREACHABLE` | Das Ziel {target} war nicht erreichbar ({detail}: NXDOMAIN, Verbindung abgelehnt, Zeitüberschreitung, HTTP 5xx zweimal). | The target {target} was unreachable ({detail}). |
| `SCAN-THROTTLED` | Der Zielhost antwortete wiederholt mit HTTP {status} ({count}-mal, {source, select, browser {Navigation in Phase {phase}} other {HTTP-Proben}}); nach der Wartezeit laut `Retry-After` und einem erneuten Versuch wurden keine weiteren Anfragen an diesen Host gestartet. Die betroffenen Prüfungen ({affects}) wurden nur teilweise durchgeführt. | The target host repeatedly responded with HTTP {status}; after waiting per `Retry-After` and one retry no further requests to it were started; affected checks were only partially performed. |
| `SCAN-TIMEOUT` | Das Zeitlimit von {timeout} wurde erreicht; nicht abgeschlossene Prüfungen: {affects}. | The time limit of {timeout} was reached; incomplete checks: {affects}. |
| `SCAN-SANDBOX-OFF` | Der Browser wurde ohne Sandbox ausgeführt (`--sandbox off`). | The browser ran without a sandbox (`--sandbox off`). |
| `SCAN-PRIVATE-REQUEST-BLOCKED` | {count} Verbindungen zu nicht öffentlichen Adressen ({targets}) wurden vor dem Aufbau blockiert (Egress-Prüfung). | {count} connections to non-public addresses ({targets}) were blocked before being opened (egress check). |

### 5.20 Исходы без находки: `reason.<id>` и `limitation.<id>`

Исходы `inconclusive`, `error`, `skipped` и `not_applicable` — не варианты: у них нет уровня, `messageId`, `crmCode` и находки ([архитектура](../02-architecture.md) §9.1 и §11.3; 03-checks §2.1). Исключение — только `locked`-варианты CONSENT-04 (5.4). Текст `reason.<id>` подставляется в статусную строку проверки из 1.3 («Nicht auswertbar: {reason}», «Nicht geprüft: {reason}»), поэтому начинается без повторения статуса; тексты `limitation.<id>` выводятся в строке «Einschränkungen» шаблона 3.2. Ids — по столбцу «Не варианты» реестра 03-checks §2.1; отклонение — только `reason.pagehide-capture-unavailable` (расхождение 1, начало раздела 5). `reason.tls-blocked` реестр не перечисляет, но его называют [архитектура](../02-architecture.md) §12 и 03-checks §3.14. Схема ключей `reason.<id>` / `limitation.<id>` и ветки `select` — предложение автора, не согласовано (открытый вопрос 3; 03-checks Q6). Один id — один текст для всех проверок, которые его используют.

| Ключ | Проверки | de | en |
|---|---|---|---|
| `reason.pdf-not-evaluated` | PRIV-01 | Die Datenschutzerklärung unter {policyUrl} liegt als PDF vor und wurde nicht ausgewertet; PDF-Dokumente werden in dieser Version nicht ausgewertet. | The privacy policy at {policyUrl} is a PDF and was not evaluated; PDF documents are not evaluated in this version. |
| `reason.document-incomplete` | PRIV-01 | Der Text der Datenschutzerklärung unter {policyUrl} wurde nicht vollständig erfasst; laut Manifest nicht erfasste Teile: {missingParts}. | The text of the privacy policy at {policyUrl} was not fully captured; parts not captured per manifest: {missingParts}. |
| `reason.language-unsupported` | PRIV-01 | Die Datenschutzerklärung unter {policyUrl} ist in der Sprache {lang} verfasst; ausgewertet werden Texte in Deutsch und Englisch. | The privacy policy at {policyUrl} is written in {lang}; only German and English texts are evaluated. |
| `reason.claim-ambiguous` | PRIV-02 | Die Formulierung „{quote}“ ({policyUrl}, Abschnitt {section}) konnte keinem Aussage-Typ mit ausreichender Konfidenz zugeordnet werden ({detail, select, negation-scope {Bezug der Verneinung nicht eindeutig} unsupported-construction {Satzbau nicht unterstützt} other {{detail}}}). | The statement “{quote}” ({policyUrl}, section {section}) could not be attributed to a claim type with sufficient confidence ({detail}). |
| `reason.handshake-inconclusive` | TLS-02, TLS-04 | Der TLS-Handshake mit {target} ({connectedIp}{protocol, select, negotiated {} other {; angefragtes Protokoll {protocol}}}) endete mit {detail}; ein eindeutiges Ergebnis wurde nicht festgestellt. | The TLS handshake with {target} ({connectedIp}{protocol, select, negotiated {} other {; requested protocol {protocol}}}) ended with {detail}; no unambiguous result was established. |
| `reason.not-observable` | CONSENT-06 | Die Consent-Mode-Befehle wurden über {method, select, gtm-template {die GTM-Template-API} custom-datalayer {ein eigenes `dataLayer`} other {{method}}} ausgeführt und sind passiv nicht beobachtbar; `gcd`-Format unbekannt: {gcdUnknown}. | Consent Mode commands were issued via {method} and cannot be observed passively; unknown `gcd` format: {gcdUnknown}. |
| `reason.source-unavailable` | VULN-01, VULN-02 | {database} war zum Prüfzeitpunkt nicht erreichbar ({error}); die Versionsangabe „{product} {version}“ wurde ohne Abgleich protokolliert. | {database} was unavailable at scan time ({error}); the version string “{product} {version}” was recorded without lookup. |
| `reason.reject-not-confirmed` | CONSENT-05 | Ablehnung nicht bestätigt ({detail, select, default-only {nur Ausgangszustand des CMP} no-decision {keine Entscheidung im CMP vermerkt} not-stored {nach dem Neuladen nicht gespeichert} cmp-unknown {CMP nicht erkannt oder nicht unterstützt} other {CMP-Status nach dem Klick: {stateAfter}}}); Anfragen nach der Ablehnung wurden nicht ausgewertet. | Rejection not confirmed ({detail}, e.g. only the CMP's initial state); requests after the rejection were not evaluated. |
| `reason.pagehide-capture-unavailable` | CONSENT-05 (расхождение 1) | Ablehnung laut CMP bestätigt; Anfragen beim Verlassen der Seite (pagehide, keepalive) konnten in dieser Messumgebung nicht erfasst werden, daher wurden Anfragen nach der Ablehnung nicht abschließend ausgewertet. | Rejection confirmed by the CMP; requests sent on page exit (pagehide, keepalive) could not be captured in this environment, so requests after the rejection were not fully evaluated. |
| `reason.tls-blocked` | браузерные проверки при TLS-02 `certificate-invalid` (`skipped`) | Das Zertifikat für {target} wurde nicht als gültig erkannt (TLS-02); browserbasierte Prüfungen wurden übersprungen. | The certificate for {target} was not recognised as valid (TLS-02); browser-based checks were skipped. |
| `limitation.banner-open` | PRIV-01 | Einwilligungsbanner nicht geschlossen: {count} aufklappbare Abschnitte der Datenschutzerklärung wurden nicht geöffnet; ausgewertet wurde der ohne Klick verfügbare Text. | Consent banner not closed: {count} expandable sections of the privacy policy were not opened; only text available without clicking was evaluated. |
| `limitation.screenshot-skipped` | CONSENT-04 | Kein Bildschirmfoto des Bannerbereichs: {detail, select, ambiguous {Bannerbereich nicht eindeutig abgrenzbar} too-large {Bannerbereich größer als 50 % des Viewports} disabled {mit `--no-screenshots` abgeschaltet} other {{detail}}}. | No screenshot of the banner area: {detail}. |
| `limitation.lexicon-changed-since-scan` | CONSENT-04 | Lexikon seit dem Scan geändert: die Einordnung der Schaltflächen weicht von der beim Scan betätigten Schaltfläche ab. | Lexicon changed since the scan: the button classification differs from the button clicked during the scan. |
| `limitation.pagehide-capture-unavailable` | CONSENT-05 | Anfragen beim Verlassen der Seite (pagehide, keepalive) wurden nicht erfasst. | Requests sent on page exit (pagehide, keepalive) were not captured. |

---

## 6. Черновик дисклеймера (Hinweis / Haftungsausschluss)

Дисклеймер выводится в каждом человекочитаемом формате и в `disclaimer` JSON; он обязателен и в минимальном отчёте при `scan.status: failed`. Флага отключения нет. Абзацы с пометкой **[условие]** рендерятся только при выполнении условия, чтобы текст всегда оставался истинным. Плейсхолдеры берутся из `tool`, `ruleset`, `datasets[]`, `scan.environment`.

> **Hinweis zur Art dieses Berichts.** Dieser Bericht wurde automatisiert durch `dsgvo-check` {toolVersion} am {startedAt} UTC erstellt (Messumgebung: {engine} {engineVersion}, Viewport {viewport}, Sprache de-DE, Zeitzone Europe/Berlin; User-Agent „{userAgent}“; Egress-Modus {egressMode}, Egress-Region {egressRegion} laut {egressSource}). Er dokumentiert technische Beobachtungen zum Prüfzeitpunkt: Netzwerkanfragen, Cookies und Speichereinträge, Seitenelemente, HTTP-Header, DNS-Einträge und TLS-Verbindungen. Die Ergebnisse sind eine Momentaufnahme und können sich jederzeit ändern.
>
> **Einordnung der Beobachtungen.** Beobachtungen werden anhand versionierter Datenbestände zugeordnet ({datasetsList}, jeweils mit Stand, Lizenz und Prüfsumme im Abschnitt „Datensätze und Attribution“). Die Zuordnung ist eine technische Klassifikation mit angegebener Konfidenz; ein nicht zugeordneter Host wird als „unbekannt“ geführt, nicht als Dienst einer bestimmten Kategorie. Die Stufen „Kritisch“, „Warnung“ und „Hinweis“ folgen dem Regelwerk {rulesetVersion} (Rechtsstand {rechtsstand}) und ordnen Beobachtungen nach technischer Priorität; sie stellen keine rechtliche Bewertung dar.
>
> **Keine rechtliche Bewertung.** Der Bericht trifft keine Aussage darüber, ob die geprüfte Website geltendes Recht einhält oder verletzt. Diese Frage hängt von Umständen ab, die automatisiert nicht erfasst werden können, unter anderem von vertraglichen Regelungen, Rechtsgrundlagen, der Erforderlichkeit einzelner Funktionen, dem Ort der Datenverarbeitung und dem eingesetzten Übermittlungsinstrument. Die zu den einzelnen Prüfungen genannten Rechtsvorschriften, Entscheidungen und Veröffentlichungen von Aufsichtsbehörden sind allgemeiner Natur, gelten für alle geprüften Websites gleichermaßen und beziehen sich nicht auf den Einzelfall. Der Bericht ersetzt keine Rechtsberatung und keine Prüfung durch eine fachkundige Person.
>
> **Fehlende Beobachtungen.** Das Fehlen einer Beobachtung bedeutet nicht, dass die betreffende Funktion nicht vorhanden ist oder dass keine Beanstandung möglich wäre. Die Prüfung umfasst {pagesPlanned} geplante Seiten, von denen {pagesObserved} aufgerufen und {pagesEvaluated} ausgewertet wurden; die Phasen und Grenzen der Messung sind im Abschnitt „Messumgebung“ und im Block „Einschränkungen der Messung“ beschrieben.
>
> **Gespeicherte Daten.** Werte von Cookies, Web-Storage-Einträgen und Consent-Strings werden weder im Klartext noch als Prüfsumme gespeichert; Anfrage- und Antwortinhalte, Formulareingaben und Dateiinhalte werden nicht gespeichert. E-Mail-Adressen aus DNS-Einträgen und `security.txt` werden maskiert.
>
> **[nur bei eingeschalteten Bildschirmfotos]** Der Bericht enthält Bildschirmfotos des Bannerbereichs als Beleg für die Messung: Ausschnitt des ersten Bildschirms vor jeder Interaktion, nur bei eindeutig abgrenzbarem Bannerbereich bis zur Hälfte des Viewports, Desktop- und Mobilansicht. ⚠ Formulierung nach Bewertung von § 51 UrhG durch die Rechtsabteilung des Auftraggebers (Frage 11).
>
> **[nur bei Banner nicht erkannt]** Das Einwilligungsbanner konnte keinem unterstützten Anbieter zugeordnet werden. Prüfungen, die von der Erkennung abhängen ({affectedChecks}), wurden nicht ausgewertet. Ein nicht erkanntes Banner ist nicht gleichbedeutend mit einem fehlenden Banner.
>
> **[nur bei `SCAN-GEO` oder `SCAN-BOTMODE`]** Das Einwilligungsbanner hat den Scan als automatisierten Zugriff oder als Zugriff von außerhalb seiner Zielregion behandelt. Die betroffenen Prüfungen ({affectedChecks}) wurden als nicht auswertbar eingestuft; das Verhalten der Website gegenüber Besuchern kann abweichen.
>
> **[nur bei `egress.region: unknown` und aktiven CONSENT-Prüfungen]** Die Region, aus der der Scan durchgeführt wurde, ist nicht bekannt. Websites können ihr Verhalten nach der Region des Besuchers steuern; Beobachtungen zu Einwilligungsbannern gelten daher nur für die tatsächliche Messumgebung.
>
> **[nur bei `--assume-region` oder `--proxy`]** Die Egress-Region „{egressRegion}“ beruht auf einer Nutzerangabe und wurde vom Scanner nicht geprüft.
>
> **[nur bei `--sandbox off`]** Der Browser wurde ohne Prozess-Sandbox ausgeführt. Dies betrifft die Isolation der Messumgebung, nicht die Ergebnisse.
>
> **[nur bei `scan.status: partial` oder `failed`]** Der Scan wurde nicht vollständig durchgeführt ({exitReasons}). Nicht abgeschlossene Prüfungen sind im Abschnitt „Prüfungen“ mit Status gekennzeichnet; bereits erhobene Beobachtungen bleiben erhalten.
>
> **[nur bei Textentwurf]** Die Texte dieses Berichts sind Entwürfe und werden derzeit durch den Auftraggeber geprüft („Textentwurf — Prüfung durch Auftraggeber ausstehend“).
>
> **[nur bei `--network-attribution`, nach dem Release]** Angaben zum Standort von Servern beruhen auf der GeoIP-Datenbank {geoipDb} (Stand {geoipDate}; IP Geolocation by DB-IP). Der Serverstandort erlaubt keinen Rückschluss auf den Ort der Datenverarbeitung oder auf das Vorliegen eines Übermittlungsinstruments nach Art. 44 ff. DSGVO.
>
> **Nutzung und Haftung.** `dsgvo-check` ist für die Prüfung eigener oder im Auftrag betreuter Websites bestimmt. Berichte über Websites Dritter sind nicht zur Veröffentlichung vorgesehen. Die Software wird unter der Apache License 2.0 ohne Gewährleistung bereitgestellt (Abschnitte 7 und 8 der Lizenz); nach deutschem Recht bleibt eine Haftung für Vorsatz und grobe Fahrlässigkeit unberührt. Die interne Kennzeichnung des Auftraggebers (`crmCode`) ist nur im maschinenlesbaren Bericht enthalten und stellt keine rechtliche Einordnung dar.

Что проверяет L0 на дисклеймере: ни одного слова из раздела 2 (кроме цитаты § 19 TDDDG, если она появится), все плейсхолдеры определены в схеме, каждый условный абзац привязан к полю отчёта (`scan.options.screenshots`, `diagnostics[]`, `scan.environment.egress`, `scan.status`, `texts.draft`), тест рендера для каждого условия в обоих состояниях.

Английская версия дисклеймера выходит только вычитанной; до этого `--lang en` недоступен.

**Nutzungshinweise** (README проекта и `--help`, draft; [архитектура](../02-architecture.md) §7.6):

> `dsgvo-check` ist für die Prüfung eigener oder im Auftrag betreuter Websites bestimmt; Berichte über Websites Dritter sind nicht zur Veröffentlichung vorgesehen. HTTP-Anfragen des Scanners tragen den User-Agent `dsgvo-check/{version} (+https://github.com/{org}/{repo}; passive DSGVO/security check)`; der Browser meldet sich als Chrome mit demselben Token. TLS-Verbindungsaufbauten (TLS-02, TLS-04) und DNS-Abfragen tragen keinen User-Agent. Phase C übermittelt die IP-Adresse des prüfenden Rechners an die Drittanbieter, deren Ressourcen die Website nach der Annahme im Banner lädt. Mit `--proxy` laufen DNS-Abfragen direkt über den Resolver, nicht über den Proxy.

`{org}` и `{repo}` не содержат `bot`, `crawler`, `spider`, `robot` (Borlabs ловит `bot` в UA); L0 проверяет подставленные значения.

---

## 7. Блок «Rechtlicher Kontext (Stand …)»

Блок — часть HTML и PDF (раздел после дисклеймера) и поле `legalContext` в JSON. Источник — статический файл `test/data/legal/context.yaml` (у каждой записи `id`, `status`, `statusDate`, `verifiedAt`, `reviewBy`, `source`), версионируется вместе с пакетом; смена записи — data-релиз без правки кода. Назначение — показать читателю, в каких правовых рамках сделаны статические `legalNote`, и явно назвать подвижные точки. Блок никогда не влияет на уровень находок и не упоминает проверяемый сайт.

Заголовок: «Rechtlicher Kontext (Stand {rechtsstand}; Regelwerk {rulesetVersion}; zuletzt geprüft {verifiedAt})».

| `id` | Что выводим (de, draft) | `status` на 30.10.2026 | Что меняет, если изменится | ⚠ |
|---|---|---|---|---|
| `tdddg-ddg` | «Das Telekommunikation-Digitale-Dienste-Datenschutz-Gesetz (TDDDG, vormals TTDSG) und das Digitale-Dienste-Gesetz (DDG, vormals TMG) gelten seit dem 14.05.2024. Dieser Bericht verwendet die aktuellen Bezeichnungen.» | `in-force` | Словарь LEGAL-02 (`validFrom`) | URL нормы на gesetze-im-internet.de — ⚠ (путь `ttdsg/`) |
| `einwv` | «Die Einwilligungsverwaltungsverordnung (EinwV, § 26 TDDDG) ist seit dem 01.04.2025 in Kraft. Anerkannte Einwilligungsverwaltungsdienste werden von diesem Scanner nicht ausgewertet; ihr Einsatz ist freiwillig.» | `in-force` | Если сайт использует PIMS-сигнал, CONSENT-03 может быть ложным — ограничение названо | Первый признанный сервис (17.10.2025) ⚠ |
| `dsk-oh` | «Die Orientierungshilfe der Datenschutzkonferenz für Anbieter:innen von digitalen Diensten liegt in Version 1.2 (Stand November 2024) vor; die Randnummern in den Rechtshinweisen beziehen sich auf diese Fassung.» | `current` | Новая версия → перепроверка всех Rn. в `legalNote` | Rn. 121, 124–125, 134–137 — ⚠ до чтения PDF |
| `eprivacy-vo` | «Der Entwurf einer ePrivacy-Verordnung wurde zurückgezogen (Amtsblatt vom 06.10.2025, C/2025/5423). Maßgeblich bleiben die Richtlinie 2002/58/EG und § 25 TDDDG.» | `withdrawn` | — | — |
| `digital-omnibus` | «Die Europäische Kommission hat am 19.11.2025 Änderungen der Regeln für den Zugriff auf Endeinrichtungen vorgeschlagen (Digital Omnibus). Der Rat hat am 21.10.2026 ein Verhandlungsmandat beschlossen (ST 14756/26); das Europäische Parlament hat noch keine Position angenommen. Geltendes Recht ist unverändert.» | `proposal` | Возможные einwilligungsfreie Zwecke (агрегированная Reichweitenmessung) → профиль ruleset по дате; «Ablehnen mit einem Klick» как прямая норма | Содержание мандата — по вторичным источникам ⚠ |
| `eu-us-dpf` | «Der Angemessenheitsbeschluss (EU) 2023/1795 (EU-US Data Privacy Framework) ist in Kraft. Das Gericht der EU hat die Klage T-553/23 am 03.09.2025 abgewiesen; das Rechtsmittel C-703/25 P (eingelegt am 31.10.2025) ist beim Gerichtshof anhängig. Angaben zur DPF-Liste in diesem Bericht geben den Stand am genannten Prüfdatum wieder und beziehen sich auf Organisationen, nicht auf einzelne Dienste.» | `in-force-contested` | Отмена → `dpfEntity.listed` теряет смысл, тексты об организации и DPF меняются одним data-релизом; на уровень не влияет | Письмо EDPB 31.07.2026 после *Trump v. Slaughter* (29.06.2026) — вторичные источники ⚠, в блок не выводится до первоисточника |
| `uk-adequacy` | «Die Angemessenheitsbeschlüsse für das Vereinigte Königreich wurden am 19.12.2025 bis zum 27.12.2031 verlängert.» | `in-force` | `adequacy.json` (`country-adequacy`) | — |
| `recaptcha-role` | «Google bietet reCAPTCHA seit dem 02.04.2026 unter Auftragsverarbeitungsbedingungen an. Welcher Vertragsstand für eine konkrete Website gilt, ist technisch nicht erkennbar.» | `changed` | Тексты PRIV-02 `wording-to-review`, EMBED-04 `captcha-with-form` | — |
| `bsi-tr-02102-2` | «Die Technische Richtlinie BSI TR-02102-2 (Version 2026-01) empfiehlt TLS 1.2 und 1.3; TLS 1.0 und 1.1 werden nicht empfohlen (siehe auch RFC 8996).» | `current` | Пороги TLS-04 в ruleset (`source: TR-02102-2@2026-01`) | — |
| `bsi-tr-03182` | «Die Technische Richtlinie BSI TR-03182 beschreibt SPF, DKIM und DMARC als Stand der Technik für E-Mail-Authentizität; SoftFail (`~all`) ist bei wirksamer DMARC-Richtlinie zulässig.» | `current` | Матрица MAIL-02 | — |
| `rfc-9989` | «RFC 9989 (DMARCbis, Mai 2026) ersetzt RFC 7489 und RFC 9091; die Prüfung MAIL-01 folgt dem Tree-Walk-Verfahren, das Tag `pct` ist entfallen.» | `current` | Алгоритм MAIL-01, вариант `legacy-pct` | — |
| `cisa-kev` | «Der CISA-Katalog „Known Exploited Vulnerabilities“ (Katalogversion {kevVersion}) dient der Priorisierung und ist keine Rechtsnorm.» | `dataset` | Правило `critical` VULN | Версия из `datasets[]` (на 30.10.2026: 2026.10.29) |

Правила блока:

1. Каждая запись выводится одним абзацем, без оценочных слов; статус отображается словами: `in-force` → «in Kraft», `in-force-contested` → «in Kraft, Rechtsmittel anhängig», `proposal` → «Vorschlag, nicht geltendes Recht», `withdrawn` → «zurückgezogen», `changed` → «geändert zum {statusDate}», `current` → «aktuelle Fassung», `dataset` → «Datenbestand».
2. Факты, подтверждённые только вторичными источниками (письмо EDPB, содержание мандата Совета), в блок не выводятся, пока не прочитан первоисточник; они живут в `context.yaml` с `verifiedAt: null` и видны только разработке.
3. `reviewBy` для `proposal` и `in-force-contested` — 3 месяца, для остальных — 12; CI предупреждает о просрочке.
4. Блок не содержит слов «Drittland», «Übermittlung», «unzulässig» и названий сервисов проверяемого сайта.

---

## 8. Чек-лист вычитки для заказчика

Вычитка идёт по PR в `test/data/texts/de.yaml`, `test/data/legal/**` и `test/data/ruleset/de-2026.yaml`; одна проверка — один PR. Снятие `draft: true` — отдельный коммит заказчика. Пункты с ☐ отмечает рецензент в описании PR.

**A. Для каждого ключа `checkId.variant`**

- ☐ Ключ есть в реестре [спецификации проверок](../03-checks.md) §2.1; исход без находки оформлен как `reason.<id>` или `limitation.<id>` (5.20), а не как вариант.
- ☐ Titel ≤ 70 знаков, без глаголов оценки, называет объект (сервис, запись, заголовок), а не вывод.
- ☐ Beschreibung отвечает на «was / wo / wann / in welchem Zustand / laut welcher Datenbank / mit welcher Konfidenz» и содержит «auf {n} von {m} geprüften Seiten» или URL.
- ☐ Фаза названа словами из 3.1; «ohne Einwilligung» отсутствует.
- ☐ Состояние запроса (`delivery`, `result`, `provenance`) или записи (`angenommen / abgelehnt / versucht`) различимо в тексте — «gesendet» только при `delivery: sent`, «Antwort erhalten» только при `result: response`.
- ☐ Ни одного слова из таблицы раздела 2 вне allowlist; L0-lint зелёный.
- ☐ Граница измерения названа: что «nicht bewertet / nicht geprüft / nicht feststellbar».
- ☐ Hinweis технический, без «Sie müssen», ≤ 400 знаков; для `info`-вариантов с ручной оценкой начинается с «Manuelle Bewertung erforderlich:».
- ☐ Плейсхолдеры совпадают с `params` в схеме; ICU `plural` для счётных величин; `en` имеет тот же набор плейсхолдеров.
- ☐ Значения cookies, Consent-Strings, адреса `mailto:`, имена из Impressum и тела ответов в тексте не появляются.
- ☐ Текст уровня `critical` соответствует условию уровня в [спецификации проверок](../03-checks.md) и не описывает ситуацию ниже уровня.

**B. Для каждого `legalNote`**

- ☐ Один текст на `checkId`; ни одной ссылки на проверяемый сайт, ни одного «Sie».
- ☐ Нормы названы в актуальной редакции (TDDDG, DDG, MStV); у каждого решения — суд, Az., дата, инстанция.
- ☐ `status` из словаря раздела 4 выбран по основному варианту `critical`; расхождения — в абзаце «Umstritten ist …».
- ☐ Все непроверенные факты с пометкой ⚠ (DSK Rn., Rechtskraft OLG Köln 6 U 80/23, Berufung VG Hannover, EDPB 05/2020 Rn. 86, EDPB TF Type C) либо подтверждены первоисточником, либо оставлены с пометкой и без цитирования деталей.
- ☐ `reviewedAt` и `reviewBy` заполнены.

**C. Дисклеймер и Rechtlicher Kontext**

- ☐ Каждый условный абзац привязан к полю отчёта; тест рендера в обоих состояниях.
- ☐ Абзац о скриншотах согласован с оценкой § 51 UrhG; при отрицательном ответе скриншоты переводятся в opt-in одним флагом, абзац остаётся условным.
- ☐ Записи `context.yaml` с `verifiedAt: null` не рендерятся.
- ☐ Формулировка о DPF не содержит «sicher», «ausreichend», «unzulässig»; дата проверки списка выводится.
- ☐ Абзац «Nutzung und Haftung» согласован с юристом заказчика по RDG, CRA и PLD; при изменении статуса проекта правится только этот абзац.

**D. Процесс**

- ☐ Лицензия текстов зафиксирована (рекомендация: CC BY 4.0 для `test/data/texts` и `test/data/legal`); в шапке файлов — `license:` и `owner: customer-legal`.
- ☐ Стоп-листы `de` и `en` вычитаны вместе с текстами; каждое исключение allowlist имеет `reason`.
- ☐ После снятия `draft: true` у всех `de`-ключей релизного manifest L0-тест «release-ready texts» зелёный; `en` либо полностью вычитан, либо `--lang en` остаётся отключённым.
- ☐ Канарейка (10 сайтов с письменным согласием) прогнана с финальными текстами; отчёты не публикуются.

---

## Открытые вопросы

Открытые решения, которые помечены как **предложение автора, не согласовано**:

1. **Поля сообщения.** Поля `title`, `description` и `hint` (Hinweis zur manuellen Prüfung; поля «remediation» нет) и раздел `legalNotes` в `test/data/texts/{de,en}.yaml` взяты из [архитектуры](../02-architecture.md) §11.4 и §13.4. Там это предложение автора архитектуры, не согласовано (ОВ-2): контракт фиксирует только `messageId` + `params` и `legalNoteId`, а отрендеренные тексты в контракт `findings[]` не входят (§11.4). Для текстов важно одно: поле рекомендации нейтрально («Hinweis»), а не «remediation».
2. **Реестр вариантов.** Реестр `checkId.variant` существует — [спецификация проверок](../03-checks.md) §2.1, канон для ruleset, текстов и CRM-маппинга. Раздел 5 ему следует: у каждого варианта реестра есть ключ, лишних ключей нет, исходы без находки вынесены в 5.20 как `reason.<id>` / `limitation.<id>`. Неутверждённые имена вариантов — предложение автора 03-checks (её Q6, Q10); при их переименовании guide переименовывает ключи вслед. Открытое расхождение с реестром одно — `reason` CONSENT-05 при недоступном захвате pagehide; оно описано в блоке «Расхождения с реестром 03-checks» в начале раздела 5 и закрывается правкой 03-checks.
3. **Ключи `reason.<id>` / `limitation.<id>` и ветки их `select`** (5.20) — предложение автора, не согласовано (так же помечено в 03-checks §2.1 и Q6). Ids берутся из реестра §2.1; набор открыт.
4. **Режимы lint `block / label / quote`**, ограничение правил областью поля (№ 13 — `hint`), allowlist ключей для «gesendet» (№ 15) и формат allowlist с `reason` — предложение автора; обязателен только L0-lint стоп-слов для `de` и `en` с явными исключениями. Имя файла стоп-листа (предложение: `test/data/texts/stoplist.{de,en}.yaml`) — за архитектурой.
5. **Сроки `reviewBy`** (6/12 месяцев для `legalNote`, 3/12 для `context.yaml`) — предложение автора; контракт фиксирует только наличие поля и предупреждение CI при просрочке.
6. **Назначение `status` по проверкам** (таблица в разделе 4) — черновик автора на основе правовой карты; утверждает DSGVO-эксперт заказчика вместе с `legalNote`.
7. **Словарь статусов `context.yaml`** (`in-force`, `in-force-contested`, `proposal`, `withdrawn`, `changed`, `current`, `dataset`) и правило «вторичные источники не рендерятся» — предложение автора.
8. **Лимиты длины** (Titel ≤ 70, Hinweis ≤ 400 знаков) — предложение автора для L0-lint.

Вопросы к заказчику, от которых зависят тексты: смысл `critical` и формулировка легенды уровней; UA и абзац Nutzungshinweise о браузере; `crmCode` для EMBED-03, CONSENT-06, TRACK-01 (на тексты не влияет, но определяет `null`); `{org}/{repo}` в UA и Nutzungshinweise; подпись ruleset для текстов `critical`-вариантов; авторство и сроки финальных `de`, лицензия и судьба `en`; скриншоты и § 51 UrhG для условного абзаца дисклеймера; egress и «Region laut Nutzerangabe» в CONSENT-03; стандарт описания сервисов для формулировок PRIV-01 `not-named` и `category-only`; RDG/CRA/PLD и абзац «Nutzung und Haftung»; generic-селекторы DKIM и текст `MAIL-03.selectors-not-found`.

Факты с пометкой ⚠, которые нужно закрыть до снятия `draft`: DSK OH v1.2 Rn. 121, 124–125, 134–137; Rechtskraft OLG Köln 6 U 80/23, Berufung VG Hannover 10 A 5385/22 и деталь о GTM; EDPB Guidelines 05/2020 Rn. 86; EDPB Cookie Banner TF Type C; UrhG § 51 для скриншотов; URL TDDDG на gesetze-im-internet.de; EinwV «Consenter».
