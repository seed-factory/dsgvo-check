import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

describe('writeReports with report variants', () => {
  const variantsOf = (root: string) =>
    [
      { lang: 'de', detail: 'full', dir: path.join(root, 'de', 'developer') },
      { lang: 'de', detail: 'brief', dir: path.join(root, 'de', 'owner') },
      { lang: 'en', detail: 'full', dir: path.join(root, 'en', 'developer') },
    ] as const;

  it('writes one html per variant in its language and level of detail; json and summary only at the root', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'out-'));
    const result = await scanWith({ failOn: 'none' });

    const w = await writeReports(result, {
      outDir: out,
      formats: ['json', 'html', 'summary'],
      lang: 'de',
      variants: [...variantsOf(out)],
      dataDir,
    });

    expect(w.errors).toEqual([]);
    const html = (...parts: string[]) => readFileSync(path.join(out, ...parts, 'report.html'), 'utf8');
    expect(html('de', 'developer')).toContain('<html lang="de">');
    expect(html('de', 'developer')).toContain('front-full');
    expect(html('de', 'owner')).toContain('<html lang="de">');
    expect(html('de', 'owner')).toContain('front-brief');
    expect(html('en', 'developer')).toContain('<html lang="en">');
    expect(existsSync(path.join(out, 'report.html'))).toBe(false);
    for (const file of ['report.json', 'summary.md']) expect(existsSync(path.join(out, file))).toBe(true);
    for (const v of variantsOf(out)) {
      expect(existsSync(path.join(v.dir, 'report.json'))).toBe(false);
      expect(existsSync(path.join(v.dir, 'summary.md'))).toBe(false);
    }
  });

  it('appends the Job Summary once however many variants there are', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'out-'));
    const stepSummary = path.join(out, 'step-summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', stepSummary);
    try {
      const result = await scanWith({ failOn: 'none' });
      await writeReports(result, {
        outDir: out,
        formats: ['html'],
        lang: 'de',
        variants: [...variantsOf(out)],
        dataDir,
      });
      const text = readFileSync(stepSummary, 'utf8');
      expect(text.match(/^## dsgvo-check/gm)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a variant html that cannot be written → exit 2 and report.json rewritten', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'out-'));
    const variants = variantsOf(out);
    mkdirSync(path.join(variants[1].dir, 'report.html'), { recursive: true });
    const result = await scanWith({ failOn: 'none' });

    const w = await writeReports(result, {
      outDir: out,
      formats: ['json', 'html'],
      lang: 'de',
      variants: [...variants],
      dataDir,
    });

    expect(w.exitCode).toBe(2);
    expect(w.errors.map((e) => e.path)).toEqual([path.join(variants[1].dir, 'report.html')]);
    expect(existsSync(path.join(variants[0].dir, 'report.html'))).toBe(true);
    expect(existsSync(path.join(variants[2].dir, 'report.html'))).toBe(true);
    const json = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(json.summary.exitCode).toBe(2);
    expect(json.summary.exitReasons).toEqual(['report-write-failed']);
  });
});
