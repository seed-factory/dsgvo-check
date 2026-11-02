import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTexts } from '../../../src/core/data.ts';
import { uiText } from '../../../src/core/messages.ts';
import { renderPdf } from '../../../src/reporters/pdf.ts';
import { writeReports } from '../../../src/scan.ts';
import { sampleFullReport } from '../../utils/report-fixtures.ts';

vi.mock('../../../src/reporters/pdf.ts', () => ({ renderPdf: vi.fn(), PDF_TIMEOUT_MS: 15_000 }));

const dirs: string[] = [];
function outputDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-pdf-output-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('optional PDF output', () => {
  it('prints exactly the saved HTML and includes PDF among the written files', async () => {
    const report = sampleFullReport();
    const outDir = outputDir();
    vi.mocked(renderPdf).mockResolvedValue(Buffer.from('%PDF-1.7\n'));
    const result = await writeReports(
      { report, snapshot: null, exitCode: 1 },
      { outDir, formats: ['json', 'html', 'pdf'], lang: 'en' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.warnings).toEqual([]);
    const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(renderPdf).toHaveBeenCalledWith(html, expect.any(Object), undefined);
    expect(result.written.map((file) => path.basename(file))).toEqual([
      'report.json',
      'report.html',
      'report.pdf',
    ]);
  });

  it('renders HTML only in memory for PDF-only output', async () => {
    const outDir = outputDir();
    vi.mocked(renderPdf).mockResolvedValue(Buffer.from('%PDF-1.7\n'));
    await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      { outDir, formats: ['pdf'], lang: 'en' },
    );
    expect(renderPdf).toHaveBeenCalledOnce();
    expect(existsSync(path.join(outDir, 'report.html'))).toBe(false);
    expect(existsSync(path.join(outDir, 'report.pdf'))).toBe(true);
  });

  it('printing failure removes a stale PDF and preserves the scan code, reasons and JSON', async () => {
    const report = sampleFullReport();
    const original = JSON.stringify(report);
    const outDir = outputDir();
    writeFileSync(path.join(outDir, 'report.pdf'), 'stale report');
    vi.mocked(renderPdf).mockRejectedValue(new Error('Chromium unavailable: private site data'));
    const result = await writeReports(
      { report, snapshot: null, exitCode: 1 },
      { outDir, formats: ['json', 'pdf'], lang: 'en' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([uiText(loadTexts('en'), 'report.pdf.skipped')]);
    expect(result.warnings.join(' ')).not.toContain('private site data');
    expect(JSON.stringify(report)).toBe(original);
    expect(JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')).summary).toEqual(
      report.summary,
    );
    expect(existsSync(path.join(outDir, 'report.pdf'))).toBe(false);
  });

  it('times out a stalled PDF without changing the report or exit code', async () => {
    const outDir = outputDir();
    const report = sampleFullReport();
    vi.mocked(renderPdf).mockImplementation(() => new Promise(() => {}));
    const result = await writeReports(
      { report, snapshot: null, exitCode: 1 },
      { outDir, formats: ['json', 'pdf'], lang: 'en', pdf: { timeoutMs: 20 } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')).summary).toEqual(
      report.summary,
    );
    expect(existsSync(path.join(outDir, 'report.pdf'))).toBe(false);
  });

  it('does not launch Chromium unless PDF was requested', async () => {
    const outDir = outputDir();
    await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      { outDir, formats: ['json', 'html'], lang: 'en' },
    );
    expect(renderPdf).not.toHaveBeenCalled();
    expect(existsSync(path.join(outDir, 'report.pdf'))).toBe(false);
  });
});
