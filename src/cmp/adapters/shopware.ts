/**
 * The cookie bar of the Shopware 6 storefront. Shopware marks an answer with a cookie (`answerCookie`) and the consent
 * of each optional cookie with a permission cookie of that cookie's name. The page names neither the installation's
 * optional cookies nor those of its plugins, so the state lists the permission cookies of Shopware itself
 * (`consentCookies`), present or absent, once the visitor answered: a reject is confirmed by their absence and says so
 * (`known-flags-absent`), which does not rule out a plugin's own cookie.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { adapterData, readerInput } from '../adapters-file.ts';
import { defineAdapter, toCategoryStates } from './base.ts';
import { flag, readerResult } from './read.ts';

interface ShopwareRead {
  storefront: boolean;
  answered: boolean;
  /** Per listed permission cookie whether one of that name is set. */
  present: Record<string, boolean>;
}

interface ShopwareArgs {
  /** The storefront globals of the detection (`salesChannelId`). */
  storefrontGlobals: string[];
  answerCookie: string;
  consentCookies: string[];
}

/** In-page, self-contained. Only the presence of cookie names is read; no value leaves the page. */
function readShopware({ storefrontGlobals, answerCookie, consentCookies }: ShopwareArgs): ShopwareRead {
  const w = globalThis as unknown as Record<string, unknown> & { document: { cookie: string } };
  const names = new Set(
    w.document.cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.includes('='))
      .map((c) => c.slice(0, c.indexOf('='))),
  );
  const present: Record<string, boolean> = {};
  for (const name of consentCookies) present[name] = names.has(name);
  return {
    storefront: storefrontGlobals.some((g) => typeof w[g] === 'string'),
    answered: names.has(answerCookie),
    present,
  };
}

const ShopwareAnswer = z.object({
  storefront: flag,
  answered: flag,
  present: z.record(z.string(), flag).catch({}),
});

/** The reader's answer, with presence only for the listed permission cookies. */
async function read(page: Page): Promise<ShopwareRead> {
  const consentCookies = readerInput('shopware', 'consentCookies');
  const r = readerResult(
    ShopwareAnswer,
    await page.evaluate(readShopware, {
      storefrontGlobals: adapterData('shopware').detect.globals,
      answerCookie: readerInput('shopware', 'answerCookie'),
      consentCookies,
    }),
  );
  const present: Record<string, boolean> = {};
  for (const name of consentCookies) present[name] = r.present[name] === true;
  return { ...r, present };
}

export const shopware = defineAdapter({
  id: 'shopware',
  // An installation offers only some of the listed cookies; one our accept left absent may not exist there.
  categoriesUnlisted: true,
  knownFlags: true,
  // "Alle Cookies akzeptieren" fetches the offcanvas cookie list before it sets any cookie.
  delayedAnswer: ['accept'],
  async readState(page) {
    const r = await read(page);
    if (!r.storefront) return [];

    return [
      {
        source: 'cookie',
        ready: 'ready',
        // Before an answer Shopware sets no permission cookie, and none is a consent of the visitor.
        categories: r.answered ? toCategoryStates(r.present) : {},
        origin: r.answered ? 'stored' : 'default',
        decision: { responded: r.answered, method: r.answered ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).storefront,
});
