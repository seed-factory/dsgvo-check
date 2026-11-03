/**
 * Writes the requested report files of a scan result (json, html, summary, pdf) and the console text. A failed
 * write turns the exit code into 2 (`report-write-failed`, 5.2); PDF printing is best effort.
 */
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DATA_DIR, loadTexts } from '../core/data.ts';
import { errorMessage } from '../core/errors.ts';
import type { ExitCode } from '../core/gate.ts';
import { uiText } from '../core/messages.ts';
import { REPORT_FILES, type ReporterContext, type ReportFormat } from '../core/reporter.ts';
import type { ScanResult } from '../scan.ts';
import { renderConsole } from './console.ts';
import { renderHtml } from './html.ts';
import { renderJson } from './json.ts';
import { PDF_TIMEOUT_MS, type PdfOptions, renderPdf } from './pdf.ts';
import { renderSummary } from './summary.ts';

export interface WriteResult {
  exitCode: ExitCode;
  written: string[];
  errors: Array<{ path: string; message: string }>;
  /** Optional PDF printing is best effort and does not change the scan result. */
  warnings: string[];
  /** Console report text (when `console` is among the formats). */
  console: string | null;
}

const RENDERERS = { json: renderJson, html: renderHtml, summary: renderSummary } as const;

/**
 * Write requested report files to `outDir` (json first). A failed write turns the exit code into 2
 * (`report-write-failed`, 5.2) and the JSON is rewritten with the updated summary when possible.
 */
export async function writeReports(
  result: ScanResult,
  opts: {
    outDir: string;
    formats: ReportFormat[];
    lang: 'de' | 'en';
    color?: boolean;
    dataDir?: string;
    /** Directory containing source artifacts when reissuing a saved report. */
    artifactsDir?: string;
    pdf?: PdfOptions;
    watchdogDeadline?: number;
    outputConsole?: (text: string) => Promise<void>;
  },
): Promise<WriteResult> {
  const outDir = path.resolve(opts.outDir);
  const texts = loadTexts(opts.lang, opts.dataDir ?? DEFAULT_DATA_DIR);
  const ctx: ReporterContext = {
    texts,
    lang: opts.lang,
    outDir: path.resolve(opts.artifactsDir ?? outDir),
    color: opts.color ?? false,
    dataDir: opts.dataDir,
  };
  const written: string[] = [];
  const errors: WriteResult['errors'] = [];
  const warnings: string[] = [];
  let renderedHtml: string | undefined;
  const fileFormats = (['json', 'html', 'summary'] as const).filter((f) => opts.formats.includes(f));

  const writeOne = async (format: (typeof fileFormats)[number]) => {
    const file = path.join(outDir, REPORT_FILES[format]);
    try {
      await mkdir(outDir, { recursive: true });
      if (format === 'html' && renderedHtml === undefined) renderedHtml = renderHtml(result.report, ctx);
      const content = format === 'html' ? renderedHtml! : RENDERERS[format](result.report, ctx);
      await writeFile(file, content);
      if (!written.includes(file)) written.push(file);
    } catch (err) {
      errors.push({ path: file, message: errorMessage(err) });
    }
  };
  for (const f of fileFormats) await writeOne(f);

  let exitCode = result.exitCode;
  if (errors.length > 0) {
    exitCode = 2;
    const s = result.report.summary;
    if (!s.exitReasons.includes('report-write-failed')) s.exitReasons.push('report-write-failed');
    s.exitCode = 2;
    if (fileFormats.includes('json') && !errors.some((e) => e.path.endsWith(REPORT_FILES.json))) {
      await writeOne('json');
    }
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      await appendFile(stepSummary, renderSummary(result.report, ctx));
    } catch {
      // Job Summary is best effort; not a requested report file.
    }
  }

  const consoleText = opts.formats.includes('console') ? renderConsole(result.report, ctx) : null;
  if (consoleText && opts.outputConsole) await opts.outputConsole(consoleText);

  if (opts.formats.includes('pdf')) {
    const file = path.join(outDir, REPORT_FILES.pdf);
    try {
      // Remove an earlier PDF first: a failed reprint must not leave a stale report behind.
      await rm(file, { force: true });
      await mkdir(outDir, { recursive: true });
      if (opts.watchdogDeadline !== undefined && opts.watchdogDeadline - Date.now() < PDF_TIMEOUT_MS)
        throw new Error('insufficient time');
      const html = renderedHtml ?? renderHtml(result.report, ctx);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Math.min(opts.pdf?.timeoutMs ?? PDF_TIMEOUT_MS, PDF_TIMEOUT_MS);
      const pdf = await Promise.race([
        renderPdf(html, ctx, opts.pdf),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PDF timeout')), timeout);
        }),
      ]).finally(() => clearTimeout(timer));
      const temporary = `${file}.tmp`;
      await writeFile(temporary, pdf);
      await rename(temporary, file);
      written.push(file);
    } catch {
      await rm(file, { force: true }).catch(() => undefined);
      await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
      warnings.push(uiText(texts, 'report.pdf.skipped'));
    }
  }

  return { exitCode, written, errors, warnings, console: consoleText };
}
