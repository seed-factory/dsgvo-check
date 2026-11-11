import type { Page } from 'playwright-core';
import { isClickError } from '../../../cmp/click-errors.ts';
import type { ClickOutcome, CmpAdapter, CmpButton, CmpFacts } from '../../../cmp/types.ts';
import type { ClickPlan, ClickPlanTarget, ClickRecord, PageRole } from '../../../core/snapshot/browser.ts';
import type { SanitizedUrl } from '../../../core/snapshot/common.ts';
import { combineVerify } from '../cmp-bridge.ts';
import type { BrowserCollection, Session } from '../collector.ts';
import { inputEventsInPage } from '../in-page/input.ts';
import { navigate } from '../pages/navigate.ts';
import { navigationErrorCode, type VisitResult, type VisitSpec, valueWithin } from '../pages/visit.ts';
import { waitForQuiet } from '../recording/quiet.ts';
import { sleep } from '../util.ts';

/** Upper bound of reading the press times of one frame; the CMP call timeout applies when it is shorter. */
const PRESS_READ_TIMEOUT_MS = 2_000;
const planTarget = (b: CmpButton, cmpId: string): ClickPlanTarget => ({
  cmpId,
  name: b.name,
  role: b.role,
  ...(b.selector ? { selector: b.selector } : {}),
  kindConfidence: b.kindConfidence,
});

/** The `classifyFirstLayer` decision when available, else the unique actionable button. */
async function clickTarget(
  s: Session,
  facts: CmpFacts | null,
  kind: 'reject' | 'accept',
  cmpId: string,
  pageUrl: SanitizedUrl,
): Promise<ClickPlan['target']> {
  const asTarget = (b: CmpButton) => planTarget(b, cmpId);

  if (!facts) return null;
  const decided = await s.cmp.targets(facts, pageUrl);
  if (decided) {
    const b = decided[kind];
    return b ? asTarget(b) : null;
  }

  const buttons = facts.firstLayer.buttons.filter(
    (b) => b.kind === kind && b.layer === 1 && b.actionableAtFirstScreen,
  );
  const b = buttons[0];
  return b && new Set(buttons.map((x) => x.name)).size === 1 ? asTarget(b) : null;
}

export function phaseB(c: BrowserCollection): Promise<void> {
  return consentPhase(c, 'B');
}

export async function phaseC(c: BrowserCollection): Promise<void> {
  if (c.cmpRecognized === false) {
    c.phases.push(c.skippedPhase('C', 'skipped', 'cmp-not-recognized'));
    return;
  }
  await consentPhase(c, 'C');
}

/** Refused only because the names did not resolve (not a private address). */
function refusedAsUnresolved(c: BrowserCollection, r: VisitResult, verdictsBefore: number): boolean {
  if (!r.error || navigationErrorCode(r.error) !== 'ERR_BLOCKED_BY_CLIENT') return false;
  const refused = c.guardVerdicts.slice(verdictsBefore);
  return refused.length > 0 && refused.every((v) => v === 'unresolved');
}

/** Why a consent phase does not start, or null. */
function skipReason(c: BrowserCollection): string | null {
  if (c.throttled) return 'throttled';
  if (!c.timeLeft()) return c.ctx.signal.aborted ? 'timeout' : 'time-budget';
  // Without request records a consent phase would look clean (CONSENT-05) — do not run it.
  if (c.counter.truncated) return 'request-cap';
  return null;
}

async function consentPhase(c: BrowserCollection, phase: 'B' | 'C'): Promise<void> {
  const skipped = skipReason(c);
  if (skipped) {
    c.phases.push(c.skippedPhase(phase, 'skipped', skipped));
    return;
  }

  const action = phase === 'B' ? 'reject' : 'accept';
  const s = await c.openPhase(phase);
  try {
    const start = await openStartPage(c, s, phase);
    await c.afterPage(s, start, null);
    if (c.throttled) return;
    if (!start.visit.evaluable) {
      markStartNotEvaluable(c, s, start);
      return;
    }

    const url = start.visit.finalUrl;
    const { adapter, first } = await observeFirstScreen(c, s, phase, url);
    if (!adapter) {
      noteCmpNotRecognized(c, s, phase, action);
      return;
    }
    if (phase === 'B') c.cmpRecognized = true;

    const target = await clickTarget(s, first, action, adapter.id, url);
    const plan: ClickPlan = {
      phase,
      action,
      target,
      ...(target ? {} : { reason: `no-unambiguous-${action}-at-first-layer` }),
    };
    c.plan.click[phase] = plan;
    const viaSettings =
      !target && phase === 'B' ? await rejectViaSettings(c, s, adapter, first, plan, url) : null;
    const clicked = viaSettings
      ? await act(c, s, adapter, action, viaSettings, url, 'settings')
      : await act(c, s, adapter, action, target, url);
    if (!clicked) return;

    const reload = await verifyClick(c, s, phase, adapter, action, url);
    await c.reveal(s, reload ?? start);
    await controlPages(c, s, adapter);
  } finally {
    await c.closePhase(s);
  }
}

/** Navigates to the start page; a name that did not resolve gets one more navigation after a pause. */
async function openStartPage(c: BrowserCollection, s: Session, phase: 'B' | 'C'): Promise<VisitResult> {
  const startSpec: VisitSpec = {
    rawUrl: c.startRaw,
    role: 'start',
    order: 0,
    phase,
    firstVisit: false,
  };
  const verdictsBefore = c.guardVerdicts.length;
  let start = await navigate(c, s, startSpec);

  // The name resolved in phase A but not now: the start page is the one page this phase cannot do without, so it gets
  // one more navigation after a pause.
  if (refusedAsUnresolved(c, start, verdictsBefore) && c.timeLeft() && !c.throttled) {
    c.ctx.log.warn(`phase ${phase}: start page refused as unresolved, retrying once`);
    const refused = c.guardVerdicts.slice(verdictsBefore);
    await sleep(c.timing.retryDelayMs, c.ctx.signal);
    s.record.pages.pop();
    start = await navigate(c, s, startSpec);
    // The refusal stays a fact of the request record and `guard.blocked`, but no document is missing, so the report
    // must not claim that.
    if (!start.error) c.guardRecovered.push(...refused);
  }
  return start;
}

function markStartNotEvaluable(c: BrowserCollection, s: Session, start: VisitResult): void {
  if (c.ctx.signal.aborted) {
    // The navigation failed because the deadline closed the browser: the phase was cut, the site did not fail.
    s.record.status = 'partial';
    s.record.reason = 'timeout';
  } else {
    s.record.status = 'failed';
    s.record.reason = start.visit.notEvaluableReason ?? 'start-page-not-evaluable';
  }
}

/**
 * Phase B whose first layer offers no reject: when the adapter describes a settings layer, opens it through the settings
 * control core chose and returns the save control core chose there, both recorded in `plan.settings`. Null when nothing
 * is to be pressed: the first layer does not qualify, the layer did not show, a group is already on (switches are never
 * toggled), or the save control is not unambiguous.
 */
async function rejectViaSettings(
  c: BrowserCollection,
  s: Session,
  adapter: CmpAdapter,
  first: CmpFacts | null,
  plan: ClickPlan,
  url: SanitizedUrl,
): Promise<ClickPlanTarget | null> {
  if (!first || !adapter.rejectsViaSettings) return null;
  const opener = await s.cmp.settingsOpener(first, url);
  if (!opener) return null;

  const open = opener.target ? planTarget(opener.target, adapter.id) : null;
  if (!open) {
    plan.settings = { open, save: null, reason: opener.reason ?? 'settings-control-not-found' };
    return null;
  }
  const layer = await s.cmp.openSettings(s.page, adapter, open, url, cmpWaitMs(c));
  if (layer) s.cmpFacts.settings = withKnownError(layer);
  const choice = layer ? await s.cmp.settingsSave(layer, url) : null;
  const save = choice?.target ? planTarget(choice.target, adapter.id) : null;
  plan.settings = {
    open,
    save,
    // Without a choice the layer did not show, or core could not be asked about it.
    ...(save
      ? {}
      : { reason: choice?.reason ?? (layer?.opened ? 'settings-save-not-found' : 'settings-not-opened') }),
  };
  return save;
}

/** How long a phase waits for a CMP, its banner or a late answer; one CMP call never takes longer. */
const cmpWaitMs = (c: BrowserCollection): number =>
  Math.min(c.ctx.config.cmp.waitMs, c.timing.cmpCallTimeoutMs);

async function observeFirstScreen(
  c: BrowserCollection,
  s: Session,
  phase: 'B' | 'C',
  url: SanitizedUrl,
): Promise<{ adapter: CmpAdapter | null; first: CmpFacts | null }> {
  const waitMs = cmpWaitMs(c);
  const det = await s.cmp.detect(s.page, url, waitMs);
  const adapter = det?.adapter ?? null;
  // Some CMPs render the dialog after their API is ready (e.g. Borlabs 3): measure the first screen then.
  if (adapter) await s.cmp.waitForBanner(s.page, adapter, url, waitMs);

  const first = await s.cmp.extract(s.page, adapter, 'first-screen', url);
  if (first) {
    if (
      phase === 'B' &&
      c.ctx.options.screenshots &&
      first.firstLayer.bannerPresent &&
      first.firstLayer.bannerVisible
    ) {
      s.record.errors.push({ code: 'screenshot-skipped', message: 'privacy-unverifiable', phase, url });
    }
    s.cmpFacts.facts.push(first);
  }
  return { adapter, first };
}

function noteCmpNotRecognized(
  c: BrowserCollection,
  s: Session,
  phase: 'B' | 'C',
  action: 'reject' | 'accept',
): void {
  if (phase === 'B') c.cmpRecognized = false;
  c.plan.click[phase] = { phase, action, target: null, reason: 'cmp-not-recognized' };
  s.record.status = 'partial';
  s.record.reason = 'cmp-not-recognized';
}

/**
 * Facts after the click and the verdict of the CMP state; phase B reloads the start page and verifies again. Returns
 * the reload, null when there was none.
 */
async function verifyClick(
  c: BrowserCollection,
  s: Session,
  phase: 'B' | 'C',
  adapter: CmpAdapter,
  action: 'reject' | 'accept',
  url: SanitizedUrl,
): Promise<VisitResult | null> {
  const after = await s.cmp.extract(s.page, adapter, 'after-click', url);
  if (after) s.cmpFacts.facts.push(after);
  const verify1 = await s.cmp.verify(s.page, adapter, action, url, cmpWaitMs(c));

  if (phase === 'B' && c.timeLeft()) {
    const reload = await navigate(c, s, {
      rawUrl: c.startRaw,
      role: 'start',
      order: 0,
      phase,
      firstVisit: false,
      reload: true,
    });
    s.record.reloaded = true;
    await c.afterPage(s, reload, 'after-reload', adapter);

    const verify2 = reload.error
      ? null
      : await s.cmp.verify(s.page, adapter, action, reload.visit.finalUrl, cmpWaitMs(c));
    const verify = combineVerify(verify1, verify2);
    if (verify) s.cmpFacts.verify = verify;
    return reload;
  }
  if (verify1) s.cmpFacts.verify = verify1;
  return null;
}

// Clicks via the adapter, then observes with `tRef: click`; false when nothing was clicked. The click moment is the
// first trusted press after the adapter was called: it still locates and waits for the button first. `path` marks the
// save control of the settings layer, pressed as the reject.
async function act(
  c: BrowserCollection,
  s: Session,
  adapter: CmpAdapter,
  action: 'reject' | 'accept',
  target: ClickPlan['target'],
  pageUrl: SanitizedUrl,
  path?: 'settings',
): Promise<boolean> {
  // Snapshot right before the click so pre-click cookies are not attributed to it.
  s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, c.moment(s, pageUrl)));

  const armedAt = Date.now();
  const outcome = await s.cmp.act(s.page, adapter, action, target, pageUrl);
  const clicked = outcome?.clicked ?? false;
  const pressedAt = clicked ? await pressTime(c, s.page, armedAt) : null;
  // Without an observed press (e.g. the page navigated away on the click) the adapter call is the bound.
  const clickedAt = pressedAt ?? armedAt;

  s.cmpFacts.click = {
    ...(outcome
      ? withKnownError(outcome)
      : { action, clicked: false, button: null, error: 'cmp-call-failed' }),
    ...(path ? { path } : {}),
  };
  s.record.click = clickRecord(adapter.id, action, outcome, pageUrl, clickedAt, pressedAt);
  if (!clicked) {
    s.record.status = 'partial';
    s.record.reason = `no-${action}-button`;
    return false;
  }

  s.recorder.markClickAt(performance.now() - (Date.now() - clickedAt));
  const actionId = s.recorder.actionId;
  if (actionId) s.record.click.actionId = actionId;
  await observeAfterClick(c, s, pageUrl, clickedAt);
  return true;
}

/** An adapter's error as stored: a code of click-errors.ts, else none. */
const knownError = (error: string | undefined): string | undefined =>
  error !== undefined && isClickError(error) ? error : undefined;

/** A click outcome or a settings layer with its error only as a known code. */
export function withKnownError<T extends { error?: string }>(x: T): T {
  const { error, ...rest } = x;
  const kept = knownError(error);
  return { ...rest, ...(kept !== undefined ? { error: kept } : {}) } as T;
}

export function clickRecord(
  cmpId: string,
  action: 'reject' | 'accept',
  outcome: ClickOutcome | null,
  pageUrl: SanitizedUrl,
  clickedAt: number,
  pressedAt: number | null,
): ClickRecord {
  const clicked = outcome?.clicked ?? false;
  const error = outcome ? knownError(outcome.error) : 'cmp-call-failed';
  return {
    action,
    cmpId,
    name: outcome?.button?.name ?? '',
    clickedAt,
    ...(clicked ? { clickedAtSource: pressedAt !== null ? 'input-event' : 'adapter-call' } : {}),
    pageUrl,
    success: clicked,
    ...(error ? { error } : {}),
  };
}

/** Waits until the page is quiet after the click, then takes the cookies and storage that appeared. */
async function observeAfterClick(
  c: BrowserCollection,
  s: Session,
  pageUrl: SanitizedUrl,
  clickedAt: number,
): Promise<void> {
  s.jar.markClick(clickedAt);
  await waitForQuiet(
    s.recorder,
    clickedAt,
    {
      ...c.timing.phases[s.phase],
      quietWindowMs: c.timing.quietWindowMs,
      maxInflight: c.timing.maxInflight,
    },
    c.ctx.signal,
  );
  c.lastNavigationEnd = Date.now();

  await c.flushRecorder(s);
  s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, c.moment(s, pageUrl)));
}

async function controlPages(c: BrowserCollection, s: Session, adapter: CmpAdapter): Promise<void> {
  let order = 1;
  for (const page of c.control) {
    if (!c.timeLeft() || c.counter.truncated || c.throttled || s.viewportLost) break;
    const r = await navigate(c, s, {
      rawUrl: page.raw,
      role: page.role as PageRole,
      order: order++,
      phase: s.phase,
      firstVisit: false,
    });
    await c.afterPage(s, r, 'control-page', adapter);
    await c.reveal(s, r);
  }
}

/**
 * Epoch ms of the first trusted press at or after `after` in any frame (in-page hook), or null. The page can edit the
 * hook's log, so only a finite number between `after` and now counts as a press: a string would compare as a number
 * and become the stored click moment.
 */
async function pressTime(c: BrowserCollection, page: Page, after: number): Promise<number | null> {
  const readTimeoutMs = Math.min(PRESS_READ_TIMEOUT_MS, c.timing.cmpCallTimeoutMs);
  let best: number | null = null;
  for (const frame of page.frames()) {
    const { value: times } = await valueWithin(
      frame.evaluate(inputEventsInPage),
      readTimeoutMs,
      c.ctx.signal,
      [] as unknown[],
    );
    const now = Date.now();
    for (const t of Array.isArray(times) ? times : []) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < after || t > now) continue;
      if (best === null || t < best) best = t;
    }
  }
  return best;
}
