/**
 * Disclaimer with conditional paragraphs (wording guide §6). The base text is the report's
 * `disclaimer.text` (built by core); the other paragraphs come from `test/data/texts/<lang>/core.yaml` (`ui.disclaimer.*`).
 * A conditional paragraph is added only when its condition holds in the report, so the text always stays true.
 * scan() composes `disclaimer.text` of the in-memory report with it; every reporter renders the paragraphs
 * again from the final report (exit reasons may change while writing). A text composed from the same base is
 * composed anew; a paragraph that a foreign base already carries is not added again.
 */
import type { Texts } from './data.ts';
import { uiText } from './messages.ts';
import type { MessageParams, Report } from './report-schema.ts';

/** Paragraph keys in rendering order (guide §6): data, conditions, draft, usage. */
export const DISCLAIMER_KEYS = [
  'disclaimer.data',
  'disclaimer.screenshots',
  'disclaimer.bannerNotRecognized',
  'disclaimer.botOrGeo',
  'disclaimer.egressUnknown',
  'disclaimer.egressAsserted',
  'disclaimer.proxy',
  'disclaimer.sandboxOff',
  'disclaimer.incomplete',
  'disclaimer.phaseC',
  'disclaimer.draft',
  'disclaimer.usage',
] as const;

export type DisclaimerKey = (typeof DISCLAIMER_KEYS)[number];

/** Phase C ("Alle akzeptieren") visited at least one page: the scanner's IP reached the site's third parties. */
export function phaseCPerformed(report: Report): boolean {
  return (report.scan.coverage?.pages ?? []).some((p) => p.phases.includes('C'));
}

/** Paragraphs whose condition holds, with their parameters. */
function applicable(report: Report): Array<[DisclaimerKey, MessageParams]> {
  const { scan } = report;
  const env = scan.environment;
  const options = scan.options;
  const out: Array<[DisclaimerKey, MessageParams]> = [['disclaimer.data', {}]];

  if (options?.screenshots === true) out.push(['disclaimer.screenshots', {}]);

  if (
    (report.findings ?? []).some(
      (f) =>
        f.checkId === 'CONSENT-04' &&
        (f.variant === 'banner-not-recognized' || f.variant === 'cmp-not-supported'),
    )
  ) {
    out.push(['disclaimer.bannerNotRecognized', {}]);
  }

  const botOrGeo = (report.diagnostics ?? []).filter(
    (d) => d.code === 'SCAN-GEO' || d.code === 'SCAN-BOTMODE',
  );
  if (botOrGeo.length > 0) {
    const checks = [...new Set(botOrGeo.flatMap((d) => d.affects))].sort();
    out.push(['disclaimer.botOrGeo', { checks: checks.join(', ') || '–' }]);
  }

  const consentActive = (report.checks ?? []).some(
    (c) => c.id.startsWith('CONSENT-') && c.status !== 'skipped',
  );
  if (env?.egress.region === 'unknown' && consentActive) out.push(['disclaimer.egressUnknown', {}]);

  const asserted =
    (env?.egress.region === 'asserted' ? env.egress.assertedRegion : undefined) ??
    options?.assumeRegion ??
    null;
  if (asserted) out.push(['disclaimer.egressAsserted', { region: asserted }]);

  if (options?.proxy === true || env?.egress.mode === 'proxy') out.push(['disclaimer.proxy', {}]);

  if (env?.sandbox.mode === 'off' || options?.sandbox === 'off') out.push(['disclaimer.sandboxOff', {}]);

  if (scan.status !== 'complete') {
    const reasons = report.summary.exitReasons;
    out.push([
      'disclaimer.incomplete',
      { status: scan.status, hasReasons: reasons.length > 0, reasons: reasons.join(', ') },
    ]);
  }

  if (phaseCPerformed(report)) out.push(['disclaimer.phaseC', {}]);
  if (report.disclaimer.draft) out.push(['disclaimer.draft', {}]);
  out.push(['disclaimer.usage', {}]);
  return out;
}

/** Base text paragraphs followed by every applicable paragraph (missing texts are skipped). */
export function disclaimerParagraphs(report: Report, texts: Texts): string[] {
  // A text composed earlier (scan() or a previous rendering) starts with the base of these texts: compose it anew
  // from the base, so a changed condition (e.g. exit reasons after a failed write) replaces its paragraph.
  const own = texts.ui.disclaimer ? uiText(texts, 'disclaimer') : null;
  const base = own && report.disclaimer.text.startsWith(own) ? own : report.disclaimer.text;
  const out = base
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const [key, params] of applicable(report)) {
    if (!texts.ui[key]) continue;
    const text = uiText(texts, key, params);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** The disclaimer as one text, paragraphs separated by a blank line (JSON `disclaimer.text`). */
export function disclaimerText(report: Report, texts: Texts): string {
  return disclaimerParagraphs(report, texts).join('\n\n');
}
