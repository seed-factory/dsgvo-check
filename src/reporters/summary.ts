/**
 * GitHub Job Summary / Markdown reporter (owner: M6). Written to `summary.md`; scan.ts also appends it to
 * $GITHUB_STEP_SUMMARY when that variable is set.
 * Safety: external strings are sanitized (`sanitizeExternal`), HTML-escaped and Markdown-escaped; URLs are never
 * turned into links (no autolinks), no images, no crmCode / `T[0-9]_` strings (5.6). Size stays far below the
 * 1 MiB step summary limit.
 */
import { renderMessage } from '../core/messages.ts';
import type { Finding, MessageParams, Report } from '../core/report-schema.ts';
import type { RenderReport, ReporterContext } from '../core/reporter.ts';
import { sanitizeExternal } from '../core/sanitize.ts';
import { disclaimerParagraphs } from './disclaimer.ts';
import {
  draftStamp,
  failedChecks,
  isDraftReport,
  type ReportLabelKey,
  reportLabel,
  sortFindings,
} from './html.ts';

export const SUMMARY_MAX_FINDINGS = 50;
const MAX_BYTES = 512 * 1024;

const WORD_JOINER = '⁠';

/**
 * Inline text for Markdown: sanitized (no newlines, so it never starts a block), HTML special characters as
 * entities, inline Markdown punctuation backslash-escaped, autolink triggers (`www.`, `scheme://`, e-mail `@`)
 * broken so scanned URLs never become clickable links.
 */
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

/** Trusted label (data/texts or built-in) with external params escaped. */
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

function findingTitle(f: Finding, ctx: ReporterContext): string {
  if (ctx.texts.messages[f.messageId]) {
    const params: MessageParams = {};
    for (const [k, v] of Object.entries(f.params)) params[k] = typeof v === 'string' ? mdText(v, 200) : v;
    return trusted(renderMessage(ctx.texts, f.messageId, params).title, 600);
  }
  return mdText(f.text?.title ?? f.messageId, 300);
}

export const renderSummary: RenderReport = (report: Report, ctx: ReporterContext) => {
  const out: string[] = [];
  const draft = isDraftReport(report, ctx) ? ` · **${mdText(draftStamp(ctx), 40)}**` : '';
  out.push(`## dsgvo-check – ${mdText(report.scan.target, 200)}${draft}`, '');

  const reasons = report.summary.exitReasons.length
    ? report.summary.exitReasons.map((r) => mdCode(r)).join(', ')
    : label(ctx, 'summary.none');
  out.push(
    `**${label(ctx, `status.${report.scan.status}`)}** · ${label(ctx, 'summary.exitCode')} **${report.summary.exitCode}** (${reasons})`,
    '',
  );
  if (report.scan.failure) {
    out.push(
      `> ${label(ctx, 'summary.failure', { message: report.scan.failure.message, code: report.scan.failure.code })}`,
      '',
    );
  }
  if (report.scan.environment?.sandbox.mode === 'off') out.push(`> ${label(ctx, 'summary.sandboxOff')}`, '');

  const c = report.summary.counts;
  if (c) {
    const heads = [
      label(ctx, 'severity.critical'),
      label(ctx, 'severity.warning'),
      label(ctx, 'severity.info'),
      label(ctx, 'summary.checkErrors'),
      label(ctx, 'summary.inconclusive'),
    ];
    out.push(`| ${heads.map(cell).join(' | ')} |`, `|${' ---: |'.repeat(heads.length)}`);
    out.push(`| ${[c.critical, c.warning, c.info, c.checkErrors, c.inconclusive].join(' | ')} |`, '');
  }

  const errs = failedChecks(report);
  if (report.summary.exitCode === 1 && errs.length > 0) {
    out.push(`> ${label(ctx, 'summary.checkErrorsWithThreshold', { checks: errs.join(', ') })}`, '');
  }

  const findings = sortFindings(report.findings ?? []);
  if (report.scan.status !== 'failed') {
    out.push(`### ${label(ctx, 'section.findings')}`, '');
    if (findings.length === 0) {
      out.push(label(ctx, 'findings.none'), '');
    } else {
      const heads = [
        'summary.column.severity',
        'summary.column.check',
        'summary.column.finding',
        'summary.column.pages',
      ] as const;
      out.push(`| ${heads.map((h) => cell(label(ctx, h))).join(' | ')} |`, '| --- | --- | --- | ---: |');
      for (const f of findings.slice(0, SUMMARY_MAX_FINDINGS)) {
        const service = f.serviceId ? ` (${mdCode(f.serviceId, 80)})` : '';
        out.push(
          `| ${cell(label(ctx, `severity.${f.severity}`))} | ${mdCode(f.checkId, 20)} | ${cell(findingTitle(f, ctx))}${cell(service)} | ${f.pages.length} |`,
        );
      }
      out.push('');
      if (findings.length > SUMMARY_MAX_FINDINGS) {
        out.push(label(ctx, 'summary.more', { count: findings.length - SUMMARY_MAX_FINDINGS }), '');
      }
    }
  }

  const diags = report.diagnostics ?? [];
  if (diags.length) {
    out.push(`### ${label(ctx, 'section.diagnostics')}`, '');
    for (const d of diags) {
      const params: MessageParams = {};
      for (const [k, v] of Object.entries(d.params ?? {}))
        params[k] = typeof v === 'string' ? mdText(v, 200) : v;
      const title = trusted(
        renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, params).title,
        600,
      );
      const affects = d.affects.length ? ` (${d.affects.map((a) => mdCode(a, 20)).join(', ')})` : '';
      out.push(`- ${mdCode(d.code, 40)} ${title}${affects}`);
    }
    out.push('');
  }

  if (report.scan.status !== 'failed') out.push(`${label(ctx, 'summary.files')}`, '');
  for (const p of disclaimerParagraphs(report, ctx.texts)) out.push(`<sub>${mdText(p, 3000)}</sub>`, '');

  let md = `${out.join('\n')}\n`;
  if (Buffer.byteLength(md) > MAX_BYTES) md = `${md.slice(0, MAX_BYTES / 4)}\n\n…\n`;
  return md;
};
