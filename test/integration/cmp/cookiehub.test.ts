/** L2: CookieHub adapter against the own simulator (reject only in the settings layer in the blocking variant). */
import { expect, it } from 'vitest';
import { extract, waitForBanner } from '../../../src/cmp/index.ts';
import { describeCmpScenarios, recognized } from './helpers.ts';

describeCmpScenarios(
  {
    id: 'cookiehub',
    site: 'cmp/cookiehub',
    okUrl: 'https://www.cookiehub.test/',
    blockingUrl: 'https://www.cookiehub.test/blocking.html',
    version: null,
    rejectName: /^Alle ablehnen$/,
    acceptName: /^Alle zulassen$/,
  },
  (env) => {
    it('settings opens a second layer; the first-screen measurement does not count it', async () => {
      const { page } = await env.open('https://www.cookiehub.test/blocking.html');
      const adapter = await recognized(page, 'cookiehub');
      await waitForBanner(page, adapter);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'link', 'settings']);
    });
  },
);
