// Bridge to the CMP subsystem, reached ONLY through `src/cmp/index.ts` and loaded lazily, so a broken CMP module costs
// CMP facts, not the collection. Calls are time-boxed; failures are recorded, never thrown. Tests may inject a stub.
import type { Page } from 'playwright-core';
import type { ClassifyOptions } from '../../cmp/classify.ts';
import type {
  ClickOutcome,
  ClickTarget,
  CmpAdapter,
  CmpButton,
  CmpDetection,
  CmpFacts,
  RawDialogText,
  SettingsChoice,
  SettingsLayerFacts,
  VerifyResult,
} from '../../cmp/types.ts';
import { redactCmpLabel } from '../../core/redaction/page-names.ts';
import type { ClickPlan, ClickPlanTarget } from '../../core/snapshot/browser.ts';
import { CMP_DIALOG_TEXT_MAX_CHARS, type CmpDialogMentions } from '../../core/snapshot/cmp-dialog.ts';
import type { BrowserPhase, CollectorError, SanitizedUrl } from '../../core/snapshot/common.ts';
import { dialogMentionsOf } from './dialog-mentions.ts';
import { sanitizeRequestUrl } from './recording/features.ts';
import { pageCallFailure, redactFreeText, withTimeout } from './util.ts';

export type Detected = { adapter: CmpAdapter | null; detection: CmpDetection };

export type ClickTargets = { reject: CmpButton | null; accept: CmpButton | null };

export interface CmpApi {
  detectCmp(page: Page): Promise<Detected>;
  waitForCmp?(page: Page, timeoutMs: number): Promise<Detected>;
  waitForBanner?(page: Page, adapter: CmpAdapter, timeoutMs: number): Promise<boolean>;
  extract(
    page: Page,
    adapter: CmpAdapter | null,
    moment: CmpFacts['moment'],
    phase: BrowserPhase,
  ): Promise<CmpFacts>;
  chooseTargets?(facts: CmpFacts, options: ClassifyOptions): Promise<ClickTargets | null>;
  /** Core's settings control for a first layer without reject; null when the first layer does not qualify. */
  chooseSettingsOpener?(facts: CmpFacts, options: ClassifyOptions): Promise<SettingsChoice | null>;
  /** Core's save control of the opened settings layer, or why there is none. */
  chooseSettingsSave?(layer: SettingsLayerFacts): Promise<SettingsChoice>;
  /** The whole text of the adapter's dialog, hidden details included, as the page holds it; null without its container. */
  dialogText?(page: Page, adapter: CmpAdapter, maxChars: number): Promise<RawDialogText | null>;
}

/** Type only: signature drift is a compile error, not a runtime surprise. */
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
  chooseTargets: async (facts, options) => {
    const m = await cmpModule();
    return m.classifyFirstLayer(facts, m.loadLexicon(), options).targets ?? null;
  },
  chooseSettingsOpener: async (facts, options) => {
    const m = await cmpModule();
    return m.chooseSettingsOpener(facts, m.loadLexicon(), options);
  },
  chooseSettingsSave: async (layer) => {
    const m = await cmpModule();
    return m.chooseSettingsSave(layer, m.loadLexicon());
  },
  dialogText: async (page, adapter, maxChars) =>
    (await cmpModule()).readDialogText(page, adapter, { maxChars }),
};

// The collector owns phase and page attribution: overwrite `phase`/`pageUrl` and sanitize URL fields the CMP subsystem
// filled from the live page. Strings copied from the page (control names, legal-link texts, footer labels) pass
// `redactFreeText`, so an address in a link text loses its local part before it is stored.
export function normalizeFacts(facts: CmpFacts, phase: BrowserPhase, pageUrl: SanitizedUrl): CmpFacts {
  facts.phase = phase;
  facts.pageUrl = pageUrl;
  if (facts.detection.frameUrl) facts.detection.frameUrl = sanitizeRequestUrl(facts.detection.frameUrl);

  const layer = facts.firstLayer;
  layer.buttons = layer.buttons.map((b) => ({ ...b, name: redactCmpLabel(redactFreeText(b.name)) }));
  if (layer.legalLinks) {
    layer.legalLinks = layer.legalLinks.map((l) => ({
      text: redactFreeText(l.text),
      href: l.href ? sanitizeRequestUrl(l.href) : null,
    }));
  }
  if (layer.coveredFooterLinks) {
    layer.coveredFooterLinks = layer.coveredFooterLinks.map((l) => ({
      ...l,
      label: redactCmpLabel(redactFreeText(l.label)),
    }));
  }
  return facts;
}

/** Control names of the settings layer are page text: they pass `redactFreeText` like those of the first layer. */
export function normalizeSettings(layer: SettingsLayerFacts): SettingsLayerFacts {
  return {
    ...layer,
    buttons: layer.buttons.map((b) => ({ ...b, name: redactCmpLabel(redactFreeText(b.name)) })),
  };
}

/** The catalog services the dialog names; `absent` without a reader or a container; `failed` when it could not be read. */
export type DialogMentionsRead = CmpDialogMentions | 'absent' | 'failed';

/** A plan target as the adapter clicks it. */
function clickTarget(planned: ClickPlanTarget, kind: ClickTarget['kind']): ClickTarget {
  return {
    name: planned.name,
    role: planned.role ?? 'button',
    ...(planned.selector ? { selector: planned.selector } : {}),
    kindConfidence: planned.kindConfidence,
    kind,
  };
}

// `v1` right after the click, `v2` after the collector's reload. A CMP that updates asynchronously may confirm the
// reject only after the reload: it then counts as verified, marked `verified-after-reload-only` in `method`. A state
// our click left unchanged was there before it, so the reload only reads it again and confirms nothing.
export function combineVerify(v1: VerifyResult | null, v2: VerifyResult | null): VerifyResult | undefined {
  const persistedAfterReload = v2 ? v2.verified : null;
  const unchangedByClick = v1?.reason?.endsWith(':unchanged-after-click') === true;
  if (v1?.verified || (v1 && (unchangedByClick || !v2?.verified))) return { ...v1, persistedAfterReload };
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
  private readonly classify: ClassifyOptions;

  constructor(
    api: CmpApi,
    timeoutMs: number,
    errors: CollectorError[],
    phase: BrowserPhase,
    classify: ClassifyOptions,
  ) {
    this.api = api;
    this.timeoutMs = timeoutMs;
    this.errors = errors;
    this.phase = phase;
    this.classify = classify;
  }

  private async call<T>(
    what: string,
    url: string,
    fn: () => Promise<T>,
    onError?: () => void,
  ): Promise<T | null> {
    try {
      return await withTimeout(fn(), this.timeoutMs, `cmp.${what}`);
    } catch (err) {
      onError?.();
      const code = `cmp-${what}-failed`;
      // The adapters' code runs in the page: only the kind of failure is kept, see pageCallFailure.
      const message = pageCallFailure(err);
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
    return this.call('classify', url, () => choose(facts, this.classify));
  }

  // The adapter clicks exactly the element core chose and decides nothing; `null` means nothing to click
  // (`no-unambiguous-<action>`).
  act(
    page: Page,
    adapter: CmpAdapter,
    action: 'reject' | 'accept',
    planned: ClickPlan['target'],
    url: string,
  ): Promise<ClickOutcome | null> {
    const target = planned ? clickTarget(planned, action) : null;
    return this.call(action, url, () => {
      if (adapter.act) return adapter.act(page, action, target);
      return action === 'reject' ? adapter.reject(page, { target }) : adapter.accept(page, { target });
    });
  }

  /** Core's settings control on the first layer; null when the first layer does not qualify or the call failed. */
  settingsOpener(facts: CmpFacts, url: string): Promise<SettingsChoice | null> {
    const choose = this.api.chooseSettingsOpener;
    if (!choose) return Promise.resolve(null);
    return this.call('classify-settings', url, () => choose(facts, this.classify));
  }

  /** Clicks the settings control core chose and reads the layer; toggles and saves nothing. */
  async openSettings(
    page: Page,
    adapter: CmpAdapter,
    opener: ClickPlanTarget,
    url: string,
    waitMs: number,
  ): Promise<SettingsLayerFacts | null> {
    const open = adapter.openSettings;
    if (!open) return null;
    const layer = await this.call('settings', url, () =>
      open.call(adapter, page, clickTarget(opener, 'settings'), { timeoutMs: waitMs }),
    );
    return layer ? normalizeSettings(layer) : null;
  }

  /**
   * Reads the whole text of the recognised CMP's dialog without a click and hands out only the catalog services it
   * names (`dialogMentionsOf`): the text does not leave this method. `absent` when the adapter has no reader or the
   * container is not there; `failed` when the read threw or timed out (one phase error records it) or the record did
   * not fit the snapshot schema.
   */
  async dialogMentions(
    page: Page,
    adapter: CmpAdapter,
    version: string | null,
    url: SanitizedUrl,
  ): Promise<DialogMentionsRead> {
    const read = this.api.dialogText;
    if (!read) return 'absent';
    let failed = false;
    const raw = await this.call(
      'dialog-mentions',
      url,
      () => read(page, adapter, CMP_DIALOG_TEXT_MAX_CHARS),
      () => {
        failed = true;
      },
    );
    if (failed) return 'failed';
    if (!raw) return 'absent';
    const takenAt = new Date().toISOString();
    return dialogMentionsOf(raw, { adapter, version, pageUrl: url, takenAt }) ?? 'failed';
  }

  settingsSave(layer: SettingsLayerFacts, url: string): Promise<SettingsChoice | null> {
    const choose = this.api.chooseSettingsSave;
    if (!choose) return Promise.resolve(null);
    return this.call('classify-settings', url, () => choose(layer));
  }

  /**
   * State check without reload: the collector performs and records the reload itself. `waitMs` bounds the wait for an
   * answer the CMP records late (Shopware's accept).
   */
  verify(
    page: Page,
    adapter: CmpAdapter,
    action: 'reject' | 'accept',
    url: string,
    waitMs: number,
  ): Promise<VerifyResult | null> {
    return this.call('verify', url, () => adapter.verify(page, action, { reload: false, timeoutMs: waitMs }));
  }
}
