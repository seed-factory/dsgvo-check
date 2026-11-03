/**
 * Phases B and C on the start page: observe before the click, first screen (+ banner screenshot in B), click reject
 * (B) or accept (C) via the CMP adapter, verify, reload and verify again (B), then the control pages.
 */
import type { Page } from 'playwright-core';
import type { CmpAdapter, CmpButton, CmpFacts } from '../../cmp/types.ts';
import type { ClickPlan, PageRole } from '../../core/snapshot-browser.ts';
import type { SanitizedUrl } from '../../core/snapshot-common.ts';
import { combineVerify } from './cmp-bridge.ts';
import type { BrowserCollection, Session } from './collector.ts';
import { inputEventsInPage } from './in-page-input.ts';
import { navigate } from './navigate.ts';
import { waitForQuiet } from './quiet.ts';
import { bannerScreenshot } from './screenshot.ts';
import { errorText, sleep, withTimeout } from './util.ts';
import { navigationErrorCode, type VisitResult, type VisitSpec, valueWithin } from './visit.ts';

/** plan.click target: the decision of `classifyFirstLayer` when available, else the unique actionable button. */
async function clickTarget(
  s: Session,
  facts: CmpFacts | null,
  kind: 'reject' | 'accept',
  cmpId: string,
  pageUrl: SanitizedUrl,
): Promise<ClickPlan['target']> {
  const asTarget = (b: CmpButton): NonNullable<ClickPlan['target']> => ({
    cmpId,
    name: b.name,
    role: b.role,
    ...(b.selector ? { selector: b.selector } : {}),
    kindConfidence: b.kindConfidence,
  });
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

/** The navigation failed because the SSRF guard refused only names that did not resolve (not a private address). */
function refusedAsUnresolved(c: BrowserCollection, r: VisitResult, verdictsBefore: number): boolean {
  if (!r.error || navigationErrorCode(r.error) !== 'ERR_BLOCKED_BY_CLIENT') return false;
  const refused = c.guardVerdicts.slice(verdictsBefore);
  return refused.length > 0 && refused.every((v) => v === 'unresolved');
}

/**
 * B: observe ≥ MIN_DWELL before the click, first screen (+ banner screenshot), reject via the adapter, verify,
 * reload and verify again, control pages. C: the same with accept, without reload and screenshot.
 */
async function consentPhase(c: BrowserCollection, phase: 'B' | 'C'): Promise<void> {
  if (c.throttled) {
    c.phases.push(c.skippedPhase(phase, 'skipped', 'throttled'));
    return;
  }
  if (!c.timeLeft()) {
    c.phases.push(c.skippedPhase(phase, 'skipped', c.ctx.signal.aborted ? 'timeout' : 'time-budget'));
    return;
  }
  if (c.counter.truncated) {
    // Without request records a consent phase would look clean (CONSENT-05) — do not run it.
    c.phases.push(c.skippedPhase(phase, 'skipped', 'request-cap'));
    return;
  }
  const action = phase === 'B' ? 'reject' : 'accept';
  const s = await c.openPhase(phase);
  try {
    const startSpec: VisitSpec = {
      rawUrl: c.startRaw,
      role: 'start',
      order: 0,
      phase,
      firstVisit: false,
    };
    const verdictsBefore = c.guardVerdicts.length;
    let start = await navigate(c, s, startSpec);
    // The name resolved in phase A but not now (a resolver hiccup that outlasted the guard's retries): the start page
    // is the one page this phase cannot do without, so it gets one more navigation after a pause.
    if (refusedAsUnresolved(c, start, verdictsBefore) && c.timeLeft() && !c.throttled) {
      c.ctx.log.warn(`phase ${phase}: start page refused as unresolved, retrying once`);
      const refused = c.guardVerdicts.slice(verdictsBefore);
      await sleep(c.deps.timing.retryDelayMs, c.ctx.signal);
      s.record.pages.pop();
      start = await navigate(c, s, startSpec);
      // The repeat loaded the document: the refusal stays a fact of the request record and of `guard.blocked`, but
      // no document is missing, so the report must not claim that.
      if (!start.error) c.guardRecovered.push(...refused);
    }
    await c.afterPage(s, start, null);
    if (c.throttled) return;
    if (!start.visit.evaluable) {
      if (c.ctx.signal.aborted) {
        // The navigation failed because the deadline closed the browser: the phase was cut, the site did not fail.
        s.record.status = 'partial';
        s.record.reason = 'timeout';
      } else {
        s.record.status = 'failed';
        s.record.reason = start.visit.notEvaluableReason ?? 'start-page-not-evaluable';
      }
      return;
    }
    const url = start.visit.finalUrl;
    const cmpWaitMs = Math.min(5_000, c.deps.timing.cmpCallTimeoutMs);
    const det = await s.cmp.detect(s.page, url, cmpWaitMs);
    const adapter = det?.adapter ?? null;
    // Some CMPs render the dialog after their API is ready (e.g. Borlabs 3): measure the first screen then.
    if (adapter) await s.cmp.waitForBanner(s.page, adapter, url, cmpWaitMs);
    const first = await s.cmp.extract(s.page, adapter, 'first-screen', url);
    if (first) {
      if (phase === 'B' && c.ctx.options.screenshots) await screenshot(c, s, first, url);
      s.cmpFacts.facts.push(first);
    }
    if (!adapter) {
      if (phase === 'B') c.cmpRecognized = false;
      c.plan.click[phase] = { phase, action, target: null, reason: 'cmp-not-recognized' };
      s.record.status = 'partial';
      s.record.reason = 'cmp-not-recognized';
      return;
    }
    if (phase === 'B') c.cmpRecognized = true;
    const target = await clickTarget(s, first, action, adapter.id, url);
    c.plan.click[phase] = {
      phase,
      action,
      target,
      ...(target ? {} : { reason: `no-unambiguous-${action}-at-first-layer` }),
    };
    const clicked = await act(c, s, adapter, action, target, url);
    if (!clicked) return;
    const after = await s.cmp.extract(s.page, adapter, 'after-click', url);
    if (after) s.cmpFacts.facts.push(after);
    const verify1 = await s.cmp.verify(s.page, adapter, action, url);
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
        : await s.cmp.verify(s.page, adapter, action, reload.visit.finalUrl);
      // A reject confirmed only after the reload is verified too.
      const verify = combineVerify(verify1, verify2);
      if (verify) s.cmpFacts.verify = verify;
    } else if (verify1) {
      s.cmpFacts.verify = verify1;
    }
    await controlPages(c, s, adapter);
  } finally {
    await c.closePhase(s);
  }
}

/**
 * Click via the adapter, then observe with `tRef: click`. Returns false when nothing was clicked (the recorder then
 * stays in navigation mode). The adapter clicks exactly `target`, the `plan.click` decision of core.
 * The click moment is the first trusted press in the page after the adapter was called: the adapter still
 * locates and waits for the button before it presses it.
 */
async function act(
  c: BrowserCollection,
  s: Session,
  adapter: CmpAdapter,
  action: 'reject' | 'accept',
  target: ClickPlan['target'],
  pageUrl: SanitizedUrl,
): Promise<boolean> {
  // Snapshot right before the click so that pre-click cookies are not attributed to the click.
  s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, c.moment(s, pageUrl)));
  const armedAt = Date.now();
  const outcome = await s.cmp.act(s.page, adapter, action, target, pageUrl);
  const clicked = outcome?.clicked ?? false;
  const pressedAt = clicked ? await pressTime(c, s.page, armedAt) : null;
  // Without an observed press (e.g. the page navigated away on the click) the adapter call is the bound.
  const clickedAt = pressedAt ?? armedAt;
  s.cmpFacts.click = outcome ?? { action, clicked: false, button: null, error: 'cmp-call-failed' };
  s.record.click = {
    action,
    cmpId: adapter.id,
    name: outcome?.button?.name ?? '',
    clickedAt,
    ...(clicked ? { clickedAtSource: pressedAt !== null ? 'input-event' : 'adapter-call' } : {}),
    pageUrl,
    success: clicked,
    ...(outcome?.error ? { error: outcome.error } : outcome ? {} : { error: 'cmp-call-failed' }),
  };
  if (!clicked) {
    s.record.status = 'partial';
    s.record.reason = `no-${action}-button`;
    return false;
  }
  s.recorder.markClickAt(performance.now() - (Date.now() - clickedAt));
  const actionId = s.recorder.actionId;
  if (actionId) s.record.click.actionId = actionId;
  s.jar.markClick(clickedAt);
  await waitForQuiet(
    s.recorder,
    clickedAt,
    {
      ...c.deps.timing.phases[s.phase],
      quietWindowMs: c.deps.timing.quietWindowMs,
      maxInflight: c.deps.timing.maxInflight,
    },
    c.ctx.signal,
  );
  c.lastNavigationEnd = Date.now();
  await c.flushRecorder(s);
  s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, c.moment(s, pageUrl)));
  return true;
}

async function controlPages(c: BrowserCollection, s: Session, adapter: CmpAdapter): Promise<void> {
  let order = 1;
  for (const page of c.control) {
    if (!c.timeLeft() || c.counter.truncated || c.throttled) break;
    const r = await navigate(c, s, {
      rawUrl: page.raw,
      role: page.role as PageRole,
      order: order++,
      phase: s.phase,
      firstVisit: false,
    });
    await c.afterPage(s, r, 'control-page', adapter);
  }
}

/** Epoch ms of the first trusted press at or after `after` in any frame of the page (in-page hook), or null. */
async function pressTime(c: BrowserCollection, page: Page, after: number): Promise<number | null> {
  let best: number | null = null;
  for (const frame of page.frames()) {
    const times = (
      await valueWithin(
        frame.evaluate(inputEventsInPage),
        Math.min(2_000, c.deps.timing.cmpCallTimeoutMs),
        c.ctx.signal,
        [] as number[],
      )
    ).value;
    for (const t of times) if (t >= after && (best === null || t < best)) best = t;
  }
  return best;
}

async function screenshot(
  c: BrowserCollection,
  s: Session,
  facts: CmpFacts,
  pageUrl: SanitizedUrl,
): Promise<void> {
  try {
    const shot = await withTimeout(
      bannerScreenshot(s.page, facts, {
        artifactsDir: c.ctx.artifactsDir,
        artifactsRelDir: c.ctx.artifactsRelDir,
        phase: s.phase,
        pageUrl,
      }),
      c.deps.timing.cmpCallTimeoutMs,
      'banner screenshot',
    );
    if ('record' in shot) {
      c.screenshots.push(shot.record);
      facts.screenshotId = shot.record.id;
    } else if (shot.skipped !== 'no-banner') {
      // No unique container ≤ 50 % of the viewport → no image.
      s.record.errors.push({
        code: 'screenshot-skipped',
        message: shot.skipped,
        phase: s.phase,
        url: pageUrl,
      });
    }
  } catch (err) {
    s.record.errors.push({
      code: 'screenshot-skipped',
      message: `error: ${errorText(err).slice(0, 200)}`,
      phase: s.phase,
      url: pageUrl,
    });
  }
}
