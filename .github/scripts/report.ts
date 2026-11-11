/** report.json for the verify steps, which run after the dependencies are installed. */
import { readFileSync } from 'node:fs';
import { type Report, ReportSchema } from '../../src/core/report/schema.ts';

/** Parsed against the report schema, so a malformed report fails the step too. */
export function readReport(file: string): Report {
  return ReportSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
