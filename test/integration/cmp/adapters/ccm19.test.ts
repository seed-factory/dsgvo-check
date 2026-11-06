/**
 * CCM19 adapter against the own simulator, which renders the widget hidden with disabled controls and opens it later.
 * A widget that is never opened is recorded as such, in the adapter and through the collector into the checks.
 */
import { expect, it } from 'vitest';
import { consent04 } from '../../../../src/checks/browser/consent-04.ts';
import { consent05 } from '../../../../src/checks/browser/consent-05.ts';
import { adaptersSection } from '../../../../src/cmp/adapters-data.ts';
import { extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import type { CmpFacts } from '../../../../src/cmp/types.ts';
import { loadDataDir } from '../../../../src/core/data/load.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { makeSnapshot, makeTarget, runCheck, withDerived } from '../../../utils/snapshot-builder.ts';
import { collect } from '../../browser/helpers.ts';
import { CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

const SITE = 'https://www.ccm19.test';
/** Long enough for the simulator to open its dialog (500 ms), short enough to keep the never-opened cases quick. */
const SHORT_WAIT_MS = 1_500;

const settingsSelector = (): string => {
  const roles = adaptersSection.parse(loadDataDir('cmp')).ccm19.banner.vendorRoles;
  return roles.find((r) => r.role === 'settings')?.selector ?? '';
};

describeCmpScenarios(
  {
    id: 'ccm19',
    site: 'cmp/ccm19',
    okUrl: `${SITE}/`,
    blockingUrl: `${SITE}/blocking.html`,
    version: null,
    rejectName: /^Ablehnen$/,
    acceptName: /^Alle akzeptieren$/,
  },
  (env) => {
    it('a dialog that never opens: flagged after the wait, no click target, nothing clicked', async () => {
      const { page } = await env.open(`${SITE}/not-opened.html`);
      const adapter = await recognized(page, 'ccm19');
      expect(await waitForBanner(page, adapter, { timeoutMs: SHORT_WAIT_MS })).toBe(false);

      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      expect(facts.firstLayer).toMatchObject({
        bannerPresent: true,
        bannerVisible: false,
        dialogNotOpened: true,
      });
      const controls = facts.firstLayer.buttons.filter((b) => b.role === 'button');
      expect(controls.map((b) => [b.name, b.enabled, b.box])).toEqual([
        ['Einstellungen', false, null],
        ['Ablehnen', false, null],
        ['Alle akzeptieren', false, null],
      ]);
      expect(facts.state[0]?.decision?.responded).toBe(false);
      expect(classifyFirstLayer(facts, loadLexicon()).targets?.reject ?? null).toBeNull();
      expect(await adapter.act?.(page, 'reject', null)).toMatchObject({ clicked: false });
    });

    it('without the wait for the banner the same widget is not called unopened', async () => {
      const { page } = await env.open(`${SITE}/not-opened.html`);
      const adapter = await recognized(page, 'ccm19');

      const facts = await extract(page, adapter, 'first-screen', { phase: 'A' });

      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.firstLayer.dialogNotOpened).toBeUndefined();
    });

    it('counterexample: the hidden widget of a visitor who answered is answered, not unopened', async () => {
      const { page } = await env.open(`${SITE}/answered.html`);
      const adapter = await recognized(page, 'ccm19');
      expect(await waitForBanner(page, adapter, { timeoutMs: SHORT_WAIT_MS })).toBe(false);

      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      expect(facts.firstLayer).toMatchObject({ bannerPresent: true, bannerVisible: false });
      expect(facts.firstLayer.dialogNotOpened).toBeUndefined();
      expect(facts.state[0]).toMatchObject({ origin: 'stored', decision: { responded: true } });
    });

    it('counterexample: a hidden copy an earlier container selector finds does not hide the opened dialog', async () => {
      const { page } = await env.open(`${SITE}/hidden-template-visible-dialog.html`);
      const adapter = await recognized(page, 'ccm19');
      expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

      const { facts, click } = await decideAndAct(page, adapter, 'reject');

      expect(facts.firstLayer.bannerVisible).toBe(true);
      const reject = facts.firstLayer.buttons.find((b) => b.kind === 'reject' && b.layer === 1);
      expect(reject).toMatchObject({ name: 'Ablehnen', actionableAtFirstScreen: true });
      expect(click).toMatchObject({ clicked: true, button: { kind: 'reject' } });
      const verify = await adapter.verify(page, 'reject');
      expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
    });

    it('the settings role is given to the settings button only, not to the language select or other controls', async () => {
      const { page } = await env.open(`${SITE}/`);
      const adapter = await recognized(page, 'ccm19');
      expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

      const matched = await page
        .locator('#ccm-widget')
        .locator(settingsSelector())
        .evaluateAll((els) =>
          els.map(
            (e) =>
              `${(e as { tagName: string }).tagName.toLowerCase()}:${(e as { textContent: string }).textContent}`,
          ),
        );
      const facts: CmpFacts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      expect(matched).toEqual(['button:Einstellungen']);
      expect(facts.firstLayer.buttons.filter((b) => b.vendorRole === 'settings').map((b) => b.name)).toEqual([
        'Einstellungen',
      ]);
    });

    it('through the collector: flagged on the first screen of B only, nothing clicked, CONSENT-04 and 05 say why', async () => {
      const run = await collect(env.server, {
        url: `${SITE}/not-opened.html`,
        deps: { phases: ['A', 'B'] },
        config: { cmp: { waitMs: SHORT_WAIT_MS } },
        maxPages: 1,
        screenshots: false,
      });
      const { browser, cmp, documents, plan } = run.result.sections;
      const facts = (p: 'A' | 'B') => cmp?.phases.find((x) => x.phase === p)?.facts ?? [];

      expect(facts('B').find((f) => f.moment === 'first-screen')?.firstLayer.dialogNotOpened).toBe(true);
      // Phase A measures without waiting for the banner: the same closed widget, not called unopened there.
      expect(
        facts('A').map((f) => [f.firstLayer.bannerPresent, f.firstLayer.dialogNotOpened]),
      ).toContainEqual([true, undefined]);
      expect(facts('A').filter((f) => f.firstLayer.dialogNotOpened !== undefined)).toEqual([]);
      expect(plan?.click.B).toMatchObject({ target: null });
      expect(cmp?.phases.find((x) => x.phase === 'B')?.click).toMatchObject({ clicked: false });

      const target = makeTarget(`${SITE}/not-opened.html`);
      const snapshot = withDerived(
        makeSnapshot({
          target,
          browser,
          cmp,
          documents,
          plan: { browser: plan ?? null, probes: [] },
        }),
      );
      for (const check of [consent04, consent05]) {
        const r = runCheck(check, snapshot);
        expect({ id: check.id, status: r.status, reason: r.reason }).toEqual({
          id: check.id,
          status: 'inconclusive',
          reason: 'cmp-dialog-not-opened',
        });
        expect(r.outcome?.observations).toEqual([]);
      }
    });
  },
);
