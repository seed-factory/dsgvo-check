/**
 * CCM19 adapter against the own simulator, which renders the widget hidden with disabled controls and opens it later,
 * and, like CCM19, never opens it for a User-Agent its crawler test takes for a bot. A widget that is never opened is
 * recorded as such, and with the reason when that test matched the page's User-Agent. The scanner's own User-Agent is
 * no crawler there: through the collector the widget opens and the reject is clicked.
 */
import { expect, it } from 'vitest';
import { consent03 } from '../../../../src/checks/browser/consent-03.ts';
import { consent04 } from '../../../../src/checks/browser/consent-04.ts';
import { consent05 } from '../../../../src/checks/browser/consent-05.ts';
import { adaptersSection } from '../../../../src/cmp/adapters-data.ts';
import { extract, loadLexicon, waitForBanner } from '../../../../src/cmp/index.ts';
import { BOT_USER_AGENT_SIGNAL, type CmpFacts } from '../../../../src/cmp/types.ts';
import { loadDataDir } from '../../../../src/core/data/load.ts';
import { browserUserAgent } from '../../../../src/core/runtime/user-agent.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { makeSnapshot, makeTarget, runCheck, withDerived } from '../../../utils/snapshot-builder.ts';
import { collect } from '../../browser/helpers.ts';
import { CHROME_UA, CMP_WAIT_MS, decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

const SITE = 'https://www.ccm19.test';
/** A token in the form search engine crawlers use, which CCM19's crawler test catches by its ` (+http`. */
const CRAWLER_FORM_UA = `${CHROME_UA} site-audit/1.0 (+https://example.test/about)`;
/** Long enough for the simulator to open its dialog (500 ms), short enough to keep the never-opened cases quick. */
const SHORT_WAIT_MS = 1_500;

const ccm19Data = () => adaptersSection.parse(loadDataDir('cmp')).ccm19;

const settingsSelector = (): string =>
  ccm19Data().banner.vendorRoles.find((r) => r.role === 'settings')?.selector ?? '';

/** The bot signal of a widget CCM19's crawler test kept closed. */
const crawlerSignal = () => ({
  cmpId: 'ccm19',
  signal: BOT_USER_AGENT_SIGNAL,
  detail: ccm19Data().dialogBotUserAgent?.label,
});

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
      const { page, adapter } = await env.openRecognized(`${SITE}/not-opened.html`, 'ccm19');
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
      // A plain Chrome is no crawler for CCM19: the dialog stayed closed for another reason, which is not named.
      expect(facts.botSignals).toEqual([]);
      expect(classifyFirstLayer(facts, loadLexicon()).targets?.reject ?? null).toBeNull();
      expect(await adapter.act?.(page, 'reject', null)).toMatchObject({ clicked: false });
    });

    it("a crawler's User-Agent matches CCM19's crawler test: the widget stays closed, the bot signal says why", async () => {
      const { page, adapter } = await env.openRecognized(`${SITE}/`, 'ccm19', { ua: CRAWLER_FORM_UA });
      expect(await waitForBanner(page, adapter, { timeoutMs: SHORT_WAIT_MS })).toBe(false);

      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      expect(facts.firstLayer).toMatchObject({
        bannerPresent: true,
        bannerVisible: false,
        dialogNotOpened: true,
      });
      expect(facts.botSignals).toEqual([crawlerSignal()]);
      expect(JSON.stringify(facts)).not.toContain('site-audit/');
    });

    it.each([
      ['a plain Chrome', CHROME_UA],
      ["the scanner's own User-Agent", browserUserAgent(CHROME_UA)],
    ])(
      'counterexample: the same page opens its widget for %s, without a bot signal',
      async (_name, userAgent) => {
        const { page, adapter } = await env.openRecognized(`${SITE}/`, 'ccm19', { ua: userAgent });
        expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

        const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

        expect(facts.firstLayer.bannerVisible).toBe(true);
        expect(facts.firstLayer.dialogNotOpened).toBeUndefined();
        expect(facts.botSignals).toEqual([]);
      },
    );

    it('without the wait for the banner the same widget is not called unopened', async () => {
      const { page, adapter } = await env.openRecognized(`${SITE}/not-opened.html`, 'ccm19');

      const facts = await extract(page, adapter, 'first-screen', { phase: 'A' });

      expect(facts.firstLayer.bannerVisible).toBe(false);
      expect(facts.firstLayer.dialogNotOpened).toBeUndefined();
    });

    it('counterexample: the hidden widget of a visitor who answered is answered, not unopened', async () => {
      const { page, adapter } = await env.openRecognized(`${SITE}/answered.html`, 'ccm19');
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
      const { page, adapter } = await env.openRecognized(`${SITE}/`, 'ccm19');
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

    /** Phases A and B through the collector on one page, then CONSENT-03, 04 and 05 on the snapshot it gives. */
    const throughCollector = async (url: string, waitMs: number) => {
      const run = await collect(env.server, {
        url,
        deps: { phases: ['A', 'B'] },
        config: { cmp: { waitMs } },
        maxPages: 1,
        screenshots: false,
      });
      const { browser, cmp, documents, plan } = run.result.sections;
      const snapshot = withDerived(
        makeSnapshot({
          target: makeTarget(url),
          browser,
          cmp,
          documents,
          plan: { browser: plan ?? null, probes: [] },
        }),
      );
      const checks = [consent03, consent04, consent05].map((check) => {
        const r = runCheck(check, snapshot);
        return {
          id: check.id,
          status: r.status,
          reason: r.reason ?? null,
          observations: r.outcome?.observations ?? null,
          diagnostics: (r.outcome?.diagnostics ?? []).map((d) => d.code),
        };
      });
      return {
        cmp,
        plan,
        checks,
        facts: (p: 'A' | 'B') => cmp?.phases.find((x) => x.phase === p)?.facts ?? [],
        click: cmp?.phases.find((x) => x.phase === 'B')?.click,
      };
    };

    // The collector browses with the scanner's own User-Agent: CCM19 has to open its widget for it as for a visitor.
    it("through the collector: the scanner's User-Agent is no crawler for CCM19; the widget opens on B, the reject is clicked, no check names a bot", async () => {
      const { cmp, plan, checks, facts, click } = await throughCollector(`${SITE}/`, CMP_WAIT_MS);

      const firstScreen = facts('B').find((f) => f.moment === 'first-screen');
      expect(firstScreen?.firstLayer.bannerVisible).toBe(true);
      expect(firstScreen?.firstLayer.dialogNotOpened).toBeUndefined();
      expect(cmp?.phases.flatMap((x) => x.facts.flatMap((f) => f.botSignals))).toEqual([]);
      expect(plan?.click.B?.target).toMatchObject({ cmpId: 'ccm19', name: 'Ablehnen' });
      expect(click).toMatchObject({ clicked: true, button: { kind: 'reject' } });
      expect(checks.map((c) => [c.id, c.status, c.reason])).toEqual([
        // One page, fewer than CONSENT-03 needs.
        ['CONSENT-03', 'inconclusive', 'insufficient-pages'],
        ['CONSENT-04', 'completed', null],
        // Beacons sent on pagehide are not captured yet.
        ['CONSENT-05', 'inconclusive', 'pagehide-capture-unavailable'],
      ]);
      expect(checks.flatMap((c) => c.diagnostics)).not.toContain('SCAN-BOTMODE');
    });

    it('through the collector: a widget that never opens is flagged on B only, nothing is clicked, CONSENT-04 and 05 say it was not opened', async () => {
      const { cmp, plan, checks, facts, click } = await throughCollector(
        `${SITE}/not-opened.html`,
        SHORT_WAIT_MS,
      );

      const firstScreen = facts('B').find((f) => f.moment === 'first-screen');
      expect(firstScreen?.firstLayer.dialogNotOpened).toBe(true);
      // The scanner's own User-Agent is no crawler for CCM19: the dialog stayed closed for another reason, not named.
      expect(cmp?.phases.flatMap((x) => x.facts.flatMap((f) => f.botSignals))).toEqual([]);
      // Phase A measures without waiting for the banner: the same closed widget, not called unopened there.
      expect(
        facts('A').map((f) => [f.firstLayer.bannerPresent, f.firstLayer.dialogNotOpened]),
      ).toContainEqual([true, undefined]);
      expect(facts('A').filter((f) => f.firstLayer.dialogNotOpened !== undefined)).toEqual([]);
      expect(plan?.click.B).toMatchObject({ target: null });
      expect(click).toMatchObject({ clicked: false });
      expect(checks.map((c) => [c.id, c.status, c.reason, c.observations, c.diagnostics])).toEqual([
        ['CONSENT-03', 'inconclusive', 'insufficient-pages', [], []],
        ['CONSENT-04', 'inconclusive', 'cmp-dialog-not-opened', [], []],
        ['CONSENT-05', 'inconclusive', 'cmp-dialog-not-opened', [], []],
      ]);
    });
  },
);
