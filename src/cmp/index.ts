/**
 * CMP subsystem: seven own adapters in catalog order, recognition with ≥ 2 independent signals for
 * `high`, the generic heuristic for unknown banners (facts only, 5.5) and the pure table.
 *
 * Collector usage, phase B — one decision, made by core:
 *   const { adapter, detection } = await waitForCmp(page, { timeoutMs });
 *   await waitForBanner(page, adapter, { timeoutMs });   // banner visible and its geometry settled (≤ 2 s extra)
 *   const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });   // before any action
 *   const target = classifyFirstLayer(facts, lexicon).targets?.reject ?? null;     // → plan.click
 *   const click = adapter?.act ? await adapter.act(page, 'reject', target) : null; // clicks exactly `target`
 *   const verify = adapter && click?.clicked ? await adapter.verify(page, 'reject') : undefined;
 * `reject(page, { target })` is the same as `act`; `reject(page, { facts })` (transitional) applies the same pure
 * decision to the passed facts; without both nothing is clicked. `verify` reloads the page itself unless
 * `{ reload: false }`; it confirms only a recorded answer (`decision.responded === true`) and, in the document of
 * our click, only a state the click produced (`consent-state.origin: action`); after any reload the origin is
 * `stored`.
 * Checks import the pure parts from `src/cmp/classify.ts` / `src/cmp/lexicon.ts` (no browser, no fs).
 */
import type { Page } from 'playwright-core';
import { sanitizeUrl } from '../core/url.ts';
import { tcfGeoSignals } from './adapters/base.ts';
import { borlabs } from './adapters/borlabs.ts';
import { ccm19 } from './adapters/ccm19.ts';
import { complianz } from './adapters/complianz.ts';
import { cookiebot } from './adapters/cookiebot.ts';
import { cookiehub } from './adapters/cookiehub.ts';
import { realCookieBanner } from './adapters/real-cookie-banner.ts';
import { usercentrics } from './adapters/usercentrics.ts';
import { NOT_DETECTED } from './detection.ts';
import { loadLexicon } from './lexicon-file.ts';
import { measureHeuristic } from './page/measure.ts';
import type { CmpAdapter, CmpDetection, CmpFacts, CmpFirstLayer, ExtractOptions } from './types.ts';

export { clickButton as act, waitUntil } from './adapters/base.ts';
export { BLOCKING_COVERED_RATIO, classifyFirstLayer, isBlocking } from './classify.ts';
export { confidenceFromSignals, signalKinds, stateVerdict } from './detection.ts';
export { classifyButton, classifyLabel, lexiconFromData, normalizeLabel } from './lexicon.ts';
export { loadLexicon } from './lexicon-file.ts';
export type * from './types.ts';

/** Catalog order (BRIEF / catalog): Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. */
export const adapters: readonly CmpAdapter[] = [
  borlabs,
  cookiebot,
  complianz,
  usercentrics,
  ccm19,
  realCookieBanner,
  cookiehub,
];

const RANK = { high: 2, medium: 1, low: 0 } as const;

/**
 * Best adapter detection (highest recognition, ties in catalog order); otherwise the generic heuristic
 * (`method: 'heuristic'`, never `high`) or `none`. A snapshot at call time — see `waitForCmp` for polling.
 */
export async function detectCmp(
  page: Page,
): Promise<{ adapter: CmpAdapter | null; detection: CmpDetection }> {
  const best = await detectAdapter(page);
  if (best) return best;
  return { adapter: null, detection: await heuristicDetection(page) };
}

/** Adapters only (cheap presence probes): highest recognition wins, ties in catalog order. */
async function detectAdapter(page: Page): Promise<{ adapter: CmpAdapter; detection: CmpDetection } | null> {
  let best: { adapter: CmpAdapter; detection: CmpDetection } | null = null;
  for (const adapter of adapters) {
    const detection = await adapter.detect(page).catch(() => null);
    if (!detection) continue;
    if (!best || RANK[detection.recognitionConfidence] > RANK[best.detection.recognitionConfidence]) {
      best = { adapter, detection };
    }
  }
  return best;
}

async function heuristicDetection(page: Page): Promise<CmpDetection> {
  const heuristic = await measureHeuristic(page, loadLexicon()).catch(() => null);
  return heuristic?.detection ?? NOT_DETECTED;
}

/**
 * Poll the adapters until one is recognized with `high` and its API is ready (or the timeout ends); the generic
 * heuristic (a full-DOM walk) runs once at the end when no adapter matched. Returns the last detection.
 */
export async function waitForCmp(
  page: Page,
  opts: { timeoutMs?: number; stepMs?: number } = {},
): Promise<{ adapter: CmpAdapter | null; detection: CmpDetection }> {
  const end = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    const res = await detectAdapter(page);
    const ready = res && res.detection.recognitionConfidence === 'high' && (await res.adapter.ready?.(page));
    if (ready || Date.now() >= end) {
      return res ?? { adapter: null, detection: await heuristicDetection(page) };
    }
    await new Promise((r) => setTimeout(r, opts.stepMs ?? 250));
  }
}

/** Interval between two geometry readings while a freshly shown banner settles (≥ 200 ms). */
const SETTLE_STEP_MS = 200;
/** A banner whose geometry has not settled after this long is measured as it is and marked `geometryUnsettled`. */
const SETTLE_MAX_MS = 2000;

/** The result of the last `waitForBanner` per page, consumed by the next first-screen `extract` of that page. */
const settleResults = new WeakMap<Page, { url: string; unsettled: boolean }>();

function geometrySignature(layer: CmpFirstLayer): string {
  const box = (b: { x: number; y: number; width: number; height: number } | null | undefined) =>
    b ? `${b.x},${b.y},${b.width},${b.height}` : '-';
  return [box(layer.containerBox), ...layer.buttons.map((b) => box(b.box))].join('|');
}

/**
 * After the first visibility an appearance animation (slide-in, fade-in) may still be running and the buttons are at
 * intermediate positions. Settled = two consecutive readings, at least `SETTLE_STEP_MS` apart, with the same container
 * and button boxes and no finite animation running in the container. Bounded by `SETTLE_MAX_MS`.
 */
async function geometrySettled(page: Page, adapter: CmpAdapter, first: CmpFirstLayer): Promise<boolean> {
  const end = Date.now() + SETTLE_MAX_MS;
  let prev = first;
  for (;;) {
    await new Promise((r) => setTimeout(r, SETTLE_STEP_MS));
    const next = await adapter.firstLayer(page).catch(() => null);
    if (!next?.bannerVisible) return false;
    if (
      geometrySignature(next) === geometrySignature(prev) &&
      !prev.containerAnimating &&
      !next.containerAnimating
    ) {
      return true;
    }
    if (Date.now() >= end) return false;
    prev = next;
  }
}

/**
 * Poll until the adapter's banner is rendered (late widgets such as CCM19), then until its geometry has settled.
 * Returns whether it appeared. A banner that never settles is recorded for the next first-screen `extract`
 * (`firstLayer.geometryUnsettled`), so that a half-way position is not judged as an unreachable reject.
 */
export async function waitForBanner(
  page: Page,
  adapter: CmpAdapter,
  opts: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const end = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    const layer = await adapter.firstLayer(page).catch(() => null);
    if (layer?.bannerVisible) {
      const settled = await geometrySettled(page, adapter, layer);
      settleResults.set(page, { url: page.url(), unsettled: !settled });
      return true;
    }
    if (Date.now() >= end) {
      settleResults.delete(page);
      return false;
    }
    await new Promise((r) => setTimeout(r, opts.stepMs ?? 250));
  }
}

/**
 * First-screen facts of an adapter whose recognition is below `high`, or whose own banner is not there, may hide a
 * visible banner of another kind: the generic heuristic is run as well. When it finds one, its container, buttons
 * and blocking replace the adapter's (which were measured on a banner that is not there); the adapter's state, bot/geo
 * signals and config stay. The result is a heuristic detection (`info` only, never clicked) with the adapter as a hint.
 * An adapter whose own banner was measured and is visible keeps its facts whatever its confidence: another element on
 * the page (a newsletter dialog) must not replace the container, buttons and screenshot of the measured banner.
 */
async function withHeuristicBanner(page: Page, facts: CmpFacts, lexicon: ReturnType<typeof loadLexicon>) {
  if (facts.moment !== 'first-screen') return facts;
  if (
    facts.firstLayer.bannerPresent &&
    (facts.detection.recognitionConfidence === 'high' || facts.firstLayer.bannerVisible)
  )
    return facts;
  const heuristic = await measureHeuristic(page, lexicon).catch(() => null);
  if (!heuristic?.measured.firstLayer.bannerPresent) return facts;
  const hint = facts.detection.cmpId ? [`adapter-hint:${facts.detection.cmpId}`] : [];
  return {
    ...facts,
    viewport: heuristic.measured.viewport,
    detection: {
      ...heuristic.detection,
      signals: [...hint, ...facts.detection.signals, ...heuristic.detection.signals],
    },
    firstLayer: heuristic.measured.firstLayer,
    blocking: heuristic.measured.blocking,
  };
}

/** `geometryUnsettled`: the settle wait ran out for this page, or a finite animation is running right now. */
function markGeometry(page: Page, facts: CmpFacts): CmpFacts {
  if (facts.moment !== 'first-screen') return facts;
  const settle = settleResults.get(page);
  settleResults.delete(page);
  const waited = settle !== undefined && settle.url === page.url() && settle.unsettled;
  if (waited || facts.firstLayer.containerAnimating === true) {
    return { ...facts, firstLayer: { ...facts.firstLayer, geometryUnsettled: true } };
  }
  return facts;
}

/** Facts with the given adapter, or the generic heuristic when `adapter` is null (5.5: only `info`). */
export async function extract(
  page: Page,
  adapter: CmpAdapter | null,
  moment: CmpFacts['moment'],
  opts: ExtractOptions = {},
): Promise<CmpFacts> {
  if (adapter) {
    const own = await adapter.extract(page, moment, opts);
    return markGeometry(page, await withHeuristicBanner(page, own, opts.lexicon ?? loadLexicon()));
  }
  const lexicon = opts.lexicon ?? loadLexicon();
  const takenAt = (opts.now ?? (() => new Date()))().toISOString();
  const [heuristic, geoSignals] = await Promise.all([
    measureHeuristic(page, lexicon).catch(() => null),
    tcfGeoSignals(page),
  ]);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  return {
    phase: opts.phase ?? 'B',
    pageUrl: sanitizeUrl(page.url()),
    moment,
    takenAt,
    viewport: heuristic?.measured.viewport ?? viewport,
    detection: heuristic?.detection ?? NOT_DETECTED,
    firstLayer: heuristic?.measured.firstLayer ?? {
      bannerPresent: false,
      bannerVisible: false,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
    },
    blocking: heuristic?.measured.blocking ?? {
      overlay: false,
      scrollLock: false,
      inert: false,
      coveredRatio: null,
      method: [],
    },
    state: [],
    geoSignals,
    botSignals: [],
    config: {},
  };
}
