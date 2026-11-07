/**
 * All browser-side modules together: real browser collector and CMP subsystem, derive, browser checks, assess/gate and
 * reporters on hand-written shops with the Cookiebot, the Wix, the Shopware and the cookieman simulator, and on the
 * CCM19 simulator. Variants: consent respected, tracker before consent, blocking banner, a first layer without a
 * reject, a reject the CMP state confirms or cannot confirm, control pages on another host the answer of the start page
 * does or does not reach, a CMP whose crawler test does not take the scanner's User-Agent for a bot, and its widget
 * that never opens.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { ConfigInput } from '../../../src/core/config/schema.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { bannerState } from '../../../src/reporters/front-page.ts';
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
  server = await startFixtureServer({
    sites: [
      'pipeline/consent-shop',
      'cmp/cookiebot',
      'browser/ga4',
      'pipeline/wix-shop',
      'cmp/wix',
      'pipeline/shopware-shop',
      'pipeline/cookieman-shop',
      'cmp/cookieman',
      'cmp/ccm19',
    ],
  });
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
  config?: ConfigInput,
  pathname = '/',
): Promise<{ r: ScanResult; report: FullReport; outDir: string; files: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-pipeline-'));
  const r = await scan({
    url: `https://${host}${pathname}`,
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir,
    checks: BROWSER_CHECKS,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
    ...(config ? { config } : {}),
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

/** Phrases that call the banner missing or unrecognised, in the report language of `run` (de). */
const BANNER_MISSING = [
  'kein Einwilligungsbanner gefunden',
  'Kein Einwilligungsbanner gefunden',
  'Einwilligungsbanner beobachtet, aber nicht erkannt',
  'Das Einwilligungsbanner wurde nicht erkannt',
];

/** A banner the adapter recognised is named recognised everywhere: no check, overview line or text calls it missing. */
function expectBannerRecognized({ report, files }: { report: FullReport; files: string }): void {
  expect(bannerState(report)).toBe('recognized');
  expect(files).toContain('Das Einwilligungsbanner wurde erkannt.');
  for (const phrase of BANNER_MISSING) expect(files).not.toContain(phrase);
  const bannerReasons = [
    'no-banner',
    'banner-not-recognized',
    'banner-candidate-unrecognized',
    'banner-undetermined',
  ];
  expect(report.checks.filter((c) => bannerReasons.includes(c.reason ?? ''))).toEqual([]);
}

const firstScreen = (r: ScanResult, phase: 'A' | 'B' | 'C') =>
  r.snapshot?.cmp?.phases.find((p) => p.phase === phase)?.facts.find((f) => f.moment === 'first-screen');
const cmpPhase = (r: ScanResult, phase: 'B' | 'C') => r.snapshot?.cmp?.phases.find((p) => p.phase === phase);

describe('full browser pipeline on the Wix simulator', () => {
  describe('first layer with "Cookie-Einstellungen", "Zustimmen" and × only: the reject is saved in the settings layer', () => {
    let scanned: Awaited<ReturnType<typeof run>>;

    beforeAll(async () => {
      scanned = await run('www.wix-nodecline-shop.test');
    });

    it('recognises Wix and reports CONSENT-04 nonblocking-no-reject as a warning, which does not fail the run', () => {
      const { r, report } = scanned;

      expect(firstScreen(r, 'B')?.detection).toMatchObject({
        cmpId: 'wix',
        method: 'adapter',
        recognitionConfidence: 'high',
      });
      expect(check(report, 'CONSENT-04')?.status).toBe('completed');
      expect(report.findings.filter((f) => f.checkId === 'CONSENT-04')).toMatchObject([
        { variant: 'nonblocking-no-reject', severity: 'warning', confidence: 'high', params: { cmp: 'wix' } },
      ]);
      expect(check(report, 'CONSENT-04')?.limitations ?? []).not.toContain('reject-unverified');
      expect(r.exitCode).toBe(0);
    });

    it('the first layer has no reject target and × is never one; B opens "Cookie-Einstellungen" and presses "Auswahl bestätigen"', () => {
      const { r } = scanned;

      const kinds = firstScreen(r, 'B')?.firstLayer.buttons.map((b) => [b.name, b.kind]);
      expect(kinds).toEqual([
        ['Zur Datenschutzerklärung', 'link'],
        ['Cookie-Einstellungen', 'settings'],
        ['Zustimmen', 'accept'],
        ['Schließen', 'close'],
      ]);
      expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({
        action: 'reject',
        target: null,
        reason: 'no-unambiguous-reject-at-first-layer',
        settings: {
          open: { cmpId: 'wix', name: 'Cookie-Einstellungen' },
          save: { cmpId: 'wix', name: 'Auswahl bestätigen' },
        },
      });
      expect(r.snapshot?.plan.browser?.click?.B?.settings?.reason).toBeUndefined();
      const b = cmpPhase(r, 'B');
      expect(b?.click).toMatchObject({
        action: 'reject',
        clicked: true,
        path: 'settings',
        button: { name: 'Auswahl bestätigen' },
      });
      expect(b?.settings).toMatchObject({
        opened: true,
        // The layer's own controls: the first layer stays open behind it and is not what was measured.
        buttons: [
          { name: 'Einstellungen schließen', vendorRole: null },
          { name: 'Auswahl bestätigen', vendorRole: 'save' },
        ],
        groups: [
          { checked: true, disabled: true },
          { checked: false, disabled: false },
          { checked: false, disabled: false },
          { checked: false, disabled: false },
        ],
      });
      expect(r.snapshot?.browser?.phases.find((p) => p.phase === 'B')?.click).toMatchObject({
        action: 'reject',
        name: 'Auswahl bestätigen',
        success: true,
      });
      expect(r.snapshot?.plan.browser?.click?.C).toMatchObject({
        action: 'accept',
        target: { cmpId: 'wix', name: 'Zustimmen' },
      });
    });

    it('confirms the save as the reject: every policy category denied by it and stored after the reload; CONSENT-05 rests on it', () => {
      const { r, report } = scanned;
      const b = cmpPhase(r, 'B');

      expect(b?.verify).toMatchObject({ action: 'reject', verified: true, persistedAfterReload: true });
      expect(b?.verify?.method).toContain('api:all-denied');
      const denied = { functional: 'denied', analytics: 'denied', advertising: 'denied' };
      expect(b?.verify?.stateAfter).toMatchObject([{ ready: 'ready', origin: 'action', categories: denied }]);
      expect(['no-reject-click', 'reject-not-confirmed', 'no-banner']).not.toContain(
        check(report, 'CONSENT-05')?.reason,
      );
      expect(ids(report).filter((x) => x.startsWith('CONSENT-05'))).toEqual([]);
    });

    it('what loads while the settings are open is before the reject: the settings stylesheet has no click, the reload has', () => {
      const { r } = scanned;
      const derived = r.snapshot?.derived?.requests ?? [];
      const b = r.snapshot?.browser?.phases.find((p) => p.phase === 'B');
      const timing = (id: string) => derived.find((c) => c.requestId === id)?.timing;

      const stylesheet = b?.requests.filter((q) => q.url.endsWith('/settings.css')) ?? [];
      expect(stylesheet).toHaveLength(1);
      expect(stylesheet[0]).toMatchObject({ afterClick: false });
      expect(stylesheet[0]?.actionId).toBeUndefined();
      expect(timing(stylesheet[0]!.id)).toBe('before-interaction');

      const reload = b?.requests.filter((q) => q.isNavigation && q.isMainFrame && q.afterClick) ?? [];
      expect(reload.length).toBeGreaterThan(0);
      expect(reload.map((q) => timing(q.id))).toEqual(reload.map(() => 'after-reject'));
    });

    it('the coverage names the reject through the settings, and the banner recognised in every text', () => {
      const { report, files } = scanned;

      expect(report.scan.coverage?.consentActions?.[0]).toEqual({
        action: 'reject',
        clicked: true,
        verified: true,
        path: 'settings',
      });
      expect(files).toContain('Ablehnen über die Einstellungen ausgelöst und bestätigt');
      expectBannerRecognized(scanned);
    });

    // The saved choice lives in the value of the platform cookie; only its name may be recorded.
    it('no value of the cookie the save wrote reaches the snapshot or a report', () => {
      const { r, files } = scanned;
      const snapshot = JSON.stringify(r.snapshot);

      expect(r.snapshot?.browser?.phases.flatMap((p) => p.cookies).map((c) => c.name)).toContain(
        'consent-policy',
      );
      for (const text of [snapshot, files]) expect(text).not.toMatch(/dt3|%22ess%22|"anl"/);
    });
  });

  it('the Google tag and a map after the confirmed save in the settings: CONSENT-05 and EMBED-02 name the settings path, CONSENT-04 stays first-layer', async () => {
    const { r, report, files } = await run('www.wix-nodecline-leaky-shop.test');

    expect(cmpPhase(r, 'B')?.click).toMatchObject({ clicked: true, path: 'settings' });
    expect(cmpPhase(r, 'B')?.verify).toMatchObject({ verified: true, persistedAfterReload: true });
    expect(report.findings.find((f) => f.checkId === 'CONSENT-05')).toMatchObject({
      variant: 'tracking-after-reject',
      severity: 'critical',
      serviceId: 'google-analytics',
      params: { rejectPath: 'settings' },
    });
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04').map((f) => f.variant)).toEqual([
      'nonblocking-no-reject',
    ]);
    expect(report.findings.find((f) => f.checkId === 'EMBED-02')).toMatchObject({
      variant: 'maps-loaded',
      params: { moment: 'before-and-after-reject', rejectConfirmed: true, rejectPath: 'settings' },
    });
    expect(files).toContain(
      'Externer Kartendienst geladen, auch nach bestätigter Ablehnung über die Einstellungen',
    );
    expect(files).toContain('nach bestätigter Ablehnung über die Einstellungen');
    expect(r.exitCode).toBe(1);
  });

  it('counterexample: an optional group already on in the settings → nothing is saved, CONSENT-05 says why', async () => {
    const scanned = await run('www.wix-preselected-shop.test');
    const { r, report } = scanned;

    expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({
      target: null,
      settings: { open: { name: 'Cookie-Einstellungen' }, save: null, reason: 'preselected-groups' },
    });
    // Nothing was pressed in the settings: the click record is the first layer's, without a target.
    expect(cmpPhase(r, 'B')?.click).toEqual({
      action: 'reject',
      clicked: false,
      button: null,
      error: 'no-unambiguous-reject',
    });
    expect(cmpPhase(r, 'B')?.verify).toBeUndefined();
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'no-reject-click',
      limitations: ['preselected-groups'],
    });
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04').map((f) => f.variant)).toEqual([
      'nonblocking-no-reject',
    ]);
    expect(scanned.files).toContain('optionale Kategorien dort bereits eingeschaltet');
    expectBannerRecognized(scanned);
  });

  it('a save that stores no answer: clicked but not confirmed, CONSENT-05 reject-not-confirmed, CONSENT-04 unchanged', async () => {
    const scanned = await run('www.wix-unsaved-shop.test');
    const { r, report, files } = scanned;

    expect(cmpPhase(r, 'B')?.click).toMatchObject({ clicked: true, path: 'settings' });
    expect(cmpPhase(r, 'B')?.verify).toMatchObject({ verified: false });
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04').map((f) => f.variant)).toEqual([
      'nonblocking-no-reject',
    ]);
    expect(check(report, 'CONSENT-04')?.limitations ?? []).not.toContain('reject-unverified');
    expect(files).toContain('Ablehnen über die Einstellungen ausgelöst, nicht bestätigt');
    expectBannerRecognized(scanned);
  });

  describe('visible "Alle ablehnen", confirmed by the platform policy', () => {
    let scanned: Awaited<ReturnType<typeof run>>;

    beforeAll(async () => {
      scanned = await run('www.wix-shop.test');
    });

    it('clicks "Alle ablehnen" in phase B and "Zustimmen" in phase C through the Wix adapter', () => {
      const click = scanned.r.snapshot?.plan.browser?.click;

      expect(click?.B).toMatchObject({ action: 'reject', target: { cmpId: 'wix', name: 'Alle ablehnen' } });
      expect(click?.C).toMatchObject({ action: 'accept', target: { cmpId: 'wix', name: 'Zustimmen' } });
    });

    it('confirms the reject: every policy category denied by our click and still stored after the reload', () => {
      const b = scanned.r.snapshot?.cmp?.phases.find((p) => p.phase === 'B');

      expect(b?.verify).toMatchObject({ action: 'reject', verified: true, persistedAfterReload: true });
      expect(b?.verify?.method).toContain('api:all-denied');
      const denied = { functional: 'denied', analytics: 'denied', advertising: 'denied' };
      expect(b?.verify?.stateAfter).toMatchObject([{ ready: 'ready', origin: 'action', categories: denied }]);
      const afterReload = b?.facts.filter((f) => f.moment === 'after-reload').flatMap((f) => f.state);
      expect(afterReload).toMatchObject([{ ready: 'ready', origin: 'stored', categories: denied }]);
    });

    // Wix keeps dataToThirdParty on after "Alle ablehnen"; it is no choice of the banner.
    it('dataToThirdParty, still on after the reject, makes it neither ineffective nor consent without action', () => {
      const { r, report } = scanned;

      const states = (r.snapshot?.cmp?.phases ?? []).flatMap((p) => [
        ...p.facts.flatMap((f) => f.state),
        ...(p.verify?.stateAfter ?? []),
      ]);
      expect(states.length).toBeGreaterThan(0);
      expect(states.filter((s) => Object.hasOwn(s.categories, 'dataToThirdParty'))).toEqual([]);
      expect(check(report, 'CONSENT-04')?.status).toBe('completed');
      expect(ids(report).filter((x) => x.startsWith('CONSENT-04'))).toEqual([]);
    });

    it('CONSENT-03, -04 and -05 find nothing; the run exits 0 and names the banner recognised', () => {
      const { r, report } = scanned;

      expect(ids(report).filter((x) => /^CONSENT-0[345]\./.test(x))).toEqual([]);
      expect(check(report, 'CONSENT-03')?.status).toBe('completed');
      // The confirmed reject is the basis of CONSENT-05: it is neither missing nor unconfirmed.
      expect(['no-reject-click', 'reject-not-confirmed', 'no-banner']).not.toContain(
        check(report, 'CONSENT-05')?.reason,
      );
      expect(r.exitCode).toBe(0);
      expectBannerRecognized(scanned);
    });
  });

  it('a tracker that loads on every visit after a confirmed Wix reject → CONSENT-05 tracking-after-reject', async () => {
    const { r, report } = await run('www.wix-leaky-shop.test');

    expect(r.snapshot?.cmp?.phases.find((p) => p.phase === 'B')?.verify).toMatchObject({
      verified: true,
      persistedAfterReload: true,
    });
    expect(report.findings.find((f) => f.checkId === 'CONSENT-05')).toMatchObject({
      variant: 'tracking-after-reject',
      severity: 'critical',
      serviceId: 'google-analytics',
    });
    expect(r.exitCode).toBe(1);
  });

  it('a policy API that throws: the reject is clicked but not confirmed, called neither ineffective nor missing', async () => {
    const scanned = await run('www.wix-unreadable-shop.test');
    const { r, report } = scanned;

    expect(r.snapshot?.plan.browser?.click?.B).toMatchObject({
      action: 'reject',
      target: { cmpId: 'wix', name: 'Alle ablehnen' },
    });
    const b = r.snapshot?.cmp?.phases.find((p) => p.phase === 'B');
    expect(b?.click?.clicked).toBe(true);
    expect(b?.verify).toMatchObject({ verified: false });
    expect(b?.verify?.stateAfter.filter((s) => s.ready === 'ready')).toEqual([]);

    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
    expect(ids(report).filter((x) => x.startsWith('CONSENT-04'))).toEqual([]);
    expect(check(report, 'CONSENT-04')?.limitations).toContain('reject-unverified');
    expectBannerRecognized(scanned);
  });
});

/** Test markers the Shopware fixtures give the permission cookies and the Google Ads cookie: no output may show them. */
const SHOPWARE_VALUES = ['SECRET_SW_FLAG_7', 'SECRET_GCL_4711'];

function expectNoShopwareValues({ r, files }: { r: ScanResult; files: string }): void {
  const snapshot = JSON.stringify(r.snapshot);
  for (const value of SHOPWARE_VALUES) {
    expect(files).not.toContain(value);
    expect(snapshot).not.toContain(value);
  }
}

const findingsOf = (report: FullReport, checkId: string) =>
  report.findings
    .filter((f) => f.checkId === checkId)
    .map((f) => [f.serviceId ?? null, f.variant, f.severity])
    .sort();

describe('full browser pipeline on the Shopware simulator', () => {
  describe('"Nur technisch notwendige" sets the answer cookie only, accept sets the permission cookies late', () => {
    let scanned: Awaited<ReturnType<typeof run>>;

    beforeAll(async () => {
      scanned = await run('www.shopware-shop.test');
    });

    it('clicks reject in phase B and accept in phase C through the Shopware adapter', () => {
      const click = scanned.r.snapshot?.plan.browser?.click;

      expect(click?.B).toMatchObject({
        action: 'reject',
        target: { cmpId: 'shopware', name: 'Nur technisch notwendige' },
      });
      expect(click?.C).toMatchObject({
        action: 'accept',
        target: { cmpId: 'shopware', name: 'Alle Cookies akzeptieren' },
      });
    });

    it('confirms the reject: answered by our click, no known permission cookie, the same after the reload', () => {
      const b = cmpPhase(scanned.r, 'B');

      expect(b?.verify).toMatchObject({ action: 'reject', verified: true, persistedAfterReload: true });
      expect(b?.verify?.method).toContain('cookie:known-flags-absent');
      const after = b?.verify?.stateAfter[0];
      expect(after).toMatchObject({ source: 'cookie', ready: 'ready', origin: 'action' });
      expect(Object.keys(after?.categories ?? {})).toContain('google-analytics-enabled');
      expect(Object.values(after?.categories ?? {}).every((v) => v === 'denied')).toBe(true);
      const afterReload = b?.facts.filter((f) => f.moment === 'after-reload').flatMap((f) => f.state);
      expect(afterReload).toMatchObject([{ origin: 'stored', categories: after?.categories }]);
    });

    it('confirms the accept although the answer comes after the offcanvas fetch, so the overview has no caveat', () => {
      const c = cmpPhase(scanned.r, 'C');

      expect(c?.verify).toMatchObject({ action: 'accept', verified: true });
      expect(c?.verify?.method).toContain('cookie:known-flags-present');
      expect(c?.verify?.stateAfter[0]?.categories).toMatchObject({ 'google-analytics-enabled': 'granted' });
      expect(scanned.files).not.toContain('Annahme nicht bestätigt');
    });

    it('CONSENT-03, -04 and -05 find nothing, CONSENT-05 rests on the confirmed reject; exit 0, banner recognised', () => {
      const { r, report } = scanned;

      expect(ids(report).filter((x) => /^CONSENT-0[345]\./.test(x))).toEqual([]);
      expect(check(report, 'CONSENT-04')?.status).toBe('completed');
      expect(check(report, 'CONSENT-04')?.limitations ?? []).not.toContain('reject-unverified');
      expect(['no-reject-click', 'reject-not-confirmed', 'no-banner']).not.toContain(
        check(report, 'CONSENT-05')?.reason,
      );
      expect(r.exitCode).toBe(0);
      expectBannerRecognized(scanned);
    });

    it('no value of a permission cookie reaches the snapshot or a report', () => {
      expectNoShopwareValues(scanned);
    });
  });

  it('Google Analytics and Google Ads on every visit after a confirmed reject → CONSENT-05 tracking-after-reject', async () => {
    const scanned = await run('www.shopware-leaky-shop.test');
    const { r, report } = scanned;

    expect(cmpPhase(r, 'B')?.verify).toMatchObject({ verified: true, persistedAfterReload: true });
    expect(findingsOf(report, 'CONSENT-05')).toEqual([
      ['google-ads', 'tracking-after-reject', 'critical'],
      ['google-analytics', 'tracking-after-reject', 'critical'],
    ]);
    const ads = report.findings.find((f) => f.checkId === 'CONSENT-05' && f.serviceId === 'google-ads');
    expect(ads?.params).toMatchObject({ name: '_gcl_au' });
    expect(r.exitCode).toBe(1);
    expectNoShopwareValues(scanned);
  });

  it('a reject that closes the bar without an answer is not confirmed: CONSENT-05 reject-not-confirmed, no finding', async () => {
    const { r, report } = await run('www.shopware-noanswer-shop.test');

    expect(cmpPhase(r, 'B')?.click?.clicked).toBe(true);
    expect(cmpPhase(r, 'B')?.verify).toMatchObject({
      verified: false,
      reason: 'cookie:no-response-recorded',
    });
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
    expect(findingsOf(report, 'CONSENT-05')).toEqual([]);
    // The state after the click shows no answer: the reject is reported as not confirmed, a warning that does not gate.
    expect(findingsOf(report, 'CONSENT-04')).toEqual([[null, 'reject-ineffective', 'warning']]);
    expect(r.exitCode).toBe(0);
  });

  it('counterexample: a reject that sets the analytics permission cookie is not confirmed; GA after it is no CONSENT-05 finding', async () => {
    const scanned = await run('www.shopware-denyflag-shop.test');
    const { r, report } = scanned;

    expect(cmpPhase(r, 'B')?.verify).toMatchObject({ verified: false, reason: 'cookie:not-all-denied' });
    expect(cmpPhase(r, 'B')?.verify?.stateAfter[0]?.categories).toMatchObject({
      'google-analytics-enabled': 'granted',
    });
    const gaAfterReject = r.snapshot?.derived?.requests.filter(
      (c) =>
        c.phase === 'B' &&
        c.timing === 'after-reject' &&
        c.serviceId === 'google-analytics' &&
        c.kind === 'hit',
    );
    expect(gaAfterReject?.length ?? 0).toBeGreaterThan(0);
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
    expect(findingsOf(report, 'CONSENT-05')).toEqual([]);
    // The state after the click grants analytics: CONSENT-04 names the reject not confirmed.
    expect(findingsOf(report, 'CONSENT-04')).toEqual([[null, 'reject-ineffective', 'warning']]);
    expectNoShopwareValues(scanned);
  });

  // The answer is the shop's own: neither the cleared permission cookie nor the reload makes it the result of our click.
  it('counterexample: an answer stored before the click is no confirmed reject, also not after the reload', async () => {
    const scanned = await run('www.shopware-answered-shop.test');
    const { r, report } = scanned;

    const verify = cmpPhase(r, 'B')?.verify;
    expect(verify).toMatchObject({ verified: false, reason: 'cookie:unchanged-after-click' });
    expect(verify?.method).not.toContain('verified-after-reload-only');
    expect(check(report, 'CONSENT-05')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
    expect(findingsOf(report, 'CONSENT-05')).toEqual([]);
    // Granted before any choice. After the click nothing is granted, so the reject is unverified, not ineffective.
    expect(findingsOf(report, 'CONSENT-04')).toEqual([[null, 'consent-without-action', 'warning']]);
    expect(check(report, 'CONSENT-04')?.limitations).toContain('reject-unverified');
    expectNoShopwareValues(scanned);
  });
});

const controlFacts = (r: ScanResult, phase: 'B' | 'C') =>
  (cmpPhase(r, phase)?.facts ?? []).filter((f) => f.moment === 'control-page');
const gaInventory = (report: FullReport) =>
  report.findings.find((f) => f.checkId === 'TRACK-01' && f.serviceId === 'google-analytics');

describe('full browser pipeline on the cookieman simulator, start page on the bare domain, other pages on www', () => {
  describe('answer cookie bound to the start host: the pages on www show the banner again', () => {
    let scanned: Awaited<ReturnType<typeof run>>;

    beforeAll(async () => {
      scanned = await run('cookieman-shop.test');
    });

    it('rejects and accepts on the start page through the cookieman adapter; the reject is confirmed there', () => {
      const { r } = scanned;
      expect(r.snapshot?.plan.browser?.click).toMatchObject({
        B: { action: 'reject', target: { cmpId: 'cookieman', name: 'Alle Cookies ablehnen' } },
        C: { action: 'accept', target: { cmpId: 'cookieman', name: 'Alle Cookies akzeptieren' } },
      });
      expect(cmpPhase(r, 'B')?.verify).toMatchObject({ verified: true, persistedAfterReload: true });
    });

    it('revisits control pages on www only, where the banner shows again without an answer after both clicks', () => {
      const { r } = scanned;
      const control = r.snapshot?.plan.browser?.controlPages.map((p) => new URL(p.url).hostname) ?? [];
      expect(control.length).toBeGreaterThan(0);
      expect(new Set(control)).toEqual(new Set(['www.cookieman-shop.test']));
      for (const phase of ['B', 'C'] as const) {
        const facts = controlFacts(r, phase);
        expect(facts).toHaveLength(control.length);
        for (const f of facts) {
          expect(f.firstLayer.bannerVisible).toBe(true);
          expect(f.state.map((s) => s.decision?.responded)).toEqual([false]);
        }
      }
    });

    it('Google Analytics on the www pages after the reject is no CONSENT-05 finding; those pages are left out', () => {
      const { r, report } = scanned;
      expect(ids(report).filter((x) => x.startsWith('CONSENT-05'))).toEqual([]);
      const c05 = check(report, 'CONSENT-05');
      expect(c05?.limitations).toContain('reject-not-in-effect');
      // Only the reload of the start page is a page after the reject.
      const pagesB = r.snapshot?.browser?.phases.find((p) => p.phase === 'B')?.pages ?? [];
      expect(c05?.coverage).toEqual({ observed: pagesB.length, evaluated: 1 });
      // The tag on www before any interaction is a finding of CONSENT-01 all the same.
      expect(ids(report)).toContain('CONSENT-01.tracking-completed');
    });

    it('TRACK-01 counts the www pages for neither click and names both limitations', () => {
      const { report } = scanned;
      expect(check(report, 'TRACK-01')).toMatchObject({
        status: 'partial',
        limitations: ['accept-not-in-effect', 'reject-not-in-effect'],
      });
      expect(gaInventory(report)?.params).toMatchObject({
        stageBeforeInteraction: 'event-sent',
        stageAfterReject: 'none',
        stageAfterAccept: 'none',
      });
    });

    it('the report words the pages left out', () => {
      expect(scanned.files).toContain('Seiten nach der Ablehnung nicht ausgewertet');
      expect(scanned.files).toContain('Seiten nach der Zustimmung nicht ausgewertet');
    });
  });

  it('counterexample: an answer cookie for the whole domain reaches www, so the tag there counts after the reject', async () => {
    const { r, report } = await run('shared-cookieman-shop.test');

    const control = controlFacts(r, 'B');
    expect(control.length).toBeGreaterThan(0);
    for (const f of control) {
      expect(new URL(f.pageUrl).hostname).toBe('www.shared-cookieman-shop.test');
      expect(f.firstLayer.bannerVisible).toBe(false);
      expect(f.state).toMatchObject([{ origin: 'stored', decision: { responded: true } }]);
    }
    expect(report.findings.find((f) => f.checkId === 'CONSENT-05')).toMatchObject({
      variant: 'tracking-after-reject',
      severity: 'critical',
      serviceId: 'google-analytics',
    });
    expect(check(report, 'CONSENT-05')?.limitations).not.toContain('reject-not-in-effect');
    expect(check(report, 'TRACK-01')?.limitations).toEqual([]);
    expect(gaInventory(report)?.params).toMatchObject({
      stageAfterReject: 'event-sent',
      stageAfterAccept: 'event-sent',
    });
  });
});

// CCM19 keeps its widget closed for a User-Agent its crawler test takes for a bot (` (+http`); the scanner's honest
// User-Agent is none, so the widget opens and the consent checks read it as a visitor would.
describe("full browser pipeline on the CCM19 simulator, whose crawler test does not match the scanner's User-Agent", () => {
  const CONSENT_CHECKS = ['CONSENT-01', 'CONSENT-02', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05', 'EMBED-01'];
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    scanned = await run('www.ccm19.test');
  });

  it('records the opened widget without a bot signal and clicks the reject', () => {
    const { r } = scanned;
    const cmp = r.snapshot?.cmp;
    const first = cmp?.phases.find((p) => p.phase === 'B')?.facts.find((f) => f.moment === 'first-screen');

    expect(first?.firstLayer.bannerVisible).toBe(true);
    expect(first?.firstLayer.dialogNotOpened).toBeUndefined();
    expect(cmp?.phases.flatMap((p) => p.facts.flatMap((f) => f.botSignals))).toEqual([]);
    expect(cmp?.phases.find((p) => p.phase === 'B')?.click).toMatchObject({
      clicked: true,
      button: { kind: 'reject' },
    });
  });

  it('the consent checks read the opened widget: none names a bot, and the reports carry no crawler text', () => {
    const { report, files } = scanned;

    expect(
      CONSENT_CHECKS.map((id) => [id, check(report, id)?.status, check(report, id)?.reason ?? null]),
    ).toEqual([
      ['CONSENT-01', 'completed', null],
      ['CONSENT-02', 'completed', null],
      // The simulator is one page, fewer than CONSENT-03 needs.
      ['CONSENT-03', 'inconclusive', 'insufficient-pages'],
      ['CONSENT-04', 'completed', null],
      // Beacons sent on pagehide are not captured yet.
      ['CONSENT-05', 'inconclusive', 'pagehide-capture-unavailable'],
      ['EMBED-01', 'completed', null],
    ]);
    expect(report.diagnostics.map((d) => d.code)).not.toContain('SCAN-BOTMODE');
    expect(bannerState(report)).toBe('recognized');
    expect(files).not.toContain('Einwilligungsbanner öffnet sich nicht für den User-Agent des Scanners');
    expect(files).not.toContain('Erkennungsmuster für Crawler');
  });
});

describe('full browser pipeline on a CCM19 page whose widget never opens', () => {
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    scanned = await run('www.ccm19.test', { cmp: { waitMs: 1_500 } }, '/not-opened.html');
  });

  it('records the closed widget on B without a bot signal and clicks nothing', () => {
    const cmp = scanned.r.snapshot?.cmp;
    const first = cmp?.phases.find((p) => p.phase === 'B')?.facts.find((f) => f.moment === 'first-screen');

    expect(first?.firstLayer.dialogNotOpened).toBe(true);
    expect(cmp?.phases.flatMap((p) => p.facts.flatMap((f) => f.botSignals))).toEqual([]);
    expect(cmp?.phases.find((p) => p.phase === 'B')?.click).toMatchObject({ clicked: false });
  });

  it('the consent checks and the reports say the banner was not opened, without naming a crawler test', () => {
    const { report, files } = scanned;
    expect(
      ['CONSENT-03', 'CONSENT-04', 'CONSENT-05'].map((id) => [
        id,
        check(report, id)?.status,
        check(report, id)?.reason ?? null,
      ]),
    ).toEqual([
      // One page, fewer than CONSENT-03 needs.
      ['CONSENT-03', 'inconclusive', 'insufficient-pages'],
      ['CONSENT-04', 'inconclusive', 'cmp-dialog-not-opened'],
      ['CONSENT-05', 'inconclusive', 'cmp-dialog-not-opened'],
    ]);
    expect(report.findings.filter((f) => f.checkId === 'CONSENT-04' || f.checkId === 'CONSENT-05')).toEqual(
      [],
    );
    expect(report.diagnostics.map((d) => d.code)).not.toContain('SCAN-BOTMODE');
    expect(bannerState(report)).toBe('dialogNotOpened');
    expect(files).toContain('Einwilligungsbanner dem Scanner nicht geöffnet');
    expect(files).not.toContain('Erkennungsmuster für Crawler');
    expect(files).not.toContain('Einwilligungsbanner nicht erkannt');
  });
});
