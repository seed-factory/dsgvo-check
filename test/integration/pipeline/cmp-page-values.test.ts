/**
 * The full browser pipeline on the Complianz simulator, where the page fills the plugin's object and the banner's buttons
 * with data: neither the snapshot nor a report holds it, while the region signal, the clicks and the verification of the
 * reject work as on a normal page. Markers start with `zq7`; the two hex ids are markers too.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
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

const CHECKS = ['CONSENT-01', 'CONSENT-02', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05'];
const MARKERS = ['zq7', '9f86d081884c7d659a2feaa0c55ad015', '5f4dcc3b5aa765d61d8327deb882cf99'];

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['cmp/complianz'] });
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  expect(server.unexpected).toEqual([]);
});

/** Scans `pathname` of the simulator and writes every report; `files` is the snapshot and each written text in one. */
async function run(
  pathname: string,
): Promise<{ r: ScanResult; report: FullReport; html: string; files: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-pipeline-'));
  const r = await scan({
    url: `https://www.complianz.test${pathname}`,
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir,
    checks: CHECKS,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
  const w = await writeReports(r, { outDir, formats: ['console', 'json', 'html', 'summary'], lang: 'de' });
  expect(w.errors).toEqual([]);
  expectValidReport(r.report);

  const read = (name: string) => readFileSync(path.join(outDir, name), 'utf8');
  const html = read('report.html');
  const files = [
    JSON.stringify(r.snapshot),
    html,
    read('report.json'),
    read('summary.md'),
    w.console ?? '',
  ].join('\n');
  return { r, report: r.report as FullReport, html, files };
}

const expectNoMarker = (files: string) => {
  for (const marker of MARKERS)
    expect(files.match(new RegExp(`.{0,40}${marker}.{0,40}`, 'g')) ?? [], marker).toEqual([]);
};

describe('the plugin object with data in region, consent type and version', () => {
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    scanned = await run('/hostile-config.html');
  });

  it('the region is reported as the special branch it is, by the plugin value `other`', () => {
    const geo = scanned.report.diagnostics.find((d) => d.code === 'SCAN-GEO');
    expect(geo?.params).toMatchObject({ signal: 'complianz:region=other' });
    expect(scanned.html).toContain('complianz:region=other');
    const first = scanned.r.snapshot?.cmp?.phases.find((p) => p.phase === 'B')?.facts[0];
    expect(first?.config).toEqual({
      'complianz.region': 'other',
      'complianz.consenttype': 'other',
      'complianz.version': null,
    });
  });

  it('no marker in the snapshot or any report', () => {
    expectNoMarker(scanned.files);
  });
});

describe('banner buttons with data in their attributes', () => {
  let scanned: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    scanned = await run('/hostile-markup.html');
  });

  it('phase B rejects and phase C accepts through the buttons own classes, and the reject verifies', () => {
    const { r } = scanned;
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
    expectNoMarker(scanned.files);
  });
});
