/**
 * Shopware adapter against the own simulator of the storefront cookie bar. The answer cookie says that the visitor
 * answered; the permission cookies whose names the adapter knows say what, by their presence alone.
 */
import { expect, it } from 'vitest';
import { adapterData } from '../../../../src/cmp/adapters-file.ts';
import { detectCmp, extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized, requestsSince } from '../helpers.ts';

const TRACKER = 'stats.shopware.test';
/** The value the simulator gives every permission cookie and the tracker cookie: it must never leave the page. */
const VALUE_MARKERS = ['SECRET_SW_FLAG_7', 'SECRET_GCL_4711'];

const known = () => adapterData('shopware').consentCookies ?? [];
/** Every known permission cookie in one state, `granted` for the names given. */
const categories = (granted: readonly string[] = []) =>
  Object.fromEntries(known().map((n) => [n, granted.includes(n) ? 'granted' : 'denied']));

const expectNoValues = (...read: unknown[]) => {
  const text = JSON.stringify(read);
  for (const marker of VALUE_MARKERS) expect(text).not.toContain(marker);
};

describeCmpScenarios(
  {
    id: 'shopware',
    site: 'cmp/shopware',
    okUrl: 'https://www.shopware.test/',
    version: null,
    rejectName: /^Nur technisch notwendige$/,
    acceptName: /^Alle Cookies akzeptieren$/,
  },
  (env) => {
    async function openBar(path: string) {
      const { page } = await env.open(`https://www.shopware.test/${path}`);
      const adapter = await recognized(page, 'shopware');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      return { page, adapter };
    }

    it('reject: no category before the answer, every known permission cookie absent after the click and the reload', async () => {
      const since = Date.now();
      const { page, adapter } = await openBar('');
      expect(await adapter.state(page)).toEqual([
        {
          source: 'cookie',
          ready: 'ready',
          categories: {},
          origin: 'default',
          decision: { responded: false, method: 'unknown' },
        },
      ]);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'reject');

      expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
      expect(verify.reason).toBeUndefined();
      expect(verify.method).toContain('cookie:known-flags-absent');
      expect(verify.method).not.toContain('cookie:all-denied');
      const answered = { decision: { responded: true, method: 'explicit' }, categories: categories() };
      expect(verify.stateAfter).toMatchObject([
        { origin: 'action', ...answered },
        { origin: 'stored', ...answered },
      ]);
      expect((await adapter.extract(page, 'after-reload')).firstLayer.bannerVisible).toBe(false);
      expect(requestsSince(env.server, TRACKER, since)).toBe(0);
    });

    it('accept: the answer comes after the offcanvas fetch; verify waits for it, unconfigured names are ignored', async () => {
      const since = Date.now();
      const { page, adapter } = await openBar('');

      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);
      // Right after the click the simulator still waits for its offcanvas: nothing recorded yet.
      expect(await adapter.state(page)).toMatchObject([{ categories: {}, decision: { responded: false } }]);
      const verify = await adapter.verify(page, 'accept', { reload: false });

      expect(verify).toMatchObject({ verified: true });
      expect(verify.method).toContain('cookie:known-flags-present');
      const granted = ['google-analytics-enabled', 'youtube-video'];
      const ignored = known().filter((n) => !granted.includes(n));
      expect(verify.method).toContain(`categories-ignored:${ignored.join(',')}`);
      expect(verify.stateAfter).toMatchObject([{ origin: 'action', categories: categories(granted) }]);
      // A permission cookie of the installation that no list names is not read.
      expect(Object.keys(verify.stateAfter[0]?.categories ?? {})).toEqual(known());
      await expect.poll(() => requestsSince(env.server, TRACKER, since)).toBeGreaterThan(0);
      expectNoValues(verify, await adapter.extract(page, 'after-click'));
    });

    it('accept: an answer later than the wait leaves the accept unconfirmed (no response recorded)', async () => {
      const { page, adapter } = await openBar('');

      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'accept', { reload: false, timeoutMs: 100 });

      expect(verify).toMatchObject({ verified: false, reason: 'cookie:no-response-recorded' });
    });

    it.each([
      {
        page: 'deny-sets-flag.html',
        what: 'a reject that also sets a known permission cookie',
        reason: 'cookie:not-all-denied',
        after: { origin: 'action', categories: categories(['google-analytics-enabled']) },
      },
      {
        page: 'deny-without-answer.html',
        what: 'a reject that closes the bar without an answer',
        reason: 'cookie:no-response-recorded',
        after: { origin: 'default', categories: {}, decision: { responded: false } },
      },
      {
        page: 'answered-before.html',
        what: 'a click on a bar whose answer was stored before',
        reason: 'cookie:unchanged-after-click',
        after: { origin: 'stored', categories: categories() },
      },
      {
        page: 'answered-granted-before.html',
        what: 'a reject that only removes a permission cookie under an answer stored before',
        reason: 'cookie:unchanged-after-click',
        after: { origin: 'stored', categories: categories() },
      },
    ])('counterexample: $what is not a confirmed reject ($reason)', async ({ page: path, reason, after }) => {
      const { page, adapter } = await openBar(path);

      const { click } = await decideAndAct(page, adapter, 'reject');
      expect(click).toMatchObject({ clicked: true, button: { kind: 'reject' } });
      const verify = await adapter.verify(page, 'reject');

      expect(verify).toMatchObject({ verified: false, reason });
      // The state right after the click; the one after the reload follows it.
      expect(verify.stateAfter[0]).toMatchObject(after);
      expectNoValues(verify);
    });

    it('a reject confirmed by state, although a tracker with an identifier loads on every visit', async () => {
      const since = Date.now();
      const { page, adapter } = await openBar('leaky-after-reject.html');

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const clickedAt = Date.now();
      const verify = await adapter.verify(page, 'reject');

      expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
      expect(verify.method).toContain('cookie:known-flags-absent');
      expect(requestsSince(env.server, TRACKER, clickedAt)).toBeGreaterThan(0);
      expect(requestsSince(env.server, TRACKER, since)).toBeGreaterThan(
        requestsSince(env.server, TRACKER, clickedAt),
      );
      expectNoValues(verify, await adapter.extract(page, 'after-reload'));
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
