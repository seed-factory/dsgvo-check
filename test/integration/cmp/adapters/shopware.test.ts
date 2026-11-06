/** Shopware adapter against the own simulator of the storefront cookie bar (the answer is recorded, its content not). */
import { expect, it } from 'vitest';
import { detectCmp, extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized, requestsSince } from '../helpers.ts';

const TRACKER = 'stats.shopware.test';

describeCmpScenarios(
  {
    id: 'shopware',
    site: 'cmp/shopware',
    okUrl: 'https://www.shopware.test/',
    version: null,
    rejectName: /^Nur technisch notwendige$/,
    acceptName: /^Alle Cookies akzeptieren$/,
    stateProves: 'answer-only',
  },
  (env) => {
    it('state before and after the reject: the answer is recorded and survives the reload, no tracker loads', async () => {
      const since = Date.now();
      const { page } = await env.open('https://www.shopware.test/');
      const adapter = await recognized(page, 'shopware');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      const before = await adapter.state(page);
      expect(before).toEqual([
        {
          source: 'cookie',
          ready: 'ready',
          categories: {},
          origin: 'default',
          decision: { responded: false, method: 'unknown' },
        },
      ]);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      await page.reload({ waitUntil: 'load' });

      expect(await adapter.state(page)).toMatchObject([
        { origin: 'stored', categories: {}, decision: { responded: true, method: 'explicit' } },
      ]);
      expect((await adapter.extract(page, 'after-reload')).firstLayer.bannerVisible).toBe(false);
      expect(requestsSince(env.server, TRACKER, since)).toBe(0);
    });

    it('accept loads the local tracker, while the state still lists no categories', async () => {
      const since = Date.now();
      const { page } = await env.open('https://www.shopware.test/');
      const adapter = await recognized(page, 'shopware');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      expect(requestsSince(env.server, TRACKER, since)).toBe(0);

      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);

      await expect.poll(() => requestsSince(env.server, TRACKER, since)).toBeGreaterThan(0);
      expect(await adapter.state(page)).toMatchObject([{ categories: {}, decision: { responded: true } }]);
    });

    it('the reject label of newer versions is a reject with high confidence, the vendor markup agrees', async () => {
      const { page } = await env.open('https://www.shopware.test/erforderliche.html');
      const adapter = await recognized(page, 'shopware');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });

      const facts = await extract(page, adapter, 'first-screen');

      const reject = facts.firstLayer.buttons.find((b) => b.vendorRole === 'reject');
      expect(reject).toMatchObject({
        name: 'Nur technisch erforderliche Cookies akzeptieren',
        kind: 'reject',
        kindConfidence: 'high',
      });
      const cls = classifyFirstLayer(facts, loadLexicon());
      expect(cls.variant).toBe('ok');
      expect(cls.targets?.reject?.name).toBe('Nur technisch erforderliche Cookies akzeptieren');
      expect(cls.targets?.accept?.name).toBe('Alle Cookies akzeptieren');
    });

    it('counterexample: a storefront page without the cookie bar (salesChannelId only) is no Shopware recognition', async () => {
      const { page } = await env.open('https://www.shopware.test/storefront-without-bar.html');

      const { adapter, detection } = await detectCmp(page);

      expect(adapter).toBeNull();
      expect(detection.method).not.toBe('adapter');
    });

    it('counterexample: the same bar without a storefront (no salesChannelId) is no high recognition', async () => {
      const { page } = await env.open('https://www.shopware.test/no-sales-channel.html');

      const { detection } = await detectCmp(page);

      expect(detection).toMatchObject({
        cmpId: 'shopware',
        method: 'adapter',
        recognitionConfidence: 'medium',
        signals: ['dom:.cookie-permission-container[data-cookie-permission]'],
      });
    });
  },
);
