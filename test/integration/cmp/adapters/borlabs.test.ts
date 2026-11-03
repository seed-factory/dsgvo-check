/** Borlabs Cookie v3 and v2 adapters against the own simulators, plus the cookiesForBots branch. */
import { expect, it } from 'vitest';
import { extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { CHROME_UA, describeCmpScenarios, recognized } from '../helpers.ts';

describeCmpScenarios(
  {
    id: 'borlabs',
    site: 'cmp/borlabs',
    okUrl: 'https://www.borlabs.test/',
    blockingUrl: 'https://www.borlabs.test/blocking.html',
    version: '3.2.1',
    rejectName: /^Nur essenzielle Cookies akzeptieren$/,
    acceptName: /^Alle akzeptieren$/,
  },
  (env) => {
    it('v2: recognized as 2.x, reject as a link next to an accept link → ok, click + verify', async () => {
      const { page } = await env.open('https://www.borlabs.test/v2.html');
      const adapter = await recognized(page, 'borlabs');
      await waitForBanner(page, adapter);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.detection.version).toBe('2.2.67');
      expect(facts.detection.versionSupported).toBe(true);
      expect(facts.blocking.overlay || facts.blocking.scrollLock).toBe(false);
      const reject = facts.firstLayer.buttons.find((b) => b.kind === 'reject');
      expect(reject).toMatchObject({
        role: 'link',
        name: 'Nur notwendige Cookies',
        vendorRole: 'reject',
        kindConfidence: 'high',
      });
      expect(classifyFirstLayer(facts, loadLexicon()).variant).toBe('ok');
      expect((await adapter.reject(page, { facts, ...DEFAULT_CLASSIFY })).clicked).toBe(true);
      const verify = await adapter.verify(page, 'reject');
      expect(verify.verified).toBe(true);
    });

    it('config facts: dialogHideDialogOnPages is evaluated for the current page', async () => {
      const { page } = await env.open('https://www.borlabs.test/');
      const adapter = await recognized(page, 'borlabs');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.config['borlabs.hideDialogOnThisPage']).toBe(false);
      expect(facts.config['borlabs.cookiesForBots']).toBe(true);
    });

    it('bot branch: cookiesForBots with a bot UA → bot signal, consent without banner', async () => {
      const { page } = await env.open('https://www.borlabs.test/', `${CHROME_UA} examplebot/1.0`);
      const adapter = await recognized(page, 'borlabs');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.botSignals.map((b) => b.signal)).toEqual(['borlabs:cookies-for-bots']);
      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.state[0]?.origin).toBe('special-branch');
    });
  },
);
