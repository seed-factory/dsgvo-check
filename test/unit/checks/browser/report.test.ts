/**
 * End to end over a saved snapshot (no collectors): derive → browser checks → assess → gate → report.
 * The report must validate against schema/report.schema.json (evidence shapes, params, crmCode).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import type { CmpFacts, CmpSection } from '../../../../src/cmp/types.ts';
import { CheckRegistry } from '../../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import { toSavedSnapshot } from '../../../../src/core/snapshot/index.ts';
import { bannerState } from '../../../../src/reporters/front-page.ts';
import { scan } from '../../../../src/scan.ts';
import { expectValidReport } from '../../../utils/report/validator.ts';
import { FIXED_NOW, makeCmpFacts } from '../../../utils/snapshot-builder.ts';
import { CONTACT, click, cmpFacts, cmpWith, cookie, IMPRESSUM, phase, req, START, site } from './helpers.ts';
import { SCENARIOS, scenariosOf } from './scenarios/index.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'm3-report-'));

async function scanSnapshot(snapshot: ReturnType<typeof site>, name: string) {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(toSavedSnapshot(snapshot)));
  return scan({
    fromSnapshot: file,
    registry: new CheckRegistry(browserChecks),
    now: () => FIXED_NOW,
    log: silentLogger,
  });
}

describe('browser checks in a full report', () => {
  it('a typical German SME site: findings, routing, related findings, crm codes, valid schema', async () => {
    const snapshot = site({
      phases: [
        phase('A', {
          requests: [
            req('A-1', 'https://www.googletagmanager.com/gtag/js?id=G-TEST1'),
            req(
              'A-2',
              'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1&cid=[redacted]&en=page_view',
              {
                resourceType: 'ping',
                identifierPresent: true,
                identifierNames: ['cid'],
              },
            ),
            req('A-3', 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet' }),
            req('A-4', 'https://www.google.com/maps/embed?pb=[redacted]', {
              pageUrl: CONTACT,
              resourceType: 'document',
            }),
            req('A-5', 'https://cdn.trustindex.io/loader.js'),
          ],
          cookies: [cookie('_ga'), cookie('CookieConsent')],
        }),
        phase('B', { click: click('reject'), requests: [] }),
      ],
    });
    const { report, exitCode } = await scanSnapshot(snapshot, 'sme');

    expectValidReport(report);
    expect(exitCode).toBe(1);
    expect(report.scan.status).toBe('complete');

    const findings = report.findings ?? [];
    const byCheck = (id: string) => findings.filter((f) => f.checkId === id);
    // Trustindex (reviews) is routed to EMBED-05, which is not part of the prototype.
    expect(byCheck('CONSENT-01').map((f) => [f.subject, f.variant, f.severity, f.crmCode])).toEqual([
      ['google-analytics', 'tracking-completed', 'critical', 'T1_TRACKER_BEFORE_CONSENT'],
    ]);
    expect(byCheck('EMBED-01').map((f) => [f.variant, f.severity, f.crmCode])).toEqual([
      ['fonts-loaded', 'warning', 'T1_FONTS_EXTERNAL'],
    ]);
    expect(byCheck('EMBED-02').map((f) => f.severity)).toEqual(['warning']);
    expect(byCheck('CONSENT-02').map((f) => [f.variant, f.severity])).toEqual([
      ['tracking-identifier-stored', 'critical'],
    ]);
    expect(byCheck('TRACK-01').map((f) => [f.subject, f.severity])).toEqual([['google-analytics', 'info']]);
    expect(byCheck('PRIV-01').map((f) => [f.subject, f.severity, f.confidence])).toEqual([
      ['google-analytics', 'warning', 'medium'],
      ['google-fonts', 'warning', 'medium'],
      ['google-maps', 'warning', 'medium'],
      ['trustindex', 'warning', 'medium'],
    ]);

    const ga = byCheck('CONSENT-01')[0];
    expect(ga?.related.map((r) => r.checkId).sort()).toEqual(['CONSENT-02', 'PRIV-01', 'TRACK-01']);
    expect(report.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'dsgvo-check-services', license: 'Apache-2.0' }),
      ]),
    );
    expect((report.checks ?? []).find((c) => c.id === 'CONSENT-03')).toMatchObject({ status: 'completed' });
  });

  it('a non-blocking first layer without a reject is a warning with its catalog code; it does not fail the run', async () => {
    const wix = scenariosOf('CONSENT-04').find(
      (s) => s.file === 'violation-wix-settings-and-accept-only.json',
    );

    const { report, exitCode } = await scanSnapshot(wix!.build(), 'wix-no-reject');

    expectValidReport(report);
    const consent04 = (report.findings ?? []).filter((f) => f.checkId === 'CONSENT-04');
    expect(consent04.map((f) => [f.variant, f.severity, f.confidence, f.crmCode])).toEqual([
      ['nonblocking-no-reject', 'warning', 'high', 'T1_CONSENT_BANNER_BROKEN'],
    ]);
    expect((report.findings ?? []).filter((f) => f.severity === 'critical')).toEqual([]);
    expect(exitCode).toBe(0);
    expect(bannerState(report)).toBe('recognized');
  });

  it("a map frame that loads Google Fonts: the map is EMBED-02, its frame's fonts an EMBED-01 warning linked to it", async () => {
    const maps = scenariosOf('EMBED-01').find((s) => s.file === 'violation-fonts-in-map-frame.json');

    const { report } = await scanSnapshot(maps!.build(), 'map-frame-fonts');

    expectValidReport(report);
    const findings = report.findings ?? [];
    const map = findings.find((f) => f.checkId === 'EMBED-02');
    const fonts = findings.filter((f) => f.checkId === 'EMBED-01');
    expect(map).toMatchObject({ variant: 'maps-loaded', params: { frameFontServices: 'Google Fonts' } });
    expect(fonts.map((f) => [f.variant, f.subject, f.severity, f.crmCode, f.serviceId])).toEqual([
      ['fonts-in-embed-frame', 'google-fonts@google-maps', 'warning', 'T1_FONTS_EXTERNAL', 'google-fonts'],
    ]);
    expect(fonts[0]?.related).toContainEqual({
      checkId: 'EMBED-02',
      fingerprint: map?.fingerprint,
      relation: 'embedded-in',
    });
  });

  const WIX: CmpFacts['detection'] = {
    cmpId: 'wix',
    method: 'adapter',
    version: null,
    versionSupported: null,
    recognitionConfidence: 'high',
    signals: ['global:consentPolicyManager', 'dom:[data-hook="consent-banner-root"]'],
  };
  /** Wix recognised by its adapter on one fact only; every other fact of the scan found no banner. */
  const recognisedOn = (p: Partial<CmpFacts>): CmpFacts =>
    cmpFacts({
      detection: WIX,
      firstLayer: {
        bannerPresent: true,
        bannerVisible: false,
        buttons: [],
        purAbo: false,
        closeMeansAccept: null,
      },
      ...p,
    });
  const none = (ph: 'A' | 'B' | 'C', pageUrl = START) =>
    makeCmpFacts({ phase: ph, pageUrl, moment: ph === 'A' ? 'phase-end' : 'first-screen' });
  const RECOGNISED_ON_ONE_FACT: Array<[string, CmpSection]> = [
    [
      'only on a subpage of phase A',
      cmpWith(
        {
          phase: 'A',
          facts: [none('A'), recognisedOn({ phase: 'A', pageUrl: IMPRESSUM, moment: 'phase-end' })],
        },
        { phase: 'B', facts: [none('B')] },
      ),
    ],
    [
      'only on the first screen of phase C',
      cmpWith(
        { phase: 'A', facts: [none('A'), none('A', IMPRESSUM)] },
        { phase: 'B', facts: [none('B')] },
        { phase: 'C', facts: [recognisedOn({ phase: 'C' })] },
      ),
    ],
    [
      'with less than high confidence on the start page',
      cmpWith(
        { phase: 'A', facts: [none('A', IMPRESSUM)] },
        {
          phase: 'B',
          facts: [
            recognisedOn({
              detection: {
                ...WIX,
                recognitionConfidence: 'medium',
                signals: ['dom:[data-hook="consent-banner-root"]'],
              },
            }),
          ],
        },
      ),
    ],
  ];

  it.each(RECOGNISED_ON_ONE_FACT)(
    'a banner its adapter recognised %s is never reported as missing',
    async (name, cmp) => {
      const snapshot = site({ phases: [phase('A'), phase('B'), phase('C')], cmp });

      const { report } = await scanSnapshot(snapshot, `recognised-${name.replace(/[^a-z]+/g, '-')}`);

      expectValidReport(report);
      const ids = ['CONSENT-03', 'CONSENT-04', 'CONSENT-05'];
      expect((report.checks ?? []).filter((c) => ids.includes(c.id) && c.reason === 'no-banner')).toEqual([]);
      expect(bannerState(report)).not.toBe('notFound');
      expect((report.findings ?? []).filter((f) => /^no-banner/.test(f.variant))).toEqual([]);
    },
  );

  it.each(
    Object.entries(SCENARIOS).flatMap(([id, list]) => list.map((s) => [`${id}/${s.file}`, s] as const)),
  )('%s gives a schema-valid report', async (name, s) => {
    const { report } = await scanSnapshot(s.build(), name.replace(/[^a-zA-Z0-9]+/g, '-'));

    expectValidReport(report);
    expect(report.scan.status).not.toBe('failed');
  });
});
