# Tests

| Level | Where                                                                          | What                                                                                                 | Network       |
| ----- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------- |
| L0    | `test/unit/core/{registry-completeness,stopwords,no-crm-codes,schema}.test.ts` | registry completeness, stop words, no `T[0-9]_` outside JSON, schema drift and Ajv contract          | none          |
| L1    | `test/unit/**`                                                                 | pure checks on snapshot slices (`test/utils/snapshot-builder.ts`), core (gate, assess, fingerprint…) | none          |
| L2    | `test/integration/**`                                                          | real Chromium (Chrome for Testing, new headless), undici, `node:tls`, dns2 against local servers     | loopback only |
| L3    | `test/e2e/**`                                                                  | packed CLI / Docker image / Action                                                                   | loopback only |
| live  | `test/live/**`                                                                 | real sites; never part of `pnpm test`                                                                | internet      |

Commands: `corepack pnpm test` (unit + integration), `test:unit`, `test:integration`, `test:e2e`, `test:live`.
Single file: `corepack pnpm vitest run test/unit/core/gate.test.ts`.

## Parallel runs

Test files run in parallel, one worker per logical core; `DSGVO_TEST_WORKERS=4` or `=50%` changes that, `=1` runs the
files one after another (`test/utils/test-workers.ts`). L2 and L3 files must stay independent of each other:

- **Temp dir:** `test/utils/worker-tmpdir.ts` (setup file) points `TMPDIR` to `<tmp>/dsgvo-test-w<pool>-<pid>` for the
  file and removes it afterwards. Use `os.tmpdir()` for anything a test creates, and never look into the real temp dir.
- **Ports:** listen on port 0. Target hostnames are virtual (`--host-resolver-rules`), only the fixture server's
  ports are real.
- **Time:** measure what the code controls. A pacer or pause is checked at the client (the moment of sending), not at
  the server (arrival jitter), and with a tolerance for a process that is descheduled on a busy machine. Certificates
  are issued relative to the real clock, so a check that reads them needs `{ now: new Date() }`, not `FIXED_NOW`.

## L2 network: how every host reaches the fixture server

Requirement: Chromium must load the target _and_ fake third parties (`www.google-analytics.com`,
`fonts.googleapis.com`, …) from `test/fixture-server` without internet, with real TLS, real cookies and a real
third-party context; Node clients (undici, `node:tls`) must see the same hosts.

Options considered:

| Option                                          | Verdict                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`--host-resolver-rules` with port remapping** | **chosen.** Verified on Chromium 156 (CfT, new headless): `MAP *:80 127.0.0.1:<httpPort>, MAP *:443 127.0.0.1:<httpsPort>` maps both host _and_ port; Host header and SNI keep the original name; `serverAddr()` = 127.0.0.1. `MAP * ~NOTFOUND` makes every other port fail with `ERR_NAME_NOT_RESOLVED` (no leak). Works with random ports, so no root and no netns. |
| Proxy on the fixture server (CONNECT + test CA) | rejected: changes browser behaviour (proxy mode, `connectedIp` is the proxy), conflicts with the user `--proxy` option, more code.                                                                                                                                                                                                                                    |
| Bind 80/443 directly                            | rejected: allowed unprivileged on macOS, not on Linux CI without `ip_unprivileged_port_start` / netns.                                                                                                                                                                                                                                                                |
| `page.route` / `route.fulfill`                  | rejected for L2: disables HTTP cache, no `serverAddr`/TLS details, interferes with the collector's own routes.                                                                                                                                                                                                                                                        |

TLS trust:
- **Chromium** gets `--ignore-certificate-errors-spki-list=<sha256 of the shared leaf key>`. All "good" leaf
  certificates (any host, issued lazily by SNI) share one key pair, so one hash covers every host. Broken
  certificates (`expired`, `wrong-name`, `self-signed`) use their own keys and stay broken in Chromium
  (`net::ERR_CERT_*`). Do not close a page that shows a certificate error — closing `chrome-error://` pages can
  block for many seconds; close the context instead.
- **Node** (undici, `node:tls`) trusts the test CA (`network.test.caPem`) → real Node errors:
  `CERT_HAS_EXPIRED`, `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`.

Node routing: `NetworkConfig.test.connect(host, port)` returns `{host: '127.0.0.1', port: <mapped>}`; collectors
connect there while keeping `servername`/`Host` = original host. Reference implementation:
`test/utils/network.ts` (`testDispatcher`). Core preflight uses `NetworkConfig.lookup` (→ 127.0.0.1) and
`allowPrivateAddresses: true` (tests only).

Chrome background traffic (`update.googleapis.com`, …) is answered with 404 and recorded in
`server.browserInternal`, not in `server.unexpected`.

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

Site content lives in `test/fixture-server/sites/<module>/<site>/` (module = owner path, see BRIEF): static files,
`/` → `index.html`, unknown path → 404 page. Each site is declared in `test/fixture-server/sites.ts`:

```ts
'core/smoke': {
  hosts: { 'www.example.test': 'www', 'fonts.googleapis.com': 'fonts' },  // host → docroot
  tls: { 'expired.example.test': 'expired' },  // valid|expired|expiring|wrong-name|self-signed
  routes: [{ host: 'example.test', scheme: 'http', path: '/', status: 301,
             headers: { location: 'https://www.example.test/' } }],
  fileHeaders: { 'www/index.html': { 'set-cookie': ['a=1; Path=/'] } },  // extra headers per static file
},
```

An undeclared site, or a `fileHeaders` entry for a missing file, fails the server start.

Use `.test` hostnames for targets (never real domains); fake third parties may use their real hostnames because
they never leave the machine. Fixture content must be written by hand: no copied CMP/vendor code (licenses).
Dynamic behaviour: `handlers` (`setCookieHandler`, `redirectHandler`, or your own `DynamicHandler`), or
`routes[].delayMs` for delayed tags.

Fake DNS for MAIL-* (M5): run a `dns2` UDP server on `127.0.0.1:0` in the test and pass
`network: { ...server.network(), dnsServers: ['127.0.0.1:<port>'] }`.

## L1 fixtures

Browser checks: scenarios in `test/unit/checks/browser/scenarios/<id>.ts`, one file per check, collected into
`SCENARIOS` and `VARIANT_SCENARIOS` by `scenarios/index.ts`. Each has a `file` name that starts with its kind
(`violation-…`, `clean-…`, `inconclusive-…`), a `$expect` and a `build()` of the snapshot; they are built in memory,
nothing is written to disk.

DNS checks: one row per query in `test/unit/checks/dns/fixtures.ts`, built in memory the same way.

HTTP checks: `test/fixtures/snapshots/http/<CHECK-ID>/{violation,clean,inconclusive|error}*.json` — a partial `Snapshot` (missing parts are filled by `makeSnapshot`) plus `$expect`:

```json
{ "$description": "Google Fonts CSS loaded before consent",
  "$expect": { "status": "completed", "variants": ["fonts-loaded"] },
  "browser": { … }, "collection": { "browser": { "status": "ok", "durationMs": 0 } } }
```

`registry-completeness.test.ts` runs every fixture of every registered check and compares status and the sorted
set of emitted variants. Write targeted tests with the builders (`makeRequest`, `makePage`, `runCheck`, …) in
`test/unit/checks/<module>/`.
