/** The first page of the report for the site owner: what was found in plain words, what to do, which services were seen. */
import { renderMessage } from '../core/data/messages.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { Finding, MessageParams, Report, Severity } from '../core/report/schema.ts';

/** Highest first: findings are listed critical before warning before info. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 3, warning: 2, info: 1 };

/** The label and text cleaning of the view the page is built for; both cap and sanitize what they return. */
export interface FrontPageTools {
  label: (key: string, params?: MessageParams) => string;
  clean: (value: unknown, max?: number) => string;
  /** Title and body of one finding as the report shows them. */
  message: (f: Finding) => { title: string; body: string };
}

export interface ActionView {
  severity: Severity;
  severityLabel: string;
  title: string;
  /** Empty when no action text exists for the message. */
  action: string;
  covers: string;
}

export interface ServiceView {
  name: string;
  beforeInteraction: string;
  afterReject: string;
  afterAccept: string;
}

/** The inventory finding of TRACK-01; its per-timing states are the table of observed services. */
const INVENTORY_MESSAGE = 'TRACK-01.service-inventory';

/** A list of actions or services stays readable; the rest is in the full report and in report.json. */
const MAX_ROWS = 50;

/** Stands where the title of a shared message would name a single entry. */
const VARIES = '…';

const BANNER_NOT_RECOGNIZED = new Set(['banner-not-recognized', 'cmp-not-supported']);

const highestSeverity = (findings: readonly Finding[]): Severity =>
  findings.reduce<Severity>(
    (best, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best),
    'info',
  );

/** Params of the group's findings that are strings and differ between them: they name single entries. */
function varyingParams(findings: readonly Finding[]): Set<string> {
  const varying = new Set<string>();
  const [first, ...rest] = findings;
  for (const [name, value] of Object.entries(first?.params ?? {})) {
    if (typeof value === 'string' && rest.some((f) => f.params[name] !== value)) varying.add(name);
  }
  return varying;
}

/** The shortest title of the group; where findings of one message name different entries, those names are left out. */
function groupTitle(findings: readonly Finding[], ctx: ReporterContext, tools: FrontPageTools): string {
  const shortest = [...findings].sort(
    (a, b) => tools.message(a).title.length - tools.message(b).title.length,
  )[0]!;
  const varying = varyingParams(findings);
  if (varying.size === 0 || !ctx.texts.messages[shortest.messageId]) return tools.message(shortest).title;

  const masked: MessageParams = { ...shortest.params };
  for (const name of varying) masked[name] = VARIES;
  return renderMessage(ctx.texts, shortest.messageId, masked).title;
}

function coverText(findings: readonly Finding[], tools: FrontPageTools): string {
  const pages = new Set(findings.flatMap((f) => f.pages)).size;
  return tools.label('actions.covers', { findings: findings.length, pages });
}

/** One entry per distinct message, the most severe first; findings that share a message are counted, not repeated. */
function actionViews(report: Report, ctx: ReporterContext, tools: FrontPageTools): ActionView[] {
  const byMessage = new Map<string, Finding[]>();
  for (const f of report.findings ?? []) {
    byMessage.set(f.messageId, [...(byMessage.get(f.messageId) ?? []), f]);
  }

  return [...byMessage.entries()]
    .map(([messageId, findings]) => ({ messageId, findings, severity: highestSeverity(findings) }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.messageId.localeCompare(b.messageId),
    )
    .slice(0, MAX_ROWS)
    .map(({ messageId, findings, severity }) => ({
      severity,
      severityLabel: tools.label(`severity.${severity}`),
      title: tools.clean(groupTitle(findings, ctx, tools), 300),
      action: ctx.texts.actions[messageId] ? tools.clean(ctx.texts.actions[messageId], 1000) : '',
      covers: coverText(findings, tools),
    }));
}

/** Label key of a state in the TRACK-01 text; anything else (no request at that timing) reads as not found. */
const STAGE_LABELS: ReadonlySet<string> = new Set(['loaded', 'initialised', 'event-sent', 'not-checked']);

function stageLabel(value: unknown, tools: FrontPageTools): string {
  return tools.label(
    `services.stage.${typeof value === 'string' && STAGE_LABELS.has(value) ? value : 'none'}`,
  );
}

function serviceViews(report: Report, tools: FrontPageTools): ServiceView[] {
  return (report.findings ?? [])
    .filter((f) => f.messageId === INVENTORY_MESSAGE)
    .map((f) => ({
      name: tools.clean(f.params.service ?? f.serviceId ?? f.subject, 200),
      beforeInteraction: stageLabel(f.params.stageBeforeInteraction, tools),
      afterReject: stageLabel(f.params.stageAfterReject, tools),
      afterAccept: stageLabel(f.params.stageAfterAccept, tools),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS);
}

/** Banner state when the report knows it: not recognized (a finding says so), recognized (CONSENT-04 evaluated), else unknown. */
function bannerState(report: Report): 'recognized' | 'notRecognized' | null {
  const notRecognized = (report.findings ?? []).some(
    (f) => f.checkId === 'CONSENT-04' && BANNER_NOT_RECOGNIZED.has(f.variant),
  );
  if (notRecognized) return 'notRecognized';
  const evaluated = (report.checks ?? []).some((c) => c.id === 'CONSENT-04' && c.status === 'completed');
  return evaluated ? 'recognized' : null;
}

/** Two or three plain sentences built from the counts, the scan status and the banner state. */
function overviewSentences(report: Report, tools: FrontPageTools): string[] {
  const counts = report.summary.counts;
  const status = report.scan.status;
  const sentences: string[] = [];

  if (status === 'failed') {
    sentences.push(tools.label('overview.failed'));
    return sentences;
  }

  if (counts) {
    sentences.push(
      tools.label('overview.points', {
        critical: counts.critical,
        warning: counts.warning,
        info: counts.info,
      }),
    );
  }
  sentences.push(tools.label(`overview.scan.${status}`));

  const banner = bannerState(report);
  if (banner) sentences.push(tools.label(`overview.banner.${banner}`));
  return sentences;
}

export function buildFrontPage(report: Report, ctx: ReporterContext, tools: FrontPageTools) {
  return {
    overview: overviewSentences(report, tools),
    actions: actionViews(report, ctx, tools),
    services: serviceViews(report, tools),
  };
}
