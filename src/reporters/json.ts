/**
 * JSON reporter: the contract format (5.1). crmCode appears only here. `disclaimer.text` carries the conditional
 * paragraphs when texts are available; without a context (minimal failed report written synchronously by the
 * CLI) the report's own text is kept.
 */

import type { Report } from '../core/report-schema.ts';
import { REPORT_SCHEMA_ID } from '../core/report-schema.ts';
import type { ReporterContext } from '../core/reporter.ts';
import { disclaimerText } from './disclaimer.ts';

export function renderJson(report: Report, ctx?: ReporterContext): string {
  const disclaimer = ctx
    ? { ...report.disclaimer, text: disclaimerText(report, ctx.texts) }
    : report.disclaimer;
  return `${JSON.stringify({ $schema: REPORT_SCHEMA_ID, ...report, disclaimer }, null, 2)}\n`;
}
