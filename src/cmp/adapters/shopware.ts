/**
 * The cookie bar of the Shopware 6 storefront. Shopware marks an answer with a cookie (`answerCookie`) and keeps
 * the consent of each optional cookie in a cookie of the installation's own configuration, which the page does not
 * list: the state says whether the visitor answered, not what. A click is therefore never verified by state.
 */
import type { Page } from 'playwright-core';
import { adapterData, readerInput } from '../adapters-file.ts';
import { defineAdapter } from './base.ts';

interface ShopwareRead {
  storefront: boolean;
  answered: boolean;
}

interface ShopwareArgs {
  /** The storefront globals of the detection (`salesChannelId`). */
  storefrontGlobals: string[];
  answerCookie: string;
}

/** In-page, self-contained. Only the presence of the answer cookie's name is read. */
function readShopware({ storefrontGlobals, answerCookie }: ShopwareArgs): ShopwareRead {
  const w = globalThis as unknown as Record<string, unknown> & { document: { cookie: string } };
  return {
    storefront: storefrontGlobals.some((g) => typeof w[g] === 'string'),
    answered: w.document.cookie.split(';').some((c) => c.trim().startsWith(`${answerCookie}=`)),
  };
}

const read = (page: Page) =>
  page.evaluate(readShopware, {
    storefrontGlobals: adapterData('shopware').detect.globals,
    answerCookie: readerInput('shopware', 'answerCookie'),
  });

export const shopware = defineAdapter({
  id: 'shopware',
  // The optional cookies are configured per installation and named nowhere on the page.
  categoriesUnlisted: true,
  async readState(page) {
    const r = await read(page);
    if (!r.storefront) return [];

    return [
      {
        source: 'cookie',
        ready: 'ready',
        categories: {},
        origin: r.answered ? 'stored' : 'default',
        decision: { responded: r.answered, method: r.answered ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).storefront,
});
