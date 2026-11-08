import type { ReporterContext } from '../core/report/reporter.ts';
import { type MessageParams, type Report, SeveritySchema } from '../core/report/schema.ts';
import { exitReasonText, phaseCState } from './disclaimer.ts';
import { type Row, reasonText } from './evidence-view.ts';
import { bannerState } from './front-page.ts';
import { item, phaseList, text, urlItem, type ViewText } from './view-text.ts';

const roundedSeconds = (ms: number): number => Math.round(ms / 100) / 10;

function summaryRows(report: Report, { label, row, rows }: ViewText, ctx: ReporterContext): Row[] {
  const scan = report.scan;
  // A known code reads as words; an unknown one is shown as it is, so the cell never repeats it.
  const exitReasons = report.summary.exitReasons.map((r) => item(exitReasonText(ctx.texts, r), 200));
  const summary: Row[] = [
    rows('summary.exitReasons', exitReasons.length ? exitReasons : [item(label('summary.none'))]),
    rows('meta.target', [urlItem(scan.target)]),
  ];

  if (scan.finalUrl) summary.push(rows('meta.finalUrl', [urlItem(scan.finalUrl)]));
  summary.push(row('meta.startedAt', scan.startedAt));
  if (typeof scan.durationMs === 'number') {
    summary.push(row('meta.duration', label('meta.seconds', { seconds: roundedSeconds(scan.durationMs) })));
  }
  if (scan.evaluatedAt) summary.push(row('meta.evaluatedAt', scan.evaluatedAt));

  if (scan.options) summary.push(row('meta.failOn', scan.options.failOn));
  if (report.ruleset) {
    const { profile, version, rechtsstand } = report.ruleset;
    summary.push(row('meta.ruleset', label('meta.rulesetValue', { profile, version, rechtsstand })));
  }

  summary.push(row('meta.version', `dsgvo-check ${text(report.tool.version, 40)}`));
  return summary;
}

function countViews(report: Report, { label }: ViewText) {
  const counts = report.summary.counts;
  if (!counts) return [];
  return [
    ...SeveritySchema.options.map((s) => ({
      label: label(`severity.${s}`),
      value: counts[s],
      severity: s,
    })),
    ...(['checkErrors', 'inconclusive', 'suppressed'] as const).map((s) => ({
      label: label(`summary.${s}`),
      value: counts[s],
      severity: '',
    })),
  ];
}

type Egress = NonNullable<Report['scan']['environment']>['egress'];

/** Reports of earlier versions hold the source as a German phrase; they read as the code it stood for. */
const LEGACY_EGRESS_SOURCES: Readonly<Record<string, string>> = {
  'nicht festgestellt': 'not-determined',
  'laut Nutzerangabe (--assume-region)': 'assume-region',
};
const EGRESS_SOURCES: ReadonlySet<string> = new Set(['not-determined', 'assume-region']);

/** The code of the egress source, or null for a value the report does not know (shown as it is). */
function egressSourceCode(source: string): string | null {
  const code = LEGACY_EGRESS_SOURCES[source] ?? source;
  return EGRESS_SOURCES.has(code) ? code : null;
}

export const regionText = (egress: Egress, label: ViewText['label']): string =>
  label('env.region', { region: egress.region, asserted: egress.assertedRegion ?? '' });

function environmentRows(report: Report, { label, row, rows }: ViewText): Row[] {
  const env = report.scan.environment;
  if (!env) return [];

  const list = (key: string, values: readonly string[]) =>
    rows(key, values.length ? values.map((v) => item(v, 200, true)) : [item('–')]);
  const browser = env.browser
    ? label('env.browserValue', {
        engine: env.browser.engine,
        version: env.browser.version ?? '–',
        channel: env.browser.channel ?? '–',
        headless: String(env.browser.headless ?? '–'),
      })
    : label('env.unavailable');
  const sandbox = label('env.sandboxValue', {
    mode: env.sandbox.mode,
    active: label(env.sandbox.active === null ? 'unknown' : env.sandbox.active ? 'yes' : 'no'),
  });
  const gaps = env.knownGaps.map((gap) => item(label('env.knownGap', { gap }), 300));
  const egress = label('env.egressValue', {
    mode: env.egress.mode,
    region: regionText(env.egress, label),
    hasSource: egressSourceCode(env.egress.source) === null,
    source: text(env.egress.source, 500),
  });

  const out: Row[] = [
    row('env.userAgentHttp', env.userAgent.http, 500),
    row('env.userAgentBrowser', env.userAgent.browser, 500),
    row('env.browser', browser),
    row('env.sandbox', sandbox),

    row('env.profile', env.profile ? label('env.profileValue', { profile: env.profile }) : null, 300),
    row('env.viewport', env.viewport ? `${env.viewport.width} × ${env.viewport.height}` : '–'),
    row('env.locale', env.locale, 40),
    row('env.timezone', env.timezone, 60),

    row('env.egress', egress),
    list('env.disabledFeatures', env.disabledChromiumFeatures),
    row('env.quic', label('env.quicValue', { quic: env.quic }), 60),
    rows('env.knownGaps', gaps.length ? gaps : [item('–')]),
    row('env.requests', label('env.requestsValue', { ...env.requestsIssued })),
  ];

  const settings = Object.entries(report.scan.options?.settings ?? {});
  if (settings.length > 0) {
    const settingItems = settings.map(([name, value]) =>
      item(`${text(name, 80)}=${text(String(value), 200)}`, 300, true),
    );
    out.push(rows('env.settings', settingItems));
  }
  const phaseC = phaseCState(report);
  if (phaseC) out.push(row('env.phaseC', label('env.phaseCValue', { state: phaseC })));

  out.push(row('env.node', env.node, 40), row('env.platform', env.platform, 60));
  return out;
}

function datasetViews(report: Report, { label }: ViewText) {
  return (report.datasets ?? []).map((d) => ({
    text: label('env.datasetValue', {
      name: text(d.name, 500),
      version: d.version ?? '–',
      license: text(d.license, 500),
    }),
    attribution: text((d as { attribution?: string }).attribution ?? '', 500),
  }));
}

type Coverage = NonNullable<Report['scan']['coverage']>;
type CheckEntry = NonNullable<Report['checks']>[number];

const reasonCell = (reason: string | undefined, v: ViewText): string =>
  reason ? text(reasonText(reason, v), 300) : '–';

function coveragePageViews(pages: Coverage['pages'], v: ViewText) {
  const { label } = v;
  return pages.map((p) => ({
    url: text(p.url),
    role: text(label('pageRole', { role: p.role }), 60),
    planned: label(p.planned ? 'yes' : 'no'),
    observed: label(p.observed ? 'yes' : 'no'),
    evaluated: label(p.evaluated ? 'yes' : 'no'),
    phases: text(phaseList(p.phases, v, true) || '–', 120),
    reason: reasonCell(p.reason, v),
  }));
}

function coverageCollectorViews(collectors: Coverage['collectors'], v: ViewText) {
  const { label } = v;
  return Object.entries(collectors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name: text(name, 40),
      status: text(label('collectorStatus', { status: c.status }), 60),
      reason: reasonCell(c.reason, v),
      duration:
        typeof c.durationMs === 'number'
          ? label('meta.seconds', { seconds: roundedSeconds(c.durationMs) })
          : '–',
    }));
}

/** The banner clicks of phases B and C; without a banner there was nothing to click, which the line says instead. */
function consentActionsText(report: Report, cov: Coverage, v: ViewText): string | null {
  const actions = cov.consentActions ?? [];
  if (actions.length === 0) return null;
  if (bannerState(report) === 'notFound' && actions.every((a) => !a.clicked)) {
    return v.label('coverage.consentActionsNoBanner');
  }
  const list = actions.map((a) =>
    v.label('coverage.consentAction', {
      action: a.action,
      clicked: a.clicked,
      verified: a.verified,
      path: a.path ?? null,
    }),
  );
  return v.label('coverage.consentActions', { actions: list.join('; ') });
}

function coverageView(report: Report, v: ViewText) {
  const cov = report.scan.coverage;
  if (!cov) return null;

  return {
    consentActions: consentActionsText(report, cov, v),
    totals: v.label('coverage.totals', {
      planned: cov.pages.filter((p) => p.planned).length,
      observed: cov.pages.filter((p) => p.observed).length,
      evaluated: cov.pages.filter((p) => p.evaluated).length,
    }),
    pages: coveragePageViews(cov.pages, v),
    requests: cov.browserRequests ? v.label('coverage.browserRequests', { ...cov.browserRequests }) : null,
    collectors: coverageCollectorViews(cov.collectors, v),
  };
}

function checkCoverageText(c: CheckEntry, { label }: ViewText): string {
  const parts: string[] = [];
  const counts = c.coverage;
  if (
    counts &&
    (counts.planned !== undefined || counts.observed !== undefined || counts.evaluated !== undefined)
  ) {
    parts.push(
      label('checkCoverage.value', {
        planned: counts.planned ?? '–',
        observed: counts.observed ?? '–',
        evaluated: counts.evaluated ?? '–',
      }),
    );
  }
  if (counts?.note)
    parts.push(text(label('checkCoverage.note', noteParams(counts.note)) || counts.note, 300));
  return parts.join(' · ') || '–';
}

/** Coverage notes are codes with numbers in them; the text words the known ones and is empty for any other note. */
function noteParams(note: string): MessageParams {
  const allowlist = /^allowlist-v([^:]+):not-evaluated=(\d+)$/.exec(note);
  if (allowlist) return { code: 'allowlist', version: allowlist[1]!, count: Number(allowlist[2]) };
  const probes = /^error-page-probes:(\d+)$/.exec(note);
  if (probes) return { code: 'error-page-probes', count: Number(probes[1]) };
  return { code: note };
}

/**
 * A limitation is a code, sometimes with a detail after the first colon (`status:429`, `document-blocked:privacy`).
 * A known code reads as words; only a code the texts do not know is shown as the code itself.
 */
function limitationView(limitation: string, { label }: ViewText): { text: string; code: string | null } {
  const colon = limitation.indexOf(':');
  const code = colon === -1 ? limitation : limitation.slice(0, colon);
  const detail = colon === -1 ? '' : limitation.slice(colon + 1);
  const words = text(label('checkLimitation', { code, detail }), 200);
  return words ? { text: words, code: null } : { text: '', code: text(limitation, 120) };
}

function checkViews(report: Report, v: ViewText) {
  return [...(report.checks ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const failure = c.error ? `${c.error.code}: ${c.error.message}` : null;
      const reason = c.reason ? reasonText(c.reason, v) : null;
      return {
        id: text(c.id, 20),
        status: text(c.status, 40),
        statusLabel: v.label(`checkStatus.${c.status}`),
        reason: text([reason, failure].filter(Boolean).join(' – ') || '–', 400),
        coverage: checkCoverageText(c, v),
        limitations: c.limitations.map((l) => limitationView(l, v)),
      };
    });
}

export function technicalView(report: Report, ctx: ReporterContext, v: ViewText) {
  return {
    summary: summaryRows(report, v, ctx),
    counts: countViews(report, v),
    environmentAvailable: !!report.scan.environment,
    environment: environmentRows(report, v),
    extra: [
      v.row('meta.version', `dsgvo-check ${text(report.tool.version, 40)}`),
      v.row('meta.schemaVersion', report.schemaVersion, 20),
    ],
    datasets: datasetViews(report, v),
    coverage: coverageView(report, v),
    checks: checkViews(report, v),
  };
}
