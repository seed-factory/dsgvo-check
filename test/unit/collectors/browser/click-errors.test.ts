/**
 * A click, a settings layer or a reload that failed is stored by its code only. The codes the adapters give
 * (src/cmp/click-errors.ts) reach the click record and the CMP facts with the kind of failure; anything else, such as
 * Playwright's message with the selector and the page's markup, is dropped. Markers start with `zq8`.
 */
import { describe, expect, it } from 'vitest';
import { clickFailure, isClickError, noTarget, reloadFailure } from '../../../../src/cmp/click-errors.ts';
import type { ClickOutcome, SettingsLayerFacts } from '../../../../src/cmp/types.ts';
import { clickRecord, withKnownError } from '../../../../src/collectors/browser/phases/consent-phase.ts';

const outcome = (error: string): ClickOutcome => ({ action: 'reject', clicked: false, button: null, error });

const layer = (error: string): SettingsLayerFacts => ({
  takenAt: '2026-11-07T10:00:00.000Z',
  opened: false,
  error,
  buttons: [],
  containerUnambiguous: false,
  buttonsTruncated: false,
  groups: [],
  essentialGroups: 0,
});

/** The error as the click record, the CMP facts of the click and the settings layer store it. */
const stored = (error: string) => ({
  record: clickRecord('cookiebot', 'reject', outcome(error), 'https://www.example.test/', 1, null).error,
  click: withKnownError(outcome(error)).error,
  settings: withKnownError(layer(error)).error,
});

describe('the stored error of a click', () => {
  it.each([
    'click-failed:timed out',
    'click-failed:page closed',
    'click-failed:frame detached',
    'click-failed:execution context destroyed',
    'click-failed',
    'target-ambiguous',
    'target-not-found',
    'invalid-selector',
    'no-selector',
    'no-target',
    'no-settings-layer',
    'no-unambiguous-reject',
    'no-unambiguous-accept:blocking-no-reject',
  ])('keeps the code %j', (error) => {
    expect(stored(error)).toEqual({ record: error, click: error, settings: error });
  });

  it.each([
    ['a message with the call log', 'click-failed: locator.click: Timeout 5000ms exceeded. zq8'],
    [
      'a strict-mode message with the selector',
      `click-failed: locator.click: Error: strict mode violation: locator('#zq8') resolved to 2 elements`,
    ],
    ['a kind that is none', 'click-failed:zq8'],
    ['a variant with an address', 'no-unambiguous-reject:zq8 alice@example.com'],
    ['free text', 'zq8 alice@example.com'],
  ])('drops %s', (_case, error) => {
    expect(stored(error)).toEqual({ record: undefined, click: undefined, settings: undefined });
  });

  it('records a CMP call that failed as such', () => {
    expect(clickRecord('cookiebot', 'reject', null, 'https://www.example.test/', 1, null).error).toBe(
      'cmp-call-failed',
    );
  });
});

describe('the codes the adapters give', () => {
  it.each([
    [
      'locator.click: Timeout 5000ms exceeded.\n  - <div data-x="zq8cover"> intercepts pointer events',
      'click-failed:timed out',
    ],
    ['locator.click: Target page, context or browser has been closed', 'click-failed:page closed'],
    ['locator.click: Frame was detached', 'click-failed:frame detached'],
    [
      "locator.click: Error: strict mode violation: locator('button.zq8') resolved to 2 elements",
      'target-ambiguous',
    ],
    ['locator.click: Element is not attached to the DOM <button id="zq8">', 'click-failed'],
  ])('a click that failed with %j is %j, a code the collector keeps', (message, code) => {
    const error = clickFailure(new Error(message));
    expect(error).toBe(code);
    expect(isClickError(error)).toBe(true);
  });

  it.each([
    ['page.reload: Target page, context or browser has been closed', 'reload-failed:page closed'],
    ['page.reload: Timeout 8000ms exceeded.', 'reload-failed:timed out'],
    ['page.reload: net::ERR_ABORTED at https://www.example.test/?sid=zq8abc', 'reload-failed'],
  ])('a reload that failed with %j is %j', (message, code) => {
    expect(reloadFailure(new Error(message))).toBe(code);
  });

  it('nothing to click is a code the collector keeps', () => {
    for (const code of [noTarget('reject'), noTarget('accept', 'blocking-no-reject')]) {
      expect(isClickError(code)).toBe(true);
    }
  });
});
