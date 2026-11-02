import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_DATA_DIR, type LegalNote, loadTexts, type Texts } from '../../../src/core/data.ts';
import {
  CheckStatusSchema,
  ConfidenceSchema,
  type Report,
  ScanStatusSchema,
  SeveritySchema,
} from '../../../src/core/report-schema.ts';
import type { ReporterContext } from '../../../src/core/reporter.ts';
import { buildReportView } from '../../../src/reporters/report-view.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report-fixtures.ts';

const source = (file: string) => readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8');

/** Collect consumers rather than deriving the expected set from the translation dictionary itself. */
export function usedReportLabelKeys(): string[] {
  const keys = new Set<string>();
  const template = readFileSync(path.join(DEFAULT_DATA_DIR, 'report/report.html'), 'utf8');
  for (const match of template.matchAll(/{{t\s+"(report\.[^"]+)"/g)) keys.add(match[1]!);
  for (const file of ['cli.ts', 'scan.ts', 'reporters/pdf.ts']) {
    for (const match of source(file).matchAll(/\buiText\([^,]+,\s*['"](report\.[^'"]+)['"]/g)) {
      keys.add(match[1]!);
    }
  }

  const texts = loadTexts('en');
  const ui = new Proxy(texts.ui, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('report.')) keys.add(key);
      return Reflect.get(target, key, receiver);
    },
    // Draft detection enumerates the whole dictionary. Enumeration is not a use of every label.
    ownKeys: () => [],
  });
  const context: ReporterContext = {
    texts: { ...texts, ui },
    lang: 'en',
    color: false,
    outDir: path.join(tmpdir(), 'report-label-key-contract'),
  };
  const capture = (report: Report) => {
    buildReportView(report, context);
    renderSummary(report, context);
  };
  const full = sampleFullReport();
  full.findings[0]!.trigger = 'before-interaction';
  full.checks[0]!.coverage = { planned: 2, observed: 2, evaluated: 1 };
  capture(full);
  capture(sampleFailedReport());

  // Closed schema domains exercise labels selected from values, not just the sample's current values.
  for (const status of ScanStatusSchema.options) {
    if (status === 'failed') continue;
    full.scan.status = status;
    capture(full);
  }
  for (const severity of SeveritySchema.options) {
    full.findings[0]!.severity = severity;
    capture(full);
  }
  for (const confidence of ConfidenceSchema.options) {
    full.findings[0]!.confidence = confidence;
    capture(full);
  }
  for (const status of CheckStatusSchema.options) {
    full.checks[0]!.status = status;
    capture(full);
  }
  const statuses = source('core/data.ts').match(
    /const LegalNoteSchema = z\.object\(\{[\s\S]*?status:\s*z\.enum\(\[([\s\S]*?)\]\)/,
  )?.[1];
  if (!statuses) throw new Error('The legal-note status domain could not be read');
  for (const match of statuses.matchAll(/'([^']+)'/g)) {
    context.texts.legalNotes['label-fixture'] = {
      text: 'Technical observation.',
      status: match[1] as LegalNote['status'],
      draft: true,
      reviewedAt: null,
      reviewBy: null,
    };
    full.findings[0]!.legalNoteId = 'label-fixture';
    capture(full);
  }
  for (const active of [true, false, null]) {
    full.scan.environment.sandbox.active = active;
    full.findings[0]!.replicated = active === true;
    capture(full);
  }

  full.summary.exitReasons = [];
  full.findings[0]!.evidenceIds.push('missing-label-evidence');
  capture(full);
  full.findings = Array.from({ length: 51 }, () => full.findings[0]!);
  capture(full);
  full.findings = [];
  capture(full);
  return [...keys].sort();
}

export const reportLabelKeys = (ui: Texts['ui']): string[] =>
  Object.keys(ui)
    .filter((key) => key.startsWith('report.'))
    .sort();
