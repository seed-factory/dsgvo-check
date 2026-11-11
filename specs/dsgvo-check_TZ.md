# dsgvo-check — specification

An open-source scanner that checks a site for DSGVO violations and basic security problems and fails CI if it finds anything critical.

---

## Required

There is no release without these. Everything else is up to you.

| What | How it should work |
|---|---|
| Single-command launch | `<tool> https://example.de` — no config, with reasonable defaults |
| CI integration | A ready-made GitHub Action and a GitLab CI template. Other CI systems use the Docker image |
| Exit code | `0` — threshold not exceeded, `1` — exceeded, `2` — the scanner itself crashed. Configurable threshold: `--fail-on critical\|warning` |
| JSON report | Stable schema: check ID, level, evidence (URL, request, cookie, header, DNS record), `crmCode` from the catalog |
| Human-readable report | Console summary. HTML if time permits |
| Extensibility | A new check can be added without changes to the core |
| Tests | For each check, a fixture with a violation and a clean fixture. The project's own CI is green |
| README | How to run locally and in CI, which checks are available |

---

## Freedom of choice

| What | You decide |
|---|---|
| Language | Any, whichever is convenient for you (within reason) |
| Architecture | Any. The only important thing is that checks are independent modules |
| Browser | Playwright or anything that can intercept network traffic and click the banner |
| Vulnerability database for VULN | Any open source with a suitable license |
| Number of checks | As many as time permits. Order follows the catalog: P0 → P1 → P2 |

---

## Checks

[Check catalog](dsgvo-check_check-catalog.md)

---

## Constraints

| Prohibited | Why |
|---|---|
| Active attacks: brute force, injections, authorization bypass | The scanner runs against other people's sites — passive checks only |
| Hammering the site | Rate limiting, an honest User-Agent with a link to the repository |
| Legal conclusions in the report | Wording “nicht gefunden in der Datenschutzerklärung”, not “verstößt gegen DSGVO”. Disclaimer in the report (I will finish the report so that everything complies with EU law) |
| False CONSENT-04 on an unknown banner | If it is not recognized, output `info` “Banner nicht erkannt” |

---

## Stages

| Stage | Deliverable |
|---|---|
| 0 · Research | Comparison table of similar tools (Website Evidence Collector, HTTP Observatory, testssl.sh, ZAP baseline and anything else you find): what they can and cannot do. Selected stack and CVE database source |
| 1 · Skeleton | CLI, JSON, exit codes, first check for each module, Docker image |
| 2 · CI | GitHub Action and GitLab template, example repository where the Action fails the build |
| 3 · Checks | As many as time permits, in catalog priority order |
| 4 · Release | |

---

## From us

| What | When |
|---|---|
| Repository and access | Before the start |
| German finding texts and disclaimer | By stage 3 - I will pass them on for proofreading and text preparation |
| Pull request reviews | Throughout, within a couple of days |
| 10 real sites for comparison | By stage 3 |
| Project page on seed-factory.com | By release |

---

## How we work

| Parameter | Condition |
|---|---|
| License | MIT or Apache-2.0 |
| Name | `dsgvo-check` is a working name; you may propose your own |
