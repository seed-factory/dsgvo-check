# Tests

| Level | Where                                                                                                                         | What                                                                                                           | Network       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| L0    | `test/unit/core/**/{registry-completeness,stopwords,schema,import-graph}.test.ts`, `test/unit/reporters/no-crm-codes.test.ts` | registry completeness, stop words, no `T[0-9]_` outside JSON, report JSON Schema (Ajv), import graph of checks | none          |
| L1    | `test/unit/**`                                                                                                                | checks on snapshot slices (`test/utils/snapshot-builder.ts`), core (gate, assess, …)                           | none          |
| L2    | `test/integration/**`                                                                                                         | real Chromium (Chrome for Testing, new headless), undici, `node:tls`, dns2, local servers                      | loopback only |
| L3    | `test/e2e/**`                                                                                                                 | packed CLI, Docker image, Action                                                                               | loopback only |
| live  | `test/live/**`                                                                                                                | real sites; never part of `pnpm test`                                                                          | internet      |

Commands: `corepack pnpm test` (unit + integration), `test:unit`, `test:integration`, `test:e2e`, `test:live`.
One file: `corepack pnpm vitest run test/unit/core/evaluation/gate.test.ts`.
The Docker part of L3 is opt-in: set `DSGVO_E2E_IMAGE` (see `test/e2e/docker.e2e.test.ts`).

## Parallel runs

One worker per logical core. `DSGVO_TEST_WORKERS=4`, `=50%` or `=1` (one file at a time) overrides it
(`test/utils/run/test-workers.ts`). L2 and L3 files must not depend on each other:

- **Temp dir.** `test/utils/run/worker-tmpdir.ts` sets `TMPDIR` to `<tmp>/dsgvo-test-<run pid>/w<pool>-<pid>` for each
  file; `test/utils/run/global-tmpdir.ts` removes the run directory. Create temp files with `os.tmpdir()` and never look
  into the real temp dir.
- **Ports.** Listen on port 0. Hostnames are virtual (`--host-resolver-rules`); only the fixture server's ports are
  real.
- **Time.** Check pacers and pauses at the client (the moment of sending), not at the server, with a tolerance for a
  descheduled process. Test certificates are issued against the real clock, so a check that reads them needs
  `{ now: new Date() }`, not `FIXED_NOW`.

## L2 network

Chromium must load the target _and_ fake third parties (`www.google-analytics.com`, `fonts.googleapis.com`, …) from
`test/fixture-server` without internet, with real TLS, cookies and third-party context. Node clients (undici,
`node:tls`) must see the same hosts.

Chosen: `--host-resolver-rules` with port remapping (`server.browserArgs()`), checked on Chromium 156.

- `MAP *:80 127.0.0.1:<httpPort>, MAP *:443 127.0.0.1:<httpsPort>` maps host _and_ port. Host header and SNI keep the
  original name; `serverAddr()` is 127.0.0.1.
- `MAP * ~NOTFOUND` fails every other port with `ERR_NAME_NOT_RESOLVED`, so nothing leaks.
- Random ports, no root, no netns.

Rejected: a proxy on the fixture server (changes browser behaviour, `connectedIp` is the proxy, conflicts with the
user's `--proxy`), binding 80/443 (needs `ip_unprivileged_port_start` or a netns on Linux CI) and `page.route`
(disables the HTTP cache, gives no `serverAddr` or TLS details, interferes with the collector's own routes).

### TLS trust

- **Chromium:** `--ignore-certificate-errors-spki-list=<sha256 of the shared leaf key>`. All good leaf certificates
  (any host, issued lazily by SNI) share one key, so one hash covers every host. `expired`, `wrong-name` and
  `self-signed` certificates have their own keys and stay broken (`net::ERR_CERT_*`). After a certificate error close
  the context, not the page: closing a `chrome-error://` page can block for many seconds.
- **Node:** trusts the test CA (`network.test.caPem`) and gets the real errors (`CERT_HAS_EXPIRED`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`).

### Node routing

`NetworkConfig.test.connect(host, port)` returns `{host: '127.0.0.1', port: <mapped>}`. Collectors connect there and
keep `servername` and `Host` as the original host (reference: `testDispatcher` in `test/utils/network.ts`). In tests,
core preflight resolves through `NetworkConfig.lookup` (always 127.0.0.1) and runs with
`allowPrivateAddresses: true`.

Chrome's background traffic (`update.googleapis.com`, …) gets a 404 and lands in `server.browserInternal`, not in
`server.unexpected`.

## Fixture server

```ts
import { startFixtureServer, setCookieHandler, redirectHandler } from '../../fixture-server/server.ts';
const server = await startFixtureServer({ sites: ['browser/fonts'] });
// scan with it:
await scan({ url: 'https://www.example.test/', network: server.network(), ... });
// or a raw browser:
const b = await launchTestBrowser(server);            // test/utils/browser.ts
expect(server.unexpected).toEqual([]);                  // every host must be declared
await b.close(); await server.close();
```

Site content lives in `test/fixture-server/sites/<module>/<site>/` (`module`: `browser`, `cmp`, `core` or
`pipeline`): static files, `/` → `index.html`, unknown path → 404 page. Declare each site in
`test/fixture-server/sites.ts`; an undeclared site, or a `fileHeaders` entry for a missing file, fails the server
start:

```ts
'core/smoke': {
  hosts: { 'www.example.test': 'www', 'fonts.googleapis.com': 'fonts' },  // host → docroot
  tls: { 'expired.example.test': 'expired' },  // valid|expired|expiring|wrong-name|self-signed
  routes: [{ host: 'example.test', scheme: 'http', path: '/', status: 301,
             headers: { location: 'https://www.example.test/' } }],
  fileHeaders: { 'www/index.html': { 'set-cookie': ['a=1; Path=/'] } },  // extra headers per static file
},
```

- Targets use `.test` hostnames, never real domains. Fake third parties may use their real hostnames: they never leave
  the machine.
- Write fixture content by hand; copied CMP or vendor code is a license problem.
- Dynamic behaviour: `handlers` (`setCookieHandler`, `redirectHandler`, your own `DynamicHandler`) or
  `routes[].delayMs` for delayed tags.
- Fake DNS for the MAIL checks: `startFakeDns(zone)` in `test/integration/dns/dns-server.ts` (dns2, UDP, random port
  on `127.0.0.1`). Pass `network: { ...server.network(), dnsServers: [dns.server] }`.

## L1 fixtures

- **Browser checks:** `test/unit/checks/browser/scenarios/<id>.ts`, one file per check, collected into `SCENARIOS`
  and `VARIANT_SCENARIOS` by `scenarios/index.ts`. A scenario has a `file` name that starts with its kind
  (`violation-…`, `clean-…`, `inconclusive-…`), an `expect` and a `build()` that makes the snapshot in memory.
- **DNS checks:** one row per query in `test/unit/checks/dns/fixtures.ts`, also in memory.
- **HTTP checks:** `test/fixtures/snapshots/http/<CHECK-ID>/{violation,clean,inconclusive|error,counterexample}*.json`,
  a partial `Snapshot` (`makeSnapshot` fills the rest) plus `$expect` (`status`, optional `variants` and `reason`):

  ```json
  { "$description": "Start page over https without any security header",
    "$expect": { "status": "completed", "variants": ["anti-framing-missing", "header-missing", "hsts-missing"] },
    "http": { "chains": [], "documents": [ … ], … } }
  ```

`registry-completeness.test.ts` runs every fixture of every registered check and compares the status and the sorted
set of emitted variants. Targeted tests use the builders (`makeRequest`, `makePage`, `runCheck`, …) and live in
`test/unit/checks/<module>/`.
