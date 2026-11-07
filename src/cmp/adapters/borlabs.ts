/** Borlabs Cookie (WordPress) v2 and v3; recognition, selectors and the bot pattern are in test/data/cmp/adapters.yaml. */
import type { Page } from 'playwright-core';
import { readerInput } from '../adapters-file.ts';
import type { ConsentStateFact } from '../types.ts';
import { defineAdapter, toCategoryStates } from './base.ts';

interface BorlabsRead {
  hasGlobal: boolean;
  cookiePresent: boolean;
  groups: string[];
  geoIp: boolean | null;
  cookiesForBots: boolean | null;
  hideOnThisPage: boolean | null;
  afterInteraction: boolean | null;
  respectDnt: boolean | null;
  bannerVisible: boolean;
  uaBot: boolean;
}

/** In-page, self-contained. The cookie value is parsed here; only the names of the consented groups leave the page. */
function readBorlabs(botUserAgent: string): BorlabsRead {
  interface El {
    getBoundingClientRect(): { width: number; height: number };
  }
  const w = globalThis as unknown as {
    BorlabsCookie?: unknown;
    borlabsCookieConfig?: { settings?: Record<string, unknown> };
    document: { cookie: string; querySelector(s: string): El | null };
    location: { href: string };
    navigator: { userAgent: string };
    getComputedStyle(el: El): { visibility: string; display: string };
  };
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const withoutQuery = (url: string | undefined): string | undefined => url?.split(/[?#]/)[0];

  const entry = w.document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('borlabs-cookie='));

  /** Groups that have at least one consented service in the cookie. */
  const readGroups = (): string[] => {
    if (!entry) return [];
    try {
      const json = JSON.parse(decodeURIComponent(entry.slice('borlabs-cookie='.length))) as {
        consents?: Record<string, unknown>;
      };
      return Object.entries(json.consents ?? {})
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([k]) => k);
    } catch {
      return [];
    }
  };

  /** Whether the dialog is configured to stay hidden on this page; null when the setting is absent. */
  const readHideOnThisPage = (pages: unknown): boolean | null => {
    if (!Array.isArray(pages)) return null;
    const here = withoutQuery(w.location.href)?.replace(/\/$/, '');
    return pages.some((p) => typeof p === 'string' && withoutQuery(p)?.replace(/\/$/, '') === here);
  };

  const isBannerVisible = (): boolean => {
    const box = w.document.querySelector(
      '#BorlabsCookieBox .brlbs-cmpnt-dialog, #BorlabsCookieBox ._brlbs-box-wrap, #BorlabsCookieBox ._brlbs-bar-wrap',
    );
    if (!box) return false;

    const r = box.getBoundingClientRect();
    const st = w.getComputedStyle(box);
    return r.width > 0 && r.height > 0 && st.visibility === 'visible' && st.display !== 'none';
  };

  const s = w.borlabsCookieConfig?.settings ?? {};

  return {
    hasGlobal: w.BorlabsCookie !== undefined && w.BorlabsCookie !== null,
    cookiePresent: !!entry,
    groups: readGroups(),
    geoIp: bool(s.dialogGeoIpActive),
    cookiesForBots: bool(s.cookiesForBots),
    hideOnThisPage: readHideOnThisPage(s.dialogHideDialogOnPages),
    afterInteraction: bool(s.dialogShowDialogAfterUserInteraction),
    respectDnt: bool(s.respectDoNotTrack),
    bannerVisible: isBannerVisible(),
    uaBot: new RegExp(botUserAgent, 'i').test(w.navigator.userAgent),
  };
}

const read = (page: Page) => page.evaluate(readBorlabs, readerInput('borlabs', 'botUserAgent'));

export const borlabs = defineAdapter({
  id: 'borlabs',
  async readState(page) {
    const r = await read(page);
    if (!r.hasGlobal && !r.cookiePresent) return [];

    // An optional group is granted when the cookie lists it; any other group in the cookie except `essential` counts too.
    // A group the cookie does not list is read as denied: after a reject the cookie lists none of them.
    const map: Record<string, boolean | null> = {};
    for (const g of readerInput('borlabs', 'optionalGroups'))
      map[g] = r.cookiePresent ? r.groups.includes(g) : false;
    for (const g of r.groups) if (g !== 'essential') map[g] = true;

    const special = r.cookiesForBots === true && r.uaBot;
    const fact: ConsentStateFact = {
      source: 'cookie',
      ready: r.hasGlobal || r.cookiePresent ? 'ready' : 'loading',
      categories: toCategoryStates(map),
      origin: special ? 'special-branch' : r.cookiePresent ? 'stored' : 'default',
      decision: {
        responded: special ? 'unknown' : r.cookiePresent,
        method: r.cookiePresent ? 'explicit' : 'unknown',
      },
    };
    return [fact];
  },
  async readGeo(page) {
    const r = await read(page);
    return r.geoIp === true && !r.bannerVisible && !r.cookiePresent && !r.hideOnThisPage
      ? [{ cmpId: 'borlabs', signal: 'borlabs:geo-ip-dialog-hidden' }]
      : [];
  },
  async readBot(page) {
    const r = await read(page);
    return r.cookiesForBots === true && r.uaBot
      ? [{ cmpId: 'borlabs', signal: 'borlabs:cookies-for-bots', detail: 'ua-matches-bot-pattern' }]
      : [];
  },
  async readConfig(page) {
    const r = await read(page);
    return {
      config: {
        'borlabs.hideDialogOnThisPage': r.hideOnThisPage,
        'borlabs.showDialogAfterUserInteraction': r.afterInteraction,
        'borlabs.geoIpActive': r.geoIp,
        'borlabs.cookiesForBots': r.cookiesForBots,
        'borlabs.respectDoNotTrack': r.respectDnt,
      },
      closeMeansAccept: null,
    };
  },
  isReady: async (page) => (await read(page)).hasGlobal,
  // The cookie lists only groups the installation has: a site without a marketing group keeps no `marketing` entry
  // after "accept all". The page exposes no list of the configured groups, so a group our accept left denied while it
  // granted another may simply not exist and is left out of the accept verdict.
  categoriesUnlisted: true,
});
