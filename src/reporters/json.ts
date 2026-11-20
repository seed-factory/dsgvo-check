/** JSON reporter: the contract format and the only place with crmCode; `disclaimer.text` carries the conditional paragraphs when texts are available. */

import type { ReporterContext } from '../core/report/reporter.ts';
import type { Report } from '../core/report/schema.ts';
import { REPORT_SCHEMA_ID } from '../core/report/schema.ts';
import { disclaimerText } from './disclaimer.ts';

export function renderJson(report: Report, ctx?: ReporterContext): string {
  // The text is composed in the language of the texts, so `lang` follows them.
  const disclaimer = ctx
    ? { ...report.disclaimer, lang: ctx.texts.lang, text: disclaimerText(report, ctx.texts) }
    : report.disclaimer;
  return `${JSON.stringify({ $schema: REPORT_SCHEMA_ID, ...report, disclaimer }, null, 2)}\n`;
}
