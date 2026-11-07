/**
 * Disclaimer with conditional paragraphs (`ui.disclaimer.*` in the core texts), each added only when its condition holds
 * in the report. Reporters compose it again from the final report because exit reasons may change while writing.
 */

import type { ReportDetail } from '../report/reporter.ts';
import type { MessageParams, Report } from '../report/schema.ts';
import type { Texts } from './load.ts';
import { uiText } from './messages.ts';

/** Paragraph keys in rendering order after the base: scope, data, conditions, draft, usage. */
export const DISCLAIMER_KEYS = [
  'disclaimer.noFinding',
  'disclaimer.dependence',
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
  'disclaimer.phaseCFailed',
  'disclaimer.draft',
  'disclaimer.usage',
] as const;

export type DisclaimerKey = (typeof DISCLAIMER_KEYS)[number];

/** One paragraph with the key it came from; `disclaimer` is the base text. */
export interface DisclaimerEntry {
  key: 'disclaimer' | DisclaimerKey;
  text: string;
}

export interface DisclaimerOptions {
  /** `brief` is the report for the site owner: its paragraphs leave the command-line options out. */
  detail?: ReportDetail;
  /** The HTML report prints its own draft line next to the stamp; the paragraph would repeat it. */
  withoutDraft?: boolean;
}

/**
 * Phase C as the disclaimer and the first page describe it: `performed` (the accept click succeeded), `unverified`
 * (clicked, but the CMP state did not confirm it), `failed` (phase C ran without a successful click) or null.
 */
export type PhaseCState = 'performed' | 'unverified' | 'failed' | null;

export function phaseCState(report: Report): PhaseCState {
  const coverage = report.scan.coverage;
  const actions = coverage?.consentActions;
  // Reports of earlier versions carry no click outcome: a visit in phase C is all they tell.
  if (!actions) return (coverage?.pages ?? []).some((p) => p.phases.includes('C')) ? 'performed' : null;

  const accept = actions.find((a) => a.action === 'accept');
  if (!accept) return null;
  if (!accept.clicked) return 'failed';
  return accept.verified === false ? 'unverified' : 'performed';
}

/** Exit reason codes in words (`exitReason` in the core texts); check ids stay as they are. */
export function exitReasonText(texts: Texts, reason: string): string {
  if (!texts.ui.exitReason) return reason;
  const withCheck = /^(check-error|strict:inconclusive):(.+)$/.exec(reason);
  const code = (withCheck?.[1] ?? reason).replace(/:/g, '-');
  return uiText(texts, 'exitReason', { code, check: withCheck?.[2] ?? '', reason });
}

/** Paragraphs whose condition holds, with their parameters. */
function applicable(report: Report, texts: Texts): Array<[DisclaimerKey, MessageParams]> {
  const { scan } = report;
  const env = scan.environment;
  const options = scan.options;
  const out: Array<[DisclaimerKey, MessageParams]> = [
    ['disclaimer.noFinding', {}],
    ['disclaimer.dependence', {}],
    ['disclaimer.data', {}],
  ];

  // The paragraph describes images that exist, not only the option.
  const screenshots = (report.evidence ?? []).some((e) => e.type === 'screenshot');
  if (options?.screenshots === true && screenshots) out.push(['disclaimer.screenshots', {}]);

  // A banner its adapter recognised, whose first layer could not be read, was attributed to a supported provider.
  if (
    (report.findings ?? []).some(
      (f) =>
        f.checkId === 'CONSENT-04' &&
        (f.variant === 'cmp-not-supported' ||
          (f.variant === 'banner-not-recognized' && f.params.bannerRecognized !== true)),
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
    // Findings above the threshold explain the exit code, not a gap in the scan.
    const reasons = report.summary.exitReasons
      .filter((r) => r !== 'threshold')
      .map((r) => exitReasonText(texts, r));
    out.push([
      'disclaimer.incomplete',
      { status: scan.status, hasReasons: reasons.length > 0, reasons: reasons.join(', ') },
    ]);
  }

  const phaseC = phaseCState(report);
  if (phaseC === 'performed' || phaseC === 'unverified') {
    out.push(['disclaimer.phaseC', { verified: phaseC === 'performed' }]);
  }
  if (phaseC === 'failed') out.push(['disclaimer.phaseCFailed', {}]);
  if (report.disclaimer.draft) out.push(['disclaimer.draft', {}]);
  out.push(['disclaimer.usage', {}]);
  return out;
}

/** Base text paragraphs followed by every applicable paragraph (missing texts are skipped), each with its key. */
export function disclaimerEntries(
  report: Report,
  texts: Texts,
  opts: DisclaimerOptions = {},
): DisclaimerEntry[] {
  // Always the base of the language being rendered: a report saved in German and rendered with --lang en must not
  // keep the German text. The saved text is the base only where the texts have none.
  const base = texts.ui.disclaimer ? uiText(texts, 'disclaimer') : report.disclaimer.text;
  const out: DisclaimerEntry[] = base
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ key: 'disclaimer', text }));

  const detail = opts.detail ?? 'full';
  for (const [key, params] of applicable(report, texts)) {
    if (!texts.ui[key] || (key === 'disclaimer.draft' && opts.withoutDraft)) continue;
    const text = uiText(texts, key, { detail, ...params });
    // A saved base from before the split already contains the scope sentences.
    if (!out.some((e) => e.text === text || (e.key === 'disclaimer' && e.text.includes(text))))
      out.push({ key, text });
  }
  return out;
}

export function disclaimerParagraphs(report: Report, texts: Texts, opts: DisclaimerOptions = {}): string[] {
  return disclaimerEntries(report, texts, opts).map((e) => e.text);
}

/** The disclaimer as one text, paragraphs separated by a blank line (JSON `disclaimer.text`). */
export function disclaimerText(report: Report, texts: Texts): string {
  return disclaimerParagraphs(report, texts).join('\n\n');
}
