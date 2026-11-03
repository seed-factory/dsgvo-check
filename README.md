# dsgvo-check

[![CI](https://github.com/seed-factory/dsgvo-check/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seed-factory/dsgvo-check/actions/workflows/ci.yml)
[![Lizenz: Apache-2.0](https://img.shields.io/badge/Lizenz-Apache--2.0-blue.svg)](LICENSE)
[![Node.js ≥ 24](https://img.shields.io/badge/Node.js-%E2%89%A5%2024-339933.svg)](#voraussetzungen)

Passiver Scan einer Website auf DSGVO/TDDDG/DDG-Indizien und grundlegende Sicherheitsprobleme, mit Exit-Code für
CI. Der Scanner öffnet die Website in Chromium (Playwright) und hält fest, was **vor** einer Einwilligung passiert,
was sich nach „Ablehnen“ und nach „Alle akzeptieren“ ändert, ob Impressum und Datenschutzerklärung erreichbar sind
und wie Header, TLS und E-Mail-Authentifizierung der Domain konfiguriert sind. Er läuft lokal, als Docker-Image, als
GitHub Action und im GitLab CI und lässt die Pipeline fehlschlagen, sobald ein Befund die gewählte Schwelle erreicht.

Der Bericht beschreibt technische Beobachtungen („beobachtet“, „nicht gefunden in …“), keine rechtliche Bewertung.

> **Status: Prototyp 0.1.0.** 15 Prüfungen, sieben CMP-Adapter; Berichte als JSON, Konsole, HTML und Markdown-Summary,
> PDF auf Wunsch. Der Prototyp prüft die Architektur an echten Websites und ist kein Release 1.0. Die Texte im Bericht
> sind Entwürfe („Textentwurf“). Noch nicht veröffentlicht (kein npm-Paket). Lücken: siehe [Grenzen](#grenzen).

## Inhalt

- [Funktionen](#funktionen)
- [Was geprüft wird](#was-geprüft-wird)
- [So funktioniert es](#so-funktioniert-es)
- [Voraussetzungen](#voraussetzungen)
- [Installation und Build](#installation-und-build)
- [Nutzung](#nutzung)
- [Optionen](#optionen)
- [Konfiguration](#konfiguration)
- [Exit-Codes](#exit-codes)
- [Docker](#docker)
- [CI-Integration](#ci-integration) mit [GitHub Action](#github-action) und [GitLab CI](#gitlab-ci)
- [Was der Scanner sendet](#was-der-scanner-sendet)
- [Grenzen](#grenzen)
- [Nutzungshinweise](#nutzungshinweise)
- [Entwicklung](#entwicklung) mit [Tech-Stack](#tech-stack), [Projektstruktur](#projektstruktur),
  [Befehle](#befehle), [Tests](#tests), [Canary](#canary) und [Release](#release)
- [Beitragen](#beitragen)
- [Lizenz](#lizenz)

## Funktionen

- **Drei Browser-Phasen** mit frischem Profil: vor jeder Interaktion, nach „Ablehnen“, nach „Alle akzeptieren“.
- **15 Prüfungen** zu Einwilligung, Tracking, Einbettungen, Rechtstexten, Sicherheits-Headern, TLS und E-Mail.
- **Sieben CMP-Adapter** (Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub).
- **Keine Werte:** Cookies, Web Storage und TC-String gelangen nie in Bericht, Snapshot oder Logs, auch nicht gehasht.
- **Berichte** als JSON (mit JSON Schema), Konsole, HTML (eine Datei ohne JavaScript), Markdown-Summary und PDF.
- **CI-tauglich:** Exit-Code nach Schwelle, GitHub Action, GitLab-Template und Docker-Image.
- **Chromium-Sandbox standardmäßig**, im Container mit eigenem seccomp-Profil statt `--privileged`.
- **Snapshots:** Rohdaten speichern und ohne Netz neu auswerten (`--save-snapshot`, `--from-snapshot`).
- **Einstellbar, aber ohne Pflicht:** Jeder Wert hat einen Standard; Schwellen per Umgebungsvariable oder `.env`.
- **Höflich:** Navigationen einzeln mit Pause, wenige HTTP-Anfragen, ehrlicher User-Agent mit Link zum Repository.

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

Jede Prüfung kann mehrere Varianten melden. Die Tabelle darunter wird aus `test/data/ruleset` erzeugt und zeigt, welche
Variante mit welchem Standard-Schweregrad gemeldet wird.

<details>
<summary>Varianten und Standard-Schweregrade</summary>

Die Meldungs-ID eines Befunds ist `<Prüfung>.<Variante>`. Die Schweregrade sind die Standardwerte des Regelwerks;
mittlere Konfidenz begrenzt einen Befund auf `warning`, niedrige auf `info`.

<!-- registry:begin: generated from test/data/ruleset by `corepack pnpm registry`, do not edit -->
| ID           | `critical`                                 | `warning`                                                                                    | `info`                                                                                                                           |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CONSENT-01` | `tracking-completed`                       | `library-loaded`, `first-party-proxy`, `cookieless-ping`                                     | `third-party-resource`, `unknown-host`, `request-not-completed`                                                                  |
| `CONSENT-02` | `tracking-identifier-stored`               | `unknown-third-party-persistent`                                                             | `unknown-first-party-persistent`, `cmp-cookie-with-uid`, `storage-rejected-or-attempted`                                         |
| `CONSENT-03` | `no-banner-strong-tracking`                | `no-banner-consent-services`                                                                 | —                                                                                                                                |
| `CONSENT-04` | `blocking-no-reject`, `close-means-accept` | `reject-not-actionable`, `reject-ineffective`, `consent-without-action`                      | `reject-as-link`, `nonblocking-no-reject`, `no-choice-at-first-layer`, `pur-abo`, `banner-not-recognized`², `cmp-not-supported`² |
| `CONSENT-05` | `tracking-after-reject`                    | `cookieless-ping-after-reject`                                                               | `connect-only-after-reject`                                                                                                      |
| `TRACK-01`   | —                                          | —                                                                                            | `service-inventory`                                                                                                              |
| `EMBED-01`   | —                                          | `fonts-loaded`                                                                               | `preconnect-only`                                                                                                                |
| `EMBED-02`   | —                                          | `maps-loaded`                                                                                | —                                                                                                                                |
| `LEGAL-01`   | `document-not-found`, `links-broken`       | `link-missing-on-some-pages`, `reachable-via-intermediate`, `footer-covered-by-banner`       | `unresolved`                                                                                                                     |
| `PRIV-01`    | —                                          | `not-named`                                                                                  | `category-only`, `ambiguous-match`                                                                                               |
| `MAIL-01`    | —                                          | `record-not-found`, `policy-none`, `record-invalid`                                          | `weak-option`, `legacy-pct`                                                                                                      |
| `MAIL-02`    | —                                          | `record-not-found`, `permissive-qualifier`, `record-invalid`, `softfail-without-enforcement` | `softfail-with-enforcement`, `ptr-mechanism`                                                                                     |
| `HDR-01`     | —                                          | `hsts-missing`, `anti-framing-missing`, `referrer-policy-permissive`                         | `header-missing`                                                                                                                 |
| `TLS-01`     | `https-unavailable`, `form-on-http-page`   | `no-redirect`, `client-side-redirect-only`                                                   | `redirect-chain-detail`                                                                                                          |
| `TLS-02`     | `certificate-invalid`                      | `chain-incomplete`, `certificate-expiring`                                                   | `certificate-expiry-approaching`                                                                                                 |
<!-- registry:end -->

² Fest vorgegeben (`locked`): wird nicht angehoben und zählt nicht für `--fail-on`; die Prüfung bleibt `inconclusive`.

</details>

### Geplante Prüfungen

Diese Prüfungen sind spezifiziert, aber noch nicht umgesetzt. Die Tabelle nennt die geplanten Varianten je Schweregrad.

| ID                    | Thema                                                | `critical`                      | `warning`                                                                    | `info`                                                           | Ohne Befund (`reason`)   |
| --------------------- | ---------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| `PRIV-02`             | Datenschutzerklärung im Abgleich mit der Beobachtung | `contradiction-replicated`      | `contradiction-single`                                                       | `wording-to-review`                                              | `claim-ambiguous`        |
| `EMBED-03`            | Videos und Vorschaubilder                            | —                               | `video-loaded`                                                               | —                                                                | —                        |
| `EMBED-04`            | CAPTCHA                                              | —                               | `captcha-without-form`                                                       | `captcha-with-form`                                              | —                        |
| `EMBED-05`            | Widgets                                              | —                               | `widget-loaded`                                                              | —                                                                | —                        |
| `CONSENT-06`          | Consent Mode                                         | `google-granted-despite-denied` | `default-granted`, `hit-before-default`                                      | —                                                                | `not-observable`         |
| `VULN-01`, `VULN-02`³ | CMS-Kern; Plugins, Themes und Bibliotheken           | `version-listed-kev-or-preauth` | `version-listed`, `eol-major`                                                | `version-unknown`                                                | `source-unavailable`     |
| `MAIL-03`             | DKIM                                                 | —                               | `key-too-short`, `given-selector-missing`                                    | `selectors-not-found`                                            | —                        |
| `TLS-03`              | Mixed Content                                        | —                               | `active-mixed-content-blocked`, `passive-upgrade-failed`, `form-action-http` | `passive-auto-upgraded`                                          | —                        |
| `TLS-04`              | TLS 1.0/1.1                                          | —                               | `legacy-protocol-accepted`                                                   | —                                                                | `handshake-inconclusive` |
| `DNS-01`              | CAA und DNSSEC                                       | —                               | `dnssec-bogus`                                                               | `caa-not-found`, `dnssec-unsigned`                               | —                        |
| `HDR-02`              | Cookie-Attribute und Versionsangaben                 | —                               | `session-cookie-attributes`                                                  | `cookie-attributes`, `cookie-samesite-missing`, `version-header` | —                        |
| `ADMIN-01`⁴           | Öffentliche WordPress-Angaben                        | —                               | `users-and-xmlrpc-exposed`                                                   | `partial-exposure`                                               | —                        |
| `FILE-01`⁴            | Dienstdateien                                        | `sensitive-signature`           | `exposed-file`                                                               | `minor-file`                                                     | —                        |
| `SEC-01`              | `security.txt`                                       | —                               | —                                                                            | `security-txt-not-found`, `security-txt-incomplete`              | —                        |
| `LEGAL-02`            | Veraltete Bezeichnungen                              | —                               | —                                                                            | `outdated-reference`                                             | —                        |
| `BFSG-01`⁵            | Automatische Zugänglichkeitssignale                  | —                               | —                                                                            | `axe-rule-observed`                                              | —                        |
| `PERF-01`⁵            | Performance im Labor                                 | —                               | —                                                                            | `lab-metrics`                                                    | —                        |

³ Die Stufen gelten bei exakt bestimmter Version; bei einem Versionsbereich liegt jede Variante eine Stufe niedriger.  
⁴ Nur auf ausdrücklichen Wunsch (Opt-in); der Prototyp sendet solche Anfragen nicht.  
⁵ Zählt nicht für `--fail-on` (`gating: false`).

## So funktioniert es

```mermaid
flowchart LR
    target["Ziel-URL"] --> collectors
    subgraph collectors["Collectors (gesamter Netzwerk-Zugriff)"]
        direction TB
        br["Browser<br/>Phase A, B, C"]
        ht["HTTP"]
        tl["TLS"]
        dn["DNS"]
    end
    collectors --> snap["Snapshot<br/>ohne Werte, vor dem Schreiben redigiert"]
    snap --> checks["Prüfungen<br/>reine Funktionen"]
    checks --> gate["Gate<br/>--fail-on, --strict"]
    gate --> result["Berichte<br/>und Exit-Code"]
```

Nur die Collectors greifen aufs Netz zu und entfernen sensible Werte, bevor etwas in den Snapshot gelangt. Die
Prüfungen sind reine Funktionen über diesem Snapshot; Schweregrade, Varianten und Texte liegen als Daten in
`test/data`, nicht im Code. Das Gate bestimmt aus den Befunden den Exit-Code. Weil der Snapshot alle Rohdaten enthält,
lässt sich ein Scan mit `--from-snapshot` ohne Netz erneut auswerten.

### Ablauf im Browser

Jede Phase startet mit einem frischen Browserprofil in einem temporären Verzeichnis.

| Phase | Aktion                                                                                | Seiten                                                                      |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A     | Ohne Interaktion beobachten                                                           | Startseite, Impressum, Datenschutzerklärung, Kontakt, bis zu 2 weitere      |
| B     | „Ablehnen“ über den CMP-Adapter klicken, Zustand prüfen, Startseite neu laden, prüfen | Startseite und bis zu 2 Kontrollseiten                                      |
| C     | „Alle akzeptieren“ klicken                                                            | Dieselben Kontrollseiten; entfällt, wenn Phase B keinen Adapter erkannt hat |

- Die weiteren Seiten in Phase A kommen aus Links oder der Sitemap. `--max-pages` begrenzt die Seitenzahl (Standard 6);
  Impressum und Datenschutzerklärung werden unabhängig davon besucht. Fehlt der Link, probiert der Scanner
  `/impressum` und `/datenschutz`.
- Jede Seite bleibt mindestens 6 s (Phase A) bzw. 4 s (B und C) offen, bis der Netzverkehr ruhig ist; Obergrenzen:
  20 s bzw. 12 s.
- B und C entfallen auch, wenn der Zielhost drosselt (429/503) oder das Zeitbudget erschöpft ist.
- Wird das globale Zeitlimit nach der Startseite erreicht, bleiben die Beobachtungen im Bericht; nicht ausgeführte
  Phasen gelten als abgeschnitten, Prüfungen ohne Daten enden mit Status `error` (`timeout`).

### Banner

Eigene Adapter gibt es für Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner und CookieHub.
Geklickt wird nur über sie.

- CONSENT-04 bewertet oberhalb von `info` nur bei Erkennung mit hoher Konfidenz.
- Ein anderes Banner wird nur heuristisch erkannt: CONSENT-04 meldet `info` „Banner nicht erkannt“ (Status
  `inconclusive`), der Scanner klickt nicht.
- Verhält sich ein Banner wie gegenüber einem Bot oder meldet es einen Standort außerhalb des EWR, werden die
  betroffenen Prüfungen `inconclusive`, nicht zu Befunden.

## Voraussetzungen

| Komponente     | Anforderung                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Node.js        | ≥ 24 (`.node-version`: 24); die CI testet 24 und 26. `engine-strict` weist ältere Versionen ab.       |
| pnpm           | 12.16.1 über `corepack` (`packageManager` in `package.json`); ein globales pnpm ist nicht nötig.      |
| Chromium       | Chrome for Testing im neuen Headless-Modus (kein Headless-Shell), installiert über `playwright-core`. |
| Linux          | Systembibliotheken für Chromium: `dsgvo-check install --with-deps` (Root) oder das Docker-Image.      |
| Docker         | Optional: für Image, GitHub Action und GitLab-Template.                                               |
| Betriebssystem | Die CI läuft auf Ubuntu 24.04; lokal wird unter macOS entwickelt. Andere Systeme sind nicht getestet. |

- Ab Node 25 liefert Node `corepack` nicht mehr mit: `npm install --global corepack` (die CI nutzt 0.36.0).
- Die Chromium-Sandbox braucht unprivilegierte User-Namespaces. Unter Ubuntu 24.04 schränkt AppArmor sie ein; die CI
  setzt dafür `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Im Container löst das
  [seccomp-Profil](#warum-ein-eigenes-seccomp-profil) das Problem.

## Installation und Build

Der Prototyp ist nicht auf npm; man baut ihn aus dem Quellcode.

```sh
git clone https://github.com/seed-factory/dsgvo-check.git
cd dsgvo-check
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm build
```

- `corepack pnpm build` übersetzt TypeScript nach `dist/` und schreibt `schema/report.schema.json` (JSON Schema des
  Berichts, aus den zod-Schemas erzeugt; nicht im Git).
- Der Einstiegspunkt ist `node dist/cli.js`.
- Unter Linux fehlen oft Systembibliotheken: `node dist/cli.js install --with-deps` (Root) installiert sie.
- `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` unterdrückt die Download-Rückfrage von corepack beim ersten Aufruf.

## Nutzung

```sh
node dist/cli.js https://www.example.de/ --format console,json,html --out ./dsgvo-check-report
```

Ein Scan dauert meist 1–3 Minuten und schreibt nach `--out`:

- `report.json` und `report.html` (eine Datei ohne JavaScript),
- `summary.md` mit `--format summary`,
- `artifacts/banner-B.jpg` bei erkanntem Banner (abschaltbar mit `--no-screenshots`),
- `report.pdf` nur mit `--format html,pdf`. Ein Druckfehler führt zu einer Warnzeile; Exit-Code und JSON bleiben.

### Bericht erneut ausgeben

Einen vorhandenen JSON-Bericht gibt der Befehl `report` ohne erneuten Scan aus. Ungültiges oder fremdes JSON endet mit
Exit-Code 2.

```sh
node dist/cli.js report ./dsgvo-check-report/report.json --format html,pdf --lang de --out ./report-export
```

- Ohne Flags rendert `report` HTML auf Deutsch. `DSGVO_CHECK_REPORT_LANG` und `DSGVO_CHECK_REPORT_FORMATS` (auch aus
  `.env`, siehe [Konfiguration](#konfiguration)) ändern diese Standardwerte, ein Flag geht vor.
- Ist `DSGVO_CHECK_REPORT_FORMATS` nicht gesetzt, bleibt es bei `html`: `console,json` ist nur der Standard eines Scans.
- `DSGVO_CHECK_REPORT_OUT_DIR` gilt nur für Scans; `report` schreibt neben die Eingabedatei oder nach `--out`.

### Snapshot speichern und neu auswerten

```sh
node dist/cli.js https://www.example.de/ --save-snapshot scan.snapshot.json
node dist/cli.js --from-snapshot scan.snapshot.json --checks HDR-01,TLS-02 --format console
```

Der Snapshot enthält die Rohdaten des Scans (ohne Cookie-, Storage- und TC-String-Werte). `*.snapshot.json` steht in
`.gitignore`.

## Optionen

Vollständig: `dsgvo-check --help`. Befehle: Scan (Standard), `report <report.json>` und `install [--with-deps]`.

| Option                              | Standard               | Bedeutung                                                                                |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `--fail-on critical\|warning\|none` | `critical`             | Schwelle für Exit-Code 1                                                                 |
| `--format <liste>`                  | `console,json`         | Ausgabeformate: `console`, `json`, `html`, `summary`, `pdf` (PDF nur ausdrücklich)       |
| `--out <dir>`                       | `./dsgvo-check-report` | Ausgabeverzeichnis                                                                       |
| `--max-pages <n>`                   | `6`                    | Seiten in Phase A                                                                        |
| `--timeout <dauer>`                 | `8m`                   | Globales Zeitlimit, z. B. `8m` oder `90s`                                                |
| `--assume-region eea\|de`           | nicht gesetzt          | Standort des Scanners laut Nutzerangabe                                                  |
| `--proxy <url>`                     | kein Proxy             | HTTP-Proxy (nur `http://`, CONNECT) für Browser, HTTP und TLS; DNS läuft direkt          |
| `--strict`                          | aus                    | Nicht eindeutige Ergebnisse, `--sandbox off` und ungeprüfte Region führen zu Exit-Code 2 |
| `--sandbox require\|off`            | `require`              | Chromium-Sandbox; `off` nur bewusst, im Bericht als `SCAN-SANDBOX-OFF` vermerkt          |
| `--no-screenshots`                  | aus                    | Keine Banner-Screenshots                                                                 |
| `--save-snapshot <file>`            | –                      | Rohdaten speichern                                                                       |
| `--from-snapshot <file>`            | –                      | Snapshot ohne Netz neu auswerten (die URL entfällt)                                      |
| `--checks <ids>`                    | alle                   | Nur diese Prüfungen, z. B. `EMBED-01,HDR-01`                                             |
| `--lang de\|en`                     | `de`                   | Sprache des Berichts                                                                     |
| `--verbose`                         | aus                    | Ausführliche Logs auf stderr                                                             |

## Konfiguration

Der Scanner läuft ohne jede Konfiguration: Jeder Wert hat einen Standard. Schwellen, Zeitlimits und Grenzen lassen
sich zusätzlich über Umgebungsvariablen der Form `DSGVO_CHECK_<ABSCHNITT>_<NAME>` setzen, etwa
`DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS`, `DSGVO_CHECK_HTTP_MAX_REDIRECTS` oder `DSGVO_CHECK_TLS_EXPIRING_DAYS`. Die
Einheit steht im Namen (`_MS` Millisekunden, `_BYTES` Bytes, `_DAYS` Tage). Eine Datei `.env` ist nicht nötig; liegt
im aktuellen Verzeichnis eine, wird sie gelesen.

- **Vorrang:** Flag, Umgebungsvariable, `.env`, Standardwert. Eine bereits gesetzte Umgebungsvariable wird von `.env`
  nicht überschrieben.
- **Nur `DSGVO_CHECK_*`:** Andere Einträge der Datei bleiben unberührt und gelangen nicht in die Umgebung von Chromium.
- **Alle Einstellungen** mit Standardwert und Beschreibung stehen in [.env.example](.env.example). Die Datei wird aus
  dem Schema in `src/core/config` erzeugt (`corepack pnpm env:example`).
- **Ungültige Werte** enden mit Exit-Code 2 (`invalid-config`) und nennen Variable, Quelle und Grund in der Sprache
  von `--lang`.
- **Abweichungen** von den Standardwerten stehen im Bericht unter „Abweichende Einstellungen“ (ohne Proxy-URL).

Drei Werte lassen sich nur verlängern, damit der Scanner höflich bleibt:

| Variable                                  | Mindestwert | Bedeutung                                                  |
| ----------------------------------------- | ----------- | ---------------------------------------------------------- |
| `DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS` | 1500        | Pause zwischen zwei Navigationen                           |
| `DSGVO_CHECK_BROWSER_RETRY_DELAY_MS`      | 3000        | Pause vor dem einen Wiederholungsversuch nach 429 oder 5xx |
| `DSGVO_CHECK_HTTP_MIN_INTERVAL_MS`        | 500         | Abstand zwischen zwei Anfragen an denselben Host           |

Im Docker-Image und in der GitHub Action gelangen nur `HOME` und `NO_COLOR` in den Container. Einstellungen übergibt
man beim manuellen `docker run` mit `--env` oder `--env-file`:

```sh
docker run --rm --env HOME=/tmp --env DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS=3000 \
  --env-file scan.env dsgvo-check:dev https://www.example.de/ --out /out
```

## Exit-Codes

| Code | Bedeutung                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| `0`  | Kein Befund erreicht die Schwelle `--fail-on`.                                                             |
| `1`  | Mindestens ein Befund erreicht die Schwelle, auch wenn andere Prüfungen fehlschlugen.                      |
| `2`  | Scan nicht durchgeführt, eine für die Schwelle relevante Prüfung fehlgeschlagen oder ein `--strict`-Grund. |

Vorrang: Scan nicht durchgeführt (`2`) vor Befund (`1`) vor Prüfungsfehler oder `--strict` (`2`) vor `0`. Ein Fehler
bei der optionalen PDF-Ausgabe ändert den Exit-Code nicht.

Alle zutreffenden Gründe stehen in `report.json` unter `summary.exitReasons`, nicht nur der entscheidende:

| Grund                      | Bedeutung                                                                                                      | Exit |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ---- |
| `threshold`                | Ein Befund erreicht `--fail-on`.                                                                               | 1    |
| `unreachable`              | Ziel nicht erreichbar (DNS, Verbindung, Zeitüberschreitung oder 5xx der Startseite).                           | 2    |
| `blocked`                  | WAF, Challenge oder 403 auf der Startseite.                                                                    | 2    |
| `timeout`                  | Globales Zeitlimit vor Ende von Phase A der Startseite, oder eine relevante Prüfung wurde dadurch abgebrochen. | 2    |
| `sandbox-unavailable`      | Die Chromium-Sandbox startete nicht (`--sandbox require`).                                                     | 2    |
| `invalid-input`            | Ungültige Argumente, Einstellungen oder URL; Zieladresse nicht öffentlich; Browser fehlt.                      | 2    |
| `internal-error`           | Interner Fehler, Abbruch durch SIGINT/SIGTERM oder Watchdog.                                                   | 2    |
| `report-write-failed`      | Ein angeforderter Bericht ließ sich nicht schreiben; bereits geschriebene Dateien bleiben.                     | 2    |
| `check-error:<ID>`         | Eine relevante Prüfung endete mit Status `error`.                                                              | 2    |
| `strict:inconclusive:<ID>` | Nur mit `--strict`: Eine relevante Prüfung war nicht eindeutig.                                                | 2    |
| `strict:sandbox-off`       | Nur mit `--strict`: `--sandbox off`.                                                                           | 2    |
| `strict:egress-unverified` | Nur mit `--strict`: Standort ungeprüft (kein `--assume-region`) bei aktiven CONSENT-Prüfungen.                 | 2    |

`check-error` und die `strict`-Gründe ergeben nur dann Exit-Code `2`, wenn kein `threshold` vorliegt; sonst gilt `1`.
Mit `--fail-on none` entfallen `threshold` und `check-error`; `--strict` wirkt davon unabhängig.

## Docker

Das Image enthält den Scanner samt Chromium und ein passendes seccomp-Profil.

```sh
docker build -t dsgvo-check:dev .
docker run --rm dsgvo-check:dev --help
docker run --rm dsgvo-check:dev seccomp-profile > dsgvo-check-seccomp.json
```

### Scan im Container

Die Chromium-Sandbox ist standardmäßig erforderlich (`--sandbox require`), startet aber nicht mit dem
Standard-seccomp-Profil von Docker. Mit dem mitgelieferten Profil läuft der Scan:

```sh
mkdir -p dsgvo-check-report
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --security-opt seccomp=dsgvo-check-seccomp.json \
  -v "$PWD/dsgvo-check-report:/out" \
  dsgvo-check:dev https://www.example.de/ --out /out --format console,json,html
```

Ohne `--user` läuft das Image als Nutzer `10001`; ihm muss das Ausgabeverzeichnis gehören, sonst endet der Scan mit
Exit-Code 2 (Bericht nicht geschrieben). Der Container gibt den Exit-Code der CLI zurück.

### Gehärteter Lauf

Mit denselben Flags wie die [GitHub Action](#github-action): keine Linux-Capabilities, schreibgeschütztes
Dateisystem (außer `/tmp` und `/out`), begrenzte Ressourcen. Sonst wird nichts eingehängt: kein `docker.sock`, kein
Workspace, keine Secrets.

```sh
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt no-new-privileges \
  --security-opt seccomp=dsgvo-check-seccomp.json \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g --env HOME=/tmp \
  --memory=3g --memory-swap=3g --cpus=2 --pids-limit=1024 --shm-size=512m \
  --volume "$PWD/dsgvo-check-report:/out" \
  dsgvo-check:dev https://www.example.de/ --out /out --format console,json,html,summary
```

### Inhalt des Images

| Bestandteil     | Wert                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Basis           | `node:24-bookworm-slim`                                                                                  |
| Browser         | Volles Chrome for Testing im neuen Headless-Modus (kein Headless-Shell), Revision laut `playwright-core` |
| Nutzer          | uid/gid `10001` (`scanner`), Arbeitsverzeichnis `/work`                                                  |
| Prozess 1       | `tini`                                                                                                   |
| Einstieg        | `/usr/local/bin/dsgvo-check` (`docker/entrypoint.sh`): startet die CLI oder gibt `seccomp-profile` aus   |
| Seccomp-Profil  | `/etc/dsgvo-check/seccomp.json` (Quelle: `docker/seccomp-chromium.json`)                                 |
| Build-Argumente | `VERSION` und `REVISION` setzen die OCI-Labels (Version, Revision, Quelle, Lizenz)                       |

### Warum ein eigenes seccomp-Profil

Die Chromium-Sandbox legt User-, PID- und Netzwerk-Namespaces an und wechselt per `chroot` in ein leeres Verzeichnis.
Das Standardprofil von Docker erlaubt `clone` mit Namespace-Flags, `unshare`, `setns` und `chroot` nur mit
`CAP_SYS_ADMIN` bzw. `CAP_SYS_CHROOT`. Mit dem Standardprofil, und immer mit `--cap-drop=ALL`, scheitert der Browser
daher mit „Chromium sandboxing failed!“. `--privileged` oder `--cap-add=SYS_ADMIN` würden funktionieren, geben dem
Container aber weit mehr, als der Browser braucht.

`docker/seccomp-chromium.json` ist das Standardprofil von Docker plus eine Regel:

```json
{ "names": ["chroot", "clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW" }
```

Alles andere bleibt unverändert, auch die Regel `clone3` → `ENOSYS`, mit der glibc auf `clone` zurückfällt.
`test/e2e/docker.e2e.test.ts` prüft beide Seiten: Mit diesem Profil, `--cap-drop=ALL`, `no-new-privileges`,
schreibgeschütztem Dateisystem und Nicht-Root-Nutzer meldet `chrome://sandbox` „adequately sandboxed“; mit dem
Standardprofil und denselben Flags scheitert der Start.

**Abwägung:** Die Regel erlaubt Prozessen im Container, User-Namespaces anzulegen, und legt damit mehr Kernel-Code
offen als das Standardprofil. Das ist der Preis der Sandbox, die den Renderer fremder Websites isoliert, und deutlich
enger als `--privileged` oder `CAP_SYS_ADMIN`.

**Self-managed GitLab-Runner:** Der Administrator setzt dasselbe Profil in der `config.toml`
(`security_opt = ["seccomp=<datei>"]`). Ohne Profil endet der Job mit Exit-Code 2 (`sandbox-unavailable`), außer
`DSGVO_CHECK_SANDBOX: "off"` ist ausdrücklich gesetzt.

**Profil neu erzeugen** nach einer Aktualisierung des Docker-Profils: die zusätzliche Regel (erster Eintrag der
aktuellen Datei) vor die neuen `syscalls` setzen. Biome ignoriert die Datei, ein Formatierungsschritt entfällt.

```sh
curl -fsSL https://raw.githubusercontent.com/moby/profiles/<commit>/seccomp/default.json \
  | jq --argjson rule "$(jq '.syscalls[0]' docker/seccomp-chromium.json)" '.syscalls = [$rule] + .syscalls' \
  > docker/seccomp-chromium.json
```

**Quellen und Lizenzen** (die Zuordnung steht auch in [NOTICE](NOTICE)):

- Basis, Inhalt unverändert: [moby/profiles `seccomp/default.json`](https://github.com/moby/profiles/blob/4b8214f/seccomp/default.json),
  Commit `4b8214f`, Apache-2.0.
- Idee, `chroot`, `clone`, `setns` und `unshare` zu erlauben: [jessfraz/dotfiles `chrome.json`](https://github.com/jessfraz/dotfiles/blob/889e23d/etc/docker/seccomp/chrome.json),
  Commit `889e23d`, MIT. Die Datei selbst ist veraltet (kein `clone3`, `rseq`, `statx`; keine Regel `clone3` → `ENOSYS`)
  und wird deshalb nicht übernommen.
- Gleicher Ansatz: [microsoft/playwright `seccomp_profile.json`](https://github.com/microsoft/playwright/blob/1d5572d/utils/docker/seccomp_profile.json),
  Commit `1d5572d`, Apache-2.0. Auch ihm fehlt die Regel `clone3` → `ENOSYS`; ohne sie scheitert auf aktuellen
  Distributionen das Anlegen von Threads.

## CI-Integration

Der Scan sollte in einem eigenen Job ohne Secrets und ohne Schreibrechte laufen: Der Scanner öffnet fremde Seiten.
GitHub Action und GitLab-Template starten das Image `ghcr.io/seed-factory/dsgvo-check:<Version>` mit der Version aus
`package.json`.

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

**Eingaben**

| Eingabe           | Standard                                 | Bedeutung                                                                        |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `url`             | – (Pflicht)                              | Ziel-URL (`http://` oder `https://`)                                             |
| `fail-on`         | `critical`                               | Schwelle: `critical`, `warning` oder `none`                                      |
| `format`          | `console,json,html`                      | Formate; PDF nur ausdrücklich (`console,json,html,pdf`)                          |
| `out`             | `dsgvo-check-report`                     | Berichtsverzeichnis, relativ zum Workspace oder absolut                          |
| `extra-args`      | leer                                     | Weitere CLI-Optionen, an Leerzeichen getrennt; Optionen der Action haben Vorrang |
| `image`           | `ghcr.io/seed-factory/dsgvo-check:0.1.0` | Scanner-Image nach Versions-Tag                                                  |
| `memory`          | `3g`                                     | Speicherlimit des Containers                                                     |
| `cpus`            | `2`                                      | CPU-Limit des Containers                                                         |
| `pids-limit`      | `1024`                                   | Prozesslimit des Containers                                                      |
| `job-summary`     | `true`                                   | Hängt die Summary an den Job an (fügt `summary` zu `format` hinzu)               |
| `upload-artifact` | `true`                                   | Lädt das Berichtsverzeichnis hoch                                                |
| `artifact-name`   | `dsgvo-check-report`                     | Name des Artefakts                                                               |
| `retention-days`  | `14`                                     | Aufbewahrung des Artefakts in Tagen                                              |

**Ausgaben:** `exit-code` (0, 1 oder 2) sowie `json-path`, `html-path` und `pdf-path` (leer, wenn die Datei fehlt;
`pdf-path` bleibt bei einem Druckfehler leer).

- Der Schritt gibt den Exit-Code des Scans weiter: Der Job schlägt bei `1` (Befunde) und `2` (Scan nicht
  durchgeführt) fehl und schreibt eine Annotation dazu.
- Der Container läuft gehärtet: Nicht-Root, eigenes seccomp-Profil, `--cap-drop=ALL`, `no-new-privileges`,
  schreibgeschütztes Dateisystem, Ressourcenlimits, ohne Secrets und ohne `docker.sock`.
- Die Eingaben gelangen über Umgebungsvariablen in die Shell, nicht per Textersetzung in den Befehl.
- Nur berichten, ohne den Job fehlschlagen zu lassen: `fail-on: none` (nur Scan-Fehler geben Exit-Code 2) oder
  `continue-on-error: true` am Schritt und Auswertung von `steps.<id>.outputs.exit-code`. `continue-on-error` lässt auch
  Exit-Code `2` durch.
- Die Action bindet man mit einem Versions-Tag ein (`@v0.1.0`), nicht mit einem Branch.

Beispiel mit absichtlich rotem Build: [examples/github-failing](examples/github-failing/README.md).

### GitLab CI

```yaml
include:
  - remote: https://raw.githubusercontent.com/seed-factory/dsgvo-check/v0.1.0/templates/gitlab/dsgvo-check.gitlab-ci.yml
    integrity: sha256-<base64-sha256-der-datei>

variables:
  DSGVO_CHECK_URL: https://staging.example.de/
```

Das [Template](templates/gitlab/dsgvo-check.gitlab-ci.yml) definiert den Job `dsgvo-check` (Stage `test`, läuft nur
bei gesetztem `DSGVO_CHECK_URL`). Der Wert für `integrity` steht in der Zusammenfassung des Release-Workflows.

| Variable                 | Standard                                 | Bedeutung                                           |
| ------------------------ | ---------------------------------------- | --------------------------------------------------- |
| `DSGVO_CHECK_URL`        | leer (Job läuft nicht)                   | Ziel-URL                                            |
| `DSGVO_CHECK_FAIL_ON`    | `critical`                               | Schwelle für Exit-Code 1                            |
| `DSGVO_CHECK_FORMAT`     | `console,json,html,summary`              | Ausgabeformate; ein PDF nur ausdrücklich            |
| `DSGVO_CHECK_OUT`        | `dsgvo-check-report`                     | Berichtsverzeichnis                                 |
| `DSGVO_CHECK_SANDBOX`    | `require`                                | `off` nur auf Runnern ohne passendes seccomp-Profil |
| `DSGVO_CHECK_EXTRA_ARGS` | leer                                     | Weitere CLI-Optionen                                |
| `DSGVO_CHECK_IMAGE`      | `ghcr.io/seed-factory/dsgvo-check:0.1.0` | Scanner-Image nach Versions-Tag                     |

- Das Berichtsverzeichnis wird bei jedem Ausgang als Artefakt gesichert (14 Tage, Zugriff ab Developer). Ein Befund
  oder Scan-Fehler lässt die Pipeline fehlschlagen (`allow_failure: false`); wer Befunde (Exit-Code 1) tolerieren will,
  setzt am Job `allow_failure: exit_codes: [1]`.
- `entrypoint: [""]` ist nötig, weil der ENTRYPOINT des Images sonst das `script` des Jobs übernähme; die CLI liegt
  unter `/usr/local/bin/dsgvo-check`.
- Sandbox auf self-managed Runnern: siehe [Docker](#warum-ein-eigenes-seccomp-profil).

## Was der Scanner sendet

Der Scanner schickt Browser-Navigationen und die folgenden Standardanfragen, sonst nichts. Wer als Betreiber wissen
will, was bei ihm angekommen ist, findet es hier vollständig.

- **Browser:** Navigationen der Phasen A, B und C (siehe [Ablauf im Browser](#ablauf-im-browser)), jeweils eine nach
  der anderen mit mindestens 1,5 s Pause.
- **HTTP** (höchstens 2 Anfragen pro Sekunde und Host):
  - `robots.txt` des Ursprungs der Startseite;
  - höchstens 2 Sitemap-Anfragen, nur wenn die Links der Startseite das Seitenbudget nicht füllen (die Sitemap oder ein
    Sitemap-Index und eine Kind-Sitemap);
  - die Umleitungsketten von `http://` und `https://` für den Zielhost und seine `www.`- und Apex-Varianten, dazu die
    Kette auf einem in der Ziel-URL ausdrücklich genannten Port;
  - je eine Anfrage an die von der Startseite verlinkten Seiten Impressum und Datenschutzerklärung (nur gleiche
    Website, für die Sicherheits-Header).
- **TLS:** ein Handshake je Host-Variante (höchstens 3), um das Zertifikat zu lesen; nach einer Umleitung auf eine
  andere Domain höchstens 3 weitere für den Zielhost und seine `www.`- und Apex-Varianten.
- **DNS:** MX-, SPF- und DMARC-Abfragen (höchstens 60 Abfragen) beim Resolver des prüfenden Rechners, nicht bei der
  Website.

Nicht gesendet werden Anfragen auf offene Dateien oder Admin-Oberflächen, Logins und Formulare. Der Scanner versucht
nie, Bot-Schutz, CAPTCHAs oder Geo-Sperren zu umgehen: Eine blockierte Website wird als blockiert vermerkt und nicht
mit Tricks erneut aufgerufen. Phase C („Alle akzeptieren“) lässt die Website ihre Ressourcen von Drittanbietern laden;
diese erhalten dann die IP-Adresse des prüfenden Rechners. HTTP-Anfragen tragen einen ehrlichen User-Agent mit Link zum
Repository (siehe [Nutzungshinweise](#nutzungshinweise)).

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
- **Nur die 15 Prüfungen oben.** Die [geplanten Prüfungen](#geplante-prüfungen) fehlen. Im Berichtsschema sind
  Baseline und Suppressions vorgesehen, die Logik dazu fehlt; es gibt keine JUnit-Ausgabe und keine SOCKS-Proxys.
- **Banner:** Nur die sieben Adapter bedienen ein Banner; andere werden heuristisch erkannt und führen höchstens zu
  `info`.
- **PRIV-01** liest den Text der Datenschutzerklärung auf derselben Seite und in Frames. Verneinungen werden nicht
  ausgewertet; die Konfidenz ist daher höchstens `medium`.
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

### Tech-Stack

TypeScript 7 (nativer `tsc`, Ausgabe nach `dist/`, ohne Bundler) auf Node.js ≥ 24, pnpm über corepack. Alle Versionen
sind exakt gepinnt (`.npmrc`: `save-exact=true`). Eine neue Abhängigkeit braucht eine permissive Lizenz (MIT,
Apache-2.0, BSD, ISC, MPL-2.0); NC-, SA- und GPL-Daten kommen nicht in die Lieferung.

| Laufzeit-Abhängigkeit | Version | Zweck                                                                 |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `playwright-core`     | 1.64.1  | Chromium-Steuerung (Chrome for Testing), CDP                          |
| `undici`              | 8.12.3  | HTTP-Client der Probes                                                |
| `commander`           | 15.0.0  | Kommandozeile                                                         |
| `zod`                 | 4.6.7   | Schemas für Bericht, Einstellungen und Daten; erzeugt das JSON Schema |
| `yaml`                | 2.9.1   | Lesen der Datenfiles in `test/data`                                   |
| `tldts`               | 7.4.19  | Registrierbare Domain und Public Suffix List                          |
| `canonicalize`        | 5.1.0   | Kanonisches JSON (RFC 8785) für Fingerabdrücke von Befunden           |

| Entwicklungs-Abhängigkeit | Version       | Zweck                                              |
| ------------------------- | ------------- | -------------------------------------------------- |
| `typescript`              | 7.0.2         | Typprüfung und Build                               |
| `vitest`                  | 5.0.5         | Testläufer                                         |
| `@biomejs/biome`          | 2.6.4         | Lint und Formatierung                              |
| `ajv`, `ajv-formats`      | 8.20.0, 3.0.1 | Prüft Berichte gegen das JSON Schema               |
| `dns2`                    | 3.1.1         | Fake-DNS-Server für die Integrationstests          |
| `@peculiar/x509`          | 3.1.0         | Testzertifikate (braucht `reflect-metadata` 0.2.2) |
| `@types/node`             | 24.19.2       | Node-Typen                                         |

### Projektstruktur

```text
dsgvo-check/
├── src/
│   ├── cli.ts, scan.ts      # Kommandozeile; Ablauf eines Scans
│   ├── collectors/          # gesamter Netzwerk-Zugriff: browser, http, tls, dns; redigieren vor dem Schreiben
│   ├── cmp/                 # Banner-Erkennung und CMP-Adapter
│   ├── derive/              # abgeleitete Fakten (Dienste-Katalog, Klassifikation)
│   ├── checks/              # Prüfungen als reine Funktionen über dem Snapshot (browser, http, dns)
│   ├── core/                # Snapshot, Einstellungen, Redaktion, Regelwerk, Gate, Berichtsschema
│   └── reporters/           # JSON, Konsole, HTML, Summary, PDF
├── test/
│   ├── data/                # Regelwerk, Texte, Dienste-Katalog, Wörterbücher, Berichtsvorlage (auch im Image)
│   ├── unit/  integration/  e2e/  live/
│   ├── fixture-server/      # lokale Server mit Fake-Drittanbietern für L2 und L3
│   └── fixtures/, utils/    # Snapshots, Berichte, Test-Helfer
├── scripts/                 # Generatoren (Register, .env.example, Schema) und Canary-Runner
├── canary/                  # sites.example.yaml; echtes Korpus und Ergebnisse nur lokal
├── docker/                  # entrypoint.sh, seccomp-chromium.json
├── templates/gitlab/        # GitLab-CI-Template
├── examples/                # Beispiel mit absichtlich rotem Build
├── .github/                 # CI, Release, Hilfsskripte (TypeScript)
├── action.yml, Dockerfile, .env.example
└── schema/                  # report.schema.json; erzeugt von `build`, nicht im Git
```

Den vollständigen Baum und die Architektur beschreibt [docs/architecture.md](docs/architecture.md) (auf Russisch).

### Befehle

| Befehl                                              | Wirkung                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `corepack pnpm install`                             | Abhängigkeiten installieren                                           |
| `corepack pnpm build`                               | `tsc` nach `dist/`, dazu `schema/report.schema.json`                  |
| `corepack pnpm typecheck` und `corepack pnpm lint`  | Typprüfung; Biome-Lint (`corepack pnpm format` formatiert)            |
| `corepack pnpm test`                                | Unit-Tests (dasselbe wie `test:unit`)                                 |
| `corepack pnpm test:integration`                    | Integrationstests mit echtem Chromium                                 |
| `corepack pnpm test:e2e`                            | End-to-End-Tests gegen das gebaute CLI                                |
| `corepack pnpm test:live`                           | Live-Tests gegen echte Websites (nie Teil von `test`)                 |
| `corepack pnpm registry` und `registry:check`       | Variantentabelle in diesem README erzeugen bzw. auf Abweichung prüfen |
| `corepack pnpm env:example` und `env:example:check` | `.env.example` aus dem Einstellungsschema erzeugen bzw. prüfen        |
| `corepack pnpm canary`                              | Canary-Runner (siehe [Canary](#canary))                               |

### Tests

| Stufe | Ort                   | Inhalt                                                                                | Netz         |
| ----- | --------------------- | ------------------------------------------------------------------------------------- | ------------ |
| L0    | `test/unit/core/**`   | Vollständigkeit des Registers, Stoppwörter, Berichtsschema, Importgraph der Prüfungen | keins        |
| L1    | `test/unit/**`        | Prüfungen auf Snapshot-Ausschnitten, Kern (Gate, Bewertung, Konfiguration, …)         | keins        |
| L2    | `test/integration/**` | Echtes Chromium (Chrome for Testing), undici, `node:tls`, dns2, lokale Server         | nur Loopback |
| L3    | `test/e2e/**`         | Gebautes CLI, Docker-Image, Action                                                    | nur Loopback |
| live  | `test/live/**`        | Echte Websites; nie Teil von `corepack pnpm test`                                     | Internet     |

Eine Datei: `corepack pnpm vitest run test/unit/core/evaluation/gate.test.ts`. Der Docker-Teil von L3 ist optional:
`DSGVO_E2E_IMAGE=dsgvo-check:dev corepack pnpm vitest run --project e2e test/e2e/docker.e2e.test.ts`.

**Parallele Läufe.** Testdateien laufen parallel, standardmäßig mit einem Worker je logischem Kern. `DSGVO_TEST_WORKERS`
(Zahl oder Anteil der Kerne, z. B. `4` oder `50%`) überschreibt das; setzen lässt es sich in der Umgebung oder in
`.env` (siehe den Block „tests“ am Ende von `.env.example`). `1` startet die Dateien nacheinander. Die CI setzt `4`
(Referenzrunner mit 4 vCPU und 16 GB); eine GitHub-Repository-Variable `DSGVO_TEST_WORKERS` überschreibt das. Ziel für
einen vollständigen Lauf auf dem Referenzrunner: 10 Minuten. Damit sich L2- und L3-Dateien nicht stören, bekommt jede
Datei ein eigenes `TMPDIR`, Server hören auf Port 0 und Zeitmessungen laufen am Client.

**L2-Netz und Fixture-Server.** Chromium und Node-Clients laden Ziel und Fake-Drittanbieter (`www.google-analytics.com`,
`fonts.googleapis.com`, …) ohne Internet aus `test/fixture-server`, mit echtem TLS, Cookies und Drittanbieter-Kontext.

- Chromium bekommt `--host-resolver-rules`: Port 80 und 443 gehen auf die Ports des Fixture-Servers, jeder andere Port
  scheitert mit `ERR_NAME_NOT_RESOLVED`. Hostname und SNI bleiben erhalten; Root und Netz-Namespaces sind nicht nötig.
  Ein Proxy, die Ports 80/443 oder `page.route` hätten das Verhalten des Browsers verändert.
- Alle gültigen Leaf-Zertifikate teilen einen Schlüssel, dessen SPKI-Hash Chromium vertraut; abgelaufene, falsche und
  selbstsignierte haben eigene Schlüssel und bleiben fehlerhaft. Node vertraut der Test-CA.
- Eine Website liegt in `test/fixture-server/sites/<modul>/<site>/` und wird in `test/fixture-server/sites.ts`
  deklariert. Ziele tragen `.test`-Hostnamen; Fake-Drittanbieter dürfen echte Namen tragen, weil sie den Rechner nie
  verlassen. Inhalte schreibt man von Hand (kopierter CMP- oder Anbietercode wäre ein Lizenzproblem). Fake-DNS für die
  MAIL-Prüfungen: `startFakeDns` in `test/integration/dns/dns-server.ts`.

**Fixtures für Prüfungen (L1).** Jede Variante braucht Fixtures `violation`, `clean`, `inconclusive` und ein
Gegenbeispiel; `registry-completeness.test.ts` führt alle aus und vergleicht Status und Varianten. Browser:
`test/unit/checks/browser/scenarios/<id>.ts`; DNS: `test/unit/checks/dns/fixtures.ts`; HTTP: JSON unter
`test/fixtures/snapshots/http/<ID>/`.

**CI.** `.github/workflows/ci.yml` läuft auf Ubuntu 24.04. Der Job `test` (Node 24 und 26) führt Typprüfung, Lint,
Unit-, Integrations- (echtes Chromium mit Sandbox) und End-to-End-Tests und prüft das gepackte CLI; der Job `docker`
baut das Image und testet Image und Action. Ein Beispielbericht (HTML und PDF) wird als Artefakt hochgeladen.

### Canary

Der Canary ist ein passiver Messlauf des Scanners über eine **lokale, nie eingecheckte** Stichprobe öffentlicher
Websites. Er misst den **Scanner**, nicht die Websites: wie oft Prüfungen `inconclusive`, `skipped` oder `error` enden,
wie oft Bot-Modus, Geo-Modus, Blockaden und nicht erreichbare Hosts auftreten (`SCAN-BOTMODE`, `SCAN-GEO`,
`SCAN-BLOCKED`, `SCAN-UNREACHABLE`), ob die CMP-Erkennung zum erwarteten CMP passt, wie lange Scans dauern und welche
Fehler beim Sammeln am häufigsten sind.

Im Repository liegt nur `canary/sites.example.yaml` mit fiktiven Hosts und allen Eingabefeldern. Das echte Korpus
gehört nach `canary/sites.yaml` (in `.gitignore`) oder in eine private Datei, die `--sites` übergibt.

```sh
cp canary/sites.example.yaml canary/sites.yaml   # dann die fiktiven Einträge ersetzen
corepack pnpm canary --dry-run                   # Plan ausgeben, nichts scannen
corepack pnpm canary --confirm                   # vollständiger Lauf, Ergebnisse in canary/results/<runId>/
corepack pnpm canary:summary <runId>             # SUMMARY.md und summary.json ohne Website-Namen
```

Alle Optionen: `node scripts/canary/main.ts --help`. Ein unterbrochener Lauf lässt sich mit `--run-id` fortsetzen;
`--reanalyze <runId>` wertet gespeicherte Snapshots ohne Netz neu aus.

Die Regeln sind Teil des Werkzeugs, keine Empfehlung:

- **Passiv:** Nur der unter [Was der Scanner sendet](#was-der-scanner-sendet) beschriebene Verkehr; blockierte Websites
  werden als blockiert vermerkt, nicht mit Tricks erneut versucht.
- **Geringe Last:** 3 Websites parallel (höchstens 5), pro Worker mindestens 1,5 s Pause zwischen Websites (Standard
  5 s); im Korpus steht jede registrierbare Domain nur einmal.
- **Ergebnisse bleiben lokal:** `canary/results/` steht in `.gitignore`; keine Veröffentlichung mit Namen, keine
  Weitergabe an ein CRM, keine Abmahnungen, Beschwerden oder Akquise. Zusammenfassungen enthalten ohne `--with-sites`
  keine Website-Namen.
- **Keine Anschuldigungen:** Die Aufnahme ins Korpus sagt nichts über eine Website; nur Organisationen, keine
  Privatpersonen. `selectionReason` nennt nur Fakten, der Validator lehnt Wertungswörter ab.
- **Bestätigung zuerst:** Ohne `--confirm` gibt der Runner nur den Plan aus.
- **Opt-out:** Betreiber erreichen das Projekt über das im User-Agent verlinkte Repository. Bei einem Widerspruch:
  Lauf stoppen, Website aus dem Korpus entfernen, ihr Verzeichnis aus allen lokalen Läufen löschen, Zusammenfassungen
  neu erzeugen.
- **Minimale Daten:** Snapshots enthalten keine Cookie-, Storage- oder TC-String-Werte, Query-Strings sind redigiert.
  Rohergebnisse nach der Auswertung löschen; behalten wird nur die Zusammenfassung ohne Namen.

### Release

Ein Release startet man von Hand: Workflow **Release** (`.github/workflows/release.yml`) mit der Version aus
`package.json`. Er

1. prüft, dass die Version zu `package.json` passt, das Tag `v<Version>` noch nicht existiert und weder Regelwerk noch
   deutsche Texte als Entwurf (`draft`) markiert sind,
2. baut das Image und führt die Docker-End-to-End-Tests dagegen aus,
3. veröffentlicht `ghcr.io/seed-factory/dsgvo-check:<Version>`,
4. setzt das Tag `v<Version>` und schreibt in die Zusammenfassung das Image, den `uses:`-Verweis der Action und den
   `integrity`-Wert für das GitLab-Template.

Die Image-Version in `action.yml`, im GitLab-Template und im `Dockerfile` folgt `package.json`
(`test/e2e/delivery-config.e2e.test.ts` prüft das). In `uses:` stehen immer Versions-Tags.

## Beitragen

Die Regeln für Beiträge, auch für KI-Agenten, stehen in [AGENTS.md](AGENTS.md) (auf Russisch), dort auch die Schritte
für eine neue Prüfung. Die wichtigsten:

- **Nur passiv:** Keine Logins, Formulare oder Umgehung von Bot-Schutz; Pausen und Abfragelimits nur verschärfen.
- **Keine Werte** von Cookies, Web Storage oder TC-String in Snapshot, Bericht und Logs.
- **Fakten statt Rechtsbewertung:** Texte nur in `test/data/texts`, Formulierungen wie „beobachtet“; ein Test sperrt
  Wertungswörter.
- **Prüfungen sind reine Funktionen** ohne Playwright und I/O; Schweregrade und Varianten stehen als Daten in
  `test/data/ruleset`, neue Schwellen und Limits im Einstellungsschema (`src/core/config/schema.ts`).
- **Jede Variante braucht Tests** (`violation`, `clean`, `inconclusive`, Gegenbeispiel); Unit- und Integrationstests
  nutzen kein Internet.
- **Ergebnisse von Scans fremder Websites** werden nicht eingecheckt.

Nach einer Änderung an Varianten: `corepack pnpm registry`; nach einer Änderung an Einstellungen:
`corepack pnpm env:example`. Vor einem Beitrag: `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test`.

## Lizenz

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
