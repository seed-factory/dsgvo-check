/** Complianz (WordPress). Bot detection uses the read-only `cmplz_is_bot()` / `cmplz_is_speedbot()` calls. */
import type { Page } from 'playwright-core';
import type { ConsentStateFact } from '../types.ts';
import { defineAdapter, toCategoryStates } from './base.ts';

interface ComplianzRead {
  present: boolean;
  apiCategories: Record<string, boolean | null> | null;
  cookieCategories: Record<string, boolean | null>;
  anyCategoryCookie: boolean;
  bannerDismissed: boolean;
  region: string | null;
  consentType: string | null;
  version: string | null;
  isBot: boolean | null;
  isSpeedbot: boolean | null;
}

/** In-page, self-contained. Cookie values are read here and never leave the page. */
function readComplianz(): ComplianzRead {
  const w = globalThis as unknown as {
    complianz?: Record<string, unknown>;
    cmplz_has_consent?: (category: string) => unknown;
    cmplz_is_bot?: () => unknown;
    cmplz_is_speedbot?: () => unknown;
    document: { cookie: string };
  };
  const cz = w.complianz;
  const prefix = typeof cz?.prefix === 'string' ? cz.prefix : 'cmplz_';
  const CATEGORIES = ['preferences', 'statistics', 'marketing'];

  /** The plugin's cookies by name. */
  const readJar = (): Record<string, string> => {
    const jar: Record<string, string> = {};
    for (const part of w.document.cookie.split(';')) {
      const i = part.indexOf('=');
      const name = part.slice(0, i).trim();
      if (i > 0 && name.startsWith(prefix)) jar[name] = part.slice(i + 1).trim();
    }
    return jar;
  };

  /** `allow` / `deny` per category; `any` is true when the visitor has a category cookie at all. */
  const readCookieCategories = (jar: Record<string, string>) => {
    const categories: Record<string, boolean | null> = {};
    let any = false;
    for (const c of CATEGORIES) {
      const v = jar[prefix + c];
      categories[c] = v === 'allow' ? true : v === 'deny' ? false : null;
      if (v !== undefined) any = true;
    }
    return { categories, any };
  };

  /** `cmplz_has_consent(category)` per category; null when the plugin does not offer the function. */
  const readApiCategories = (): Record<string, boolean | null> | null => {
    if (typeof w.cmplz_has_consent !== 'function') return null;

    const categories: Record<string, boolean | null> = {};
    for (const c of CATEGORIES) {
      try {
        const v = w.cmplz_has_consent(c);
        categories[c] = typeof v === 'boolean' ? v : null;
      } catch {
        categories[c] = null;
      }
    }
    return categories;
  };

  const call = (f: (() => unknown) | undefined): boolean | null => {
    if (typeof f !== 'function') return null;
    try {
      return f() === true;
    } catch {
      return null;
    }
  };
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  const jar = readJar();
  const cookie = readCookieCategories(jar);

  return {
    present: !!cz,
    apiCategories: readApiCategories(),
    cookieCategories: cookie.categories,
    anyCategoryCookie: cookie.any,
    bannerDismissed: jar[`${prefix}banner-status`] === 'dismissed',
    region: str(cz?.region),
    consentType: str(cz?.consenttype),
    version: str(cz?.version),
    isBot: call(w.cmplz_is_bot),
    isSpeedbot: call(w.cmplz_is_speedbot),
  };
}

const read = (page: Page) => page.evaluate(readComplianz);

export const complianz = defineAdapter({
  id: 'complianz',
  async readState(page) {
    const r = await read(page);
    if (!r.present) return [];

    const responded = r.bannerDismissed || r.anyCategoryCookie;
    const special = r.isBot === true || r.isSpeedbot === true || (r.region !== null && r.region !== 'eu');
    const origin = special ? 'special-branch' : responded ? 'stored' : 'default';

    const facts: ConsentStateFact[] = [];
    if (r.apiCategories) {
      facts.push({
        source: 'api',
        ready: 'ready',
        categories: toCategoryStates(r.apiCategories),
        origin,
        decision: { responded, method: responded ? 'explicit' : 'unknown' },
      });
    }
    if (r.anyCategoryCookie) {
      facts.push({
        source: 'cookie',
        ready: 'ready',
        categories: toCategoryStates(r.cookieCategories),
        origin,
        decision: { responded, method: 'explicit' },
      });
    }
    return facts;
  },
  async readGeo(page) {
    const r = await read(page);
    return r.region !== null && r.region !== 'eu'
      ? [
          {
            cmpId: 'complianz',
            signal: `complianz:region=${r.region}`,
            ...(r.consentType ? { detail: `consenttype=${r.consentType}` } : {}),
          },
        ]
      : [];
  },
  async readBot(page) {
    const r = await read(page);
    return [
      ...(r.isBot ? [{ cmpId: 'complianz', signal: 'complianz:is_bot' }] : []),
      ...(r.isSpeedbot ? [{ cmpId: 'complianz', signal: 'complianz:is_speedbot' }] : []),
    ];
  },
  async readConfig(page) {
    const r = await read(page);
    return {
      config: {
        'complianz.region': r.region,
        'complianz.consenttype': r.consentType,
        'complianz.version': r.version,
      },
      closeMeansAccept: null,
    };
  },
  isReady: async (page) => (await read(page)).present,
});
