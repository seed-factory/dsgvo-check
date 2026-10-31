/** L2: Usercentrics v3 (shadow DOM #usercentrics-cmp-ui) and v2 (#usercentrics-root) against own simulators. */
import { expect, it } from 'vitest';
import { classifyFirstLayer, extract, loadLexicon, waitForBanner } from '../../../src/cmp/index.ts';
import { decideAndAct, describeCmpScenarios, recognized } from './helpers.ts';

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
      expect((await adapter.reject(page, { facts })).clicked).toBe(true);
      expect((await adapter.verify(page, 'reject')).verified).toBe(true);
    });

    it('geo branch: isConsentRequired() false without an answer → geo signal, no banner', async () => {
      const { page } = await env.open('https://www.usercentrics.test/geo.html');
      const adapter = await recognized(page, 'usercentrics');
      await page.waitForTimeout(400);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.geoSignals.map((g) => g.signal)).toEqual(['usercentrics:isConsentRequired=false']);
      expect(facts.firstLayer.bannerVisible).toBe(false);
    });

    // S-14: a click that changes nothing must not turn a default-denied state with an unknown answer into a reject.
    it('a deny button without effect (answer unknown, default denied) is not a verified reject', async () => {
      const { page } = await env.open('https://www.usercentrics.test/broken-deny.html');
      const adapter = await recognized(page, 'usercentrics');
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.state[0]?.decision?.responded).toBe('unknown');
      expect(Object.values(facts.state[0]?.categories ?? {})).toEqual(['denied', 'denied']);
      const target = classifyFirstLayer(facts, loadLexicon()).targets?.reject ?? null;
      expect(target?.name).toBe('Ablehnen');
      const click = await adapter.reject(page, { facts, target });
      expect(click.clicked).toBe(true);
      const now = await adapter.verify(page, 'reject', { reload: false });
      expect(now.verified).toBe(false);
      expect(now.reason).toBe('api:response-unknown');
      expect(now.method).toContain('ui-closed');
      expect(now.stateAfter.some((st) => st.origin === 'action')).toBe(false);
      const full = await adapter.verify(page, 'reject');
      expect(full.verified).toBe(false);
      expect(full.persistedAfterReload).toBe(false);
    });

    it('after an explicit reject isConsentRequired() is false too, but that is not a geo signal', async () => {
      const { page } = await env.open('https://www.usercentrics.test/');
      const adapter = await recognized(page, 'usercentrics');
      await waitForBanner(page, adapter);
      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      expect(await adapter.geoSignals(page)).toEqual([]);
    });
  },
);
