/**
 * Real Cookie Banner (devowl.io, WordPress). Random ids and obfuscated classes, so structural selectors only; the
 * options object (`isAcceptAllForBots`, `groups`) is read defensively.
 */
import type { Page } from 'playwright-core';
import { versionFromUrl } from '../detection.ts';
import { defineAdapter, toCategoryStates } from './base.ts';

interface RcbRead {
  present: boolean;
  cookiePresent: boolean;
  categories: Record<string, boolean | null>;
  acceptAllForBots: boolean | null;
  respectDnt: boolean | null;
  uaBot: boolean;
  bannerVisible: boolean;
}

function readRcb(): RcbRead {
  interface El {
    getBoundingClientRect(): { width: number; height: number };
  }
  const w = globalThis as unknown as {
    consentApi?: unknown;
    realCookieBanner?: { isAcceptAllForBots?: unknown; isRespectDoNotTrack?: unknown; groups?: unknown };
    document: { cookie: string; querySelector(s: string): El | null };
    navigator: { userAgent: string };
  };
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const entry = w.document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('real_cookie_banner'));
  let consented: string[] = [];
  if (entry) {
    try {
      const value = decodeURIComponent(entry.slice(entry.indexOf('=') + 1));
      const json = value.slice(value.indexOf('{'));
      consented = Object.entries(JSON.parse(json) as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([k]) => k);
    } catch {
      consented = [];
    }
  }
  const groups = Array.isArray(w.realCookieBanner?.groups)
    ? (w.realCookieBanner.groups as Array<{ id?: unknown; slug?: unknown; isEssential?: unknown }>)
    : [];
  const categories: Record<string, boolean | null> = {};
  for (const g of groups) {
    if (g.isEssential === true) continue;
    const key = typeof g.slug === 'string' ? g.slug : String(g.id);
    categories[key] = entry ? consented.includes(String(g.id)) : false;
  }
  if (groups.length === 0 && entry) categories['non-essential'] = consented.length > 1;
  const banner = w.document.querySelector('div[consent-skip-blocker="1"][data-bg]');
  const rect = banner?.getBoundingClientRect();
  return {
    present: w.consentApi !== undefined && w.consentApi !== null,
    cookiePresent: !!entry,
    categories,
    acceptAllForBots: bool(w.realCookieBanner?.isAcceptAllForBots),
    respectDnt: bool(w.realCookieBanner?.isRespectDoNotTrack),
    uaBot:
      /bot|crawl|spider|slurp|headless|lighthouse|http|\.com\b|scan|check|monitor|fetch|curl|wget|python/i.test(
        w.navigator.userAgent,
      ),
    bannerVisible: !!rect && rect.width > 0 && rect.height > 0,
  };
}

const read = (page: Page) => page.evaluate(readRcb);

const botBranch = (r: RcbRead) =>
  r.acceptAllForBots === true && r.uaBot && r.cookiePresent && !r.bannerVisible;

export const realCookieBanner = defineAdapter({
  id: 'real-cookie-banner',
  name: 'Real Cookie Banner',
  supportedVersions: null,
  detect: {
    globals: ['consentApi', 'realCookieBanner'],
    scripts: [
      {
        label: 'wp-content/plugins/real-cookie-banner',
        pattern: '/wp-content/plugins/real-cookie-banner(-pro)?/',
      },
    ],
    dom: ['div[consent-skip-blocker="1"][data-bg]'],
    cookies: ['^real_cookie_banner'],
  },
  version: (raw) => versionFromUrl(raw.scriptUrls[0]),
  banner: {
    containers: [
      'div[consent-skip-blocker="1"][data-bg] dialog',
      'div[consent-skip-blocker="1"][data-bg] [role="dialog"]',
      'div[consent-skip-blocker="1"][data-bg]',
    ],
    overlays: ['div[consent-skip-blocker="1"][data-bg]'],
    vendorRoles: [],
  },
  async readState(page) {
    const r = await read(page);
    if (!r.present && !r.cookiePresent) return [];
    const bot = botBranch(r);
    return [
      {
        source: 'cookie',
        ready: r.present || r.cookiePresent ? 'ready' : 'loading',
        categories: toCategoryStates(r.categories),
        origin: bot ? 'special-branch' : r.cookiePresent ? 'stored' : 'default',
        decision: {
          responded: bot ? 'unknown' : r.cookiePresent,
          method: r.cookiePresent && !bot ? 'explicit' : 'unknown',
        },
      },
    ];
  },
  async readBot(page) {
    const r = await read(page);
    return botBranch(r)
      ? [{ cmpId: 'real-cookie-banner', signal: 'rcb:accept-all-for-bots', detail: 'ua-matches-bot-pattern' }]
      : [];
  },
  async readConfig(page) {
    const r = await read(page);
    return {
      config: { 'rcb.isAcceptAllForBots': r.acceptAllForBots, 'rcb.isRespectDoNotTrack': r.respectDnt },
      closeMeansAccept: null,
    };
  },
  isReady: async (page) => (await read(page)).present,
});
