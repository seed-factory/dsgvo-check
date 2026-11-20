/**
 * First-screen measurement end to end: the collector waits for and measures the banner, core decides the click,
 * CONSENT-04 judges the facts (hand-written shops on the Cookiebot simulator, test/fixture-server/sites/cmp/shops).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['cmp/shops', 'cmp/cookiebot'] });
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  expect(server.unexpected.map((r) => `${r.host}${r.path}`)).toEqual([]);
});

async function run(host: string) {
  const result = await scan({
    url: `https://${host}/`,
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir: mkdtempSync(path.join(tmpdir(), 'dsgvo-cmp-measure-')),
    checks: ['CONSENT-03', 'CONSENT-04', 'CONSENT-05'],
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
  expect(result.report.scan.status).toBe('complete');
  const report = result.report as FullReport;
  const bPhase = result.snapshot?.cmp?.phases.find((p) => p.phase === 'B');
  const first = bPhase?.facts.find((f) => f.moment === 'first-screen');
  return { result, report, bPhase, first };
}

describe('collector: first-screen measurement through the browser checks', () => {
  it('dialog slides in 1 s after the API is ready (1.2 s transition) → reject measured, clicked, no CONSENT-04 finding', async () => {
    const { result, report, bPhase, first } = await run('www.animated-shop.test');
    expect(first?.firstLayer.bannerVisible).toBe(true);
    expect(first?.firstLayer.geometryUnsettled ?? false).toBe(false);
    expect(result.snapshot?.plan.browser?.click?.B).toMatchObject({
      action: 'reject',
      target: { cmpId: 'cookiebot', name: 'Ablehnen' },
    });
    expect(bPhase?.click).toMatchObject({ action: 'reject', clicked: true });
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04')).toEqual([]);
    expect(report.checks.find((c) => c.id === 'CONSENT-04')?.status).toBe('completed');
  });

  it('45 hidden vendor toggles before the visible buttons → reject and accept are clicked, no nonblocking-no-reject', async () => {
    const { result, report, bPhase } = await run('www.vendors-shop.test');
    expect(result.snapshot?.plan.browser?.click?.B).toMatchObject({
      action: 'reject',
      target: { name: 'Ablehnen' },
    });
    expect(result.snapshot?.plan.browser?.click?.C).toMatchObject({
      action: 'accept',
      target: { name: 'Alle zulassen' },
    });
    expect(bPhase?.click).toMatchObject({ action: 'reject', clicked: true });
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04')).toEqual([]);
  });
});
