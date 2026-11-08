import type { ReportDetail, ReporterContext } from '../../../../src/core/report/reporter.ts';
import type { Finding, FullReport } from '../../../../src/core/report/schema.ts';
import { sampleFullReport } from '../../../utils/report/fixtures.ts';
import { reporterContext } from '../../../utils/report/reporter-inputs.ts';

export const ctx = (detail: ReportDetail = 'full', lang: 'de' | 'en' = 'de'): ReporterContext => {
  const c = reporterContext(lang, { detail });
  c.texts.messages['TEST-01.entry'] = { title: 'Eintrag {name} gefunden', body: '{name}', draft: true };
  c.texts.actions['TEST-01.entry'] = 'Prüfen Sie den Eintrag.';
  c.texts.messages['TEST-02.counted'] = {
    title: '{kind, select, cookie {Cookie} request {Anfrage} other {Eintrag}} {name} auf {pageCount} Seiten',
    body: '{name}',
    draft: true,
  };
  c.texts.actions['TEST-02.counted'] =
    'Prüfen Sie {name} ({count} Stück, {host}){mode, select, true { sofort} other {}}.';
  return c;
};

const fp = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

// The base finding has no text of its own, so a finding without one is worded by the data texts of its message.
export const finding = (n: number, over: Partial<Finding>): Finding => ({
  ...sampleFullReport().findings[1]!,
  fingerprint: fp(n),
  evidenceIds: [],
  related: [],
  legalNoteId: null,
  ...over,
});

/** A finding of the check and variant its message id names. */
export const findingOf = (
  n: number,
  messageId: string,
  severity: Finding['severity'],
  over: Partial<Finding> = {},
): Finding => {
  const [checkId, variant] = messageId.split('.') as [string, string];
  return finding(n, { checkId, variant, messageId, severity, ...over });
};

export const entry = (n: number, name: string, page = 'https://www.example.de/'): Finding =>
  findingOf(100 + n, 'TEST-01.entry', 'info', { params: { name }, pages: [page] });

export const inventory = (n: number, service: string, stages: [string, string, string]): Finding =>
  findingOf(200 + n, 'TRACK-01.service-inventory', 'info', {
    serviceId: service.toLowerCase(),
    params: {
      service,
      stageBeforeInteraction: stages[0],
      stageAfterReject: stages[1],
      stageAfterAccept: stages[2],
    },
  });

export const RAN_WITH_OPEN_CHECKS =
  'Der Scan ist durchgelaufen, aber nicht jede Prüfung hat ein abschließendes Ergebnis.';

export function reportWith(findings: Finding[]): FullReport {
  const r = sampleFullReport();
  r.findings = findings;
  const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  r.summary.counts = {
    ...r.summary.counts!,
    critical: count('critical'),
    warning: count('warning'),
    info: count('info'),
  };
  return r;
}
