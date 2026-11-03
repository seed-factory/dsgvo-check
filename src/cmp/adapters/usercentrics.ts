/**
 * Usercentrics v3 and v2. The banner lives in open shadow DOM (measured and clicked through it); the shape of
 * `getConsentDetails()` is read defensively.
 */
import type { Page } from 'playwright-core';
import { majorSupported } from '../detection.ts';
import type { CategoryState } from '../types.ts';
import { defineAdapter } from './base.ts';

interface UsercentricsRead {
  v3: boolean;
  v2: boolean;
  initialized: boolean;
  categories: Record<string, CategoryState>;
  responded: boolean | 'unknown';
  method: 'explicit' | 'implied' | 'unknown';
  consentRequired: boolean | null;
}

/** In-page, self-contained, async (the v3 API returns promises). Read-only calls only. */
async function readUsercentrics(): Promise<UsercentricsRead> {
  type Fn = (...a: unknown[]) => unknown;
  const w = globalThis as unknown as {
    __ucCmp?: Record<string, Fn | undefined>;
    UC_UI?: Record<string, Fn | undefined>;
    localStorage: { getItem(k: string): string | null };
    setTimeout: typeof setTimeout;
  };
  const withTimeout = async (v: unknown): Promise<unknown> =>
    Promise.race([Promise.resolve(v), new Promise((r) => w.setTimeout(() => r(undefined), 2000))]);
  const call = async (obj: Record<string, Fn | undefined> | undefined, name: string): Promise<unknown> => {
    const f = obj?.[name];
    if (typeof f !== 'function') return undefined;
    try {
      return await withTimeout(f.call(obj));
    } catch {
      return undefined;
    }
  };
  const stateOf = (v: unknown): CategoryState => {
    if (v === true) return 'granted';
    if (v === false) return 'denied';
    const s = String(
      (v as { state?: unknown; status?: unknown } | null)?.state ??
        (v as { status?: unknown } | null)?.status ??
        '',
    );
    if (/ALL_ACCEPTED|^ACCEPTED$|^true$/i.test(s)) return 'granted';
    if (/ALL_DENIED|^DENIED$|^false$/i.test(s)) return 'denied';
    if (/SOME/i.test(s)) return 'partial';
    return 'unknown';
  };
  const out: UsercentricsRead = {
    v3: !!w.__ucCmp,
    v2: !!w.UC_UI,
    initialized: false,
    categories: {},
    responded: 'unknown',
    method: 'unknown',
    consentRequired: null,
  };
  if (w.__ucCmp) {
    out.initialized = (await call(w.__ucCmp, 'isInitialized')) === true;
    const details = (await call(w.__ucCmp, 'getConsentDetails')) as
      | { consent?: { type?: unknown }; categories?: Record<string, unknown> }
      | undefined;
    if (details) {
      out.initialized = true;
      for (const [id, v] of Object.entries(details.categories ?? {})) {
        const essential =
          (v as { essential?: unknown } | null)?.essential === true || /^essential$/i.test(id);
        if (!essential) out.categories[id] = stateOf(v);
      }
      const type = String(details.consent?.type ?? '').toUpperCase();
      out.responded = type === 'EXPLICIT' ? true : type === 'IMPLICIT' ? false : 'unknown';
      out.method = type === 'EXPLICIT' ? 'explicit' : type === 'IMPLICIT' ? 'implied' : 'unknown';
    }
    const req = await call(w.__ucCmp, 'isConsentRequired');
    out.consentRequired = typeof req === 'boolean' ? req : null;
  } else if (w.UC_UI) {
    out.initialized = (await call(w.UC_UI, 'isInitialized')) === true;
    const services = await call(w.UC_UI, 'getServicesBaseInfo');
    if (Array.isArray(services)) {
      const byCat: Record<string, boolean[]> = {};
      for (const s of services as Array<{
        categorySlug?: unknown;
        isEssential?: unknown;
        consent?: { status?: unknown };
      }>) {
        if (s.isEssential === true) continue;
        const cat = typeof s.categorySlug === 'string' ? s.categorySlug : 'uncategorized';
        const list = byCat[cat] ?? [];
        list.push(s.consent?.status === true);
        byCat[cat] = list;
      }
      for (const [cat, list] of Object.entries(byCat)) {
        out.categories[cat] = list.every(Boolean) ? 'granted' : list.some(Boolean) ? 'partial' : 'denied';
      }
    }
    let interaction: string | null = null;
    try {
      interaction = w.localStorage.getItem('uc_user_interaction');
    } catch {
      interaction = null;
    }
    out.responded =
      interaction === 'true' ? true : interaction === 'false' || interaction === null ? false : 'unknown';
    out.method = out.responded === true ? 'explicit' : 'unknown';
  }
  return out;
}

const read = (page: Page) => page.evaluate(readUsercentrics);

export const usercentrics = defineAdapter({
  id: 'usercentrics',
  name: 'Usercentrics',
  supportedVersions: '2.x || 3.x',
  detect: {
    globals: ['__ucCmp', 'UC_UI'],
    scripts: [
      {
        label: 'web.cmp.usercentrics.eu/ui/loader.js',
        pattern: '^https://web\\.cmp\\.usercentrics\\.eu/ui/loader\\.js',
      },
      { label: 'app.usercentrics.eu/browser-ui', pattern: '^https://app\\.usercentrics\\.eu/browser-ui/' },
    ],
    dom: ['#usercentrics-cmp-ui', '#usercentrics-root'],
    storage: ['^ucData$', '^uc_settings$', '^uc_user_interaction$'],
  },
  version(raw) {
    if (raw.globals.includes('__ucCmp') || raw.dom.includes('#usercentrics-cmp-ui')) return '3';
    if (raw.globals.includes('UC_UI') || raw.dom.includes('#usercentrics-root')) return '2';
    if (raw.scripts.includes('web.cmp.usercentrics.eu/ui/loader.js')) return '3';
    if (raw.scripts.includes('app.usercentrics.eu/browser-ui')) return '2';
    return null;
  },
  versionSupported: (v) => majorSupported(v, [2, 3]),
  banner: {
    containers: [
      '#uc-main-dialog',
      '[data-testid="uc-default-banner"]',
      '[data-testid="uc-center-container"]',
      '#uc-center-container',
    ],
    overlays: ['#uc-overlay', '[data-testid="uc-overlay"]'],
    vendorRoles: [
      { selector: '[data-action-type="accept"]', role: 'accept' },
      { selector: '[data-action-type="deny"]', role: 'reject' },
      { selector: '[data-action-type="more"]', role: 'settings' },
      { selector: '[data-action-type="save"]', role: 'save' },
      { selector: '[data-action-type="close"]', role: 'close' },
      { selector: '[data-testid="uc-accept-all-button"]', role: 'accept' },
      { selector: '[data-testid="uc-deny-all-button"]', role: 'reject' },
      { selector: '[data-testid="uc-more-button"]', role: 'settings' },
      { selector: '[data-testid="uc-save-button"]', role: 'save' },
    ],
  },
  async readState(page) {
    const r = await read(page);
    if (!r.v3 && !r.v2) return [];
    const geo = r.v3 && r.consentRequired === false && r.responded !== true;
    return [
      {
        source: 'api',
        ready: r.initialized ? 'ready' : 'loading',
        categories: r.categories,
        origin: geo ? 'special-branch' : r.responded === true ? 'stored' : 'default',
        decision: { responded: r.responded, method: r.method },
        scope: r.v3 ? 'v3' : 'v2',
      },
    ];
  },
  async readGeo(page) {
    const r = await read(page);
    // After an explicit answer isConsentRequired() is false as well — only without an answer it means "no banner here".
    return r.v3 && r.consentRequired === false && r.responded !== true
      ? [{ cmpId: 'usercentrics', signal: 'usercentrics:isConsentRequired=false' }]
      : [];
  },
  async readConfig(page) {
    const r = await read(page);
    return { config: { 'usercentrics.version': r.v3 ? '3' : r.v2 ? '2' : null }, closeMeansAccept: null };
  },
  isReady: async (page) => (await read(page)).initialized,
});
