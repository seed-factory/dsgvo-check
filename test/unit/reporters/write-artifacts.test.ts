/**
 * Rendering a saved report into another directory (`report <report.json> --out <dir>`): the screenshots are read from
 * the directory of the JSON file, where the scan stored them, and embedded in the new HTML.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../../src/core/report/schema.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { sampleFullReport } from '../../utils/report/fixtures.ts';

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

function savedReport() {
  const source = mkdtempSync(path.join(tmpdir(), 'saved-report-'));
  mkdirSync(path.join(source, 'artifacts'));
  writeFileSync(path.join(source, 'artifacts', 'banner-B.jpg'), JPEG);

  const report = sampleFullReport();
  const shot = report.evidence.find((e) => e.type === 'screenshot') as Extract<
    Evidence,
    { type: 'screenshot' }
  >;
  shot.sha256 = createHash('sha256').update(JPEG).digest('hex');
  return { source, report };
}

describe('a saved report rendered into another directory', () => {
  it('embeds the screenshots stored next to the JSON file', async () => {
    const { source, report } = savedReport();
    const out = mkdtempSync(path.join(tmpdir(), 'rendered-'));

    const w = await writeReports(
      { report, snapshot: null, exitCode: 0 },
      { outDir: out, formats: ['html'], lang: 'en', artifactsDir: source },
    );

    expect(w.errors).toEqual([]);
    expect(readFileSync(path.join(out, 'report.html'), 'utf8')).toContain(
      `src="data:image/jpeg;base64,${JPEG.toString('base64')}"`,
    );
  });

  it('finds nothing to embed when the images are looked up in the output directory instead', async () => {
    const { report } = savedReport();
    const out = mkdtempSync(path.join(tmpdir(), 'rendered-'));

    await writeReports(
      { report, snapshot: null, exitCode: 0 },
      { outDir: out, formats: ['html'], lang: 'en' },
    );

    const html = readFileSync(path.join(out, 'report.html'), 'utf8');
    expect(html).not.toContain('data:image');
    expect(html).toContain('Screenshot not embedded');
  });
});
