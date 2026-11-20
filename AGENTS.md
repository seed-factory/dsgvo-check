# AGENTS.md — rules for agents working on dsgvo-check code

dsgvo-check is a passive CLI scanner in TypeScript and Playwright: it looks for signs of DSGVO/TDDDG/DDG violations and basic security problems on websites, and fails CI based on its findings. The repository contains a prototype and the approved 1.0 release documents.

## Sources of truth

Priority: customer decision → [specification](specs/dsgvo-check_TZ.md) → [check catalog](specs/dsgvo-check_check-catalog.md) → `test/data/ruleset` and the code with its tests → [README.md](README.md) and [docs/architecture.md](docs/architecture.md).

Exception: for variants of implemented checks, names, default levels, `locked` and `crm` are defined by `test/data/ruleset/de-2026/*.yaml`. The table in [README.md](README.md) (the “What is checked” section) is generated from it.

| Need                                | Where to look                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| What we are building and why        | [specs/dsgvo-check_TZ.md](specs/dsgvo-check_TZ.md), [README.md](README.md)                                                                 |
| Architecture at a glance            | [docs/architecture.md](docs/architecture.md)                                                                                               |
| Contracts, modules, fields          | Contracts and modules — [docs/architecture.md](docs/architecture.md); fields — schemas in `src/core/snapshot` and `src/core/report`        |
| Check behavior, `messageId`         | `src/checks/**` and their tests; variants — `test/data/ruleset`                                                                            |
| Finding texts and stop words        | `test/data/texts/**`; rule 3 below and `test/unit/core/data/stopwords.test.ts`                                                             |
| Tests, CI, Docker, Action           | [README.md](README.md), “Development”, “Docker”, “CI integration” sections                                                                 |
| Dictionaries, signatures, selectors | `test/data/{cmp,legal,browser,http,services}`; list — in [docs/architecture.md](docs/architecture.md), “Dictionaries and matching” section |
| How the prototype works             | [README.md](README.md): status note and “Limitations” section                                                                              |

If a decision contradicts these documents, stop and ask. Do not silently rewrite a document to match the code.

## Commands

```bash
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1, no browser or network; `corepack pnpm test` runs only these
corepack pnpm test:integration   # L2: real Chromium, local servers, no internet
corepack pnpm test:changed       # only affected tests: merge-base with main + uncommitted changes
corepack pnpm build && corepack pnpm test:e2e   # build also writes schema/report.schema.json from zod
corepack pnpm registry           # regenerate the variants table in README.md
corepack pnpm env:example        # regenerate .env.example from the settings schema (env:example:check checks it)
node dist/cli.js https://example.test --format console,json,html
node dist/cli.js report <report.json> --format html,pdf
```

Dependency versions are pinned exactly (`.npmrc`: `save-exact=true`). A new dependency must have a permissive license (MIT, Apache-2.0, BSD, ISC, MPL-2.0). NC, SA and GPL data are not shipped.

## Hard rules

1. **Passive only.** No logins, form submissions, brute force, or bypassing CAPTCHA and bot protection. FILE-01 and ADMIN-01 are opt-in class E only. Navigate one at a time, with a pause of ≥ 1.5 s; HTTP probes: ≤ 2 requests/s per host. Use an honest User-Agent with a link to the repository.
2. **No values.** Cookie, Web Storage and TC-String values must not enter the snapshot, report, logs or exceptions, either in clear text or as hashes. Redact query to `[redacted]` (except the allowlist), and `mailto:` to the domain. The collector redacts before writing.
3. **Fact, not legal assessment.** User-facing strings live only in `test/data/texts/**`. Wording: “beobachtet”, “nicht gefunden in …”. A test checks stop words (verstößt, rechtswidrig, unzulässig, DSGVO-konform, illegal, violates…). `crmCode` (`T1_…`) is output only in JSON.
4. **Checks are pure functions.** `src/checks/**` imports only `src/core/api.ts` and types: no Playwright, undici or `node:*` I/O (checked by the import graph test). Levels, gating and `crmCode` are data in `test/data/ruleset`, not code.
5. **Unrecognized banner → `info` “Banner nicht erkannt”.** Only dedicated CMP adapters issue CONSENT-04 above `info` when recognition is `high`. Bot and geo signals make checks `inconclusive`, not a finding.
6. **Tests are mandatory.** Every check variant is covered by `violation`, `clean`, `inconclusive` and counterexample fixtures (registry completeness test). Unit and integration tests do not access the internet. Live sites are allowed only in `test/live/**` (not run by default) and in the canary.
7. **Results of scans of other people's sites are not committed or published.** `canary/results/` and `dsgvo-check-report*` are in `.gitignore`.
8. **Git.** Do not commit or push without an explicit request.
9. **Comments explain why.** No review, round or canary numbers, model names, owner tags, decorative separators or labels for removed solutions.
10. **Keep delivery short.** Input parsing and validation are in TypeScript. YAML and shell only launch the container, isolate it and pass reports to CI. Use version tags in `uses:`; the image is `ghcr.io/seed-factory/dsgvo-check:<version from package.json>`.
11. **Tests describe behavior.** File and scenario names contain no review history. Similar cases are combined into tables without losing unique inputs or the requirements of rule 6.
12. **New thresholds, timeouts and limits go in the settings schema.** Add a field to `src/core/config/schema.ts` with a default, bounds and description (variable name `DSGVO_CHECK_<SECTION>_<NAME>`, unit in the name: `_MS`, `_BYTES`, `_DAYS`), then run `corepack pnpm env:example`. The default equals the previous value, and `.env` remains optional. The collector takes the value from `ctx.config`, the check from `ctx.thresholds` and does not import the config. Pauses in rule 1 may only be made stricter in the schema. Protocol constants (SPF, DMARC) and protective limits (redaction, parsing sizes for external content) remain in code.
13. **Dictionaries go in `test/data/`, logic in code.** Everything that changes with the outside world (words and phrases, parameter and cookie names, bot protection and WAF signatures, CMP selectors and indicators, page paths and extensions) lives in YAML alongside `cmp/lexicon.yaml` and `legal/links.yaml`, not in constants. Every top-level key has a zod schema (`dataSection` from `src/core/data/parse.ts`), and the file is included in `test/unit/core/data/sections.test.ts`. The collector obtains values through `loadSection`, the check from `ctx.data` (`data: ['<directory>']`) and the same pure schema, and page code (`in-page/`, `cmp/page/`) receives them as an `evaluate` argument. Logic tables (internal type mappings, Node and Chromium error codes, HTTP/TLS/DNS protocol vocabulary, standard markup) and everything that protects privacy remain in code: the query and header allowlist in `src/core/url` and `src/core/redaction`, and hidden fields in `report-view.ts`.

## Adding a check

An example of a pure check is [contract-example.test.ts](test/unit/core/evaluation/contract-example.test.ts).

1. Create `src/checks/<module>/<id>.ts` and add a line to `src/checks/<module>/index.ts`.
2. Add variants with level and `crm` (catalog code or `null`) to `test/data/ruleset/de-2026/<module>.yaml` and texts to `test/data/texts/{de,en}/<module>.yaml`. Then run `corepack pnpm registry`.
3. Add fixtures:
   - browser: scenario `test/unit/checks/browser/scenarios/<id>.ts` and a line in `scenarios/index.ts`;
   - dns: lines in `test/unit/checks/dns/fixtures.ts`;
   - http: JSON in `test/fixtures/snapshots/http/<ID>/`.

Take the variant names for a planned check from the “Planned checks” table in [README.md](README.md). After `corepack pnpm registry`, the check moves to the implemented table.
