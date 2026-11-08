/**
 * The full browser pipeline on the Complianz simulator, where the page fills the plugin's object and the banner's buttons
 * with data: neither the snapshot nor a report holds it, while the region signal, the clicks and the verification of the
 * reject work as on a normal page. Markers start with `zq7`; the two hex ids are markers too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FullReport } from '../../../src/core/report/schema.ts';
import type { ScanResult } from '../../../src/scan.ts';
import { useFixtureServer } from '../../fixture-server/use-fixture-server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { scanFixture, useScan, writeFixtureReports } from './helpers.ts';

const CHECKS = ['CONSENT-01', 'CONSENT-02', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05'];
const MARKERS = ['zq7', '9f86d081884c7d659a2feaa0c55ad015', '5f4dcc3b5aa765d61d8327deb882cf99'];

const server = useFixtureServer(() => ({ sites: ['cmp/complianz'] }));

afterEach(() => {
  expect(server().unexpected).toEqual([]);
});

/** Scans `pathname` of the simulator and writes every report; `files` is the snapshot and each written text in one. */
async function run(
  pathname: string,
): Promise<{ r: ScanResult; report: FullReport; html: string; files: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-pipeline-'));
  const r = await scanFixture(server(), {
    url: `https://www.complianz.test${pathname}`,
    outDir,
    checks: CHECKS,
  });
  const { html, json, summary, console: consoleText } = await writeFixtureReports(r, outDir);
  expectValidReport(r.report);
  const files = [JSON.stringify(r.snapshot), html, json, summary, consoleText ?? ''].join('\n');
  return { r, report: r.report as FullReport, html, files };
}

const expectNoMarker = (files: string) => {
  for (const marker of MARKERS)
    expect(files.match(new RegExp(`.{0,40}${marker}.{0,40}`, 'g')) ?? [], marker).toEqual([]);
};

describe('the plugin object with data in region, consent type and version', () => {
  const scanned = useScan(() => run('/hostile-config.html'));

  it('the region is reported as the special branch it is, by the plugin value `other`', () => {
    const geo = scanned().report.diagnostics.find((d) => d.code === 'SCAN-GEO');
    expect(geo?.params).toMatchObject({ signal: 'complianz:region=other' });
    expect(scanned().html).toContain('complianz:region=other');
    const first = scanned().r.snapshot?.cmp?.phases.find((p) => p.phase === 'B')?.facts[0];
    expect(first?.config).toEqual({
      'complianz.region': 'other',
      'complianz.consenttype': 'other',
      'complianz.version': null,
    });
  });

  it('no marker in the snapshot or any report', () => {
    expectNoMarker(scanned().files);
  });
});

describe('banner buttons with data in their attributes', () => {
  const scanned = useScan(() => run('/hostile-markup.html'));

  it('phase B rejects and phase C accepts through the buttons own classes, and the reject verifies', () => {
    const { r } = scanned();
    expect(r.snapshot?.plan.browser?.click).toMatchObject({
      B: {
        action: 'reject',
        target: {
          cmpId: 'complianz',
          name: 'Ablehnen',
          role: 'button',
          selector: 'button.cmplz-btn.cmplz-deny',
        },
      },
      C: {
        action: 'accept',
        target: { cmpId: 'complianz', name: 'Akzeptieren', selector: 'button.cmplz-btn.cmplz-accept' },
      },
    });
    const b = r.snapshot?.cmp?.phases.find((p) => p.phase === 'B');
    expect(b?.click).toMatchObject({ clicked: true, button: { role: 'button' } });
    expect(b?.verify?.verified).toBe(true);
  });

  it('no marker in the snapshot or any report', () => {
    expectNoMarker(scanned().files);
  });
});
