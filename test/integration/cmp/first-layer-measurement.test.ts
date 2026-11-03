/**
 * How the first screen is measured (Cookiebot simulator): hidden vendor toggles must not push the visible buttons out
 * of the measurement, lost candidates are reported, and a banner that never settles is reported, not judged mid-animation.
 */
import { describe, expect, it } from 'vitest';
import { classifyFirstLayer, extract, loadLexicon, waitForBanner } from '../../../src/cmp/index.ts';
import { decideAndAct, recognized, useCmpServer } from './helpers.ts';

describe('first-layer measurement (Cookiebot simulator)', () => {
  const env = useCmpServer(['cmp/cookiebot', 'cmp/generic']);
  const lexicon = loadLexicon();

  describe('button limit', () => {
    it('45 hidden vendor toggles before the visible buttons: reject and accept are measured and clicked', async () => {
      const { page } = await env.open('https://www.cookiebot.test/many-vendors.html');
      const adapter = await recognized(page, 'cookiebot');
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });
      const reject = facts.firstLayer.buttons.find((b) => b.name === 'Ablehnen');
      expect(reject?.vendorRole).toBe('reject');
      expect(reject?.actionableAtFirstScreen).toBe(true);
      expect(facts.firstLayer.buttons.length).toBeLessThanOrEqual(40);
      // The dropped buttons are hidden second-layer toggles: no first-layer candidate was lost.
      expect(facts.firstLayer.buttonsTruncated ?? false).toBe(false);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('ok');
      expect(cls.targets?.reject?.name).toBe('Ablehnen');
      expect(cls.targets?.accept?.name).toBe('Alle zulassen');
    });

    it('phase B clicks the reject on that page', async () => {
      const { page } = await env.open('https://www.cookiebot.test/many-vendors.html');
      const adapter = await recognized(page, 'cookiebot');
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const { click } = await decideAndAct(page, adapter, 'reject');
      expect(click.error).toBeUndefined();
      expect(click.clicked).toBe(true);
      expect(click.button?.kind).toBe('reject');
    });

    it('counterexample: the ordinary banner is not flagged as truncated', async () => {
      const { page } = await env.open('https://www.cookiebot.test/');
      const adapter = await recognized(page, 'cookiebot');
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.firstLayer.buttonsTruncated ?? false).toBe(false);
    });

    it('more first-layer candidates than the limit (generic bar with 60 visible links): flagged as truncated', async () => {
      const { page } = await env.open('https://www.generic.test/many-controls.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.firstLayer.buttons.length).toBe(40);
      expect(facts.firstLayer.buttonsTruncated).toBe(true);
    });
  });

  describe('appearance animation', () => {
    it('dialog slides in over 1.2 s: the first screen is measured settled, the reject is actionable and clicked', async () => {
      const { page } = await env.open('https://www.cookiebot.test/animated.html');
      const adapter = await recognized(page, 'cookiebot');
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const { facts, click } = await decideAndAct(page, adapter, 'reject');
      expect(facts.firstLayer.geometryUnsettled ?? false).toBe(false);
      const reject = facts.firstLayer.buttons.find((b) => b.name === 'Ablehnen');
      expect(reject?.vendorRole).toBe('reject');
      expect(reject?.actionableAtFirstScreen).toBe(true);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('ok');
      expect(cls.targets?.reject).not.toBeNull();
      expect(click.clicked).toBe(true);
    });

    it('counterexample: a settled dialog below the viewport is still reject-not-actionable', async () => {
      const { page } = await env.open('https://www.cookiebot.test/offscreen.html');
      const adapter = await recognized(page, 'cookiebot');
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.firstLayer.geometryUnsettled ?? false).toBe(false);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('reject-not-actionable');
      expect(cls.targets?.reject).toBeNull();
    });

    it('a dialog that keeps moving is bounded to about 2 s and reported as unsettled', async () => {
      const { page } = await env.open('https://www.cookiebot.test/wobble.html');
      const adapter = await recognized(page, 'cookiebot');
      const t0 = Date.now();
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5000);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.firstLayer.geometryUnsettled).toBe(true);
    });
  });
});
