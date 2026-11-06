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
  const capture = (report: Report, detail: ReporterContext['detail'] = 'full') => {
    buildReportView(report, { ...context, detail });
    renderSummary(report, context);
  };

  const full = sampleFullReport();
  // The settings row only appears for settings that differ from the defaults.
  full.scan.options = { ...full.scan.options!, settings: { DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: 3000 } };
  full.findings[0]!.trigger = 'before-interaction';
  // A coverage note and a limitation are codes the view words.
  full.checks[0]!.coverage = { planned: 2, observed: 2, evaluated: 1, note: 'negation-not-parsed' };
  full.checks[0]!.limitations = ['status:429'];
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

  // Front page: a recognized banner, every timing state of an observed service and repeated requests.
  const front = sampleFullReport();
  front.checks.find((c) => c.id === 'CONSENT-04')!.status = 'completed';
  front.findings = ['loaded', 'initialised', 'event-sent', 'not-checked', 'none'].map((stage, n) => ({
    ...front.findings[0]!,
    fingerprint: `sha256:${(n + 1).toString(16).padStart(64, '0')}`,
    messageId: 'TRACK-01.service-inventory',
    params: {
      service: `S${n}`,
      stageBeforeInteraction: stage,
      stageAfterReject: stage,
      stageAfterAccept: stage,
    },
  }));
  const request = front.evidence.find((e) => e.id === 'ev-request')!;
  front.evidence = [request, { ...request, id: 'ev-request-again', page: 'https://www.example.de/kontakt' }];
  front.findings[0]!.evidenceIds = front.evidence.map((e) => e.id);
  // An accept the banner did not confirm, its click outcomes and a start page that leads to another site.
  front.scan.coverage.consentActions = [
    { action: 'reject', clicked: true, verified: true },
    { action: 'accept', clicked: true, verified: false },
  ];
  front.scan.finalUrl = 'https://www.example.com/';
  capture(front);
  capture(front, 'brief');

  // The browser checks ran on the redirect target of a refused certificate.
  const continued = sampleFullReport();
  continued.scan.finalUrl = 'https://www.example.com/';
  continued.scan.entry = {
    reason: 'tls-invalid',
    requested: continued.scan.target,
    via: 'http://www.example.de/',
    url: 'https://www.example.com/',
  };
  capture(continued, 'brief');

  // A re-evaluated snapshot, a site without a banner, and the pages and headers of one finding listed together.
  const replay = sampleFullReport();
  replay.scan.evaluatedAt = '2026-11-01T10:00:00.000Z';
  replay.checks.find((c) => c.id === 'CONSENT-04')!.status = 'not_applicable';
  replay.checks.find((c) => c.id === 'CONSENT-04')!.reason = 'no-banner';
  replay.scan.coverage.consentActions = [{ action: 'reject', clicked: false, verified: null }];
  replay.findings = replay.findings.filter((f) => f.checkId !== 'CONSENT-04');
  const listed = replay.evidence.filter((e) => e.type === 'page' || e.type === 'header');
  replay.evidence.push(...listed.map((e) => ({ ...e, id: `${e.id}-again` })));
  const document = replay.evidence.find((e) => e.type === 'document')!;
  Object.assign(document, {
    manifest: { partCount: 3, textLength: 1200, expandablesFound: 1, linkedPages: 0 },
  });
  replay.findings[0]!.evidenceIds = replay.evidence.map((e) => e.id);
  capture(replay);

  // A banner-like box the heuristic did not take, cited by its features.
  const candidate = sampleFullReport();
  const cmp = candidate.evidence.find((e) => e.type === 'cmp')!;
  Object.assign(cmp, {
    candidate: {
      reason: 'no-control',
      keywordHits: 2,
      controls: ['settings', 'other'],
      cookieWording: true,
      fixed: true,
      dialog: false,
      named: false,
    },
  });
  candidate.findings[0]!.evidenceIds = [cmp.id];
  capture(candidate);

  // More differing values in one item than it names.
  const grouped = sampleFullReport();
  grouped.findings = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, n) => ({
    ...grouped.findings[1]!,
    fingerprint: `sha256:${(n + 1).toString(16).padStart(64, '0')}`,
    params: { name },
  }));
  capture(grouped, 'brief');

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
