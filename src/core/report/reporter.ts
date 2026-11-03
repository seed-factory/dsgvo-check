/** Reporter contract. Reporters are pure renderers: report (+ texts) → string. Writing files is done by scan.ts. */
import type { Texts } from '../data/load.ts';
import type { Lang, Report } from './schema.ts';

export const REPORT_FORMATS = ['console', 'json', 'html', 'summary', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** File names inside `--out`. */
export const REPORT_FILES: Readonly<Record<Exclude<ReportFormat, 'console'>, string>> = {
  json: 'report.json',
  html: 'report.html',
  summary: 'summary.md',
  pdf: 'report.pdf',
};

export interface ReporterContext {
  texts: Texts;
  lang: Lang;
  /** Absolute output directory; screenshot paths in evidence are relative to it. */
  outDir: string;
  /** ANSI colors (console only). */
  color: boolean;
  /** Optional data root, including the report template. */
  dataDir?: string;
}

export type RenderReport = (report: Report, ctx: ReporterContext) => string;
