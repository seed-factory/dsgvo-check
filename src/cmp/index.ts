/** CMP subsystem: the seven own adapters, a generic heuristic for unknown banners (facts only) and the pure table. */
import type { Page } from 'playwright-core';
import { sanitizeUrl } from '../core/url/url.ts';
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

/** In catalog order, which also breaks recognition ties. */
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

/** Best adapter detection, else the generic heuristic (never `high`) or `none`; a snapshot, see `waitForCmp` for polling. */
export async function detectCmp(
  page: Page,
): Promise<{ adapter: CmpAdapter | null; detection: CmpDetection }> {
  const best = await detectAdapter(page);
  if (best) return best;
  return { adapter: null, detection: await heuristicDetection(page) };
}

/** Adapters only (cheap probes); ties go to the earlier adapter. */
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

/** Polls until an adapter is `high` and ready; the full-DOM heuristic runs once at the end if none matched. */
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

const SETTLE_STEP_MS = 200;
/** A banner that has not settled after this long is measured as is and marked `geometryUnsettled`. */
const SETTLE_MAX_MS = 2000;

/** Result of the last `waitForBanner` per page, consumed by the next first-screen `extract`. */
const settleResults = new WeakMap<Page, { url: string; unsettled: boolean }>();

function geometrySignature(layer: CmpFirstLayer): string {
  const box = (b: { x: number; y: number; width: number; height: number } | null | undefined) =>
    b ? `${b.x},${b.y},${b.width},${b.height}` : '-';
  return [box(layer.containerBox), ...layer.buttons.map((b) => box(b.box))].join('|');
}

/** Settled = two consecutive readings with equal container and button boxes and no animation running. */
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

/** Waits for the banner and its geometry to settle; a banner that never settles is flagged `geometryUnsettled`. */
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
 * If the adapter's banner is not there or recognition is below `high`, a banner found by the generic heuristic
 * replaces its container, buttons and blocking (result `info` only). A measured, visible adapter banner is kept.
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

/** Marks `geometryUnsettled` when the settle wait ran out or an animation is still running. */
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

/** Facts via the adapter, or the generic heuristic when `adapter` is null (`info` only). */
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
