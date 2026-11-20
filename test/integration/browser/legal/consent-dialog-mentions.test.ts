/**
 * From the browser collector to the report on the Borlabs simulator with collapsed Cookie-Details: the collector reads
 * the dialog that its own adapter recognised, once in phase A and without a click, and keeps only the catalog services
 * the text names. PRIV-01 reports the service only the dialog names as `named-in-cmp-only` and the one it does not
 * name as `not-named`; neither the text of the dialog nor the UID it prints reaches the snapshot, the saved snapshot,
 * the reports, the other files of the scan or the log.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { createBrowserCollector } from '../../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../../src/core/report/schema.ts';
import { createLogger } from '../../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { expectValidReport } from '../../../utils/report/validator.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../helpers.ts';

const START = 'https://www.borlabs.test/details.html';
/**
 * What only the collapsed Cookie-Details hold: the UID of the visit (the simulator starts it with `zqx`), the label in
 * front of it, and provider address, purpose and cookie table of the services.
 */
const DIALOG_ONLY = [
  'zqx',
  'Einwilligungs-ID',
  'Gordon House',
  'Ereignisbehandlung',
  'Conversion-Tracking und Remarketing',
  'Cookie Laufzeit',
];

/** Every file under `dir`, as text. */
function filesUnder(dir: string): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      return [path.relative(dir, file), readFileSync(file, 'latin1')];
    });
}

describe('Borlabs dialog with collapsed Cookie-Details from the collector to the report', () => {
  let server: FixtureServer;
  let r: ScanResult;
  let outDir = '';
  const log: string[] = [];

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['cmp/borlabs'] });
    outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-dialog-mentions-'));
    r = await scan({
      url: START,
      network: server.network(),
      log: createLogger('debug', (line) => log.push(line)),
      sandbox: TEST_SANDBOX,
      outDir,
      saveSnapshot: path.join(outDir, 'scan.snapshot.json'),
      checks: browserChecks.map((c) => c.id),
      collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
    });
    const w = await writeReports(r, { outDir, formats: ['json', 'html'], lang: 'de' });
    expect(w.errors).toEqual([]);
  });

  afterAll(async () => {
    await server?.close();
  });

  const report = () => r.report as FullReport;
  const priv01 = () => report().findings.filter((f) => f.checkId === 'PRIV-01');

  it('the snapshot names the services of the Cookie-Details by their catalog terms, and nothing else of the dialog', () => {
    expect(r.snapshot?.cmp?.dialogMentions).toEqual({
      cmpId: 'borlabs',
      cmpName: 'Borlabs Cookie',
      version: '3.2.1',
      phase: 'A',
      pageUrl: START,
      takenAt: expect.any(String),
      services: [
        { serviceId: 'google-ads', term: 'Google AdWords' },
        { serviceId: 'google-tag-manager', term: 'Google Tag Manager' },
      ],
      truncated: false,
    });
    expect(r.snapshot?.cmp?.dialogMentionsFailed).toBeUndefined();
  });

  it('reading it clicked nothing: no consent cookie in phase A, the policy and the Impressum were read as usual', () => {
    const a = r.snapshot?.browser?.phases.find((p) => p.phase === 'A');
    expect(a?.click).toBeUndefined();
    expect(a?.cookies.map((c) => c.name)).not.toContain('borlabs-cookie');
    expect(r.snapshot?.documents?.documents.map((d) => [d.kind, d.complete])).toEqual([
      ['impressum', true],
      ['privacy', true],
    ]);
  });

  it('PRIV-01: the Tag Manager only the dialog names → named-in-cmp-only (info); Google Analytics → not-named', () => {
    expectValidReport(r.report);
    expect(
      priv01()
        .map((f) => [f.subject, f.variant, f.severity])
        .sort(),
    ).toEqual([
      ['google-analytics', 'not-named', 'warning'],
      ['google-tag-manager', 'named-in-cmp-only', 'info'],
    ]);
    const gtm = priv01().find((f) => f.subject === 'google-tag-manager');
    expect(gtm?.params).toMatchObject({
      cmp: 'Borlabs Cookie',
      cmpTerm: 'Google Tag Manager',
      categoryOnly: false,
    });
    const match = report().evidence.find((e) => gtm?.evidenceIds.includes(e.id) && e.type === 'text-match');
    expect(match).toMatchObject({
      documentId: 'cmp-dialog',
      quote: 'Google Tag Manager',
      matchLevel: 'named',
    });
    const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain(
      'in den Angaben des Einwilligungsbanners (Borlabs Cookie) genannt: Google Tag Manager',
    );
  });

  it('no text of the dialog and no UID anywhere: snapshot, saved snapshot, JSON and HTML report, other files, log', () => {
    const written = filesUnder(outDir);
    expect(written.map(([f]) => f)).toEqual(
      expect.arrayContaining(['scan.snapshot.json', 'report.json', 'report.html']),
    );
    const places: Array<[string, string]> = [
      ['snapshot', JSON.stringify(r.snapshot)],
      ['report', JSON.stringify(r.report)],
      ['log', log.join('\n')],
      ...written,
    ];
    for (const [where, content] of places)
      for (const text of DIALOG_ONLY) expect(content.includes(text), `${text} in ${where}`).toBe(false);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
