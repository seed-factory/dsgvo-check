/**
 * End to end on a site that plants values of its own choosing where the browser collector reads short values, and
 * whose legal pages print the visitor's cookie and storage values: the snapshot, the JSON report and the reports for
 * people hold none of them, while the legal documents are still found and evaluated. Markers: `zq8`, `4f3a9c1d`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserChecks } from '../../../src/checks/browser/index.ts';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';
import { HOSTILE_SITE } from '../browser/hostile-values-site.ts';
import { type SiteDir, writeSite } from '../browser/site-dir.ts';

const MARKERS = /[^"<>]{0,40}(?:zq8|4f3a9c1d)[^"<>]{0,40}/gi;

let server: FixtureServer;
let dir: SiteDir;
let r: ScanResult;
let outputs: Record<string, string>;

beforeAll(async () => {
  dir = writeSite(HOSTILE_SITE);
  server = await startFixtureServer({ hosts: { 'www.example.test': dir.root } });
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-page-values-'));
  r = await scan({
    url: 'https://www.example.test/',
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir,
    checks: browserChecks.map((c) => c.id),
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
  const w = await writeReports(r, { outDir, formats: ['console', 'json', 'html', 'summary'], lang: 'de' });
  expect(w.errors).toEqual([]);
  const read = (f: string) => readFileSync(path.join(outDir, f), 'utf8');
  outputs = {
    snapshot: JSON.stringify(r.snapshot),
    'report.json': read('report.json'),
    'report.html': read('report.html'),
    'summary.md': read('summary.md'),
    console: w.console ?? '',
  };
});

afterAll(async () => {
  await server?.close();
  dir?.cleanup();
});

describe('a scan of a site that plants values in what the browser reads', () => {
  it('the scan ran all three phases and wrote a valid report', () => {
    expectValidReport(r.report);
    expect(r.snapshot?.browser?.phases.map((p) => p.phase)).toEqual(['A', 'B', 'C']);
  });

  it.each(['snapshot', 'report.json', 'report.html', 'summary.md', 'console'])(
    'no planted value in %s',
    (name) => {
      expect(outputs[name]?.match(MARKERS) ?? []).toEqual([]);
    },
  );

  it('counterexample: the legal documents are found and read in German', () => {
    expect(r.snapshot?.documents?.documents.map((d) => [d.kind, d.lang])).toEqual(
      expect.arrayContaining([
        ['impressum', 'de'],
        ['privacy', 'de'],
      ]),
    );
    const legal = (r.report as FullReport).checks.find((c) => c.id === 'LEGAL-01');
    expect(legal?.error).toBeUndefined();
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
