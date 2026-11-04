import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_DATA_DIR, type LegalNote, loadTexts, type Texts } from '../../../../src/core/data/load.ts';
import type { ReporterContext } from '../../../../src/core/report/reporter.ts';
import {
  CheckStatusSchema,
  ConfidenceSchema,
  type Report,
  ScanStatusSchema,
  SeveritySchema,
} from '../../../../src/core/report/schema.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { renderSummary } from '../../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';

const source = (file: string) => readFileSync(new URL(`../../../../src/${file}`, import.meta.url), 'utf8');

/** Keys that the template, the CLI and the writers name literally. */
function literalLabelKeys(): Set<string> {
  const keys = new Set<string>();
  const template = readFileSync(path.join(DEFAULT_DATA_DIR, 'report/report.html'), 'utf8');

  for (const match of template.matchAll(/{{t\s+"(report\.[^"]+)"/g)) keys.add(match[1]!);
  for (const file of ['cli.ts', 'reporters/write.ts', 'reporters/pdf.ts']) {
    for (const match of source(file).matchAll(/\buiText\([^,]+,\s*['"](report\.[^'"]+)['"]/g)) {
      keys.add(match[1]!);
    }
  }
  return keys;
}

/** A reporter context whose label dictionary adds every `report.*` key that gets read to `keys`. */
function recordingContext(keys: Set<string>): ReporterContext {
  const texts = loadTexts('en');
  const ui = new Proxy(texts.ui, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('report.')) keys.add(key);
      return Reflect.get(target, key, receiver);
    },
    // Draft detection enumerates the whole dictionary. Enumeration is not a use of every label.
    ownKeys: () => [],
  });
  return {
    texts: { ...texts, ui },
    lang: 'en',
    color: false,
    outDir: path.join(tmpdir(), 'report-label-key-contract'),
  };
}

/** The statuses a legal note can have, read from the schema source so that a new one is exercised automatically. */
function legalNoteStatuses(): Array<LegalNote['status']> {
  const statuses = source('core/data/load.ts').match(
    /const LegalNoteSchema = z\.object\(\{[\s\S]*?status:\s*z\.enum\(\[([\s\S]*?)\]\)/,
  )?.[1];
  if (!statuses) throw new Error('The legal-note status domain could not be read');
  return [...statuses.matchAll(/'([^']+)'/g)].map((match) => match[1] as LegalNote['status']);
}

/** Collect consumers rather than deriving the expected set from the translation dictionary itself. */
export function usedReportLabelKeys(): string[] {
  const keys = literalLabelKeys();
  const context = recordingContext(keys);
  const capture = (report: Report) => {
    buildReportView(report, context);
    renderSummary(report, context);
  };

  const full = sampleFullReport();
  // The settings row only appears for settings that differ from the defaults.
  full.scan.options = { ...full.scan.options!, settings: { DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: 3000 } };
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
  for (const status of legalNoteStatuses()) {
    context.texts.legalNotes['label-fixture'] = {
      text: 'Technical observation.',
      status,
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

  // Empty and oversized lists, and an evidence reference without evidence.
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
