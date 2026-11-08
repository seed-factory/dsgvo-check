/**
 * Shared adapter machinery: what an adapter recognises and where its banner is comes from test/data/cmp/adapters.yaml,
 * the adapter file adds read-only readers that run in the page (serialized, so self-contained). Clicking executes core's
 * target on exactly one element.
 */
import type { Page } from 'playwright-core';
import { hasStoredNameSyntax, isCategoryKey, isStoredName } from '../../core/redaction/page-names.ts';
import { sanitizeUrl } from '../../core/url/url.ts';
import { type AdapterData, supportedVersionsOf } from '../adapters-data.ts';
import { adapterData } from '../adapters-file.ts';
import { classifyFirstLayer } from '../classify.ts';
import { type ClickError, clickFailure, noTarget, reloadFailure } from '../click-errors.ts';
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
import { geometrySignature } from '../geometry.ts';
import { loadLexicon } from '../lexicon-file.ts';
import { cmpDetectProbe, type DetectArgs, type DetectRaw, tcfPingProbe } from '../page/detect.ts';
import { type BannerSpec, measureBanner, readBannerText } from '../page/measure.ts';
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
  SettingsLayerFacts,
  VerifyOptions,
  VerifyResult,
} from '../types.ts';

const CLICK_TIMEOUT_MS = 5000;

/** Default wait in `verify` for the reload, the adapter's readiness and an answer the CMP records late. */
const VERIFY_TIMEOUT_MS = 8000;

const WAIT_STEP_MS = 200;

/** Category keys past this many are folded into `other` too. */
const MAX_CATEGORY_KEYS = 32;

/** The category under which the states of keys that are no names are kept. */
export const OTHER_CATEGORY = 'other';

const CATEGORY_STATES: ReadonlySet<unknown> = new Set<CategoryState>([
  'denied',
  'granted',
  'partial',
  'unknown',
]);

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
  /**
   * The CMP's dialog is in the page but closed in the way of a dialog the CMP has not opened yet, with no answer stored.
   * Read for the first screen only; `waitForBanner` decides whether the wait for it had run out.
   */
  readDialogNotOpened?(page: Page): Promise<boolean>;
  isReady(page: Page): Promise<boolean>;
  /** The API cannot list the installation's categories (CookieHub), so a category left `denied` by our accept click may not exist. */
  categoriesUnlisted?: boolean;
  /**
   * The categories are permission cookies known by name (Shopware): only an answer our click newly recorded is its
   * result, and `verify.method` names that basis.
   */
  knownFlags?: boolean;
  /**
   * Clicks whose answer the CMP records some time after the click (Shopware's "accept all" first fetches the
   * installation's cookie list): `verify` waits for an answer up to its `timeoutMs` before it reads the state.
   */
  delayedAnswer?: ReadonlyArray<'reject' | 'accept'>;
}

const answered = (states: readonly ConsentStateFact[]): boolean =>
  states.some((s) => s.ready === 'ready' && s.decision?.responded === true);

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The detection probe's answer as the Node side takes it. The probe runs in the page, which can change what it returns:
 * a global, script or selector counts only when it is the vendor's own (adapters.yaml), a cookie or storage name only
 * when it has the syntax of a stored name (`hasStoredNameSyntax`: the probe splits `document.cookie` with built-ins the
 * page can replace, so a `name=value` pair may come back as a name) and the vendor's pattern matches it here; a name with
 * an identifier run counts but is stored as `[redacted]`. Version strings and script URLs are read for a version only.
 */
function detectRawOf(raw: unknown, d: AdapterData['detect']): DetectRaw {
  const r = isRecord(raw) ? raw : {};
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
  const among = (v: unknown, known: readonly string[]) => strings(v).filter((x) => known.includes(x));
  const named = (v: unknown, patterns: readonly string[]) => {
    const res = patterns.map((p) => new RegExp(p));
    return strings(v)
      .filter((n) => hasStoredNameSyntax(n) && res.some((re) => re.test(n)))
      .map((n) => (isStoredName(n) ? n : '[redacted]'));
  };

  const versions: Record<string, string> = {};
  if (isRecord(r.versions)) {
    for (const path of d.versionGlobals) {
      const v = Object.hasOwn(r.versions, path) ? r.versions[path] : undefined;
      if (typeof v === 'string') versions[path] = v;
    }
  }
  return {
    globals: among(r.globals, d.globals),
    versions,
    scripts: among(
      r.scripts,
      d.scripts.map((s) => s.label),
    ),
    scriptUrls: strings(r.scriptUrls).slice(0, d.scripts.length),
    dom: among(r.dom, d.dom),
    cookies: named(r.cookies, d.cookies),
    storage: named(r.storage, d.storage),
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

/**
 * The categories with only names as keys (`isCategoryKey`). The page chooses the keys (a group slug, a key in the value
 * of its consent cookie), so any other key, and any past the first `MAX_CATEGORY_KEYS`, is folded into one `other`. Its
 * state is that of the folded ones when they agree, else `partial`: a verdict over all categories stays the same. A
 * value that is no state is `unknown`.
 */
export function foldCategories(categories: Readonly<Record<string, unknown>>): Record<string, CategoryState> {
  const out: Record<string, CategoryState> = {};
  const folded = new Set<CategoryState>();
  let kept = 0;
  for (const [key, value] of Object.entries(categories)) {
    const state = CATEGORY_STATES.has(value) ? (value as CategoryState) : 'unknown';
    if (key !== OTHER_CATEGORY && kept < MAX_CATEGORY_KEYS && isCategoryKey(key)) {
      out[key] = state;
      kept++;
    } else {
      folded.add(state);
    }
  }
  const [only, ...more] = folded;
  if (only !== undefined) out[OTHER_CATEGORY] = more.length === 0 ? only : 'partial';
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

/** The TCF CMP id is a 12-bit field. */
const MAX_TCF_CMP_ID = 4095;

/**
 * `tcf:gdprApplies=false` from the TCF ping. The page provides `__tcfapi` and even the `Promise` the ping answers with,
 * so only an exact answer counts, and the CMP id only as a number the field can hold.
 */
export async function tcfGeoSignals(page: Page): Promise<GeoSignal[]> {
  const r: unknown = await safe(page.evaluate(tcfPingProbe), null);
  if (!isRecord(r) || r.present !== true || r.gdprApplies !== false) return [];
  const id = r.cmpId;
  const known = typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= MAX_TCF_CMP_ID;
  return [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false', ...(known ? { detail: `cmpId=${id}` } : {}) }];
}

/** Click one element by its selector: exactly one match, `locator.click()` with actionability checks, no `force`. */
export async function clickButton(
  page: Page,
  button: Pick<CmpButton, 'selector'>,
  timeoutMs = CLICK_TIMEOUT_MS,
): Promise<{ clicked: boolean; error?: ClickError }> {
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
    return { clicked: false, error: clickFailure(err) };
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
    get rejectsViaSettings() {
      return data().settingsLayer !== undefined;
    },
    get dialogBotUserAgent() {
      return data().dialogBotUserAgent;
    },

    async detect(page): Promise<CmpDetection | null> {
      const vendor = data();
      const answer: unknown = await safe(page.evaluate(cmpDetectProbe, detectArgsOf(vendor.detect)), null);
      if (!answer) return null;
      const raw = detectRawOf(answer, vendor.detect);
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
      // Read after the measurement: a dialog that opened in between is visible to it, so it is not called unopened.
      const layer = measured.firstLayer;
      const notOpened =
        moment === 'first-screen' &&
        layer.bannerPresent &&
        !layer.bannerVisible &&
        (await safe(spec.readDialogNotOpened?.(page), false));
      return {
        phase: opts.phase ?? 'B',
        pageUrl: sanitizeUrl(page.url()),
        moment,
        takenAt,
        viewport: measured.viewport,
        detection,
        firstLayer: notOpened ? { ...layer, dialogNotOpened: true } : layer,
        blocking: measured.blocking,
        state,
        geoSignals,
        botSignals,
        config: cfg.config,
      };
    },

    // Every state passes here, those `verify` compares included: category keys come from the page.
    state: (page) =>
      safe(
        spec
          .readState(page)
          .then((states) => states.map((s) => ({ ...s, categories: foldCategories(s.categories) }))),
        [],
      ),

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
    openSettings: (page, opener, opts = {}) =>
      openSettings(page, opener, opts.timeoutMs ?? VERIFY_TIMEOUT_MS),

    async verify(page, action, opts: VerifyOptions = {}): Promise<VerifyResult> {
      const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;

      // `action` only in the document of our click and only for an answer the click produced; after any
      // reload (ours or the collector's) the adapter's own origin (`stored`) stays.
      const click = await clickInThisDocument(page);
      if (click !== null && spec.delayedAnswer?.includes(action)) {
        await waitUntil(async () => answered(await adapter.state(page)), timeoutMs);
      }
      const now = await adapter.state(page);
      const stateNow = originAfterClick(now, click?.before ?? null, click !== null, {
        newAnswerOnly: spec.knownFlags === true,
      });
      const ignoreCategories =
        action === 'accept' && spec.categoriesUnlisted === true && click !== null
          ? unchangedDeniedAfterAccept(click.before, now)
          : [];
      const verdict = stateVerdict(stateNow, action, {
        requireAction: click !== null,
        ignoreCategories,
        knownFlags: spec.knownFlags === true,
      });

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

    dialogText: (page, opts) => readBannerText(page, data().banner, loadLexicon(), opts.maxChars),
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
      return { persisted: null, state: [], reason: reloadFailure(err) };
    }
  }

  /**
   * Clicks the settings control core chose and reads the layer once it shows and stands still: its controls, measured
   * like a first layer with the vendor's save and reject roles, and its group switches. Not a click of `execute`: the
   * consent state before the save, not before this click, is what `verify` compares with.
   */
  async function openSettings(
    page: Page,
    opener: ClickTarget,
    timeoutMs: number,
  ): Promise<SettingsLayerFacts> {
    const layer = data().settingsLayer;
    const closed = (error?: ClickError): SettingsLayerFacts => ({
      takenAt: new Date().toISOString(),
      opened: false,
      ...(error ? { error } : {}),
      buttons: [],
      containerUnambiguous: false,
      buttonsTruncated: false,
      groups: [],
      essentialGroups: layer?.essentialGroups ?? 0,
    });
    if (!layer) return closed('no-settings-layer');

    const res = await clickButton(page, opener, Math.min(timeoutMs, CLICK_TIMEOUT_MS));
    if (!res.clicked) return closed(res.error ?? 'click-failed');

    const lexicon = loadLexicon();
    const spec: BannerSpec = {
      containers: layer.containers,
      vendorRoles: layer.vendorRoles,
      switches: layer.groups,
    };
    const measure = () => measureBanner(page, spec, lexicon);
    // Shown = visible, no animation running, at least one control rendered, and the same boxes in two readings in a
    // row. Some vendors show the layer's overlay at once and start fading its panel in only a moment later: a reading
    // in between finds the container visible but every control inside it still transparent.
    const seen: { previous: string | null; last: Awaited<ReturnType<typeof measure>> | null } = {
      previous: null,
      last: null,
    };
    const settled = await waitUntil(async () => {
      const m = await measure();
      seen.last = m;
      const layerNow = m.firstLayer;
      const ready =
        layerNow.bannerVisible &&
        layerNow.containerAnimating !== true &&
        layerNow.buttons.some((b) => b.box !== null);
      const signature = ready ? geometrySignature(layerNow) : null;
      const still = signature !== null && signature === seen.previous;
      seen.previous = signature;
      return still;
    }, timeoutMs);
    // A layer that showed but never settled is read as it was last measured; its controls decide on their own whether
    // anything can be saved.
    const measured = seen.last;
    if (!measured || (!settled && !measured.firstLayer.bannerVisible)) return closed();

    // One measurement for the controls and the switches: both come from the container the probe chose.
    const first = measured.firstLayer;
    return {
      takenAt: new Date().toISOString(),
      opened: first.bannerVisible,
      buttons: first.buttons,
      containerUnambiguous: first.containerUnambiguous === true,
      buttonsTruncated: first.buttonsTruncated === true,
      groups: measured.raw?.switches ?? [],
      essentialGroups: layer.essentialGroups,
    };
  }

  /** Clicks exactly the target core chose; no classification here. */
  async function execute(
    page: Page,
    action: 'reject' | 'accept',
    target: ClickTarget | null,
    timeoutMs?: number,
  ): Promise<ClickOutcome> {
    if (!target) return { action, clicked: false, button: null, error: noTarget(action) };
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
    if (!opts.facts) return { action, clicked: false, button: null, error: 'no-target' satisfies ClickError };
    const cls = classifyFirstLayer(opts.facts, opts.lexicon ?? loadLexicon(), {
      blockingCoveredRatio: opts.blockingCoveredRatio,
    });
    const target = (action === 'reject' ? cls.targets?.reject : cls.targets?.accept) ?? null;
    if (!target) return { action, clicked: false, button: null, error: noTarget(action, cls.variant) };
    return execute(page, action, target, opts.timeoutMs);
  }

  return adapter;
}
