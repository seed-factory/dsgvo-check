/** Shared setup of the scan unit tests: a test data dir, test checks with known findings and fake collectors. */
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import { fakeCollectors, publicLookup, testDataDir } from '../../utils/scan-harness.ts';
import { FIXED_NOW, makeBrowser, makeHttp } from '../../utils/snapshot-builder.ts';

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
