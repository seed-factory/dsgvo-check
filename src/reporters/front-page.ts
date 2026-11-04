/** The first page of the report for the site owner: what was found in plain words, what to do, which services were seen. */
import { formatMessage, renderMessage } from '../core/data/messages.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { Finding, MessageParams, Report, Severity } from '../core/report/schema.ts';
import { registrableDomain } from '../core/url/url.ts';
import { phaseCState } from './disclaimer.ts';
import { reasonText } from './evidence-view.ts';

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

/** The inventory finding of TRACK-01; its per-timing states are the table of observed services, not a to-do. */
const INVENTORY_MESSAGE = 'TRACK-01.service-inventory';

/** A list of actions or services stays readable; the rest is in the full report and in report.json. */
const MAX_ROWS = 50;

/** A grouped item names this many differing values; the others are counted ("und 3 weitere"). */
const MAX_LISTED_VALUES = 5;

/**
 * At the same severity, what the browser saw on the pages (consent, tracking, privacy policy) comes before transport
 * security and before the mail settings of the domain.
 */
const MODULE_ORDER: readonly string[] = ['browser', 'http', 'dns'];

type ParamValue = MessageParams[string];

const highestSeverity = (findings: readonly Finding[]): Severity =>
  findings.reduce<Severity>(
    (best, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best),
    'info',
  );

const distinctPages = (findings: readonly Finding[]): number =>
  new Set(findings.flatMap((f) => f.pages)).size;

/** Distinct values in a stable order, the first ones named and the rest counted. */
function listOf(values: readonly ParamValue[], more: (count: number) => string): string | null {
  const distinct = [...new Set(values.filter((v) => v !== null).map(String))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (distinct.length === 0) return null;
  const named = distinct.slice(0, MAX_LISTED_VALUES).join(', ');
  const rest = distinct.length - MAX_LISTED_VALUES;
  return rest > 0 ? `${named} ${more(rest)}` : named;
}

/**
 * Params of one item for all findings of a message: a value every finding shares stays as it is, differing numbers
 * add up, other differing values become their list. Findings of one message often cover the same pages, so
 * `pageCount` is the number of distinct pages of the item instead of a sum.
 */
export function aggregateParams(
  findings: readonly Finding[],
  more: (count: number) => string,
): MessageParams {
  if (findings.length === 1) return { ...findings[0]!.params };

  const out: MessageParams = {};
  for (const name of new Set(findings.flatMap((f) => Object.keys(f.params)))) {
    const values = findings.flatMap((f) => (f.params[name] === undefined ? [] : [f.params[name]!]));
    const first = values[0] as ParamValue;
    const numbers = values.every((v) => typeof v === 'number') ? (values as number[]) : null;
    if (name === 'pageCount' && numbers) out[name] = Math.max(distinctPages(findings), ...numbers);
    else if (values.every((v) => v === first)) out[name] = first;
    else if (numbers) out[name] = numbers.reduce((n, v) => n + v, 0);
    else out[name] = listOf(values, more);
  }
  return out;
}

/** The title of an item: the message rendered with the item's params, or the shortest title without a text entry. */
function itemTitle(
  messageId: string,
  findings: readonly Finding[],
  params: MessageParams,
  ctx: ReporterContext,
  tools: FrontPageTools,
): string {
  if (findings.length > 1 && ctx.texts.messages[messageId]) {
    return renderMessage(ctx.texts, messageId, params).title;
  }
  const titles = findings.map((f) => tools.message(f).title);
  return titles.sort((a, b) => a.length - b.length)[0]!;
}

function coverText(findings: readonly Finding[], tools: FrontPageTools): string {
  return tools.label('actions.covers', { findings: findings.length, pages: distinctPages(findings) });
}

interface Item {
  messageId: string;
  findings: Finding[];
  severity: Severity;
  module: number;
  pages: number;
}

/** Severity first; then the module of the check, the pages and the findings an item covers. */
function byImportance(a: Item, b: Item): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.module - b.module ||
    b.pages - a.pages ||
    b.findings.length - a.findings.length ||
    a.messageId.localeCompare(b.messageId)
  );
}

/** Findings that share a message form one item: they are counted, not repeated. */
function actionItems(report: Report): Item[] {
  const byMessage = new Map<string, Finding[]>();
  for (const f of report.findings ?? []) {
    if (f.messageId === INVENTORY_MESSAGE) continue;
    byMessage.set(f.messageId, [...(byMessage.get(f.messageId) ?? []), f]);
  }

  const moduleOf = new Map((report.checks ?? []).map((c) => [c.id, c.module ?? '']));
  const rank = (checkId: string) => {
    const index = MODULE_ORDER.indexOf(moduleOf.get(checkId) ?? '');
    return index === -1 ? MODULE_ORDER.length : index;
  };
  return [...byMessage.entries()]
    .map(([messageId, findings]) => ({
      messageId,
      findings,
      severity: highestSeverity(findings),
      module: rank(findings[0]!.checkId),
      pages: distinctPages(findings),
    }))
    .sort(byImportance);
}

function actionViews(items: readonly Item[], ctx: ReporterContext, tools: FrontPageTools): ActionView[] {
  const more = (count: number) => tools.label('list.more', { count });
  return items.map(({ messageId, findings, severity }) => {
    const params = aggregateParams(findings, more);
    const template = ctx.texts.actions[messageId];
    return {
      severity,
      severityLabel: tools.label(`severity.${severity}`),
      title: tools.clean(itemTitle(messageId, findings, params, ctx, tools), 300),
      action: template ? tools.clean(formatMessage(template, params, ctx.lang), 1000) : '',
      covers: coverText(findings, tools),
    };
  });
}

/** Label key of a state in the TRACK-01 text; anything else (no request at that timing) reads as not found. */
const STAGE_LABELS: ReadonlySet<string> = new Set(['loaded', 'initialised', 'event-sent', 'not-checked']);

const stageKey = (value: unknown): string =>
  typeof value === 'string' && STAGE_LABELS.has(value) ? value : 'none';

function serviceRows(report: Report): Finding[] {
  return (report.findings ?? []).filter((f) => f.messageId === INVENTORY_MESSAGE);
}

function serviceViews(rows: readonly Finding[], tools: FrontPageTools): ServiceView[] {
  const stage = (value: unknown) => tools.label(`services.stage.${stageKey(value)}`);
  return rows
    .map((f) => ({
      name: tools.clean(f.params.service ?? f.serviceId ?? f.subject, 200),
      beforeInteraction: stage(f.params.stageBeforeInteraction),
      afterReject: stage(f.params.stageAfterReject),
      afterAccept: stage(f.params.stageAfterAccept),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS);
}

export type BannerState = 'recognized' | 'notRecognized' | 'notFound' | 'notVisible';

/** CONSENT-04 variants of a banner that no adapter or heuristic could attribute. */
const NOT_RECOGNIZED: ReadonlySet<string> = new Set(['banner-not-recognized', 'cmp-not-supported']);

/** Reasons of an inconclusive check that the banner sentence already explains. */
const BANNER_REASONS: ReadonlySet<string> = new Set([...NOT_RECOGNIZED, 'first-layer-not-visible']);

/** Banner state when the report knows it: not recognized (a finding says so), else from the outcome of CONSENT-04. */
export function bannerState(report: Report): BannerState | null {
  const notRecognized = (report.findings ?? []).some(
    (f) => f.checkId === 'CONSENT-04' && NOT_RECOGNIZED.has(f.variant),
  );
  if (notRecognized) return 'notRecognized';

  const check = (report.checks ?? []).find((c) => c.id === 'CONSENT-04');
  if (check?.status === 'completed') return 'recognized';
  if (check?.status === 'not_applicable' && check.reason === 'no-banner') return 'notFound';
  if (check?.status === 'inconclusive' && check.reason === 'first-layer-not-visible') return 'notVisible';
  return null;
}

type CheckEntry = NonNullable<Report['checks']>[number];

/** Why a check gave no conclusive result, in the groups the overview names; null for checks with a result. */
const OPEN_CAUSES = ['tls-blocked', 'geo', 'bot', 'reject', 'timeout', 'error', 'other'] as const;
type OpenCause = (typeof OPEN_CAUSES)[number];

const INCONCLUSIVE_CAUSES: Readonly<Record<string, OpenCause>> = {
  geo: 'geo',
  'bot-mode': 'bot',
  'no-reject-click': 'reject',
  'reject-not-confirmed': 'reject',
};

/**
 * An inconclusive check that still reported findings was evaluated in part: its findings hold, only the rest of the
 * check is open. A banner that was not recognised is a finding of its own, which the banner sentence explains.
 */
const partlyEvaluated = (c: CheckEntry, report: Report): boolean =>
  c.status === 'inconclusive' &&
  openCause(c) !== 'banner' &&
  (report.findings ?? []).some((f) => f.checkId === c.id);

function openCause(c: CheckEntry): OpenCause | 'banner' | null {
  const reason = c.reason ?? '';
  switch (c.status) {
    case 'skipped':
      // Checks left out with --checks were not asked for.
      if (reason === 'not-selected') return null;
      return reason === 'tls-blocked' ? 'tls-blocked' : 'other';
    case 'inconclusive':
      if (BANNER_REASONS.has(reason)) return 'banner';
      return INCONCLUSIVE_CAUSES[reason] ?? 'other';
    case 'error':
      return reason === 'timeout' ? 'timeout' : 'error';
    default:
      return null;
  }
}

/** Checks without a conclusive result that the overview names; checks evaluated in part are named on their own. */
const openChecks = (report: Report): CheckEntry[] =>
  (report.checks ?? []).filter((c) => openCause(c) !== null && !partlyEvaluated(c, report));

/** Why a check is open, in words; the counts of evaluated pages where the check has them. */
function reasonOf(c: CheckEntry, tools: FrontPageTools): string {
  const reason = c.reason ? reasonText(c.reason, tools) : '';
  const { observed, evaluated } = c.coverage ?? {};
  if (typeof observed !== 'number' || typeof evaluated !== 'number' || evaluated >= observed) return reason;
  return tools.label('overview.pagesEvaluated', { reason, evaluated, observed });
}

/**
 * One sentence per cause, naming the checks without a conclusive result. A banner that was not recognised, not shown
 * or not found already explains why its checks and the reject stay open; the banner sentence says so instead.
 */
function openSentences(
  checks: readonly CheckEntry[],
  banner: BannerState | null,
  tools: FrontPageTools,
): string[] {
  const bannerExplains = banner !== null && banner !== 'recognized';
  const byCause = new Map<OpenCause, CheckEntry[]>();
  for (const c of checks) {
    const found = openCause(c);
    if (!found || (bannerExplains && (found === 'banner' || found === 'reject'))) continue;
    const cause = found === 'banner' ? 'other' : found;
    byCause.set(cause, [...(byCause.get(cause) ?? []), c]);
  }
  return OPEN_CAUSES.flatMap((cause) => {
    const open = byCause.get(cause);
    if (!open) return [];
    const sorted = [...open].sort((a, b) => a.id.localeCompare(b.id));
    const reasons = [...new Set(sorted.map((c) => reasonOf(c, tools)).filter(Boolean))].join('; ');
    return [
      tools.label('overview.open', {
        count: sorted.length,
        checks: sorted.map((c) => c.id).join(', '),
        cause,
        hasReasons: reasons !== '',
        reasons,
      }),
    ];
  });
}

/**
 * Checks evaluated in part, in one sentence: why the rest is open and that the findings shown hold. They are named by
 * the titles of their items, which the owner sees in the list below, not by their ids.
 */
function partlySentence(
  report: Report,
  titles: ReadonlyMap<string, string[]>,
  tools: FrontPageTools,
): string[] {
  const partly = (report.checks ?? [])
    .filter((c) => partlyEvaluated(c, report))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (partly.length === 0) return [];
  const reasons = [...new Set(partly.map((c) => reasonOf(c, tools)).filter(Boolean))].join('; ');
  const named = partly.flatMap((c) => titles.get(c.id) ?? []);
  return [
    tools.label('overview.partly', {
      count: partly.length,
      hasReasons: reasons !== '',
      reasons,
      titles: named.join('; '),
    }),
  ];
}

const hostOf = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The start page ends up on another site: the scan covers that site only as far as the start pages go. */
function redirectedHost(report: Report): string | null {
  const from = hostOf(report.scan.target);
  const to = hostOf(report.scan.finalUrl);
  if (!from || !to || from === to) return null;
  const site = (host: string) => registrableDomain(host) ?? host;
  return site(from) === site(to) ? null : to;
}

/** The counts, the scan status, checks without a result, the banner, the region and a redirect to another site. */
function overviewSentences(
  report: Report,
  items: readonly Item[],
  titles: ReadonlyMap<string, string[]>,
  tools: FrontPageTools,
): string[] {
  const counts = report.summary.counts;
  const status = report.scan.status;
  if (status === 'failed') return [tools.label('overview.failed')];

  const sentences: string[] = [];
  if (counts) {
    const grouped = items.some((i) => i.findings.length > 1);
    sentences.push(
      tools.label('overview.findings', {
        critical: counts.critical,
        warning: counts.warning,
        info: counts.info,
        items: grouped ? Math.min(items.length, MAX_ROWS) : 0,
      }),
    );
  }

  const banner = bannerState(report);
  const open = openChecks(report);
  const partly = partlySentence(report, titles, tools);
  const state =
    status === 'partial' ? 'partial' : open.length > 0 ? 'gaps' : partly.length > 0 ? 'ran' : 'complete';
  sentences.push(tools.label('overview.scan', { state }), ...openSentences(open, banner, tools), ...partly);

  if (banner) sentences.push(tools.label('overview.banner', { state: banner }));

  const consentFindings = (report.findings ?? []).some((f) => f.checkId.startsWith('CONSENT-'));
  if (report.scan.environment?.egress.region === 'unknown' && consentFindings) {
    sentences.push(tools.label('overview.region'));
  }

  const redirected = redirectedHost(report);
  if (redirected) sentences.push(tools.label('overview.redirect', { host: redirected }));
  return sentences;
}

/** Checks whose results the table of observed services rests on. */
const SERVICE_CHECKS = /^(CONSENT|TRACK)-/;

/** The caveats of the overview that concern the table, the accept that was not confirmed and the "not checked" note. */
function serviceNotes(report: Report, rows: readonly Finding[], tools: FrontPageTools): string[] {
  if (rows.length === 0) return [];
  const banner = bannerState(report);
  const checks = (report.checks ?? []).filter((c) => SERVICE_CHECKS.test(c.id));

  // A check evaluated in part concerns its own findings, which the overview names; the table does not rest on it.
  const notes = openSentences(
    checks.filter((c) => !partlyEvaluated(c, report)),
    banner,
    tools,
  );
  if (banner && banner !== 'recognized') notes.push(tools.label('overview.banner', { state: banner }));
  if (phaseCState(report) === 'unverified') notes.push(tools.label('services.acceptUnverified'));

  const stages = rows.flatMap((f) => [
    f.params.stageBeforeInteraction,
    f.params.stageAfterReject,
    f.params.stageAfterAccept,
  ]);
  if (stages.some((s) => stageKey(s) === 'not-checked')) notes.push(tools.label('services.note'));
  return notes;
}

/** Titles of the to-do items by the check of their findings. */
function titlesByCheck(items: readonly Item[], actions: readonly ActionView[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  items.forEach((item, i) => {
    const check = item.findings[0]!.checkId;
    out.set(check, [...(out.get(check) ?? []), actions[i]!.title]);
  });
  return out;
}

export function buildFrontPage(report: Report, ctx: ReporterContext, tools: FrontPageTools) {
  const items = actionItems(report);
  const rows = serviceRows(report);
  const actions = actionViews(items, ctx, tools);
  return {
    overview: overviewSentences(report, items, titlesByCheck(items, actions), tools),
    actions: actions.slice(0, MAX_ROWS),
    services: serviceViews(rows, tools),
    serviceNotes: serviceNotes(report, rows, tools),
  };
}
