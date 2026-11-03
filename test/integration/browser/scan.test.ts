/**
 * The real browser collector inside `scan`: the report is valid (Ajv), coverage lists the visited pages and the
 * environment shows the browser; fatal start pages fail the scan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { defineCheck } from '../../../src/core/api.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors, testDataDir } from '../../utils/scan-harness.ts';
import { FAST_TIMING, TEST_SANDBOX } from './helpers.ts';

/** A check that only needs the browser sections, so that the orchestrator runs the browser collector. */
const probe = defineCheck({
  id: 'TEST-01',
  module: 'browser',
  requires: ['browser', 'documents', 'cmp'],
  variants: [{ variant: 'seen' }],
  run: () => [],
});

let server: FixtureServer;
const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/ga4', 'browser/fatal'] });
});

afterAll(async () => {
  await server?.close();
});

const base = () => ({
  network: server.network(),
  registry: new CheckRegistry([probe]),
  dataDir,
  log: silentLogger,
  sandbox: TEST_SANDBOX,
  collectors: fakeCollectors({
    browser: createBrowserCollector({ timing: FAST_TIMING, phases: ['A', 'B', 'C'] }),
  }),
});

describe('scan with the browser collector', () => {
  it('produces a valid report with coverage, final URL and browser environment', async () => {
    const r = await scan({ url: 'https://www.example.test/', ...base() });
    expectValidReport(r.report);
    expect(r.exitCode).toBe(0);
    expect(r.report.scan.status).toBe('complete');
    if (r.report.scan.status === 'failed') throw new Error('unexpected failed report');
    const coverage = r.report.scan.coverage;
    expect(coverage?.pages.map((p) => [p.url, p.role, p.planned, p.observed, p.evaluated])).toEqual(
      expect.arrayContaining([
        ['https://www.example.test/', 'start', true, true, true],
        ['https://www.example.test/impressum/', 'impressum', true, true, true],
        ['https://www.example.test/kontakt/', 'contact', true, true, true],
      ]),
    );
    expect(coverage?.browserRequests?.limit).toBe(2000);
    expect(r.report.scan.environment?.browser).toMatchObject({
      engine: 'chromium',
      channel: 'chromium',
      headless: 'new',
    });
    expect(r.report.scan.environment?.userAgent.browser).toContain('dsgvo-check/');
    expect(r.snapshot?.target.finalUrl).toBe('https://www.example.test/');
    expect(r.report.checks?.find((c) => c.id === 'TEST-01')?.status).toBe('completed');
  });

  it('a WAF challenge on the start page fails the scan with exit 2 and SCAN-BLOCKED', async () => {
    const r = await scan({ url: 'https://blocked.example.test/', ...base() });
    expectValidReport(r.report);
    expect(r.exitCode).toBe(2);
    expect(r.report.summary.exitReasons).toEqual(['blocked']);
  });
});
