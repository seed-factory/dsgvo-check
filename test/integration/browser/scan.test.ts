/**
 * The real browser collector inside `scan`: the report is valid (Ajv), coverage lists the visited pages and the
 * environment shows the browser; fatal start pages fail the scan.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { scan } from '../../../src/scan.ts';
import { useFixtureServer } from '../../fixture-server/use-fixture-server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors, testDataDir } from '../../utils/scan-harness.ts';
import { BROWSER_PROBE_CHECK, FAST_TIMING, TEST_SANDBOX } from './helpers.ts';

const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });

const server = useFixtureServer(() => ({ sites: ['browser/ga4', 'browser/fatal'] }));

const base = () => ({
  network: server().network(),
  registry: new CheckRegistry([BROWSER_PROBE_CHECK]),
  dataDir,
  log: silentLogger,
  sandbox: TEST_SANDBOX,
  collectors: fakeCollectors({
    browser: createBrowserCollector({ timing: FAST_TIMING, phases: ['A', 'B', 'C'] }),
  }),
});

describe('scan with the browser collector', () => {
  describe('a clean site over phases A, B and C', () => {
    let r: Awaited<ReturnType<typeof scan>>;

    beforeAll(async () => {
      r = await scan({ url: 'https://www.example.test/', ...base() });
    });

    it('produces a valid, complete report with exit 0', () => {
      expectValidReport(r.report);
      expect(r.exitCode).toBe(0);
      expect(r.report.scan.status).toBe('complete');
      expect(r.report.checks?.find((c) => c.id === 'TEST-01')?.status).toBe('completed');
    });

    it('lists the visited pages in the coverage, with the request limit', () => {
      if (r.report.scan.status === 'failed') throw new Error('unexpected failed report');
      const coverage = r.report.scan.coverage;

      expect(coverage?.pages.map((p) => [p.url, p.role, p.planned, p.observed, p.evaluated])).toEqual(
        expect.arrayContaining([
          ['https://www.example.test/', 'start', true, true, true],
          ['https://www.example.test/impressum/', 'impressum', true, true, true],
          ['https://www.example.test/kontakt/', 'contact', true, true, true],
        ]),
      );
      expect(coverage?.browserRequests?.limit).toBe(4000);
    });

    it('shows the browser environment and the final URL', () => {
      if (r.report.scan.status === 'failed') throw new Error('unexpected failed report');

      expect(r.report.scan.environment?.browser).toMatchObject({
        engine: 'chromium',
        channel: 'chromium',
        headless: 'new',
      });
      expect(r.report.scan.environment?.userAgent.browser).toContain('dsgvo-check/');
      expect(r.snapshot?.target.finalUrl).toBe('https://www.example.test/');
    });
  });

  it('a WAF challenge on the start page fails the scan with exit 2 and SCAN-BLOCKED', async () => {
    const r = await scan({ url: 'https://blocked.example.test/', ...base() });

    expectValidReport(r.report);
    expect(r.exitCode).toBe(2);
    expect(r.report.summary.exitReasons).toEqual(['blocked']);
  });
});
