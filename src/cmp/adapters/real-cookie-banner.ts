/**
 * Real Cookie Banner (devowl.io, WordPress). Random ids and obfuscated classes, so structural selectors only; the
 * options object (`isAcceptAllForBots`, `groups`) is read defensively.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { readerInput } from '../adapters-file.ts';
import { defineAdapter, toCategoryStates } from './base.ts';
import { categoryFlags, flag, maybeFlag, readerResult } from './read.ts';

interface RcbRead {
  present: boolean;
  cookiePresent: boolean;
  categories: Record<string, boolean | null>;
  acceptAllForBots: boolean | null;
  respectDnt: boolean | null;
  uaBot: boolean;
  bannerVisible: boolean;
}

/** In-page, self-contained. The cookie value is parsed here and never leaves the page. */
function readRcb(botUserAgent: string): RcbRead {
  interface El {
    getBoundingClientRect(): { width: number; height: number };
  }
  type Group = { id?: unknown; slug?: unknown; isEssential?: unknown };
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

  /** Ids of the groups with at least one consented service in the cookie. */
  const readConsented = (): string[] => {
    if (!entry) return [];
    try {
      const value = decodeURIComponent(entry.slice(entry.indexOf('=') + 1));
      const json = value.slice(value.indexOf('{'));
      return Object.entries(JSON.parse(json) as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([k]) => k);
    } catch {
      return [];
    }
  };

  const readCategories = (consented: string[]): Record<string, boolean | null> => {
    const groups = Array.isArray(w.realCookieBanner?.groups) ? (w.realCookieBanner.groups as Group[]) : [];
    const categories: Record<string, boolean | null> = {};
    for (const g of groups) {
      if (g.isEssential === true) continue;

      const key = typeof g.slug === 'string' ? g.slug : String(g.id);
      categories[key] = entry ? consented.includes(String(g.id)) : false;
    }
    // Without a group list the cookie can only say whether anything beyond the essential group was consented.
    if (groups.length === 0 && entry) categories['non-essential'] = consented.length > 1;
    return categories;
  };

  const isBannerVisible = (): boolean => {
    const rect = w.document.querySelector('div[consent-skip-blocker="1"][data-bg]')?.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  };

  return {
    present: w.consentApi !== undefined && w.consentApi !== null,
    cookiePresent: !!entry,
    categories: readCategories(readConsented()),
    acceptAllForBots: bool(w.realCookieBanner?.isAcceptAllForBots),
    respectDnt: bool(w.realCookieBanner?.isRespectDoNotTrack),
    uaBot: new RegExp(botUserAgent, 'i').test(w.navigator.userAgent),
    bannerVisible: isBannerVisible(),
  };
}

/** The reader's answer; the group slugs and ids are the page's, the stored state keeps only names (`foldCategories`). */
const RcbAnswer = z.object({
  present: flag,
  cookiePresent: flag,
  categories: categoryFlags,
  acceptAllForBots: maybeFlag,
  respectDnt: maybeFlag,
  uaBot: flag,
  bannerVisible: flag,
});

const read = async (page: Page): Promise<RcbRead> =>
  readerResult(RcbAnswer, await page.evaluate(readRcb, readerInput('real-cookie-banner', 'botUserAgent')));

const botBranch = (r: RcbRead) =>
  r.acceptAllForBots === true && r.uaBot && r.cookiePresent && !r.bannerVisible;

export const realCookieBanner = defineAdapter({
  id: 'real-cookie-banner',
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
