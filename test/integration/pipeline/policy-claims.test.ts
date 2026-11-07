/**
 * PRIV-02 end to end: real browser collector, derive, browser checks, assess and reporters on two fixture sites whose
 * privacy policy states the Google Fonts are installed locally. On one every page loads them from Google, on the
 * other only the frame of an embedded Google Map does: no use of Google Fonts by the site, but fonts from a
 * third-party server that EMBED-01 reports for the map's frame.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserChecks } from '../../../src/checks/browser/index.ts';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

const BROWSER_CHECKS = browserChecks.map((c) => c.id);

async function run(
  server: FixtureServer,
): Promise<{ r: ScanResult; report: FullReport; json: string; userFacing: string[] }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-policy-claims-'));
  const r = await scan({
    url: 'https://www.example.test/',
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
  const read = (f: string) => readFileSync(path.join(outDir, f), 'utf8');
  return {
    r,
    report: r.report as FullReport,
    json: read('report.json'),
    userFacing: [read('report.html'), read('summary.md'), w.console ?? ''],
  };
}

const check = (report: FullReport, id: string) => report.checks.find((c) => c.id === id);
const findingsOf = (report: FullReport, id: string) => report.findings.filter((f) => f.checkId === id);

describe('a policy stating local Google Fonts while every page loads them from Google', () => {
  let server: FixtureServer;
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/fonts-claim'] });
    scanned = await run(server);
  });
  afterAll(async () => {
    await server?.close();
  });
  afterEach(() => {
    expect(server.unexpected).toEqual([]);
  });

  it('reports PRIV-02 contradiction-replicated as critical next to the EMBED-01 load, exit 1', () => {
    const { r, report } = scanned;
    const [priv, ...more] = findingsOf(report, 'PRIV-02');
    expect(more).toEqual([]);
    expect(priv).toMatchObject({
      variant: 'contradiction-replicated',
      severity: 'critical',
      subject: 'google-fonts',
      params: {
        service: 'Google Fonts',
        claim: 'self-hosted+no-connection',
        hosts: 'fonts.googleapis.com, fonts.gstatic.com',
      },
    });
    expect(Number(priv?.params.contextCount)).toBeGreaterThanOrEqual(2);
    const embed = findingsOf(report, 'EMBED-01').find((f) => f.subject === 'google-fonts');
    expect(priv?.related.map((x) => x.fingerprint)).toContain(embed?.fingerprint);
    expect(r.exitCode).toBe(1);
  });

  it('quotes both statements verbatim from the policy section', () => {
    const priv = findingsOf(scanned.report, 'PRIV-02')[0];
    const quotes = scanned.report.evidence
      .filter((e) => priv?.evidenceIds.includes(e.id))
      .map((e) => e as { type: string; claim?: string; section?: string | null; quote?: string })
      .filter((e) => e.type === 'text-match');
    // The report orders evidence by its id, not by the sentence order of the policy.
    expect(quotes.map((q) => q.quote).sort()).toEqual([
      'Die Google Fonts sind auf dieser Website lokal installiert.',
      'Eine Verbindung zu Servern von Google findet beim Seitenaufruf nicht statt.',
    ]);
    expect(quotes.map((q) => `${q.claim} ${q.section}`).sort()).toEqual([
      'no-connection Datenschutzerklärung > 5. Plugins und Tools > Google Fonts',
      'self-hosted Datenschutzerklärung > 5. Plugins und Tools > Google Fonts',
    ]);
  });

  it('keeps the catalog code in the JSON report only', () => {
    expect(scanned.json).toContain('T1_MISLEADING_CLAIM');
    for (const text of scanned.userFacing) expect(text).not.toMatch(/T[0-9]_/);
    expect(scanned.userFacing[0]).toContain(
      'Angabe der Datenschutzerklärung und Beobachtung weichen ab: Google Fonts',
    );
  });
});

describe('the same statement on a site serving its own font, with a Google Map that loads Google Fonts', () => {
  let server: FixtureServer;
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/fonts-local'] });
    scanned = await run(server);
  });
  afterAll(async () => {
    await server?.close();
  });
  afterEach(() => {
    expect(server.unexpected).toEqual([]);
  });

  it('the map frame did load the Google Fonts stylesheet', () => {
    expect(server.requestsTo('fonts.googleapis.com').length).toBeGreaterThan(0);
    const fontRequests = scanned.r.snapshot?.browser?.phases
      .flatMap((p) => p.requests)
      .filter((q) => q.host === 'fonts.googleapis.com');
    expect(fontRequests?.length).toBeGreaterThan(0);
    expect(
      fontRequests?.every(
        (q) => !q.isMainFrame && q.frameUrl?.startsWith('https://www.google.com/maps/embed'),
      ),
    ).toBe(true);
  });

  it("PRIV-02 completes without a finding; EMBED-01 reports the map frame's fonts, not a font load of the site", () => {
    const { report } = scanned;
    expect(check(report, 'PRIV-02')?.status).toBe('completed');
    expect(findingsOf(report, 'PRIV-02')).toEqual([]);
    expect(check(report, 'EMBED-01')?.status).toBe('completed');
    const map = findingsOf(report, 'EMBED-02')[0];
    expect(findingsOf(report, 'EMBED-01').map((f) => [f.variant, f.subject, f.severity, f.crmCode])).toEqual([
      ['fonts-in-embed-frame', 'google-fonts@google-maps', 'warning', 'T1_FONTS_EXTERNAL'],
    ]);
    expect(
      findingsOf(report, 'EMBED-01')[0]?.related.map((r) => [r.checkId, r.fingerprint, r.relation]),
    ).toContainEqual(['EMBED-02', map?.fingerprint, 'embedded-in']);
    expect(scanned.userFacing[0]).toContain(
      'Externe Schriftarten von einer Einbettung geladen: Google Fonts in Google Maps',
    );
  });
});
