/**
 * Bridge to the CMP subsystem. The collector calls it ONLY through `src/cmp/index.ts` (the default
 * `CmpApi`, loaded lazily so that a broken CMP module costs CMP facts, not the whole collection); tests may inject a
 * stub with the same shape. Every call is time-boxed and failures are recorded, never thrown.
 */
import type { Page } from 'playwright-core';
import type {
  ClickOutcome,
  ClickTarget,
  CmpAdapter,
  CmpButton,
  CmpDetection,
  CmpFacts,
  VerifyResult,
} from '../../cmp/types.ts';
import type { BrowserPhase, CollectorError, SanitizedUrl } from '../../core/snapshot-common.ts';
import { sanitizeRequestUrl } from './features.ts';
import type { ClickPlan } from './types.ts';
import { errorText, redactFreeText, withTimeout } from './util.ts';

export type Detected = { adapter: CmpAdapter | null; detection: CmpDetection };
export type ClickTargets = { reject: CmpButton | null; accept: CmpButton | null };

export interface CmpApi {
  detectCmp(page: Page): Promise<Detected>;
  /** Poll until a recognized CMP is ready (optional; falls back to `detectCmp`). */
  waitForCmp?(page: Page, timeoutMs: number): Promise<Detected>;
  /** Poll until the adapter's banner is rendered (late banners); resolves whether it appeared (optional). */
  waitForBanner?(page: Page, adapter: CmpAdapter, timeoutMs: number): Promise<boolean>;
  extract(
    page: Page,
    adapter: CmpAdapter | null,
    moment: CmpFacts['moment'],
    phase: BrowserPhase,
  ): Promise<CmpFacts>;
  /** The click decision of the pure `classifyFirstLayer` (optional; else the facts' unique button). */
  chooseTargets?(facts: CmpFacts): Promise<ClickTargets | null>;
}

/** `src/cmp/index.ts` (type only): signature drift between M1 and M2 is a compile error, not a runtime surprise. */
type CmpModule = typeof import('../../cmp/index.ts');

let modulePromise: Promise<CmpModule> | null = null;
function cmpModule(): Promise<CmpModule> {
  modulePromise ??= import('../../cmp/index.ts');
  return modulePromise;
}

export const defaultCmpApi: CmpApi = {
  detectCmp: async (page) => (await cmpModule()).detectCmp(page),
  waitForCmp: async (page, timeoutMs) => (await cmpModule()).waitForCmp(page, { timeoutMs }),
  waitForBanner: async (page, adapter, timeoutMs) =>
    (await cmpModule()).waitForBanner(page, adapter, { timeoutMs }),
  extract: async (page, adapter, moment, phase) =>
    (await cmpModule()).extract(page, adapter, moment, { phase }),
  chooseTargets: async (facts) => {
    const m = await cmpModule();
    return m.classifyFirstLayer(facts, m.loadLexicon()).targets ?? null;
  },
};

/**
 * The collector owns phase and page attribution, and the snapshot only holds sanitized URLs: overwrite
 * `phase`/`pageUrl` and sanitize URL fields the CMP subsystem may have filled from the live page. Strings that the
 * probe copied from the page (accessible names of controls, text of the legal links of the banner, labels of covered
 * footer links) pass `redactFreeText`: an address in a link text loses its local part before it is stored.
 * The click `selector` is no free text; the probe does not build it from an attribute value that holds an address.
 */
export function normalizeFacts(facts: CmpFacts, phase: BrowserPhase, pageUrl: SanitizedUrl): CmpFacts {
  facts.phase = phase;
  facts.pageUrl = pageUrl;
  if (facts.detection.frameUrl) facts.detection.frameUrl = sanitizeRequestUrl(facts.detection.frameUrl);
  const layer = facts.firstLayer;
  layer.buttons = layer.buttons.map((b) => ({ ...b, name: redactFreeText(b.name) }));
  if (layer.legalLinks) {
    layer.legalLinks = layer.legalLinks.map((l) => ({
      text: redactFreeText(l.text),
      href: l.href ? sanitizeRequestUrl(l.href) : null,
    }));
  }
  if (layer.coveredFooterLinks) {
    layer.coveredFooterLinks = layer.coveredFooterLinks.map((l) => ({
      ...l,
      label: redactFreeText(l.label),
    }));
  }
  return facts;
}

/**
 * Verification of B: `v1` right after the click, `v2` after the collector's reload. A CMP that updates its
 * state asynchronously may confirm the reject only after the reload: then the reject counts as verified, marked
 * `verified-after-reload-only` in `method`. `persistedAfterReload` is the reload result (null without one).
 */
export function combineVerify(v1: VerifyResult | null, v2: VerifyResult | null): VerifyResult | undefined {
  const persistedAfterReload = v2 ? v2.verified : null;
  if (v1?.verified || (v1 && !v2?.verified)) return { ...v1, persistedAfterReload };
  if (v2?.verified) {
    return {
      ...v2,
      method: [...v2.method, 'verified-after-reload-only'],
      persistedAfterReload: true,
      ...(v1?.reason ? { reason: `before-reload:${v1.reason}` } : {}),
    };
  }
  return v2 ? { ...v2, persistedAfterReload } : undefined;
}

export class CmpBridge {
  private readonly api: CmpApi;
  private readonly timeoutMs: number;
  private readonly errors: CollectorError[];
  private readonly phase: BrowserPhase;

  constructor(api: CmpApi, timeoutMs: number, errors: CollectorError[], phase: BrowserPhase) {
    this.api = api;
    this.timeoutMs = timeoutMs;
    this.errors = errors;
    this.phase = phase;
  }

  private async call<T>(what: string, url: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await withTimeout(fn(), this.timeoutMs, `cmp.${what}`);
    } catch (err) {
      const code = `cmp-${what}-failed`;
      const message = errorText(err).split('\n')[0]?.slice(0, 300) ?? '';
      // The same failure on every page is reported once per phase.
      if (!this.errors.some((e) => e.code === code && e.message === message)) {
        this.errors.push({ code, message, phase: this.phase, url });
      }
      return null;
    }
  }

  detect(page: Page, url: string, waitMs = 0): Promise<Detected | null> {
    return this.call('detect', url, () =>
      waitMs > 0 && this.api.waitForCmp ? this.api.waitForCmp(page, waitMs) : this.api.detectCmp(page),
    );
  }

  /** Wait for a late banner before the first screen is measured; false when it did not appear (or no support). */
  async waitForBanner(page: Page, adapter: CmpAdapter, url: string, waitMs: number): Promise<boolean> {
    const wait = this.api.waitForBanner;
    if (!wait || waitMs <= 0) return false;
    return (await this.call('wait-banner', url, () => wait(page, adapter, waitMs))) ?? false;
  }

  extract(
    page: Page,
    adapter: CmpAdapter | null,
    moment: CmpFacts['moment'],
    url: string,
  ): Promise<CmpFacts | null> {
    return this.call('extract', url, async () =>
      normalizeFacts(await this.api.extract(page, adapter, moment, this.phase), this.phase, url),
    );
  }

  targets(facts: CmpFacts, url: string): Promise<ClickTargets | null> {
    const choose = this.api.chooseTargets;
    if (!choose) return Promise.resolve(null);
    return this.call('classify', url, () => choose(facts));
  }

  /**
   * `act(page, target)`: the adapter clicks exactly the element core chose (`plan.click[phase].target`) and
   * decides nothing. `null` means "nothing to click"; the adapter then reports `no-unambiguous-<action>`.
   */
  act(
    page: Page,
    adapter: CmpAdapter,
    action: 'reject' | 'accept',
    planned: ClickPlan['target'],
    url: string,
  ): Promise<ClickOutcome | null> {
    const target: ClickTarget | null = planned
      ? {
          name: planned.name,
          role: planned.role ?? 'button',
          ...(planned.selector ? { selector: planned.selector } : {}),
          kindConfidence: planned.kindConfidence,
          kind: action,
        }
      : null;
    return this.call(action, url, () => {
      if (adapter.act) return adapter.act(page, action, target);
      return action === 'reject' ? adapter.reject(page, { target }) : adapter.accept(page, { target });
    });
  }

  /** State check without reload: the collector performs and records the reload itself. */
  verify(
    page: Page,
    adapter: CmpAdapter,
    action: 'reject' | 'accept',
    url: string,
  ): Promise<VerifyResult | null> {
    return this.call('verify', url, () => adapter.verify(page, action, { reload: false }));
  }
}
