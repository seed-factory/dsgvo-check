/**
 * Shared adapter machinery: what an adapter recognises and where its banner is comes from test/data/cmp/adapters.yaml,
 * the adapter file adds read-only readers that run in the page (serialized, so self-contained). Clicking executes core's
 * target on exactly one element.
 */
import type { Page } from 'playwright-core';
import { sanitizeUrl } from '../../core/url/url.ts';
import { type AdapterData, supportedVersionsOf } from '../adapters-data.ts';
import { adapterData } from '../adapters-file.ts';
import { classifyFirstLayer } from '../classify.ts';
import {
  cleanVersion,
  confidenceFromSignals,
  majorSupported,
  NOT_DETECTED,
  originAfterClick,
  stateVerdict,
  unchangedDeniedAfterAccept,
  versionFromUrl,
} from '../detection.ts';
import { loadLexicon } from '../lexicon-file.ts';
import { cmpDetectProbe, type DetectArgs, type DetectRaw, tcfPingProbe } from '../page/detect.ts';
import { measureBanner } from '../page/measure.ts';
import type {
  ActOptions,
  BotSignal,
  CategoryState,
  ClickOutcome,
  ClickTarget,
  CmpAdapter,
  CmpButton,
  CmpDetection,
  CmpFacts,
  ConsentStateFact,
  ExtractOptions,
  GeoSignal,
  KnownCmpId,
  VerifyOptions,
  VerifyResult,
} from '../types.ts';

const CLICK_TIMEOUT_MS = 5000;

/** Default wait for the reload and the adapter's readiness in `verify`. */
const VERIFY_TIMEOUT_MS = 8000;

const WAIT_STEP_MS = 200;

/** Error texts in the facts keep the first line of the message, cut to this length. */
const CLICK_ERROR_MAX_LENGTH = 160;
const RELOAD_ERROR_MAX_LENGTH = 120;

export type ConfigValue = string | number | boolean | null;

export interface AdapterConfig {
  config: Record<string, ConfigValue>;
  /** "×" means accept according to the CMP config; null = unknown. */
  closeMeansAccept: boolean | null;
}

export interface AdapterSpec {
  /** Key of the adapter's entry in test/data/cmp/adapters.yaml. */
  id: KnownCmpId;
  /** Read-only; `origin` is `stored` with a recorded answer, `default` without, `special-branch` for geo/bot. */
  readState(page: Page): Promise<ConsentStateFact[]>;
  readGeo?(page: Page): Promise<GeoSignal[]>;
  readBot?(page: Page): Promise<BotSignal[]>;
  readConfig?(page: Page): Promise<AdapterConfig>;
  isReady(page: Page): Promise<boolean>;
  /** The API cannot list the installation's categories (CookieHub), so a category left `denied` by our accept click may not exist. */
  categoriesUnlisted?: boolean;
}

function detectArgsOf(d: AdapterData['detect']): DetectArgs {
  return {
    globals: d.globals,
    versionGlobals: d.versionGlobals,
    scripts: d.scripts,
    dom: d.dom,
    cookies: d.cookies,
    storage: d.storage,
  };
}

/** The version the vendor reports about itself, else `?ver=` of its script, else the first matching rule. */
function versionOf(raw: DetectRaw, d: AdapterData): string | null {
  for (const path of d.detect.versionGlobals) {
    const own = cleanVersion(raw.versions[path]);
    if (own) return own;
  }
  if (d.version.fromScriptUrl) {
    const fromUrl = versionFromUrl(raw.scriptUrls[0]);
    if (fromUrl) return fromUrl;
  }
  for (const r of d.version.rules) {
    const found =
      (r.global !== undefined && raw.globals.includes(r.global)) ||
      (r.dom !== undefined && raw.dom.includes(r.dom)) ||
      (r.script !== undefined && raw.scripts.includes(r.script));
    if (found) return r.version;
  }
  return null;
}

/** `true/false/null` per category → `granted/denied/unknown`. */
export function toCategoryStates(map: Record<string, boolean | null>): Record<string, CategoryState> {
  const out: Record<string, CategoryState> = {};
  for (const [k, v] of Object.entries(map))
    out[k] = v === true ? 'granted' : v === false ? 'denied' : 'unknown';
  return out;
}

export function decisionMethod(m: string | null | undefined): 'explicit' | 'implied' | 'unknown' {
  return m === 'explicit' || m === 'implied' ? m : 'unknown';
}

async function safe<T>(p: Promise<T> | undefined, fallback: T): Promise<T> {
  if (!p) return fallback;
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export async function tcfGeoSignals(page: Page): Promise<GeoSignal[]> {
  const r = await safe(page.evaluate(tcfPingProbe), { present: false, gdprApplies: null, cmpId: null });
  if (r.present && r.gdprApplies === false) {
    return [
      {
        cmpId: 'tcf',
        signal: 'tcf:gdprApplies=false',
        ...(r.cmpId !== null ? { detail: `cmpId=${r.cmpId}` } : {}),
      },
    ];
  }
  return [];
}

/** Click one element by its selector: exactly one match, `locator.click()` with actionability checks, no `force`. */
export async function clickButton(
  page: Page,
  button: Pick<CmpButton, 'selector'>,
  timeoutMs = CLICK_TIMEOUT_MS,
): Promise<{ clicked: boolean; error?: string }> {
  if (!button.selector) return { clicked: false, error: 'no-selector' };

  const locator = page.locator(button.selector);
  let n: number;
  try {
    n = await locator.count();
  } catch {
    return { clicked: false, error: 'invalid-selector' };
  }
  if (n !== 1) return { clicked: false, error: n === 0 ? 'target-not-found' : 'target-ambiguous' };

  try {
    await locator.click({ timeout: timeoutMs });
    return { clicked: true };
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0] ?? 'error';
    return { clicked: false, error: `click-failed: ${msg.slice(0, CLICK_ERROR_MAX_LENGTH)}` };
  }
}

export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = WAIT_STEP_MS,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Document identity (`performance.timeOrigin` changes with every navigation/reload). */
async function documentOrigin(page: Page): Promise<number | null> {
  return safe(
    page.evaluate(
      () => (globalThis as unknown as { performance: { timeOrigin: number } }).performance.timeOrigin,
    ),
    null,
  );
}

interface ClickRecord {
  document: number;
  /** Consent state read right before that click (`action` only for a state the click changed). */
  before: ConsentStateFact[];
}

const clicks = new WeakMap<Page, ClickRecord>();

/** The record of our last click when it happened in the current document, else null (any reload since). */
async function clickInThisDocument(page: Page): Promise<ClickRecord | null> {
  const click = clicks.get(page);
  if (click === undefined) return null;
  return (await documentOrigin(page)) === click.document ? click : null;
}

export function defineAdapter(spec: AdapterSpec): CmpAdapter {
  // The data is read on first use, so a broken data file is reported by the scan and not when this module is imported.
  const data = (): AdapterData => adapterData(spec.id);

  const adapter: CmpAdapter = {
    id: spec.id,
    get name() {
      return data().name;
    },
    get supportedVersions() {
      return supportedVersionsOf(data().supportedMajors);
    },

    async detect(page): Promise<CmpDetection | null> {
      const vendor = data();
      const raw = await safe(page.evaluate(cmpDetectProbe, detectArgsOf(vendor.detect)), null);
      if (!raw) return null;
      const signals = [
        ...raw.globals.map((g) => `global:${g}`),
        ...raw.scripts.map((s) => `script:${s}`),
        ...raw.dom.map((d) => `dom:${d}`),
        ...raw.cookies.map((c) => `cookie:${c}`),
        ...raw.storage.map((k) => `storage:${k}`),
      ];
      const confidence = confidenceFromSignals(signals, vendor.detect.requiredKinds);
      if (!confidence) return null;
      const version = versionOf(raw, vendor);
      return {
        cmpId: spec.id,
        method: 'adapter',
        version,
        versionSupported: vendor.supportedMajors ? majorSupported(version, vendor.supportedMajors) : null,
        recognitionConfidence: confidence,
        signals,
      };
    },

    async extract(page, moment, opts: ExtractOptions = {}): Promise<CmpFacts> {
      const lexicon = opts.lexicon ?? loadLexicon();
      const now = opts.now ?? (() => new Date());
      const takenAt = now().toISOString();
      const [detection, cfg, state, geoSignals, botSignals] = await Promise.all([
        adapter.detect(page).then((d) => d ?? NOT_DETECTED),
        safe(spec.readConfig?.(page), { config: {}, closeMeansAccept: null }),
        adapter.state(page),
        adapter.geoSignals(page),
        adapter.botSignals(page),
      ]);
      const measured = await measureBanner(page, data().banner, lexicon, cfg.closeMeansAccept);
      return {
        phase: opts.phase ?? 'B',
        pageUrl: sanitizeUrl(page.url()),
        moment,
        takenAt,
        viewport: measured.viewport,
        detection,
        firstLayer: measured.firstLayer,
        blocking: measured.blocking,
        state,
        geoSignals,
        botSignals,
        config: cfg.config,
      };
    },

    state: (page) => safe(spec.readState(page), []),

    async geoSignals(page) {
      const [own, tcf] = await Promise.all([safe(spec.readGeo?.(page), []), tcfGeoSignals(page)]);
      return [...own, ...tcf];
    },

    botSignals: (page) => safe(spec.readBot?.(page), []),

    async firstLayer(page) {
      const cfg = await safe(spec.readConfig?.(page), { config: {}, closeMeansAccept: null });
      return (await measureBanner(page, data().banner, loadLexicon(), cfg.closeMeansAccept)).firstLayer;
    },

    act: (page, action, target, opts = {}) => execute(page, action, target, opts.timeoutMs),
    reject: (page, opts) => decideOrExecute(page, 'reject', opts),
    accept: (page, opts) => decideOrExecute(page, 'accept', opts),

    async verify(page, action, opts: VerifyOptions = {}): Promise<VerifyResult> {
      const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;

      // `action` only in the document of our click and only for an answer the click produced; after any
      // reload (ours or the collector's) the adapter's own origin (`stored`) stays.
      const now = await adapter.state(page);
      const click = await clickInThisDocument(page);
      const stateNow = originAfterClick(now, click?.before ?? null, click !== null);
      const ignoreCategories =
        action === 'accept' && spec.categoriesUnlisted === true && click !== null
          ? unchangedDeniedAfterAccept(click.before, now)
          : [];
      const verdict = stateVerdict(stateNow, action, { requireAction: click !== null, ignoreCategories });

      const methods = [...verdict.methods];
      const bannerOpen = await safe(
        measureBanner(page, data().banner, loadLexicon()).then((m) => m.firstLayer.bannerVisible),
        false,
      );
      if (!bannerOpen) methods.push('ui-closed');

      let reason = verdict.ok ? undefined : verdict.reason;
      let persisted: boolean | null = null;
      let afterReload: ConsentStateFact[] = [];
      if (opts.reload !== false) {
        const reloaded = await recheckAfterReload(page, action, ignoreCategories, timeoutMs);
        persisted = reloaded.persisted;
        afterReload = reloaded.state;
        if (reloaded.persisted) methods.push('persisted-after-reload');
        reason ??= reloaded.reason;
      }

      return {
        action,
        verified: verdict.ok && persisted !== false,
        method: methods,
        stateAfter: [...stateNow, ...afterReload],
        persistedAfterReload: persisted,
        ...(reason ? { reason } : {}),
      };
    },

    ready: (page) => safe(spec.isReady(page), false),
  };

  /** Reloads the page and reads the state again: a stored answer survives the reload, a session-only one does not. */
  async function recheckAfterReload(
    page: Page,
    action: 'reject' | 'accept',
    ignoreCategories: readonly string[],
    timeoutMs: number,
  ): Promise<{ persisted: boolean | null; state: ConsentStateFact[]; reason?: string }> {
    try {
      await page.reload({ waitUntil: 'load', timeout: timeoutMs });
      await waitUntil(() => spec.isReady(page), timeoutMs);

      const state = await adapter.state(page);
      const again = stateVerdict(state, action, { ignoreCategories });
      return {
        persisted: again.ok,
        state,
        ...(again.ok ? {} : { reason: `after-reload:${again.reason ?? 'not-confirmed'}` }),
      };
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? '';
      return {
        persisted: null,
        state: [],
        reason: `reload-failed: ${msg.slice(0, RELOAD_ERROR_MAX_LENGTH)}`,
      };
    }
  }

  /** Clicks exactly the target core chose; no classification here. */
  async function execute(
    page: Page,
    action: 'reject' | 'accept',
    target: ClickTarget | null,
    timeoutMs?: number,
  ): Promise<ClickOutcome> {
    if (!target) return { action, clicked: false, button: null, error: `no-unambiguous-${action}` };
    const before = await adapter.state(page);
    const document = await documentOrigin(page);
    const res = await clickButton(page, target, timeoutMs);
    if (res.clicked && document !== null) clicks.set(page, { document, before });
    return {
      action,
      clicked: res.clicked,
      button: {
        name: target.name,
        role: target.role,
        kind: target.kind ?? action,
        kindConfidence: target.kindConfidence,
      },
      ...(res.error ? { error: res.error } : {}),
    };
  }

  /**
   * Core's target, or (transitional) the same pure decision over the passed facts. Never measures on its own: the click
   * must be the one recorded in `plan.click`.
   */
  async function decideOrExecute(
    page: Page,
    action: 'reject' | 'accept',
    opts: ActOptions = {},
  ): Promise<ClickOutcome> {
    if (opts.target !== undefined) return execute(page, action, opts.target, opts.timeoutMs);
    if (!opts.facts) return { action, clicked: false, button: null, error: 'no-target' };
    const cls = classifyFirstLayer(opts.facts, opts.lexicon ?? loadLexicon(), {
      blockingCoveredRatio: opts.blockingCoveredRatio,
    });
    const target = (action === 'reject' ? cls.targets?.reject : cls.targets?.accept) ?? null;
    if (!target)
      return { action, clicked: false, button: null, error: `no-unambiguous-${action}:${cls.variant}` };
    return execute(page, action, target, opts.timeoutMs);
  }

  return adapter;
}
