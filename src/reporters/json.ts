/**
 * JSON reporter: the contract format (5.1). crmCode appears only here. `disclaimer.text` carries the conditional
 * paragraphs when texts are available; without a context (minimal failed report written synchronously by the
 * CLI) the report's own text is kept.
 */

import { REPORT_SCHEMA_ID } from '../core/report-schema.ts';
import type { RenderReport } from '../core/reporter.ts';
import { disclaimerText } from './disclaimer.ts';

export const renderJson: RenderReport = (report, ctx) => {
  const texts = (ctx as Parameters<RenderReport>[1] | null)?.texts;
  const disclaimer = texts
    ? { ...report.disclaimer, text: disclaimerText(report, texts) }
    : report.disclaimer;
  return `${JSON.stringify({ $schema: REPORT_SCHEMA_ID, ...report, disclaimer }, null, 2)}\n`;
};
