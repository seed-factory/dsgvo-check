# Canary corpus and runner

The canary runs the dsgvo-check prototype over a local sample of public websites. It measures the **scanner**, not the
sites:

- How often does each check end `inconclusive`, `skipped` or `error`?
- How often do bot mode, geo mode, blocking and unreachable hosts occur (`SCAN-BOTMODE`, `SCAN-GEO`, `SCAN-BLOCKED`,
  `SCAN-UNREACHABLE`)?
- Does CMP recognition match the expected CMP?
- How long do scans take, and which collection errors are the most common?

It does not replace the acceptance canary (10 sites with written owner consent and `mustFind` / `mustNotFind`).

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
2. **Low load.** 3 sites in parallel by default, at most 5. Each worker waits between sites (default 5 s, at least
   1.5 s). Inside a scan the scanner's own pacing applies: one navigation at a time, ≥ 1.5 s apart, at most 2 HTTP
   probes per second per host. The User-Agent is honest and links to the repository. Corpus entries have distinct
   registrable domains, so parallel scans never hit the same site.
3. **Results stay private.** `canary/results/` is in `.gitignore`. Results are never published with site names, passed
   to a CRM or used for warning letters (Abmahnungen), complaints or sales outreach. Aggregates contain no site names
   unless `--with-sites`; that output is for local analysis only.
4. **No accusations.** Being in the corpus says nothing about a site. `selectionReason` states facts only
   ("CMP-Vielfalt: Cookiebot", "Behörden-Referenz", "Nicht-EU-Kontrolle"). A `publicReference` is allowed only for cases
   that an authority, a court, noyb or major media documented publicly, and only with a link that was checked. The
   validator rejects verdict words (the stop-word list of `test/data/texts`, plus "Abmahnung").
5. **Confirmation first.** A full live run needs the customer's confirmation. The runner scans only with `--confirm`;
   without it, it prints the plan and exits.
6. **Opt-out.** Operators can contact the project through the [repository](https://github.com/seed-factory/dsgvo-check)
   linked in the User-Agent. On an opt-out request or complaint:
   - stop the run (Ctrl-C lets running sites finish and starts no new ones);
   - remove the site from the local corpus;
   - delete its `<siteId>` directory from every local run (reports, snapshots, screenshots, logs, `meta.json`) and its
     entry from each `run.json`, or delete the affected runs entirely;
   - regenerate summaries from the remaining results before using them again.
7. **Minimal data.** Snapshots hold no cookie, Web Storage or TC-String values; query strings are redacted. Banner
   screenshots are stored next to the reports. Delete raw results (`canary/results/<runId>/`) once the analysis is
   done; keep only the aggregate summary made without `--with-sites`.

## The corpus

The repository holds only [sites.example.yaml](sites.example.yaml): three fictional hosts and every input field. The
real corpus (URLs, ids, organization names, selection notes) lives in `canary/sites.yaml`, which Git ignores, or in a
private file passed with `--sites`. Never commit it or publish named scan results.

Choose a sample that answers the measurement question; there is no mandatory size or regional split
(`--expected-count <n>` optionally enforces one). Include organizations only, never private persons.

Fields of an entry:

- `id`: `<iso-country>-<name>`, lower-case kebab-case, unique.
- `url`: start page; http(s), no query, no fragment, no credentials. URL, host and registrable domain are unique.
- `region`: `de`, `eu` (other EU/EEA) or `non-eu`; must match `country`.
- `country`: ISO 3166-1 alpha-2 (`GB`, not `UK`; `GR`, not `EL`).
- `sector`: one of `SECTORS` in [scripts/canary/sites.ts](../scripts/canary/sites.ts), for example `media`, `retail`,
  `government`, `technology`.
- `sizeClass`: `large`, `medium` or `small-business`.
- `expectedCmp`: `borlabs`, `cookiebot`, `complianz`, `usercentrics`, `ccm19`, `real-cookie-banner`, `cookiehub`,
  `other`, `none` or `unknown`.
- `cmpSignal`: how `expectedCmp` was established (a loader script, an element id, a configuration object, a public
  vendor statement). Required unless `unknown`.
- `selectionReason`: neutral and factual. A documented case starts with `öffentlich dokumentierter Fall:` and contains
  the link.
- `publicReference`: https URL of the public source, or `null`.

`expectedCmp` values outside the seven adapters:

- `other`: a CMP without an adapter (OneTrust, Sourcepoint, Didomi, consentmanager, own banners, …).
- `none`: no CMP loader, banner element or cookie notice in the static HTML. A banner added later by JavaScript cannot
  be ruled out.
- `unknown`: blocked, ambiguous or inconclusive pages.

Record CMP observations factually, with no more than one verification request per site. The validator rejects
duplicate ids, hosts and registrable domains, region/country mismatches, missing CMP evidence and verdict words.
`corepack pnpm vitest run test/unit/canary` tests it, the runner and the aggregation without scanning any site.

## Running

Once:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
cp canary/sites.example.yaml canary/sites.yaml   # then replace the fictional entries
```

Commands (all options: `node scripts/canary/main.ts --help`):

```sh
node scripts/canary/main.ts --dry-run                       # print the plan, scan nothing
node scripts/canary/main.ts --confirm                       # full run, new run id (UTC timestamp)
node scripts/canary/main.ts --confirm --region de --limit 5 # first 5 German sites
node scripts/canary/main.ts --confirm --id de-example-media,at-example-retail # selected local entries
node scripts/canary/main.ts --confirm --run-id 20261030-120000              # resume: finished sites are skipped
node scripts/canary/main.ts --confirm --run-id 20261030-120000 --retry-errors   # re-run sites with runner errors
node scripts/canary/main.ts --confirm --engine cli          # one CLI process per site (isolation, hard kill)
node scripts/canary/main.ts --reanalyze 20261030-120000     # recompute checks from saved snapshots, no network
node scripts/canary/main.ts summary 20261030-120000         # SUMMARY.md + summary.json (no site names)
node scripts/canary/main.ts summary 20261030-120000 --with-sites --stdout   # local analysis only
```

`corepack pnpm canary …` and `corepack pnpm canary:summary …` are aliases.

Per site the runner uses `--fail-on none`, a JSON report, `--save-snapshot`, a 4 min timeout, `--lang de` and
`--sandbox require`. Sites start in `sites.yaml` order after the filters (`--region`, `--id`, then `--limit`); with
parallel workers they finish in any order.

Run from a connection in Germany or the EU: results from elsewhere show more geo effects. The egress region is reported
as "unknown" unless `--assume-region eea|de` is passed.

## Results

```
canary/results/<runId>/
  run.json              plan, options, tool and Node version, sha256 of sites.yaml, site list
  SUMMARY.md            written by `main.ts summary`
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
`report-unreadable`. A scan that failed by itself (unreachable, blocked) has `error: null`, `scanStatus: failed` and its
reason in `report.json`.

`--reanalyze <runId>` writes a new run (`<runId>.re-<timestamp>` unless `--run-id` is given). For each finished site it
copies `snapshot.json` and runs the scanner with `--from-snapshot`, so a fix in `derive` or in a check can be compared
on the same raw data. Sites whose scan failed, or that have no snapshot, keep their original report (`meta.kept`).

## Summary

`node scripts/canary/main.ts summary` writes `SUMMARY.md` and `summary.json` into the run directory: scan status, diagnostics
(sites per `SCAN-*` code), findings, check statuses, CMP recognition, durations and top errors (machine codes only).
The scan-status, diagnostics and findings tables have one column per region group: all, EU/EEA (DE + other EU/EEA), DE,
EU/EEA without DE, non-EU. How the numbers are formed:

- A failed scan with exit reason `unreachable` or `blocked` counts as `SCAN-UNREACHABLE` or `SCAN-BLOCKED`.
- Findings and check statistics count complete and partial scans only.
- Inconclusive share of a check = `inconclusive / (results − skipped)`.
- Detected CMP is read from `snapshot.json`: the best CMP fact (adapter before heuristic, then confidence, then phase B
  first screen); without a snapshot, from `cmp` evidence in the report. `n/a` means the browser delivered no CMP facts.
  The matrix of `expectedCmp` against the detected CMP comes with recall per CMP.
- Without `--with-sites`, no site id, URL or free-text message appears, and site hosts that leak into machine codes are
  replaced by `<site>`.
