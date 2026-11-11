/**
 * End to end on a site that plants values of its own choosing where the browser collector reads short values, and
 * whose legal pages print the visitor's cookie and storage values: the snapshot, the JSON report and the reports for
 * people hold none of them, while the legal documents are still found and evaluated. Markers: `zq8`, `4f3a9c1d`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserChecks } from '../../../src/checks/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import type { ScanResult } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { HOSTILE_SITE } from '../browser/hostile-values-site.ts';
import { useSite } from '../browser/site-dir.ts';
import { scanFixture, writeFixtureReports } from './helpers.ts';

const MARKERS = /[^"<>]{0,40}(?:zq8|4f3a9c1d)[^"<>]{0,40}/gi;

const site = useSite(HOSTILE_SITE);
let r: ScanResult;
let outputs: Record<string, string>;

beforeAll(async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-page-values-'));
  r = await scanFixture(site.server, {
    url: 'https://www.example.test/',
    outDir,
    checks: browserChecks.map((c) => c.id),
  });
  const { json, html, summary, console: consoleText } = await writeFixtureReports(r, outDir);
  outputs = {
    snapshot: JSON.stringify(r.snapshot),
    'report.json': json,
    'report.html': html,
    'summary.md': summary,
    console: consoleText ?? '',
  };
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
    expect(site.server.unexpected).toEqual([]);
  });
});
