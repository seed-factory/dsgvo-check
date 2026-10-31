/**
 * L2: what the generic heuristic recognizes (canary fixes G09, G10, G13, G18). Facts only: an unknown banner is
 * `banner-not-recognized` (info), nothing is clicked (5.5).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFirstLayer, detectCmp, extract, loadLexicon } from '../../../src/cmp/index.ts';
import { bannerScreenshot } from '../../../src/collectors/browser/screenshot.ts';
import { useCmpServer } from './helpers.ts';

describe('generic heuristic: recognition of unknown banners', () => {
  const env = useCmpServer(['cmp/generic', 'cmp/cookiebot']);
  const lexicon = loadLexicon();

  describe('G09: visible consent-looking iframe whose content cannot be resolved', () => {
    it('full-viewport iframe titled "Consent window", content below the keyword threshold → unresolved candidate', async () => {
      const { page } = await env.open('https://www.generic.test/consent-frame.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.recognitionConfidence).toBe('low');
      expect(facts.detection.signals).toContain('heuristic:frame-candidate');
      expect(facts.firstLayer.bannerPresent).toBe(true);
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.consentFrameUnresolved).toBe(true);
      // No clicks on the candidate: no buttons are reported, and the table gives no target.
      expect(facts.firstLayer.buttons).toEqual([]);
      expect(facts.firstLayer.coversFooter ?? false).toBe(false);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.targets).toEqual({ reject: null, accept: null });
    });

    it('counterexample: a full-viewport video iframe without consent wording is no candidate', async () => {
      const { page } = await env.open('https://www.generic.test/video-frame.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
    });

    it('counterexample: a small iframe titled "Consent widget" (below 50 % of the viewport) is no candidate', async () => {
      const { page } = await env.open('https://www.generic.test/small-consent-frame.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
    });

    it('counterexample: a large booking iframe whose body has a single "Privacy" footer link is no candidate', async () => {
      const { page } = await env.open('https://www.generic.test/booking-frame.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
      expect(classifyFirstLayer(facts, lexicon).reasons).toEqual(['no-banner-detected']);
    });

    it('a large untitled iframe whose body has consent wording (two keywords) but no controls stays an unresolved candidate', async () => {
      const { page } = await env.open('https://www.generic.test/wording-frame.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.signals).toContain('heuristic:frame-candidate');
      const hits = facts.detection.signals.find((x) => x.startsWith('heuristic:keywords:'));
      expect(Number(hits?.split(':')[2])).toBeGreaterThanOrEqual(2);
      expect(facts.detection.signals).not.toContain('heuristic:frame-label');
      expect(facts.firstLayer.consentFrameUnresolved).toBe(true);
    });
  });

  describe('G10: languages beyond de/en and static banners', () => {
    it('Finnish fixed bar with reject and accept → found as heuristic banner, kinds classified, info only', async () => {
      const { page } = await env.open('https://www.generic.test/fi-banner.html');
      const { adapter, detection } = await detectCmp(page);
      expect(adapter).toBeNull();
      expect(detection.method).toBe('heuristic');
      expect(detection.signals).toContain('heuristic:fixed');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject', 'settings']);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.targets).toEqual({ reject: null, accept: null });
    });

    it('static (not fixed) region at the top of the page with cookie wording and two buttons → found, signal heuristic:static', async () => {
      const { page } = await env.open('https://www.generic.test/static-region.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:static');
      expect(facts.detection.recognitionConfidence).not.toBe('high');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
      expect(facts.firstLayer.containerFixed).toBe(false);
    });

    it('counterexample: a data-protection text block in main without banner controls is not a banner', async () => {
      const { page } = await env.open('https://www.generic.test/policy-text.html');
      const { detection } = await detectCmp(page);
      expect(detection.method).toBe('none');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });
  });

  describe('G18: page chrome is not a banner, and "covers the footer" is a measured overlap', () => {
    it('fixed side menu inside <nav> with privacy words and many links → nothing recognized, footer not covered', async () => {
      const { page } = await env.open('https://www.generic.test/docs-nav.html');
      const { detection } = await detectCmp(page);
      expect(detection.method).toBe('none');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.coversFooter ?? false).toBe(false);
      expect(classifyFirstLayer(facts, lexicon).reasons).toEqual(['no-banner-detected']);
    });

    it('a real fixed bar over footer links that are visible at the first screen → covered, with the link and who covers it', async () => {
      const { page } = await env.open('https://www.generic.test/footer-covered.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
      expect(facts.firstLayer.coversFooter).toBe(true);
      const covered = facts.firstLayer.coveredFooterLinks ?? [];
      expect(covered.map((l) => l.label)).toEqual(
        expect.arrayContaining(['Impressum', 'Datenschutzerklärung']),
      );
      expect(covered[0]?.coveredBy).toBe('banner');
      expect(covered[0]?.box.width).toBeGreaterThan(0);
    });

    it('counterexample: the same kind of bar on a long page, footer below the first screen → no overlap observed', async () => {
      const { page } = await env.open('https://www.generic.test/footer-below-fold.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.coversFooter ?? false).toBe(false);
      expect(facts.firstLayer.coveredFooterLinks ?? []).toEqual([]);
    });

    it('counterexample: a fixed cookie bar with accept/reject is still recognized as before (info, no click)', async () => {
      const { page } = await env.open('https://www.generic.test/');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(classifyFirstLayer(facts, lexicon).targets).toEqual({ reject: null, accept: null });
    });

    it('a fixed cookie bar with accept/reject placed inside <footer> (footer partial) is still found', async () => {
      const { page } = await env.open('https://www.generic.test/bar-in-footer.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:fixed');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
      expect(classifyFirstLayer(facts, lexicon).variant).toBe('banner-not-recognized');
    });

    it('the same bar inside a container with role contentinfo is still found', async () => {
      const { page } = await env.open('https://www.generic.test/bar-in-contentinfo.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
    });

    it('a static cookie region with accept/reject inside <header> is still found (heuristic:static)', async () => {
      const { page } = await env.open('https://www.generic.test/region-in-header.html');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:static');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
    });

    it('counterexample: a fixed footer strip "Impressum · Datenschutz · Cookie-Einstellungen" (settings link, no accept/reject) is no banner', async () => {
      const { page } = await env.open('https://www.generic.test/footer-link-strip.html');
      const { detection } = await detectCmp(page);
      expect(detection.method).toBe('none');
      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });
  });

  describe('G13: a medium adapter signal does not hide a visible generic banner', () => {
    it('stored-consent signal of an adapter (one signal kind) next to a visible fixed banner → heuristic facts, adapter kept as hint', async () => {
      const { page } = await env.open('https://www.generic.test/medium-storage.html');
      const { adapter, detection } = await detectCmp(page);
      expect(adapter?.id).toBe('cookiebot');
      expect(detection.recognitionConfidence).toBe('medium');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.firstLayer.bannerPresent).toBe(true);
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.cmpId).toBeNull();
      expect(facts.detection.recognitionConfidence).not.toBe('high');
      expect(facts.detection.signals).toEqual(
        expect.arrayContaining(['adapter-hint:cookiebot', 'cookie:CookieConsent', 'heuristic:fixed']),
      );
      expect(facts.firstLayer.containerBox).toBeTruthy();
      expect(classifyFirstLayer(facts, lexicon).targets).toEqual({ reject: null, accept: null });
      // The banner can be photographed for the report (D20): the container is unique and small.
      const dir = await mkdtemp(path.join(tmpdir(), 'dsgvo-check-shot-'));
      try {
        const shot = await bannerScreenshot(page, facts, {
          artifactsDir: dir,
          artifactsRelDir: 'artifacts',
          phase: 'B',
          pageUrl: 'https://www.generic.test/medium-storage.html',
        });
        expect('record' in shot).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counterexample: a medium adapter whose own banner is measured and visible keeps its facts next to a foreign dialog', async () => {
      const { page } = await env.open('https://www.generic.test/medium-own-banner.html');
      const { adapter, detection } = await detectCmp(page);
      expect(adapter?.id).toBe('cookiebot');
      expect(detection.recognitionConfidence).toBe('medium');
      const own = await (adapter as NonNullable<typeof adapter>).extract(page, 'first-screen', {});
      expect(own.firstLayer.bannerVisible).toBe(true);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.detection.method).toBe('adapter');
      expect(facts.detection.cmpId).toBe('cookiebot');
      expect(facts.detection.signals.some((s) => s.startsWith('heuristic:'))).toBe(false);
      expect(facts.firstLayer.containerBox).toEqual(own.firstLayer.containerBox);
      expect(facts.firstLayer.buttons.map((b) => [b.name, b.vendorRole])).toEqual([
        ['Ablehnen', 'reject'],
        ['Alle zulassen', 'accept'],
      ]);
      expect(facts.blocking.ariaModal ?? false).toBe(false);
    });

    it('counterexample: an adapter that initializes late (3 s) and shows its own dialog → facts of the adapter', async () => {
      const { page } = await env.open('https://www.cookiebot.test/late.html');
      const { adapter } = await detectCmp(page);
      expect(adapter?.id).toBe('cookiebot');
      const { waitForBanner } = await import('../../../src/cmp/index.ts');
      expect(await waitForBanner(page, adapter as NonNullable<typeof adapter>, { timeoutMs: 8000 })).toBe(
        true,
      );
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.detection.method).toBe('adapter');
      expect(facts.detection.cmpId).toBe('cookiebot');
      expect(facts.firstLayer.bannerPresent).toBe(true);
    });
  });
});
