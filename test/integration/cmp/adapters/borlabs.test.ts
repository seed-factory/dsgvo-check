/** Borlabs Cookie v3 and v2 adapters against the own simulators, plus the cookiesForBots branch. */
import { expect, it } from 'vitest';
import { extract, loadLexicon, readDialogText, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { CHROME_UA, decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

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
      expect([facts.blocking.overlay, facts.blocking.scrollLock]).toEqual([false, false]);
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

    it('v2 with only some optional groups: accept all is verified, the groups the site lacks are left out', async () => {
      const { page } = await env.open('https://www.borlabs.test/v2-groups.html');
      const adapter = await recognized(page, 'borlabs');
      await waitForBanner(page, adapter);

      const { click } = await decideAndAct(page, adapter, 'accept');
      expect(click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'accept');

      expect(verify.reason).toBeUndefined();
      expect(verify.verified).toBe(true);
      expect(verify.method).toContain('categories-ignored:statistics,marketing');
      expect(verify.stateAfter[0]?.categories).toMatchObject({ 'external-media': 'granted' });
    });

    it('v2 counterexample: the reject still reads every optional group as denied', async () => {
      const { page } = await env.open('https://www.borlabs.test/v2-groups.html');
      const adapter = await recognized(page, 'borlabs');
      await waitForBanner(page, adapter);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'reject');

      expect(verify.verified).toBe(true);
      expect(verify.method.some((m) => m.startsWith('categories-ignored'))).toBe(false);
    });

    it('dialog text: the collapsed Cookie-Details are read with the first layer, without opening them', async () => {
      const { page, adapter } = await env.openRecognized('https://www.borlabs.test/details.html', 'borlabs', {
        banner: true,
      });

      const read = await readDialogText(page, adapter, { maxChars: 100_000 });

      expect(read?.truncated).toBe(false);
      expect(read?.text).toMatch(/^Datenschutzeinstellungen Wir nutzen Cookies/);
      expect(read?.text).toContain('Cookie-Details Name Google Tag Manager Anbieter Google Ireland Limited');
      expect(read?.text).toContain('Name Google AdWords');
      // The page side does not redact: the UID is there; the collector replaces it before anything is stored.
      expect(read?.text).toMatch(/Ihre Einwilligungs-ID \(UID\): zqx[a-z]{5}(-[a-z]{8}){3}$/);
      const details = await page.locator('.brlbs-cmpnt-cookie-details').evaluate((el) => el.style.display);
      expect(details).toBe('none');
    });

    it('dialog text: cut at the limit it is given, and said so', async () => {
      const { page, adapter } = await env.openRecognized('https://www.borlabs.test/details.html', 'borlabs', {
        banner: true,
      });

      const read = await readDialogText(page, adapter, { maxChars: 40 });

      expect(read).toEqual({ text: 'Datenschutzeinstellungen Wir nutzen Cook', truncated: true });
    });

    it('config facts: dialogHideDialogOnPages is evaluated for the current page', async () => {
      const { page, adapter } = await env.openRecognized('https://www.borlabs.test/', 'borlabs');

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
