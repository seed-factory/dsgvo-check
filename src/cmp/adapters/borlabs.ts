/** Borlabs Cookie (WordPress) v2 and v3; bot detection mirrors the Borlabs 3.5 `isBot` pattern. */
import type { Page } from 'playwright-core';
import { majorSupported, versionFromUrl } from '../detection.ts';
import type { ConsentStateFact } from '../types.ts';
import { defineAdapter, toCategoryStates } from './base.ts';

/** Optional service groups; essential is never optional. */
const OPTIONAL_GROUPS = ['statistics', 'marketing', 'external-media'];

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

function readBorlabs(): BorlabsRead {
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
    uaBot: /bot|googlebot|crawler|spider|robot|crawling|lighthouse/i.test(w.navigator.userAgent),
  };
}

const read = (page: Page) => page.evaluate(readBorlabs);

export const borlabs = defineAdapter({
  id: 'borlabs',
  name: 'Borlabs Cookie',
  supportedVersions: '2.x || 3.x',
  detect: {
    globals: ['BorlabsCookie', 'borlabsCookieConfig'],
    scripts: [{ label: 'wp-content/plugins/borlabs-cookie', pattern: '/wp-content/plugins/borlabs-cookie/' }],
    dom: ['#BorlabsCookieBox', '.brlbs-cmpnt-dialog', '._brlbs-box-wrap', '._brlbs-bar-wrap'],
    cookies: ['^borlabs-cookie$'],
  },
  version(raw) {
    const fromUrl = versionFromUrl(raw.scriptUrls[0]);
    if (fromUrl) return fromUrl;
    if (raw.dom.includes('.brlbs-cmpnt-dialog')) return '3';
    if (raw.dom.includes('._brlbs-box-wrap') || raw.dom.includes('._brlbs-bar-wrap')) return '2';
    return null;
  },
  versionSupported: (v) => majorSupported(v, [2, 3]),
  banner: {
    containers: [
      '#BorlabsCookieBox .brlbs-cmpnt-dialog',
      '#BorlabsCookieBox ._brlbs-box-wrap',
      '#BorlabsCookieBox ._brlbs-bar-wrap',
      '#BorlabsCookieBox [role="dialog"]',
    ],
    overlays: ['#BorlabsCookieBox .brlbs-cmpnt-dialog-backdrop', '#BorlabsCookieBox ._brlbs-bg-dark'],
    vendorRoles: [
      { selector: '.brlbs-btn-accept-all', role: 'accept' },
      { selector: '.brlbs-btn-accept-only-essential', role: 'reject' },
      { selector: '.brlbs-btn-save', role: 'save' },
      { selector: '[data-cookie-accept-all]', role: 'accept' },
      { selector: '[data-cookie-refuse]', role: 'reject' },
      { selector: '[data-cookie-individual]', role: 'settings' },
      { selector: '[data-cookie-accept]', role: 'save' },
    ],
  },
  async readState(page) {
    const r = await read(page);
    if (!r.hasGlobal && !r.cookiePresent) return [];
    const map: Record<string, boolean | null> = {};
    for (const g of OPTIONAL_GROUPS) map[g] = r.cookiePresent ? r.groups.includes(g) : false;
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
