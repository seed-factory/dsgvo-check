/** Reporter contract. Reporters are pure renderers: report (+ texts) → string. Writing files is done by scan.ts. */
import type { Texts } from './data.ts';
import type { Report } from './report-schema.ts';

export type ReportFormat = 'console' | 'json' | 'html' | 'summary';
export const REPORT_FORMATS: readonly ReportFormat[] = ['console', 'json', 'html', 'summary'];

/** File names inside `--out`. */
export const REPORT_FILES: Readonly<Record<Exclude<ReportFormat, 'console'>, string>> = {
  json: 'report.json',
  html: 'report.html',
  summary: 'summary.md',
};

export interface ReporterContext {
  texts: Texts;
  lang: 'de' | 'en';
  /** Absolute output directory; screenshot paths in evidence are relative to it. */
  outDir: string;
  /** ANSI colors (console only). */
  color: boolean;
}

export type RenderReport = (report: Report, ctx: ReporterContext) => string;
