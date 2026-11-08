import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfigInput } from '../../../../src/core/config/load.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { uiText } from '../../../../src/core/data/messages.ts';
import { renderPdf } from '../../../../src/reporters/pdf.ts';
import { writeReports } from '../../../../src/reporters/write.ts';
import { sampleFullReport } from '../../../utils/report/fixtures.ts';

vi.mock('../../../../src/reporters/pdf.ts', () => ({ renderPdf: vi.fn(), PDF_TIMEOUT_MS: 15_000 }));

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

  it.each([
    ['the option', { detail: 'brief' as const }, undefined],
    ['the setting', {}, parseConfigInput({ report: { detail: 'brief' } })],
  ])('prints and writes the brief report from %s; the JSON is the same', async (_name, detail, config) => {
    const outDir = outputDir();
    vi.mocked(renderPdf).mockResolvedValue(Buffer.from('%PDF-1.7\n'));
    const report = sampleFullReport();

    await writeReports(
      { report, snapshot: null, exitCode: 0 },
      { outDir, formats: ['json', 'html', 'pdf'], lang: 'en', ...detail, ...(config ? { config } : {}) },
    );

    const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).not.toContain('class="evidence"');
    expect(html).toContain('What to do');
    expect(renderPdf).toHaveBeenCalledWith(html, expect.any(Object), undefined);
    const json = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    expect(json.findings[0].evidenceIds).toEqual(report.findings[0]!.evidenceIds);
  });

  it('prefers the option over the setting', async () => {
    const outDir = outputDir();
    await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      {
        outDir,
        formats: ['html'],
        lang: 'en',
        detail: 'full',
        config: parseConfigInput({ report: { detail: 'brief' } }),
      },
    );
    expect(readFileSync(path.join(outDir, 'report.html'), 'utf8')).toContain('class="evidence"');
  });

  it('renders HTML only in memory for PDF-only output', async () => {
    const outDir = outputDir();
    vi.mocked(renderPdf).mockResolvedValue(Buffer.from('%PDF-1.7\n'));

    await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      { outDir, formats: ['pdf'], lang: 'en' },
    );

    expect(renderPdf).toHaveBeenCalledOnce();
    expect(existsSync(path.join(outDir, 'report.html')), 'no HTML file for PDF-only output').toBe(false);
    expect(existsSync(path.join(outDir, 'report.pdf')), 'the PDF is written').toBe(true);
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
    expect(existsSync(path.join(outDir, 'report.pdf')), 'the stale PDF is removed').toBe(false);
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
    expect(existsSync(path.join(outDir, 'report.pdf')), 'no PDF after the timeout').toBe(false);
  });

  it('hands the limits of the settings to the printer and keeps the watchdog from cutting it short', async () => {
    const config = parseConfigInput({ pdf: { timeoutMs: 30_000 }, scan: { reportWriteReserveMs: 45_000 } });
    vi.mocked(renderPdf).mockResolvedValue(Buffer.from('%PDF-1.7\n'));
    const outDir = outputDir();

    // 40 s are left before the watchdog, more than the 30 s PDF limit of the settings: the PDF is printed
    const printed = await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      { outDir, formats: ['pdf'], lang: 'en', config, watchdogDeadline: Date.now() + 40_000 },
    );
    expect(printed.warnings).toEqual([]);
    expect(renderPdf).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limits: expect.objectContaining({ pdfTimeoutMs: 30_000 }) }),
      undefined,
    );

    // 20 s are less than the PDF limit: the PDF is skipped instead of being cut short by the watchdog
    vi.mocked(renderPdf).mockClear();
    const skipped = await writeReports(
      { report: sampleFullReport(), snapshot: null, exitCode: 0 },
      { outDir: outputDir(), formats: ['pdf'], lang: 'en', config, watchdogDeadline: Date.now() + 20_000 },
    );
    expect(renderPdf).not.toHaveBeenCalled();
    expect(skipped.warnings).toEqual([uiText(loadTexts('en'), 'report.pdf.skipped')]);
  });
});
