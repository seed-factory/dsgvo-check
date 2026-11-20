/** Presentation data selected from a report; it contains text and checked local images, never markup. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { reporterLimits } from '../core/config/limits.ts';
import { renderMessage, uiText } from '../core/data/messages.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { Evidence, Finding, Report } from '../core/report/schema.ts';
import {
  type EvidenceTools,
  type EvidenceView,
  evidenceView,
  evidenceViews,
  type Item,
  MAX_LIST_ITEMS,
  type Row,
} from './evidence-view.ts';
import { buildFrontPage, SEVERITY_RANK } from './front-page.ts';
import { noticeGroups } from './notice-view.ts';
import { regionText, technicalView } from './technical-view.ts';
import { item, phaseList, text, urlItem, type ViewText, viewText } from './view-text.ts';

export { type ReportLabelKey, reportLabel } from './view-text.ts';

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
  if (!ctx.texts.messages[f.messageId] && f.text) return { title: f.text.title, body: f.text.body };
  return renderMessage(ctx.texts, f.messageId, f.params);
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

const anchorOf = (f: Finding) =>
  `f-${f.fingerprint
    .replace(/^sha256:/, '')
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 16)}`;

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

function fullSections(report: Report, ctx: ReporterContext, v: ViewText) {
  return {
    groups: findingGroups(report, v, ctx),
    otherShots: unreferencedScreenshots(report, v, ctx),
    diagnostics: diagnosticViews(report, ctx),
    ...technicalView(report, ctx, v),
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
  const draft = isDraftReport(report, ctx);
  const stamp = text(draftStamp(ctx), 60);
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
    draft,
    draftStamp: stamp,

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
      draft: draft ? { text: label('notice.draft'), stamp } : null,
      rechtsstand: report.legalContext?.rechtsstand ?? report.ruleset?.rechtsstand ?? null,
    }),
  };
}
