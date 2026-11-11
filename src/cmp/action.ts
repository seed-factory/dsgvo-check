import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import { isAriaRole } from '../core/redaction/page-names.ts';
import { type ClickError, clickFailure } from './click-errors.ts';
import { armClickGuard } from './page/action-guard.ts';
import type { ClickTarget } from './types.ts';

export const CLICK_TIMEOUT_MS = 5_000;

const SUBMIT_BUTTON = ':is(form button, button[form]):not([type="button" i], [type="reset" i])';
const SUBMIT_INPUT = ':is(form input, input[form]):is([type="submit" i], [type="image" i])';
const SUBMITTER = `:is(${SUBMIT_BUTTON}, ${SUBMIT_INPUT})`;
const PASSIVE_CONTROL = `css=:not(${SUBMITTER}, ${SUBMITTER} *, :has(${SUBMITTER}), label, label *)`;
const TARGET_CHANGED = 'target-changed';

interface ClickDocument {
  live: AbortController;
  measured?: AbortSignal;
}

const documents = new WeakMap<Page, ClickDocument>();

export function rememberClickDocument(page: Page): void {
  let document = documents.get(page);
  if (!document) {
    const state: ClickDocument = { live: new AbortController() };
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      state.live.abort(TARGET_CHANGED);
      state.live = new AbortController();
    });
    document = state;
    documents.set(page, document);
  }
  document.measured = document.live.signal;
}

export function clickSignal(page: Page, timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const document = documents.get(page)?.measured;
  if (!document) return AbortSignal.abort(TARGET_CHANGED);

  const signals = [document, AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

type ButtonClick = { clicked: boolean; error?: ClickError };

export function abortedClick(signal: AbortSignal): ButtonClick {
  return {
    clicked: false,
    error: signal.reason === TARGET_CHANGED ? TARGET_CHANGED : 'click-failed:timed out',
  };
}

export async function clickButton(
  page: Page,
  button: Pick<ClickTarget, 'selector' | 'name' | 'role'>,
  timeoutMs = CLICK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ButtonClick> {
  if (!button.selector) return { clicked: false, error: 'no-selector' };
  if (signal?.aborted) return abortedClick(signal);
  if (!isAriaRole(button.role)) return { clicked: false, error: TARGET_CHANGED };

  const locator = page.locator(button.selector);
  let n: number;
  try {
    n = await locator.count();
  } catch {
    return { clicked: false, error: 'invalid-selector' };
  }
  if (n !== 1) return { clicked: false, error: n === 0 ? 'target-not-found' : 'target-ambiguous' };

  const role = button.role as Parameters<Page['getByRole']>[0];
  const target = locator
    .and(page.getByRole(role, { name: button.name, exact: true }))
    .and(page.locator(PASSIVE_CONTROL));
  try {
    if (signal?.aborted) return abortedClick(signal);
    if ((await target.count()) !== 1) return { clicked: false, error: TARGET_CHANGED };
    return await clickOnce(page, target, timeoutMs, signal);
  } catch (err) {
    return signal?.aborted ? abortedClick(signal) : { clicked: false, error: clickFailure(err) };
  }
}

async function clickOnce(
  page: Page,
  locator: Locator,
  timeout: number,
  signal?: AbortSignal,
): Promise<ButtonClick> {
  const token = randomUUID();
  const binding = `__dsgvoClick_${randomUUID().replaceAll('-', '')}`;
  let acknowledged = false;
  const receiver = await page.exposeBinding(binding, ({ frame }, value: unknown) => {
    if (frame === page.mainFrame() && value === token) acknowledged = true;
  });
  try {
    const element = await locator.elementHandle({ timeout, signal });
    try {
      const guard = await element.evaluateHandle(armClickGuard, { binding, token, submitter: SUBMITTER });
      let failure: unknown;
      let activated = false;
      try {
        if (signal?.aborted) return abortedClick(signal);
        const sameElement = await locator.evaluate((candidate, pinned) => candidate === pinned, element, {
          timeout,
          signal,
        });
        if (!sameElement) return { clicked: false, error: TARGET_CHANGED };
        await element.click({ timeout, signal, scroll: 'none', noWaitAfter: true });
      } catch (err) {
        failure = err;
      } finally {
        activated = (await guard.evaluate((finish) => finish()).catch(() => null)) ?? acknowledged;
        await guard.dispose().catch(() => undefined);
      }
      if (activated) return { clicked: true };
      if (failure) throw failure;
      return { clicked: false, error: TARGET_CHANGED };
    } finally {
      await element.dispose().catch(() => undefined);
    }
  } finally {
    await receiver.dispose().catch(() => undefined);
  }
}
