/** Writes the requested report files and the console text of a scan result; a failed write turns the exit code into 2 (`report-write-failed`), PDF printing is best effort. */
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reporterLimits } from '../core/config/limits.ts';
import type { Config } from '../core/config/schema.ts';
import { DEFAULT_DATA_DIR, loadTexts } from '../core/data/load.ts';
import { uiText } from '../core/data/messages.ts';
import type { ExitCode } from '../core/evaluation/gate.ts';
import {
  PROFILE_DETAIL,
  REPORT_FILES,
  type ReportDetail,
  type ReporterContext,
  type ReportFormat,
} from '../core/report/reporter.ts';
import type { Lang } from '../core/report/schema.ts';
import { errorMessage } from '../core/runtime/errors.ts';
import type { ScanResult } from '../scan.ts';
import { renderConsole } from './console.ts';
import { renderHtml } from './html.ts';
import { renderJson } from './json.ts';
import { type PdfOptions, renderPdf } from './pdf.ts';
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

/** Formats that become a file through a renderer; written in this order, json first. */
const FILE_FORMATS = ['json', 'html', 'summary'] as const;
type FileFormat = (typeof FILE_FORMATS)[number];

/** One rendering of report.html and report.pdf. */
export interface ReportVariant {
  lang: Lang;
  detail: ReportDetail;
  dir: string;
}

export interface WriteOptions {
  outDir: string;
  formats: ReportFormat[];
  /** Language of report.json, summary.md and the console text. */
  lang: Lang;
  /** Level of detail of the HTML and the PDF without `variants`; the first profile of the settings when absent. */
  detail?: ReportDetail;
  /** Renderings of report.html and report.pdf; one in `outDir` in `lang` and `detail` when absent. */
  variants?: ReportVariant[];
  color?: boolean;
  dataDir?: string;
  /** Directory containing source artifacts when reissuing a saved report. */
  artifactsDir?: string;
  pdf?: PdfOptions;
  /** Operator settings: report size limits and the PDF time limit (built-in defaults when absent). */
  config?: Pick<Config, 'report' | 'pdf'>;
  watchdogDeadline?: number;
  outputConsole?: (text: string) => Promise<void>;
}

function reporterContext(
  opts: WriteOptions,
  outDir: string,
  lang: Lang,
  detail: ReportDetail,
): ReporterContext {
  return {
    texts: loadTexts(lang, opts.dataDir ?? DEFAULT_DATA_DIR),
    lang,
    outDir: path.resolve(opts.artifactsDir ?? outDir),
    color: opts.color ?? false,
    detail,
    dataDir: opts.dataDir,
    limits: reporterLimits(opts.config),
  };
}

/** A report whose files could not all be written no longer passes: exit code 2 with reason `report-write-failed`. */
function recordWriteFailure(summary: ScanResult['report']['summary']): void {
  if (!summary.exitReasons.includes('report-write-failed')) summary.exitReasons.push('report-write-failed');
  summary.exitCode = 2;
}

/** The Job Summary is best effort and not a requested report file. */
async function appendJobSummary(report: ScanResult['report'], ctx: ReporterContext): Promise<void> {
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (!stepSummary) return;

  try {
    await appendFile(stepSummary, renderSummary(report, ctx));
  } catch {
    // Deliberately ignored.
  }
}

function printWithinLimit(
  html: string,
  ctx: ReporterContext,
  pdf: PdfOptions | undefined,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    renderPdf(html, ctx, pdf),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF timeout')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Prints through a temporary file and a rename, so a half-written PDF never carries the final name. */
async function writePdf(
  file: string,
  renderHtmlOnce: () => string,
  ctx: ReporterContext,
  opts: WriteOptions,
): Promise<void> {
  const pdfTimeoutMs = ctx.limits?.pdfTimeoutMs ?? reporterLimits().pdfTimeoutMs;

  // Remove an earlier PDF first: a failed reprint must not leave a stale report behind.
  await rm(file, { force: true });
  await mkdir(path.dirname(file), { recursive: true });
  if (opts.watchdogDeadline !== undefined && opts.watchdogDeadline - Date.now() < pdfTimeoutMs) {
    throw new Error('insufficient time');
  }

  const timeoutMs = Math.min(opts.pdf?.timeoutMs ?? pdfTimeoutMs, pdfTimeoutMs);
  const pdf = await printWithinLimit(renderHtmlOnce(), ctx, opts.pdf, timeoutMs);

  const temporary = `${file}.tmp`;
  await writeFile(temporary, pdf);
  await rename(temporary, file);
}

/** Writes the requested report files to `outDir` (json first); a failed write sets exit code 2 and the JSON is rewritten with the updated summary when possible. */
export async function writeReports(result: ScanResult, opts: WriteOptions): Promise<WriteResult> {
  const outDir = path.resolve(opts.outDir);
  const profile = opts.config?.report.profiles[0];
  const detail = opts.detail ?? (profile ? PROFILE_DETAIL[profile] : 'full');
  const ctx = reporterContext(opts, outDir, opts.lang, detail);
  const variants = (opts.variants ?? [{ lang: opts.lang, detail, dir: outDir }]).map((v) => ({
    dir: path.resolve(v.dir),
    ctx: reporterContext(opts, outDir, v.lang, v.detail),
  }));
  const written: string[] = [];
  const errors: WriteResult['errors'] = [];
  const warnings: string[] = [];

  // The HTML of a variant is shared by its html file and its PDF.
  const htmlOf = new Map<string, string>();
  const html = (v: (typeof variants)[number]) => {
    const cached = htmlOf.get(v.dir);
    if (cached !== undefined) return cached;
    const rendered = renderHtml(result.report, v.ctx);
    htmlOf.set(v.dir, rendered);
    return rendered;
  };

  const writeFileTo = async (dir: string, name: string, render: () => string) => {
    const file = path.join(dir, name);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, render());
      if (!written.includes(file)) written.push(file);
    } catch (err) {
      errors.push({ path: file, message: errorMessage(err) });
    }
  };

  const writeOne = async (format: FileFormat) => {
    if (format === 'html') {
      for (const v of variants) await writeFileTo(v.dir, REPORT_FILES.html, () => html(v));
    } else {
      await writeFileTo(outDir, REPORT_FILES[format], () => RENDERERS[format](result.report, ctx));
    }
  };

  const fileFormats = FILE_FORMATS.filter((f) => opts.formats.includes(f));
  for (const format of fileFormats) await writeOne(format);

  let exitCode = result.exitCode;
  if (errors.length > 0) {
    exitCode = 2;
    recordWriteFailure(result.report.summary);
    const jsonFailed = errors.some((e) => e.path.endsWith(REPORT_FILES.json));
    if (fileFormats.includes('json') && !jsonFailed) await writeOne('json');
  }

  await appendJobSummary(result.report, ctx);

  const consoleText = opts.formats.includes('console') ? renderConsole(result.report, ctx) : null;
  if (consoleText && opts.outputConsole) await opts.outputConsole(consoleText);

  if (opts.formats.includes('pdf')) {
    for (const v of variants) {
      const file = path.join(v.dir, REPORT_FILES.pdf);
      try {
        await writePdf(file, () => html(v), v.ctx, opts);
        written.push(file);
      } catch {
        await rm(file, { force: true }).catch(() => undefined);
        await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
        const warning = uiText(ctx.texts, 'report.pdf.skipped');
        if (!warnings.includes(warning)) warnings.push(warning);
      }
    }
  }

  return { exitCode, written, errors, warnings, console: consoleText };
}
