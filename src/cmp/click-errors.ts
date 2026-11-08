/**
 * Codes of a click, of the settings layer it opens and of a reload in `verify` that did not happen. The adapters give
 * them (base.ts), and of a click and a settings layer the collector keeps no other (consent-phase.ts), so that the two
 * cannot drift apart. A code names the kind of failure, never Playwright's message: its first line repeats the
 * selector, which is built from the page's attributes, the call log after it quotes the page's markup, and a navigation
 * error names the URLs the page went to, with their query. The module loads nothing else of the CMP subsystem, so the
 * collector imports it directly.
 */
import {
  errorText,
  PAGE_CALL_FAILURE_KINDS,
  type PageCallFailureKind,
  pageCallFailure,
} from '../collectors/browser/util.ts';
import type { FirstLayerVariant } from './types.ts';

/** A code alone, or with the kind of failure `pageCallFailure` names after a `:`. */
type WithKind<C extends string> = C | `${C}:${PageCallFailureKind}`;

const withKinds = <C extends string>(code: C): Array<WithKind<C>> => [
  code,
  ...PAGE_CALL_FAILURE_KINDS.map((kind): WithKind<C> => `${code}:${kind}`),
];

export const CLICK_ERRORS = [
  'no-selector',
  'invalid-selector',
  'target-not-found',
  'target-ambiguous',
  'target-changed',
  'no-target',
  'no-settings-layer',
  ...withKinds('click-failed'),
] as const;

type Action = 'reject' | 'accept';
/** Core found nothing to click; the variant of the first layer when the adapter asked core itself. */
type NoTarget = `no-unambiguous-${Action}` | `no-unambiguous-${Action}:${FirstLayerVariant}`;
const NO_TARGET = /^no-unambiguous-(?:reject|accept)(?::[a-z-]{1,40})?$/;

export const noTarget = (action: Action, variant?: FirstLayerVariant): NoTarget =>
  variant ? `no-unambiguous-${action}:${variant}` : `no-unambiguous-${action}`;

export type ClickError = (typeof CLICK_ERRORS)[number] | NoTarget;

export function isClickError(code: string): code is ClickError {
  return (CLICK_ERRORS as readonly string[]).includes(code) || NO_TARGET.test(code);
}

function withKind<C extends string>(code: C, err: unknown): WithKind<C> {
  const kind = PAGE_CALL_FAILURE_KINDS.find((k) => k === pageCallFailure(err));
  return kind ? `${code}:${kind}` : code;
}

/** A failed `locator.click()`: `target-ambiguous` when strict mode found several elements, else `click-failed`. */
export function clickFailure(err: unknown): ClickError {
  if (/strict mode violation/i.test(errorText(err))) return 'target-ambiguous';
  return withKind('click-failed', err);
}

export function reloadFailure(err: unknown): WithKind<'reload-failed'> {
  return withKind('reload-failed', err);
}
