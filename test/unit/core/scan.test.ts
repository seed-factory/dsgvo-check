import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineCheck } from '../../../src/core/check.ts';
import { loadTexts } from '../../../src/core/data.ts';
import { disclaimerParagraphs } from '../../../src/core/disclaimer.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { type ScanOptions, scan, writeReports } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report-validator.ts';
import { fakeCollectors, nxdomainLookup, publicLookup, testDataDir } from '../../utils/scan-harness.ts';
import {
  FIXED_NOW,
  makeBrowser,
  makeDocumentResponse,
  makeHttp,
  makePage,
  makePhase,
  makeTls,
  makeTlsEndpoint,
} from '../../utils/snapshot-builder.ts';

const dataDir = testDataDir({
  ruleset: {
    'TEST-01': { hit: 'critical', soft: 'warning' },
    'TEST-02': { header: 'warning' },
    'TEST-03': { 'tracker-hit': 'critical' },
  },
  crm: { 'TEST-01.hit': 'T1_OTHER' },
});

const browserCheck = defineCheck({
  id: 'TEST-01',
  module: 'browser',
  requires: ['browser', 'derived'],
  variants: [{ variant: 'hit' }, { variant: 'soft' }],
  run: (slice) =>
    slice.browser.phases.length > 0
      ? [
          {
            checkId: 'TEST-01',
            variant: 'hit',
            confidence: 'high',
            subject: 'svc',
            phases: ['A'],
            pages: [slice.target.url],
            evidence: [],
            params: { detail: 'x' },
          },
        ]
      : [],
});

const httpCheck = defineCheck({
  id: 'TEST-02',
  module: 'http',
  requires: ['http'],
  variants: [{ variant: 'header' }],
  run: (slice) =>
    slice.http.documents.length === 0
      ? [
          {
            checkId: 'TEST-02',
            variant: 'header',
            confidence: 'high',
            subject: 'strict-transport-security',
            phases: ['http'],
            pages: [],
            evidence: [],
            params: { detail: 'y' },
          },
        ]
      : [],
});

const consentCheck = defineCheck({
  id: 'TEST-03',
  module: 'browser',
  requires: ['browser'],
  variants: [{ variant: 'tracker-hit' }],
  run: () => [],
});

const registry = () => new CheckRegistry([browserCheck, httpCheck, consentCheck]);

const tlsCheck = defineCheck({
  id: 'TEST-02',
  module: 'http',
  requires: ['tls'],
  variants: [{ variant: 'header' }],
  run: () => [],
});

const withBrowser = fakeCollectors({
  browser: async () => ({
    status: 'ok',
    sections: {
      browser: makeBrowser({ phases: [{ ...emptyPhase('A') }] }),
      finalUrl: 'https://www.example.de/start',
    },
  }),
  http: async () => ({ status: 'ok', sections: { http: makeHttp() } }),
});

function emptyPhase(phase: 'A') {
  return {
    phase,
    status: 'completed' as const,
    startedAt: FIXED_NOW.toISOString(),
    durationMs: 1,
    profile: 'persistent-tmp' as const,
    pages: [],
    requests: [],
    cookies: [],
    storage: [],
    errors: [],
  };
}

function opts(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    url: 'https://www.example.de/',
    dataDir,
    registry: registry(),
    collectors: withBrowser,
    network: { lookup: publicLookup },
    now: () => FIXED_NOW,
    log: silentLogger,
    ...over,
  };
}

describe('scan() — fatal paths produce a valid minimal failed report (5.1, 5.2)', () => {
  it.each([
    ['unsupported scheme', { url: 'ftp://example.de/' }, 'invalid-input', 'target-unsupported-scheme'],
    ['credentials in URL', { url: 'https://user:pw@example.de/' }, 'invalid-input', 'target-credentials'],
    ['NXDOMAIN', { network: { lookup: nxdomainLookup } }, 'unreachable', 'target-nxdomain'],
    [
      'target resolves to a private address',
      { network: { lookup: async () => [{ address: '10.0.0.5', family: 4 as const }] } },
      'invalid-input',
      'target-not-public',
    ],
    ['unknown --checks id', { checks: ['NOPE-99'] }, 'invalid-input', 'unknown-check'],
    [
      'SOCKS5 proxy (1.0: http:// only, D11)',
      { proxy: 'socks5://127.0.0.1:1080' },
      'invalid-input',
      'invalid-proxy',
    ],
    [
      'override of a locked variant (5.4)',
      { overrides: [{ rule: 'CONSENT-04.banner-not-recognized', severity: 'critical' as const }] },
      'invalid-input',
      'locked-override',
    ],
    ['invalid --fail-on', { failOn: 'sometimes' as never }, 'invalid-input', 'invalid-fail-on'],
    ['invalid --max-pages', { maxPages: Number.NaN }, 'invalid-input', 'invalid-max-pages'],
    [
      'unreadable --from-snapshot',
      { fromSnapshot: '/nonexistent/snap.json' },
      'invalid-input',
      'snapshot-unreadable',
    ],
    [
      'broken data directory',
      { dataDir: mkdtempSync(path.join(tmpdir(), 'empty-data-')) },
      'internal-error',
      'internal-error',
    ],
  ] as const)('%s', async (_name, over, reason, code) => {
    const result = await scan(opts(over as Partial<ScanOptions>));
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toContain(reason);
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe(code);
    expectValidReport(result.report);
  });

  it.each([
    ['blocked', 'SCAN-BLOCKED'],
    ['unreachable', 'SCAN-UNREACHABLE'],
    ['sandbox-unavailable', null],
    ['browser-unavailable', null],
  ] as const)('collector fatal %s → failed, results gathered so far are kept', async (reason, diag) => {
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async () => ({
            status: 'error',
            sections: {},
            fatal: { reason, code: `x-${reason}`, message: 'nope' },
          }),
        },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    // TEST-02 (http) still ran and its finding is kept
    expect(result.report.findings?.map((f) => f.checkId)).toEqual(['TEST-02']);
    if (diag) expect(result.report.diagnostics?.map((d) => d.code)).toContain(diag);
    expectValidReport(result.report);
  });
});

describe('scan() — pipeline', () => {
  it('runs collectors, derive, checks, assess and gate', async () => {
    const result = await scan(opts());
    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold']);
    expect(result.report.findings?.map((f) => `${f.checkId}.${f.variant}:${f.severity}`)).toEqual([
      'TEST-01.hit:critical',
      'TEST-02.header:warning',
    ]);
    expect(result.report.findings?.[0]?.crmCode).toBe('T1_OTHER');
    expect(result.snapshot?.derived).toBeDefined();
    expect(result.snapshot?.target.finalUrl).toBe('https://www.example.de/start');
    expectValidReport(result.report);
  });

  it('without the browser, the final URL comes from the HTTP start document', async () => {
    const result = await scan(
      opts({
        checks: ['TEST-02'],
        collectors: fakeCollectors({
          http: async () => ({
            status: 'ok',
            sections: {
              http: makeHttp({
                documents: [
                  makeDocumentResponse({
                    url: 'https://www.example.de/',
                    finalUrl: 'https://example.de/home?sid=1',
                  }),
                ],
              }),
            },
          }),
        }),
      }),
    );
    expect(result.snapshot?.target.finalUrl).toBe('https://example.de/home?sid=[redacted]');
    expect(result.snapshot?.target.finalHost).toBe('example.de');
    expect(result.report.scan.finalUrl).toBe('https://example.de/home?sid=[redacted]');
  });

  it('the browser final URL wins over the HTTP one', async () => {
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          http: async () => ({
            status: 'ok',
            sections: {
              http: makeHttp({
                documents: [
                  makeDocumentResponse({ url: 'https://www.example.de/', finalUrl: 'https://x.example.de/' }),
                ],
              }),
            },
          }),
        },
      }),
    );
    expect(result.snapshot?.target.finalUrl).toBe('https://www.example.de/start');
  });

  it('--fail-on warning / none', async () => {
    expect((await scan(opts({ failOn: 'none' }))).exitCode).toBe(0);
    const onlyHttp = await scan(opts({ failOn: 'warning', checks: ['TEST-02'] }));
    expect(onlyHttp.exitCode).toBe(1);
    expect(onlyHttp.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'not-selected',
    });
  });

  it('only runs collectors needed by the selected checks', async () => {
    const called: string[] = [];
    const spy = fakeCollectors({
      browser: async () => {
        called.push('browser');
        return { status: 'ok', sections: {} };
      },
      dns: async () => {
        called.push('dns');
        return { status: 'ok', sections: {} };
      },
      http: async () => {
        called.push('http');
        return { status: 'ok', sections: { http: makeHttp() } };
      },
    });
    await scan(opts({ collectors: spy, checks: ['TEST-02'] }));
    expect(called).toEqual(['http']);
  });

  it('collector skipped (stub) → dependent checks skipped with its reason; no effect on exit code', async () => {
    const result = await scan(
      opts({
        collectors: fakeCollectors({
          browser: async () => ({ status: 'skipped', reason: 'not-implemented', sections: {} }),
        }),
        checks: ['TEST-01'],
      }),
    );
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'not-implemented',
    });
    expect(result.exitCode).toBe(0);
  });

  it('collector ok without its section → relevant check error → exit 2 (check-error)', async () => {
    const result = await scan(opts({ collectors: fakeCollectors(), checks: ['TEST-01'] }));
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'error',
      reason: 'collector-error:browser',
    });
    expect(result.report.scan.status).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['check-error:TEST-01']);
    expectValidReport(result.report);
  });

  it('a throwing check → error + check-error, other findings still gate with 1', async () => {
    const throwing = defineCheck({
      ...httpCheck,
      run: () => {
        throw new Error('boom');
      },
    });
    const reg = () => new CheckRegistry([browserCheck, throwing]);
    const result = await scan(opts({ registry: reg(), failOn: 'warning' }));
    expect(result.report.checks?.find((c) => c.id === 'TEST-02')).toMatchObject({
      status: 'error',
      reason: 'exception',
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold', 'check-error:TEST-02']);
    // TEST-02 can reach only `warning`: under --fail-on critical it is not relevant.
    const notRelevant = await scan(opts({ registry: reg() }));
    expect(notRelevant.report.summary.exitReasons).toEqual(['threshold']);
  });

  it('global timeout before phase A finished on the start page → failed, SCAN-TIMEOUT, exit 2 (timeout)', async () => {
    const result = await scan(
      opts({
        timeoutMs: 150,
        abortGraceMs: 20,
        collectors: { ...withBrowser, browser: () => new Promise(() => {}) },
        checks: ['TEST-01'],
      }),
    );
    expect(result.report.scan.status).toBe('failed');
    // The collector handed over nothing: whether the start page was captured is unknown (G51), the code says so.
    if (result.report.scan.status === 'failed')
      expect(result.report.scan.failure.code).toBe('browser-no-handover');
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'error',
      reason: 'timeout',
    });
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.report.summary.exitReasons).toEqual(['timeout', 'check-error:TEST-01']);
    expect(result.exitCode).toBe(2);
    expectValidReport(result.report);
  });

  it('invalid certificate on the target → browser not started, browser checks skipped (tls-blocked)', async () => {
    let browserCalled = false;
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async () => {
            browserCalled = true;
            return { status: 'ok', sections: {} };
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [makeTlsEndpoint({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' })],
              }),
            },
          }),
        },
        registry: new CheckRegistry([
          browserCheck,
          defineCheck({
            id: 'TEST-02',
            module: 'http',
            requires: ['tls'],
            variants: [{ variant: 'header' }],
            run: () => [],
          }),
        ]),
      }),
    );
    expect(browserCalled).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-blocked',
    });
  });

  it('invalid certificate on an explicit target port (S-20) → tls-blocked as well', async () => {
    let browserCalled = false;
    const result = await scan(
      opts({
        url: 'https://www.example.de:8443/',
        collectors: {
          ...withBrowser,
          browser: async () => {
            browserCalled = true;
            return { status: 'ok', sections: {} };
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [
                  makeTlsEndpoint({ port: 8443, authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }),
                ],
              }),
            },
          }),
        },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(browserCalled).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({ reason: 'tls-blocked' });
  });

  it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])(
    'incomplete chain (%s) does not block the browser: Chrome completes chains via AIA',
    async (code) => {
      let browserCalled = false;
      await scan(
        opts({
          collectors: {
            ...withBrowser,
            browser: async (ctx) => {
              browserCalled = true;
              return withBrowser.browser(ctx);
            },
            tls: async () => ({
              status: 'ok',
              sections: {
                tls: makeTls({
                  endpoints: [
                    makeTlsEndpoint({
                      authorized: false,
                      authorizationError: code,
                      chainComplete: false,
                      hostnameMatches: true,
                    }),
                  ],
                }),
              },
            }),
          },
          registry: new CheckRegistry([browserCheck, tlsCheck]),
        }),
      );
      expect(browserCalled).toBe(true);
    },
  );

  it('wrong host name with an incomplete chain still blocks the browser', async () => {
    let browserCalled = false;
    await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async (ctx) => {
            browserCalled = true;
            return withBrowser.browser(ctx);
          },
          tls: async () => ({
            status: 'ok',
            sections: {
              tls: makeTls({
                endpoints: [
                  makeTlsEndpoint({
                    authorized: false,
                    authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                    chainComplete: false,
                    hostnameMatches: false,
                  }),
                ],
              }),
            },
          }),
        },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(browserCalled).toBe(false);
  });

  it('--sandbox off → SCAN-SANDBOX-OFF; --strict turns it into 2', async () => {
    const soft = await scan(opts({ sandbox: 'off', checks: ['TEST-02'], failOn: 'critical' }));
    expect(soft.report.diagnostics?.map((d) => d.code)).toContain('SCAN-SANDBOX-OFF');
    expect(soft.exitCode).toBe(0);
    const strict = await scan(
      opts({ sandbox: 'off', checks: ['TEST-02'], strict: true, assumeRegion: 'de' }),
    );
    expect(strict.exitCode).toBe(2);
    expect(strict.report.summary.exitReasons).toEqual(['strict:sandbox-off']);
  });

  it('--save-snapshot / --from-snapshot: replay without collectors gives the same findings', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const file = path.join(dir, 'site.snapshot.json');
    const first = await scan(opts({ saveSnapshot: file }));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.derived).toBeUndefined();
    const explode = async () => {
      throw new Error('collectors must not run on replay');
    };
    const replay = await scan(
      opts({
        url: undefined,
        fromSnapshot: file,
        collectors: { browser: explode, http: explode, tls: explode, dns: explode },
      }),
    );
    expect(replay.report.findings?.map((f) => f.fingerprint)).toEqual(
      first.report.findings?.map((f) => f.fingerprint),
    );
    expect(replay.report.scan.status).toBe('complete');
    expect(replay.snapshot?.derived).toBeDefined();
    if (replay.report.scan.status !== 'failed') expect(replay.report.scan.options?.fromSnapshot).toBe(true);
    expectValidReport(replay.report);
  });
});

const startVisit = (phase: 'A' | 'B' = 'A') => makePage({ url: 'https://www.example.de/', phase });

/** Browser collector that honours the abort signal like M1: it stops and returns what it has after `delayMs`. */
const abortAware =
  (sections: () => Record<string, unknown>, delayMs = 5) =>
  (ctx: { signal: AbortSignal }) =>
    new Promise<never>((resolve) => {
      ctx.signal.addEventListener(
        'abort',
        () =>
          setTimeout(
            () => resolve({ status: 'partial', reason: 'timeout', sections: sections() } as never),
            delayMs,
          ),
        { once: true },
      );
    });

describe('scan() — global timeout (5.2)', () => {
  it('before phase A finished on the start page: fatal timeout even with --fail-on none; earlier findings kept', async () => {
    const result = await scan(
      opts({
        failOn: 'none',
        timeoutMs: 100,
        abortGraceMs: 200,
        collectors: { ...withBrowser, browser: abortAware(() => ({})) },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toEqual(['timeout']);
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    // HTTP finished before the deadline: its finding stays in the report.
    expect(result.report.findings?.map((f) => f.checkId)).toEqual(['TEST-02']);
    expectValidReport(result.report);
  });

  it('a fatal signal of a collector cut by the deadline does not replace the timeout', async () => {
    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 200,
        collectors: {
          ...withBrowser,
          browser: (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener('abort', () =>
                resolve({
                  status: 'error',
                  sections: {},
                  fatal: {
                    reason: 'unreachable',
                    code: 'start-page-unreachable',
                    message: 'closed by abort',
                  },
                }),
              );
            }),
        },
      }),
    );
    expect(result.report.scan.status).toBe('failed');
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe('scan-timeout');
    expect(result.report.summary.exitReasons).toContain('timeout');
    expect(result.report.summary.exitReasons).not.toContain('unreachable');
  });

  it('after the start page in phase A: facts the collector returns after the abort are kept (partial)', async () => {
    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          browser: abortAware(() => ({
            browser: makeBrowser({
              phases: [
                makePhase('A', { pages: [startVisit()] }),
                makePhase('B', { status: 'failed', reason: 'timeout' }),
              ],
            }),
            finalUrl: 'https://www.example.de/start',
          })),
        },
      }),
    );
    expect(result.report.scan.status).toBe('partial');
    // The critical finding of phase A survives the deadline in phase B → 1, not 2.
    expect(result.report.findings?.map((f) => `${f.checkId}.${f.variant}`)).toContain('TEST-01.hit');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons[0]).toBe('threshold');
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'partial', reason: 'timeout' });
    expectValidReport(result.report);
  });

  it('after the start page in phase A with --fail-on none → partial, 0', async () => {
    const result = await scan(
      opts({
        failOn: 'none',
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          browser: abortAware(() => ({
            browser: makeBrowser({ phases: [makePhase('A', { pages: [startVisit()] })] }),
          })),
        },
      }),
    );
    expect(result.report.scan.status).toBe('partial');
    expect(result.exitCode).toBe(0);
  });

  it('a collector that ignores the abort is given up after the grace period', async () => {
    const t0 = Date.now();
    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 50,
        collectors: { ...withBrowser, browser: () => new Promise(() => {}) },
      }),
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(result.report.summary.exitReasons).toContain('timeout');
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'error', reason: 'timeout' });
  });

  it('without the browser (no phase A planned) a timeout is not fatal', async () => {
    const result = await scan(
      opts({
        checks: ['TEST-02'],
        timeoutMs: 100,
        abortGraceMs: 20,
        collectors: { ...withBrowser, http: () => new Promise(() => {}) },
      }),
    );
    expect(result.report.scan.status).toBe('partial');
    expect(result.report.summary.exitReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe('scan() — target redaction (D20)', () => {
  it('query values of the target never reach snapshot, report or saved snapshot; collectors get the raw URL', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const file = path.join(dir, 'site.snapshot.json');
    const seen: string[] = [];
    const result = await scan(
      opts({
        url: 'https://www.example.de/?token=secret#frag',
        saveSnapshot: file,
        collectors: {
          ...withBrowser,
          browser: async (ctx) => {
            seen.push(ctx.target.url);
            return withBrowser.browser(ctx);
          },
        },
      }),
    );
    expect(seen).toEqual(['https://www.example.de/?token=secret']);
    expect(result.report.scan.target).toBe('https://www.example.de/?token=[redacted]');
    expect(JSON.stringify(result.report)).not.toContain('secret');
    expect(JSON.stringify(result.snapshot)).not.toContain('secret');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });

  it.each([
    ['credentials', 'https://demo-user:demo-password@example.de/?sid=demo-session'],
    ['invalid URL', 'https://demo-user:demo-password@exa mple.de/?sid=demo-session'],
    ['unsupported scheme', 'ftp://demo-user:demo-password@example.de/?sid=demo-session'],
  ])('failed report for a rejected target (%s) carries no credentials or query values', async (_n, url) => {
    const result = await scan(opts({ url }));
    expect(result.exitCode).toBe(2);
    const json = JSON.stringify(result.report);
    for (const secret of ['demo-user', 'demo-password', 'demo-session']) expect(json).not.toContain(secret);
    expectValidReport(result.report);
  });

  it('a fatal error after parsing keeps the redacted target', async () => {
    const result = await scan(
      opts({ url: 'https://www.example.de/?token=secret', network: { lookup: nxdomainLookup } }),
    );
    expect(result.report.scan.target).toBe('https://www.example.de/?token=[redacted]');
  });
});

describe('scan() — preflight', () => {
  it('an IPv6 literal target is classified without DNS (no brackets sent to the resolver)', async () => {
    const asked: string[] = [];
    const lookup = async (host: string) => {
      asked.push(host);
      return nxdomainLookup(host);
    };
    const result = await scan(
      opts({ url: 'https://[2606:4700:4700::1111]/', checks: ['TEST-02'], network: { lookup } }),
    );
    expect(asked).toEqual([]);
    expect(result.report.scan.status).not.toBe('failed');
    expect(result.report.scan.target).toBe('https://[2606:4700:4700::1111]/');
  });

  it.each([
    ['https://[::1]/', 'target-not-public'],
    ['https://127.0.0.1/', 'target-not-public'],
    ['https://[64:ff9b::a9fe:a9fe]/', 'target-not-public'],
  ])('IP literal %s → invalid-input/%s', async (url, code) => {
    const result = await scan(opts({ url, network: { lookup: nxdomainLookup } }));
    expect(result.report.scan.status).toBe('failed');
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe(code);
  });

  it('a host with public and non-public addresses is rejected up front (same policy as the browser guard)', async () => {
    let collectorsRan = false;
    const result = await scan(
      opts({
        network: {
          lookup: async () => [
            { address: '93.184.215.14', family: 4 as const },
            { address: '10.0.0.5', family: 4 as const },
          ],
        },
        collectors: fakeCollectors({
          http: async () => {
            collectorsRan = true;
            return { status: 'ok', sections: {} };
          },
        }),
      }),
    );
    expect(collectorsRan).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['invalid-input']);
    if (result.report.scan.status === 'failed') {
      expect(result.report.scan.failure.code).toBe('target-mixed-addresses');
      expect(result.report.scan.failure.message).toContain('10.0.0.5');
    }
    expectValidReport(result.report);
  });
});

describe('scan() — --strict under --fail-on none (5.2: --strict acts independently)', () => {
  it('sandbox off → 2 with strict:sandbox-off', async () => {
    const result = await scan(
      opts({ failOn: 'none', strict: true, sandbox: 'off', assumeRegion: 'de', checks: ['TEST-02'] }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['strict:sandbox-off']);
  });

  it('nothing strict-relevant → 0', async () => {
    const result = await scan(opts({ failOn: 'none', strict: true, assumeRegion: 'de' }));
    expect(result.exitCode).toBe(0);
  });
});

describe('--save-snapshot write failure', () => {
  it('keeps the scan result but exits 2 with report-write-failed', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'snapfail-'));
    const blocker = path.join(parent, 'file');
    writeFileSync(blocker, 'x');
    const result = await scan(opts({ saveSnapshot: path.join(blocker, 'sub', 'x.snapshot.json') }));
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('complete');
    expect(result.report.summary.exitReasons).toEqual(['report-write-failed', 'threshold']);
    expectValidReport(result.report);
  });
});

describe('writeReports()', () => {
  it('writes report.json and renders the console report', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'out-'));
    const result = await scan(opts());
    const w = await writeReports(result, { outDir: out, formats: ['console', 'json'], lang: 'de', dataDir });
    expect(w.exitCode).toBe(1);
    expect(w.errors).toEqual([]);
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expectValidReport(json);
    expect(w.console).toContain('TEST-01');
  });

  it('a requested file that cannot be written → exit 2 with report-write-failed', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'out-'));
    const blocker = path.join(parent, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const result = await scan(opts());
    const w = await writeReports(result, { outDir: blocker, formats: ['json'], lang: 'de', dataDir });
    expect(w.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toContain('report-write-failed');
    expect(existsSync(path.join(blocker, 'report.json'))).toBe(false);
    expectValidReport(result.report);
  });

  it.each([
    ['html', 'report.html'],
    ['summary', 'summary.md'],
  ] as const)(
    'a requested %s report that cannot be written → 2; JSON rewritten with the final code (5.2)',
    async (format, file) => {
      const out = mkdtempSync(path.join(tmpdir(), 'out-'));
      // A directory in place of the file makes exactly this reporter fail; report.json stays writable.
      mkdirSync(path.join(out, file));
      const result = await scan(opts({ failOn: 'none' }));
      expect(result.exitCode).toBe(0);
      const w = await writeReports(result, { outDir: out, formats: ['json', format], lang: 'de', dataDir });
      expect(w.exitCode).toBe(2);
      expect(w.errors.map((e) => path.basename(e.path))).toEqual([file]);
      expect(w.written.map((p) => path.basename(p))).toEqual(['report.json']);
      const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
      expect(json.summary.exitCode).toBe(2);
      expect(json.summary.exitReasons).toEqual(['report-write-failed']);
      expectValidReport(json);
    },
  );
});

describe('scan() — one monotonic time scale for evidence (5.3 tMs, S-30)', () => {
  it('every collector gets the same scan clock: ms since scan.startedAt, monotonic, never reset', async () => {
    const seen: Array<{ name: string; t: number }> = [];
    const clocked =
      (name: string, sections: Record<string, unknown>) => async (ctx: { clock?: () => number }) => {
        if (!ctx.clock) throw new Error(`${name}: no scan clock`);
        const a = ctx.clock();
        await new Promise((r) => setTimeout(r, 5));
        const b = ctx.clock();
        expect(b).toBeGreaterThanOrEqual(a);
        seen.push({ name, t: a });
        return { status: 'ok' as const, sections };
      };
    const result = await scan(
      opts({
        collectors: fakeCollectors({
          http: clocked('http', { http: makeHttp() }) as never,
          browser: clocked('browser', {
            browser: makeBrowser({ phases: [{ ...emptyPhase('A') }] }),
          }) as never,
        }),
      }),
    );
    expect(result.report.scan.status).not.toBe('failed');
    const browser = seen.find((s) => s.name === 'browser');
    const http = seen.find((s) => s.name === 'http');
    expect(http?.t).toBeGreaterThanOrEqual(0);
    // The browser runs after http/tls/dns on the same clock.
    expect(browser?.t).toBeGreaterThan(http?.t ?? Number.POSITIVE_INFINITY);
  });
});

describe('scan() — the in-memory report carries the composed disclaimer (FP-11)', () => {
  it('conditional paragraphs are part of report.disclaimer.text, not only of the written files', async () => {
    const result = await scan(opts({ sandbox: 'off' }));
    const text = result.report.disclaimer.text;
    expect(text).toMatch(/--sandbox off/);
    expect(text).toMatch(/eigener oder im Auftrag betreuter Websites/);
  });

  it('the minimal failed report too', async () => {
    const result = await scan(opts({ url: 'ftp://example.de/' }));
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.disclaimer.text).toMatch(/Der Scan wurde nicht durchgeführt/);
  });

  it('rendering again after the exit reasons changed replaces the paragraph instead of adding a second one', async () => {
    const { report } = await scan(opts({ url: 'ftp://example.de/' }));
    report.summary.exitReasons = [...report.summary.exitReasons, 'report-write-failed'];
    const paragraphs = disclaimerParagraphs(report, loadTexts('de'));
    const incomplete = paragraphs.filter((p) => p.startsWith('Der Scan wurde nicht'));
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain('report-write-failed');
  });
});
