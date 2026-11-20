import { formatMessage } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { MessageParams, Report } from '../core/report/schema.ts';
import type { Item, Row } from './evidence-view.ts';

export type ReportLabelKey = string;

export function reportLabel(ctx: ReporterContext, key: ReportLabelKey, params: MessageParams = {}): string {
  const entry = ctx.texts.ui[`report.${key}`];
  if (!entry) throw new Error(`Unknown report label: ${key}`);
  return formatMessage(entry.text, params, ctx.lang);
}

export const text = (value: unknown, max = 2000): string =>
  value === null || value === undefined ? '–' : sanitizeExternal(String(value), max);

export const item = (value: unknown, max = 2000, code = false): Item => ({
  text: text(value, max),
  code,
  url: false,
  href: null,
});
export const urlItem = (value: unknown): Item => ({ ...item(value), url: true });

/** Label and row builders of one view: a label and its string parameters are cleaned and length-capped on the way in. */
export interface ViewText {
  label: (key: string, params?: MessageParams) => string;
  row: (key: string, value: unknown, max?: number) => Row;
  rows: (key: string, values: Item[]) => Row;
  /**
   * A phase with what happened in it (B after a reject, or a visit without one); `B:before-click` names the first screen
   * of B or C before its click; `short` for table cells.
   */
  phase: (phase: string, short?: boolean) => string;
}

type PhaseOutcome = 'done' | 'unverified' | 'not-clicked' | '';

/**
 * What the click of phase B (reject) and C (accept) did on the start page. A phase without a click is a further visit
 * and must not read as "after reject"; reports of earlier versions carry no click outcome and keep the plain label.
 */
function phaseOutcomes(report: Report): Record<string, PhaseOutcome> {
  const actions = report.scan.coverage?.consentActions;
  const outcome = (action: 'reject' | 'accept'): PhaseOutcome => {
    const a = actions?.find((x) => x.action === action);
    if (!a) return '';
    if (!a.clicked) return 'not-clicked';
    return a.verified === false ? 'unverified' : 'done';
  };
  return { B: outcome('reject'), C: outcome('accept') };
}

export function viewText(report: Report, ctx: ReporterContext): ViewText {
  const label = (key: string, params: MessageParams = {}) => {
    const clean: MessageParams = {};
    for (const [name, value] of Object.entries(params)) {
      clean[name] = typeof value === 'string' ? sanitizeExternal(value, 500) : value;
    }
    return sanitizeExternal(reportLabel(ctx, key, clean), 4000);
  };
  const outcomes = phaseOutcomes(report);
  return {
    label,
    row: (key, value, max = 2000) => ({ label: label(key), items: [item(value, max)] }),
    rows: (key, values) => ({ label: label(key), items: values }),
    phase: (key, short = false) => {
      const [phase = key, moment] = key.split(':');
      const outcome = moment === 'before-click' ? 'before-click' : (outcomes[phase] ?? '');
      return label(short ? 'phaseShort' : 'phase', { phase, outcome });
    },
  };
}

export const phaseList = (phases: readonly string[], v: ViewText, short = false): string =>
  [...new Set(phases)]
    .sort((a, b) => a.localeCompare(b))
    .map((phase) => v.phase(phase, short))
    .join(', ');
