/**
 * Wix adapter against the own simulator of the site banner (policy read from `consentPolicyManager`), including the
 * reject through the settings layer of a first layer without one.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import {
  chooseSettingsOpener,
  chooseSettingsSave,
  detectCmp,
  extract,
  loadLexicon,
  waitForBanner,
} from '../../../../src/cmp/index.ts';
import type { ClickTarget, CmpAdapter, CmpButton } from '../../../../src/cmp/types.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
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

/** The click target of a control core chose. */
const asTarget = (b: CmpButton): ClickTarget => ({
  name: b.name,
  role: b.role,
  ...(b.selector ? { selector: b.selector } : {}),
  kindConfidence: b.kindConfidence,
  kind: b.kind,
});

/** Whether the analytics switch of the shown layer is on (the last category, as Wix lists them): read, never changed. */
const analyticsSwitchOn = (page: Page): Promise<boolean | null> =>
  page
    .getByRole('dialog')
    .locator('[data-hook="consent-banner-section-toggle-input"]')
    .last()
    .evaluate((input) => (input as { checked: boolean }).checked)
    .catch(() => null);

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

    it('counterexample: a first layer with "Zustimmen" and × alone has no reject; the × is never clicked as one', async () => {
      const { page } = await env.open('https://www.wix.test/close-only.html');
      const adapter = await recognized(page, 'wix');
      expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      expect(facts.firstLayer.buttons.map((b) => [b.name, b.kind])).toEqual([
        ['Zur Datenschutzerklärung', 'link'],
        ['Zustimmen', 'accept'],
        ['Schließen', 'close'],
      ]);
      const cls = classifyFirstLayer(facts, loadLexicon());
      expect(cls.variant).toBe('nonblocking-no-reject');
      expect(cls.targets?.reject).toBeNull();
      const click = await adapter.reject(page, { facts, ...DEFAULT_CLASSIFY });
      expect(click.clicked).toBe(false);
      expect(await waitForBanner(page, adapter, { timeoutMs: 100 })).toBe(true);
    });

    it('a policy API that throws: Wix is still recognised, the clicked reject is not confirmed and no state is called ready', async () => {
      const { page } = await env.open('https://www.wix.test/policy-throws.html');
      const adapter = await recognized(page, 'wix');
      await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      expect(await adapter.ready?.(page)).toBe(false);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      const verify = await adapter.verify(page, 'reject', { timeoutMs: 1_000 });

      expect(verify).toMatchObject({ verified: false, reason: 'state-unavailable' });
      expect(verify.persistedAfterReload).not.toBe(true);
      expect(verify.stateAfter.filter((st) => st.ready === 'ready')).toEqual([]);
    });

    describe('the reject through the settings layer of a first layer without one', () => {
      /** The first screen of `url`, the opener core chose on it and, when there is one, the layer it opened. */
      async function settingsOf(url: string) {
        const { page } = await env.open(url);
        const adapter: CmpAdapter = await recognized(page, 'wix');
        expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);
        const first = await extract(page, adapter, 'first-screen', { phase: 'B' });
        const opener = chooseSettingsOpener(first, loadLexicon(), DEFAULT_CLASSIFY);
        const layer = opener?.target
          ? await adapter.openSettings?.(page, asTarget(opener.target), { timeoutMs: CMP_WAIT_MS })
          : undefined;
        return { page, adapter, first, opener, layer };
      }

      it('"Cookie-Einstellungen" opens the layer with every optional group off; its save is a reject the policy confirms after the reload', async () => {
        const since = Date.now();
        const { page, adapter, opener, layer } = await settingsOf('https://www.wix.test/no-decline.html');

        expect(adapter.rejectsViaSettings).toBe(true);
        expect(opener?.target?.name).toBe('Cookie-Einstellungen');
        // The layer's container shows at once, its panel only fades in a moment later: the controls are read once
        // they show and stand still, not while they are still transparent.
        expect(layer?.buttons.every((b) => b.actionableAtFirstScreen)).toBe(true);
        expect(layer).toMatchObject({
          opened: true,
          containerUnambiguous: true,
          groups: [
            { checked: true, disabled: true },
            { checked: false, disabled: false },
            { checked: false, disabled: false },
            { checked: false, disabled: false },
          ],
        });
        // The layer's own controls only: the first layer, open behind it, is not what was measured.
        expect(layer?.buttons.map((b) => [b.name, b.vendorRole])).toEqual([
          ['Einstellungen schließen', null],
          ['Auswahl bestätigen', 'save'],
        ]);
        expect((await adapter.firstLayer(page)).bannerVisible).toBe(true);
        const save = chooseSettingsSave(layer!, loadLexicon());
        expect(save.target?.name).toBe('Auswahl bestätigen');
        // Opening the settings records no answer: the policy is still the default before the save.
        expect((await adapter.state(page))[0]).toMatchObject({
          origin: 'default',
          decision: { responded: false },
        });

        expect((await adapter.act!(page, 'reject', asTarget(save.target!))).clicked).toBe(true);
        const verify = await adapter.verify(page, 'reject');

        expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
        expect(verify.method).toContain('api:all-denied');
        expect(requestsSince(env.server, TRACKER, since)).toBe(0);
      });

      it('counterexample: an optional group already on → nothing is saved (preselected-groups) and the switch stays on', async () => {
        const { page, adapter, layer } = await settingsOf('https://www.wix.test/no-decline-preselected.html');

        expect(layer?.groups.filter((g) => g.checked && !g.disabled)).toHaveLength(1);
        expect(chooseSettingsSave(layer!, loadLexicon())).toEqual({
          target: null,
          reason: 'preselected-groups',
        });
        expect(await analyticsSwitchOn(page)).toBe(true);
        expect((await adapter.state(page))[0]).toMatchObject({
          origin: 'default',
          decision: { responded: false },
        });
      });

      it('counterexample: a hidden copy of the layer with every switch off comes first; the shown layer has analytics on → nothing is saved', async () => {
        const { layer } = await settingsOf('https://www.wix.test/no-decline-hidden-copy.html');

        expect(layer).toMatchObject({ opened: true, containerUnambiguous: true });
        expect(layer?.groups.filter((g) => g.checked && !g.disabled)).toHaveLength(1);
        expect(chooseSettingsSave(layer!, loadLexicon())).toEqual({
          target: null,
          reason: 'preselected-groups',
        });
      });

      it('counterexample: analytics on and locked like the essential switch → nothing is saved', async () => {
        const { layer } = await settingsOf('https://www.wix.test/no-decline-locked-on.html');

        expect(layer?.groups.filter((g) => g.checked && g.disabled)).toHaveLength(2);
        expect(layer?.essentialGroups).toBe(1);
        expect(chooseSettingsSave(layer!, loadLexicon())).toEqual({
          target: null,
          reason: 'preselected-groups',
        });
      });

      it('counterexample: two save controls in the layer → no save control is chosen', async () => {
        const { layer } = await settingsOf('https://www.wix.test/no-decline-two-saves.html');

        expect(layer?.buttons.filter((b) => b.vendorRole === 'save')).toHaveLength(2);
        expect(chooseSettingsSave(layer!, loadLexicon())).toEqual({
          target: null,
          reason: 'settings-save-not-found',
        });
      });

      it('counterexample: a settings control of the page outside the banner is never the opener', async () => {
        const { first, opener, layer } = await settingsOf('https://www.wix.test/settings-outside.html');

        expect(first.firstLayer.buttons.map((b) => b.name)).not.toContain('Cookie-Einstellungen');
        expect(opener).toEqual({ target: null, reason: 'settings-control-not-found' });
        expect(layer).toBeUndefined();
      });

      it('counterexample: a first layer with "Alle ablehnen" never opens the settings', async () => {
        const { opener, layer } = await settingsOf('https://www.wix.test/');

        expect(opener).toBeNull();
        expect(layer).toBeUndefined();
      });

      it('a save that stores no answer leaves the policy at its default: the reject is not confirmed', async () => {
        const { page, adapter, layer } = await settingsOf('https://www.wix.test/no-decline-unsaved.html');
        const save = chooseSettingsSave(layer!, loadLexicon());
        expect((await adapter.act!(page, 'reject', asTarget(save.target!))).clicked).toBe(true);

        const verify = await adapter.verify(page, 'reject', { timeoutMs: 1_000 });

        expect(verify.verified).toBe(false);
        expect(verify.persistedAfterReload).not.toBe(true);
      });
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
