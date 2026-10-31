/**
 * HTML reporter (owner: M6). One self-contained file without JS (D25, 5.8):
 * - CSP `default-src 'none'; img-src data:; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` in a meta
 *   tag; the only style block is hashed, there are no `style=` attributes and no external resources;
 * - every external string goes through `sanitizeExternal` and HTML escaping; URLs are text, links are anchors only;
 * - banner screenshots are embedded as `data:` URIs read from `<outDir>/artifacts` (checked path, type, checksum);
 * - crmCode is never rendered and `T[0-9]_` never appears literally (5.6).
 * Labels come from `data/texts/<lang>/report.yaml` (ui keys `report.*`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatMessage, renderMessage, uiText } from '../core/messages.ts';
import type {
  CheckResult,
  Evidence,
  Finding,
  MessageParams,
  Report,
  ScanCoverage,
  ScanEnvironment,
  Severity,
} from '../core/report-schema.ts';
import type { RenderReport, ReporterContext } from '../core/reporter.ts';
import { sanitizeExternal } from '../core/sanitize.ts';
import { disclaimerParagraphs, phaseCPerformed } from './disclaimer.ts';

// ---------------------------------------------------------------- labels (shared with summary.ts)

/** Label keys of the HTML report and the Job Summary; texts live in `data/texts/<lang>/report.yaml` (D22). */
export const REPORT_LABEL_KEYS = [
  'doc.title',
  'doc.heading',
  'nav.label',
  'section.summary',
  'section.findings',
  'section.diagnostics',
  'section.environment',
  'section.coverage',
  'section.notice',
  'meta.target',
  'meta.finalUrl',
  'meta.startedAt',
  'meta.duration',
  'meta.seconds',
  'meta.version',
  'meta.ruleset',
  'meta.rulesetValue',
  'meta.failOn',
  'meta.schemaVersion',
  'status.label',
  'status.complete',
  'status.partial',
  'status.failed',
  'summary.exitCode',
  'summary.exitReasons',
  'summary.none',
  'summary.counts',
  'summary.checkErrors',
  'summary.inconclusive',
  'summary.suppressed',
  'summary.failure',
  'summary.sandboxOff',
  'summary.checkErrorsWithThreshold',
  'summary.more',
  'summary.column.severity',
  'summary.column.check',
  'summary.column.finding',
  'summary.column.pages',
  'summary.files',
  'severity.critical',
  'severity.warning',
  'severity.info',
  'findings.none',
  'findings.unavailable',
  'findings.groupService',
  'findings.groupOther',
  'finding.confidence',
  'confidence.high',
  'confidence.medium',
  'confidence.low',
  'finding.pages',
  'finding.phases',
  'finding.trigger',
  'finding.replicated',
  'finding.provider',
  'finding.parent',
  'finding.dpf',
  'finding.dpfValue',
  'finding.classification',
  'finding.related',
  'finding.fingerprint',
  'finding.evidence',
  'finding.evidenceTruncated',
  'finding.evidenceMissing',
  'finding.legalNote',
  'finding.legalStatus',
  'finding.legalUnreviewed',
  'legal.authority-consensus',
  'legal.court-first-instance',
  'legal.court-appellate',
  'legal.contested',
  'legal.technical',
  'evidence.otherScreenshots',
  'screenshot.alt',
  'screenshot.missing',
  'diagnostics.none',
  'diagnostics.affects',
  'env.userAgentHttp',
  'env.userAgentBrowser',
  'env.browser',
  'env.browserValue',
  'env.sandbox',
  'env.sandboxValue',
  'env.profile',
  'env.viewport',
  'env.locale',
  'env.timezone',
  'env.egress',
  'env.egressValue',
  'env.disabledFeatures',
  'env.quic',
  'env.knownGaps',
  'env.requests',
  'env.requestsValue',
  'env.phaseC',
  'env.phaseCValue',
  'env.node',
  'env.platform',
  'env.unavailable',
  'env.datasets',
  'env.datasetValue',
  'coverage.pages',
  'coverage.totals',
  'coverage.url',
  'coverage.role',
  'coverage.planned',
  'coverage.observed',
  'coverage.evaluated',
  'coverage.phases',
  'coverage.reason',
  'coverage.collectors',
  'coverage.collector',
  'coverage.status',
  'coverage.duration',
  'coverage.browserRequests',
  'coverage.checks',
  'coverage.check',
  'coverage.checkCoverage',
  'coverage.limitations',
  'coverage.unavailable',
  'checkStatus.completed',
  'checkStatus.partial',
  'checkStatus.inconclusive',
  'checkStatus.not_applicable',
  'checkStatus.skipped',
  'checkStatus.error',
  'checkCoverage.value',
  'notice.rechtsstand',
  'notice.draft',
  'footer.generated',
  'yes',
  'no',
  'unknown',
] as const;

export type ReportLabelKey = (typeof REPORT_LABEL_KEYS)[number];

/** Label text from data (`ui['report.<key>']`); a missing key renders as the key itself (the L0 test forbids it). */
export function reportLabel(ctx: ReporterContext, key: ReportLabelKey, params: MessageParams = {}): string {
  const fromData = ctx.texts.ui[`report.${key}`];
  return fromData ? formatMessage(fromData.text, params, ctx.lang) : key;
}

/** Draft stamp ("Textentwurf") when any text in use is a draft (D22). */
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

// ---------------------------------------------------------------- shared helpers

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 3, warning: 2, info: 1 };

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.checkId.localeCompare(b.checkId) ||
      a.variant.localeCompare(b.variant) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
}

/** Rendered title/body of a finding; falls back to the convenience copy in the report. */
export function findingText(f: Finding, ctx: ReporterContext): { title: string; body: string } {
  if (ctx.texts.messages[f.messageId]) return renderMessage(ctx.texts, f.messageId, f.params);
  if (f.text) return { title: f.text.title, body: f.text.body };
  return renderMessage(ctx.texts, f.messageId, f.params);
}

/** Ids of checks with status `error` (5.2: with exit code 1 they get an extra line in HTML and Summary). */
export function failedChecks(report: Report): string[] {
  return (report.checks ?? []).filter((c) => c.status === 'error').map((c) => c.id);
}

// ---------------------------------------------------------------- escaping

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape for HTML text and quoted attribute values; `T<digit>_` is broken up so crm codes never appear (5.6). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c] ?? c).replace(/T(\d)_/g, 'T$1&#95;');
}

/** External string: sanitize (ANSI, bidi, control chars) and escape. */
function x(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return '–';
  return escapeHtml(sanitizeExternal(String(value), max));
}

/** Escaped label. */
function L(ctx: ReporterContext, key: ReportLabelKey, params: MessageParams = {}): string {
  return escapeHtml(sanitizeExternal(reportLabel(ctx, key, params), 4000));
}

/** Escaped label with external params (params are sanitized first). */
function LX(ctx: ReporterContext, key: ReportLabelKey, params: Record<string, unknown>): string {
  const clean: MessageParams = {};
  for (const [k, v] of Object.entries(params)) {
    clean[k] =
      v === null || v === undefined
        ? null
        : typeof v === 'number' || typeof v === 'boolean'
          ? v
          : sanitizeExternal(String(v), 500);
  }
  return L(ctx, key, clean);
}

const url = (u: unknown) => `<code class="url">${x(u, 2000)}</code>`;

/** Anchor id from a fingerprint (only [0-9a-f]). */
function anchorOf(f: Finding): string {
  return `f-${f.fingerprint
    .replace(/^sha256:/, '')
    .replace(/[^0-9a-f]/g, '')
    .slice(0, 16)}`;
}

// ---------------------------------------------------------------- screenshots

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

type ScreenshotResult = { ok: true; dataUri: string } | { ok: false; reason: string };

function imageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

function within(dir: string, file: string): boolean {
  return file.startsWith(dir + path.sep);
}

/** Read a screenshot from `<outDir>/artifacts` and return it as a data: URI (never follows paths outside). */
export function loadScreenshot(outDir: string, relPath: string, sha256: string): ScreenshotResult {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return { ok: false, reason: 'path' };
  const base = path.resolve(outDir, 'artifacts');
  const file = path.resolve(outDir, relPath);
  if (!within(base, file)) return { ok: false, reason: 'path' };
  let data: Buffer;
  try {
    const realBase = realpathSync(base);
    const realFile = realpathSync(file);
    if (!within(realBase, realFile)) return { ok: false, reason: 'path' };
    const st = statSync(realFile);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    if (st.size > MAX_SCREENSHOT_BYTES) return { ok: false, reason: 'too-large' };
    data = readFileSync(realFile);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const expected = sha256.toLowerCase().replace(/^sha256:/, '');
  if (createHash('sha256').update(data).digest('hex') !== expected) return { ok: false, reason: 'checksum' };
  const mime = imageMime(data);
  if (!mime) return { ok: false, reason: 'format' };
  return { ok: true, dataUri: `data:${mime};base64,${data.toString('base64')}` };
}

// ---------------------------------------------------------------- evidence

/** Fields that must never be shown (D20: no cookie/storage/TC values, not even hashed). */
const SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  cookie: ['value', 'valueSha256', 'valueHash', 'hash'],
  storage: ['value', 'valueSha256', 'valueHash', 'hash'],
  'consent-state': ['tcString', 'value'],
  cmp: ['tcString'],
};
const ALWAYS_HIDDEN = new Set(['id', 'type', 'tcString', 'tcstring']);

function fieldValue(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'string') return /^(https?|wss?):\/\//i.test(v) ? url(v) : x(v, 1000);
  if (typeof v === 'number' || typeof v === 'boolean') return x(String(v));
  if (Array.isArray(v) && v.every((i) => i === null || ['string', 'number', 'boolean'].includes(typeof i))) {
    if (v.length === 0) return '–';
    return `<ul class="plain">${v
      .slice(0, 50)
      .map((i) => `<li>${fieldValue(i)}</li>`)
      .join('')}</ul>`;
  }
  if (Array.isArray(v)) {
    return `<ul class="plain">${v
      .slice(0, 50)
      .map((i) => `<li><code>${x(JSON.stringify(i), 1000)}</code></li>`)
      .join('')}</ul>`;
  }
  return `<code>${x(JSON.stringify(v), 1000)}</code>`;
}

function evidenceFields(ev: Evidence): string {
  const hidden = new Set([...ALWAYS_HIDDEN, ...(SECRET_FIELDS[ev.type] ?? [])]);
  const rows = Object.entries(ev as Record<string, unknown>)
    .filter(([k, v]) => !hidden.has(k) && v !== undefined)
    .map(([k, v]) => `<dt>${x(k, 80)}</dt><dd>${fieldValue(v)}</dd>`);
  return rows.length ? `<dl class="kv">${rows.join('')}</dl>` : '';
}

function screenshotBlock(ev: Extract<Evidence, { type: 'screenshot' }>, ctx: ReporterContext): string {
  const shot = loadScreenshot(ctx.outDir, ev.path, ev.sha256);
  if (shot.ok) {
    return `<figure class="shot"><img src="${shot.dataUri}" alt="${L(ctx, 'screenshot.alt')}"><figcaption>${x(
      ev.path,
    )}</figcaption></figure>`;
  }
  return `<p class="muted">${LX(ctx, 'screenshot.missing', { reason: shot.reason, path: ev.path })}</p>`;
}

function evidenceItem(ev: Evidence, ctx: ReporterContext): string {
  const head = `<span class="ev-type">${x(ev.type, 60)}</span>`;
  const shot =
    ev.type === 'screenshot' ? screenshotBlock(ev as Extract<Evidence, { type: 'screenshot' }>, ctx) : '';
  return `<li class="ev">${head}${shot}${evidenceFields(ev)}</li>`;
}

// ---------------------------------------------------------------- sections

function dlRows(rows: Array<[string, string]>): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function badge(ctx: ReporterContext, s: Severity): string {
  return `<span class="badge sev-${s}">${L(ctx, `severity.${s}`)}</span>`;
}

function summarySection(report: Report, ctx: ReporterContext): string {
  const scan = report.scan;
  const parts: string[] = [];
  const statusLabel = L(ctx, `status.${scan.status}`);
  parts.push(`<p class="status status-${scan.status}">${statusLabel}</p>`);
  if (scan.failure) {
    parts.push(
      `<p class="failure">${LX(ctx, 'summary.failure', { message: scan.failure.message, code: scan.failure.code })}</p>`,
    );
  }
  if (scan.environment?.sandbox.mode === 'off') {
    parts.push(`<p class="warn">${L(ctx, 'summary.sandboxOff')}</p>`);
  }
  const reasons = report.summary.exitReasons.length
    ? report.summary.exitReasons.map((r) => `<code>${x(r, 120)}</code>`).join(' ')
    : L(ctx, 'summary.none');
  const rows: Array<[string, string]> = [
    [
      L(ctx, 'summary.exitCode'),
      `<strong class="exit exit-${report.summary.exitCode}">${report.summary.exitCode}</strong>`,
    ],
    [L(ctx, 'summary.exitReasons'), reasons],
    [L(ctx, 'meta.target'), url(scan.target)],
  ];
  if (scan.finalUrl) rows.push([L(ctx, 'meta.finalUrl'), url(scan.finalUrl)]);
  rows.push([L(ctx, 'meta.startedAt'), x(scan.startedAt)]);
  if (typeof scan.durationMs === 'number') {
    rows.push([
      L(ctx, 'meta.duration'),
      L(ctx, 'meta.seconds', { seconds: Math.round(scan.durationMs / 100) / 10 }),
    ]);
  }
  if (scan.options) rows.push([L(ctx, 'meta.failOn'), `<code>${x(scan.options.failOn)}</code>`]);
  if (report.ruleset) {
    rows.push([
      L(ctx, 'meta.ruleset'),
      LX(ctx, 'meta.rulesetValue', {
        profile: report.ruleset.profile,
        version: report.ruleset.version,
        rechtsstand: report.ruleset.rechtsstand,
      }),
    ]);
  }
  rows.push([L(ctx, 'meta.version'), `dsgvo-check ${x(report.tool.version, 40)}`]);
  parts.push(dlRows(rows));

  const c = report.summary.counts;
  if (c) {
    parts.push(`<h3>${L(ctx, 'summary.counts')}</h3>`);
    parts.push(
      `<dl class="counts">${(['critical', 'warning', 'info'] as const)
        .map((s) => `<div class="count sev-${s}"><dt>${L(ctx, `severity.${s}`)}</dt><dd>${c[s]}</dd></div>`)
        .join(
          '',
        )}<div class="count"><dt>${L(ctx, 'summary.checkErrors')}</dt><dd>${c.checkErrors}</dd></div>` +
        `<div class="count"><dt>${L(ctx, 'summary.inconclusive')}</dt><dd>${c.inconclusive}</dd></div>` +
        `<div class="count"><dt>${L(ctx, 'summary.suppressed')}</dt><dd>${c.suppressed}</dd></div></dl>`,
    );
  }
  const errs = failedChecks(report);
  if (report.summary.exitCode === 1 && errs.length > 0) {
    parts.push(
      `<p class="warn">${LX(ctx, 'summary.checkErrorsWithThreshold', { checks: errs.join(', ') })}</p>`,
    );
  }
  return parts.join('\n');
}

interface Group {
  key: string;
  serviceId: string | null;
  findings: Finding[];
}

export function groupByService(findings: readonly Finding[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of sortFindings(findings)) {
    const key = f.serviceId ? `s:${f.serviceId}` : 'other';
    let g = map.get(key);
    if (!g) {
      g = { key, serviceId: f.serviceId ?? null, findings: [] };
      map.set(key, g);
    }
    g.findings.push(f);
  }
  const top = (g: Group) => Math.max(...g.findings.map((f) => SEVERITY_RANK[f.severity]));
  return [...map.values()].sort((a, b) => {
    if ((a.serviceId === null) !== (b.serviceId === null)) return a.serviceId === null ? 1 : -1;
    return top(b) - top(a) || (a.serviceId ?? '').localeCompare(b.serviceId ?? '');
  });
}

function legalNoteBlock(f: Finding, ctx: ReporterContext): string {
  if (!f.legalNoteId) return '';
  const note = ctx.texts.legalNotes[f.legalNoteId];
  if (!note) return '';
  const meta = [
    LX(ctx, 'finding.legalStatus', { status: reportLabel(ctx, `legal.${note.status}` as ReportLabelKey) }),
  ];
  if (note.draft) meta.push(L(ctx, 'finding.legalUnreviewed'));
  if (note.reviewedAt) meta.push(x(note.reviewedAt, 40));
  return `<details class="legal"><summary>${L(ctx, 'finding.legalNote')}</summary><p>${x(note.text, 4000)}</p><p class="muted">${meta.join(' · ')}</p></details>`;
}

function findingBlock(
  f: Finding,
  ctx: ReporterContext,
  evidence: Map<string, Evidence>,
  byFp: Map<string, Finding>,
) {
  const text = findingText(f, ctx);
  const rows: Array<[string, string]> = [
    [L(ctx, 'finding.confidence'), L(ctx, `confidence.${f.confidence}`)],
  ];
  if (f.pages.length) {
    rows.push([
      L(ctx, 'finding.pages'),
      `<ul class="plain">${f.pages
        .slice(0, 50)
        .map((p) => `<li>${url(p)}</li>`)
        .join('')}</ul>`,
    ]);
  }
  if (f.phases.length) rows.push([L(ctx, 'finding.phases'), x(f.phases.join(', '), 120)]);
  if (f.trigger) rows.push([L(ctx, 'finding.trigger'), x(f.trigger, 200)]);
  if (typeof f.replicated === 'boolean')
    rows.push([L(ctx, 'finding.replicated'), L(ctx, f.replicated ? 'yes' : 'no')]);
  if (f.provider)
    rows.push([
      L(ctx, 'finding.provider'),
      `${x(f.provider.name, 200)} (${x(f.provider.country ?? '–', 8)})`,
    ]);
  if (f.parent)
    rows.push([L(ctx, 'finding.parent'), `${x(f.parent.name, 200)} (${x(f.parent.country ?? '–', 8)})`]);
  if (f.dpfEntity) {
    rows.push([
      L(ctx, 'finding.dpf'),
      LX(ctx, 'finding.dpfValue', {
        name: f.dpfEntity.name,
        listed: f.dpfEntity.listed === null ? 'unknown' : String(f.dpfEntity.listed),
        checkedAt: f.dpfEntity.checkedAt ?? '–',
      }),
    ]);
  }
  const cls = f.classification;
  rows.push([
    L(ctx, 'finding.classification'),
    `${x(cls.source, 80)}${cls.datasetVersion ? ` ${x(cls.datasetVersion, 40)}` : ''}`,
  ]);
  if (f.related.length) {
    rows.push([
      L(ctx, 'finding.related'),
      `<ul class="plain">${f.related
        .map((r) => {
          const target = byFp.get(r.fingerprint);
          const label = `${x(r.checkId, 20)}${r.relation ? ` (${x(r.relation, 60)})` : ''}`;
          return `<li>${target ? `<a href="#${anchorOf(target)}">${label}</a>` : label}</li>`;
        })
        .join('')}</ul>`,
    ]);
  }
  rows.push([L(ctx, 'finding.fingerprint'), `<code>${x(f.fingerprint, 80)}</code>`]);

  const evItems = f.evidenceIds.map((id) => {
    const ev = evidence.get(id);
    return ev
      ? evidenceItem(ev, ctx)
      : `<li class="ev muted">${LX(ctx, 'finding.evidenceMissing', { id })}</li>`;
  });
  const truncated = f.evidenceTruncated ? `<p class="muted">${L(ctx, 'finding.evidenceTruncated')}</p>` : '';
  const evBlock = evItems.length
    ? `<details class="evidence"><summary>${L(ctx, 'finding.evidence', { count: evItems.length })}</summary><ul class="evs">${evItems.join('')}</ul>${truncated}</details>`
    : truncated;

  return `<article class="finding sev-${f.severity}" id="${anchorOf(f)}">
<h4>${badge(ctx, f.severity)} <code>${x(f.checkId, 20)}</code> ${x(text.title, 300)}</h4>
<p>${x(text.body, 4000)}</p>
${dlRows(rows)}
${evBlock}
${legalNoteBlock(f, ctx)}
</article>`;
}

function findingsSection(report: Report, ctx: ReporterContext): string {
  const findings = report.findings ?? [];
  if (findings.length === 0) {
    const key = report.scan.status === 'failed' ? 'findings.unavailable' : 'findings.none';
    return `<p>${L(ctx, key)}</p>`;
  }
  const evidence = new Map((report.evidence ?? []).map((e) => [e.id, e] as const));
  const byFp = new Map(findings.map((f) => [f.fingerprint, f] as const));
  const out: string[] = [];
  for (const g of groupByService(findings)) {
    const title = g.serviceId
      ? LX(ctx, 'findings.groupService', { service: g.serviceId })
      : L(ctx, 'findings.groupOther');
    out.push(`<section class="group"><h3>${title}</h3>`);
    for (const f of g.findings) out.push(findingBlock(f, ctx, evidence, byFp));
    out.push('</section>');
  }
  const referenced = new Set(findings.flatMap((f) => f.evidenceIds));
  const otherShots = (report.evidence ?? []).filter((e) => e.type === 'screenshot' && !referenced.has(e.id));
  if (otherShots.length) {
    out.push(`<section class="group"><h3>${L(ctx, 'evidence.otherScreenshots')}</h3><ul class="evs">`);
    for (const e of otherShots) out.push(evidenceItem(e, ctx));
    out.push('</ul></section>');
  }
  return out.join('\n');
}

function diagnosticsSection(report: Report, ctx: ReporterContext): string {
  const diags = report.diagnostics ?? [];
  if (diags.length === 0) return `<p>${L(ctx, 'diagnostics.none')}</p>`;
  return `<ul class="diags">${diags
    .map((d) => {
      const msg = renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, d.params ?? {});
      const affects = d.affects.length
        ? `<p class="muted">${L(ctx, 'diagnostics.affects')}: ${d.affects.map((a) => `<code>${x(a, 20)}</code>`).join(' ')}</p>`
        : '';
      return `<li><strong><code>${x(d.code, 40)}</code> ${x(msg.title, 300)}</strong><p>${x(msg.body, 2000)}</p>${affects}</li>`;
    })
    .join('')}</ul>`;
}

function environmentSection(report: Report, ctx: ReporterContext): string {
  const env: ScanEnvironment | undefined = report.scan.environment;
  const parts: string[] = [];
  if (!env) {
    parts.push(`<p>${L(ctx, 'env.unavailable')}</p>`);
  } else {
    const list = (items: readonly string[]) =>
      items.length ? items.map((i) => `<code>${x(i, 200)}</code>`).join(' ') : '–';
    const rows: Array<[string, string]> = [
      [L(ctx, 'env.userAgentHttp'), `<code>${x(env.userAgent.http, 500)}</code>`],
      [
        L(ctx, 'env.userAgentBrowser'),
        env.userAgent.browser ? `<code>${x(env.userAgent.browser, 500)}</code>` : '–',
      ],
      [
        L(ctx, 'env.browser'),
        env.browser
          ? LX(ctx, 'env.browserValue', {
              engine: env.browser.engine,
              version: env.browser.version ?? '–',
              channel: env.browser.channel ?? '–',
              headless: env.browser.headless ?? '–',
            })
          : L(ctx, 'env.unavailable'),
      ],
      [
        L(ctx, 'env.sandbox'),
        LX(ctx, 'env.sandboxValue', {
          mode: env.sandbox.mode,
          active:
            env.sandbox.active === null
              ? reportLabel(ctx, 'unknown')
              : reportLabel(ctx, env.sandbox.active ? 'yes' : 'no'),
        }),
      ],
      [L(ctx, 'env.profile'), x(env.profile ?? '–', 100)],
      [L(ctx, 'env.viewport'), env.viewport ? `${env.viewport.width} × ${env.viewport.height}` : '–'],
      [L(ctx, 'env.locale'), x(env.locale, 40)],
      [L(ctx, 'env.timezone'), x(env.timezone, 60)],
      [
        L(ctx, 'env.egress'),
        LX(ctx, 'env.egressValue', {
          mode: env.egress.mode,
          region: env.egress.assertedRegion
            ? `${env.egress.region}: ${env.egress.assertedRegion}`
            : env.egress.region,
          source: env.egress.source,
        }),
      ],
      [L(ctx, 'env.disabledFeatures'), list(env.disabledChromiumFeatures)],
      [L(ctx, 'env.quic'), x(env.quic, 20)],
      [L(ctx, 'env.knownGaps'), list(env.knownGaps)],
      [L(ctx, 'env.requests'), LX(ctx, 'env.requestsValue', { ...env.requestsIssued })],
      // D08: phase C discloses the scanner's IP address to the site's third parties.
      ...(phaseCPerformed(report)
        ? ([[L(ctx, 'env.phaseC'), L(ctx, 'env.phaseCValue')]] as Array<[string, string]>)
        : []),
      [L(ctx, 'env.node'), x(env.node, 40)],
      [L(ctx, 'env.platform'), x(env.platform, 60)],
    ];
    parts.push(dlRows(rows));
  }
  const extra: Array<[string, string]> = [
    [L(ctx, 'meta.version'), `dsgvo-check ${x(report.tool.version, 40)}`],
    [L(ctx, 'meta.schemaVersion'), x(report.schemaVersion, 20)],
  ];
  parts.push(dlRows(extra));
  const datasets = report.datasets ?? [];
  if (datasets.length) {
    parts.push(`<h3>${L(ctx, 'env.datasets')}</h3><ul>`);
    for (const d of datasets) {
      const attribution = (d as { attribution?: unknown }).attribution;
      parts.push(
        `<li>${LX(ctx, 'env.datasetValue', { name: d.name, version: d.version ?? '–', license: d.license })}${
          typeof attribution === 'string' && attribution ? ` – ${x(attribution, 500)}` : ''
        }</li>`,
      );
    }
    parts.push('</ul>');
  }
  return parts.join('\n');
}

function yesNo(ctx: ReporterContext, v: boolean): string {
  return `<span class="${v ? 'yes' : 'no'}">${L(ctx, v ? 'yes' : 'no')}</span>`;
}

function checkCoverageText(c: CheckResult, ctx: ReporterContext): string {
  if (!c.coverage) return '–';
  const parts: string[] = [];
  if (
    c.coverage.planned !== undefined ||
    c.coverage.observed !== undefined ||
    c.coverage.evaluated !== undefined
  ) {
    parts.push(
      L(ctx, 'checkCoverage.value', {
        planned: c.coverage.planned ?? '–',
        observed: c.coverage.observed ?? '–',
        evaluated: c.coverage.evaluated ?? '–',
      }),
    );
  }
  if (c.coverage.note) parts.push(x(c.coverage.note, 300));
  return parts.join(' · ') || '–';
}

function coverageSection(report: Report, ctx: ReporterContext): string {
  const cov: ScanCoverage | undefined = report.scan.coverage;
  const parts: string[] = [];
  if (!cov) {
    parts.push(`<p>${L(ctx, 'coverage.unavailable')}</p>`);
  } else {
    const planned = cov.pages.filter((p) => p.planned).length;
    const observed = cov.pages.filter((p) => p.observed).length;
    const evaluated = cov.pages.filter((p) => p.evaluated).length;
    parts.push(`<h3>${L(ctx, 'coverage.pages')}</h3>`);
    parts.push(`<p>${L(ctx, 'coverage.totals', { planned, observed, evaluated })}</p>`);
    if (cov.pages.length) {
      parts.push(
        `<div class="scroll"><table><thead><tr><th>${L(ctx, 'coverage.url')}</th><th>${L(ctx, 'coverage.role')}</th><th>${L(
          ctx,
          'coverage.planned',
        )}</th><th>${L(ctx, 'coverage.observed')}</th><th>${L(ctx, 'coverage.evaluated')}</th><th>${L(
          ctx,
          'coverage.phases',
        )}</th><th>${L(ctx, 'coverage.reason')}</th></tr></thead><tbody>${cov.pages
          .map(
            (p) =>
              `<tr><td>${url(p.url)}</td><td>${x(p.role, 40)}</td><td>${yesNo(ctx, p.planned)}</td><td>${yesNo(
                ctx,
                p.observed,
              )}</td><td>${yesNo(ctx, p.evaluated)}</td><td>${x(p.phases.join(', ') || '–', 60)}</td><td>${x(
                p.reason ?? '–',
                200,
              )}</td></tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    }
    if (cov.browserRequests) {
      parts.push(`<p>${L(ctx, 'coverage.browserRequests', { ...cov.browserRequests })}</p>`);
    }
    const collectors = Object.entries(cov.collectors).sort(([a], [b]) => a.localeCompare(b));
    if (collectors.length) {
      parts.push(`<h3>${L(ctx, 'coverage.collectors')}</h3>`);
      parts.push(
        `<div class="scroll"><table><thead><tr><th>${L(ctx, 'coverage.collector')}</th><th>${L(ctx, 'coverage.status')}</th><th>${L(
          ctx,
          'coverage.reason',
        )}</th><th>${L(ctx, 'coverage.duration')}</th></tr></thead><tbody>${collectors
          .map(
            ([name, c]) =>
              `<tr><td>${x(name, 40)}</td><td>${x(c.status, 40)}</td><td>${x(c.reason ?? '–', 200)}</td><td>${
                typeof c.durationMs === 'number'
                  ? L(ctx, 'meta.seconds', { seconds: Math.round(c.durationMs / 100) / 10 })
                  : '–'
              }</td></tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    }
  }
  const checks = report.checks ?? [];
  if (checks.length) {
    parts.push(`<h3>${L(ctx, 'coverage.checks')}</h3>`);
    parts.push(
      `<div class="scroll"><table><thead><tr><th>${L(ctx, 'coverage.check')}</th><th>${L(ctx, 'coverage.status')}</th><th>${L(
        ctx,
        'coverage.reason',
      )}</th><th>${L(ctx, 'coverage.checkCoverage')}</th><th>${L(ctx, 'coverage.limitations')}</th></tr></thead><tbody>${[
        ...checks,
      ]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => {
          const status = reportLabel(ctx, `checkStatus.${c.status}` as ReportLabelKey);
          const reason = [c.reason, c.error ? `${c.error.code}: ${c.error.message}` : null]
            .filter(Boolean)
            .join(' – ');
          return `<tr class="st-${c.status}"><td><code>${x(c.id, 20)}</code></td><td>${x(status, 40)}</td><td>${x(
            reason || '–',
            400,
          )}</td><td>${checkCoverageText(c, ctx)}</td><td>${
            c.limitations.length ? c.limitations.map((l) => `<code>${x(l, 120)}</code>`).join(' ') : '–'
          }</td></tr>`;
        })
        .join('')}</tbody></table></div>`,
    );
  }
  return parts.join('\n');
}

function noticeSection(report: Report, ctx: ReporterContext, draft: boolean): string {
  const parts = disclaimerParagraphs(report, ctx.texts).map((p) => `<p>${x(p, 6000)}</p>`);
  const rechtsstand = report.legalContext?.rechtsstand ?? report.ruleset?.rechtsstand;
  if (rechtsstand) parts.push(`<p class="muted">${LX(ctx, 'notice.rechtsstand', { date: rechtsstand })}</p>`);
  if (draft)
    parts.push(
      `<p class="stamp-line"><span class="stamp">${x(draftStamp(ctx), 60)}</span> ${L(ctx, 'notice.draft')}</p>`,
    );
  return parts.join('\n');
}

// ---------------------------------------------------------------- document

const CSS = [
  ':root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#ffffff;--card:#f6f8fa;--line:#d1d9e0;',
  '--crit:#b42318;--warn:#8a5a00;--info:#0b5cad;--ok:#1a7f37}',
  '@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#151b23;',
  '--line:#3d444d;--crit:#ff8182;--warn:#e3b341;--info:#79c0ff;--ok:#56d364}}',
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--bg);color:var(--fg);',
  'font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif}',
  'header.top,main,footer{max-width:1120px;margin:0 auto;padding:16px 20px}',
  'header.top{border-bottom:1px solid var(--line)}',
  'h1{font-size:1.6em;margin:.2em 0}h2{font-size:1.3em;margin:1.6em 0 .6em;padding-bottom:.2em;border-bottom:1px solid var(--line)}',
  'h3{font-size:1.1em;margin:1.2em 0 .5em}h4{font-size:1em;margin:0 0 .4em;line-height:1.4}',
  'nav ul{list-style:none;padding:0;margin:.5em 0;display:flex;flex-wrap:wrap;gap:.4em 1.2em}',
  'a{color:var(--info)}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.88em;',
  'background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 .3em}',
  'code.url{word-break:break-all;overflow-wrap:anywhere}',
  '.muted{color:var(--muted);font-size:.92em}',
  '.stamp{display:inline-block;border:2px solid var(--warn);color:var(--warn);font-weight:700;',
  'text-transform:uppercase;letter-spacing:.06em;padding:.1em .6em;border-radius:4px;font-size:.85em}',
  '.status{font-size:1.15em;font-weight:600;margin:.4em 0}',
  '.failure,.warn{border-left:4px solid var(--warn);background:var(--card);padding:.5em .8em;margin:.6em 0}',
  '.failure{border-left-color:var(--crit)}',
  '.exit{font-size:1.2em}.exit-1,.exit-2{color:var(--crit)}.exit-0{color:var(--ok)}',
  'dl.kv{display:grid;grid-template-columns:minmax(10em,max-content) 1fr;gap:.25em 1em;margin:.6em 0}',
  'dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
  'dl.counts{display:flex;flex-wrap:wrap;gap:.6em;margin:.4em 0}',
  '.count{border:1px solid var(--line);border-radius:6px;padding:.4em .9em;min-width:7em;background:var(--card)}',
  '.count dt{font-size:.85em;color:var(--muted)}.count dd{margin:0;font-size:1.5em;font-weight:700}',
  '.count.sev-critical dd{color:var(--crit)}.count.sev-warning dd{color:var(--warn)}.count.sev-info dd{color:var(--info)}',
  '.badge{display:inline-block;font-size:.78em;font-weight:700;border-radius:999px;padding:.05em .7em;',
  'color:var(--bg);vertical-align:.1em}',
  '.badge.sev-critical{background:var(--crit)}.badge.sev-warning{background:var(--warn)}.badge.sev-info{background:var(--info)}',
  '.group{margin:1em 0 1.6em}',
  '.finding{border:1px solid var(--line);border-left:5px solid var(--line);border-radius:6px;padding:.8em 1em;',
  'margin:.8em 0;background:var(--bg)}',
  '.finding.sev-critical{border-left-color:var(--crit)}.finding.sev-warning{border-left-color:var(--warn)}',
  '.finding.sev-info{border-left-color:var(--info)}',
  'details{margin:.5em 0}summary{cursor:pointer;color:var(--muted)}',
  'ul.plain{list-style:none;padding:0;margin:0}ul.evs{list-style:none;padding:0;margin:.4em 0}',
  'li.ev{border-top:1px dashed var(--line);padding:.5em 0}',
  '.ev-type{display:inline-block;font-weight:600;font-size:.85em;background:var(--card);border:1px solid var(--line);',
  'border-radius:4px;padding:0 .4em}',
  'figure.shot{margin:.5em 0}figure.shot img{max-width:100%;height:auto;border:1px solid var(--line)}',
  'figcaption{font-size:.85em;color:var(--muted)}',
  '.scroll{overflow-x:auto}',
  'table{border-collapse:collapse;width:100%;font-size:.92em;margin:.4em 0}',
  'th,td{border:1px solid var(--line);padding:.3em .5em;text-align:left;vertical-align:top}',
  'th{background:var(--card)}td .yes,td .no{font-weight:600}.yes{color:var(--ok)}.no{color:var(--muted)}',
  'tr.st-error td{background:var(--card)}',
  'ul.diags{padding-left:1.2em}ul.diags li{margin:.5em 0}',
  'footer{color:var(--muted);font-size:.85em;border-top:1px solid var(--line);margin-top:2em}',
  '@media print{nav,summary{display:none}details{display:block}.finding{break-inside:avoid}}',
].join('');

const CSS_HASH = createHash('sha256').update(CSS).digest('base64');
export const HTML_CSP = `default-src 'none'; img-src data:; style-src 'sha256-${CSS_HASH}'; base-uri 'none'; form-action 'none'`;

const SECTION_IDS = {
  summary: 'zusammenfassung',
  findings: 'befunde',
  diagnostics: 'diagnose',
  environment: 'messumgebung',
  coverage: 'abdeckung',
  notice: 'hinweis',
} as const;

export const renderHtml: RenderReport = (report: Report, ctx: ReporterContext) => {
  const draft = isDraftReport(report, ctx);
  const target = sanitizeExternal(report.scan.target, 200);
  const sections: Array<[keyof typeof SECTION_IDS, string]> = [
    ['summary', summarySection(report, ctx)],
    ['findings', findingsSection(report, ctx)],
    ['diagnostics', diagnosticsSection(report, ctx)],
    ['environment', environmentSection(report, ctx)],
    ['coverage', coverageSection(report, ctx)],
    ['notice', noticeSection(report, ctx, draft)],
  ];
  const nav = sections
    .map(([k]) => `<li><a href="#${SECTION_IDS[k]}">${L(ctx, `section.${k}`)}</a></li>`)
    .join('');
  const body = sections
    .map(
      ([k, html]) =>
        `<section id="${SECTION_IDS[k]}">\n<h2>${L(ctx, `section.${k}`)}</h2>\n${html}\n</section>`,
    )
    .join('\n');
  const stamp = draft ? ` <span class="stamp">${x(draftStamp(ctx), 60)}</span>` : '';
  return `<!doctype html>
<html lang="${ctx.lang === 'en' ? 'en' : 'de'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">
<meta name="referrer" content="no-referrer">
<title>${LX(ctx, 'doc.title', { target })}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
<h1>${L(ctx, 'doc.heading')}${stamp}</h1>
<p>${url(report.scan.target)}</p>
<nav><strong>${L(ctx, 'nav.label')}</strong><ul>${nav}</ul></nav>
</header>
<main>
${body}
</main>
<footer><p>${L(ctx, 'footer.generated', { version: sanitizeExternal(report.tool.version, 40) })}</p></footer>
</body>
</html>
`;
};
