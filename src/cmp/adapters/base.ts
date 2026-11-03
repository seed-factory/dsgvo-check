/**
 * Shared adapter machinery. An adapter is a declarative spec (signals, banner selectors, vendor roles) plus
 * read-only state/geo/bot readers: `extract / act / verify`. What counts as reject/accept and where to click is
 * decided by the pure `classifyFirstLayer` in core; `act(page, action, target)` only executes that target with
 * `locator.click()` without `force`, on exactly one matching element.
 */
import type { Page } from 'playwright-core';
import { sanitizeUrl } from '../../core/url.ts';
import { classifyFirstLayer } from '../classify.ts';
import {
  confidenceFromSignals,
  NOT_DETECTED,
  originAfterClick,
  stateVerdict,
  unchangedDeniedAfterAccept,
} from '../detection.ts';
import { loadLexicon } from '../lexicon-file.ts';
import { cmpDetectProbe, type DetectRaw, tcfPingProbe } from '../page/detect.ts';
import { type BannerSpec, measureBanner } from '../page/measure.ts';
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

export interface DetectSpec {
  /** Global paths, e.g. `Cookiebot`, `BorlabsCookie.Consents`. */
  globals?: string[];
  /** Global paths holding the CMP's own version string, e.g. `complianz.version` (preferred over a script URL). */
  versionGlobals?: string[];
  /** Script URL regex sources with a stable label for the signal. */
  scripts?: Array<{ label: string; pattern: string }>;
  /** Light-DOM selectors (shadow hosts included). */
  dom?: string[];
  /** Consent cookie name regex sources (names only). */
  cookies?: string[];
  /** localStorage key regex sources (names only). */
  storage?: string[];
}

export type ConfigValue = string | number | boolean | null;

export interface AdapterConfig {
  config: Record<string, ConfigValue>;
  /** "×" means accept according to the CMP config; null = unknown. */
  closeMeansAccept: boolean | null;
}

export interface AdapterSpec {
  id: KnownCmpId;
  name: string;
  supportedVersions: string | null;
  detect: DetectSpec;
  version?(raw: DetectRaw): string | null;
  versionSupported?(version: string | null): boolean | null;
  banner: BannerSpec;
  /** Read-only state. `origin` is `stored` when an answer is recorded, `default` otherwise, `special-branch` for geo/bot. */
  readState(page: Page): Promise<ConsentStateFact[]>;
  readGeo?(page: Page): Promise<GeoSignal[]>;
  readBot?(page: Page): Promise<BotSignal[]>;
  readConfig?(page: Page): Promise<AdapterConfig>;
  /** CMP initialized (API loaded). */
  isReady(page: Page): Promise<boolean>;
  /**
   * The API cannot list the categories an installation offers, only answer per name (CookieHub). A category that
   * stays `denied` through our accept click, while the click granted another one, may not exist there: it is left
   * out of the accept verdict (`categories-ignored:<names>` in `method`). Default false.
   */
  categoriesUnlisted?: boolean;
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
  timeoutMs = 5000,
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
    return { clicked: false, error: `click-failed: ${msg.slice(0, 160)}` };
  }
}

export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 200,
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
  /** Document in which our last click happened. */
  document: number;
  /** Consent state read right before that click (`action` only for a state the click changed). */
  before: ConsentStateFact[];
}

/** Page → our last click. */
const clicks = new WeakMap<Page, ClickRecord>();

/** The record of our last click when it happened in the current document, else null (any reload since). */
async function clickInThisDocument(page: Page): Promise<ClickRecord | null> {
  const click = clicks.get(page);
  if (click === undefined) return null;
  return (await documentOrigin(page)) === click.document ? click : null;
}

export function defineAdapter(spec: AdapterSpec): CmpAdapter {
  const detectArgs = {
    globals: spec.detect.globals ?? [],
    versionGlobals: spec.detect.versionGlobals ?? [],
    scripts: spec.detect.scripts ?? [],
    dom: spec.detect.dom ?? [],
    cookies: spec.detect.cookies ?? [],
    storage: spec.detect.storage ?? [],
  };

  const adapter: CmpAdapter = {
    id: spec.id,
    name: spec.name,
    supportedVersions: spec.supportedVersions,

    async detect(page): Promise<CmpDetection | null> {
      const raw = await safe(page.evaluate(cmpDetectProbe, detectArgs), null);
      if (!raw) return null;
      const signals = [
        ...raw.globals.map((g) => `global:${g}`),
        ...raw.scripts.map((s) => `script:${s}`),
        ...raw.dom.map((d) => `dom:${d}`),
        ...raw.cookies.map((c) => `cookie:${c}`),
        ...raw.storage.map((k) => `storage:${k}`),
      ];
      const confidence = confidenceFromSignals(signals);
      if (!confidence) return null;
      const version = spec.version ? spec.version(raw) : null;
      return {
        cmpId: spec.id,
        method: 'adapter',
        version,
        versionSupported: spec.versionSupported ? spec.versionSupported(version) : null,
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
      const measured = await measureBanner(page, spec.banner, lexicon, cfg.closeMeansAccept);
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
      return (await measureBanner(page, spec.banner, loadLexicon(), cfg.closeMeansAccept)).firstLayer;
    },

    act: (page, action, target, opts = {}) => execute(page, action, target, opts.timeoutMs),
    reject: (page, opts) => decideOrExecute(page, 'reject', opts),
    accept: (page, opts) => decideOrExecute(page, 'accept', opts),

    async verify(page, action, opts: VerifyOptions = {}): Promise<VerifyResult> {
      const timeoutMs = opts.timeoutMs ?? 8000;
      const now = await adapter.state(page);
      // `action` only in the document of our click and only for an answer the click produced; after any
      // reload (ours or the collector's) the adapter's own origin (`stored`) stays.
      const click = await clickInThisDocument(page);
      const stateNow = originAfterClick(now, click?.before ?? null, click !== null);
      const ignoreCategories =
        action === 'accept' && spec.categoriesUnlisted === true && click !== null
          ? unchangedDeniedAfterAccept(click.before, now)
          : [];
      const verdict = stateVerdict(stateNow, action, { requireAction: click !== null, ignoreCategories });
      const methods = [...verdict.methods];
      const bannerOpen = await safe(
        measureBanner(page, spec.banner, loadLexicon()).then((m) => m.firstLayer.bannerVisible),
        false,
      );
      if (!bannerOpen) methods.push('ui-closed');
      let persisted: boolean | null = null;
      let afterReload: ConsentStateFact[] = [];
      let reason = verdict.ok ? undefined : verdict.reason;
      if (opts.reload !== false) {
        try {
          await page.reload({ waitUntil: 'load', timeout: timeoutMs });
          await waitUntil(() => spec.isReady(page), timeoutMs);
          afterReload = await adapter.state(page);
          const again = stateVerdict(afterReload, action, { ignoreCategories });
          persisted = again.ok;
          if (again.ok) methods.push('persisted-after-reload');
          else reason ??= `after-reload:${again.reason ?? 'not-confirmed'}`;
        } catch (err) {
          reason ??= `reload-failed: ${((err as Error).message.split('\n')[0] ?? '').slice(0, 120)}`;
        }
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

  /** `act(page, target)`: click exactly the target core chose; no classification here. */
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
   * `reject`/`accept`: the target passed by core; transitional without one, the same pure decision over the passed
   * first-screen facts. Never a fresh measurement of its own (the click must be the one written to `plan.click`).
   */
  async function decideOrExecute(
    page: Page,
    action: 'reject' | 'accept',
    opts: ActOptions = {},
  ): Promise<ClickOutcome> {
    if (opts.target !== undefined) return execute(page, action, opts.target, opts.timeoutMs);
    if (!opts.facts) return { action, clicked: false, button: null, error: 'no-target' };
    const cls = classifyFirstLayer(opts.facts, opts.lexicon ?? loadLexicon());
    const target = (action === 'reject' ? cls.targets?.reject : cls.targets?.accept) ?? null;
    if (!target)
      return { action, clicked: false, button: null, error: `no-unambiguous-${action}:${cls.variant}` };
    return execute(page, action, target, opts.timeoutMs);
  }

  return adapter;
}
