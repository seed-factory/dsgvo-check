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
import { disclaimerParagraphs, phaseCPerformed } from './disclaimer.ts';
import { buildFrontPage, SEVERITY_RANK } from './front-page.ts';

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

/** A list field (pages, evidence values) shows at most this many entries. */
const MAX_LIST_ITEMS = 50;

const URL_VALUE = /^(https?|wss?):\/\//i;
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

interface Item {
  text: string;
  code: boolean;
  url: boolean;
  href: string | null;
}

interface Row {
  label: string;
  items: Item[];
}

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

interface EvidenceView {
  type: string;
  missing: string | null;
  /** "5×" when identical requests are shown as one item; null for a single occurrence. */
  occurrences: string | null;
  fields: Row[];
  screenshot: { dataUri: string | null; missing: string | null; path: string } | null;
}

/** One evidence value as a list item: URLs get link styling, scalars are plain text, objects are shown as JSON code. */
function evidenceItem(value: unknown): Item {
  if (typeof value === 'string') return URL_VALUE.test(value) ? urlItem(value) : item(value, 1000);
  if (value === null || ['number', 'boolean', 'undefined'].includes(typeof value)) return item(value, 1000);
  return item(JSON.stringify(value), 1000, true);
}

function evidenceFields(ev: Evidence): Row[] {
  const hidden = new Set([...ALWAYS_HIDDEN, ...(SECRET_FIELDS[ev.type] ?? [])]);
  return Object.entries(ev as Record<string, unknown>)
    .filter(([k, v]) => !hidden.has(k) && v !== undefined)
    .map(([k, v]): Row => {
      const values = Array.isArray(v) ? v.slice(0, MAX_LIST_ITEMS) : [v];
      return { label: text(k, 80), items: values.length ? values.map(evidenceItem) : [item('–')] };
    });
}

function screenshotView(ev: Evidence, ctx: ReporterContext): EvidenceView['screenshot'] {
  if (ev.type !== 'screenshot') return null;

  const shotEv = ev as Extract<Evidence, { type: 'screenshot' }>;
  const shot = loadScreenshot(ctx.outDir, shotEv.path, shotEv.sha256, ctx.limits?.screenshotEmbedMaxBytes);
  return {
    dataUri: shot.ok ? shot.dataUri : null,
    missing: shot.ok
      ? null
      : reportLabel(ctx, 'screenshot.missing', { reason: shot.reason, path: text(shotEv.path, 500) }),
    path: text(shotEv.path),
  };
}

function evidenceView(ev: Evidence, ctx: ReporterContext): EvidenceView {
  return {
    type: text(ev.type, 60),
    missing: null,
    occurrences: null,
    fields: evidenceFields(ev),
    screenshot: screenshotView(ev, ctx),
  };
}

/** Label and row builders of one view: a label and its string parameters are cleaned and length-capped on the way in. */
interface ViewText {
  label: (key: string, params?: MessageParams) => string;
  row: (key: string, value: unknown, max?: number) => Row;
  rows: (key: string, values: Item[]) => Row;
}

function viewText(ctx: ReporterContext): ViewText {
  const label = (key: string, params: MessageParams = {}) => {
    const clean: MessageParams = {};
    for (const [name, value] of Object.entries(params)) {
      clean[name] = typeof value === 'string' ? sanitizeExternal(value, 500) : value;
    }
    return sanitizeExternal(reportLabel(ctx, key, clean), 4000);
  };
  return {
    label,
    row: (key, value, max = 2000) => ({ label: label(key), items: [item(value, max)] }),
    rows: (key, values) => ({ label: label(key), items: values }),
  };
}

const roundedSeconds = (ms: number): number => Math.round(ms / 100) / 10;

function summaryRows(report: Report, { label, row, rows }: ViewText): Row[] {
  const scan = report.scan;
  const exitReasons = report.summary.exitReasons.map((r) => item(r, 120, true));
  const summary: Row[] = [
    rows('summary.exitReasons', exitReasons.length ? exitReasons : [item(label('summary.none'))]),
    rows('meta.target', [urlItem(scan.target)]),
  ];

  if (scan.finalUrl) summary.push(rows('meta.finalUrl', [urlItem(scan.finalUrl)]));
  summary.push(row('meta.startedAt', scan.startedAt));
  if (typeof scan.durationMs === 'number') {
    summary.push(row('meta.duration', label('meta.seconds', { seconds: roundedSeconds(scan.durationMs) })));
  }

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

/** Related findings link to their anchor in the report when the other finding is part of it. */
function relatedItems(related: Finding['related'], byFingerprint: ReadonlyMap<string, Finding>): Item[] {
  return related.map((r) => {
    const target = byFingerprint.get(r.fingerprint);
    return {
      ...item(`${text(r.checkId, 20)}${r.relation ? ` (${text(r.relation, 60)})` : ''}`),
      href: target ? anchorOf(target) : null,
    };
  });
}

/** The detail rows under a finding; optional facts of the finding add a row each. */
function findingRows(
  f: Finding,
  { label, row, rows }: ViewText,
  byFingerprint: ReadonlyMap<string, Finding>,
) {
  const out: Row[] = [row('finding.confidence', label(`confidence.${f.confidence}`))];

  if (f.pages.length) out.push(rows('finding.pages', f.pages.slice(0, MAX_LIST_ITEMS).map(urlItem)));
  if (f.phases.length) out.push(row('finding.phases', f.phases.join(', '), 120));
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
      checkedAt: checkedAt ?? '–',
    });
    out.push(row('finding.dpf', dpfValue));
  }

  const { source, datasetVersion } = f.classification;
  const classification = `${text(source, 80)}${datasetVersion ? ` ${text(datasetVersion, 40)}` : ''}`;
  out.push(row('finding.classification', classification));

  if (f.related.length) out.push(rows('finding.related', relatedItems(f.related, byFingerprint)));
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

type RequestEvidence = Extract<Evidence, { type: 'request' }>;

/** Fields that tell a repeated request apart: when and where it was made. The merged item lists pages and phases instead. */
const OCCURRENCE_FIELDS = new Set([
  'page',
  'phase',
  'tMs',
  'navigationId',
  'frameId',
  'frameUrl',
  'actionId',
  'parentRequestId',
]);

/** Requests that agree in everything but time and place are one request seen several times. */
function requestKey(ev: Evidence): string | null {
  if (ev.type !== 'request') return null;
  const r = ev as RequestEvidence;
  // Everything the view shows except time and place; otherwise a differing event type or
  // identifier match, or cache versus network delivery, would be hidden behind the first request.
  return JSON.stringify([
    r.url,
    r.method,
    r.resourceType,
    r.delivery,
    r.result,
    r.serviceId ?? null,
    r.provenance ?? null,
    r.thirdPartyETLD1 ?? null,
    r.connectedIp ?? null,
    r.initiator ?? null,
    r.features ?? null,
  ]);
}

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** One item for identical requests: the shared fields once, the pages and phases of all of them, and their count. */
function mergedRequestView(
  group: readonly RequestEvidence[],
  ctx: ReporterContext,
  v: ViewText,
): EvidenceView {
  const [first] = group as [RequestEvidence, ...RequestEvidence[]];
  const pages = distinct(
    group.flatMap((r) => ((r as { page?: string }).page ? [(r as { page: string }).page] : [])),
  );
  const phases = distinct(
    group.flatMap((r) => ((r as { phase?: string }).phase ? [(r as { phase: string }).phase] : [])),
  );

  const view = evidenceView(first, ctx);
  const shared = view.fields.filter((row) => !OCCURRENCE_FIELDS.has(row.label));
  if (phases.length) shared.push(v.row('evidence.phases', phases.join(', '), 120));
  if (pages.length)
    shared.push({ label: v.label('evidence.pages'), items: pages.slice(0, MAX_LIST_ITEMS).map(urlItem) });
  return { ...view, occurrences: v.label('evidence.occurrences', { count: group.length }), fields: shared };
}

/** The evidence of one finding in the order of its ids; identical requests are shown once with their count. */
function evidenceViews(
  ids: readonly string[],
  evidence: ReadonlyMap<string, Evidence>,
  v: ViewText,
  ctx: ReporterContext,
): EvidenceView[] {
  const views: EvidenceView[] = [];
  const repeated = new Map<string, { index: number; group: RequestEvidence[] }>();

  for (const id of distinct(ids)) {
    const ev = evidence.get(id);
    if (!ev) {
      const missing = v.label('finding.evidenceMissing', { id: text(id, 500) });
      views.push({ type: '', missing, occurrences: null, fields: [], screenshot: null });
      continue;
    }

    const key = requestKey(ev);
    const seen = key === null ? undefined : repeated.get(key);
    if (seen) {
      seen.group.push(ev as RequestEvidence);
      continue;
    }
    if (key !== null) repeated.set(key, { index: views.length, group: [ev as RequestEvidence] });
    views.push(evidenceView(ev, ctx));
  }

  for (const { index, group } of repeated.values()) {
    if (group.length > 1) views[index] = mergedRequestView(group, ctx, v);
  }
  return views;
}

function findingView(
  f: Finding,
  v: ViewText,
  ctx: ReporterContext,
  evidence: ReadonlyMap<string, Evidence>,
  byFingerprint: ReadonlyMap<string, Finding>,
) {
  const evs = evidenceViews(f.evidenceIds, evidence, v, ctx);
  const message = findingText(f, ctx);
  return {
    anchor: anchorOf(f),
    severity: f.severity,
    severityLabel: v.label(`severity.${f.severity}`),
    checkId: text(f.checkId, 20),
    title: text(message.title, 300),
    body: text(message.body, 4000),
    rows: findingRows(f, v, byFingerprint),
    evidence: evs,
    evidenceCount: evs.length,
    evidenceTruncated: !!f.evidenceTruncated,
    legalNote: legalNoteView(f, v, ctx),
  };
}

function findingGroups(report: Report, v: ViewText, ctx: ReporterContext) {
  const findings = report.findings ?? [];
  const evidence = new Map((report.evidence ?? []).map((ev) => [ev.id, ev]));
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));
  return groupByService(findings).map((group) => ({
    title: group.serviceId
      ? v.label('findings.groupService', { service: text(group.serviceId, 500) })
      : v.label('findings.groupOther'),
    findings: group.findings.map((f) => findingView(f, v, ctx, evidence, byFingerprint)),
  }));
}

/** Screenshots no finding refers to; shown only when there are findings at all. */
function unreferencedScreenshots(report: Report, ctx: ReporterContext): EvidenceView[] {
  const findings = report.findings ?? [];
  if (!findings.length) return [];
  const referenced = new Set(findings.flatMap((f) => f.evidenceIds));
  return (report.evidence ?? [])
    .filter((ev) => ev.type === 'screenshot' && !referenced.has(ev.id))
    .map((ev) => evidenceView(ev, ctx));
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
        headless: env.browser.headless ?? '–',
      })
    : label('env.unavailable');
  const sandbox = label('env.sandboxValue', {
    mode: env.sandbox.mode,
    active: label(env.sandbox.active === null ? 'unknown' : env.sandbox.active ? 'yes' : 'no'),
  });
  const egress = label('env.egressValue', {
    mode: env.egress.mode,
    region: env.egress.assertedRegion
      ? `${env.egress.region}: ${env.egress.assertedRegion}`
      : env.egress.region,
    source: text(env.egress.source, 500),
  });

  const out: Row[] = [
    row('env.userAgentHttp', env.userAgent.http, 500),
    row('env.userAgentBrowser', env.userAgent.browser, 500),
    row('env.browser', browser),
    row('env.sandbox', sandbox),

    row('env.profile', env.profile, 100),
    row('env.viewport', env.viewport ? `${env.viewport.width} × ${env.viewport.height}` : '–'),
    row('env.locale', env.locale, 40),
    row('env.timezone', env.timezone, 60),

    row('env.egress', egress),
    list('env.disabledFeatures', env.disabledChromiumFeatures),
    row('env.quic', env.quic, 20),
    list('env.knownGaps', env.knownGaps),
    row('env.requests', label('env.requestsValue', { ...env.requestsIssued })),
  ];

  const settings = Object.entries(report.scan.options?.settings ?? {});
  if (settings.length > 0) {
    const settingItems = settings.map(([name, value]) =>
      item(`${text(name, 80)}=${text(String(value), 200)}`, 300, true),
    );
    out.push(rows('env.settings', settingItems));
  }
  if (phaseCPerformed(report)) out.push(row('env.phaseC', label('env.phaseCValue')));

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

function coveragePageViews(pages: Coverage['pages'], { label }: ViewText) {
  return pages.map((p) => ({
    url: text(p.url),
    role: text(p.role, 40),
    planned: label(p.planned ? 'yes' : 'no'),
    observed: label(p.observed ? 'yes' : 'no'),
    evaluated: label(p.evaluated ? 'yes' : 'no'),
    phases: text(p.phases.join(', ') || '–', 60),
    reason: text(p.reason, 200),
  }));
}

function coverageCollectorViews(collectors: Coverage['collectors'], { label }: ViewText) {
  return Object.entries(collectors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name: text(name, 40),
      status: text(c.status, 40),
      reason: text(c.reason, 200),
      duration:
        typeof c.durationMs === 'number'
          ? label('meta.seconds', { seconds: roundedSeconds(c.durationMs) })
          : '–',
    }));
}

function coverageView(report: Report, v: ViewText) {
  const cov = report.scan.coverage;
  if (!cov) return null;

  return {
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
  if (counts?.note) parts.push(text(counts.note, 300));
  return parts.join(' · ') || '–';
}

function checkViews(report: Report, v: ViewText) {
  return [...(report.checks ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const failure = c.error ? `${c.error.code}: ${c.error.message}` : null;
      return {
        id: text(c.id, 20),
        status: text(c.status, 40),
        statusLabel: v.label(`checkStatus.${c.status}`),
        reason: text([c.reason, failure].filter(Boolean).join(' – ') || '–', 400),
        coverage: checkCoverageText(c, v),
        limitations: c.limitations.map((l) => text(l, 120)),
      };
    });
}

/** What only the full report shows: findings with their evidence and every technical table. */
function fullSections(report: Report, ctx: ReporterContext, v: ViewText) {
  const scan = report.scan;
  return {
    groups: findingGroups(report, v, ctx),
    otherShots: unreferencedScreenshots(report, ctx),
    diagnostics: diagnosticViews(report, ctx),

    summary: summaryRows(report, v),
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
  const v = viewText(ctx);
  const { label } = v;
  const scan = report.scan;
  const errors = failedChecks(report);
  const full = (ctx.detail ?? 'full') === 'full';
  const front = buildFrontPage(report, ctx, {
    label,
    clean: text,
    message: (f) => findingText(f, ctx),
  });

  return {
    screenshotAlt: label('screenshot.alt'),
    lang: ctx.lang === 'en' ? 'en' : 'de',
    target: text(scan.target),
    titleTarget: text(scan.target, 200),
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

    disclaimer: disclaimerParagraphs(report, ctx.texts).map((p) => text(p, 6000)),
    rechtsstand: report.legalContext?.rechtsstand ?? report.ruleset?.rechtsstand ?? null,
  };
}
