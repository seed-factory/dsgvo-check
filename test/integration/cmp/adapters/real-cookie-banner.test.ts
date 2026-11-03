/** Real Cookie Banner adapter against the own simulator, including accept-all-for-bots with our honest UA. */
import { expect, it } from 'vitest';
import { classifyFirstLayer, extract, loadLexicon } from '../../../../src/cmp/index.ts';
import { browserUserAgent } from '../../../../src/core/runtime/user-agent.ts';
import { CHROME_UA, describeCmpScenarios, recognized } from '../helpers.ts';

describeCmpScenarios(
  {
    id: 'real-cookie-banner',
    site: 'cmp/real-cookie-banner',
    okUrl: 'https://www.rcb.test/',
    blockingUrl: 'https://www.rcb.test/blocking.html',
    version: '5.1.0',
    rejectName: /^Weiter ohne Einwilligung$/,
    acceptName: /^Alle akzeptieren$/,
  },
  (env) => {
    it('random digit-leading container id and obfuscation-free structural selectors still give a unique click target', async () => {
      const { page } = await env.open('https://www.rcb.test/');
      const adapter = await recognized(page, 'real-cookie-banner');
      const facts = await extract(page, adapter, 'first-screen');
      const reject = classifyFirstLayer(facts, loadLexicon()).targets?.reject;
      expect(reject?.role).toBe('button');
      expect(await page.locator(reject?.selector ?? 'none').count()).toBe(1);
    });

    it('bot branch : the honest UA token triggers accept-all-for-bots → bot signal, no banner', async () => {
      const { page } = await env.open('https://www.rcb.test/', browserUserAgent(CHROME_UA));
      const adapter = await recognized(page, 'real-cookie-banner');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.botSignals.map((b) => b.signal)).toEqual(['rcb:accept-all-for-bots']);
      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.state[0]?.origin).toBe('special-branch');
      expect(classifyFirstLayer(facts, loadLexicon()).variant).toBe('banner-not-recognized');
    });
  },
);
