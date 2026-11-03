# dsgvo-check

Passiver Scan einer Website auf DSGVO/TDDDG/DDG-Indizien und grundlegende Sicherheitsprobleme, mit Exit-Code für
CI. Der Scanner öffnet die Website in Chromium (Playwright) und hält fest, was **vor** einer Einwilligung passiert,
was sich nach „Ablehnen“ und nach „Alle akzeptieren“ ändert, ob Impressum und Datenschutzerklärung erreichbar sind
und wie Header, TLS und E-Mail-Authentifizierung der Domain konfiguriert sind.

Der Bericht beschreibt technische Beobachtungen („beobachtet“, „nicht gefunden in …“), keine rechtliche Bewertung.

> **Status: Prototyp 0.1.0.** 15 Prüfungen, sieben CMP-Adapter; Berichte als JSON, Konsole, HTML und Markdown-Summary,
> PDF auf Wunsch. Noch nicht veröffentlicht (kein npm-Paket). Umfang und bekannte Lücken:
> [docs/prototype/BRIEF.md](docs/prototype/BRIEF.md).

## Was geprüft wird

| ID         | Beobachtung                                                                               |
| ---------- | ----------------------------------------------------------------------------------------- |
| CONSENT-01 | Anfragen an Dritte und Tracking-Hits vor einer Interaktion mit dem Banner                 |
| CONSENT-02 | Cookies und Web Storage vor Interaktion (Namen, Flags, Laufzeit; **keine Werte**)         |
| CONSENT-03 | Tracking ohne erkennbares Einwilligungsbanner                                             |
| CONSENT-04 | Erste Banner-Ebene: „Ablehnen“ gleichrangig zu „Akzeptieren“?                             |
| CONSENT-05 | Was nach einem bestätigten „Ablehnen“ weiter gesendet oder gespeichert wird               |
| TRACK-01   | Dienste-Inventar je Zeitpunkt: vor Interaktion, nach Ablehnung, nach Zustimmung           |
| EMBED-01   | Schriften von Drittservern (z. B. Google Fonts)                                           |
| EMBED-02   | Karten (z. B. Google Maps) ohne Zwei-Klick-Lösung                                         |
| LEGAL-01   | Impressum und Datenschutzerklärung: verlinkt, erreichbar, nicht vom Banner verdeckt       |
| PRIV-01    | Werden beobachtete Dienste in der Datenschutzerklärung genannt?                           |
| HDR-01     | Sicherheits-Header: HSTS, CSP, Einbettungsschutz, `nosniff`, Referrer-/Permissions-Policy |
| TLS-01     | Umleitung von http auf https                                                              |
| TLS-02     | Zertifikat: gültig, vollständige Kette, Restlaufzeit relativ zur Gesamtlaufzeit           |
| MAIL-01    | DMARC-Eintrag und Richtlinie                                                              |
| MAIL-02    | SPF-Eintrag (statisch ausgewertet), zusammen mit DMARC                                    |

Verhalten, Varianten und Schweregrade: [docs/03-checks.md](docs/03-checks.md) (Register §2.1).

### Ablauf im Browser

Jede Phase startet mit einem frischen Browserprofil.

- **Phase A**, ohne Interaktion: Startseite, Impressum, Datenschutzerklärung, Kontakt und bis zu 2 weitere Seiten
  (nach Links oder Sitemap). `--max-pages` begrenzt die Seitenzahl (Standard 6); Impressum und Datenschutzerklärung
  werden unabhängig davon besucht. Fehlt der Link, werden `/impressum` und `/datenschutz` probiert.
- **Phase B**: „Ablehnen“ über den CMP-Adapter klicken, Zustand prüfen, Startseite neu laden und erneut prüfen, bis zu
  2 Kontrollseiten besuchen.
- **Phase C**: „Alle akzeptieren“ klicken, dieselben Kontrollseiten besuchen. Entfällt, wenn Phase B keinen Adapter
  erkannt hat.

B und C entfallen auch, wenn der Zielhost drosselt (429/503) oder das Zeitbudget erschöpft ist. Wird das globale
Zeitlimit nach der Startseite erreicht, bleiben die Beobachtungen im Bericht; nicht ausgeführte Phasen gelten als
abgeschnitten, Prüfungen ohne Daten enden mit Status `error` (`timeout`).

### Banner

Eigene Adapter gibt es für Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner und CookieHub.
Geklickt wird nur über sie.

- CONSENT-04 bewertet oberhalb von `info` nur bei Erkennung mit hoher Konfidenz.
- Ein anderes Banner wird nur heuristisch erkannt: CONSENT-04 meldet `info` „Banner nicht erkannt“ (Status
  `inconclusive`), der Scanner klickt nicht.
- Verhält sich ein Banner wie gegenüber einem Bot oder meldet es einen Standort außerhalb des EWR, werden die
  betroffenen Prüfungen `inconclusive`, nicht zu Befunden.

## Schnellstart

Voraussetzungen: Node.js ≥ 24, `corepack` (liefert pnpm 12).

```sh
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm build
node dist/cli.js https://www.example.de/ --format console,json,html --out ./dsgvo-check-report
```

Unter Linux braucht Chromium zusätzlich Systembibliotheken: `node dist/cli.js install --with-deps` (benötigt Root)
oder das Docker-Image.

Ein Scan dauert meist 1–3 Minuten und schreibt nach `--out`:

- `report.json` und `report.html` (eine Datei ohne JavaScript),
- `summary.md` mit `--format summary`,
- `artifacts/banner-B.jpg` bei erkanntem Banner (abschaltbar mit `--no-screenshots`),
- `report.pdf` nur mit `--format html,pdf`. Ein Druckfehler führt zu einer Warnzeile; Exit-Code und JSON bleiben.

Einen vorhandenen JSON-Bericht gibt der Befehl `report` ohne erneuten Scan aus. Ungültiges oder fremdes JSON endet mit
Exit-Code 2.

```sh
node dist/cli.js report ./dsgvo-check-report/report.json --format html,pdf --lang de --out ./report-export
```

### Docker

Die Chromium-Sandbox ist standardmäßig erforderlich (`--sandbox require`), startet aber nicht mit dem
Standard-seccomp-Profil von Docker. Das Image liefert ein passendes Profil mit:

```sh
docker build -t dsgvo-check:dev .
docker run --rm dsgvo-check:dev seccomp-profile > dsgvo-check-seccomp.json
mkdir -p dsgvo-check-report
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --security-opt seccomp=dsgvo-check-seccomp.json \
  -v "$PWD/dsgvo-check-report:/out" \
  dsgvo-check:dev https://www.example.de/ --out /out --format console,json,html
```

Ohne `--user` läuft das Image als Nutzer `10001`; ihm muss das Ausgabeverzeichnis gehören, sonst endet der Scan mit
Exit-Code 2 (Bericht nicht geschrieben). Gehärteter Lauf (`--cap-drop=ALL`, schreibgeschütztes Dateisystem,
Ressourcenlimits): [docker/README.md](docker/README.md).

### GitHub Action

```yaml
jobs:
  dsgvo-check:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: seed-factory/dsgvo-check@v0.1.0
        with:
          url: https://staging.example.de/
          fail-on: critical
```

- Die Action startet das Image `ghcr.io/seed-factory/dsgvo-check:0.1.0` mit gehärteten Flags: non-root, eigenes
  seccomp-Profil, `--cap-drop=ALL`, schreibgeschütztes Dateisystem, ohne Secrets.
- Standardformat: `console,json,html`. `job-summary` (Standard `true`) fügt die Summary hinzu und hängt sie an den Job
  an. Das Berichtsverzeichnis wird als Artefakt `dsgvo-check-report` hochgeladen (14 Tage).
- Mit `format: console,json,html,pdf` ist auch ein PDF dabei; der Output `pdf-path` bleibt bei einem Druckfehler leer.
- Den Scan in einem eigenen Job ohne Secrets und ohne Schreibrechte laufen lassen: Der Scanner öffnet fremde Seiten.

Beispiel mit absichtlich rotem Build: [examples/github-failing](examples/github-failing/README.md).

### GitLab CI

```yaml
include:
  - remote: https://raw.githubusercontent.com/seed-factory/dsgvo-check/v0.1.0/templates/gitlab/dsgvo-check.gitlab-ci.yml
    integrity: sha256-<base64-sha256-der-datei>

variables:
  DSGVO_CHECK_URL: https://staging.example.de/
```

Das [Template](templates/gitlab/dsgvo-check.gitlab-ci.yml) nutzt ein Image nach Versions-Tag; ein ausdrücklich
gewähltes PDF liegt im Berichtsartefakt. Sandbox auf self-managed Runnern: [docker/README.md](docker/README.md).

## Optionen

Vollständig: `dsgvo-check --help`. Die wichtigsten:

- `--fail-on critical|warning|none`: Schwelle für Exit-Code 1 (Standard `critical`).
- `--format console,json,html,pdf,summary`: Ausgabeformate (Standard `console,json`); PDF nur bei ausdrücklicher Auswahl.
- `--out <dir>`: Ausgabeverzeichnis (Standard `./dsgvo-check-report`).
- `--max-pages <n>`, `--timeout <dauer>`: Seiten in Phase A (Standard 6), globales Zeitlimit (Standard `8m`).
- `--assume-region eea|de`: Standort des Scanners laut Nutzerangabe.
- `--proxy <url>`: HTTP-Proxy (nur `http://`, CONNECT) für Browser, HTTP und TLS; DNS läuft direkt.
- `--strict`: nicht eindeutige Ergebnisse, `--sandbox off` und ungeprüfte Region führen zu Exit-Code 2.
- `--sandbox require|off`: Chromium-Sandbox; `off` nur bewusst, im Bericht als `SCAN-SANDBOX-OFF` vermerkt.
- `--save-snapshot <file>`, `--from-snapshot <file>`: Rohdaten speichern bzw. ohne Netz neu auswerten.
- `--checks <ids>`: nur diese Prüfungen, z. B. `EMBED-01,HDR-01`.
- `--lang de|en`: Sprache des Berichts.

## Exit-Codes

- `0`: Kein Befund erreicht die Schwelle `--fail-on`.
- `1`: Mindestens ein Befund erreicht die Schwelle, auch wenn andere Prüfungen fehlschlugen.
- `2`, wenn eine dieser Bedingungen zutrifft:
  - Scan nicht durchgeführt: nicht erreichbar, blockiert, Zeitlimit vor der Startseite, Sandbox nicht gestartet,
    Browser nicht installiert, ungültige Eingabe, interner Fehler oder Abbruch, Bericht nicht geschrieben.
  - Eine für die Schwelle relevante Prüfung ist fehlgeschlagen.
  - Mit `--strict` zusätzlich: nicht eindeutige Ergebnisse, `--sandbox off`, nicht angegebene Region.

Vorrang: Scan nicht durchgeführt (`2`) vor Befund (`1`) vor Prüfungsfehler oder `--strict` (`2`) vor `0`. Die Gründe
stehen in `report.json` unter `summary.exitReasons`; vollständige Tabelle: [Architektur §12](docs/02-architecture.md).
Ein Fehler bei der optionalen PDF-Ausgabe ändert den Exit-Code nicht.

## Grenzen

- **Kein Rechtsrat.** Ein Befund ist ein technisches Indiz. Ein leerer Bericht ist keine Freigabe: Er bedeutet nicht,
  dass die Website den Vorgaben entspricht.
- **Nur passiv.** Keine Logins, Formulare oder Umgehung von CAPTCHA, Bot-Schutz und Geo-Sperren. Probes auf offene
  Dateien (`.git`, `.env`, Backups) und Admin-Oberflächen gibt es im Prototyp nicht. Die Option des Nutzers ersetzt
  nicht die Erlaubnis des Website-Betreibers.
- **Keine Werte.** Werte von Cookies, Web Storage und TC-String landen weder im Bericht noch im Snapshot, auch nicht
  gehasht. Query-Parameter werden bis auf eine Allowlist durch `[redacted]` ersetzt, `mailto:`-Adressen bis auf die
  Domain maskiert. Das temporäre Browserprofil enthält die Cookies der Website: Es wird nach jeder Phase entfernt, Reste
  eines mit SIGKILL beendeten Scans räumt der nächste Scan auf.
- **Messumgebung.** Banner reagieren auf Standort, IP-Reputation und Headless-Merkmale: Ein Scan aus einem
  Rechenzentrum außerhalb der EU kann andere Ergebnisse liefern. Der Prototyp prüft den Standort nicht selbst; mit
  `--strict` und ohne `--assume-region` endet ein Scan mit CONSENT-Prüfungen daher mit Exit-Code 2
  (`strict:egress-unverified`), sofern kein Befund Exit-Code 1 auslöst.
- **Nicht ausgewertet:** Datenschutzerklärungen als PDF, aufklappbare Menüs, pagehide-Beacons nach dem Ablehnen, DKIM.
- **Netzwerkgrenze (SSRF).** Geprüft werden die Zieladresse vor dem Start und jede Navigation von Dokumenten und
  Frames (private, Loopback-, Link-local- und Metadaten-Adressen). Nicht abgedeckt: Subressourcen, DNS-Rebinding und das
  Ziel hinter einem `--proxy`. Den Scanner nicht in einem Netz mit sensiblen internen Diensten und nicht in Jobs mit
  Secrets laufen lassen.

## Nutzungshinweise

`dsgvo-check` ist für die Prüfung eigener oder im Auftrag betreuter Websites bestimmt; Berichte über Websites
Dritter sind nicht zur Veröffentlichung vorgesehen. HTTP-Anfragen des Scanners tragen den User-Agent
`dsgvo-check/<version> (+https://github.com/seed-factory/dsgvo-check; passive DSGVO/security check)`; der Browser
meldet sich als Chrome mit demselben Token. TLS-Verbindungsaufbauten und DNS-Abfragen tragen keinen User-Agent.
Phase C übermittelt die IP-Adresse des prüfenden Rechners an die Drittanbieter, deren Ressourcen die Website nach
der Annahme im Banner lädt. Mit `--proxy` laufen DNS-Abfragen direkt über den Resolver, nicht über den Proxy.

Derselbe Text steht in `dsgvo-check --help` (Quelle: `test/data/texts/de/core.yaml`, Schlüssel `usageNotes`).

## Entwicklung

```sh
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1: ohne Browser und Netz
corepack pnpm test:integration   # L2: echtes Chromium gegen lokale Server, ohne Internet
corepack pnpm build && corepack pnpm test:e2e   # L3: gebautes CLI; Docker und Action mit DSGVO_E2E_IMAGE
```

Testdateien laufen parallel; `DSGVO_TEST_WORKERS` (Zahl oder Anteil der Kerne, z. B. `4` oder `50%`) steuert die
Worker, `1` startet sie nacheinander. Details: [test/README.md](test/README.md).

- Regeln für Beiträge (auch für KI-Agenten): [AGENTS.md](AGENTS.md).
- Aufbau des Codes: [Architekturüberblick](docs/architecture.md).
- Kanarienvogel-Messung über öffentliche Websites und ihre Regeln: [canary/README.md](canary/README.md). Der reale
  Korpus und die Ergebnisse bleiben lokal; im Repository liegt nur [sites.example.yaml](canary/sites.example.yaml) mit
  fiktiven Hosts.

## Dokumentation

- [Architekturüberblick](docs/architecture.md)
- [Ziel und Rahmen](docs/00-brief.md)
- [Architektur und Verträge](docs/02-architecture.md)
- [Prüfungen und Varianten](docs/03-checks.md)
- [Formulierungen der Befunde](docs/legal/wording-guide.md)
- [Tests, CI, Docker, Action](docs/04-quality-and-delivery.md)
- [Prototyp: Umfang und Grenzen](docs/prototype/BRIEF.md)
- [Aufgabenstellung](specs/dsgvo-check_TZ.md)

Die Dokumente unter `docs/` und `specs/` sind überwiegend auf Russisch; Ausgaben des Scanners sind Deutsch oder
Englisch.

## Lizenz

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
