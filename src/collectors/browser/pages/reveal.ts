// Content below the first screen: after the first-screen facts of a page the viewport is set to the document height for
// a short stay and then restored. Off-screen frames and lazy embeds (maps, videos, their fonts) then load as they do
// for a visitor who scrolls down, while the page sees no scroll, wheel or input event: a banner that takes scrolling as
// consent is not triggered, and phase A still observes without interaction.
import type { Page } from 'playwright-core';
import type { RevealFacts } from '../../../core/snapshot/browser.ts';
import type { Viewport } from '../../../core/snapshot/common.ts';
import type { PhaseTiming } from '../config.ts';
import { type RawScrollFacts, scrollFactsInPage } from '../in-page/dom.ts';
import { fields } from '../page-values.ts';
import { waitForQuiet } from '../recording/quiet.ts';
import type { NetworkRecorder } from '../recording/recorder.ts';
import { TimeoutError, withTimeout } from '../util.ts';

/** Attempts to set the first-screen viewport again; a second one covers a call the browser refused once. */
const RESTORE_ATTEMPTS = 2;

/**
 * A viewport call that did not settle in time keeps running and may still land after a later one, also after a restore
 * that Playwright answered from its own record of the size: nothing after it confirms the first screen.
 */
const unsettled = (err: unknown): boolean => err instanceof TimeoutError;

/** `browser.revealDwellMs` within the hard cap of the phase; 0 switches the step off. */
export function revealDwellMs(configuredMs: number, phase: PhaseTiming): number {
  return Math.max(0, Math.min(configuredMs, phase.hardCapMs));
}

export type RevealPlan =
  | { outcome: 'fits-viewport' | 'scroll-locked' | 'scrolled'; documentHeightPx: number }
  | { outcome: 'revealed'; documentHeightPx: number; viewportHeightPx: number; capped: boolean };

/**
 * How tall the viewport gets: the document height, at most `maxHeightPx` and never lower than the viewport. Only a page
 * at the top is resized: when a resize changes the layout of a scrolled page (a media query on the height), the browser
 * moves it back up, and that fires a scroll event.
 */
export function revealPlan(f: RawScrollFacts, viewport: Viewport, maxHeightPx: number): RevealPlan {
  const documentHeightPx = Math.max(0, Math.ceil(f.heightPx));
  if (f.locked) return { outcome: 'scroll-locked', documentHeightPx };
  if (f.scrollY > 0) return { outcome: 'scrolled', documentHeightPx };
  if (documentHeightPx <= viewport.height) return { outcome: 'fits-viewport', documentHeightPx };
  const viewportHeightPx = Math.min(documentHeightPx, Math.max(maxHeightPx, viewport.height));
  return {
    outcome: 'revealed',
    documentHeightPx,
    viewportHeightPx,
    capped: documentHeightPx > viewportHeightPx,
  };
}

/**
 * The document measured during the stay is taller than the viewport it was shown in: it grew with the viewport (a
 * section sized in viewport units, `height: 100vh`, or content that loaded below), so what lay below the first screen
 * kept its distance to the bottom and its lower part stayed below, as on a page taller than the cap. Null when the
 * height could not be read again.
 */
export function grewBelowViewport(viewportHeightPx: number, heightDuringPx: number | null): boolean {
  return heightDuringPx !== null && Math.ceil(heightDuringPx) > viewportHeightPx;
}

export interface RevealInput {
  page: Page;
  recorder: NetworkRecorder;
  /** The viewport of the first screen, restored afterwards. */
  viewport: Viewport;
  /** Longest stay, from `revealDwellMs`. */
  dwellMs: number;
  maxHeightPx: number;
  quietWindowMs: number;
  maxInflight: number;
  /** Bound of each call into the page (height, viewport). */
  callTimeoutMs: number;
  signal: AbortSignal;
}

export interface RevealResult {
  facts: RevealFacts;
  /** Why the step failed or the viewport could not be restored. */
  error?: string;
  /**
   * The first-screen viewport is confirmed again (or was never changed). Playwright's `viewportSize()` reports the size
   * asked for before the browser confirmed it, so only a call that resolved counts.
   */
  restored: boolean;
}

/**
 * The measurement in the shape the page code promises: it runs in the page's own world, whose script can replace
 * `Math` or `getComputedStyle`. A height that is no finite number is no measurement.
 */
async function measure(page: Page): Promise<RawScrollFacts> {
  const f = fields(await page.evaluate(scrollFactsInPage));
  if (typeof f.heightPx !== 'number' || !Number.isFinite(f.heightPx))
    throw new Error('document height unreadable');
  const scrollY = typeof f.scrollY === 'number' && Number.isFinite(f.scrollY) ? f.scrollY : 0;
  return { heightPx: f.heightPx, scrollY, locked: f.locked === true };
}

// Our own words only: a page can throw anything from its scripts (also a cookie value), and Playwright passes the text
// of a page exception on.
const failure = (what: string, err: unknown): string =>
  err instanceof TimeoutError ? err.message : `${what} failed`;

/** Sets the viewport of the first screen again; the message of the last attempt when that is not confirmed. */
async function restore(i: RevealInput): Promise<string | undefined> {
  let error: string | undefined;
  for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
    try {
      await withTimeout(i.page.setViewportSize(i.viewport), i.callTimeoutMs, 'restore the viewport');
      return undefined;
    } catch (err) {
      error = failure('restore the viewport', err);
      if (unsettled(err)) break;
    }
  }
  return error;
}

export async function revealBelowFold(i: RevealInput): Promise<RevealResult> {
  let measured: RawScrollFacts;
  try {
    measured = await withTimeout(measure(i.page), i.callTimeoutMs, 'document height');
  } catch (err) {
    return {
      facts: { outcome: 'failed', documentHeightPx: null },
      error: failure('document height', err),
      restored: true,
    };
  }

  const plan = revealPlan(measured, i.viewport, i.maxHeightPx);
  if (plan.outcome !== 'revealed') return { facts: plan, restored: true };

  const startedAt = Date.now();
  // Before the resize: the page may start loading before the call returns.
  i.recorder.markReveal();
  try {
    await withTimeout(
      i.page.setViewportSize({ width: i.viewport.width, height: plan.viewportHeightPx }),
      i.callTimeoutMs,
      'enlarge the viewport',
    );
  } catch (err) {
    const restoreError = await restore(i);
    return {
      facts: { outcome: 'failed', documentHeightPx: plan.documentHeightPx },
      error: [failure('enlarge the viewport', err), restoreError].filter(Boolean).join('; '),
      restored: restoreError === undefined && !unsettled(err),
    };
  }

  const quiet = await waitForQuiet(
    i.recorder,
    startedAt,
    { minDwellMs: 0, hardCapMs: i.dwellMs, quietWindowMs: i.quietWindowMs, maxInflight: i.maxInflight },
    i.signal,
  );
  // Measured again before the restore: a page sized by the viewport shrinks back with it.
  const heightDuringPx = await withTimeout(measure(i.page), i.callTimeoutMs, 'document height').then(
    (f) => f.heightPx,
    () => null,
  );
  const capped = plan.capped || grewBelowViewport(plan.viewportHeightPx, heightDuringPx);
  const restoreError = await restore(i);
  return {
    facts: {
      outcome: 'revealed',
      documentHeightPx: plan.documentHeightPx,
      viewportHeightPx: plan.viewportHeightPx,
      ...(capped ? { capped: true as const } : {}),
      quietReached: quiet.quietReached,
      dwellMs: quiet.dwellMs,
    },
    ...(restoreError ? { error: restoreError } : {}),
    restored: restoreError === undefined,
  };
}
