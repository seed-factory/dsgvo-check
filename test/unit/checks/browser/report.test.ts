/**
 * End to end over a saved snapshot (no collectors): derive → browser checks → assess → gate → report.
 * The report must validate against schema/report.schema.json (evidence shapes, params, crmCode).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { silentLogger } from '../../../../src/core/logger.ts';
import { CheckRegistry } from '../../../../src/core/registry.ts';
import { toSavedSnapshot } from '../../../../src/core/snapshot.ts';
import { scan } from '../../../../src/scan.ts';
import { expectValidReport } from '../../../utils/report-validator.ts';
import { FIXED_NOW } from '../../../utils/snapshot-builder.ts';
import { CONTACT, click, cookie, phase, req, site } from './helpers.ts';
import { SCENARIOS } from './scenarios/index.ts';

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

  it.each(
    Object.entries(SCENARIOS).flatMap(([id, list]) => list.map((s) => [`${id}/${s.file}`, s] as const)),
  )('%s gives a schema-valid report', async (name, s) => {
    const { report } = await scanSnapshot(s.build(), name.replace(/[^a-zA-Z0-9]+/g, '-'));
    expectValidReport(report);
    expect(report.scan.status).not.toBe('failed');
  });
});
