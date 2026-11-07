/** Cookiebot adapter against the own simulator, including the bot branch (isSpider) and the geo branch. */
import { expect, it } from 'vitest';
import { extract, loadLexicon } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { CHROME_UA, decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

/** The origins in `states` that differ from `origin`: empty when all states come from that origin. */
const originsOtherThan = (states: ReadonlyArray<{ origin: string }>, origin: string) =>
  states.map((s) => s.origin).filter((o) => o !== origin);

describeCmpScenarios(
  {
    id: 'cookiebot',
    site: 'cmp/cookiebot',
    okUrl: 'https://www.cookiebot.test/',
    blockingUrl: 'https://www.cookiebot.test/blocking.html',
    version: null,
    rejectName: /^Ablehnen$/,
    acceptName: /^Alle zulassen$/,
  },
  (env) => {
    it('bot branch: isSpider → bot signal, consent without banner (special-branch), no verdict', async () => {
      const { page } = await env.open('https://www.cookiebot.test/', `${CHROME_UA} Chrome-Lighthouse`);
      const adapter = await recognized(page, 'cookiebot');
      const facts = await extract(page, adapter, 'first-screen');

      expect(facts.botSignals).toEqual([{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }]);
      expect(facts.geoSignals).toEqual([]);
      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.state.length).toBeGreaterThan(0);
      expect(originsOtherThan(facts.state, 'special-branch')).toEqual([]);
      expect(facts.state.find((s) => s.source === 'api')?.categories.marketing).toBe('granted');

      const cls = classifyFirstLayer(facts, loadLexicon());
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.reasons).toContain('banner-not-visible');
      expect((await adapter.reject(page, { facts, ...DEFAULT_CLASSIFY })).clicked).toBe(false);
    });

    it('geo branch: out of region → isOutOfRegion, CookieConsent=-1, gdprApplies=false and TCF ping', async () => {
      const { page, adapter } = await env.openRecognized('https://www.cookiebot.test/geo.html', 'cookiebot');
      const facts = await extract(page, adapter, 'first-screen');

      expect(facts.geoSignals.map((g) => g.signal).sort()).toEqual([
        'cookiebot:CookieConsent=-1',
        'cookiebot:gdprApplies=false',
        'cookiebot:isOutOfRegion',
        'tcf:gdprApplies=false',
      ]);
      expect(facts.botSignals).toEqual([]);
      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(originsOtherThan(facts.state, 'special-branch')).toEqual([]);
    });

    it('collector flow (verify without reload, own reload, verify again): origin action, then stored', async () => {
      const { page, adapter } = await env.openRecognized('https://www.cookiebot.test/', 'cookiebot');
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);

      // Before the reload the state comes from the click itself.
      const first = await adapter.verify(page, 'reject', { reload: false });
      expect(first.verified).toBe(true);
      expect(first.persistedAfterReload).toBeNull();
      expect(originsOtherThan(first.stateAfter, 'action')).toEqual([]);

      // After our own reload it is read back from storage.
      await page.reload({ waitUntil: 'load' });
      const second = await adapter.verify(page, 'reject', { reload: false });
      expect(second.verified).toBe(true);
      expect(originsOtherThan(second.stateAfter, 'stored')).toEqual([]);
      expect(second.stateAfter.find((s) => s.source === 'api')?.decision).toEqual({
        responded: true,
        method: 'explicit',
      });
    });

    it('never stores cookie values: the facts contain no CookieConsent payload', async () => {
      const { page, adapter } = await env.openRecognized('https://www.cookiebot.test/', 'cookiebot');
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);

      const facts = await adapter.extract(page, 'after-click');

      expect(JSON.stringify(facts)).not.toMatch(/stamp|necessary:true|ver:1/);
    });
  },
);
