/** Usercentrics v3 (shadow DOM #usercentrics-cmp-ui) and v2 (#usercentrics-root) against own simulators. */
import { expect, it } from 'vitest';
import { extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

describeCmpScenarios(
  {
    id: 'usercentrics',
    site: 'cmp/usercentrics',
    okUrl: 'https://www.usercentrics.test/',
    blockingUrl: 'https://www.usercentrics.test/blocking.html',
    version: '3',
    rejectName: /^Ablehnen$/,
    acceptName: /^Alle akzeptieren$/,
  },
  (env) => {
    it('buttons inside the open shadow root are measured and clickable', async () => {
      const { page } = await env.open('https://www.usercentrics.test/');
      const adapter = await recognized(page, 'usercentrics');
      await waitForBanner(page, adapter);

      const facts = await extract(page, adapter, 'first-screen');

      const reject = facts.firstLayer.buttons.find((b) => b.kind === 'reject');
      expect(reject?.inShadowDom).toBe(true);
      expect(reject?.hitTestOk).toBe(true);
      expect(reject?.selector).toContain('>>');
    });

    it('v2: recognized as version 2, reject verified via UC_UI services and uc_user_interaction', async () => {
      const { page } = await env.open('https://www.usercentrics.test/v2.html');
      const adapter = await recognized(page, 'usercentrics');
      await waitForBanner(page, adapter);

      const facts = await extract(page, adapter, 'first-screen');

      expect(facts.detection.version).toBe('2');
      expect(classifyFirstLayer(facts, loadLexicon()).variant).toBe('ok');
      expect((await adapter.reject(page, { facts, ...DEFAULT_CLASSIFY })).clicked).toBe(true);
      expect((await adapter.verify(page, 'reject')).verified).toBe(true);
    });

    it('geo branch: isConsentRequired false without an answer → geo signal, no banner', async () => {
      const { page } = await env.open('https://www.usercentrics.test/geo.html');
      const adapter = await recognized(page, 'usercentrics');
      await page.waitForTimeout(400);

      const facts = await extract(page, adapter, 'first-screen');

      expect(facts.geoSignals.map((g) => g.signal)).toEqual(['usercentrics:isConsentRequired=false']);
      expect(facts.firstLayer.bannerVisible).toBe(false);
    });

    // A click that changes nothing must not turn a default-denied state with an unknown answer into a reject.
    it('a deny button without effect (answer unknown, default denied) is not a verified reject', async () => {
      const { page } = await env.open('https://www.usercentrics.test/broken-deny.html');
      const adapter = await recognized(page, 'usercentrics');
      expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.state[0]?.decision?.responded).toBe('unknown');
      expect(Object.values(facts.state[0]?.categories ?? {})).toEqual(['denied', 'denied']);
      const target = classifyFirstLayer(facts, loadLexicon()).targets?.reject ?? null;
      expect(target?.name).toBe('Ablehnen');

      const click = await adapter.reject(page, { facts, target, ...DEFAULT_CLASSIFY });
      expect(click.clicked).toBe(true);

      // Without a reload the UI is closed, but the CMP never answered: no reject is verified.
      const now = await adapter.verify(page, 'reject', { reload: false });
      expect(now.verified).toBe(false);
      expect(now.reason).toBe('api:response-unknown');
      expect(now.method).toContain('ui-closed');
      expect(now.stateAfter.map((st) => st.origin)).not.toContain('action');

      // The full verification, with reload, does not find a persisted answer either.
      const full = await adapter.verify(page, 'reject');
      expect(full.verified).toBe(false);
      expect(full.persistedAfterReload).toBe(false);
    });

    // The v3 loader may show up while a v2 call is still pending; the state keeps the version it was read from.
    it('a v3 API that appears while a v2 read is in flight does not turn the v2 state into v3', async () => {
      const { page } = await env.open('https://www.usercentrics.test/v2.html');
      const adapter = await recognized(page, 'usercentrics');
      await page.evaluate(() => {
        const w = globalThis as unknown as { __ucCmp?: unknown; UC_UI?: unknown };
        w.__ucCmp = undefined;
        w.UC_UI = {
          isInitialized: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                w.__ucCmp = {};
                resolve(true);
              }, 100),
            ),
          getServicesBaseInfo: () => [],
        };
      });

      const [state] = await adapter.state(page);

      expect(state?.scope).toBe('v2');
      expect(state?.ready).toBe('ready');
    });

    it('after an explicit reject isConsentRequired is false too, but that is not a geo signal', async () => {
      const { page } = await env.open('https://www.usercentrics.test/');
      const adapter = await recognized(page, 'usercentrics');
      await waitForBanner(page, adapter);
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      expect(await adapter.geoSignals(page)).toEqual([]);
    });
  },
);
