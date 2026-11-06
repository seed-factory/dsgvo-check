/** Presentation data selected from a report; it contains text and checked local images, never markup. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { reporterLimits } from '../core/config/limits.ts';
import { formatMessage, renderMessage, uiText } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import {
  type Evidence,
  type Finding,
  type MessageParams,
  type Report,
  SeveritySchema,
} from '../core/report/schema.ts';
import { exitReasonText, phaseCState } from './disclaimer.ts';
import {
  type EvidenceTools,
  type EvidenceView,
  evidenceView,
  evidenceViews,
  type Item,
  MAX_LIST_ITEMS,
  type Row,
  reasonText,
} from './evidence-view.ts';
import { bannerState, buildFrontPage, SEVERITY_RANK } from './front-page.ts';
import { noticeGroups } from './notice-view.ts';

export { SEVERITY_RANK };

/** Evidence fields that carry values of cookies, storage or consent strings; the report shows names, never values. */
const SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  cookie: ['value', 'valueSha256', 'valueHash', 'hash'],
  storage: ['value', 'valueSha256', 'valueHash', 'hash'],
  'consent-state': ['tcString', 'value'],
  cmp: ['tcString'],
};

/** Hidden for every evidence type: internal ids, the discriminator and anything that could hold a TC-String or crmCode. */
const ALWAYS_HIDDEN = new Set(['id', 'type', 'tcString', 'tcstring', 'crmCode']);

const hiddenFields = (ev: Evidence): ReadonlySet<string> =>
  new Set([...ALWAYS_HIDDEN, ...(SECRET_FIELDS[ev.type] ?? [])]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ReportLabelKey = string;

export function reportLabel(ctx: ReporterContext, key: ReportLabelKey, params: MessageParams = {}): string {
  const entry = ctx.texts.ui[`report.${key}`];
  if (!entry) throw new Error(`Unknown report label: ${key}`);
  return formatMessage(entry.text, params, ctx.lang);
}

export function isDraftReport(report: Report, ctx: ReporterContext): boolean {
  return (
    report.disclaimer.draft ||
    Object.values(ctx.texts.ui).some((u) => u.draft) ||
    Object.values(ctx.texts.messages).some((m) => m.draft)
  );
}

export function draftStamp(ctx: ReporterContext): string {
  return uiText(ctx.texts, 'console.draftStamp');
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.checkId.localeCompare(b.checkId) ||
      a.variant.localeCompare(b.variant) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
}

export function findingText(f: Finding, ctx: ReporterContext): { title: string; body: string } {
  if (ctx.texts.messages[f.messageId]) return renderMessage(ctx.texts, f.messageId, f.params);
  return f.text
    ? { title: f.text.title, body: f.text.body }
    : renderMessage(ctx.texts, f.messageId, f.params);
}

export function failedChecks(report: Report): string[] {
  return (report.checks ?? []).filter((c) => c.status === 'error').map((c) => c.id);
}

interface Group {
  key: string;
  serviceId: string | null;
  findings: Finding[];
}

export function groupByService(findings: readonly Finding[]): Group[] {
  const groups = new Map<string, Group>();
  for (const f of sortFindings(findings)) {
    const key = f.serviceId ? `s:${f.serviceId}` : 'other';
    const group: Group = groups.get(key) ?? { key, serviceId: f.serviceId ?? null, findings: [] };
    group.findings.push(f);
    groups.set(key, group);
  }

  // Service groups come first, the most severe on top; findings without a service go last.
  const topSeverity = (g: Group) => Math.max(...g.findings.map((f) => SEVERITY_RANK[f.severity]));
  return [...groups.values()].sort((a, b) => {
    if ((a.serviceId === null) !== (b.serviceId === null)) return a.serviceId === null ? 1 : -1;
    return topSeverity(b) - topSeverity(a) || (a.serviceId ?? '').localeCompare(b.serviceId ?? '');
  });
}

type ScreenshotResult = { ok: true; dataUri: string } | { ok: false; reason: string };

function imageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

type FileRead = { ok: true; data: Buffer } | { ok: false; reason: string };

/** Resolves symlinks first, so a link inside the artifacts directory cannot lead out of it. */
function readInsideDir(base: string, file: string, maxBytes: number): FileRead {
  try {
    const realBase = realpathSync(base);
    const realFile = realpathSync(file);
    if (!realFile.startsWith(realBase + path.sep)) return { ok: false, reason: 'path' };

    const stat = statSync(realFile);
    if (!stat.isFile()) return { ok: false, reason: 'missing' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };

    return { ok: true, data: readFileSync(realFile) };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

/** Canonical paths, file size, magic bytes and checksum protect the only embedded resource. */
export function loadScreenshot(
  outDir: string,
  relPath: string,
  sha256: string,
  maxBytes: number = reporterLimits().screenshotEmbedMaxBytes,
): ScreenshotResult {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return { ok: false, reason: 'path' };
  const base = path.resolve(outDir, 'artifacts');
  const file = path.resolve(outDir, relPath);
  if (!file.startsWith(base + path.sep)) return { ok: false, reason: 'path' };

  const read = readInsideDir(base, file, maxBytes);
  if (!read.ok) return read;

  const expectedSha256 = sha256.toLowerCase().replace(/^sha256:/, '');
  if (createHash('sha256').update(read.data).digest('hex') !== expectedSha256) {
    return { ok: false, reason: 'checksum' };
  }

  const mime = imageMime(read.data);
  return mime
    ? { ok: true, dataUri: `data:${mime};base64,${read.data.toString('base64')}` }
    : { ok: false, reason: 'format' };
}

const text = (value: unknown, max = 2000): string =>
  value === null || value === undefined ? '–' : sanitizeExternal(String(value), max);

const item = (value: unknown, max = 2000, code = false): Item => ({
  text: text(value, max),
  code,
  url: false,
  href: null,
});
const urlItem = (value: unknown): Item => ({ ...item(value), url: true });
const anchorOf = (f: Finding) =>
  `f-${f.fingerprint
    .replace(/^sha256:/, '')
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 16)}`;

/** Label and row builders of one view: a label and its string parameters are cleaned and length-capped on the way in. */
interface ViewText {
  label: (key: string, params?: MessageParams) => string;
  row: (key: string, value: unknown, max?: number) => Row;
  rows: (key: string, values: Item[]) => Row;
  /**
   * A phase with what happened in it (B after a reject, or a visit without one); `B:before-click` names the first screen
   * of B or C before its click; `short` for table cells.
   */
  phase: (phase: string, short?: boolean) => string;
}

type PhaseOutcome = 'done' | 'unverified' | 'not-clicked' | '';

/**
 * What the click of phase B (reject) and C (accept) did on the start page. A phase without a click is a further visit
 * and must not read as "after reject"; reports of earlier versions carry no click outcome and keep the plain label.
 */
function phaseOutcomes(report: Report): Record<string, PhaseOutcome> {
  const actions = report.scan.coverage?.consentActions;
  const outcome = (action: 'reject' | 'accept'): PhaseOutcome => {
    const a = actions?.find((x) => x.action === action);
    if (!a) return '';
    if (!a.clicked) return 'not-clicked';
    return a.verified === false ? 'unverified' : 'done';
  };
  return { B: outcome('reject'), C: outcome('accept') };
}

function viewText(report: Report, ctx: ReporterContext): ViewText {
  const label = (key: string, params: MessageParams = {}) => {
    const clean: MessageParams = {};
    for (const [name, value] of Object.entries(params)) {
      clean[name] = typeof value === 'string' ? sanitizeExternal(value, 500) : value;
    }
    return sanitizeExternal(reportLabel(ctx, key, clean), 4000);
  };
  const outcomes = phaseOutcomes(report);
  return {
    label,
    row: (key, value, max = 2000) => ({ label: label(key), items: [item(value, max)] }),
    rows: (key, values) => ({ label: label(key), items: values }),
    phase: (key, short = false) => {
      const [phase = key, moment] = key.split(':');
      const outcome = moment === 'before-click' ? 'before-click' : (outcomes[phase] ?? '');
      return label(short ? 'phaseShort' : 'phase', { phase, outcome });
    },
  };
}

/** The evidence view works with the cleaned labels and items of this view. */
function evidenceTools(v: ViewText, ctx: ReporterContext): EvidenceTools {
  return {
    label: v.label,
    item,
    urlItem,
    phase: (p) => v.phase(p),
    screenshot: (ev) => screenshotView(ev, v, ctx),
    hidden: hiddenFields,
  };
}

function screenshotView(ev: Evidence, { label }: ViewText, ctx: ReporterContext): EvidenceView['screenshot'] {
  if (ev.type !== 'screenshot') return null;

  const shotEv = ev as Extract<Evidence, { type: 'screenshot' }>;
  const shot = loadScreenshot(ctx.outDir, shotEv.path, shotEv.sha256, ctx.limits?.screenshotEmbedMaxBytes);
  return {
    dataUri: shot.ok ? shot.dataUri : null,
    missing: shot.ok
      ? null
      : label('screenshot.missing', { reason: shot.reason, path: text(shotEv.path, 500) }),
    path: text(shotEv.path),
  };
}

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

const partyText = (party: { name: unknown; country: unknown }): string =>
  `${text(party.name, 200)} (${text(party.country, 8)})`;

/** Related findings name their title and link to their anchor when the other finding is part of the report. */
function relatedItems(
  related: Finding['related'],
  byFingerprint: ReadonlyMap<string, Finding>,
  { label }: ViewText,
  ctx: ReporterContext,
): Item[] {
  return related.map((r) => {
    const target = byFingerprint.get(r.fingerprint);
    const value = label('finding.relatedValue', {
      check: r.checkId,
      hasTitle: Boolean(target),
      title: target ? text(findingText(target, ctx).title, 200) : '',
      relation: r.relation ?? 'related',
    });
    return { ...item(value, 400), href: target ? anchorOf(target) : null };
  });
}

/** Phases in their order, each with what happened in it (A before any interaction, B after reject, C after accept). */
const phaseList = (phases: readonly string[], v: ViewText, short = false): string =>
  [...new Set(phases)]
    .sort((a, b) => a.localeCompare(b))
    .map((phase) => v.phase(phase, short))
    .join(', ');

/**
 * The phases of a finding; B or C as `B:before-click` when all its evidence of that phase was recorded before the click
 * (a finding before an interaction that phase B confirmed on its first screen).
 */
function findingPhases(f: Finding, evidence: ReadonlyMap<string, Evidence>): string[] {
  const cited = f.evidenceIds.flatMap((id) => evidence.get(id) ?? []);
  return f.phases.map((phase) => {
    const own = cited.filter((e) => e.phase === phase);
    return phase !== 'A' && own.length > 0 && own.every((e) => e.beforeClick === true)
      ? `${phase}:before-click`
      : phase;
  });
}

/** The detail rows under a finding; optional facts of the finding add a row each. */
function findingRows(f: Finding, v: ViewText, ctx: ReporterContext, sources: FindingSources) {
  const { label, row, rows } = v;
  const out: Row[] = [row('finding.confidence', label(`confidence.${f.confidence}`))];

  if (f.pages.length) out.push(rows('finding.pages', f.pages.slice(0, MAX_LIST_ITEMS).map(urlItem)));
  if (f.phases.length) out.push(row('finding.phases', phaseList(findingPhases(f, sources.evidence), v), 400));
  if (f.trigger) out.push(row('finding.trigger', f.trigger, 200));
  if (typeof f.replicated === 'boolean') {
    out.push(row('finding.replicated', label(f.replicated ? 'yes' : 'no')));
  }

  if (f.provider) out.push(row('finding.provider', partyText(f.provider)));
  if (f.parent) out.push(row('finding.parent', partyText(f.parent)));
  if (f.dpfEntity) {
    const { name, listed, checkedAt } = f.dpfEntity;
    const dpfValue = label('finding.dpfValue', {
      name: text(name, 500),
      listed: listed === null ? 'unknown' : String(listed),
      hasDate: Boolean(checkedAt),
      checkedAt: checkedAt ?? '',
    });
    out.push(row('finding.dpf', dpfValue));
  }

  const { source, datasetVersion } = f.classification;
  const adapter = /^adapter:(.+)$/.exec(source);
  const classification = label('finding.classificationValue', {
    source: adapter ? 'adapter' : text(source, 80),
    cmp: adapter ? text(adapter[1], 80) : '',
    hasVersion: Boolean(datasetVersion),
    version: datasetVersion ? text(datasetVersion, 40) : '',
  });
  out.push(row('finding.classification', classification));

  if (f.related.length)
    out.push(rows('finding.related', relatedItems(f.related, sources.byFingerprint, v, ctx)));
  out.push(rows('finding.fingerprint', [item(f.fingerprint, 80, true)]));
  return out;
}

function legalNoteView(f: Finding, { label }: ViewText, ctx: ReporterContext) {
  const note = f.legalNoteId ? ctx.texts.legalNotes[f.legalNoteId] : null;
  if (!note) return null;
  return {
    text: text(note.text, 4000),
    meta: [
      label('finding.legalStatus', { status: label(`legal.${note.status}`) }),
      ...(note.draft ? [label('finding.legalUnreviewed')] : []),
      ...(note.reviewedAt ? [text(note.reviewedAt, 40)] : []),
    ].join(' · '),
  };
}

const distinctIds = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The evidence of a finding is capped; where the finding counts its requests, the view says how many were seen. */
function evidenceSample(
  f: Finding,
  evidence: ReadonlyMap<string, Evidence>,
  { label }: ViewText,
): string | null {
  const total = f.params.requestCount;
  if (typeof total !== 'number') return null;
  const shown = distinctIds(f.evidenceIds).filter((id) => evidence.get(id)?.type === 'request').length;
  return total > shown ? label('finding.evidenceSample', { shown, total }) : null;
}

interface FindingSources {
  evidence: ReadonlyMap<string, Evidence>;
  byFingerprint: ReadonlyMap<string, Finding>;
  /** Legal notes already shown: a note is printed once, under the first finding that cites it. */
  shownNotes: Set<string>;
}

function findingView(f: Finding, v: ViewText, ctx: ReporterContext, sources: FindingSources) {
  const missing = (id: string) => v.label('finding.evidenceMissing', { id: text(id, 500) });
  const evs = evidenceViews(f.evidenceIds, sources.evidence, evidenceTools(v, ctx), missing);
  const message = findingText(f, ctx);
  const firstOfNote = f.legalNoteId !== null && !sources.shownNotes.has(f.legalNoteId);
  if (f.legalNoteId !== null) sources.shownNotes.add(f.legalNoteId);
  return {
    anchor: anchorOf(f),
    severity: f.severity,
    severityLabel: v.label(`severity.${f.severity}`),
    checkId: text(f.checkId, 20),
    title: text(message.title, 300),
    body: text(message.body, 4000),
    rows: findingRows(f, v, ctx, sources),
    evidence: evs,
    evidenceCount: distinctIds(f.evidenceIds).length,
    evidenceSample: evidenceSample(f, sources.evidence, v),
    evidenceTruncated: !!f.evidenceTruncated,
    legalNote: firstOfNote ? legalNoteView(f, v, ctx) : null,
  };
}

/** The name of the service as the findings give it; the catalog id where none does. */
function serviceName(group: Group): string {
  const named = group.findings.find((f) => typeof f.params.service === 'string' && f.params.service);
  return text(named?.params.service ?? group.serviceId, 500);
}

function findingGroups(report: Report, v: ViewText, ctx: ReporterContext) {
  const findings = report.findings ?? [];
  const sources: FindingSources = {
    evidence: new Map((report.evidence ?? []).map((ev) => [ev.id, ev])),
    byFingerprint: new Map(findings.map((f) => [f.fingerprint, f])),
    shownNotes: new Set(),
  };
  return groupByService(findings).map((group) => ({
    title: group.serviceId
      ? v.label('findings.groupService', { service: serviceName(group) })
      : v.label('findings.groupOther'),
    findings: group.findings.map((f) => findingView(f, v, ctx, sources)),
  }));
}

/** Screenshots no finding refers to; shown only when there are findings at all. */
function unreferencedScreenshots(report: Report, v: ViewText, ctx: ReporterContext): EvidenceView[] {
  const findings = report.findings ?? [];
  if (!findings.length) return [];
  const referenced = new Set(findings.flatMap((f) => f.evidenceIds));
  const tools = evidenceTools(v, ctx);
  return (report.evidence ?? [])
    .filter((ev) => ev.type === 'screenshot' && !referenced.has(ev.id))
    .map((ev) => evidenceView(ev, tools));
}

function diagnosticViews(report: Report, ctx: ReporterContext) {
  return (report.diagnostics ?? []).map((d) => {
    const message = renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, d.params ?? {});
    return {
      code: text(d.code, 40),
      title: text(message.title, 300),
      body: text(message.body, 2000),
      affects: d.affects.map((a) => text(a, 20)),
    };
  });
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

/** The region of the network egress in words: not determined, or the region the user asserted. */
const regionText = (egress: Egress, label: ViewText['label']): string =>
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

/** A reason code in words, or `–` when there is none. */
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

/** Planned/observed/evaluated counts plus the free-text note of one check, joined into one cell. */
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

/** What only the full report shows: findings with their evidence and every technical table. */
function fullSections(report: Report, ctx: ReporterContext, v: ViewText) {
  const scan = report.scan;
  return {
    groups: findingGroups(report, v, ctx),
    otherShots: unreferencedScreenshots(report, v, ctx),
    diagnostics: diagnosticViews(report, ctx),

    summary: summaryRows(report, v, ctx),
    counts: countViews(report, v),

    environmentAvailable: !!scan.environment,
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

/** Only selected presentation fields enter the view; report objects and crmCode are never copied. */
export function buildReportView(report: Report, ctx: ReporterContext) {
  const v = viewText(report, ctx);
  const { label } = v;
  const scan = report.scan;
  const errors = failedChecks(report);
  const full = (ctx.detail ?? 'full') === 'full';
  const front = buildFrontPage(report, ctx, {
    label,
    clean: text,
    message: (f) => findingText(f, ctx),
  });

  const env = scan.environment;
  return {
    screenshotAlt: label('screenshot.alt'),
    lang: ctx.lang === 'en' ? 'en' : 'de',
    target: text(scan.target),
    titleTarget: text(scan.target, 200),
    // The disclaimer speaks of "the stated time": the first lines of both reports state it, with the region.
    scanMeta: label('doc.scanMeta', {
      date: text(scan.startedAt, 40).slice(0, 16).replace('T', ' '),
      hasRegion: Boolean(env),
      region: env ? regionText(env.egress, label) : '',
    }),
    version: text(report.tool.version, 40),
    draft: isDraftReport(report, ctx),
    draftStamp: text(draftStamp(ctx), 60),

    full,
    frontClass: full ? 'front-full' : 'front-brief',
    exitCode: report.summary.exitCode,
    status: scan.status,
    statusLabel: label(`status.${scan.status}`),
    failure: scan.failure
      ? label('summary.failure', {
          message: text(scan.failure.message, 500),
          code: text(scan.failure.code, 500),
        })
      : null,
    sandboxOff: scan.environment?.sandbox.mode === 'off',
    checkErrors:
      report.summary.exitCode === 1 && errors.length
        ? label('summary.checkErrorsWithThreshold', { checks: errors.join(', ') })
        : null,

    ...front,
    emptyFindings: label(scan.status === 'failed' ? 'findings.unavailable' : 'findings.none'),
    ...(full ? fullSections(report, ctx, v) : {}),

    notice: noticeGroups(report, ctx, {
      label,
      clean: text,
      draft: isDraftReport(report, ctx)
        ? { text: label('notice.draft'), stamp: text(draftStamp(ctx), 60) }
        : null,
      rechtsstand: report.legalContext?.rechtsstand ?? report.ruleset?.rechtsstand ?? null,
    }),
  };
}
