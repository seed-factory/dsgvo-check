/** Cookiebot (Usercentrics A/S); selectors from the vendor's public DOM ids, read-only API access. */
import type { Page } from 'playwright-core';
import type { ConsentStateFact } from '../types.ts';
import { decisionMethod, defineAdapter, toCategoryStates as toCategories } from './base.ts';

interface CookiebotRead {
  apiPresent: boolean;
  apiLoaded: boolean;
  hasResponse: boolean | null;
  method: string | null;
  categories: Record<string, boolean | null>;
  isOutOfRegion: boolean | null;
  gdprApplies: boolean | null;
  spider: boolean | null;
  cookiePresent: boolean;
  cookieOutOfRegion: boolean;
  cookieCategories: Record<string, boolean | null>;
  cookieMethod: string | null;
  blockingMode: string | null;
}

/** In-page, self-contained. The cookie value is parsed here and never leaves the page. */
function readCookiebot(): CookiebotRead {
  interface Api {
    consent?: Record<string, unknown>;
    hasResponse?: unknown;
    isOutOfRegion?: unknown;
    regulations?: { gdprApplies?: unknown };
    isSpider?: () => unknown;
  }
  const w = globalThis as unknown as {
    Cookiebot?: Api;
    document: { cookie: string; querySelector(s: string): { getAttribute(n: string): string | null } | null };
  };
  const cats = ['preferences', 'statistics', 'marketing'];
  const cb = w.Cookiebot;
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const categories: Record<string, boolean | null> = {};
  for (const c of cats) categories[c] = bool(cb?.consent?.[c]);
  let spider: boolean | null = null;
  try {
    spider = typeof cb?.isSpider === 'function' ? cb.isSpider() === true : null;
  } catch {
    spider = null;
  }
  const entry = w.document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('CookieConsent='));
  let value: string | null = null;
  if (entry) {
    try {
      value = decodeURIComponent(entry.slice('CookieConsent='.length));
    } catch {
      value = entry.slice('CookieConsent='.length);
    }
  }
  const cookieCategories: Record<string, boolean | null> = {};
  let cookieMethod: string | null = null;
  if (value !== null && value !== '-1') {
    for (const c of cats) {
      const m = new RegExp(`${c}:(true|false)`).exec(value);
      cookieCategories[c] = value === '0' ? false : m ? m[1] === 'true' : null;
    }
    cookieMethod = /method:'?(explicit|implied)/.exec(value)?.[1] ?? null;
  }
  const method = cb?.consent?.method;
  return {
    apiPresent: !!cb,
    apiLoaded: !!cb && typeof cb.hasResponse === 'boolean',
    hasResponse: bool(cb?.hasResponse),
    method: typeof method === 'string' ? method : null,
    categories,
    isOutOfRegion: bool(cb?.isOutOfRegion),
    gdprApplies: bool(cb?.regulations?.gdprApplies),
    spider,
    cookiePresent: value !== null,
    cookieOutOfRegion: value === '-1',
    cookieCategories,
    cookieMethod,
    blockingMode:
      w.document.querySelector('script[src*="cookiebot"]')?.getAttribute('data-blockingmode') ?? null,
  };
}

const read = (page: Page) => page.evaluate(readCookiebot);

export const cookiebot = defineAdapter({
  id: 'cookiebot',
  name: 'Cookiebot',
  supportedVersions: null,
  detect: {
    globals: ['Cookiebot'],
    scripts: [
      { label: 'consent.cookiebot.com/uc.js', pattern: '^https://consent\\.cookiebot\\.(com|eu)/uc\\.js' },
    ],
    dom: ['#CybotCookiebotDialog'],
    cookies: ['^CookieConsent$'],
  },
  banner: {
    containers: ['#CybotCookiebotDialog'],
    overlays: ['#CybotCookiebotDialogBodyUnderlay'],
    vendorRoles: [
      { selector: '#CybotCookiebotDialogBodyButtonDecline', role: 'reject' },
      { selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll', role: 'reject' },
      { selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', role: 'accept' },
      { selector: '#CybotCookiebotDialogBodyButtonAccept', role: 'accept' },
      { selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection', role: 'save' },
      { selector: '#CybotCookiebotDialogBodyLevelButtonCustomize', role: 'settings' },
      { selector: '#CybotCookiebotDialogBodyButtonDetails', role: 'settings' },
      { selector: '#CybotCookiebotBannerCloseButtonE2E', role: 'close' },
    ],
  },
  async readState(page) {
    const r = await read(page);
    const special = r.isOutOfRegion === true || r.spider === true || r.cookieOutOfRegion;
    const facts: ConsentStateFact[] = [];
    if (r.apiPresent) {
      facts.push({
        source: 'api',
        ready: r.apiLoaded ? 'ready' : 'loading',
        categories: toCategories(r.categories),
        origin: special ? 'special-branch' : r.hasResponse ? 'stored' : 'default',
        decision: { responded: r.hasResponse ?? 'unknown', method: decisionMethod(r.method) },
      });
    }
    if (r.cookiePresent) {
      facts.push({
        source: 'cookie',
        ready: 'ready',
        categories: r.cookieOutOfRegion
          ? { preferences: 'granted', statistics: 'granted', marketing: 'granted' }
          : toCategories(r.cookieCategories),
        origin: special ? 'special-branch' : 'stored',
        decision: { responded: !r.cookieOutOfRegion, method: decisionMethod(r.cookieMethod) },
      });
    }
    return facts;
  },
  async readGeo(page) {
    const r = await read(page);
    if (r.spider === true) return []; // the bot branch also sets "out of region"; reported as bot, not geo
    return [
      ...(r.isOutOfRegion === true ? [{ cmpId: 'cookiebot', signal: 'cookiebot:isOutOfRegion' }] : []),
      ...(r.cookieOutOfRegion ? [{ cmpId: 'cookiebot', signal: 'cookiebot:CookieConsent=-1' }] : []),
      ...(r.gdprApplies === false ? [{ cmpId: 'cookiebot', signal: 'cookiebot:gdprApplies=false' }] : []),
    ];
  },
  async readBot(page) {
    const r = await read(page);
    return r.spider === true ? [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] : [];
  },
  async readConfig(page) {
    const r = await read(page);
    return {
      config: {
        'cookiebot.consentMethod': r.method ?? r.cookieMethod,
        'cookiebot.blockingMode': r.blockingMode,
      },
      closeMeansAccept: null,
    };
  },
  isReady: async (page) => (await read(page)).apiLoaded,
});
