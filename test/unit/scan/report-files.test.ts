import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeReports } from '../../../src/reporters/write.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { dataDir, scanWith } from './fixtures.ts';

describe('save-snapshot write failure', () => {
  it('keeps the scan result but exits 2 with report-write-failed', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'snapfail-'));
    const blocker = path.join(parent, 'file');
    writeFileSync(blocker, 'x');

    const result = await scanWith({ saveSnapshot: path.join(blocker, 'sub', 'x.snapshot.json') });

    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('complete');
    expect(result.report.summary.exitReasons).toEqual(['report-write-failed', 'threshold']);
    expectValidReport(result.report);
  });
});

describe('writeReports', () => {
  it('a requested file that cannot be written → exit 2 with report-write-failed', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'out-'));
    const blocker = path.join(parent, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const result = await scanWith();

    const w = await writeReports(result, { outDir: blocker, formats: ['json'], lang: 'de', dataDir });

    expect(w.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toContain('report-write-failed');
    expect(existsSync(path.join(blocker, 'report.json')), 'no report.json below a file').toBe(false);
    expectValidReport(result.report);
  });

  it.each([
    ['html', 'report.html'],
    ['summary', 'summary.md'],
  ] as const)(
    'a requested %s report that cannot be written → 2; JSON rewritten with the final code (5.2)',
    async (format, file) => {
      const out = mkdtempSync(path.join(tmpdir(), 'out-'));
      // A directory in place of the file makes exactly this reporter fail; report.json stays writable.
      mkdirSync(path.join(out, file));
      const result = await scanWith({ failOn: 'none' });
      expect(result.exitCode).toBe(0);

      const w = await writeReports(result, { outDir: out, formats: ['json', format], lang: 'de', dataDir });

      expect(w.exitCode).toBe(2);
      expect(w.errors.map((e) => path.basename(e.path))).toEqual([file]);
      expect(w.written.map((p) => path.basename(p))).toEqual(['report.json']);
      const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
      expect(json.summary.exitCode).toBe(2);
      expect(json.summary.exitReasons).toEqual(['report-write-failed']);
      expectValidReport(json);
    },
  );
});
