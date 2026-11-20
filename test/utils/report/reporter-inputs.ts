/**
 * Reporter inputs next to the sample reports: the context a reporter gets, check results without severity data and the
 * banner clicks of a scan.
 */
import { loadTexts } from '../../../src/core/data/load.ts';
import type { ReporterContext } from '../../../src/core/report/reporter.ts';
import type { CheckResult, ConsentAction, Lang } from '../../../src/core/report/schema.ts';

/** The context of a reporter run in `lang`; the output folder does not exist, so no screenshot file is read. */
export const reporterContext = (lang: Lang = 'de', over: Partial<ReporterContext> = {}): ReporterContext => ({
  texts: loadTexts(lang),
  lang,
  outDir: '/nonexistent-out',
  color: false,
  ...over,
});

/** Browser texts may carry external params, so a CONSENT-01 message with params exercises their escaping. */
export function withTrackerHitMessage(ctx: ReporterContext): ReporterContext {
  ctx.texts.messages['CONSENT-01.tracker-hit'] = {
    title: 'Tracker {service} auf {host} beobachtet',
    body: 'Anfrage an {host} vor einer Einwilligung beobachtet.',
    draft: true,
  };
  return ctx;
}

export const checkResult = (
  id: string,
  status: CheckResult['status'],
  reason: string | null,
  module = 'browser',
): CheckResult => ({ id, module, status, reason, limitations: [], coverage: null, durationMs: 1 });

/** What became of a banner click: not made, made and confirmed by the CMP state, or made and not confirmed. */
type Click = 'not-clicked' | 'confirmed' | 'unconfirmed';

const CLICK: Record<Click, Omit<ConsentAction, 'action'>> = {
  'not-clicked': { clicked: false, verified: null },
  confirmed: { clicked: true, verified: true },
  unconfirmed: { clicked: true, verified: false },
};

/** The banner clicks of phase B (reject) and phase C (accept). */
export const consentClicks = (clicks: { reject: Click; accept: Click }): ConsentAction[] => [
  { action: 'reject', ...CLICK[clicks.reject] },
  { action: 'accept', ...CLICK[clicks.accept] },
];
