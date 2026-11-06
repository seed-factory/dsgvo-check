/** Wix adapter against the own simulator of the site banner (policy read from `consentPolicyManager`). */
import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { detectCmp, extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized, requestsSince } from '../helpers.ts';

const TRACKER = 'stats.wix.test';

/** The platform's own policy, booleans only: whether it is the default and its `dataToThirdParty` flag. */
function platformPolicy(page: Page): Promise<{ defaultPolicy: boolean; dataToThirdParty: boolean }> {
  return page.evaluate(() => {
    interface Policy {
      defaultPolicy: boolean;
      policy: Record<string, boolean>;
    }
    const w = globalThis as unknown as { consentPolicyManager: { getCurrentConsentPolicy(): Policy } };
    const current = w.consentPolicyManager.getCurrentConsentPolicy();
    return {
      defaultPolicy: current.defaultPolicy,
      dataToThirdParty: current.policy.dataToThirdParty === true,
    };
  });
}

describeCmpScenarios(
  {
    id: 'wix',
    site: 'cmp/wix',
    okUrl: 'https://www.wix.test/',
    nonblockingNoRejectUrl: 'https://www.wix.test/no-decline.html',
    version: null,
    rejectName: /^Alle ablehnen$/,
    acceptName: /^Zustimmen$/,
  },
  (env) => {
    it('dataToThirdParty stays on before any answer and after the reject: the default grants no category, the reject is confirmed as all denied after the reload', async () => {
      const since = Date.now();
      const { page } = await env.open('https://www.wix.test/');
      const adapter = await recognized(page, 'wix');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      expect(await platformPolicy(page)).toEqual({ defaultPolicy: true, dataToThirdParty: true });
      // No granted category in the default state, so nothing for consent-without-action.
      expect(await adapter.state(page)).toEqual([
        {
          source: 'api',
          ready: 'ready',
          categories: { functional: 'denied', analytics: 'denied', advertising: 'denied' },
          origin: 'default',
          decision: { responded: false, method: 'unknown' },
        },
      ]);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'reject');

      expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
      expect(verify.method).toContain('api:all-denied');
      expect(await platformPolicy(page)).toEqual({ defaultPolicy: false, dataToThirdParty: true });
      expect(await adapter.state(page)).toEqual([
        {
          source: 'api',
          ready: 'ready',
          categories: { functional: 'denied', analytics: 'denied', advertising: 'denied' },
          origin: 'stored',
          decision: { responded: true, method: 'explicit' },
        },
      ]);
      // Without a banner in the page the platform API and the banner script still recognise Wix.
      expect(await recognized(page, 'wix')).toBe(adapter);
      expect(requestsSince(env.server, TRACKER, since)).toBe(0);
    });

    it('counterexample: a site with the platform policy API but no banner app (consentPolicyManager only) is no Wix recognition', async () => {
      const { page } = await env.open('https://www.wix.test/platform-without-banner.html');

      const { adapter, detection } = await detectCmp(page);

      expect(adapter).toBeNull();
      expect(detection.method).not.toBe('adapter');
    });

    it('accept grants every optional category and loads the local tracker', async () => {
      const since = Date.now();
      const { page } = await env.open('https://www.wix.test/');
      const adapter = await recognized(page, 'wix');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });

      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);

      expect((await adapter.state(page))[0]?.categories).toEqual({
        functional: 'granted',
        analytics: 'granted',
        advertising: 'granted',
      });
      await expect.poll(() => requestsSince(env.server, TRACKER, since)).toBeGreaterThan(0);
    });

    it('never stores the cookie value: the facts hold the policy categories only', async () => {
      const { page } = await env.open('https://www.wix.test/');
      const adapter = await recognized(page, 'wix');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);

      const facts = await adapter.extract(page, 'after-click');

      expect(JSON.stringify(facts)).not.toMatch(/consent-policy|"ess"|"dt3"|dataToThirdParty/);
    });

    it('the description under aria-hidden, the policy link, settings as span[role=button] and × are measured', async () => {
      const { page } = await env.open('https://www.wix.test/');
      const adapter = await recognized(page, 'wix');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });

      const facts = await extract(page, adapter, 'first-screen');

      const kinds = facts.firstLayer.buttons.map((b) => [b.name, b.kind, b.vendorRole ?? null]);
      expect(kinds).toEqual([
        ['Datenschutzerklärung', 'link', null],
        ['Einstellungen', 'settings', 'settings'],
        ['Alle ablehnen', 'reject', 'reject'],
        ['Zustimmen', 'accept', 'accept'],
        ['Schließen', 'close', 'close'],
      ]);
      expect(facts.firstLayer.buttons.find((b) => b.kind === 'settings')?.role).toBe('button');
      expect(facts.firstLayer.closeMeansAccept).toBeNull();
      expect(classifyFirstLayer(facts, loadLexicon()).variant).toBe('ok');
    });
  },
);
