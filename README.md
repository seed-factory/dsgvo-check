# dsgvo-check

Passiver Scan einer Website auf DSGVO/TDDDG/DDG-Indizien und grundlegende Sicherheitsprobleme, mit Exit-Code für
CI. `dsgvo-check` öffnet die Website in Chromium (Playwright) und hält fest, was **vor** einer Einwilligung passiert,
was sich nach „Ablehnen“ und nach „Alle akzeptieren“ ändert, ob Impressum und Datenschutzerklärung erreichbar sind,
und wie Header, TLS und E-Mail-Authentifizierung der Domain konfiguriert sind.

Der Bericht beschreibt technische Beobachtungen („beobachtet“, „nicht gefunden in …“), keine rechtliche Bewertung.

> **Status: Prototyp 0.1.0.** 15 Prüfungen, sieben CMP-Adapter, Berichte als JSON, Konsole, HTML und Markdown-Summary;
> PDF bei ausdrücklicher Auswahl. Noch nicht veröffentlicht: kein npm-Paket. Umfang, Vereinfachungen und bekannte
> Lücken: [docs/prototype/BRIEF.md](docs/prototype/BRIEF.md).


## Was geprüft wird

| ID         | Was beobachtet wird                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| CONSENT-01 | Anfragen an Dritte und Tracking-Hits vor einer Interaktion mit dem Banner                                     |
| CONSENT-02 | Cookies und Web Storage vor einer Interaktion (Namen, Flags, Laufzeit, Setzer; **keine Werte**)               |
| CONSENT-03 | Tracking ohne erkennbares Einwilligungsbanner                                                                 |
| CONSENT-04 | Erste Ebene des Banners: gibt es „Ablehnen“ gleichrangig zu „Akzeptieren“                                     |
| CONSENT-05 | Was nach einem bestätigten „Ablehnen“ weiter gesendet oder gespeichert wird                                   |
| TRACK-01   | Inventar der Dienste mit Zeitpunkt: vor Interaktion, nach Ablehnung, nach Zustimmung                          |
| EMBED-01   | Schriften von Drittservern (z. B. Google Fonts)                                                               |
| EMBED-02   | Karten (z. B. Google Maps) ohne Zwei-Klick-Lösung                                                             |
| LEGAL-01   | Impressum und Datenschutzerklärung: verlinkt auf jeder geprüften Seite, erreichbar, nicht vom Banner verdeckt |
| PRIV-01    | Werden beobachtete Dienste in der Datenschutzerklärung genannt                                                |
| HDR-01     | Sicherheits-Header: HSTS, CSP, Schutz gegen Einbetten, `nosniff`, Referrer- und Permissions-Policy            |
| TLS-01     | Umleitung von http auf https                                                                                  |
| TLS-02     | Zertifikat: gültig, vollständige Kette, Restlaufzeit relativ zur Gesamtlaufzeit                               |
| MAIL-01    | DMARC-Eintrag und Richtlinie                                                                                  |
| MAIL-02    | SPF-Eintrag, statisch ausgewertet, zusammen mit DMARC                                                         |

Verhalten, Varianten und Schweregrade jeder Prüfung: [docs/03-checks.md](docs/03-checks.md) (Register §2.1).

**Ablauf des Browsers.** Jede Phase startet mit einem frischen Browserprofil.

- **Phase A**, ohne Interaktion: Startseite, Impressum, Datenschutzerklärung, Kontakt und bis zu 2 weitere Seiten
  nach Links oder Sitemap (`--max-pages`, Standard 6). Impressum und Datenschutzerklärung zählen nicht gegen die
  Grenze. Fehlt der Link, werden zusätzlich `/impressum` und `/datenschutz` probiert.
- **Phase B** klickt „Ablehnen“ über den CMP-Adapter, prüft den Zustand, lädt die Startseite neu, prüft erneut und
  besucht bis zu 2 Kontrollseiten aus Phase A.
- **Phase C** klickt „Alle akzeptieren“ und besucht dieselben Kontrollseiten. Sie entfällt, wenn in Phase B kein
  Adapter erkannt wurde.
- B und C entfallen auch, wenn der Zielhost drosselt (429/503) oder das Zeitbudget erschöpft ist.
- Erreicht der Scan das globale Zeitlimit, nachdem die Startseite erfasst wurde, bleiben die erhobenen Beobachtungen
  im Bericht. Nicht ausgeführte Phasen gelten als vom Zeitlimit abgeschnitten; Prüfungen, denen dadurch Daten
  fehlen, enden mit Status `error` (`timeout`).

**Banner.** Sieben CMP haben eigene Adapter: Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner,
CookieHub. Geklickt wird nur über einen eigenen Adapter. Eine Bewertung von CONSENT-04 oberhalb von `info` gibt es nur
bei Erkennung mit hoher Konfidenz. Ein anderes Banner wird nur heuristisch erkannt: CONSENT-04 meldet dann `info`
„Banner nicht erkannt“ mit Status `inconclusive`, und der Scanner klickt dort nicht. Verhält sich ein Banner wie
gegenüber einem Bot oder meldet es einen Standort außerhalb des EWR, werden die betroffenen Prüfungen
`inconclusive`, nicht zu Befunden.

## Schnellstart

Voraussetzungen: Node.js ≥ 24, `corepack` (liefert pnpm 12).

```sh
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm build
node dist/cli.js https://www.example.de/ --format console,json,html --out ./dsgvo-check-report
```

Unter Linux braucht Chromium Systembibliotheken: `node dist/cli.js install --with-deps` (benötigt Root) oder das
Docker-Image.

Ein Scan dauert meist 1–3 Minuten. Ergebnis: `report.json`, `report.html` (eine Datei ohne JavaScript),
optional `summary.md`, bei erkanntem Banner `artifacts/banner-B.jpg` (abschaltbar mit `--no-screenshots`), dazu die
Ausgabe in der Konsole. `--format html,pdf` erzeugt zusätzlich `report.pdf`; ohne `pdf` wird kein PDF erzeugt.
Ein Druckfehler führt zu einer Warnzeile; Exit-Code und JSON-Bericht bleiben dabei erhalten.

Ein vorhandener JSON-Bericht lässt sich ohne erneuten Scan ausgeben:

```sh
node dist/cli.js report ./dsgvo-check-report/report.json --format html,pdf --lang de --out ./report-export
```

Die Eingabe wird gegen das Berichtsschema geprüft; ungültiges oder fremdes JSON endet mit Exit-Code 2.

### Docker

Die Chromium-Sandbox ist standardmäßig erforderlich (`--sandbox require`). Mit dem Standard-seccomp-Profil von
Docker startet sie nicht; das Image liefert ein passendes Profil mit:

```sh
docker build -t dsgvo-check:dev .
docker run --rm dsgvo-check:dev seccomp-profile > dsgvo-check-seccomp.json
mkdir -p dsgvo-check-report
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --cap-drop=ALL --security-opt no-new-privileges \
  --security-opt seccomp=dsgvo-check-seccomp.json \
  -v "$PWD/dsgvo-check-report:/out" \
  dsgvo-check:dev https://www.example.de/ --out /out --format console,json,html
```

Der Container läuft so als aufrufender Nutzer und kann in das gemountete Verzeichnis schreiben. Ohne `--user` läuft
das Image als Nutzer `10001`, dem das Verzeichnis dann gehören muss; sonst endet der Scan mit Exit-Code 2 (Bericht
nicht geschrieben). Alle gehärteten Flags der Action: [docker/README.md](docker/README.md).

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

Die Action startet das Image mit gehärteten Flags (non-root, eigenes seccomp-Profil, `--cap-drop=ALL`,
schreibgeschütztes Dateisystem, ohne Secrets), hängt die Summary an den Job an und lädt das Berichtsverzeichnis als
Artefakt `dsgvo-check-report` hoch (14 Tage). Ihr Standardformat ist `console,json,html`; mit `job-summary: true`
kommt die Summary hinzu. Das Image ist `ghcr.io/seed-factory/dsgvo-check:0.1.0`. Mit `format: console,json,html,pdf`
wird ein erzeugtes PDF ebenfalls hochgeladen; der Output `pdf-path` bleibt bei einem Druckfehler leer.
Den Scan in einem eigenen Job ohne Secrets und ohne Schreibrechte laufen lassen: der Scanner öffnet fremde Seiten.
Beispiel mit absichtlich rotem Build:
[examples/github-failing](examples/github-failing/README.md).

### GitLab CI

```yaml
include:
  - remote: https://raw.githubusercontent.com/seed-factory/dsgvo-check/v0.1.0/templates/gitlab/dsgvo-check.gitlab-ci.yml
    integrity: sha256-<base64-sha256-der-datei>

variables:
  DSGVO_CHECK_URL: https://staging.example.de/
```

Hinweise zu Sandbox auf self-managed Runnern: [docker/README.md](docker/README.md).
Das [GitLab-Template](templates/gitlab/dsgvo-check.gitlab-ci.yml) verwendet ein Image nach Versions-Tag.
Ein ausdrücklich gewähltes PDF ist im Berichtsartefakt enthalten.

## Optionen

Vollständig: `dsgvo-check --help`. Die wichtigsten:

| Option                                             | Bedeutung                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--fail-on critical\|warning\|none`                | Schwelle für Exit-Code 1 (Standard `critical`)                                           |
| `--format console,json,html,pdf,summary`           | Ausgabeformate (Standard `console,json`); PDF nur bei ausdrücklicher Auswahl             |
| `--out <dir>`                                      | Ausgabeverzeichnis (Standard `./dsgvo-check-report`)                                     |
| `--max-pages <n>`, `--timeout <dauer>`             | Seiten in Phase A (Standard 6), globales Zeitlimit (Standard `8m`)                       |
| `--assume-region eea\|de`                          | Standort des Scanners laut Nutzerangabe                                                  |
| `--proxy <url>`                                    | HTTP-Proxy (nur `http://`, CONNECT) für Browser, HTTP und TLS; DNS läuft direkt          |
| `--strict`                                         | Nicht eindeutige Ergebnisse, `--sandbox off` und ungeprüfte Region führen zu Exit-Code 2 |
| `--sandbox require\|off`                           | Chromium-Sandbox; `off` nur bewusst, wird im Bericht als `SCAN-SANDBOX-OFF` vermerkt     |
| `--save-snapshot <file>`, `--from-snapshot <file>` | Rohdaten speichern bzw. ohne Netz neu auswerten                                          |
| `--checks <ids>`                                   | Nur diese Prüfungen, z. B. `EMBED-01,HDR-01`                                             |
| `--lang de\|en`                                    | Sprache des Berichts                                                                     |

## Exit-Codes

| Code | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Kein Befund erreicht die Schwelle `--fail-on`                                                                                                                                                                                                                                                                                                                                            |
| `1`  | Mindestens ein Befund erreicht die Schwelle, auch wenn andere Prüfungen fehlschlugen                                                                                                                                                                                                                                                                                                     |
| `2`  | Scan nicht durchgeführt (nicht erreichbar, blockiert, Zeitlimit vor der Startseite, Sandbox nicht gestartet, Browser nicht installiert, ungültige Eingabe, interner Fehler oder Abbruch, Bericht nicht geschrieben) oder eine für die Schwelle relevante Prüfung ist fehlgeschlagen; mit `--strict` auch bei nicht eindeutigen Ergebnissen, `--sandbox off` und nicht angegebener Region |

Vorrang: `2` (Scan nicht durchgeführt) vor `1` vor `2` (Prüfungsfehler, `--strict`) vor `0`. Die Gründe stehen in
`report.json` unter `summary.exitReasons`. Vollständige Tabelle: [Architektur §12](docs/02-architecture.md).
Ein Fehler bei der optionalen PDF-Ausgabe ändert den Exit-Code nicht.

## Grenzen

- **Kein Rechtsrat.** Ein Befund ist ein technisches Indiz, keine rechtliche Bewertung. Ein leerer Bericht ist
  keine Freigabe: Er bedeutet nicht, dass die Website den Vorgaben entspricht.
- **Nur passiv.** Keine Logins, keine Formulare, keine Umgehung von CAPTCHA, Bot-Schutz oder Geo-Sperren.
  Probes auf offene Dateien (`.git`, `.env`, Backups) und Admin-Oberflächen gibt es im Prototyp nicht. Die Option des
  Nutzers ersetzt nicht die Erlaubnis des Website-Betreibers.
- **Keine Werte.** Werte von Cookies, Web Storage und TC-String landen weder im Bericht noch im Snapshot, auch nicht
  gehasht. Query-Parameter werden bis auf eine Allowlist durch `[redacted]` ersetzt, `mailto:`-Adressen bis auf die
  Domain maskiert. Das temporäre Browserprofil enthält die Cookies der Website; es wird nach jeder Phase entfernt.
  Reste eines mit SIGKILL beendeten Scans entfernt der nächste Scan beim Start.
- **Messumgebung.** Banner reagieren auf Standort, IP-Reputation und Headless-Merkmale. Ein Scan aus einem
  Rechenzentrum außerhalb der EU kann andere Ergebnisse liefern als aus Deutschland. Der Prototyp prüft den
  Standort nicht selbst: mit `--strict` und ohne `--assume-region` endet ein Scan mit CONSENT-Prüfungen daher mit
  Exit-Code 2 (`strict:egress-unverified`), sofern kein Befund Exit-Code 1 auslöst.
- **Nicht ausgewertet:** Datenschutzerklärungen als PDF, aufklappbare Menüs, pagehide-Beacons nach dem Ablehnen,
  DKIM.
- **Netzwerkgrenze (SSRF).** Der Scanner prüft die Zieladresse vor dem Start und jede Navigation von Dokumenten und
  Frames auf private, Loopback-, Link-local- und Metadaten-Adressen. Subressourcen, DNS-Rebinding und das Ziel
  hinter einem `--proxy` deckt der Prototyp nicht ab. Den Scanner daher nicht in einem Netz mit sensiblen internen
  Diensten und nicht in Jobs mit Secrets laufen lassen.

## Nutzungshinweise

`dsgvo-check` ist für die Prüfung eigener oder im Auftrag betreuter Websites bestimmt; Berichte über Websites
Dritter sind nicht zur Veröffentlichung vorgesehen. HTTP-Anfragen des Scanners tragen den User-Agent
`dsgvo-check/<version> (+https://github.com/seed-factory/dsgvo-check; passive DSGVO/security check)`; der Browser
meldet sich als Chrome mit demselben Token. TLS-Verbindungsaufbauten und DNS-Abfragen tragen keinen User-Agent.
Phase C übermittelt die IP-Adresse des prüfenden Rechners an die Drittanbieter, deren Ressourcen die Website nach
der Annahme im Banner lädt. Mit `--proxy` laufen DNS-Abfragen direkt über den Resolver, nicht über den Proxy.

Derselbe Text steht in `dsgvo-check --help` (Quelle: `data/texts/de/core.yaml`, Schlüssel `usageNotes`).

## Entwicklung

```sh
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm schema:check
corepack pnpm test:unit          # L0–L1: ohne Browser und Netz
corepack pnpm test:integration   # L2: echtes Chromium gegen lokale Server, ohne Internet
corepack pnpm build && corepack pnpm test:e2e   # L3: gebautes CLI; Docker und Action mit DSGVO_E2E_IMAGE
```

Die Testdateien laufen parallel, mit so vielen Workern, wie die Maschine logische Kerne hat. `DSGVO_TEST_WORKERS` ändert
das: eine Zahl (`DSGVO_TEST_WORKERS=4 corepack pnpm test:integration`) oder ein Anteil der Kerne (`DSGVO_TEST_WORKERS=50%`);
mit `1` laufen die Dateien nacheinander. Ein ungültiger Wert bricht den Lauf mit einer Fehlermeldung ab. Jede Testdatei
bekommt ein eigenes temporäres Verzeichnis (`TMPDIR`), das nach der Datei gelöscht wird.

Regeln für Beiträge (auch für KI-Agenten): [AGENTS.md](AGENTS.md). Die Kanarienvogel-Messung über 100 öffentliche
Websites und ihre Regeln:
[canary/README.md](canary/README.md). Der reale Korpus und die Ergebnisse bleiben lokal; im Repository liegt nur
[sites.example.yaml](canary/sites.example.yaml) mit fiktiven Hosts.

## Dokumentation

| Thema                        | Dokument                                                           |
| ---------------------------- | ------------------------------------------------------------------ |
| Ziel und Rahmen              | [docs/00-brief.md](docs/00-brief.md)                               |
| Architektur und Verträge     | [docs/02-architecture.md](docs/02-architecture.md)                 |
| Prüfungen und Varianten      | [docs/03-checks.md](docs/03-checks.md)                             |
| Formulierungen der Befunde   | [docs/legal/wording-guide.md](docs/legal/wording-guide.md)         |
| Tests, CI, Docker, Action    | [docs/04-quality-and-delivery.md](docs/04-quality-and-delivery.md) |
| Prototyp: Umfang und Grenzen | [docs/prototype/BRIEF.md](docs/prototype/BRIEF.md)                 |
| Aufgabenstellung             | [specs/](specs/dsgvo-check_TZ.md)                                  |

Die Projektdokumentation unter `docs/` ist auf Russisch; Ausgaben des Scanners sind Deutsch oder Englisch.

## Lizenz

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
