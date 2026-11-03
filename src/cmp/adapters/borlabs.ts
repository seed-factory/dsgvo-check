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
  const entry = w.document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('borlabs-cookie='));
  let groups: string[] = [];
  if (entry) {
    try {
      const json = JSON.parse(decodeURIComponent(entry.slice('borlabs-cookie='.length))) as {
        consents?: Record<string, unknown>;
      };
      groups = Object.entries(json.consents ?? {})
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([k]) => k);
    } catch {
      groups = [];
    }
  }
  const s = w.borlabsCookieConfig?.settings ?? {};
  const pages = Array.isArray(s.dialogHideDialogOnPages) ? (s.dialogHideDialogOnPages as unknown[]) : null;
  const here = w.location.href.split(/[?#]/)[0];
  const box = w.document.querySelector(
    '#BorlabsCookieBox .brlbs-cmpnt-dialog, #BorlabsCookieBox ._brlbs-box-wrap, #BorlabsCookieBox ._brlbs-bar-wrap',
  );
  let bannerVisible = false;
  if (box) {
    const r = box.getBoundingClientRect();
    const st = w.getComputedStyle(box);
    bannerVisible = r.width > 0 && r.height > 0 && st.visibility === 'visible' && st.display !== 'none';
  }
  return {
    hasGlobal: w.BorlabsCookie !== undefined && w.BorlabsCookie !== null,
    cookiePresent: !!entry,
    groups,
    geoIp: bool(s.dialogGeoIpActive),
    cookiesForBots: bool(s.cookiesForBots),
    hideOnThisPage: pages
      ? pages.some(
          (p) => typeof p === 'string' && p.split(/[?#]/)[0]?.replace(/\/$/, '') === here?.replace(/\/$/, ''),
        )
      : null,
    afterInteraction: bool(s.dialogShowDialogAfterUserInteraction),
    respectDnt: bool(s.respectDoNotTrack),
    bannerVisible,
    uaBot: new RegExp(botUserAgent, 'i').test(w.navigator.userAgent),
  };
}

const read = (page: Page) => page.evaluate(readBorlabs, readerInput('borlabs', 'botUserAgent'));

export const borlabs = defineAdapter({
  id: 'borlabs',
  async readState(page) {
    const r = await read(page);
    if (!r.hasGlobal && !r.cookiePresent) return [];
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
});
