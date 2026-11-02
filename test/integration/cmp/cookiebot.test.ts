/** : Cookiebot adapter against the own simulator, including the bot branch (isSpider) and the geo branch. */
import { expect, it } from 'vitest';
import { classifyFirstLayer, extract, loadLexicon } from '../../../src/cmp/index.ts';
import { CHROME_UA, decideAndAct, describeCmpScenarios, recognized } from './helpers.ts';

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
      expect(facts.state.every((s) => s.origin === 'special-branch')).toBe(true);
      expect(facts.state.find((s) => s.source === 'api')?.categories.marketing).toBe('granted');
      const cls = classifyFirstLayer(facts, loadLexicon());
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.reasons).toContain('banner-not-visible');
      expect((await adapter.reject(page, { facts })).clicked).toBe(false);
    });

    it('geo branch: out of region → isOutOfRegion, CookieConsent=-1, gdprApplies=false and TCF ping', async () => {
      const { page } = await env.open('https://www.cookiebot.test/geo.html');
      const adapter = await recognized(page, 'cookiebot');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.geoSignals.map((g) => g.signal).sort()).toEqual([
        'cookiebot:CookieConsent=-1',
        'cookiebot:gdprApplies=false',
        'cookiebot:isOutOfRegion',
        'tcf:gdprApplies=false',
      ]);
      expect(facts.botSignals).toEqual([]);
      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.state.every((s) => s.origin === 'special-branch')).toBe(true);
    });

    it('collector flow (verify without reload, own reload, verify again): origin action, then stored', async () => {
      const { page } = await env.open('https://www.cookiebot.test/');
      const adapter = await recognized(page, 'cookiebot');
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const first = await adapter.verify(page, 'reject', { reload: false });
      expect(first.verified).toBe(true);
      expect(first.persistedAfterReload).toBeNull();
      expect(first.stateAfter.every((s) => s.origin === 'action')).toBe(true);
      await page.reload({ waitUntil: 'load' });
      const second = await adapter.verify(page, 'reject', { reload: false });
      expect(second.verified).toBe(true);
      expect(second.stateAfter.every((s) => s.origin === 'stored')).toBe(true);
      expect(second.stateAfter.find((s) => s.source === 'api')?.decision).toEqual({
        responded: true,
        method: 'explicit',
      });
    });

    it('never stores cookie values: the facts contain no CookieConsent payload', async () => {
      const { page } = await env.open('https://www.cookiebot.test/');
      const adapter = await recognized(page, 'cookiebot');
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const facts = await adapter.extract(page, 'after-click');
      const json = JSON.stringify(facts);
      expect(json).not.toMatch(/stamp|necessary:true|ver:1/);
    });
  },
);
