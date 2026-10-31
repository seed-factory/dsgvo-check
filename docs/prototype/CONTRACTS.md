# dsgvo-check prototype: contracts for module agents

This page is written for module agents M1 to M7. It covers what the scaffold provides: interfaces, where types and stubs live, how to register a check, data formats, how to write L1/L2 tests, and the commands. The source of truth for behaviour is still [consensus §2/§4/§5](../consensus/README.md) plus [BRIEF](BRIEF.md). This file is the source of truth for **code shapes**.

Ground rules (from BRIEF):

- Change **only your own paths**.
- Shared contracts change **only additively**. You may add new optional fields. You may not rename or remove anything.
- If you need a change in `src/core/**`, `package.json` or another agent's file, write it in your report.

## 1. Pipeline and file map

```
CLI (src/cli.ts) ─► scan(options) (src/scan.ts)
  validate → preflight (DNS + SSRF) → collectors http/tls/dns (parallel) → browser
  → Snapshot (+ --save-snapshot) → derive() → checks over `requires` slices → assess → gate → report
  → writeReports(): json / html / summary files, console text
```

| Path | Owner | Status after scaffold |
|---|---|---|
| `src/core/**` | scaffold | implemented: report-schema, check, snapshot, assess, gate, fingerprint, registry, data, messages, execute, url, net, collector, reporter, report, user-agent, sanitize |
| `src/scan.ts`, `src/cli.ts`, `src/index.ts`, `src/reporters/{json,console}.ts`, `src/checks/index.ts` | scaffold | implemented |
| `src/collectors/browser/{types,index}.ts` | M1 | types complete; `collectBrowser` = stub (`skipped/not-implemented`) |
| `src/cmp/{types,index}.ts` | M2 | types complete; `adapters = []`, `detectCmp` returns none, `extract` throws, `classifyFirstLayer` returns `banner-not-recognized` |
| `src/derive/{types,index}.ts` | M3 | types complete; `derive()` returns empty classification |
| `src/checks/{browser,http,dns}/index.ts` | M3 / M4 / M5 | empty arrays `browserChecks`, `httpChecks`, `dnsChecks` |
| `src/collectors/{http,tls,dns}/{types,index}.ts` | M4 / M4 / M5 | types complete; collectors = stubs |
| `src/reporters/{html,summary}.ts` | M6 | stubs throw `NotImplementedError` |
| `data/{ruleset/de-2026,texts/de,texts/en,crm}/{browser,http,dns}.yaml` | M3 / M4 / M5 | empty maps, ready to fill |
| `data/ruleset/de-2026/_profile.yaml`, `data/texts/*/core.yaml`, `data/routing.yaml` | scaffold | filled |
| `test/utils/**`, `test/fixture-server/server.ts` | scaffold | implemented |

## 2. Commands

```
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium   # or: node dist/cli.js install
corepack pnpm typecheck        # tsc 7, strict, no emit
corepack pnpm lint             # biome check .  (format: corepack pnpm format)
corepack pnpm test             # unit + integration
corepack pnpm test:unit | test:integration | test:e2e | test:live
corepack pnpm vitest run test/unit/checks/http        # one dir/file
corepack pnpm build            # tsc -p tsconfig.build.json → dist/
corepack pnpm schema           # regenerate schema/report.schema.json (test fails on drift)
node src/cli.ts https://… --out /tmp/out --verbose      # run from source (Node 24 type stripping)
```

TypeScript rules:

- Use relative imports **with a `.ts` extension**. `tsc` rewrites them to `.js`. Example: `import { defineCheck } from '../../core/api.ts'`.
- Type-only imports need `import type`, because `verbatimModuleSyntax` is on.
- `noUncheckedIndexedAccess` is on.
- No `enum`, `namespace` or parameter properties (`erasableSyntaxOnly`).

## 3. Snapshot (`src/core/snapshot.ts`)

```ts
interface Snapshot {
  snapshotVersion: 1; tool; createdAt; target: TargetInfo; options; environment: SnapshotEnvironment;
  plan: { browser: BrowserPlan | null; probes: ProbeRecord[] };
  collection: Partial<Record<'browser'|'http'|'tls'|'dns', CollectorStatus>>;
  diagnostics: DiagnosticInput[];             // SCAN-* raised by collectors
  browser?: BrowserSection;   documents?: DocumentsSection;   cmp?: CmpSection;   // M1 (+M2 facts)
  http?: HttpSection;   tls?: TlsSection;                                         // M4
  dns?: DnsSection;                                                               // M5
  derived?: DerivedSection;                                                       // M3, recomputed, never saved
}
type SnapshotSectionKey = 'target'|'environment'|'plan'|'browser'|'documents'|'cmp'|'http'|'tls'|'dns'|'derived';
type SnapshotSlice<K> = { readonly [P in K]-?: NonNullable<Snapshot[P]> } & { readonly target: TargetInfo };
```

Section types live in these files:

- `src/collectors/browser/types.ts`: `BrowserSection`, `PhaseRecord`, `PageVisit`, `DomFacts`, `RequestRecord`, `CookieRecord`, `StorageRecord`, `ClickRecord`, `ScreenshotRecord`, `BrowserPlan`, `PlannedPage`, `ClickPlan`, `DocumentsSection`, `DocumentRecord`, `DocumentPart`.
- `src/cmp/types.ts`: `CmpSection`, `CmpPhaseFacts`, `CmpFacts`, `CmpDetection`, `CmpButton`, `BlockingFacts`, `ConsentStateFact`, `GeoSignal`, `BotSignal`, `VerifyResult`, `CmpAdapter`, `FirstLayerClassification`, `CmpLexicon`.
- `src/collectors/http/types.ts`: `HttpSection`, `RedirectChain`, `HttpHop`, `DocumentResponse`, `ProbeRecord`.
- `src/collectors/tls/types.ts`: `TlsSection`, `TlsEndpoint`, `CertificateInfo`.
- `src/collectors/dns/types.ts`: `DnsSection`, `DnsQueryRecord`, `DnsAnswer`, `DnsRcode`.
- `src/derive/types.ts`: `DerivedSection`, `ClassifiedRequest`, `ClassifiedCookie`, `ClassifiedStorage`, `ServiceObservation`, `ServiceInfo`, `ServiceCategory`, `DatasetRef`.
- `src/core/snapshot-common.ts`: shared primitives such as `BrowserPhase = 'A'|'B'|'C'`, `Phase`, `HeaderRecord`, `CollectorError` and `CollectorStatus`.

Invariants:

- **D20.** No cookie, Web Storage or TC-String values are stored, not even as hashes. Store lengths only. URLs go through `sanitizeUrl()` from `src/core/url.ts`, which keeps the query allowlist and replaces everything else with `[redacted]`. Generic allowlisted names (`id`, `tid`, `v`, `t`) keep their value only in the expected form (`QUERY_VALUE_RULES`, FP-06); `mailto:` is masked to the domain (S-08). Free text that a collector copies (link text, accessible names, titles, parts of legal documents, DNS TXT) goes through `redactText()` from `src/core/redact.ts`; values of path parameters (`;k=v`, `prefix:k=v&k=v`) and e-mail addresses in the path are redacted by `sanitizeUrl()` too (canary2 G01, G03); a query key or value that holds an address (as text or percent-encoded) is `[redacted]` even for an allowlisted name (S-privacy-3, §18.1). `set-cookie` header values are never stored; store `setCookieNames`. Response headers are stored through the one normalizer `src/core/headers.ts` (HTTP collector and browser, FP-08): values only for security and technical headers, URL headers sanitized, everything else `[redacted]`.
- **Safe request features (D05, 5.3).** The browser collector extracts before redaction `identifierNames`, `matchesStoredIdentifier` (in-memory comparison with cookie and storage values), `sentCookieNames`, `eventType` (`en`/`ev`, `t` only as a UA hit type) and `consentSignals`, and writes `parserVersion` (`request-features/2`) and `observationSource` (`playwright`). `derive` computes `identifier.kind` (`stored-match` / `persistent-param` / `user-supplied` / `per-load` / `none`) from these saved features and the catalog signature, so `--from-snapshot` recomputes it.
- **Time and ids (5.3, S-30).** `RequestRecord`, `CookieRecord` and `StorageRecord` carry `atMs` (ms since `scan.startedAt` on the scan clock `ctx.clock`, one monotonic scale for all phases), `navigationId` (`<phase>-n<k>`, also on `PageVisit`) and `actionId` (`<phase>-a1`, also on `ClickRecord`) after the B/C click; requests also `frameId` and `parentRequestId` (redirect). The older `tStartMs`/`tRef` and cookie `tMs` (relative to navigation or click) stay in the snapshot for the checks but are not exported as evidence.
- A missing section means the check is not run. The status then comes from `snapshot.collection[<collector>]` (see §4.4).

## 4. Check contract (`src/core/check.ts`, import via `src/core/api.ts`)

```ts
interface Check<K extends SnapshotSectionKey> {
  id: string;                         // catalog id, /^[A-Z]+-\d{2}$/, e.g. 'EMBED-01'
  module: 'browser' | 'http' | 'dns'; // decides the data file names and fixture dir
  requires: readonly K[];             // sections the check reads
  variants: readonly CheckVariant[];  // ALL variants it can emit (static)
  data?: readonly string[];           // data/<name>/*.yaml dirs loaded into ctx.data (e.g. 'cmp', 'services')
  run(slice: SnapshotSlice<K>, ctx: CheckContext): readonly Observation[] | CheckOutcome;   // PURE
}
interface CheckVariant { variant: string /* kebab-case */; variantGroup?: string /* default = variant */; maxConfidence?: Confidence }
interface Observation {
  checkId: string; variant: string; confidence: 'high'|'medium'|'low';
  subject: string;                    // fingerprint subject, use `subjects.*` (§6); never the target host
  serviceId?: string; category?: string;   // category enables routing de-dup (§5)
  phases: Phase[]; pages: string[];   // sanitized URLs
  evidence: EvidenceInput[];          // evidence objects without `id` (assess dedups and assigns ids)
  params: Record<string, string|number|boolean|null>;   // message params, safe values only
  trigger?: string; replicated?: boolean; related?: { checkId: string; subject: string; relation?: string }[];
  classification?: { source: string; datasetVersion: string|null };
  provider?: {name, country}; parent?: {name, country}; dpfEntity?: {name, listed, checkedAt, source};
}
interface CheckOutcome {
  status: 'completed'|'partial'|'inconclusive'|'not_applicable'|'skipped';   // 'error' = throw
  reason?: string;                    // e.g. 'banner-not-recognized', 'bot-mode', 'geo', 'tls-blocked', 'no-wordpress'
  limitations?: string[]; observations: Observation[];
  coverage?: { planned?; observed?; evaluated?; note? };
  diagnostics?: { code: `SCAN-${string}`; affects: string[]; params? }[];  // e.g. SCAN-BOTMODE
}
interface CheckContext { now: Date; lang: 'de'|'en'; routing: Record<category, checkId>; data: Record<string, unknown>;
                         options: { strict; assumeRegion: 'eea'|'de'|null; fromSnapshot } }
defineCheck<const K>(check: Check<K>): Check<K>   // infers K from `requires`
```

### 4.1 Rules for checks

- **No I/O.** Biome forbids imports of `playwright-core`, `undici`, `node:fs`, `node:net`, `node:tls`, `node:dns`, `node:http(s)` and `node:child_process` in `src/checks/**`.
- Import only from `src/core/api.ts`. Type-only imports from the `types.ts` files are fine.
- **Severity is not decided by the check.** Severity comes from the ruleset for each `(checkId, variant)`. To express a different level, emit a different `variant`, or a lower `confidence`: `medium` caps the result at `warning`, `low` caps it at `info`.
- Returning a bare array means `status: 'completed'`.
- A thrown exception means `status: 'error'`, reason `exception`. If the check is relevant, the gate adds `check-error:<id>`.
- An `inconclusive` check may still emit an `info` observation, for example CONSENT-04 `banner-not-recognized` (5.5).
- Read the clock only through `ctx.now`.

### 4.2 Assess (`src/core/assess.ts`)

1. **Severity.** `severity = cap(ruleset[checkId].variants[variant].severity ⊕ overrides, confidence)`.
2. **Routing.** A check that owns a category in `data/routing.yaml` (CONSENT-01, EMBED-01…05) has observations with `category` owned by **another** check dropped. Checks outside routing are never dropped: CONSENT-02, CONSENT-03, CONSENT-05, TRACK-01, PRIV-01, HDR-01 and others.
3. **Merging.** Observations with the same fingerprint (`checkId`, `variantGroup`, `subject`) merge into one finding. The finding keeps the highest severity, then the highest confidence. Phases, pages and evidence are unions.
4. **Evidence.** Evidence is deduplicated globally. Ids are `ev-<12 hex>`. At most 20 ids per finding; if there are more, `evidenceTruncated` is set.
5. **Fields.** `crmCode` = `crm[checkId.variant] ?? null`. `messageId` = `checkId.variant`. `legalNoteId` = `checkId`. `related[]` holds findings with the same `serviceId` plus resolved `Observation.related`.
6. **Invalid observations.** An unknown variant, or a variant without a ruleset entry, turns the check status into `error` / `invalid-observation`.
7. **`maxSeverity`.** The maximum over the static variants after ruleset and overrides, **without** the confidence cap (5.2, S-29): a failed check has no confidence. The gate uses it to decide relevance.

### 4.3 Gate (`src/core/gate.ts`)

`gate(GateInput) → { exitCode: 0|1|2, exitReasons[] }` is pure and follows table 5.2.

- **Priority.** fatal (2) > `threshold` (1) > `check-error:<id>`, `timeout`, `strict:*` (2) > 0.
- **Relevant check.** `gating`, enabled, and `maxSeverity ≥ failOn`.
- **`--fail-on none`.** No threshold and no relevant checks, so neither `threshold` nor `check-error:*`. `--strict` acts independently (5.2, S-09): `strict:sandbox-off`, `strict:egress-unverified` and `strict:inconclusive:<id>` still give 2. Under `none` the strict scope for `inconclusive` is enabled gating checks with `maxSeverity ≥ warning`, so `none` is never stricter than `--fail-on warning`.
- **Fatal reasons.** `unreachable`, `blocked`, `timeout` (global `--timeout` before phase A finished the start page, S-10), `sandbox-unavailable`, `invalid-input` (also used for `browser-unavailable`), `internal-error`, `report-write-failed`.

### 4.4 Missing sections (`src/core/execute.ts`, `executeCheck`)

| `snapshot.collection[x]` | check status / reason |
|---|---|
| `skipped` (for example `not-implemented`, `tls-blocked`) | `skipped` / that reason |
| `ok`, `partial` or `error`, but the section is absent | `error` / `collector-error:<x>` → `check-error` if relevant |
| collector timed out | `error` / `timeout` |
| `not-run` (not needed) | `skipped` / `not-collected` |

After a global timeout (`snapshot.collection.browser.reason = 'timeout'`) an `inconclusive` result without observations becomes `error` / `timeout` only when the phase its reason belongs to was cut: the record is missing, or is `skipped`/`partial` with `timeout` or `time-budget`. The reason maps to the phase (`REASON_PHASES` in `execute.ts`): `insufficient-pages`, `no-evaluable-pages`, `no-pre-consent-observation`, `no-network-observation` to A; `phase-b-missing`, `no-reject-click`, `reject-not-confirmed` to B; `phase-c-missing` to C; `cmp-not-observed` to A or B. A phase that ended by itself keeps the `inconclusive` reason when only a later phase was cut (R08).

**When a collector reports `ok` or `partial`, it MUST deliver all of its sections, even if they are empty.** The browser collector must always deliver `browser`, `documents` and `cmp`.

## 5. Registering a check (example M5)

1. Create `src/checks/dns/mail-01.ts`:

```ts
import { defineCheck, subjects } from '../../core/api.ts';
export const mail01 = defineCheck({
  id: 'MAIL-01', module: 'dns', requires: ['dns'],
  variants: [{ variant: 'record-not-found' }, { variant: 'policy-none' }, { variant: 'record-invalid' }, { variant: 'weak-option' }],
  run(slice, ctx) {
    const q = slice.dns.queries.find((x) => x.purpose === 'dmarc');
    if (!q) throw new Error('no DMARC query in snapshot');           // → status error, check-error:MAIL-01
    if (q.rcode === 'SERVFAIL' || q.rcode === 'TIMEOUT') throw new Error(`DMARC lookup ${q.rcode}`);
    if (q.rcode === 'NXDOMAIN' || q.answers.length === 0) return [{
      checkId: 'MAIL-01', variant: 'record-not-found', confidence: 'high', subject: subjects.record('dmarc'),
      phases: ['dns'], pages: [], params: { domain: slice.dns.domain },
      evidence: [{ type: 'dns', qname: q.qname, qtype: q.type, rcode: q.rcode, records: [] }],
    }];
    return [];
  },
});
```

2. Add it to `src/checks/dns/index.ts`: `export const dnsChecks: readonly AnyCheck[] = [mail01];`.
3. Data (§7):
   - `data/ruleset/de-2026/dns.yaml`: `checks: { MAIL-01: { gating: true, variants: { record-not-found: {severity: warning}, … } } }`.
   - `data/texts/de/dns.yaml` and `data/texts/en/dns.yaml`: `messages['MAIL-01.record-not-found'] = {title, body}`, plus `legalNotes['MAIL-01']`.
   - `data/crm/dns.yaml`: `mapping: { MAIL-01.record-not-found: T3_MAIL_UNPROTECTED, … }`. Use an explicit `null` where there is no code.
   - Variant names come from the registry `docs/03-checks.md` §2.1. `test/unit/core/registry-spec.test.ts` (L0, FT-09) parses that table and fails when a `checkId.variant`, its default severity or its `locked` mark differs from ruleset, check declaration, texts or crm.
4. Fixtures: `test/fixtures/snapshots/dns/MAIL-01/` with `violation*.json`, `clean*.json` and `inconclusive*.json` or `error*.json`, each with `$expect` (§8.1).
5. Targeted tests go in `test/unit/checks/dns/mail-01.test.ts`. Include the "соседняя ложная находка" counterexample. A compiled, runnable copy of this example with its L1 tests is `test/unit/core/contract-example.test.ts`.
6. Run `corepack pnpm test:unit`. `registry-completeness.test.ts` lists every gap at once; it also keeps the list of variants that no fixture expects (FT-08), which may only shrink.

## 6. Fingerprint (`src/core/fingerprint.ts`)

`fingerprint({checkId, variantGroup, subject})` = `"sha256:" + hex(sha256(JCS({v: 1, …})))`. Build subjects with `subjects.*`:

- `service(serviceId | null, thirdPartyEtld1?)` gives the `serviceId`, or `unknown:<etld1>`. Used by CONSENT-01/05/06, TRACK-01, EMBED-*, PRIV-01.
- `cookie({name, firstParty, etld1, path, partitioned})` gives `name|first-party or etld1|path|partitioned`. Used by CONSENT-02 and HDR-02.
- `storage({storageType, key, firstParty, etld1})`
- `header(name)` for HDR-01. `record('dmarc'|'spf')` for MAIL-*. `document('impressum'|'privacy')` for LEGAL-01. `consentUi()` for CONSENT-03/04.
- `tlsEndpoint('http-entry'|'certificate', tlsHostRole(host, finalHost))` for TLS-01 / TLS-02 (5.4, S-37): `http-entry:final`, `certificate:pair` and so on. The role is relative to the final host of the start page (the HTTP start chain, else `target.finalHost`, else the target host): `final`, `pair` (the other host of its www/apex pair), or `www`/`apex` for hosts outside that pair. The same endpoint gets the same fingerprint whether `example.de` or `www.example.de` was typed. `tls(kind, hostVariant)` is deprecated and unused.

These never contain the target host, pages, phase, time, query, values or severity.

## 7. Data files

All files under `data/` are merged per directory, one file per module. **A duplicate key across files is an error.**

| Path | Format |
|---|---|
| `data/ruleset/de-2026/<module>.yaml` | `checks: { ID: { gating: true, variants: { <variant>: { severity: critical\|warning\|info, gating?: bool } } } }`. Profile metadata is in `_profile.yaml` (`version` 2026.10.0, `draft: true`). |
| `data/texts/{de,en}/<module>.yaml` | `draft: true` at file level; `messages: { 'ID.variant': { title, body, draft? } }`; `legalNotes: { ID: { text, status: authority-consensus\|court-first-instance\|court-appellate\|contested\|technical, reviewedAt, reviewBy } }`. |
| `data/crm/<module>.yaml` | `mapping: { 'ID.variant': T1_… \| null }`. Must match `/^T\d_[A-Z_]+$/` or be explicit null. Appears only in JSON. |
| `data/routing.yaml` | `owners: { <category>: <checkId> }` (scaffold) |
| `data/<name>/*.yaml` | Free-form. Loaded only when a check lists `data: ['<name>']`. Merging rules: objects deep-merge, arrays concatenate, conflicting scalars are an error. Validate with zod inside your check or derive. For example `data/services/**` (M3) and `data/cmp/**` (M2). |

**Templates** (`src/core/messages.ts`, a subset of ICU MF1):

- `{param}`
- `{n, number}`
- `{n, plural, =0 {…} one {# Seite} other {# Seiten}}`
- `{x, select, a {…} other {…}}`
- `''` for a literal apostrophe

The de and en texts of a variant must use the same parameters.

**Wording.** Use "beobachtet" and "nicht gefunden in …". The stop-word test (`test/unit/core/stopwords.test.ts`) forbids these words, case-insensitive, in de and en: verstößt/Verstoß, rechtswidrig, unzulässig, DSGVO-konform, datenschutzkonform, rechtskonform, illegal, violates/violation, unlawful, non-compliant, in breach. Comment lines (`#`) are ignored.

**Diagnostic texts** live in `data/texts/*/core.yaml` under `messages['diagnostic.SCAN-…']`. If you need a new `SCAN-*` code, ask the integrator.

## 8. Tests

### 8.1 L1: pure, no network (`test/utils/snapshot-builder.ts`)

- **Snapshot factories:**
  - general: `makeSnapshot(partial)`, `makeTarget(url)`
  - browser: `makeBrowser`, `makePhase(phase, p)`, `makePage({url})`, `makeRequest({url})`, `makeCookie({name})`, `makeStorage({key})`, `makeDom`, `makeLink({text})`, `makeBrowserPlan`
  - documents: `makeDocuments`, `makeDocument({kind})`
  - CMP: `makeCmp`, `makeCmpFacts`
  - HTTP: `makeHttp`, `makeChain({startUrl})`, `makeHop({url})`, `makeDocumentResponse({url})`
  - TLS: `makeTls`, `makeTlsEndpoint`, `makeCert`
  - DNS: `makeDns`, `makeDnsQuery({qname})`
  - derive: `makeDerived`, and `withDerived(snapshot)`, which runs the real `derive()`.
  - `makeSnapshot` sets `collection.<x> = ok` for every section you pass.
- **Running checks:**
  - `checkContext(p)`: fixed clock `2026-10-30T12:00Z`, `de`, real routing, `dataDirs`.
  - `runCheck(check, snapshot, ctx?)` returns an `ExecutedCheck` (status and missing sections handled exactly as in the orchestrator).
  - `observationsOf(result)` and `variantsOf(result)`.
- **Fixture file** `test/fixtures/snapshots/<module>/<ID>/<kind>[-suffix].json`, where `<kind>` is `violation`, `clean`, `inconclusive` or `error`:

```json
{ "$description": "…", "$expect": { "status": "completed", "variants": ["fonts-loaded"], "reason": "optional" },
  "target": { …optional TargetInfo… }, "browser": { … }, "derived": { …optional, else computed… } }
```

  - `loadFixture(module, id, file)` and `loadFixtures(module, id)` fill defaults through `makeSnapshot`.
  - `registry-completeness` executes **every** fixture and compares `status` with the sorted, unique `variants`. A `violation*` fixture must emit at least one variant.
- **Reports for reporter tests (M6):** `test/utils/report-fixtures.ts`:
  - `sampleFullReport()` contains every evidence type, a crmCode and hostile strings.
  - `sampleFailedReport()`.
  - `HOSTILE_TEXT`.
- **Ajv:** `test/utils/report-validator.ts` provides `expectValidReport(report)` and `validateReport(report)`. They check against `schema/report.schema.json`.

### 8.2 L2: real Chromium, local servers, no internet (`test/README.md`)

- **Fixture server.** `startFixtureServer({ sites: ['<module>/<site>'], handlers?, routes?, tls? })` in `test/fixture-server/server.ts` serves sites from `test/fixture-server/sites/<module>/<site>/hosts.json`.
  - It returns `{ httpPort, httpsPort, pki, requests, unexpected, browserInternal, network(), browserArgs(), requestsTo(host), addHandler, addRoute, reset, close }`.
  - Helpers: `setCookieHandler(match, cookies)` and `redirectHandler(match, location, status)`.
- **Network config.** `server.network()` returns a `NetworkConfig` for `scan()` and the collectors:
  - `lookup` resolves to 127.0.0.1, and `allowPrivateAddresses: true`.
  - `test.connect(host, port)` maps to the random ports.
  - `test.browserArgs` carries `--host-resolver-rules` and the SPKI allowlist.
  - `test.caPem` holds the test CA.
- **Test browser.** `launchTestBrowser(server)` in `test/utils/browser.ts` launches CfT new headless with a fresh persistent profile, `de-DE` and `Europe/Berlin`. It also records `requests`.
- **Undici.** `testDispatcher(network)` in `test/utils/network.ts` is the reference undici Agent that honours `test.connect` and the test CA.
- **Certificates.** `createTestPki()` in `test/utils/certs.ts` provides `issue({hosts, notBefore, notAfter, selfSigned, ownKey})` and `issueKind('valid'|'expired'|'expiring'|'wrong-name'|'self-signed', hosts)`.
- **DNS (M5).** Start dns2 on `127.0.0.1:0` and pass `network: { ...server.network(), dnsServers: ['127.0.0.1:<port>'] }`.
- **Assertions.** In every L2 test, `expect(server.unexpected).toEqual([])`.
- **Execution.** The integration project runs files sequentially with a 120 s timeout. Do not close pages that show `chrome-error://`; close the context instead.

## 9. Collector contract (`src/core/collector.ts`)

```ts
type BrowserCollector = (ctx: CollectorContext) => Promise<CollectorResult<{ browser?; documents?; cmp?; plan?: BrowserPlan; finalUrl?: string }>>;
type HttpCollector    = (ctx) => Promise<CollectorResult<{ http?: HttpSection }>>;
type TlsCollector     = (ctx) => Promise<CollectorResult<{ tls?: TlsSection }>>;
type DnsCollector     = (ctx) => Promise<CollectorResult<{ dns?: DnsSection }>>;
interface CollectorContext { target: TargetInfo; options: { maxPages; screenshots; sandbox: 'require'|'off'; lang; assumeRegion };
  network: NetworkConfig; userAgent: { http: string; token: string }; signal: AbortSignal; deadline: number;
  artifactsDir: string; artifactsRelDir: 'artifacts'; now(): Date; clock?(): number; log: Logger; snapshot: Readonly<Snapshot> }
interface CollectorResult<S> { status: 'ok'|'partial'|'error'|'skipped'; reason?; sections: S;
  diagnostics?: DiagnosticInput[]; probes?: ProbeRecord[]; error?: CollectorError;
  fatal?: { reason: 'unreachable'|'blocked'|'sandbox-unavailable'|'browser-unavailable'|…; code; message } }
```

- `ctx.target` carries the **raw** target URL (query included) for navigation only; `ctx.snapshot.target` and everything stored is redacted (S-04, D20).
- `ctx.clock()` is ms since `scan.startedAt` on a monotonic clock: the one scale of 5.3 `tMs`. A collector run without the orchestrator starts its own clock (tests).

### 9.1 Order, timeout and fatal errors

- http, tls and dns run in parallel first. The browser runs afterwards, and `ctx.snapshot` holds their sections.
- If the target's own TLS endpoint (`hostVariant: 'target'`, no `role`, at whatever port it was probed — an explicit port of the target URL counts, S-20) has `authorized: false` and the error is not only an incomplete chain, the browser is skipped with reason `tls-blocked`. M1 also returns `skipped/tls-blocked` itself when navigation hits `ERR_CERT_*` — this covers the final host after a cross-domain redirect, whose certificates the HTTP collector records in `http.finalTls` (S-19). TLS-02 therefore `requires: ['tls', 'http']`.
- On timeout, `ctx.signal` aborts. The orchestrator waits up to `ABORT_GRACE_MS` (10 s) for the collector's result: collectors return what they have (status `partial`, reason `timeout`) and the facts gathered before the abort are kept (S-11). A fatal that arrives after the abort is ignored. A timeout before phase A finished the start page is fatal `timeout` (`failed`, `SCAN-TIMEOUT`, exit 2; S-10).
- Return `fatal` for start-page conditions:
  - unreachable: NXDOMAIN, refused on both 80 and 443, timeout, or 5xx twice;
  - blocked: WAF, challenge or 403;
  - the sandbox did not start under `require`;
  - the browser is missing.
- The scan then fails with exit 2. Results that other collectors already gathered stay in the report.

### 9.2 Network

`NetworkConfig` (`src/core/net.ts`) is `{ proxy, allowPrivateAddresses, lookup, dnsServers, test? }`.

- **Tests.** Honour `test.connect`, `test.caPem` (TLS trustStore `'test'`) and `test.browserArgs` (append them to the Chromium args) whenever `network.test` is set.
- **SSRF guard.** Use `classifyAddress(ip)` and `isPublicAddress(ip)` (NAT64, 6to4 and Teredo are unpacked; `fec0::/10` is private, FP-04). Preflight refuses a target with any non-public address (`target-not-public`, `target-mixed-addresses`, FP-05). The browser blocks non-public addresses and names that do not resolve locally (fail-closed, S-01) for top-level documents, frames and popups through a browser-level CDP `Fetch` session (FP-01), unless `allowPrivateAddresses` is true. 429 on the start page after the retry is `SCAN-THROTTLED`, not a fatal (FC-06).

### 9.3 User-Agent and pacing

- HTTP and TLS use `ctx.userAgent.http`.
- The browser uses `browserUserAgent(chromeUa)` from `src/core/user-agent.ts`, which is the real Chrome UA plus the token. Pair it with `ACCEPT_LANGUAGE`.
- Navigations run one at a time with at least 1.5 s between them. HTTP probes are limited to 2 requests per second per host.

### 9.4 Browser (M1)

- Launch with `chromium.launchPersistentContext(tmpdir, { channel: 'chromium', headless: true, chromiumSandbox: ctx.options.sandbox === 'require', locale: 'de-DE', timezoneId: 'Europe/Berlin', args })`. Use a fresh profile per phase.
- Fill `engine.sandbox` and `disabledFeatures`.
- Write screenshots to `ctx.artifactsDir`. The path in the snapshot is relative to the out dir, for example `artifacts/banner-B.jpg`.

## 10. CMP (M2) and derive (M3)

### 10.1 CMP

```ts
interface CmpAdapter {
  id; name; supportedVersions;
  detect(page); extract(page, moment); state(page); geoSignals(page); botSignals(page); firstLayer(page);
  act?(page, action: 'reject'|'accept', target: ClickTarget | null): Promise<ClickOutcome>;   // D12
  reject(page, opts?: ActOptions); accept(page, opts?: ActOptions);   // ActOptions.target = the same decision
  verify(page, action, opts?: { reload?: boolean });
}
```

D12 after round 4b: the adapter is `extract / act / verify` and decides nothing. What counts as reject or accept, whether the banner blocks and where to click is decided only by the pure `classifyFirstLayer(facts, lexicon)` in core; the collector writes the choice to `plan.click[phase].target` and passes exactly that target to `act` (S-31). `null` means nothing is clicked (`no-unambiguous-<action>`). Without a target and without facts the adapter never measures and picks a button on its own (`no-target`). `verify` gives `origin: action` only for an answer the click produced (S-14); default-denied without a recorded answer is no reject.

`src/cmp/index.ts` exports:

- `adapters: readonly CmpAdapter[]`
- `detectCmp(page) → { adapter | null, detection }`
- `extract(page, adapter | null, moment) → CmpFacts`
- `classifyFirstLayer(facts, lexicon) → FirstLayerClassification`, which is **pure** and has no page access. Checks may import it.

Recognition with `high` needs at least 2 independent signals.

### 10.2 Derive

`derive(snapshot: Snapshot) → DerivedSection` in `src/derive/index.ts` must be pure. Load the catalog synchronously from `data/services/**`, for example with `loadDataDir('services')`. Fill `datasets[]`; it goes into report `datasets[]`. The orchestrator runs `derive` only when `snapshot.browser` exists.

## 11. Reporters (M6) and programmatic API (M7)

### 11.1 Reporters

`type RenderReport = (report: Report, ctx: ReporterContext) => string`, where `ReporterContext = { texts, lang, outDir, color }`. It lives in `src/core/reporter.ts`.

- **HTML.** `renderHtml` writes `report.html`: one file, no JS, CSP `default-src 'none'`, no `T[0-9]_`.
- **Summary.** `renderSummary` writes `summary.md`. It is also appended to `$GITHUB_STEP_SUMMARY` when that variable is set.
- **Labels and escaping.** Take labels from `uiText(texts, key)`. Run external strings through `sanitizeExternal`, then apply HTML or Markdown escaping.
- **Rendering texts.** `renderMessage(texts, messageId, params)`.
- **Failures.** A requested file that fails to render or write gives exit 2 with `report-write-failed`.
- **Disclaimer.** The composition of the conditional paragraphs is pure and lives in `src/core/disclaimer.ts` (re-exported by `src/reporters/disclaimer.ts`). `buildFullReport` / `buildFailedReport` compose `report.disclaimer.text` already in memory (FP-11); every reporter composes again from the final report, starting from the same base, so a changed condition (exit reasons after a failed write) replaces its paragraph instead of adding a second one. The CLI writes its own minimal failed report with the same composition, and `--help` ends with the Nutzungshinweise from `data/texts/de/core.yaml` (`usageNotes`).

### 11.2 Programmatic API

From `src/index.ts`:

- `scan(options: ScanOptions): Promise<{ report, snapshot, exitCode }>`. It never throws for scan problems.
- `writeReports(result, { outDir, formats, lang, color? })` returns `{ exitCode, written, errors, console }`.
- `ScanOptions` includes the CLI options `url`, `failOn`, `formats`, `outDir`, `maxPages`, `timeoutMs`, `proxy`, `assumeRegion`, `lang`, `strict`, `sandbox`, `screenshots`, `saveSnapshot`, `fromSnapshot`, `checks` and `overrides`. It also includes the programmatic-only options `network`, `dataDir`, `now`, `registry`, `collectors` and `log`.

## 12. Report schema (`src/core/report-schema.ts`)

- The zod 4 schema is the source. It emits JSON Schema 2020-12 to `schema/report.schema.json` with objects open.
- `SCHEMA_VERSION = '0.2.0'` (0.1.0 → 0.2.0 in the review: `request` evidence per 5.3, S-30).
- **Closed enums:** `severity`, `confidence`, check `status`, `scan.status` and exit reasons.
- **Known evidence types:**
  - `request`, `cookie`, `storage`, `header`, `dns`, `tls`
  - `cmp`, `consent-state`, `document`, `text-match`
  - `screenshot`, `page`, `redirect-chain`, `link`
- **Unknown evidence types.** Any other lower-case type passes the schema, but `EvidenceInput` is typed only for the known types. To add a new type, ask the integrator.
- **`request` evidence (5.3).** `url`, `method`, `resourceType`, `initiator?`, `phase`, `page`, `tMs?` (scan scale), `navigationId?`, `actionId?`, `frameId?`, `frameUrl?`, `parentRequestId?`; required `delivery` (`attempted / blocked-by-browser / sent`) and `result` (`response {status} / failed {errorText} / aborted / none`), independent of each other; `provenance?` (`network / service-worker`; cache is not distinguished in the prototype); required `features {identifier {kind, param?}, matchesStoredIdentifier, eventType?, consentSignal? {gcs, gcd, npa, dma, adStorage, analyticsStorage}, parserVersion, observationSource}`; `thirdPartyETLD1`, `serviceId?`, `connectedIp?`. Build it only with `requestEvidence(record, classification)` from `src/checks/browser/shared.ts`: the same request gives the same evidence and id in every check. A body error after the response keeps `result: response` (S-17). The legacy `state`, `status`, `tStartMs`, `tRef` and `identifierPresent` are not exported.
- **`cookie` / `storage` evidence.** `tMs` is the scan-scale `atMs` of the record, plus `navigationId?` and `actionId?`.
- After an additive change, run `corepack pnpm schema`.

## 13. Known gaps of the scaffold

- All collectors, CMP adapters, derive, HTML and Summary are stubs. A real scan therefore reports every check as `skipped/not-implemented`, which is not possible yet anyway with an empty registry, and exits with 0.
- Suppressions and baseline have schema fields but no logic.
- There are no phases A′ or M and no egress proxy. These gaps are listed in `scan.environment.knownGaps`.

## 14. Changes made during integration (2026-10-30)

All changes are additive or tighten behaviour that the consensus already required. Current state: [STATUS.md](STATUS.md).

| Area | Change |
|---|---|
| `src/core/url.ts` | `ev` (Meta Pixel event name) is in `QUERY_ALLOWLIST`; the browser collector uses the same list. |
| `src/core/data.ts`, `src/core/assess.ts`, `src/scan.ts` | Ruleset variants may carry `locked: true` (5.4/5.5). Overrides never change a locked variant; an override rule that names one is `invalid-input` / `locked-override` (exit 2). |
| `src/core/report-schema.ts` | `tls` evidence: optional `port`, `cipher`, `lifetimeDays`, `hostnameMatches`. `datasets[]`: optional `attribution` (5.8). Schema regenerated. |
| `src/scan.ts` | Browser skipped with `tls-blocked` only for real certificate errors: an incomplete chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `chainComplete: false`, host name matching) no longer blocks it. `target.finalUrl` falls back to the HTTP start document when the browser did not run. `derive()` gets `dataDir`. `--proxy` accepts only `http://` (D11). |
| `src/collectors/browser/screenshot.ts` | The D20 crop uses `CmpFirstLayer.containerBox` from M2; `containerUnambiguous: false` → no screenshot (`container-ambiguous`). |
| `src/collectors/browser/cmp-bridge.ts` | Typed against `typeof import('src/cmp/index.ts')`: a signature change in M2 is a compile error. |
| `src/checks/browser/consent-04.ts` | Imports the pure `classify.ts` / `lexicon.ts` instead of `src/cmp/index.ts`. `test/unit/core/import-graph.test.ts` (L0) follows runtime imports of every check transitively and forbids browser, network and fs modules. |
| `src/reporters/html.ts`, `data/texts/{de,en}/report.yaml` | HTML and Job Summary labels live in data (D22); the code keeps only the key list `REPORT_LABEL_KEYS`. |
| `src/collectors/browser/launch.ts`, `Dockerfile` | Inside the image (`DSGVO_CHECK_CONTAINER=1`) a sandbox failure prints the exact `seccomp-profile` and `docker run` lines (D25). |
| `src/index.ts` | Exports `createLogger`, `silentLogger`, `Logger`. |
| `test/fixture-server/server.ts` | `connectivitycheck.gstatic.com` is a browser-internal host. |
| `test/integration/pipeline/**`, `test/fixture-server/sites/pipeline/**` | L2 of the whole browser side (M1 collector + M2 CMP + derive + M3 checks + M6 reporters) on a shop with the Cookiebot simulator. |
| `test/live/smoke.test.ts` | Live smoke of the built CLI (`corepack pnpm test:live`, not part of `pnpm test`). |

## 15. Changes after the review (2026-10-30)

Review consensus: [review/CONSENSUS.md](review/CONSENSUS.md); every finding with its test: [review/FIXES.md](review/FIXES.md). Contract changes, by area:

| Area | Change |
|---|---|
| `src/core/report-schema.ts` | `SCHEMA_VERSION` 0.2.0. `request` evidence per 5.3 (§12); `cookie`/`storage` `tMs` on the scan scale with `navigationId`/`actionId`. |
| `src/core/collector.ts`, `src/scan.ts` | `CollectorContext.clock` (scan clock). Abort grace `ABORT_GRACE_MS` 10 s; fatal `timeout`. `tlsBlocked` uses the target endpoint at any port. |
| `src/collectors/browser/{recorder,jar,visit,collector}.ts` | Records carry `atMs`, `navigationId`, `actionId`, `frameId`, `parentRequestId`, `parserVersion`, `observationSource`; a body error keeps `result: response`; `ERR_ABORTED` before a response is `result: aborted`. |
| `src/collectors/browser/cmp-bridge.ts` | `act(page, adapter, action, plan.click target, url)` → `adapter.act(page, action, target)` (S-31). |
| `src/core/headers.ts` | One header normalizer for the HTTP collector and the browser (FP-08). |
| `src/core/fingerprint.ts` | `subjects.tlsEndpoint` + `tlsHostRole` used by TLS-01/02 (S-37). |
| `src/core/assess.ts`, `src/core/gate.ts` | `maxSeverity` without confidence cap (S-29); `--strict` independent of `--fail-on none` (S-09). |
| `src/core/disclaimer.ts`, `src/cli.ts`, `data/texts/*/core.yaml` | Disclaimer composed in core; Nutzungshinweise in `--help` and README (FP-11). Diagnostic texts use `{count}`/`{addressClass}`. |
| `src/checks/browser/shared.ts` | `hasPhaseA` needs an evaluable page; `noPhaseAReason`, `throttleAware` (FC-06, S-27); `requestEvidence(record, classification)`. |
| Tests | L0 `registry-spec.test.ts` (§2.1 registry, FT-09); stop words of guide rules 2/3/6/10/13 in all texts and rendered reports (FP-10); variant-fixture ratchet (FT-08). |

## 16. Changes after the canary2 triage (2026-10-30)

Run `20261030-canary2` (100 sites, frozen `dist`), triage and fixes: [canary/TRIAGE.md](canary/TRIAGE.md). Groups `Gnn` are the groups of that triage. All fields below are optional or additive; `SNAPSHOT_VERSION` 1 and `SCHEMA_VERSION` 0.2.0 stay, older snapshots load and give the old behaviour (a missing fact is "unknown", never a finding). Entries marked `Rnn` were changed or added by the review of these fixes (2026-10-31, [canary/TRIAGE.md](canary/TRIAGE.md) §7); the contract-visible ones are in place in §4.4 and §16.2–16.6.

### 16.1 Redaction and free text (G01, G02, G03)

| Area | Change |
|---|---|
| `src/core/redact.ts` (new, exported by `src/core/api.ts`) | `redactText(text, allowlist?)`, `maskEmails`, `maskMailto`. `mailto:local@d` → `mailto:[redacted]@d` with one prefix per recipient (DMARC `rua`), headers dropped; bare `local@d` → `[redacted]@d`; every `http(s)://` substring goes through `sanitizeUrl`. Idempotent, linear. A `mailto:` value ends at whitespace and at `;` (the tags of a DMARC record after an address survive). Phone numbers are not masked (open question, STATUS §5). Review S-privacy-2…5: see §18.1 for the local part, the quotes, `mailto: ` with a space and the lenient decoding of path segments. |
| `src/core/url.ts` | `sanitizeUrl` redacts values of path parameters after the query: matrix `;name=value`, the first part of a segment with `=`, and `prefix:k=v&k=v` segments (names of the query allowlist keep their value under the same rules). E-mail addresses in the path (also a nested `mailto:` or `%40`) are masked. Applies to every URL field of the snapshot. |
| `src/collectors/browser/features.ts` | `pathParameters` reads identifier names from the RAW path before redaction (`identifierNames`; values only in memory). Names: `IDENTIFIER_PARAMS` and `PATH_IDENTIFIER_PARAMS`; whether a name is a persistent identifier is decided by `identifierParams` of the catalog signature. |
| `src/collectors/browser/{dom,util,documents}.ts` | Link text, accessible name, title, `h1`, iframe title, placeholder text and document parts (`parts[].text`, `parts[].section`) are redacted before they are stored or hashed; `sha256` covers the redacted text. |
| `src/collectors/dns/collect.ts` | TXT answers go through `redactText` (the local `maskMailto` of `src/checks/dns/lib/records.ts` is gone). `chunks` are re-cut from the redacted value. |
| `test/unit/core/fixture-redaction.test.ts` (L0) | Fails when a browser fixture holds an address with a local part, a `mailto:` recipient or an identifier/address in the path of an http(s) URL. Synthetic fixtures of other zones store `[redacted]@example.test`, as the collector writes it. |

### 16.2 Browser collector (G04, G23, G35, G49–G57)

| Area | Change |
|---|---|
| `DomFacts.linksTruncated?` / `RawDomFacts.linksTotal`, `linksTruncated` | Set when the page has more links than `maxLinks` (1500). Collection reads a priority pass first (links with legal keys in any region, then footer, banner, header, nav; at most 2× `maxLinks`), then the rest in DOM order; the list keeps document order. LEGAL-01 gives the limitation `<kind>-links-truncated` for such a page, never "missing". |
| `RawDocument.expandablesIgnored?` | Collapsed elements outside the document text (nav, aside, search, menus, CMP banner, header/footer outside main) are counted here, not in `expandablesFound`; their text gets no `expandable` origin. The header or footer of a component (`<component>-header` / `<component>-footer` in `id` or `class`: accordion, collapse, card, panel, expansion, faq, toggle, tab; for the ambiguous nouns item, entry, post, article, section, block only the `-header`) is no page chrome (R01, S-L-B); `site-header`, `id="header"`, `header-menu`, `section-footer`, a bare `<header>`/`<footer>` outside main and `role=banner`/`contentinfo` still are. One rule for headings, the first `h1` and collapsed panels (S-legal-1, S-legal-2, §18.2). |
| `DocumentRecord.manifest.framesFound?` | All child frames of the page (readable, unreadable, foreign origin). PRIV-01 writes it into the `document` evidence only when the snapshot has it. |
| `cookieHookInit` / `RawCookieWrite` | Each log entry also has `host` (`location.hostname` of the writing document; `null` for `about:blank`) and `domain` (parsed `Domain=` attribute, lower case, no leading dot, or `null`); also for `cookieStore.set({domain})`. `JarTracker` takes the domain of an `attempted` cookie from `domain ?? host` of the document, not from the host of the script (`setterHost`/`setterUrl` stay the script). The document of an `about:blank` or `about:srcdoc` frame has the host of its nearest ancestor frame with an http(s) URL (`documentHostOf`, R13); any other URL without a host (`data:`, `blob:`, opaque) stays unknown, and without a known host and a `Domain=` no `attempted` record is made (the context cannot be checked) and the setter stays `unknown`. |
| `SetCookieOrigin` (`recorder.ts`) | Keyed by `name\|domain\|path\|partition`; fields `name`, `domain?`, `path`, `partitioned`, `at`, `afterClick?`. The setter of a jar cookie is `http-response` only when name, domain, path and partition match; otherwise a script write that can have set that domain, else `unknown`. `afterClick` is set when a response to a request started after the click writes the same key (the setter, the first writer, does not change); the HTTP write after the click is read from it, so only the cookie with that exact key gets an `afterClick` record, not every cookie of the same name (R06). The flag is also set retroactively: a late `markClickAt` flags the origins that the response of a re-marked request has already written (S-requests-1). Optional internal `rejected?: true`: the `Domain=` is not allowed to the response host (RFC 6265 5.3), see §18.3. |
| `NetworkRecorder`, `JarTracker` | New options `{ metaTimeoutMs?, signal }` for `NetworkRecorder` and `{ evalTimeoutMs?, signal, onError }` for `JarTracker`: `new JarTracker(target, setCookieOrigins, options?)` (the by-name callback in the third position is gone, R06). `flush({ timeoutMs?, signal? })` returns `boolean` (`false` = the wait was abandoned; the pending handlers no longer change records). The per-page wait of `visitPage` passes no `timeoutMs` (R30): it is bounded only by the page budget (`bounded()`, `recorder-flush-timeout`), the response handlers live out their own `metaTimeoutMs`, and handlers that are still pending are abandoned by the flush at the end of the phase (`collector.ts`) and by `dispose()`. `settleWithin` with `Infinity` waits for the promise (no 1 ms timer). Reads that run out of time end up in `PhaseRecord.errors` (`recorder-flush-timeout`, `response-headers-timeout`, `server-address-timeout`, `dom-collect-timeout`, `in-page-read-timeout`). |
| `RequestRecord` | `fromServiceWorker` is the INITIATOR of the request (G33); who answered is `provenance` (`network`, `service-worker`, `http-cache`, `memory-cache`) and `state`. derive treats a request issued by a service worker and answered by the network as delivered. |
| `DocumentsSection.attempts[].outcome` | New value `unconfirmed` (a substantive page that could not be confirmed as the document; neither found nor soft-404). A document with the error `unconfirmed` is no usable document (`usableDocument`). `DocumentRecord.lang` is the language of the heading markers, the `lang` attribute is the fallback. |
| `BrowserCollectorDeps` | New `closeBudgetMs` (3 s), `abortOrderlyMs` (5.5 s), `lookupBackoffMs`. Failure code `browser-no-handover` (the collector returned nothing within the abort grace). Collector result `partial` carries `reason` (`time-budget`, `throttled`, `request-cap`, `timeout`, `phase-failed:<phase>`); phases not run after the deadline are `skipped`/`timeout`. The global abort is always `timeout` (a phase A cut while pages are queued is `partial`/`timeout`; a start navigation of B cut by the abort is `partial`/`timeout`, not `failed`); `time-budget` is only the local reserve before it (R27). A fallback probe of the legal pages skipped for lack of time makes phase A `partial`/`time-budget`, as a cut queue does (R09). |
| `SCAN-*` params | `SCAN-BLOCKED`: `count`, `page`, `pages`, `phase`, `kind`, `signals` and `affects` by page role; `SCAN-TIMEOUT`: `count`; `SCAN-PRIVATE-REQUEST-BLOCKED`: `unresolved`, `nonPublic`, `hasLookupCodes`, `lookupCodes`, `lookupFirstAtMs`, `recovered`. A refusal made good by the repeated navigation to the start page of the same phase is not counted and leaves no diagnostic; when other refusals remain, `recovered` names how many were loaded after the repeat (R28). The request record keeps `blockedByGuard`. Transient lookup codes (`EAI_AGAIN`, `ETIMEOUT`, …) are retried with backoff (≤ 3 tries, ≤ 5 s); `ENOTFOUND` stays fail-closed. Every wait for the resolver is bounded by what is left of that budget; when it is spent the result is `unresolved` with the code `ETIMEOUT` (S-robustness-1). `SCAN-BLOCKED` is judged by the final outcome of a logical navigation (S-robustness-3, §18.5). |
| Profiles | `.dsgvo-check-owner` `{pid, startedAt, host}` in each temporary profile; `removeStaleProfiles()` at collector start removes profiles of dead pids and unmarked ones older than 24 h. `profilesOfPid()` / `removeProfilesOfPid()` (the canary runner after `SIGKILL`) take a profile only when pid AND host of the marker match (`os.hostname()` by default): a profile of the same pid from another container in a shared temp dir stays; a marker without `host` is never taken by pid (S-robustness-2). A browser that does not close within `closeBudgetMs` is killed through its profile: `pidsUsingProfile()` reads `/proc/<pid>/cmdline` for the exact `--user-data-dir=<dir>` and `killBrowserProcesses()` sends `SIGKILL` (Linux; the image needs no `pkill`); `pkill -f` stays as the fallback where there is no `/proc` (macOS). A browser that cannot be killed is a `warn` without the path (R14). `LaunchConfig.log` is passed by the collector. |
| `data/texts/{de,en}/core.yaml`, `src/scan.ts` | `failure.scan-timeout` and `failure.browser-no-handover` (parameter `{seconds}`) are texts of the `ui` section and are rendered in the language of the scan (R29). The other fatal strings of the browser collector and the messages of `InvalidInputError`/`ScanFatalError` stay in code (a known departure from D22, STATUS §4). |
| `src/core/snapshot.ts`, `scripts/canary-runner.ts` | `SnapshotEnvironment.trustStore?` (`node-bundled` \| `system`) from `detectTrustStore(env, execArgv)`; `TlsEndpoint.trustStore` uses the same function (`test` with the test CA). `run.json` has `ca` (`trustStore`, `nodeUseSystemCa`, flag, presence of `NODE_EXTRA_CA_CERTS` without the path). `detectTrustStore` reads the options the way Node does (S-net-3, §18.4); `ca.useSystemCaFlag` is `useSystemCaOption(env, execArgv)`, the effective option and not the presence of a word. |

### 16.3 CMP (G06–G10, G13–G18)

| Area | Change |
|---|---|
| `CmpFirstLayer` | Optional facts: `buttonsTruncated`, `containerAnimating`, `geometryUnsettled`, `consentFrameUnresolved`, `coveredFooterLinks` (`{label, box, coveredBy: 'banner' \| 'overlay'}[]`, hit test of the centre of a legal link outside the banner in the first screen). `coversFooter` is true only with a non-empty `coveredFooterLinks`. The page function returns every link under the banner or its backdrop (`ProbeResult.coveredLinks`, name ≤ 80 characters, at most 200 in DOM order); `toMeasured` keeps those that the lexicon of `data/legal` accepts as Impressum or privacy policy of any supported language (`matchLegalLink`), at most 5 (S-cmp-2, §18.6). |
| `classifyFirstLayer`, CONSENT-03/04 | New reasons `buttons-truncated` and `geometry-unsettled` (banner not recognised, `info`; no verdict from a cut or moving first layer); limitations of CONSENT-04 with the same names; CONSENT-03 gives `inconclusive` with reason and limitation `consent-frame-unresolved` when a large consent iframe cannot be read and tracking was seen. |
| `detection.signals` | New: `heuristic:static`, `heuristic:frame-candidate`, `adapter-hint:<id>`. The heuristic runs when the own banner of the adapter was not measured, or when it is below `high` and not visible, and then supplies container and buttons (the level stays `info`, no click). A banner of the adapter that was measured and is visible, or has recognition `high`, stays in the facts (R22). This replaces the earlier wording «an adapter below `high` or without banner: the heuristic runs too»; the decision waits for the customer (STATUS §4, TRIAGE §7). |
| Probe, candidates (R02, R21) | A candidate inside `nav`, `aside`, `role=navigation` or `role=complementary` is never a banner. A candidate that is itself a `header`, `footer`, `role=banner` or `role=contentinfo` is no banner unless it is a dialog; a candidate inside such a section is accepted only with an accept or reject control outside `nav` (`settings` and `save` do not count). `ProbeArgs.choicePhrases` (optional, filled by `measure.ts` from the lexicon: classes `accept` and `reject`) carries the phrases for that test. A consent-iframe candidate by the body text of a large frame needs at least `MIN_BODY_KEYWORDS` = 2 distinct keywords; one hit is enough only in the `title`, `aria-label` or `name` of the frame. |
| `cmp-bridge.ts` `normalizeFacts` (R19) | `buttons[].name`, `legalLinks[].text` and `coveredFooterLinks[].label` go through `redactFreeText` (an address becomes `[redacted]@domain`). The click selector of a button is not built from an `id`, attribute or class token whose value contains `@` (a class token with an address is dropped, the other tokens may still make the selector unique, else a structural `nth-child` selector is used; the click still works; S-privacy-1). The class attribute is split by the whitespace of HTML, and a selector is accepted only when it finds exactly the control (R-cmp-1). |
| CONSENT-04, primary facts (R23) | The facts of the verdict are chosen by rank: an adapter with `recognitionConfidence` `high` is above a heuristic; an adapter below `high` equals a heuristic. At equal weak rank the facts with a visible banner win, then the phase (B first screen, A, C), then the start page. A banner hidden on the legal pages of A but visible in B therefore gives the evidence and the screenshot of B. |
| Probe | At most 40 candidates are ranked (vendor role, then rendered, then the rest); order in the facts stays DOM order. `waitForBanner` waits up to 2 s beyond the appearance timeout for a settled geometry (two equal measurements, no finite animation); the whole call stays within `cmpCallTimeoutMs`. |
| `data/cmp/lexicon.yaml` | Version 2026.10.2: 11 more languages (fr, es, it, pt, nl, da, no, sv, fi, is, pl); `ausgewählte … akzeptieren` is class `save`. |
| Adapters | `versionFromUrl` accepts dotted versions only; `DetectSpec.versionGlobals` / `DetectRaw.versions` (Complianz reads `complianz.version`). CookieHub: a category that stayed `denied` before and after the click is ignored for the accept verdict (`categories-ignored:<name>` in `method`). |
| Report | `CmpEvidence.buttons[].vendorRole` (nullable, optional); `DocumentEvidence.manifest` (optional: `partCount`, `textLength`, `expandablesFound`, `expandablesOpened`, `framesIncluded`, `framesFound`, `framesRead`, `linkedPages`, `truncated`). `schema/report.schema.json` regenerated. |
| `ScreenshotRecord` | `width`/`height` are those of the saved image (`clipForBox` cuts the container to the viewport); an empty intersection is `skipped: container-outside-viewport`. A `crop.box` field is not part of the record. |

### 16.4 Legal checks (G19–G28)

- **Lexicon.** `data/legal/links.yaml` (version 2026.10.1; 13 languages; labels, keys, weak keys, heading markers, contact and hop keys, error-page phrases) is read by `src/collectors/browser/legal-lexicon.ts` (pure) through `legal-lexicon-file.ts`; used by `pages.ts`, `documents.ts` and `legal-01.ts` (`requires … data: ['legal']`, `ctx.data.legal`). Labels match on word boundaries over normalised text and are ranked (exact label, label with key, key inside label, href slug, generic terms). `findLegalLink` returns `candidates`; on `unconfirmed` the collector tries the next one (≤ 3 extra GETs per scan).
- **LEGAL-01.** New limitations: `<kind>-type-unconfirmed`, `<kind>-search-incomplete:<reason>`, `<kind>-links-truncated`, `<kind>-target-not-evaluable`. `links-broken` only when every link of the kind is confirmed broken. `document-not-found` carries `hopChecked` and `fallbackChecked`. `footer-covered-by-banner` has `high` confidence only for an adapter with recognition `high` or a measured overlap (`coveredFooterLinks`). Probes of the fallback/hop step that were judged `soft-404` or `unconfirmed` are not checked pages (`coverage.note: error-page-probes:<n>`); a visit with the role impressum or privacy whose URL (or final URL) is a `soft-404` attempt is such a probe too, so the error page behind a legal link is not a checked page of the other document kind (R26; an `unconfirmed` page stays in the denominator). `critical` `document-not-found` needs a fallback attempt of the kind: a skipped fallback gives the limitation `<kind>-search-incomplete:fallback-skipped` and `partial`, whatever the status of phase A says (R09). An unconfirmed target of the direct link with a document found by the fallback gives the limitation `<kind>-type-unconfirmed` instead of `reachable-via-intermediate` (R25; hop attempts do not count). The type of a fetched page is confirmed only by headings of its content: headings in `nav`/`aside`/`search`/menu and in `header`/`footer`/banner outside `main`/`article` are chrome (`documentInPage` in `in-page.ts` classifies them, result `RawDocument.headingPlaces`; the first `h1` is chosen by the same rule, S-legal-1; R03). A canonical label keeps the exact rank in its hyphenated and spaced spellings (`labelsJoined`: «Datenschutz-Hinweise», «Privacy-Policy»; R04); a weak key counts only as the whole label or in a label of at most `WEAK_LABEL_TOKENS` = 2 words (R24). A weak key (tier 4) loses against an exact canonical label of the other kind on the same link and on any other link to the same URL (`matchLegalLinks`, L3); a shared page with an exact label for each kind stays with both kinds, and `findLegalLink` and LEGAL-01 (`footer-covered-by-banner` too) read the links of a page the same way. In the collector a second kind behind an already queued page is attached to that queue item (`QItem.alsoKinds`): the page is fetched once and read per kind; the same holds when the next candidate of one kind is already queued for the other (S-legal-3, §18.2). A false friend (`cookie`, `einstellungen`) in the href path switches the path match off only when the path has no primary key of the kind (S-legal-4).
- **PRIV-01.** A document with the only error `expand-failed` gives `partial` with `banner-open`; the negative search carries the manifest and `partCount`/`complete` in the message parameters; `language-unsupported` follows the language of the markers.
- **Import boundary.** `legal-01.ts` and `priv-01.ts` import the pure `legal-lexicon.ts` beside `src/core/api.ts` (like `consent-04.ts` with `src/cmp/lexicon.ts`); `import-graph.test.ts` stays green. A strict reading of AGENTS rule 4 would move the module into `src/core` (STATUS §5).

### 16.5 Requests, catalog, TRACK-01 (G31–G37)

- **derive.** `resourceType` `other` without a signature is `resource`/`loaded`; `xhr`, `fetch`, `ping`, `beacon`, `image` are unchanged (a global change waits for a recount with `--from-snapshot`).
- **Catalog.** 26 new services (ad tech, analytics, tag and consent vendors); signatures for service calls (Ad Manager dictionary/`gpt.js`/ad request, HubSpot service calls and tracking pixel, Experience Edge consent call, the identity, experience, checkout and REST hosts of one content-analytics vendor so that a domain match alone never makes them a hit, R05) and `identifierParams` for path sinks (Floodlight, ddm activity, gmp conversion, Audience Manager `ibs:`: `dc_pre`, `_dc_unique_id`, `dc_dbm_token`, `dc_ext_key`, `gdid`, `dpuuid`). Consent-state allowlist version 2 (consentmanager, Usercentrics v3, Sourcepoint, Funding Choices).
- **TRACK-01.** Stage per timing: `params.stageBeforeInteraction`, `stageAfterReject`, `stageAfterAccept` (`loaded`, `initialised`, `event-sent`, `none`, `not-checked`); `params.stage` stays the maximum and ignores `not-checked`. `none` means the timing was carried out and no request of the service was seen («nicht gefunden»); `not-checked` means it was not carried out: `stageAfterReject`/`stageAfterAccept` are carried out only after a successful click of that action in a phase that is not `skipped`, `stageBeforeInteraction` always (R07). The body says «nicht geprüft» / «not checked» for it, never «nicht gefunden». The texts in `data/texts/{de,en}/browser.yaml` follow; they deviate from the draft table of wording-guide §5.5 (STATUS §4).

### 16.6 HTTP, TLS, DNS (G02, G40–G48)

| Area | Change |
|---|---|
| `HeaderRecord` | New optional `truncated` (the stored `value` was cut at `MAX_HEADER_VALUE` = 2048) and, for `content-security-policy` and `-report-only`, `frameAncestors {present, restricts, sources[≤20]}` computed on the complete value as the server sent it, before any editing and before the cut (S-net-2, §18.4); `sources` are reduced to a keyword, `*`, a scheme or `[scheme://]host[:port]`. Set when the value has the directive or is at least `MAX_HEADER_VALUE` long (cut, or complete at exactly the limit, R12); absent on a shorter value without it and in older snapshots (HDR-01 still gives the limitation `csp-truncated` for an older snapshot without the fact at the limit). `cspFrameAncestors` and `MAX_HEADER_VALUE` are exported by `src/core/api.ts`. |
| HDR-01 | `anti-framing-missing` reads the fact; a cut enforced CSP without the fact (older snapshot) gives no finding and the limitation `csp-truncated` (`partial`). Report-only and meta CSP still do not count. Combined `X-Frame-Options` and `Strict-Transport-Security` fields are parsed per field. |
| TLS-01 | A redirect to another host without an HTTP probe of the final host gives `partial` with a limitation; an HTTPS first hop to another host and an HTTP first hop are told apart (reason and texts). |
| TLS-02 | `chain-incomplete` only for `authorized = false` with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. `chainComplete = authorized \|\| selfSigned(last)`; resolving every issuer through the sent chain and the trust store is open (STATUS §5). `chain-incomplete` is given only when the server did not send the issuer of the leaf (no sent certificate has a `subject` equal to the `issuer` of the leaf, compared without case); with the issuer sent and `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` the result is `certificate-invalid` with the reason `untrusted-root` (R20). TLS-01, HDR-01 and `tlsBlocked` in `scan.ts` still read only the error code and treat that case as an incomplete chain; the browser phase stops on `ERR_CERT_*` itself (STATUS §5). |
| HTTP collector | `<meta http-equiv="refresh">` inside `noscript` and `template` is no redirect (nested templates and tag boundaries: §18.4). |

## 17. Changes after the live rescan (L1–L3, 2026-10-31)

Defects of a live rescan after the canary2 fixes: [canary/TRIAGE.md](canary/TRIAGE.md) §8. `SNAPSHOT_VERSION` 1 and `SCHEMA_VERSION` 0.2.0 stay; no field was added to the snapshot or the report. Entries marked `Lnn` belong to this round.

| Area | Change |
|---|---|
| `NetworkRecorder.inflight()` (L1) | Counts only the open requests of the current navigation and document, for the quiet decision (`waitForQuiet`). The set is cleared by `beginNavigation` and when a request for a new document of the page's main frame arrives (JS or meta redirect, reload); the main frame is the frame of the first document request of the phase. An HTTP redirect hop of the same navigation, a subframe document and the document of another page (popup) do not clear it. Records (`RequestRecord`, their `state` and `delivery`) of earlier pages are not touched, and a late `requestfinished` of an old request is harmless. Requests of the current page still hold the wait until `HARD_CAP`. |
| `PhaseRecord.errors` (L2) | A repeated navigation to the start page of phase A leaves an entry of the first attempt. `code` is `navigation-timeout`, the network code (`ERR_…`) or `http-<status>`; `url` is the start page; `message` is `start page: attempt 1 of 2 failed after <N> ms; repeated after a pause of <M> ms (navigation <id>)`, where `<id>` is the `navigationId` of the failed attempt, so its requests are not orphans. The same fact goes to the log (`warn`, without the URL). Phase A still has one `start` visit (the repeat). No new `SCAN-*` code and no user text. |
| `visitStart` (L2) | Before the repeat after a navigation that ended in an error the page leaves the failed navigation for `about:blank` (`leaveFailedNavigation`, best effort). Without it Chromium took the repeat for the same unfinished navigation when the server had sent nothing, and ended it at once with `ERR_ABORTED` without a request; the cause `timeout` became `ERR_ABORTED` in `start-page-unreachable`. A repeat after a 5xx or 429 does not need it (a document was committed). The retry of 429/503 in `navigate()` and the repeat of the start page of B/C still have no entry in `errors`. |
| `matchLegalLinks(lex, kind, refs)` (L3) | In `legal-lexicon.ts`. `matchLegalLink` is a wrapper with an empty page identity. `links` are `LegalLinkRef` = `{ input: LinkInput, page: string }` where `page` is `pageKey(href)` (`''` when the link has no target page); the weak match is dropped when the same link or another link to the same URL has an exact canonical label of the other kind. Symmetric for Impressum and privacy. |

## 18. Changes after the Codex Sol review (S-*, 2026-10-31)

Review of the fixes of §16 and §17 by Codex GPT-6.1-Sol: [canary/TRIAGE.md](canary/TRIAGE.md) §9. `SNAPSHOT_VERSION` 1 and `SCHEMA_VERSION` 0.2.0 stay; the only snapshot-shaped additions are optional (`RawDocument.headingPlaces`, the internal `SetCookieOrigin.rejected`). Entries `S-<zone>-n` are findings of the review, `N-REV`, `R-cmp` and `R-requests` are remarks of the reviewers on the fixes.

### 18.1 Redaction (S-privacy-2…5)

| Area | Change |
|---|---|
| Local part of an address (`url.ts`, `redact.ts`) | Any character except a boundary: control characters, whitespace of every script (NBSP, thin space, U+3000, U+2028 stay boundaries), `" ( ) , : ; < > @ [ \ ]` and non-ASCII quotes and brackets (`Pi`, `Pf`, `Ps`, `Pe`). That is the whole `atext` of RFC 5322/6531 with emoji, `™`, `€`, `·`. `{` and `}` are a branch of their own. The quoted form `"…"` (with `\` escapes) is an address too. Both are at most 64 characters, so the scan stays linear (400 000 characters: tens of milliseconds). `/ ? # & =` belong to the local part only in free text; inside a string that is already a URL (the tail of `sanitizeUrl`, an unrecognised URL, a path segment with parameters) they stay boundaries. `%2F` and `%5C` stay boundaries in a segment. `a@b.test@c.test` is one address. |
| Tokens (`redact.ts`) | `redactText` takes the URL and `mailto:` tokens first and masks the bare addresses between them (an address glued to a URL, `a@x.dehttps://…`, no longer eats the start of the URL). An apostrophe and a backtick do not end a URL or `mailto:` token (they are legal URL characters); a closing quote is cut as trailing punctuation like a closing bracket, so `'https://…'`, `window.open('…');` and `('…')` work as before. Two URLs glued by quote and comma without a space are one token and the query is hidden as a whole. The `]` of an own `[redacted]` is not cut as a closing bracket (idempotence with a stray `]` in the path). A quoted address (`mailto: "a b"@d.test`, `…?id="x"@d.test`) is part of the token, also when glued to a URL or `mailto:` token. |
| `mailto: ` with a space (`redact.ts`) | The prose guard after the space looks at the body after soft decoding (up to three rounds, so `%2540` counts as an address), not at a literal `@`: `mailto: %61lice%40d.test` → `mailto:[redacted]@d.test`. Prose stays: `mailto: Kontakt aufnehmen`, `mailto: 100% Datenschutz`, `mailto: %ZZ nicht erreichbar`, `(mailto: siehe unten)`. The body of a `mailto:` token ends before `https?://`: a URL after `mailto:` and a space (or glued to a recipient) is a URL token with the ordinary boundary, its query is redacted (`mailto:https://shop.example.test/p?sid=X` → `mailto:https://shop.example.test/p?sid=[redacted]`). `maskMailto` uses the same decoding; a domain of dots and hyphens gives `[redacted]` without `@`; `mailto:mailto:` collapses. |
| Path segment (`url.ts`) | `decodeLenient` (exported by `url.ts` only): valid `%XX` are decoded, `%ZZ`, a lone `%` and invalid UTF-8 (`%E9`) stay literal, so a `%40` next to a broken escape no longer hides. The broken escape is written as `%25ZZ` / `%25E9`; `%2F`, `%5C` and the structure of the path are kept; `%2540` stays the text `%40`. A check without an address does not change the URL. |
| Query (`url.ts`) | `containsAddress` (text or percent-encoded, up to three rounds): a value that holds an address is never kept, not for an allowlisted name either (`family=Roboto','a@x.test'`, `hl=de\`a@x.test\`` → `[redacted]`); a key that holds an address becomes `[redacted]`. Allowlisted names without a value rule (`family`, `hl`, `display`, …) still keep any value without an address (D20); `family=Open+Sans:wght@400;700` is no address. |

### 18.2 Legal documents (S-legal-1…4, S-legal-3 follow-up)

| Area | Change |
|---|---|
| `RawDocument.h1` | The first visible `h1` outside the chrome, chosen by `documentInPage` with the function that decides the chrome of headings and collapsed panels (`outsideText`); a hidden `h1` and an `h1` of the banner do not count. The error-page marker by `h1` no longer fires on an `h1` from the chrome; the `title` remains. An `h1` in a bare page-level `<header>` outside `main`/`article` is chrome. |
| `RawDocument.headingPlaces?` | `{ chrome, content }`: counts of the visible headings by place, from `documentInPage`, read by `extractDocument` for the main document and for same-origin frames. `headingPlacesInPage` in `documents.ts` is gone: headings, the first `h1` and collapsed panels share one rule. |
| Chrome rule (`in-page.ts`) | `COMPONENT_BAR_RE`: the header or footer of an unambiguous component (accordion, collapse, collapsible, card, panel, expansion, faq, toggle, expand, expandable, tab, tabs) is no chrome; for the ambiguous nouns (item, entry, post, article, section, block) only the `-header` is stripped, `section-footer` and `block-footer` stay chrome (S-L-B). A token of `id`/`class` that starts with `has`/`with`/`without`/`no` and ends with a part of the page (`has-fixed-header`, `with-header`, `page-with-footer`, `no-sidebar`, up to two words between) is a layout state, not chrome (S-L-C). `sticky-footer` stays chrome (known limitation, TRIAGE §9). |
| Href path (`legal-lexicon.ts`, `matchOwn`) | A false friend (`cookie`, `einstellungen`) in the path switches the path match off only when the path has no primary key of the kind: `/privacy-policy-and-cookies` is tier 3, `/cookie-settings` is not privacy. As a side effect `/privacy-policy/cookie-settings` with a neutral label is tier 3 (the page type is confirmed by headings anyway). `findLegalLink` and LEGAL-01 read the same link the same way. |
| Queue (`collector.ts`, phase A) | `QItem.alsoKinds?`: other kinds whose links lead to this very page. `handleLink` attaches a second kind to the queued item instead of dropping it; after the page is recorded for the main kind it is recorded for each `alsoKinds` entry on the same open page (one navigation, no fallback probe). `pending(kind)` counts `alsoKinds`. `tryNextCandidate`: a next candidate that is already queued as the document of another kind stays in the queue and gets the kind in `alsoKinds` (it used to be taken out and lost, with its document). |

### 18.3 Requests and cookies (S-requests-1, S-requests-2)

| Area | Change |
|---|---|
| `NetworkRecorder.markClickAt` | The recorder keeps the link request → `SetCookieOrigin`s written by its response (references only, no values; set while the request is not after-click yet, cleared by `markClickAt` and `dispose()`). A late `markClickAt` sets `afterClick` on the origins of each re-marked request (start ≥ the click), so the cookie that exists already gets its `afterClick` record. The key `name\|domain\|path\|partition` is unchanged. |
| `cookieDomainVerdict(host, domain)` (`recorder.ts`) | RFC 6265 5.3 steps 5 and 6 with domain-match of 5.1.3: `host-only` (no attribute, or a public suffix equal to the host), `domain` (the host may set it), `rejected` (no domain-match, a public suffix other than the host, an IP address other than the host). Public suffixes come from `registrableDomain` (tldts, private suffixes included), as in Chromium. Exported with the type `CookieDomainVerdict`. |
| `SetCookieOrigin.rejected?` | Internal flag for the verdict `rejected`: `domain` is not filled, the key carries the suffix `\|rejected`, so the claim does not take the key of a real host-only cookie of the claimed host. `jar.ts` (`setterOf`, `writtenAfterClick`) skips such an origin: the existing cookie gets neither a foreign setter nor a second `afterClick` record. A rejected attempt stays an `attempted` record with `domain` = the response host (it does not look like a first-party cookie). The flag is not in the report or the snapshot. |

### 18.4 HTTP, headers, trust store (S-net-1…3, N-REV-1…4)

| Area | Change |
|---|---|
| `documentMarkup` (`collectors/http/html.ts`) | Templates nest: the markup is read with a depth counter, the content of raw-text elements (`script`, `style`, `noscript`, `textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes`) inside a template is text (a `"</template>"` string in a script closes nothing), an unclosed outer template runs to the end. A tag is read together with its quoted attribute values (`name="…"`, `name='…'`, also with spaces around `=`; a quote elsewhere, as in `<p don't>`, is no quote): a `<template>`, `</template>` or `<script>` inside a value is text and a `>` in a value does not end the tag (N-REV-2). A tag name ends at HTML whitespace, `/` or `>`: `<template-card>`, `<script-loader>` are custom elements. Linear per tag; a text without any `>` behind the position answers at once. |
| Meta tags (`html.ts`, `http/index.ts`) | `extractMeta` and the meta-refresh branch of `detectClientRedirect` read the opening tags of `documentMarkup`: a `<meta>` inside `template`, `noscript`, `script` and the like is not a fact of the document (N-REV-3; HDR-01 no longer takes an inert CSP or referrer meta). The values are stored through `storedHeaderRecord` (N-REV-4): `refresh` URL sanitized, `content-security-policy` reduced like a header value, every other name `[redacted]` (a `set-cookie` meta never keeps its value), without the `frameAncestors` fact (a meta CSP has no effect on framing). `metaReferrer` keeps only the keyword tokens (`[a-z-]`, ≤ 40 characters), else `null`. |
| `HeaderRecord.frameAncestors` | Computed on the value as it came, before any editing and before the cut; `present` and `restricts` do not depend on the URL sanitizer. `sources` (≤ 20, each ≤ 200 characters) are reduced by `safeCspSource` to a keyword (`'self'`), `*`, a scheme (`https:`) or `[scheme://]host[:port]`: user info, addresses, path, query and fragment are not stored; a token that is no host (`alice%40mail.invalid`) and every other quoted token (nonce, hash) is `[redacted]`. The spelling is kept; applying it twice changes nothing. |
| Stored CSP `value` (`headers.ts`) | A token that is no `http(s)://` URL and carries user info or an address (`@`, `%40`) or a path, query or fragment behind the host is reduced the same way, with or without a scheme (`portal.invalid/users/…` → `portal.invalid`, `wss://api.invalid/x?u=…` → `wss://api.invalid`). `http(s)://` tokens stay with `sanitizeUrl`; keywords, relative `report-uri`, `data:`, `wss://host:port` are unchanged. |
| `detectTrustStore(env, execArgv)` (`snapshot.ts`) | Reads `NODE_OPTIONS` as Node splits it (a space separates words, double quotes open and close a part of a word and are dropped, `\` escapes inside them, single quotes are ordinary), then applies the options in Node's order: `NODE_OPTIONS` first, the command line after it; the last of `--use-system-ca` / `--no-use-system-ca` wins. `NODE_USE_SYSTEM_CA=1` is only the starting value and is overridden in both directions. `_` for `-` and `=value` are recognised. `--use-openssl-ca` is counted as `system`; `NODE_EXTRA_CA_CERTS` adds to any set and is recorded apart. `useSystemCaOption(env, execArgv)`: whether `--use-system-ca` is in effect as an option (`run.json` `ca.useSystemCaFlag`). |

### 18.5 Robustness (S-robustness-1…3)

| Area | Change |
|---|---|
| `ssrf.ts` | `lookupOnce` takes the shared deadline and races `network.lookup` with a timer (cleared in `finally`): every wait for the resolver is bounded by what is left of the budget, also the immediate repeat after `ENOTFOUND`. When the budget is spent the result is `unresolved` and `onLookupError` gets `{ code: 'ETIMEOUT', attempt }`. A late answer is not applied and not cached. |
| `SCAN-BLOCKED` (`collector.ts`) | `visit()` no longer notes a block after each attempt; `settleBlocked` at the end of `navigate()` decides by the final outcome of the logical navigation: a challenge in the final visit is a block; a challenged first attempt with a repeat that gives no evaluable page is a block (data of the first attempt); a repeat that delivered an evaluable page gives no `SCAN-BLOCKED`. The first block is a record in `PhaseRecord.errors` (code `http-<status>`, message `attempt 1 of 2 … attempt 2 delivered the page / was blocked again / gave no evaluable page`, with phase and URL), as for the start page (L2). The start page of phase A stays outside (fatal in `scan.ts`). |
| Profiles | See the `Profiles` row of §16.2: `profilesOfPid` / `removeProfilesOfPid` take `host` (default `os.hostname()`). |

### 18.6 CMP (S-cmp-2, S-privacy-1, R-cmp-1)

| Area | Change |
|---|---|
| `ProbeResult` (`cmp/page/probe.ts`) | No lexicon and no regular expression of legal words in the page function. It returns `coveredLinks` (every link outside the banner whose centre lies under the banner or its backdrop in the first screen: hit test, name ≤ 80 characters, at most 200 in DOM order); `legalLinks`, `coversFooter` and `coveredFooterLinks` are not fields of it any more. A constant outside the body of the page function breaks its serialization (the heuristic then returns `none` silently), so the limit 200 lives inside it. |
| `toMeasured` (`cmp/page/measure.ts`) | Selects `legalLinks` of the banner and `coveredFooterLinks` with `matchLegalLink` of `collectors/browser/legal-lexicon.ts` (both kinds, label only, `data/legal`, loaded by `loadLegalLexicon()` or passed as `opts.legal`); at most 5 in DOM order, `coversFooter` is true with a non-empty list. The report shape (`CmpFirstLayer`) is unchanged. A link to a settings dialog (`Datenschutz-Einstellungen`, `Privacy settings`, `Paramètres de confidentialité`) is no legal link; a lone `Rechtliches` (a navigation hop) is no covered legal link. |
| Click selector (`probe.ts`, `uniqueIn`) | See the `normalizeFacts` row of §16.3: class tokens with `@` are dropped, `class` is split by the whitespace of HTML, and `isOnly(selector)` requires one match that is the element itself. |
