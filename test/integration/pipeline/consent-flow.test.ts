/**
 * All browser-side modules together: real browser collector and CMP subsystem, derive, browser checks, assess/gate and
 * reporters on a hand-written shop with the Cookiebot simulator. Variants: consent respected, tracker before consent, blocking banner.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

const BROWSER_CHECKS = [
  'CONSENT-01',
  'CONSENT-02',
  'CONSENT-03',
  'CONSENT-04',
  'CONSENT-05',
  'TRACK-01',
  'EMBED-01',
  'EMBED-02',
  'LEGAL-01',
  'PRIV-01',
  'PRIV-02',
];
/** Value parts of the `_ga` cookie / `cid` set by the fake gtag (must never reach a report). */
const GA_CLIENT_ID = '987654321';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['pipeline/consent-shop', 'cmp/cookiebot', 'browser/ga4'] });
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  expect(server.unexpected).toEqual([]);
});

/**
 * Scans `host` with the real browser collector, writes all reports and checks what holds for every run: reports valid
 * and complete, no CRM code in the user-facing outputs, no client id anywhere. `files` is every written text in one.
 */
async function run(
  host: string,
): Promise<{ r: ScanResult; report: FullReport; outDir: string; files: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-pipeline-'));
  const r = await scan({
    url: `https://${host}/`,
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir,
    checks: BROWSER_CHECKS,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
  const w = await writeReports(r, { outDir, formats: ['console', 'json', 'html', 'summary'], lang: 'de' });
  expect(w.errors).toEqual([]);
  expectValidReport(r.report);
  expect(r.report.scan.status).toBe('complete');

  const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');
  const summary = readFileSync(path.join(outDir, 'summary.md'), 'utf8');
  const json = readFileSync(path.join(outDir, 'report.json'), 'utf8');
  const consoleText = w.console ?? '';
  // CRM codes belong in the JSON only.
  for (const text of [html, summary, consoleText]) expect(text).not.toMatch(/T[0-9]_/);
  const files = [html, summary, json, consoleText].join('\n');
  expect(files).not.toContain(GA_CLIENT_ID);

  return { r, report: r.report as FullReport, outDir, files };
}

const ids = (report: FullReport) => report.findings.map((f) => `${f.checkId}.${f.variant}`).sort();
const check = (report: FullReport, id: string) => report.checks.find((c) => c.id === id);

describe('full browser pipeline on the Cookiebot simulator', () => {
  describe('consent respected: reject clicked, tracker only after accept', () => {
    let scanned: Awaited<ReturnType<typeof run>>;

    beforeAll(async () => {
      scanned = await run('www.consent-shop.test');
    });

    it('exits 0 without a critical finding', () => {
      expect(scanned.r.exitCode).toBe(0);
      expect(scanned.report.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    });

    it('clicks reject in phase B and accept in phase C, both through the Cookiebot adapter', () => {
      const click = scanned.r.snapshot?.plan.browser?.click;

      expect(click?.B).toMatchObject({
        action: 'reject',
        target: { cmpId: 'cookiebot', name: 'Ablehnen' },
      });
      expect(click?.C).toMatchObject({
        action: 'accept',
        target: { cmpId: 'cookiebot', name: 'Alle zulassen' },
      });
    });

    it('completes CONSENT-04 without a finding and runs all three phases', () => {
      const { r, report } = scanned;

      expect(check(report, 'CONSENT-04')?.status).toBe('completed');
      expect(ids(report).filter((x) => x.startsWith('CONSENT-04'))).toEqual([]);
      expect(r.snapshot?.browser?.phases.map((p) => [p.phase, p.status])).toEqual([
        ['A', 'completed'],
        ['B', 'completed'],
        ['C', 'completed'],
      ]);
    });

    // Google Analytics appears only after accept (inventory) and is named in the privacy policy.
    it("inventories Google Analytics; the only other finding is the CMP's own third-party resource", () => {
      const { report } = scanned;

      expect(ids(report)).toContain('TRACK-01.service-inventory');
      expect(ids(report).filter((x) => /^(CONSENT-0[125]|PRIV-01)\./.test(x))).toEqual([
        'CONSENT-01.third-party-resource',
      ]);
      expect(report.findings.find((f) => f.checkId === 'CONSENT-01')?.serviceId).toBe('cookiebot');
    });
  });

  it('tracker before consent and after reject → CONSENT-01/02/05 critical, exit 1', async () => {
    const { r, report } = await run('www.leaky-shop.test');

    expect(r.exitCode).toBe(1);
    expect(report.summary.exitReasons).toEqual(['threshold']);
    const critical = report.findings.filter((f) => f.severity === 'critical');
    expect(critical.map((f) => `${f.checkId}.${f.variant}:${f.serviceId}`).sort()).toEqual([
      'CONSENT-01.tracking-completed:google-analytics',
      'CONSENT-02.tracking-identifier-stored:google-analytics',
      'CONSENT-05.tracking-after-reject:google-analytics',
    ]);

    // Related findings share the service (grouping in HTML).
    const c01 = critical.find((f) => f.checkId === 'CONSENT-01');
    expect(c01?.related?.length ?? 0).toBeGreaterThan(0);
  });

  it('late banner (rendered 2.5 s after the CMP API is ready): the first screen waits for it, reject is clicked', async () => {
    const { r, report } = await run('www.late-shop.test');

    expect(r.exitCode).toBe(0);
    const first = r.snapshot?.cmp?.phases
      .find((p) => p.phase === 'B')
      ?.facts.find((f) => f.moment === 'first-screen');
    expect(first?.firstLayer.bannerVisible).toBe(true);
    expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({
      action: 'reject',
      target: { cmpId: 'cookiebot', name: 'Ablehnen' },
    });
    expect(check(report, 'CONSENT-04')?.status).toBe('completed');
  });

  it('cookie notice the heuristic dismisses (one keyword, a settings button) → no "no banner" finding, the reject stays open', async () => {
    const { r, report, files } = await run('www.notice-shop.test');

    const candidates = r.snapshot?.cmp?.phases
      .find((p) => p.phase === 'A')
      ?.facts.map((f) => f.firstLayer.bannerCandidate);
    expect(candidates?.length).toBeGreaterThanOrEqual(2);
    expect(candidates?.every((c) => c?.reason === 'keywords' && c.controls.includes('settings'))).toBe(true);

    expect(check(report, 'CONSENT-03')).toMatchObject({
      status: 'inconclusive',
      reason: 'banner-candidate-unrecognized',
    });
    expect(check(report, 'CONSENT-04')).toMatchObject({
      status: 'inconclusive',
      reason: 'banner-not-recognized',
    });
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'banner-not-recognized',
    });
    expect(ids(report).filter((x) => x.startsWith('CONSENT-0') && !x.startsWith('CONSENT-01'))).toEqual([
      'CONSENT-02.tracking-identifier-stored',
      'CONSENT-04.banner-not-recognized',
    ]);
    expect(report.findings.find((f) => f.checkId === 'CONSENT-04')?.severity).toBe('info');
    expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({ target: null });

    expect(files).toContain('Einwilligungsbanner beobachtet, aber nicht erkannt');
    expect(files).not.toContain('kein Einwilligungsbanner gefunden');
    expect(files).not.toContain('Der Scan wurde vollständig durchgeführt.');
  });

  it('blocking banner without reject → CONSENT-04 blocking-no-reject with banner screenshot, exit 1', async () => {
    const { r, report, outDir, files } = await run('www.blocking-shop.test');

    expect(r.exitCode).toBe(1);
    const f = report.findings.find((x) => x.checkId === 'CONSENT-04');
    expect(f).toMatchObject({ variant: 'blocking-no-reject', severity: 'critical', confidence: 'high' });
    expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({ target: null });
    expect(check(report, 'CONSENT-05')).toMatchObject({ status: 'inconclusive', reason: 'no-reject-click' });

    const shot = report.evidence.find((e) => e.type === 'screenshot');
    expect(shot).toMatchObject({ path: 'artifacts/banner-B.jpg' });
    expect(existsSync(path.join(outDir, 'artifacts/banner-B.jpg'))).toBe(true);
    expect(files).toContain('data:image/jpeg;base64,');
  });
});
