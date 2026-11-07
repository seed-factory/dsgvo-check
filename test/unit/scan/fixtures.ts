/** Shared setup of the scan unit tests: a test data dir, test checks with known findings and fake collectors. */
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import type { Collectors } from '../../../src/core/snapshot/collector.ts';
import type { HttpHop } from '../../../src/core/snapshot/http.ts';
import type { TlsEndpoint } from '../../../src/core/snapshot/tls.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import { fakeCollectors, publicLookup, testDataDir } from '../../utils/scan-harness.ts';
import {
  FIXED_NOW,
  makeBrowser,
  makeCert,
  makeHop,
  makeHttp,
  makeTls,
  makeTlsEndpoint,
} from '../../utils/snapshot-builder.ts';

export const dataDir = testDataDir({
  ruleset: {
    'TEST-01': { hit: 'critical', soft: 'warning' },
    'TEST-02': { header: 'warning' },
    'TEST-03': { 'tracker-hit': 'critical' },
  },
  crm: { 'TEST-01.hit': 'T1_OTHER' },
});

export const browserCheck = defineCheck({
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

export const httpCheck = defineCheck({
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

export const tlsCheck = defineCheck({
  id: 'TEST-02',
  module: 'http',
  requires: ['tls'],
  variants: [{ variant: 'header' }],
  run: () => [],
});

export const withBrowser = fakeCollectors({
  browser: async () => ({
    status: 'ok',
    sections: {
      browser: makeBrowser({ phases: [{ ...emptyPhase('A') }] }),
      finalUrl: 'https://www.example.de/start',
    },
  }),
  http: async () => ({ status: 'ok', sections: { http: makeHttp() } }),
});

export function emptyPhase(phase: 'A') {
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

/** Browser collector that honours the abort signal: it stops and returns what it has after `delayMs`. */
export const abortAware =
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

export function opts(over: Partial<ScanOptions> = {}): ScanOptions {
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

/** A TLS collector whose probe of the target was refused: CERT_HAS_EXPIRED unless `over` says otherwise. */
export const refusedTls =
  (over: Partial<TlsEndpoint> = {}): Collectors['tls'] =>
  async () => ({
    status: 'ok',
    sections: {
      tls: makeTls({
        endpoints: [makeTlsEndpoint({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED', ...over })],
      }),
    },
  });

// A target with a refused certificate whose plain-http address redirects to another host.
export const TARGET = 'https://broken.example.test/';
export const VIA = 'http://broken.example.test/';
export const RAW_FINAL = 'https://site.example.test/start?token=raw-fixture-7';
export const STORED_FINAL = 'https://site.example.test/start?token=[redacted]';

export const httpHop = (url: string, status: number, location?: string): HttpHop =>
  makeHop({ url, status, ...(location ? { location } : {}) });

/** An https hop as the HTTP collector stores it: Node's verdict of the connection. */
export const httpsHop = (url: string, status: number, over: Partial<HttpHop> = {}): HttpHop =>
  makeHop({ url, status, tlsAuthorized: true, tlsAuthorizationError: null, ...over });

/** The self-signed certificate (issued to another name) that the TLS collector refused on the target. */
export const brokenTarget = (host = 'broken.example.test'): TlsEndpoint =>
  makeTlsEndpoint({
    host,
    authorized: false,
    authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    hostnameMatches: false,
    chain: [makeCert({ subject: 'CN=other.example.test', selfSigned: true })],
  });
