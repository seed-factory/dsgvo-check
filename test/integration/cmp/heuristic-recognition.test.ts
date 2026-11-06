/** Generic heuristic: facts only; an unknown banner is `banner-not-recognized` (info), nothing is clicked. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCmp, extract, loadLexicon, waitForBanner } from '../../../src/cmp/index.ts';
import type { CmpFacts } from '../../../src/cmp/types.ts';
import { bannerScreenshot } from '../../../src/collectors/browser/phases/screenshot.ts';
import { classifyFirstLayer } from '../../utils/classify.ts';
import { useCmpServer } from './helpers.ts';

describe('generic heuristic: recognition of unknown banners', () => {
  const env = useCmpServer(['cmp/generic', 'cmp/cookiebot']);
  const lexicon = loadLexicon();

  /** Opens `file` of the generic fixture site and measures its first screen without an adapter. */
  async function measure(file: string): Promise<CmpFacts> {
    const { page } = await env.open(`https://www.generic.test/${file}`);
    return extract(page, null, 'first-screen');
  }

  const buttonKinds = (facts: CmpFacts) => facts.firstLayer.buttons.map((b) => b.kind).sort();

  describe('visible consent-looking iframe whose content cannot be resolved', () => {
    it('full-viewport iframe titled "Consent window", content below the keyword threshold → unresolved candidate', async () => {
      const facts = await measure('consent-frame.html');

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
      const facts = await measure('video-frame.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
    });

    it('counterexample: a small iframe titled "Consent widget" (below 50 % of the viewport) is no candidate', async () => {
      const facts = await measure('small-consent-frame.html');

      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
    });

    it('counterexample: a large booking iframe whose body has a single "Privacy" footer link is no candidate', async () => {
      const facts = await measure('booking-frame.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
      expect(classifyFirstLayer(facts, lexicon).reasons).toEqual(['no-banner-detected']);
    });

    it('a large untitled iframe whose body has consent wording (two keywords) but no controls stays an unresolved candidate', async () => {
      const facts = await measure('wording-frame.html');

      expect(facts.detection.signals).toContain('heuristic:frame-candidate');
      const hits = facts.detection.signals.find((x) => x.startsWith('heuristic:keywords:'));
      expect(Number(hits?.split(':')[2])).toBeGreaterThanOrEqual(2);
      expect(facts.detection.signals).not.toContain('heuristic:frame-label');
      expect(facts.firstLayer.consentFrameUnresolved).toBe(true);
    });
  });

  describe('languages beyond de/en and static banners', () => {
    it('Finnish fixed bar with reject and accept → found as heuristic banner, kinds classified, info only', async () => {
      const { page } = await env.open('https://www.generic.test/fi-banner.html');

      const { adapter, detection } = await detectCmp(page);
      expect(adapter).toBeNull();
      expect(detection.method).toBe('heuristic');
      expect(detection.signals).toContain('heuristic:fixed');

      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject', 'settings']);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.targets).toEqual({ reject: null, accept: null });
    });

    it('static (not fixed) region at the top of the page with cookie wording and two buttons → found, signal heuristic:static', async () => {
      const facts = await measure('static-region.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:static');
      expect(facts.detection.recognitionConfidence).not.toBe('high');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
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

  describe('page chrome is not a banner, and "covers the footer" is a measured overlap', () => {
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
      const facts = await measure('footer-covered.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
      expect(facts.firstLayer.coversFooter).toBe(true);

      const covered = facts.firstLayer.coveredFooterLinks ?? [];
      expect(covered.map((l) => l.label)).toEqual(
        expect.arrayContaining(['Impressum', 'Datenschutzerklärung']),
      );
      expect(covered[0]?.coveredBy).toBe('banner');
      expect(covered[0]?.box.width).toBeGreaterThan(0);
    });

    it('counterexample: the same kind of bar on a long page, footer below the first screen → no overlap observed', async () => {
      const facts = await measure('footer-below-fold.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.coversFooter ?? false).toBe(false);
      expect(facts.firstLayer.coveredFooterLinks ?? []).toEqual([]);
    });

    it('counterexample: a fixed cookie bar with accept/reject is still recognized as before (info, no click)', async () => {
      const facts = await measure('');

      expect(facts.detection.method).toBe('heuristic');
      expect(classifyFirstLayer(facts, lexicon).targets).toEqual({ reject: null, accept: null });
    });

    it('a fixed cookie bar with accept/reject placed inside <footer> (footer partial) is still found', async () => {
      const facts = await measure('bar-in-footer.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:fixed');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
      expect(classifyFirstLayer(facts, lexicon).variant).toBe('banner-not-recognized');
    });

    it('the same bar inside a container with role contentinfo is still found', async () => {
      const facts = await measure('bar-in-contentinfo.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
    });

    it('a static cookie region with accept/reject inside <header> is still found (heuristic:static)', async () => {
      const facts = await measure('region-in-header.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:static');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
    });

    it('counterexample: a fixed footer strip "Impressum · Datenschutz · Cookie-Einstellungen" (settings link, no accept/reject) is no banner', async () => {
      const { page } = await env.open('https://www.generic.test/footer-link-strip.html');

      const { detection } = await detectCmp(page);
      expect(detection.method).toBe('none');

      const facts = await extract(page, null, 'first-screen');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });
  });

  describe('one consent keyword: a choice or a banner name decides, else the dismissed candidate is kept', () => {
    it('a fixed bar with one keyword ("Cookies") and reject and accept buttons is found', async () => {
      const facts = await measure('one-keyword-choice.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:keywords:1');
      expect(buttonKinds(facts)).toEqual(['accept', 'reject', 'settings', 'settings']);
      expect(classifyFirstLayer(facts, lexicon).targets).toEqual({ reject: null, accept: null });
    });

    it('a fixed box named after a cookie banner with one keyword and a settings button is found', async () => {
      const facts = await measure('one-keyword-named.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toEqual(
        expect.arrayContaining(['heuristic:fixed', 'heuristic:named', 'heuristic:keywords:1']),
      );
    });

    it('a fixed bar with the cookie keyword and only an acknowledgement ("OK") is found', async () => {
      const facts = await measure('one-keyword-cookie-acknowledge.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:keywords:1');
      expect(buttonKinds(facts)).toEqual(['accept']);
    });

    it('counterexample: one keyword and only a "Mehr erfahren" link → no banner, the candidate is kept as facts', async () => {
      const facts = await measure('one-keyword-no-control.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toEqual({
        reason: 'keywords',
        keywordHits: 1,
        controls: ['other'],
        cookieWording: true,
        fixed: true,
        dialog: false,
        named: false,
      });
    });

    it.each([
      ['a shipping notice ("Tracking") with "Verstanden"', 'one-keyword-acknowledge-shipping.html'],
      ['a policy update notice ("Datenschutzerklärung") with "OK"', 'one-keyword-acknowledge-policy.html'],
    ])(
      'counterexample: %s → no banner, the acknowledgement is no choice of the candidate',
      async (_name, file) => {
        const facts = await measure(file);

        expect(facts.detection.method).toBe('none');
        expect(facts.firstLayer.bannerPresent).toBe(false);
        expect(facts.firstLayer.bannerCandidate).toMatchObject({
          reason: 'keywords',
          controls: ['other'],
          cookieWording: false,
        });
      },
    );

    it.each([
      [
        'a discount box ("Datenschutz") with "Anmelden" and "Mehr Informationen"',
        'one-keyword-newsletter-details.html',
      ],
      [
        'a chat teaser ("Datenschutzhinweise") with "Chat starten" and "Details"',
        'one-keyword-chat-details.html',
      ],
    ])('counterexample: %s → no banner, a candidate without cookie wording', async (_name, file) => {
      const facts = await measure(file);

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerCandidate).toMatchObject({
        reason: 'keywords',
        controls: ['settings', 'other'],
        cookieWording: false,
      });
    });

    it.each([
      ['a newsletter box with "Newsletter abonnieren" and a paid accept', 'one-keyword-newsletter.html'],
      ['a chat box with "Chat starten" and a close button', 'one-keyword-chat.html'],
    ])(
      'counterexample: %s and one keyword → no banner, no lexicon control in the candidate',
      async (_name, file) => {
        const facts = await measure(file);

        expect(facts.detection.method).toBe('none');
        expect(facts.firstLayer.bannerPresent).toBe(false);
        expect(facts.firstLayer.bannerCandidate).toMatchObject({ reason: 'keywords', controls: ['other'] });
      },
    );

    it('the candidate holds features only: no page text, no control names', async () => {
      const facts = await measure('one-keyword-no-control.html');

      expect(JSON.stringify(facts.firstLayer.bannerCandidate)).not.toMatch(/Cookies|erfahren|Website/);
    });

    it.each([
      ['two keywords', 'footer-link-strip.html'],
      ['one keyword', 'footer-link-strip-one-keyword.html'],
    ])(
      'a settings link strip in the page footer with %s is kept as a candidate inside the page chrome',
      async (_name, file) => {
        const facts = await measure(file);

        expect(facts.firstLayer.bannerPresent).toBe(false);
        expect(facts.firstLayer.bannerCandidate).toMatchObject({ reason: 'page-section', fixed: true });
      },
    );

    it('a page without anything banner-shaped records that the heuristic saw no candidate', async () => {
      const facts = await measure('none.html');

      expect(facts.firstLayer.bannerCandidate).toBeNull();
    });

    it('wording hidden from screen readers but shown on screen counts: a fixed bar with an aria-hidden description is found', async () => {
      const facts = await measure('aria-hidden-text.html');

      expect(facts.detection.method).toBe('heuristic');
      const hits = facts.detection.signals.find((s) => s.startsWith('heuristic:keywords:'));
      expect(Number(hits?.split(':')[2])).toBeGreaterThanOrEqual(2);
      expect(buttonKinds(facts)).toEqual(['accept', 'settings']);
    });

    it('a fixed banner after more elements than the scan reads in document order is still found', async () => {
      const facts = await measure('banner-after-long-body.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
    });
  });

  describe('a medium adapter signal does not hide a visible generic banner', () => {
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

      // The banner can be photographed for the report: the container is unique and small.
      const dir = await mkdtemp(path.join(tmpdir(), 'dsgvo-check-shot-'));
      try {
        const shot = await bannerScreenshot(page, facts, {
          artifactsDir: dir,
          artifactsRelDir: 'artifacts',
          phase: 'B',
          pageUrl: 'https://www.generic.test/medium-storage.html',
        });
        expect(shot, 'no screenshot record').toHaveProperty('record');
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
      expect(facts.detection.signals.filter((s) => s.startsWith('heuristic:'))).toEqual([]);
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
