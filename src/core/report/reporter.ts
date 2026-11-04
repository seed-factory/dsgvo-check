/** Reporter contract. Reporters are pure renderers: report (+ texts) → string. Writing files is done by scan.ts. */
import type { Texts } from '../data/load.ts';
import type { Lang, Report } from './schema.ts';

export const REPORT_FORMATS = ['console', 'json', 'html', 'summary', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** `full`: findings with evidence for developers; `brief`: plain summary and action points for the site owner. */
export const REPORT_DETAILS = ['full', 'brief'] as const;
export type ReportDetail = (typeof REPORT_DETAILS)[number];

/** File names inside `--out`. */
export const REPORT_FILES: Readonly<Record<Exclude<ReportFormat, 'console'>, string>> = {
  json: 'report.json',
  html: 'report.html',
  summary: 'summary.md',
  pdf: 'report.pdf',
};

/** Size and time limits of the renderers (`report.*` and `pdf.timeoutMs` of the settings). */
export interface ReporterLimits {
  summaryMaxFindings: number;
  summaryMaxBytes: number;
  screenshotEmbedMaxBytes: number;
  pdfTimeoutMs: number;
}

export interface ReporterContext {
  texts: Texts;
  lang: Lang;
  /** Absolute output directory; screenshot paths in evidence are relative to it. */
  outDir: string;
  /** ANSI colors (console only). */
  color: boolean;
  /** Level of detail of report.html and report.pdf (`full` when absent). */
  detail?: ReportDetail;
  /** Optional data root, including the report template. */
  dataDir?: string;
  /** The built-in defaults when absent. */
  limits?: ReporterLimits;
}

export type RenderReport = (report: Report, ctx: ReporterContext) => string;
