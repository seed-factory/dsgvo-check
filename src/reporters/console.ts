/** Console reporter: no crmCode strings; every string from a scanned site goes through `sanitizeExternal`. */
import { renderMessage, uiText } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { RenderReport, ReporterContext } from '../core/report/reporter.ts';
import type { Finding, Report, Severity } from '../core/report/schema.ts';
import { disclaimerParagraphs } from './disclaimer.ts';

const COLORS: Record<Severity, string> = {
  critical: '\u001b[31;1m',
  warning: '\u001b[33m',
  info: '\u001b[36m',
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

function paint(ctx: ReporterContext, code: string, s: string): string {
  return ctx.color ? `${code}${s}${RESET}` : s;
}

function line(s: string, max = 400): string {
  return sanitizeExternal(s, max);
}

/** Continuation lines line up under the check id: the 9-character severity label plus one space. */
const SEVERITY_LABEL_WIDTH = 9;
const INDENT = ' '.repeat(SEVERITY_LABEL_WIDTH + 1);

/** A finding lists this many pages and shows the rest as a count. */
const MAX_PAGES_SHOWN = 3;

type Translate = (key: string, params?: Record<string, string | number>) => string;

function findingBlock(f: Finding, ctx: ReporterContext): string[] {
  const msg = renderMessage(ctx.texts, f.messageId, f.params);
  const label = uiText(ctx.texts, `console.severity.${f.severity}`).padEnd(SEVERITY_LABEL_WIDTH);
  const out = [`${paint(ctx, COLORS[f.severity], label)} ${f.checkId}  ${line(msg.title, 160)}`];
  out.push(`${INDENT}${line(msg.body, 600)}`);

  if (f.pages.length > 0) {
    const shown = f.pages.slice(0, MAX_PAGES_SHOWN).map((p) => line(p, 120));
    const more = f.pages.length > MAX_PAGES_SHOWN ? ` (+${f.pages.length - MAX_PAGES_SHOWN})` : '';
    out.push(paint(ctx, DIM, `${INDENT}${uiText(ctx.texts, 'console.pages')}: ${shown.join(', ')}${more}`));
  }
  if (f.confidence !== 'high') {
    out.push(paint(ctx, DIM, `${INDENT}${uiText(ctx.texts, `console.confidence.${f.confidence}`)}`));
  }
  return out;
}

function isDraft(ctx: ReporterContext): boolean {
  return (
    Object.values(ctx.texts.ui).some((u) => u.draft) || Object.values(ctx.texts.messages).some((m) => m.draft)
  );
}

/** Title with the draft stamp, then the scan outcome: the failure or status and duration. */
function headerLines(report: Report, ctx: ReporterContext, t: Translate): string[] {
  const draft = isDraft(ctx) ? ` [${t('console.draftStamp')}]` : '';
  const title = `${t('console.title', { version: report.tool.version, target: line(report.scan.target, 200) })}${draft}`;

  if (report.scan.status === 'failed') {
    const failed = t('console.failed', {
      message: line(report.scan.failure.message, 300),
      code: report.scan.failure.code,
    });
    return [title, paint(ctx, COLORS.critical, failed)];
  }

  const seconds = Math.round((report.scan.durationMs ?? 0) / 100) / 10;
  return [title, `${t(`console.status.${report.scan.status}`)} · ${t('console.duration', { seconds })}`];
}

/** Severity counts, then one block per finding. */
function findingLines(report: Report, ctx: ReporterContext, t: Translate): string[] {
  const lines: string[] = [];

  const c = report.summary.counts;
  if (c) lines.push(t('console.counts', { critical: c.critical, warning: c.warning, info: c.info }));
  lines.push('');

  const findings = report.findings ?? [];
  if (findings.length === 0 && report.scan.status !== 'failed') lines.push(t('console.noFindings'), '');
  for (const f of findings) lines.push(...findingBlock(f, ctx), '');
  return lines;
}

function checkLines(report: Report, t: Translate): string[] {
  const checks = report.checks ?? [];
  if (checks.length === 0) return [];

  const by = (status: string) => checks.filter((c) => c.status === status).length;
  return [
    t('console.checks', {
      total: checks.length,
      completed: by('completed'),
      partial: by('partial'),
      inconclusive: by('inconclusive'),
      notApplicable: by('not_applicable'),
      skipped: by('skipped'),
      error: by('error'),
    }),
  ];
}

function diagnosticLines(report: Report, ctx: ReporterContext, t: Translate): string[] {
  return (report.diagnostics ?? []).map((d) => {
    const msg = renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, d.params ?? {});
    const affects = d.affects.length ? ` (${d.affects.join(', ')})` : '';
    return `${t('console.diagnostic')} ${d.code}: ${line(msg.title, 200)}${affects}`;
  });
}

function exitLines(report: Report, ctx: ReporterContext, t: Translate): string[] {
  const reasons = report.summary.exitReasons.length ? report.summary.exitReasons.join(', ') : '–';
  return [
    t('console.exit', { code: report.summary.exitCode, reasons }),
    '',
    ...disclaimerParagraphs(report, ctx.texts).map((p) => paint(ctx, DIM, line(p, 4000))),
  ];
}

export const renderConsole: RenderReport = (report: Report, ctx: ReporterContext) => {
  const t: Translate = (key, params = {}) => uiText(ctx.texts, key, params);
  const lines = [
    ...headerLines(report, ctx, t),
    ...findingLines(report, ctx, t),
    ...checkLines(report, t),
    ...diagnosticLines(report, ctx, t),
    ...exitLines(report, ctx, t),
  ];
  return `${lines.join('\n')}\n`;
};
