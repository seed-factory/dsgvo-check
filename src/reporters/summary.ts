/**
 * GitHub Job Summary / Markdown reporter, written to `summary.md` (scan.ts also appends it to $GITHUB_STEP_SUMMARY).
 * External strings are sanitized and escaped, URLs never become links, there are no images and no crmCode strings.
 */

import { reporterLimits } from '../core/config/limits.ts';
import { renderMessage } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { RenderReport, ReporterContext } from '../core/report/reporter.ts';
import type { Finding, MessageParams, Report } from '../core/report/schema.ts';
import { disclaimerParagraphs } from './disclaimer.ts';
import {
  draftStamp,
  failedChecks,
  isDraftReport,
  type ReportLabelKey,
  reportLabel,
  sortFindings,
} from './report-view.ts';

export const SUMMARY_MAX_FINDINGS = reporterLimits().summaryMaxFindings;

/** Invisible word joiner inserted into `www.` and `scheme://`, so Markdown renderers do not turn scanned URLs into links. */
const WORD_JOINER = '⁠';

const FINDING_COLUMNS = [
  'summary.column.severity',
  'summary.column.check',
  'summary.column.finding',
  'summary.column.pages',
] as const;

/** Inline Markdown text: sanitized, HTML and Markdown punctuation escaped, autolink triggers broken so scanned URLs never become links. */
export function mdText(value: unknown, max = 300): string {
  if (value === null || value === undefined) return '–';
  return sanitizeExternal(String(value), max)
    .replace(/(www)\./gi, `$1${WORD_JOINER}.`)
    .replace(/\b([a-z][a-z0-9+.-]*)(:\/\/)/gi, `$1${WORD_JOINER}$2`)
    .replace(/[\\`*_{}[\]()|~@]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Code span for tool-controlled identifiers (exit reasons, check ids, codes). */
function mdCode(value: string, max = 120): string {
  const s = sanitizeExternal(value, max).replace(/`/g, "'").replace(/\|/g, '\\|');
  return `\`${s}\``;
}

/** Trusted label (test/data/texts or built-in) with external params escaped. */
function label(ctx: ReporterContext, key: ReportLabelKey, params: Record<string, unknown> = {}): string {
  const clean: MessageParams = {};
  for (const [k, v] of Object.entries(params)) {
    clean[k] = typeof v === 'number' || typeof v === 'boolean' || v === null ? v : mdText(v, 300);
  }
  return trusted(reportLabel(ctx, key, clean), 2000);
}

/** Trusted rendered text (params already escaped): single line, crm pattern broken. */
function trusted(s: string, max: number): string {
  const one = s.replace(/[\r\n\t]+/g, ' ');
  return (one.length > max ? `${one.slice(0, max - 1)}…` : one).replace(/T(\d)_/g, 'T$1\\_');
}

function cell(s: string): string {
  return s.replace(/(?<!\\)\|/g, '\\|');
}

/** Message params with every string escaped for Markdown and capped at `max` characters. */
function escapedParams(params: MessageParams, max: number): MessageParams {
  const out: MessageParams = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === 'string' ? mdText(v, max) : v;
  return out;
}

function findingTitle(f: Finding, ctx: ReporterContext): string {
  if (ctx.texts.messages[f.messageId]) {
    return trusted(renderMessage(ctx.texts, f.messageId, escapedParams(f.params, 200)).title, 600);
  }
  return mdText(f.text?.title ?? f.messageId, 300);
}

/** Heading, status line with the exit code and reasons, and the failure and sandbox notes. */
function headerLines(report: Report, ctx: ReporterContext): string[] {
  const draft = isDraftReport(report, ctx) ? ` · **${mdText(draftStamp(ctx), 40)}**` : '';
  const reasons = report.summary.exitReasons.length
    ? report.summary.exitReasons.map((r) => mdCode(r)).join(', ')
    : label(ctx, 'summary.none');

  const out = [
    `## dsgvo-check – ${mdText(report.scan.target, 200)}${draft}`,
    '',
    `**${label(ctx, `status.${report.scan.status}`)}** · ${label(ctx, 'summary.exitCode')} **${report.summary.exitCode}** (${reasons})`,
    '',
  ];
  if (report.scan.failure) {
    const failure = label(ctx, 'summary.failure', {
      message: report.scan.failure.message,
      code: report.scan.failure.code,
    });
    out.push(`> ${failure}`, '');
  }
  if (report.scan.environment?.sandbox.mode === 'off') out.push(`> ${label(ctx, 'summary.sandboxOff')}`, '');
  return out;
}

/** One-row table of the severity and check-error counts. */
function countsTable(c: NonNullable<Report['summary']['counts']>, ctx: ReporterContext): string[] {
  const heads = [
    label(ctx, 'severity.critical'),
    label(ctx, 'severity.warning'),
    label(ctx, 'severity.info'),
    label(ctx, 'summary.checkErrors'),
    label(ctx, 'summary.inconclusive'),
  ];
  return [
    `| ${heads.map(cell).join(' | ')} |`,
    `|${' ---: |'.repeat(heads.length)}`,
    `| ${[c.critical, c.warning, c.info, c.checkErrors, c.inconclusive].join(' | ')} |`,
    '',
  ];
}

function findingsSection(findings: readonly Finding[], ctx: ReporterContext, maxFindings: number): string[] {
  const out = [`### ${label(ctx, 'section.findings')}`, ''];
  if (findings.length === 0) return [...out, label(ctx, 'findings.none'), ''];

  out.push(
    `| ${FINDING_COLUMNS.map((h) => cell(label(ctx, h))).join(' | ')} |`,
    '| --- | --- | --- | ---: |',
  );
  for (const f of findings.slice(0, maxFindings)) {
    const service = f.serviceId ? ` (${mdCode(f.serviceId, 80)})` : '';
    out.push(
      `| ${cell(label(ctx, `severity.${f.severity}`))} | ${mdCode(f.checkId, 20)} | ${cell(findingTitle(f, ctx))}${cell(service)} | ${f.pages.length} |`,
    );
  }
  out.push('');
  if (findings.length > maxFindings) {
    out.push(label(ctx, 'summary.more', { count: findings.length - maxFindings }), '');
  }
  return out;
}

function diagnosticsSection(diagnostics: NonNullable<Report['diagnostics']>, ctx: ReporterContext): string[] {
  const out = [`### ${label(ctx, 'section.diagnostics')}`, ''];
  for (const d of diagnostics) {
    const params = escapedParams(d.params ?? {}, 200);
    const title = trusted(renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, params).title, 600);
    const affects = d.affects.length ? ` (${d.affects.map((a) => mdCode(a, 20)).join(', ')})` : '';
    out.push(`- ${mdCode(d.code, 40)} ${title}${affects}`);
  }
  out.push('');
  return out;
}

export const renderSummary: RenderReport = (report: Report, ctx: ReporterContext) => {
  const { summaryMaxFindings: maxFindings, summaryMaxBytes: maxBytes } = ctx.limits ?? reporterLimits();
  const failed = report.scan.status === 'failed';
  const out = headerLines(report, ctx);

  if (report.summary.counts) out.push(...countsTable(report.summary.counts, ctx));

  const errs = failedChecks(report);
  if (report.summary.exitCode === 1 && errs.length > 0) {
    out.push(`> ${label(ctx, 'summary.checkErrorsWithThreshold', { checks: errs.join(', ') })}`, '');
  }

  if (!failed) out.push(...findingsSection(sortFindings(report.findings ?? []), ctx, maxFindings));

  const diags = report.diagnostics ?? [];
  if (diags.length) out.push(...diagnosticsSection(diags, ctx));

  if (!failed) out.push(`${label(ctx, 'summary.files')}`, '');
  for (const p of disclaimerParagraphs(report, ctx.texts)) out.push(`<sub>${mdText(p, 3000)}</sub>`, '');

  let md = `${out.join('\n')}\n`;
  if (Buffer.byteLength(md) > maxBytes) md = `${md.slice(0, maxBytes / 4)}\n\n…\n`;
  return md;
};
