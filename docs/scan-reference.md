# Scan-Referenz

Diese Seite beschreibt das Verhalten des Prototyps im Detail.
Für den Einstieg siehe [README](../README.md), für Code und Datenflüsse [Architektur](architecture.md).

- [Optionen](#optionen) · [Einstellungen](#einstellungen) · [Exit-Gründe](#exit-gründe)
- [Seitenauswahl](#seiten-in-phase-a) · [Ablauf pro Seite](#auf-jeder-seite) · [Kontrollseiten](#kontrollseiten-in-phase-b-und-c)
- [Abbruch](#abbruch-und-fehlende-phasen) · [Zertifikatfehler](#abgelehntes-zertifikat-der-ziel-url)
- [Banner und CMP](#banner) · [Ablehnen über Einstellungen](#ablehnen-über-die-einstellungen) · [Klick bestätigen](#klick-bestätigen)
- [Gespeicherte Daten](#keine-werte) · [Abdeckung](#abdeckung) · [Netzwerkgrenze](#netzwerkgrenze-ssrf)
- [Einzelne Prüfungen](#einzelne-prüfungen)

## Optionen

`dsgvo-check --help` zeigt alle Optionen für den Standardbefehl Scan. Hilfe zu den Unterbefehlen geben
`dsgvo-check report --help` und `dsgvo-check install --help`.

| Option | Standard | Bedeutung |
| --- | --- | --- |
| `--fail-on critical\|warning\|none` | `critical` | Schwelle für Exit-Code 1 |
| `--format <liste>` | `console,json` | Ausgabeformate: `console`, `json`, `html`, `summary`, `pdf` (PDF nur ausdrücklich) |
| `--out <dir>` | `./dsgvo-check-report` | Ausgabeverzeichnis |
| `--max-pages <n>` | `6` | Seiten in Phase A |
| `--timeout <dauer>` | `8m` | Globales Zeitlimit, z. B. `8m` oder `90s` |
| `--assume-region eea\|de` | nicht gesetzt | Standort des Scanners laut Nutzerangabe |
| `--proxy <url>` | kein Proxy | HTTP-Proxy (nur `http://`, CONNECT) für Browser, HTTP und TLS; DNS läuft direkt |
| `--strict` | aus | Nicht eindeutige Ergebnisse, `--sandbox off` und ungeprüfte Region führen zu Exit-Code 2 |
| `--sandbox require\|off\|container` | `require` (Image: `container`) | Chromium-Sandbox; `off` nur bewusst, im Bericht als `SCAN-SANDBOX-OFF` vermerkt; `container` nur im Docker-Image |
| `--no-screenshots` | aus | Deaktiviert die Anforderung eines Bannerbilds. Die Aufnahme ist derzeit ausgesetzt. |
| `--save-snapshot <file>` | – | Rohdaten speichern |
| `--from-snapshot <file>` | – | Snapshot ohne Netz neu auswerten (die URL entfällt) |
| `--checks <ids>` | alle | Nur diese Prüfungen, z. B. `EMBED-01,HDR-01` |
| `--lang de\|en` | `de` | Sprache des Berichts |
| `--detail full\|brief` | `full` | HTML und PDF: `full` mit Belegen für Entwickler, `brief` kurz, mit Handlungsempfehlungen für Betreiber |
| `--verbose` | aus | Ausführliche Logs auf stderr |

## Einstellungen

Der Scanner läuft ohne Konfiguration. Schwellen, Zeitlimits und Grenzen lassen sich über Umgebungsvariablen der Form
`DSGVO_CHECK_<ABSCHNITT>_<NAME>` ändern, etwa `DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS` oder
`DSGVO_CHECK_TLS_EXPIRING_DAYS`. Die Einheit steht im Namen: `_MS` Millisekunden, `_BYTES` Bytes, `_DAYS` Tage, `_PX`
CSS-Pixel, `_BITS` Bit.

- **Alle Einstellungen** mit Standardwert und Beschreibung: [.env.example](../.env.example).
- **`.env`:** nicht nötig; liegt im aktuellen Verzeichnis eine, wird sie gelesen. Nur `DSGVO_CHECK_*` zählt; andere
  Einträge bleiben unberührt und gelangen nicht in die Umgebung von Chromium.
- **Vorrang:** Flag, Umgebungsvariable, `.env`, Standardwert. `.env` überschreibt keine gesetzte Umgebungsvariable.
- **Ungültige Werte** enden mit Exit-Code 2 (`invalid-config`) und nennen Variable, Quelle und Grund in der Sprache
  von `--lang`.
- **Abweichungen** von den Standardwerten stehen im Bericht unter „Abweichende Einstellungen“ (ohne Proxy-URL).
- **Docker und Action.** Die GitHub Action reicht `HOME` und `NO_COLOR` an den Container durch. Bei einem eigenen
  `docker run` kannst du Einstellungen mit `--env` oder `--env-file` übergeben.

```sh
mkdir -p dsgvo-check-report
docker run --rm --env HOME=/tmp --env DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS=3000 \
  --env-file scan.env --user "$(id -u):$(id -g)" \
  -v "$PWD/dsgvo-check-report:/out" \
  dsgvo-check:dev https://www.example.de/ --out /out
```

Drei Werte lassen sich nur verlängern, damit der Scanner höflich bleibt:

| Variable | Mindestwert | Bedeutung |
| --- | --- | --- |
| `DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS` | 1500 | Pause zwischen zwei Navigationen |
| `DSGVO_CHECK_BROWSER_RETRY_DELAY_MS` | 3000 | Pause vor dem einen Wiederholungsversuch nach 429 oder 5xx |
| `DSGVO_CHECK_HTTP_MIN_INTERVAL_MS` | 500 | Abstand zwischen zwei Anfragen an denselben Host |

## Exit-Gründe

| Code | Bedeutung |
| --- | --- |
| `0` | Kein Befund erreicht die Schwelle `--fail-on`. |
| `1` | Mindestens ein Befund erreicht die Schwelle, auch wenn andere Prüfungen fehlschlugen. |
| `2` | Scan nicht durchgeführt, eine für die Schwelle relevante Prüfung fehlgeschlagen oder ein `--strict`-Grund. |

- **Vorrang:** Scan nicht durchgeführt (`2`) vor Befund (`1`) vor Prüfungsfehler oder `--strict` (`2`) vor `0`.
- Ließ sich ein angeforderter Bericht nicht schreiben (`report-write-failed`), gilt `2`, auch bei einem Befund.
- `check-error` und die `strict`-Gründe ergeben nur ohne `threshold` Exit-Code `2`; sonst gilt `1`.
- Mit `--fail-on none` entfallen `threshold` und `check-error`; `--strict` wirkt davon unabhängig.
- Ein Fehler bei der optionalen PDF-Ausgabe ändert den Exit-Code nicht.

Alle zutreffenden Gründe stehen in `report.json` unter `summary.exitReasons`, nicht nur der entscheidende:

| Grund | Bedeutung | Exit |
| --- | --- | --- |
| `threshold` | Ein Befund erreicht `--fail-on`. | 1 |
| `unreachable` | Ziel nicht erreichbar (DNS, Verbindung, Zeitüberschreitung oder 5xx der Startseite). | 2 |
| `blocked` | WAF, Challenge oder 403 auf der Startseite. | 2 |
| `timeout` | Globales Zeitlimit vor Ende von Phase A der Startseite, oder eine relevante Prüfung wurde dadurch abgebrochen. | 2 |
| `sandbox-unavailable` | Die Chromium-Sandbox startete nicht (`--sandbox require`). | 2 |
| `invalid-input` | Ungültige Argumente, Einstellungen oder URL; Zieladresse nicht öffentlich; Browser fehlt. | 2 |
| `internal-error` | Interner Fehler, Abbruch durch SIGINT/SIGTERM oder Watchdog. | 2 |
| `report-write-failed` | Ein angeforderter Bericht ließ sich nicht schreiben; bereits geschriebene Dateien bleiben. | 2 |
| `check-error:<ID>` | Eine relevante Prüfung endete mit Status `error`. | 2 |
| `strict:inconclusive:<ID>` | Nur mit `--strict`: Eine relevante Prüfung war nicht eindeutig. | 2 |
| `strict:sandbox-off` | Nur mit `--strict`: `--sandbox off`. | 2 |
| `strict:egress-unverified` | Nur mit `--strict`: Standort ungeprüft (kein `--assume-region`) bei aktiven CONSENT-Prüfungen. | 2 |

## Browserablauf

Phasen und Ablauf im Überblick stehen im [README](../README.md#how-a-scan-works).
Die folgenden Abschnitte beschreiben Seitenauswahl, Abbrüche und Details der Bannererkennung.

### Seiten in Phase A

- **Budget:** `--max-pages` (Standard 6) begrenzt die Seitenzahl in Phase A. Die weiteren Seiten bekommen, was nach
  Startseite, Impressum, Datenschutzerklärung, Kontakt- und Zwischenseiten übrig bleibt, beim Standard also 2. Eine
  gemeinsame Seite für Impressum und Datenschutzerklärung zählt einmal.
- **Rechtstexte** werden unabhängig vom Budget besucht. Fehlt der Link, probiert der Scanner `/impressum` und
  `/datenschutz`; diese Aufrufe zählen an Stelle der verlinkten Seite.
- **Weitere Seiten** kommen aus den Links der Startseite: zuerst je Gruppe von Stichwörtern höchstens eine Seite, in
  dieser Reihenfolge: Video, Anfahrt und Standort, Geschichte, Über uns, Team, Karriere, Referenzen, Termin, Blog und
  News, Newsletter, Shop, Galerie, Leistungen und Produkte (Liste: `test/data/browser/pages.yaml`). Zwei Seiten
  desselben Bereichs (`/unternehmen/geschichte`, `/unternehmen/team`) dürfen aus verschiedenen Gruppen kommen. Reicht
  das nicht, folgen Links der Navigation und Einträge der Sitemap, je URL-Bereich eine Seite.
- **Andere Sprachversionen** sind nie weitere Seiten: ein anderes Sprachpräfix als das der Startseite (`/en/` neben
  `/de/`), ein Sprachumschalter („EN“, „English“, eine Flagge ohne Text auf `/en/`), ein `hreflang` einer anderen
  Sprache.
- **Das eigene Sprachpräfix** zählt nicht als Bereich: Auf einer Startseite `/de/` bleiben `/de/kontakt/anfahrt/` und
  `/de/unternehmen/geschichte/` wählbar, ebenso auf einer Startseite ohne Präfix mit `lang="de"`, deren Umschalter
  „DE“ nach `/de/` führt.
- **Links auf Rechtstexte:** Die Sprache der Startseite geht vor; eine andere Sprachversion wird nur gewählt, wenn die
  Website keine andere verlinkt.

Weitere Datenschutzhinweise:

- Verlinkt die Seite mit dem Link auf die Datenschutzerklärung weitere Datenschutzhinweise der Website (etwa
  „Datenschutz Kurse“ oder „Datenschutzhinweise Bewerbung“ im Seitenfuß), liest der Scanner danach bis zu einen davon
  (`DSGVO_CHECK_BROWSER_MAX_SUPPLEMENTARY_POLICIES`, 0 bis 3), den am besten passenden Link zuerst.
- Es zählt nur ein Link, dessen Text ein Datenschutzwort ist oder damit beginnt und der nicht im Inhaltsbereich oder
  einer Seitenleiste steht: Ein Artikel über Datenschutz ist kein Hinweis der Website.
- Diese Aufrufe zählen wie die Rechtstexte nicht gegen `--max-pages`, halten aber die Pause zwischen Navigationen und
  das Zeitbudget ein.
- Andere Sprachversionen der Datenschutzerklärung (`/en/datenschutz/` hinter „EN“) werden nur vermerkt, nicht
  aufgerufen, auch wenn die Seite der eigenen Sprache nicht als Datenschutzerklärung bestätigt wurde.
- Links auf Einstellungsdialoge („Datenschutz-Einstellungen“) bleiben unberührt.

Fehlt der Link auf das Impressum, liest der Scanner die ohnehin geöffneten Seiten mit: Startseite, Kontaktseite und
Zwischenseiten wie „Über uns“. Dafür gibt es keine zusätzlichen Seitenaufrufe.

- Weisen die Überschriften im Inhalt einer Kontakt- oder Zwischenseite sie als Impressum aus, gilt das Impressum als
  über diese Seite gefunden.
- Sonst bleibt ihr Text für LEGAL-01, das darin nach Angaben eines Impressums sucht (Registereintrag, USt-IdNr.,
  Vertretungsberechtigte, § 5 DDG, § 18 Abs. 2 MStV).

### Auf jeder Seite

- **Wartezeit:** Jede Seite bleibt mindestens 6 s (Phase A) bzw. 4 s (B und C) offen, bis der Netzverkehr ruhig ist;
  Obergrenzen 20 s bzw. 12 s.
- **Erster Bildschirm zuerst:** Banner, Links und Rechtstexte werden festgestellt, bevor das Fenster
  vergrößert wird.
- **Unterhalb des ersten Bildschirms:** Danach vergrößert der Scanner das Fenster auf die Höhe der Seite, höchstens auf
  10 000 Pixel (`DSGVO_CHECK_BROWSER_REVEAL_MAX_HEIGHT_PX`), wartet bis zu 3 s auf ruhigen Netzverkehr
  (`DSGVO_CHECK_BROWSER_REVEAL_DWELL_MS`, 0 schaltet das ab) und stellt das Fenster vor der nächsten Navigation zurück.
  So laden Karten, Videos und andere Inhalte wie bei einem Besucher, der nach unten scrollt.
- **Gescrollt wird nicht:** Die Seite erhält kein Scroll-, Maus- oder Tastaturereignis. Phase A bleibt ohne
  Interaktion, und ein Banner, das Scrollen als Einwilligung wertet, wird nicht ausgelöst.
- In B und C geschieht das auf der Startseite erst nach dem Klick (in B auf der neu geladenen Seite), danach auf den
  Kontrollseiten.
- Seiten, die ins Fenster passen, sich nicht scrollen lassen (etwa unter einem blockierenden Banner) oder selbst nach
  unten gescrollt haben, bleiben, wie sie sind.
- Anfragen nach dem Vergrößern tragen in `report.json` `afterReveal: true`.

### Kontrollseiten in Phase B und C

- **Auswahl:** Seiten aus Phase A mit eingebetteten Inhalten: iframes und Platzhalter von Drittanbietern, neue Hosts
  gegenüber der Startseite. Karten, Videos (auch Vorschaubilder), Schriften und Widgets aus dem Dienstekatalog zählen
  mehr als unbekannte Hosts.
- **Nicht gezählt:** iframes von Einwilligungsanbietern und iframes ganz außerhalb der Seite (etwa ein
  4×4-Hilfsframe bei −9999 px).
- **Ursprung:** Seiten auf dem Ursprung der Startseite, auf der B und C klicken, gehen vor, weil ein
  Einwilligungs-Cookie dieses Hosts auf einem anderen Host nicht gilt. Seiten eines anderen Ursprungs kommen nur zum
  Zug, wenn keine Seite des Ursprungs übrig ist, und tragen im Plan den Grund `other-origin`.
- **Gilt die Entscheidung?** Das liest der Scanner auf jeder Kontrollseite am Banner ab. Zeigt es sich erneut oder
  liegt ihm keine Antwort vor (etwa weil das Cookie der Antwort nur für den Host der Startseite gilt und die
  Kontrollseite auf `www` liegt), zählen CONSENT-05 und TRACK-01 die Seite nicht als Seite nach Ablehnung bzw.
  Zustimmung. Was sie sendet oder speichert, gilt dann nicht als Befund nach der Ablehnung, und die Seite gilt nicht als
  ausgewertet (Einschränkung `reject-not-in-effect` bzw. `accept-not-in-effect`, Status `partial`).
- Eine Seite auf einem anderen Host, die die gespeicherte Antwort liest (Cookie für die ganze Domain), zählt.

### Abbruch und fehlende Phasen

- Phase C entfällt, wenn Phase B keinen Adapter erkannt hat.
- B und C entfallen, wenn der Zielhost drosselt (429/503) oder das Zeitbudget erschöpft ist.
- Wird das globale Zeitlimit nach der Startseite erreicht, bleiben die Beobachtungen im Bericht. Nicht ausgeführte
  Phasen gelten als abgeschnitten, Prüfungen ohne Daten enden mit Status `error` (`timeout`).

Sperrt Bot-Schutz eine weitere Seite (`SCAN-BLOCKED`) oder drosselt der Zielhost (`SCAN-THROTTLED`), nennt der Bericht
die Prüfungen, denen dadurch Beobachtungen fehlen:

| Fall | Betroffene Prüfungen |
| --- | --- |
| Gesperrte Seite | die Prüfungen, die Seiten ihrer Art lesen (die Datenschutzerklärung etwa LEGAL-01, LEGAL-02, PRIV-01, PRIV-02) |
| Gesperrte Seite in Phase A | zusätzlich TLS-01, das die Links jeder Seite liest |
| Gesperrtes Impressum | zusätzlich MAIL-01 bis MAIL-03, die die E-Mail-Domains des Impressums abfragen |
| Gesperrte Seite, die Phase A für einen Rechtstext liest | auch dessen Prüfungen: Impressum LEGAL-01, LEGAL-02, MAIL-01 bis MAIL-03; Datenschutzerklärung LEGAL-01, LEGAL-02, PRIV-01, PRIV-02 |
| Drosselung in Phase A | die Browser-Prüfungen, TLS-01 und MAIL-01 bis MAIL-03 |

„Für einen Rechtstext lesen“ meint eine Seite, die beides ist (Datenschutzerklärung und Impressum), und Kontakt- und
Zwischenseiten, solange ein Rechtstext fehlt.

### Abgelehntes Zertifikat der Ziel-URL

Nimmt die TLS-Prüfung das Zertifikat der Ziel-URL nicht als gültig an, ruft der Browser sie nicht auf.

- **Ausweichen:** Leitet die unverschlüsselte Adresse (`http://`, Standardport) auf einen anderen Host weiter und
  wurde jedes Zertifikat auf diesem Weg als gültig angenommen, laufen die Phasen A, B und C dort, mit derselben
  Prüfung der Zertifikate wie sonst. Der Bericht nennt das (`SCAN-TLS-FALLBACK`, in `report.json` unter
  `scan.entry`); TLS-02 meldet weiterhin das Zertifikat der Ziel-URL.
- **Kein Ausweichen:** wenn eine Weiterleitung über ein abgelehntes Zertifikat läuft, `http://` die Seite selbst
  ausliefert oder auf HTTPS desselben Hosts weiterleitet, oder die Ziel-URL einen Port oder eine IP-Adresse nennt.
  Die Browser-Prüfungen entfallen dann; `SCAN-TLS-BLOCKED` nennt den Grund.
- **Ausweichen scheitert:** Liefert der Browser dort keine auswertbare Seite (Challenge, Fehlerstatus, Zeitlimit) oder
  kommt er nicht bis dorthin, entfallen die Browser-Prüfungen wie ohne den Versuch (`tls-fallback-failed`); der Scan
  schlägt deshalb nicht fehl.
- **Bot- oder WAF-Schutz** am Ziel der Weiterleitung nennen Übersicht, `SCAN-TLS-BLOCKED`
  (`fallback: bot-protection`), Konsole und Zusammenfassung mit den Bezeichnungen seiner Signale (etwa
  `header:x-vercel-mitigated`); umgangen wird er nicht. Ein Status 403 allein ist kein solches Signal und bleibt beim
  allgemeinen Text.
- **Hinter `--proxy`** ist das Urteil über die Zertifikate unbekannt; der Browser wechselt dann nicht.
- **Ohne TLS-02** (`--checks`) wird das Zertifikat nicht vorab geprüft: Der Browser ruft die Ziel-URL auf und bricht
  beim Zertifikat ab, ohne Fortsetzung.
- `DSGVO_CHECK_SCAN_TLS_FALLBACK=off` schaltet das Ausweichen ab.

## Banner

Eigene Adapter gibt es für Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner und CookieHub sowie
für die eingebauten Banner von Shopware 6, Wix und der TYPO3-Erweiterung cookieman. Geklickt wird nur über sie.

Die Testnachbildungen zeigen [Cookiebot](images/banner-cookiebot.png) mit direkter Ablehnung,
[Usercentrics](images/banner-usercentrics.png) ohne direkte Ablehnung und den Wix-Pfad von der
[ersten Ebene](images/banner-wix-first-layer.png) zu den [Einstellungen](images/banner-wix-settings.png).

In Phase B versucht der Scanner, eine Ablehnung auszulösen und zu bestätigen.

```mermaid
flowchart TD
    Adapter{"Passender CMP-Adapter?"}
    Adapter -->|Nein| Open["Ablehnung bleibt ungeprüft"]
    Adapter -->|Ja| Reject{"Eindeutige Ablehnung auf der ersten Ebene?"}
    Reject -->|Ja| Click["Ablehnen klicken"]
    Reject -->|Nein| Settings{"Kann der Adapter die Einstellungen öffnen und sicher speichern?"}
    Settings -->|Nein| Open
    Settings -->|Ja| Save["Auswahl speichern"]
    Click --> Verify["Zustand prüfen und nach Neuladen erneut prüfen"]
    Save --> Verify
```

### Banner erkennen

- CONSENT-04 bewertet oberhalb von `info` nur bei Erkennung mit hoher Konfidenz.
- Shopware und Wix gelten nur mit ihrem Banner (oder dem Banner-Skript von Wix) als erkannt, nicht allein durch die
  Kennungen der Plattform.
- Findet der erste passende Container-Selektor eines Adapters nur verborgene Elemente, zählt ein späterer, wenn sein
  Element eine sichtbare Schaltfläche oder einen sichtbaren Link zeigt. Eine verborgene Vorlage verdeckt so nicht den
  offenen Dialog, und ein Rahmen, von dem bei geschlossenem Banner nur der eigene Kasten zu sehen ist, gilt nicht als
  Banner.
- Ein anderes Banner wird nur heuristisch erkannt: CONSENT-04 meldet `info` „Banner nicht erkannt“ (Status
  `inconclusive`), der Scanner klickt nicht.
- Ein Banner zeigt sich auf jeder Seite, bis der Besucher antwortet. Was die Heuristik nur auf einer Unterseite findet
  (ein festes Inhaltsverzeichnis der Datenschutzerklärung, eine eingebettete Datenschutzerklärung), gehört zu dieser
  Seite und ist kein Banner. Es zählt auf der Startseite oder auf mindestens zwei Seiten
  (`DSGVO_CHECK_CMP_MIN_CANDIDATE_PAGES`).
- Was der Besucher nicht sieht (verdeckt, abgeschnitten, durchsichtig oder in einem verborgenen iframe), zählt nicht.

Beobachtet, aber nicht erkannt: Die Heuristik sieht einen bannerähnlichen Kasten mit einem Einwilligungswort (auf der
Seite oder in einem iframe, das auf dem ersten Bildschirm sichtbar ist) und wertet ihn nicht als Banner. Dann schließt
CONSENT-03 nicht auf „kein Einwilligungsbanner“, wenn der Kasten eines davon hat:

- einen Bannernamen;
- eine Ablehnen- oder Annehmen-Schaltfläche;
- ein Cookie-Wort und eine Schaltfläche, die das Lexikon kennt (etwa Einstellungen oder Speichern);
- als fester Kasten oder Dialog ein Cookie-Wort und ein weiteres Einwilligungswort, auch wenn das Lexikon seine
  Schaltflächen nicht lesen kann.

Ein Cookie-Wort zählt nur unverneint („Wir verwenden keine Cookies“ zählt nicht). Ein Kasten im Kopf- oder Fußbereich
der Seite ohne Ablehnen- oder Annehmen-Schaltfläche zählt nicht.

CONSENT-03 bleibt dann `inconclusive`, CONSENT-04 meldet `info` „Banner nicht erkannt“, und die Befundtexte nennen das
Banner „beobachtet, aber nicht erkannt“. Ein bloßes „OK“ oder „Verstanden“ unter einem Versand- oder
Datenschutzhinweis ist keine solche Schaltfläche.

### Ablehnung auf der ersten Ebene

- Bietet ein erkanntes Banner „Zustimmen“, aber keine Ablehnung, meldet CONSENT-04 `critical`: `blocking-no-reject`,
  wenn das Banner die Seite blockiert, sonst `nonblocking-no-reject` (etwa nur „Cookie-Einstellungen“ und
  „Zustimmen“).
- Eine Schließen-Schaltfläche (×) zählt nie als Ablehnen.
- Kennt der Adapter die Einstellungsebene, lehnt der Scanner dort ab (siehe unten); CONSENT-04 bewertet weiter die
  erste Ebene.
- Sonst klickt er im Besuch mit Ablehnung nichts, und CONSENT-05 bleibt `inconclusive`. Wurden die Einstellungen
  geöffnet, aber nicht gespeichert, steht der Grund als Einschränkung dabei.

### Ablehnen über die Einstellungen

Diesen Klickpfad bietet aktuell nur der Wix-Adapter. Er nutzt `settingsLayer` aus `test/data/cmp/adapters.yaml`.

- Voraussetzung: Die erste Ebene eines mit hoher Konfidenz erkannten Banners bietet keine Ablehnung.
- Der Scanner klickt die Einstellungsschaltfläche des Banners und liest in der Einstellungsebene die Schalter der
  Kategorien, auch optisch verborgene. Die erste Ebene, die bei Wix dahinter offen bleibt, liest er dabei nicht.
- Die Speichern-Schaltfläche des Anbieters (bei Wix „Auswahl bestätigen“) klickt er nur, wenn
  - jede Kategorie, die der Besucher umstellen kann, schon ausgeschaltet ist,
  - kein gesperrter Schalter außer dem für die erforderliche Verarbeitung des Anbieters eingeschaltet ist (bei Wix
    einer, `essentialGroups`) und
  - genau eine solche Schaltfläche des Anbieters zu sehen ist.
- Schalter stellt er nie um. Ist eine Kategorie schon eingeschaltet, klickt er nichts mehr (`preselected-groups`).
- Der Zeitpunkt der Ablehnung ist das Speichern: Was lädt, während die Einstellungen offen sind, zählt als vor der
  Ablehnung. Danach folgen wie sonst die Prüfung des Zustands, das Neuladen und die Kontrollseiten.
- Die Befunde nennen die Ablehnung „über die Einstellungen“.

### Schaltflächen einordnen

| Beschriftung | Ablehnen | Annehmen |
| --- | --- | --- |
| Abo- oder Zahlungswörter („abonnieren“, „Pur-Abo“, „bezahlen“) | nie | nie |
| Verneinte oder eingeschränkte Zustimmung („Nicht alle akzeptieren“, „Ich akzeptiere keine Cookies“, „Nur Statistik akzeptieren“) | nur, wenn das Markup des Anbieters sie als Ablehnen ausweist | nie |
| Verneinung der Cookie-Art („Nicht notwendige Cookies ablehnen“) | ja | — |
| Zustimmung zu den nicht notwendigen Cookies („Ich akzeptiere nicht notwendige Cookies“) | nie | — |
| Zustimmung nur zu den notwendigen Cookies, auch ohne „nur“ („Erforderliche Cookies erlauben“, „Accept necessary“) | ja, wenn die Formulierung im Lexikon steht und daneben nur Cookie-, Notwendigkeits- und Hinweiswörter wie „empfohlen“ stehen | nie |
| „Accept necessary and analytics cookies“ | nein | nein |

### Klick bestätigen

- Einen Zustand, den der Klick unverändert ließ (eine schon vorher gespeicherte Antwort), liest das Neuladen nur noch
  einmal: Er bestätigt das Ablehnen bei keinem Banner.
- „Ablehnung nicht bestätigt“ meldet CONSENT-04 nur, wenn der Zustand nach dem Klick keine Antwort zeigt oder eine
  Kategorie erlaubt; sonst bleibt es bei der Einschränkung `reject-unverified` ohne Befund.
- Hat der Scanner im Besuch mit Zustimmung angenommen, obwohl sich der Dialog im Besuch mit Ablehnung nicht öffnete,
  nennt die Übersicht nur die Ablehnung als nicht geprüft.

### Shopware

Shopware vermerkt die Antwort im Cookie `cookie-preference` und die Erlaubnis jedes optionalen Cookies in einem eigenen
Berechtigungs-Cookie. Gelesen werden nur die Namen der Berechtigungs-Cookies von Shopware selbst
(`google-analytics-enabled`, `google-ads-enabled`, `wishlist-enabled`, `youtube-video`, `vimeo-video`; `consentCookies`
in `test/data/cmp/adapters.yaml`), nie Werte.

- **Ablehnen bestätigt:** Erst der Klick hat `cookie-preference` gesetzt, keines der Berechtigungs-Cookies ist
  vorhanden, und beides bleibt nach dem Neuladen so (`cookie:known-flags-absent`).
- **Annehmen bestätigt:** Der Klick hat mindestens eines dieser Cookies gesetzt; die übrigen bietet die Installation
  womöglich nicht an. Da Shopware beim Annehmen zuerst die Cookie-Liste des Shops lädt, wartet der Scanner auf die
  Antwort bis zu `DSGVO_CHECK_CMP_WAIT_MS`.
- **Nicht bestätigt:** Setzt das Ablehnen eines der Berechtigungs-Cookies oder keine Antwort, bleibt CONSENT-05
  `inconclusive` ohne Befund, und CONSENT-04 meldet „Ablehnung nicht bestätigt“ (`warning`).

### CCM19

CCM19 legt seinen Dialog verborgen und mit deaktivierten Bedienelementen in die Seite und öffnet ihn später.

- Ist er auf dem ersten Bildschirm der Phasen B und C nach der Wartezeit auf das Banner (`DSGVO_CHECK_CMP_WAIT_MS`)
  noch so und keine Antwort gespeichert, klickt der Scanner nichts. CONSENT-04 und CONSENT-05 bleiben `inconclusive`
  („Einwilligungsbanner dem Scanner nicht geöffnet“), ohne Befund; ebenso CONSENT-03, wenn vor einer Interaktion
  einwilligungsbedürftige Dienste geladen wurden. Über das, was Besucher sehen, sagt der Bericht dann nichts.
- CCM19 öffnet seinen Dialog nie für einen Browser, den sein eigener Crawler-Test (`isBotBrowser` in seiner `app.js`)
  für einen Bot hält. Der Test erkennt unter anderem das ` (+http` in den Kennungen von Suchmaschinen-Crawlern. Der
  User-Agent des Scanners nennt den Link zum Repository deshalb nach der Beschreibung und ohne `+`, passt nicht darauf,
  und der Dialog öffnet sich dem Scanner wie einem Besucher.
- Bleibt der Dialog geschlossen und passt der User-Agent der Seite auf diesen Test (`dialogBotUserAgent` in
  `test/data/cmp/adapters.yaml`, vom Anbieter übernommen), vermerkt der Scanner ein Bot-Signal. Jede Prüfung, die
  Bot-Signale liest (CONSENT-01 bis CONSENT-05, EMBED-01 bis EMBED-03, PRIV-02), bleibt dann `inconclusive` mit dem
  Grund „Einwilligungsbanner dem Scanner nicht geöffnet: User-Agent passt auf das Crawler-Muster des Banners“
  (`cmp-bot-user-agent`), ohne Befund.
- Übersicht und `SCAN-BOTMODE` nennen den Test und dass ein Besucher mit einem üblichen Browser das Banner womöglich
  sieht. Passt der User-Agent nicht, bleibt es beim Grund „Einwilligungsbanner dem Scanner nicht geöffnet“.
- Der User-Agent ist für jede Website derselbe und wird nur im Abschnitt der Messumgebung gespeichert.

Verhält sich ein Banner wie gegenüber einem Bot oder meldet es einen Standort außerhalb des EWR, werden die betroffenen
Prüfungen `inconclusive`, nicht zu Befunden.

## Grenzen

### Methode

- **Kein Rechtsrat.** Ein Befund ist ein technisches Indiz. Ein leerer Bericht ist keine Freigabe: Er bedeutet nicht,
  dass die Website den Vorgaben entspricht.
- **Nur passiv.** Keine Logins, Formulare oder Umgehung von CAPTCHA, Bot-Schutz und Geo-Sperren. Probes auf offene
  Dateien (`.git`, `.env`, Backups) und Admin-Oberflächen gibt es im Prototyp nicht. Die Option des Nutzers ersetzt
  nicht die Erlaubnis des Website-Betreibers.
- **Messumgebung.** Banner reagieren auf Standort, IP-Reputation und Headless-Merkmale: Ein Scan aus einem
  Rechenzentrum außerhalb der EU kann andere Ergebnisse liefern. Der Prototyp prüft den Standort nicht selbst. Mit
  `--strict` und ohne `--assume-region` endet ein Scan mit CONSENT-Prüfungen daher mit Exit-Code 2
  (`strict:egress-unverified`), sofern kein Befund Exit-Code 1 auslöst.
- **20 implementierte Prüfungen.** Die [geplanten Prüfungen](../README.md#planned-checks) fehlen. Im Berichtsschema sind
  Baseline und Suppressions vorgesehen, die Logik dazu fehlt. Es gibt keine JUnit-Ausgabe und keine SOCKS-Proxys.

### Keine Werte

Werte von Cookies, Web Storage und TC-String landen weder im Bericht noch im Snapshot noch in Logs, auch nicht gehasht.
Der Collector redigiert alles vor dem Schreiben:

| Daten | Gespeichert | Ersetzt durch `[redacted]` oder weggelassen |
| --- | --- | --- |
| Cookies, Web Storage, IndexedDB | Name, Flags, Laufzeit | Wert, immer; Namen siehe unten |
| `Set-Cookie` | Name | Wert und Attribute |
| URLs | Schema, Host, Pfad; Werte erlaubter Query-Parameter in ihrer Form | übrige Query-Werte, Pfadparameter (`;k=v`) und Query-Schlüssel mit Adresse; Zugangsdaten und Fragment fallen weg; `data:`- und `blob:`-URLs bis auf das Schema |
| E-Mail-Adressen, auch `name(at)domain.de` und `name [at] domain.de` | Domain | lokaler Teil |
| Header-Werte | was die Grammatik des Headers erlaubt | alles andere |
| `Server`, `X-Powered-By` und ähnliche | Produkt und Version (`PHP/7.2.34`) | der Wert selbst, Kommentare wie `(Ubuntu)` |
| Text des Einwilligungsbanners | die gefundenen Dienste des Katalogs in der Schreibweise des Katalogs | der Text |
| Markup und Konfiguration des Banners | Namen | Werte, die keine Namen sind |
| Beschriftungen von CMP-Schaltflächen | Wörter | Wörter mit einer Kennung |
| Text von Impressum und Datenschutzerklärung | Text | Cookie- und Storage-Werte des Besuchers |
| Zertifikate | Subject und Issuer, SAN-Einträge `DNS:` mit Hostnamen und `IP Address:` (öffentlich, für alle gleich) | Adressen in Subject und Issuer bis auf die Domain, dort auch Query und Fragment von URLs; andere SAN-Einträge fallen weg; `DNS:`-Namen, die keine Hostnamen sind |
| Temporäres Browserprofil mit den Cookies der Website | — | wird nach jeder Phase entfernt; Reste eines mit SIGKILL beendeten Scans räumt der nächste Scan auf |

#### URLs

- Query-Werte bleiben nur für eine Allowlist von Parametern, die Einstellungen der Website tragen (`QUERY_ALLOWLIST`
  in `src/core/url/url.ts`, etwa `id`, `v`, `hl`, `family`), und nur in der erwarteten Form:

| Parameter | Erlaubte Form |
| --- | --- |
| `id`, `tid` | Tag-ID (`G-…`, `GTM-…`); bei `id` des Meta Pixels auch dessen Nummer |
| `v` | Version |
| `t` | Treffertyp von Universal Analytics |
| `family` | Schriftnamen ohne Kennung; Schriftzahlen bis 1000 hinter `:` oder `@` zählen nicht als Kennung |
| übrige der Liste | Wert ohne Kennung |

- Nie erhalten bleibt ein Wert mit einer Adresse, einer eingebetteten URL oder eigenem Query (`?`, `=`, `&`, `#`).
- Pfadparameter (`;k=v`) folgen derselben Regel wie Query-Parameter; Adressen im Pfad werden maskiert, auch kodiert.
- `mailto:`-Adressen werden bis auf die Domain maskiert, ebenso `name(at)domain.de` und `name [at] domain.de`, auch
  hinter `mailto:`. „(AT) www.example.at“ ist keine Adresse.

#### Header

- Gespeichert werden Schlüsselwörter, bereinigte URLs und Namen ohne Kennung; aufeinanderfolgende unbekannte Einträge
  einer Liste zählen als einer.
- Von `Server`, `X-Powered-By` und ähnlichen Headern bleiben nur Produkt und Version, siehe [HDR-02](#hdr-02).

#### Banner und Seite

- Den Text des Einwilligungsbanners, den PRIV-01 braucht, speichert der Scan nicht: Der Collector durchsucht ihn im
  Speicher nach Namen und Schreibweisen des Dienstekatalogs und behält nur die Treffer. Einwilligungs-IDs, UIDs oder
  TC-Strings, die das Banner neben den Diensten anzeigt, gelangen so in keiner Form in Snapshot, Bericht oder Logs.
- Aus Markup und Konfiguration des Banners übernimmt der Scanner nur Namen. Ids, Klassen und Attributwerte mit Query,
  Adresse, URL, Leerzeichen, unsichtbaren Zeichen (Nullbreitenzeichen, Richtungszeichen), Vollbreitenzeichen wie `＠`
  oder einer Kennung kommen weder in den Klick-Selektor noch in den Snapshot. Dieselbe Regel gilt für kurze Werte der
  Seite außerhalb des Banners (Linkschemata, Skripttypen, Ereignisnamen, Cookie-Pfade).
- Einwilligungskategorien mit Schlüsseln, die keine Namen sind, erscheinen zusammengefasst als `other`, ebenso Werte von
  Anbieter-Einstellungen, die der Anbieter nicht kennt (etwa eine Complianz-Region).
- Eine CMP-Version bleibt nur aus zwei bis vier Zahlengruppen mit höchstens fünf Ziffern je Gruppe und zusammen weniger
  als acht Ziffern erhalten.
- Cookie- und Storage-Namen der CMP-Erkennung zählen nur als Namen ohne `=` und `;`. Enthält ein Name eine Kennung,
  zählt er für die Erkennung und wird als `[redacted]` gespeichert.
- In Beschriftungen von CMP-Schaltflächen wird ein Wort mit Kennung durch `[redacted]` ersetzt
  (`Accept 4f3a9c1d2e7b4a9f` wird zu `Accept [redacted]`), ebenso eine Reihe kurzer Hex- oder Ziffergruppen
  (`4f3a 9c1d 2e7b`), auch in Klammern oder durch Kommas, Semikolons und Striche getrennt. Ein Wort aus Buchstaben
  eines Falls (`DATENSCHUTZEINSTELLUNGEN`) bleibt; das letzte Wort einer an der Grenze abgeschnittenen Beschriftung
  entfällt.

Was als Kennung gilt, hängt davon ab, wer den Wert wählt. Namen aus Markup und Seite (Ids, Klassen, Attribute,
Kategorien) wählt der Anbieter oder die Website; ein Wert mit Kennung ist dort kein Name. Namen von Cookies, Web
Storage und IndexedDB wählt die Website ebenfalls, sie sind für alle Besucher gleich, und Dienstekatalog und Allowlist
erkennen Dienste daran; darin werden nur Kennungen eines Besuchers zu `[redacted]`.

| Form | Macht einen Namen aus der Seite zum Nicht-Namen | Wird in Cookie- und Storage-Namen `[redacted]` |
| --- | --- | --- |
| Ziffern | 6 in Folge oder 8 insgesamt | 10 in Folge oder in Gruppen, verbunden durch `-`, `_`, `:` oder `.` |
| Hex-Folge mit Ziffer und Buchstabe | ab 8 Zeichen; ab 16 Zeichen auch über Punkte, Bindestriche oder unsichtbare Zeichen hinweg | ab 16 Zeichen, auch in Gruppen mit `-`, `_`, `:` oder `.` |
| Base64-Folge | ab 16 Zeichen mit zwei Ziffern und einem Buchstaben | ab 20 Zeichen mit mindestens zwei Ziffern und beiden Schreibweisen, auch Base64url (`V1StGXR8_Z5jdHi6B-myT`) |
| UUID | immer | immer |
| Folge aus Base64-Zeichen und Trennern (`-`, `_`, `.`, `:`, `/`, `+`) | ab 20 Zeichen, wenn ihre Teile keine Wörter sind (siehe unten) | — |

#### Namen aus der Seite

- Mit Ziffer bleibt eine lange Folge ein Name, wenn ihre durch `-`, `_`, `.` und `:` geteilten Teile Wörter sind und
  höchstens ein Teil eine kurze Gruppe aus Buchstaben oder Ziffern ist oder auf sie endet, oder wenn zwei Teile Zahlen
  aus ein bis drei Ziffern sind: `CybotCookiebotBannerCloseButtonE2E`, `ch2-open-settings-btn`, `v:3_blog:100`. Eine
  Version mit Punkten (`v1.2.3`) und ein Teil aus Wörtern mit `/` (`group-hover/item`) zählen als Wörter.
- Ohne Ziffer bleibt sie ein Name, wenn jeder Teil aus camelCase-Wörtern oder einem Wort in Großbuchstaben besteht:
  `CookiebotOnConsentReady`, `sp_choice_type_SAVE_AND_EXIT`. `uHSRxnPAZmKQVeTWyDBcfGJL` und 24 Großbuchstaben in Folge
  sind keine Namen.
- Auch ein echter Name mit einer solchen Folge (`post-123456`, `ConsentBanner2024`) gilt nicht als Name. Der
  Klick-Selektor nutzt dann ein anderes Merkmal oder den Pfad im Dokument.
- Nicht erkannt werden Buchstaben anderer Schriften, die wie lateinische aussehen (ein kyrillisches `с` in einem
  Hex-Hash).
- Die genauen Regeln stehen in `src/core/redaction/page-names.ts` und seinen Tests.

#### Namen von Cookies, Web Storage und IndexedDB

- Beispiel: `rc::[redacted]`. Ein Wort, das an der Kennung klebt, bleibt (`optimizely_data$$oeu[redacted]`).
- Vor einer Base64-Folge bleibt nur ein Präfix aus gewöhnlichen Wörtern; ein zufälliges Präfix geht mit der Kennung.
- Ein erstes Herstellerpräfix aus Buchstaben (`ucData`, `_hjSession`, `_ga`) vor einer einzelnen kürzeren Kennung
  bleibt zusammen mit ihr (`ucData_hxnJq0hMNeT4UY`).
- Kürzere Kennungen wie `_hjSessionUser_1234567` oder `TS01dc4fc6` bleiben.
- Die Namen behalten keine Adresse (auch nicht kodiert oder abgeschnitten) und keinen Query-Wert. Ein lokaler Teil mit
  `@` oder `(at)` und einem Buchstaben oder `[` dahinter (`alice@intranet`) fällt weg; in Schlüsseln von Web Storage
  bleibt eine Version wie `pkg@3.7.1`.
- Ein Cookie-Name, der kein Cookie-Token ist oder eine Adresse enthält (auch ein buchstäbliches `@`, `(at)` oder `[at]`,
  gleich was folgt), wird `[redacted]`; das Cookie zählt weiter. Ein kodiertes `%40` ohne Domain bleibt
  (`AMCV_…%40AdobeOrg`).

#### Besucherwerte in Rechtstexten

Eine Seite kann Cookie-Werte anzeigen (eine Cookie-Erklärung mit der
Einwilligungs-ID, ein Skript, das `document.cookie` ins Impressum schreibt). Der Scanner sucht deshalb die Werte selbst
im Text und ersetzt sie, auch kodiert, durch `[redacted]`:

- aus Cookies und Web Storage Stücke ab acht Zeichen mit Ziffer;
- aus Cookies und aus Feldern von Web Storage, die wie eine Kennung heißen (`uid`, `consentId`, `kundennummer`;
  `clientPhone` und `userAgent` nicht), auch kürzere Kennungen ab sechs Zeichen: sechs oder sieben Ziffern, eine
  Kennungsfolge ohne Ziffer, in Cookies auch 20 Buchstaben und mehr. Gewöhnliche Wörter wie `marketing` bleiben, ebenso
  Registernummer und Telefon aus einem Impressum-Cache in anderen Feldern.
- Nie ersetzt wird die Zeichenfolge ohne Leerzeichen direkt hinter einem Marker für Register- oder Steuernummern
  (`HRB 12345`, `USt-IdNr.: DE123456789`; Liste in `test/data/legal/business-markers.yaml`), auch wenn ein Wert des
  Besuchers gleich lautet. Bei „USt-IdNr.: DE 123 456 789“ ist nur `DE` geschützt.
- Steht in einem Wert ein Hostname der Website, gelten die Labels ihrer registrierbaren Domain nicht als Kennung, damit
  ihre Adressen im Impressum ganz bleiben. Ein bloßes Label in einem Wert (`site=autohaus24online`) wird dagegen
  gesucht.
- Die Suche ist begrenzt: Stücke bis 512 Zeichen, je Wert höchstens 50 lange und 10 kürzere, zusammen höchstens 1 000.

### Abdeckung

- **Nur wenige Seiten.** Phase A sieht die Startseite, die Rechtstexte, die Kontaktseite und so viele weitere Seiten,
  wie `--max-pages` erlaubt; sie stammen aus den Links der Startseite und ihrer Sitemap. Einbettungen auf anderen
  Unterseiten bleiben unbeobachtet.
- **Stichwörter** werden als Wortteile gesucht („Firmengeschichte“ zählt zu Geschichte), daher kann auf Portalen auch
  ein Artikel als weitere Seite gewählt werden.
- **Unterhalb des ersten Bildschirms** zeigt der Scanner eine Seite nur bis 10 000 Pixel Höhe. Was darunter liegt,
  bleibt ungesehen, und EMBED-01, EMBED-02 und EMBED-03 nennen die Einschränkung `reveal-height-capped`. Dasselbe gilt
  für eine Seite, die mit dem größeren Fenster mitwächst (ein Abschnitt in Fensterhöhe, `100vh`), denn ihr unterer Teil
  bleibt dabei unter dem Fenster.
- Inhalte, die erst auf ein Scroll-Ereignis hin nachladen oder in einem eigenen Scrollbereich der Seite liegen, sieht
  der Scanner nicht. Mit `DSGVO_CHECK_BROWSER_REVEAL_DWELL_MS=0` bleibt es beim ersten Bildschirm; der Bericht nennt
  dann die Beobachtungslücke `below-fold-not-revealed`.
- **Nicht ausgewertet:** Datenschutzerklärungen als PDF, aufklappbare Menüs, pagehide-Beacons nach dem Ablehnen.
- **Ältere Snapshots:** Ohne Versionsangaben bleibt HDR-02 `inconclusive`. Ohne die Angabe der Banner-Heuristik zeigt
  derselbe Link eines Containers mit Bannernamen auf zwei Seiten nur, dass das Vorhandensein eines Banners nicht
  feststellbar ist: CONSENT-03 bis CONSENT-05 bleiben `inconclusive`, ohne Befund.

### Grenzen bei Einwilligungsbannern

- Nur die zehn Adapter bedienen ein Banner; andere werden heuristisch erkannt und führen höchstens zu `info`.
- Ein Banner, das den Scanner an seinem User-Agent für einen Bot hält, antwortet ihm anders als einem Besucher. Real
  Cookie Banner mit „Alle akzeptieren für Bots“ nimmt jedes `http` und `check` dafür, also auch Name und Link des
  Scanners. Einwilligung, Ablehnung und eingebettete Dienste bleiben auf solchen Websites `inconclusive` (`bot-mode`,
  bei einem Crawler-Test wie dem von CCM19 `cmp-bot-user-agent`), ohne Befund, und sind manuell zu prüfen.
- Der User-Agent bleibt ehrlich, mit Name und Link zum Repository; `navigator.webdriver` wird nicht verborgen.
- Ein Shopware-Ablehnen bestätigt der Scanner an den Berechtigungs-Cookies von Shopware selbst; die von Plugins kennt
  er nicht, die Bestätigung schließt sie nicht aus.
- Über die Einstellungen lehnt er nur bei Wix ab und nur, wenn dort jede Kategorie schon ausgeschaltet ist.
  Voreingestellte Kategorien schaltet er nicht aus; die Ablehnung bleibt dann ungeprüft.
- Die Selektoren der Wix-Einstellungen sind an einem bereinigten Ausschnitt des Markups des Wix-Banners (Version
  1.871.0, `test/fixtures/cmp/wix/settings-layer.html`) und am eigenen Simulator getestet, der dieses Markup
  nachbildet. Ändert Wix das Markup der Einstellungsebene, klickt der Scanner die Einstellungsschaltfläche, speichert
  aber nichts (`settings-not-opened` oder `settings-groups-unreadable`).

### Einzelne Prüfungen

- [Einwilligung](#nach-dem-ablehnen-consent-05-und-embed) · [Schriften](#embed-01-schriften) · [Videos](#embed-03-videos)
- [Impressum und Datenschutzerklärung](#legal-01) · [Veraltete Bezeichnungen](#legal-02) · [Dienstnamen](#priv-01) · [Aussagen zum Abruf](#priv-02)
- [E-Mail-Domains](#mail-01-bis-mail-03-e-mail-domains) · [DKIM](#mail-03-dkim)
- [Versionsangaben](#hdr-02) · [HTTP-Formulare](#tls-01-formulare-über-http) · [HTTP-Links](#tls-01-http-links)

#### Nach dem Ablehnen: CONSENT-05 und EMBED

- CONSENT-05 bewertet nach dem Ablehnen nur Tracking (Analyse, Werbung, Sitzungsaufzeichnung).
- Schriften, Karten und Videos, die danach weiter laden, melden EMBED-01, EMBED-02 und EMBED-03. Titel und Text sagen,
  ob sie vor der Interaktion, nach dem Ablehnen oder zu beiden Zeitpunkten geladen wurden und ob der Zustand der CMP
  das Ablehnen bestätigt.
- Als „nach bestätigter Ablehnung“ zählt nur eine Seite, auf der das Ablehnen laut den Fakten der CMP gilt: Das Banner
  erscheint dort nicht wieder.

#### EMBED-01: Schriften

- Gezählt werden abgeschlossene Abrufe von Schriftdiensten des Dienstekatalogs. Ohne abgeschlossenen Abruf der Website
  selbst bleibt es bei `preconnect-only`.
- Schriften, die ein Kartenrahmen oder ein Videoplayer lädt, nennen EMBED-02 und EMBED-03 mit. EMBED-01 meldet sie
  zusätzlich als eigenen Befund `fonts-in-embed-frame` je Schriftdienst und Einbettung (etwa Google Fonts im Rahmen von
  Google Maps), mit Angaben zum Zeitpunkt wie bei `fonts-loaded` und mit einem Link auf den Befund der Einbettung.
- Schriften, die die Seite selbst lädt, bleiben `fonts-loaded`. Hat der Rahmen einer Einbettung Schriften desselben
  Dienstes geladen, sagt der Text von `preconnect-only`, dass sich die Feststellung auf Abrufe außerhalb der Rahmen
  bezieht, und nennt die Einbettung.
- Schriftdateien anderer Hosts im Rahmen zählen EMBED-02 und EMBED-03 als Anfragen an Hilfshosts.
- Schriften im Rahmen von CAPTCHAs, Widgets, Bewertungen, Chats und Social-Media-Plugins ergeben keinen eigenen Befund,
  weil deren Prüfungen (EMBED-04, EMBED-05) nicht Teil des Prototyps sind.
- Die Seite einer Anfrage im Rahmen ist wie bei EMBED-03 die Seite, auf der das Dokument des Rahmens geladen wurde.
  EMBED-02 zählt eine späte Anfrage des Kartenrahmens dagegen für die Seite, mit der sie aufgezeichnet wurde; Seitenzahl
  und Zeitpunkt beider Befunde können dann abweichen.

#### EMBED-03: Videos

- Videos werden je Einbettung gemeldet. Was ein Player-Rahmen lädt, gehört zu dessen Dienst, auch die Vorschaubilder
  und Videodaten von YouTube, die ein Player von youtube-nocookie.com abruft. Ein Vorschaubild auf der Seite selbst
  bleibt beim Dienst, von dem es stammt.
- Als Vorschaubild gilt ein Bild nur mit der Signatur des Dienstekatalogs (`/vi/` auf `ytimg.com`, `/video/` auf
  `i.vimeocdn.com`), ein Beacon-Bild des Players (`generate_204`) nicht.
- Die Seite eines Player-Rahmens ist die Seite, auf der sein Dokument geladen wurde, auch wenn ein Beacon des Players
  erst beim Wechsel zur nächsten Seite gesendet wird.
- Was ein Player speichert, meldet CONSENT-02 als eigenen, verknüpften Befund.
- Ein Videorahmen im Seitenaufbau, der beim Besuch nichts lädt, ergibt keinen Befund, sondern die Einschränkung
  `video-embed-not-loaded`.
- Ist die Seite, die der Scanner für einen Link mit einem Wort der Gruppe `video` gewählt hat („Video“, „Videos“,
  „Mediathek“, Liste in `test/data/browser/pages.yaml`), nicht auswertbar, ergibt das ohne Video auf anderen Seiten
  `inconclusive` (`video-page-not-evaluable`), mit Video die Einschränkung gleichen Namens.

#### LEGAL-01

- Die Prüfung erkennt Angaben eines Impressums an Wörtern und bewertet ihre Vollständigkeit nicht.
- Hält ein Abschnitt mit seinen Unterabschnitten mindestens 3 der 5 Bereiche
  (`DSGVO_CHECK_LEGAL_IMPRESSUM_MIN_GROUPS`), meldet die Prüfung statt „nicht gefunden“ die Warnung
  `provider-details-without-link`.
- In der Datenschutzerklärung zählen dafür nur ein Abschnitt „Impressum“ und der Seitenfuß, weil sie auch
  Firmenangaben von Auftragsverarbeitern nennt.
- Auf Kontakt-, Zwischen- und Startseite zählt ein Abschnitt seine Unterabschnitte nur mit, wenn er „Impressum“ heißt.
  Angaben in getrennten Abschnitten unter der Überschrift der Seite („Kontakt“ über „Anfahrt“, „Team“) zählen nicht
  zusammen.

#### LEGAL-02

- Gesucht werden nur die Bezeichnungen aus
  [test/data/legal/outdated-references.yaml](../test/data/legal/outdated-references.yaml): TMG, RStV, TTDSG, EU-US
  Privacy Shield, Safe Harbor, Richtlinie 95/46/EG und ausdrücklich „BDSG a. F.“ (das BDSG selbst gilt weiter und
  zählt nicht).
- Gelesen werden die HTML-Fassungen von Impressum und Datenschutzerklärung (deutsch oder englisch) und die weiteren
  Datenschutzhinweise der Website, ohne nicht angezeigten Text. Eine Seite, die beides ist, ergibt einen Befund je
  Bezeichnung.
- Ein Satz beginnt mit einem Großbuchstaben, „§“ oder einer Zahl. Ein Satz, der die Bezeichnung als frühere nennt
  („vormals § 5 TMG“, „für ungültig erklärt“) oder zusammen mit der Nachfolgeregelung („§ 5 TMG bzw. § 5 DDG“, „Data
  Privacy Framework“), zählt nicht. Das kann einen Satz übersehen, der beides tut; ein Hinweis im Nachbarsatz zählt
  dagegen nicht für ihn.
- Fehlt ein Dokument, liegt es nur als PDF oder in einer anderen Sprache vor oder ist es abgeschnitten, nennt die
  Prüfung das als Einschränkung (`partial`); ohne lesbares Dokument ist sie `inconclusive` (`no-documents`).
- Die Befunde sind `info`; ob eine Angabe rechtlich erheblich ist, bewertet die Prüfung nicht.

#### PRIV-01

- Gelesen wird der Text der Datenschutzerklärung auf derselben Seite und in Frames, dazu die weiteren
  Datenschutzhinweise der Website, die Phase A gelesen hat. Eine Nennung in einem davon gilt als Nennung.
- Andere Sprachversionen werden nicht gelesen. Sie und weitere Hinweise, die als PDF, in einer anderen Sprache,
  abgeschnitten oder gar nicht vorliegen, ergeben die Einschränkung `supplement-not-evaluated` (Status `partial`); die
  Datenschutzerklärung selbst wird trotzdem ausgewertet.
- Verneinungen werden nicht ausgewertet; die Konfidenz ist daher höchstens `medium`.
- Steht der Dienstname als Teil eines Hostnamens im Text (etwa „player.vimeo.com“), zählt er als Nennung.

Nennung nur im Banner:

- Nennt kein Dokument den Dienst, wohl aber das Einwilligungsbanner selbst mit Namen oder Schreibweise des
  Dienstekatalogs (etwa die eingeklappten „Cookie-Details“ von Borlabs Cookie), meldet PRIV-01 statt `not-named` oder
  `category-only` die Variante `named-in-cmp-only` (`info`). Der Befund nennt die Schreibweise aus dem Katalog.
- Gelesen wird der Text des Banners einmal in Phase A ohne Klick, auf der ersten Seite, auf der ein eigener Adapter das
  Banner sicher erkennt (nie die allgemeine Heuristik), höchstens 100 000 Zeichen.
- Firmenname, Domain oder Kategorie im Banner zählen nicht als Nennung.
- Bleibt ein Dienst ungenannt, gilt die Einschränkung `cmp-dialog-truncated`, wenn der Text abgeschnitten ist, und
  `cmp-dialog-unread`, wenn das Lesen fehlschlug; es wird im selben Scan nicht wiederholt.

#### PRIV-02

- Erkannt werden nur die Angaben aus [test/data/legal/claims.yaml](../test/data/legal/claims.yaml) (deutsch und englisch,
  in HTML-Datenschutzerklärungen): lokal eingebunden, keine Verbindung, erst nach Einwilligung geladen. Weitere
  Datenschutzhinweise der Website liest PRIV-02 nicht.
- Ein Satz zählt, wenn er den Dienst nennt oder unter einer Überschrift mit dem Dienst steht. „Erst nach Einwilligung“
  zählt nur mit einem Wort des Ladens oder der Verbindung („Cookies werden erst gesetzt, wenn Sie zustimmen“ ist keine
  solche Angabe).
- Nicht gewertet (`claim-ambiguous`) werden Angaben mit Vorbehalt („sofern“, „kann“), nur für einen Teil („einige“,
  „außer“) oder eine andere Zeit („früher“, „künftig“), in nicht angezeigtem Text, zusammen mit dem externen Abruf im
  selben Satz, in Sätzen zu mehreren Diensten und in Sätzen über 200 Zeichen.
- Eine Verneinung vor der Angabe („nicht lokal“, „not installed locally“) hebt sie auf.

| Beobachtung | Schweregrad |
| --- | --- |
| Abweichung in mindestens zwei Beobachtungen (Phase und Seite, `DSGVO_CHECK_LEGAL_POLICY_CLAIM_MIN_CONTEXTS`) | `critical` |
| Abweichung in einer Beobachtung | `warning` |
| Dasselbe Dokument beschreibt auch den Abruf von außerhalb („von Google“, „von Google-Servern geladen“, „Drittanbieter“) | `info` |
| Nur Abrufe ohne Antwort und Verbindungsvorbereitungen beobachtet | `info` |

- Eine Anfrage im Frame zählt für die Seite seines Dokuments.
- Schriften, die der Frame einer eingebetteten Karte lädt, sind kein Abruf der Website (EMBED-01 meldet sie als
  `fonts-in-embed-frame`). Nach „Alle akzeptieren“ zählen Anfragen auf Seiten mit Karten- oder Videodienst im
  Hauptdokument nicht.
- „Keine Verbindung“ zu einer Karte oder einem Video gilt nur bis zur Einwilligung, denn ohne Verbindung zeigt die
  Einbettung nichts.
- „Auch nach bestätigter Ablehnung“ steht nur für Anfragen auf Seiten, auf denen die Ablehnung laut den Fakten der CMP
  gilt.
- Ohne Befund ist die Datenschutzerklärung nicht als zutreffend bestätigt.

#### MAIL-01 bis MAIL-03: E-Mail-Domains

- Geprüft werden die gescannte Domain, nach einer Weiterleitung der Startseite auf eine andere Domain auch deren
  Domain, und die Domains von bis zu 2 E-Mail-Adressen aus dem Impressum.
- Aus dem Impressum zählen zuerst Adressen im Text, dann `mailto:`-Links, beides im Inhalt der Impressumsseite, nicht
  im Seitenfuß oder in der Navigation. Freemail-Anbieter wie `gmx.de` zählen nicht (Liste in
  `test/data/dns/mail-domains.yaml`); ein Host `www.` ist keine E-Mail-Domain.
- Jede Domain bekommt eigene Befunde. Die Adresse im Impressum belegt nicht, wer die Domain betreibt.
- Adressen aus der Datenschutzerklärung, aus DMARC-Berichtsadressen und von anderen Seiten werden nicht abgefragt.
- Ohne gelesenes Impressum (nur MAIL-Prüfungen gewählt, Zertifikat ungültig ohne Weiterleitung auf einen anderen Host,
  Impressum nicht gefunden) bleibt das im Ergebnis vermerkt („E-Mail-Domains aus dem Impressum in diesem Lauf nicht
  erhoben“).

#### MAIL-03: DKIM

Selektoren sind frei wählbar, und DNS verrät nicht, welche es gibt. Abgefragt werden je Domain höchstens
`DSGVO_CHECK_DNS_DKIM_MAX_SELECTORS` (8), in dieser Reihenfolge:

1. die Selektoren aus `DSGVO_CHECK_DNS_DKIM_SELECTORS` (`selector` für jede Domain oder `domain/selector`);
2. die festen Selektoren eines erkannten Anbieters. Microsoft 365 (`selector1`, `selector2`) gilt nur als erkannt,
   wenn ein MX-Eintrag unter `mail.protection.outlook.com` (bei DANE mit DNSSEC unter `mx.microsoft`) und das
   SPF-include zusammen vorliegen;
3. übliche Namen (Liste in `test/data/dns/dkim.yaml`).

| Ergebnis | Variante |
| --- | --- |
| Unter keinem abgefragten Selektor ein Schlüssel; angegebene oder feste Selektoren waren dabei | `given-selector-missing` (`warning`) |
| Unter keinem abgefragten Selektor ein Schlüssel, sonst | `selectors-not-found` (`info`) |
| RSA-Schlüssel unter `DSGVO_CHECK_DNS_DKIM_MIN_RSA_BITS` (1024, nach RFC 8301; anhebbar) | `key-too-short` |

Findet sich unter einem Selektor ein Schlüssel, meldet MAIL-03 keinen der beiden ersten Befunde.

- Ein Schlüssel unter einem anderen Namen bleibt unsichtbar. Ein veröffentlichter Schlüssel belegt nicht, dass E-Mails
  signiert werden. Ed25519 hat keine RSA-Länge.
- Domains mit Null-MX oder ganz ohne MX- und SPF-Eintrag werden nicht abgefragt.
- Keinen Befund ergeben: fehlgeschlagene Abfragen, ein aufgebrauchtes Budget, nicht lesbare oder widerrufene Schlüssel
  (leeres `p=`) und erwartete Selektoren über der Grenze.
- Zeitüberschreitungen bei DKIM-Abfragen halten die Abfragen der nächsten Domain nicht an.

#### HDR-02

- Versionsangaben stammen nur aus den Headern `Server`, `X-Powered-By`, `X-Generator`, `X-Redirect-By`,
  `X-AspNet-Version` und `X-AspNetMvc-Version` von Startseite, Impressum und Datenschutzerklärung, und nur in der Form
  `Produkt/Version`.
- Nicht gespeichert werden:
  - Kommentare in Klammern, Text in Anführungszeichen und Text, der ohne Leerzeichen an beiden hängt;
  - Produktnamen mit Punkt oder in der Form einer Kennung (Hash, UUID);
  - Versionen in der Form eines Hostnamens, mit Hash im Zusatz oder aus vier Zahlen wie eine IPv4-Adresse (also auch
    `openresty/1.21.4.1`);
  - alles nach den ersten vier Paaren.
- Ein Produktname aus einem Wort lässt sich von einem Rechnernamen ohne Punkt nicht unterscheiden.
- `<meta name="generator">` wird nicht gelesen. Ob eine Version Schwachstellen hat, bewertet die Prüfung nicht.

#### TLS-01: Formulare über http

- Der Scanner liest Formulare aus dem Markup der Antwort, ohne Skripte auszuführen: Ein Formular, das erst ein Skript
  einfügt, sieht er nicht.
- Ein relatives `action` löst er wie ein Browser gegen das erste `<base href>` auf; das `formaction` einer Schaltfläche
  liest er nicht.
- Gelesen werden die ersten 512 KiB einer Seite. Wurde eine Antwort dort abgeschnitten, ließ sie sich nicht entpacken
  oder stand statt des Impressums oder der Datenschutzerklärung ein Bot-Schutz dort, und stand im gelesenen Teil kein
  Formular, nennt TLS-01 die Einschränkung `http-form-not-inspected`.
- Ein Formular einer https-Seite, das an eine `http://`-Adresse sendet, ist kein TLS-01-Befund.

Außer der Startseite und den verlinkten Rechtstexten fragt der Scanner höchstens 3 weitere `http://`-Adressen ab
(`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES`), nur auf Hosts, deren Wurzel `http://<host>/` ohne Umleitung auf https
ausgeliefert wird:

- **Zuerst Seiten mit Formular:** Seiten, auf denen Phase A ein Formular gesehen hat, das mehr als eine Suche auf der
  Website nimmt (dieselbe Regel wie für das Markup, Wörter in `test/data/http/html.yaml`). Formulare mit E-Mail- oder
  Passwortfeld zuerst.
- **Mit dem Rest Permalinks:** Beiträge und Artikel, die die Seiten der Phase A als Permalink verlinken
  (`rel="bookmark"`, so verlinkt WordPress das Datum eines Beitrags). Die Links der Startseite zuerst, sonst in der
  Reihenfolge im Dokument, und nur Adressen, die Phase A nicht selbst besucht hat.
- Ein Beitrag mit Kommentarformular wird so nur gesehen, wenn Phase A ihn besucht (Seitengruppe Blog/News) oder eine
  besuchte Seite ihn als Permalink verlinkt und er ins Budget passt. Ein Beitrag, der nur über Titel oder
  „Weiterlesen“ ohne `rel="bookmark"` verlinkt ist, wird nicht abgefragt.
- Seiten mit Formular über dem Budget ergeben `http-form-twins-capped`. Weitere Permalinks über dem Budget nennt TLS-01
  nicht, denn ob sie ein Formular tragen, ist nicht bekannt.
- Seiten und Permalinks mit Query-Parametern oder Port in der Adresse werden nicht abgefragt (also auch nicht
  WordPress-Adressen der Form `/?p=123`).
- Antwortet ein Host mit 429 oder 503, bekommt er in diesem Schritt keine weitere Anfrage.
- Antwortet die Adresse mit einem Bot-Schutz, einem Fehler oder einer Weiterleitung auf eine andere `http://`-Adresse,
  bleibt es bei der Einschränkung `http-form-twin-undecided`.

#### TLS-01: http-Links

- http-Links zählen nur, wenn sie in Phase A auf einer https-Seite der Website beobachtet wurden und auf `http://`
  eines Hosts derselben Domain zeigen.
- Ob ein solcher Link umleitet, entscheidet die Abfrage der Startseite (`/`) des Hosts, nicht der verlinkte Pfad.
  Abgefragt werden nur die angegebene Adresse, www und die Domain selbst. Für andere Hosts bleibt die Konfidenz
  `medium`, ebenso, wenn die Startseite unter `http://` nur eine Seite bis 1 KiB liefert.
- Gesucht wird HSTS in den https-Antworten auf dem Weg der Umleitung, die auch auf einen anderen Host führen kann; der
  Befund nennt diesen Host.
- Ohne Browser (`--checks TLS-01`) bewertet TLS-01 nur die http-Adressen; lief der Browser nicht, nennt die Prüfung die
  Einschränkung.

### Netzwerkgrenze (SSRF)

- Geprüft werden die Zieladresse vor dem Start und jede Navigation von Dokumenten und Frames (private, Loopback-,
  Link-local- und Metadaten-Adressen).
- Nicht abgedeckt: Subressourcen, DNS-Rebinding und das Ziel hinter einem `--proxy`.
- Den Scanner nicht in einem Netz mit sensiblen internen Diensten und nicht in Jobs mit Secrets laufen lassen.
