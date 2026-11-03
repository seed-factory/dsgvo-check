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

function findingBlock(f: Finding, ctx: ReporterContext): string[] {
  const msg = renderMessage(ctx.texts, f.messageId, f.params);
  const label = uiText(ctx.texts, `console.severity.${f.severity}`).padEnd(9);
  const out = [`${paint(ctx, COLORS[f.severity], label)} ${f.checkId}  ${line(msg.title, 160)}`];
  out.push(`          ${line(msg.body, 600)}`);
  if (f.pages.length > 0) {
    const shown = f.pages.slice(0, 3).map((p) => line(p, 120));
    const more = f.pages.length > 3 ? ` (+${f.pages.length - 3})` : '';
    out.push(paint(ctx, DIM, `          ${uiText(ctx.texts, 'console.pages')}: ${shown.join(', ')}${more}`));
  }
  if (f.confidence !== 'high') {
    out.push(paint(ctx, DIM, `          ${uiText(ctx.texts, `console.confidence.${f.confidence}`)}`));
  }
  return out;
}

function isDraft(ctx: ReporterContext): boolean {
  return (
    Object.values(ctx.texts.ui).some((u) => u.draft) || Object.values(ctx.texts.messages).some((m) => m.draft)
  );
}

export const renderConsole: RenderReport = (report: Report, ctx: ReporterContext) => {
  const t = (key: string, params: Record<string, string | number> = {}) => uiText(ctx.texts, key, params);
  const lines: string[] = [];
  const draft = isDraft(ctx) ? ` [${t('console.draftStamp')}]` : '';
  lines.push(
    `${t('console.title', { version: report.tool.version, target: line(report.scan.target, 200) })}${draft}`,
  );

  if (report.scan.status === 'failed') {
    lines.push(
      paint(
        ctx,
        COLORS.critical,
        t('console.failed', {
          message: line(report.scan.failure.message, 300),
          code: report.scan.failure.code,
        }),
      ),
    );
  } else {
    const seconds = Math.round((report.scan.durationMs ?? 0) / 100) / 10;
    lines.push(`${t(`console.status.${report.scan.status}`)} · ${t('console.duration', { seconds })}`);
  }

  const findings = report.findings ?? [];
  if (report.summary.counts) {
    const c = report.summary.counts;
    lines.push(t('console.counts', { critical: c.critical, warning: c.warning, info: c.info }));
  }
  lines.push('');
  if (findings.length === 0 && report.scan.status !== 'failed') lines.push(t('console.noFindings'), '');
  for (const f of findings) lines.push(...findingBlock(f, ctx), '');

  const checks = report.checks ?? [];
  if (checks.length > 0) {
    const by = (s: string) => checks.filter((c) => c.status === s).length;
    lines.push(
      t('console.checks', {
        total: checks.length,
        completed: by('completed'),
        partial: by('partial'),
        inconclusive: by('inconclusive'),
        notApplicable: by('not_applicable'),
        skipped: by('skipped'),
        error: by('error'),
      }),
    );
  }
  for (const d of report.diagnostics ?? []) {
    const msg = renderMessage(ctx.texts, d.messageId ?? `diagnostic.${d.code}`, d.params ?? {});
    const affects = d.affects.length ? ` (${d.affects.join(', ')})` : '';
    lines.push(`${t('console.diagnostic')} ${d.code}: ${line(msg.title, 200)}${affects}`);
  }
  const reasons = report.summary.exitReasons.length ? report.summary.exitReasons.join(', ') : '–';
  lines.push(t('console.exit', { code: report.summary.exitCode, reasons }));
  lines.push('');
  for (const p of disclaimerParagraphs(report, ctx.texts)) lines.push(paint(ctx, DIM, line(p, 4000)));
  return `${lines.join('\n')}\n`;
};
