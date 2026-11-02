# Canary corpus and runner

The canary measures the dsgvo-check prototype against a locally maintained sample of public websites. It answers
questions about the **scanner**, not about the sites:

- How often does each check end `inconclusive`, `skipped` or `error`?
- How often do bot mode, geo mode, blocking and unreachable hosts occur (`SCAN-BOTMODE`, `SCAN-GEO`,
  `SCAN-BLOCKED`, `SCAN-UNREACHABLE`)?
- Does CMP recognition match the CMP we expected?
- How long do scans take, and which collection errors are the most common?

The acceptance canary is a separate set of 10 sites with written owner consent and `mustFind` / `mustNotFind`
expectations. This measurement runner does not replace that acceptance process.


## Rules

These rules are part of the tool, not a recommendation.

1. **Passive only.** The scanner sends browser navigations (class O: phases A, B and C) and the default
   probes (class T), nothing else:
   - HTTP: `robots.txt` of the start origin and, only when the links of the start page do not fill the page
     budget, at most 2 sitemap requests (the sitemap, or a sitemap index and one child sitemap); the `http://` and
     `https://` redirect chains of the target host and of its `www.` and apex variants, plus the chain on an explicit
     port of the target URL; one request each for the Impressum and Datenschutz pages linked from the start page
     (same site only, for the security headers);
   - TLS: one TLS handshake per host variant (at most 3), to read the certificate; after a redirect to another
     domain, at most 3 more for the final host and its `www.` and apex variants;
   - DNS: MX, SPF and DMARC lookups (at most 60 queries) at the resolver of the scanning machine, not at the site.

   It sends no exposure probes, no FILE-01, no ADMIN-01, no logins and no form submissions. It never tries to get
   around bot protection, CAPTCHAs or geo blocks. A blocked site is recorded as blocked; it is not retried with
   tricks. Phase C ("Alle akzeptieren") lets the site load its third-party resources, which then receive the IP
   address of the scanning machine.
2. **Low load.** The default is 3 sites in parallel, and at most 5. Each worker pauses before every site
   (default 5 s, at least 1.5 s). Inside a scan, the scanner's own pacing applies: one navigation at a time
   with ≥ 1.5 s between navigations, at most 2 HTTP probes per second per host. The scanner sends an honest
   User-Agent with a link to the repository. Each corpus entry has its own registrable domain, so no two
   parallel scans hit the same site.
3. **Results stay private.** `canary/results/` is in `.gitignore`. Results are never published with site names,
   never passed to a CRM and never used for warning letters (Abmahnungen), complaints or sales outreach. Aggregates
   (`SUMMARY.md`, `summary.json`) contain no site names unless `--with-sites` is given, and that output is for local
   analysis only.
4. **No accusations.** Being in the corpus says nothing about a site. `selectionReason` states facts only
   ("CMP-Vielfalt: Cookiebot", "Behörden-Referenz", "Nicht-EU-Kontrolle"). A `publicReference` is added only for
   cases that were documented publicly by an authority, a court, noyb or major media, and only with a link that was
   checked. The validator rejects verdict words (the stop-word list of `data/texts`, plus "Abmahnung").
5. **Confirmation first.** A full live run needs the customer's confirmation. The runner
   only scans with `--confirm`; without it, it prints the plan and exits.
6. **Opt-out.** Operators can contact the project through the [repository](https://github.com/seed-factory/dsgvo-check)
   linked in the User-Agent. On an opt-out request or complaint, stop the run (Ctrl-C finishes the running sites
   and starts no new ones), remove the site from the local corpus, and delete its entire `<siteId>` directory from
   every local run, including reports, snapshots, screenshots, logs and `meta.json`. Also remove its entry from
   each `run.json`, or delete the affected run directories entirely. Regenerate summaries from the remaining
   results before using them again.
7. **Minimal data.** Snapshots hold no cookie, Web Storage or TC-String values; query strings are redacted.
   Banner screenshots are stored next to the reports. Delete raw results (`canary/results/<runId>/`) once the
   analysis is done; keep only the aggregate summary without `--with-sites`.

## Running

Prerequisites, once:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
```

Create your private corpus by copying [sites.example.yaml](sites.example.yaml) to `canary/sites.yaml` and replacing
the fictional entries. `canary/sites.yaml` is ignored by Git; do not commit it. An external corpus can be selected
with `--sites <file>`.

Commands (all options: `node scripts/canary.ts --help`):

```sh
node scripts/canary.ts --dry-run                       # print the plan, scan nothing
node scripts/canary.ts --dry-run --expected-count 100  # optionally require a sample size
node scripts/canary.ts --confirm                       # full run, new run id (UTC timestamp)
node scripts/canary.ts --confirm --region de --limit 5 # first 5 German sites
node scripts/canary.ts --confirm --id de-example-media,at-example-retail # selected local entries
node scripts/canary.ts --confirm --run-id 20261030-120000              # resume: finished sites are skipped
node scripts/canary.ts --confirm --run-id 20261030-120000 --retry-errors   # re-run sites with runner errors
node scripts/canary.ts --confirm --engine cli          # one CLI process per site (isolation, hard kill)
node scripts/canary.ts --reanalyze 20261030-120000     # recompute checks from saved snapshots, no network
node scripts/canary-summary.ts 20261030-120000         # SUMMARY.md + summary.json (no site names)
node scripts/canary-summary.ts 20261030-120000 --with-sites --stdout   # local analysis only
```

`corepack pnpm canary …` and `corepack pnpm canary:summary …` are aliases.

Defaults per site: `--fail-on none`, JSON report, `--save-snapshot`, timeout 4 min, `--lang de`,
`--sandbox require`. The order of the sites is the order in `sites.yaml`, after the filters (`--region`, `--id`,
then `--limit`). Sites start in that order; with parallel workers they finish in any order.

Run the canary from a connection in Germany or the EU. Results from elsewhere show more geo effects, and the
egress region is reported as "unknown" unless `--assume-region` is passed.

## Results

```
canary/results/<runId>/
  run.json              plan, options, tool and Node version, sha256 of sites.yaml, site list
  SUMMARY.md            written by canary-summary
  summary.json
  <siteId>/
    report.json         the scanner's JSON report
    snapshot.json       the saved snapshot (input for --reanalyze)
    artifacts/          banner screenshots, if any
    scan.log            scanner log of this site
    meta.json           written last: exitCode, durationMs, scanStatus, error (runner-level), site attributes
```

`meta.json` marks a finished site; a resumed run skips every site that has one. `error` is set only for runner
problems: `runner-exception`, `watchdog-timeout` (no result after timeout + 60 s), `report-missing`,
`report-unreadable`. A scan that failed by itself (unreachable, blocked) has `error: null`,
`scanStatus: failed` and its reason in `report.json`.

`--reanalyze <runId>` writes a new run (`<runId>.re-<timestamp>` unless `--run-id` is given). For each finished
site it copies `snapshot.json` and runs the scanner with `--from-snapshot`, so a fix in `derive` or in a check can be
compared on the same raw data. Sites whose scan failed, or that have no snapshot, keep their original report
(`meta.kept`).

## Summary

`scripts/canary-summary.ts` aggregates a run. Each table has columns for all sites, EU/EEA (DE + other EU/EEA),
DE, EU/EEA without DE, and non-EU.

- **Scan status:** complete, partial, failed, no report, pending, runner errors; failure codes, exit reasons and
  exit codes.
- **Diagnostics:** sites per `SCAN-*` code. A failed scan with exit reason `unreachable` or `blocked` counts as
  `SCAN-UNREACHABLE` or `SCAN-BLOCKED`.
- **Findings:** counts by severity, and by `checkId` / `variant` / severity with the number of sites per region.
- **Checks:** status counts and the inconclusive share per check, computed as
  `inconclusive / (results − skipped)`, plus the reasons of non-completed results.
- **CMP:** a matrix of `expectedCmp` against the detected CMP. Detection is read from `snapshot.json`: the best
  CMP fact, adapter before heuristic, then confidence, then phase B first screen. Without a snapshot it falls back
  to `cmp` evidence in the report. `n/a` means the browser delivered no CMP facts. The matrix comes with recall
  per CMP.
- **Durations:** min, median, p90, max and mean per region group and per collector.
- **Top errors:** runner errors, scan failures, check errors and collector errors, as machine codes only.

Findings and check statistics count complete and partial scans only. Without `--with-sites`, no site id, URL or
free-text message appears, and site hosts that leak into machine codes are replaced by `<site>`.

## The corpus (`sites.yaml`)

The repository contains only [sites.example.yaml](sites.example.yaml), with three fictional hosts and all input
fields. Real URLs, site identifiers, organization names and selection notes belong in the local ignored
`canary/sites.yaml` or in a private file passed through `--sites`. Do not publish that file or named scan results.

There is no mandatory corpus size or regional split. Choose a sample that answers the measurement question;
`--expected-count <n>` optionally enforces its size before any filters or scans. Only include organizations,
never private persons. Each entry must have a distinct registrable domain.

| Field             | Values                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | `<iso-country>-<name>`, kebab-case, unique                                                                                                                                                                                          |
| `url`             | start page; http(s), no query, no fragment, no credentials; unique URL, host and registrable domain                                                                                                                                 |
| `region`          | `de`, `eu` (other EU/EEA), `non-eu`; must match `country`                                                                                                                                                                           |
| `country`         | ISO 3166-1 alpha-2 (`GB`, not `UK`; `GR`, not `EL`)                                                                                                                                                                                 |
| `sector`          | `media`, `ecommerce`, `retail`, `manufacturing`, `crafts`, `education`, `government`, `banking`, `insurance`, `tourism`, `transport`, `health`, `technology`, `telecom`, `automotive`, `energy`, `food`, `association`, `nonprofit` |
| `sizeClass`       | `large`, `medium`, `small-business`                                                                                                                                                                                                 |
| `expectedCmp`     | `borlabs`, `cookiebot`, `complianz`, `usercentrics`, `ccm19`, `real-cookie-banner`, `cookiehub`, `other`, `none`, `unknown`                                                                                                         |
| `cmpSignal`       | how `expectedCmp` was established; required unless `unknown`                                                                                                                                                                        |
| `selectionReason` | neutral, factual; documented cases start with `öffentlich dokumentierter Fall:` and contain the link                                                                                                                                |
| `publicReference` | https URL of the public source, or `null`                                                                                                                                                                                           |

`expectedCmp` records the observation used to choose a local entry. Record the source in `cmpSignal`, for example
a loader script, an element id, a configuration object or a public vendor statement. Keep selection notes neutral;
`publicReference` is optional, and a documented public case requires an HTTPS reference in `selectionReason`.

- `other` is a CMP outside the seven adapters (OneTrust, Sourcepoint, Didomi, consentmanager, own banners, …).
- `none` means no CMP loader, no banner element and no cookie notice in the static HTML. A banner added later by
  JavaScript cannot be ruled out.
- `unknown` covers blocked, ambiguous and inconclusive pages.

Validation: `corepack pnpm vitest run test/unit/canary` checks the fictional example, schema, filters, runner and
aggregation behavior without scanning sites. The validator rejects duplicate ids, hosts and registrable domains,
invalid regions, missing CMP evidence and verdict words. To change a local corpus:

1. Choose entries and the optional sample size for the measurement.
2. Record CMP observations factually, with no more than one verification request per site.
3. Add a `publicReference` only after checking its source; do not publish local corpus notes.
