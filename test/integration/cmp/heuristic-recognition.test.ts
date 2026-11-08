/**
 * Generic heuristic: facts only; an unknown banner (no adapter) in the main document, an open shadow DOM or a
 * cross-origin iframe is `banner-not-recognized` (info), nothing is clicked.
 */
import { describe, expect, it } from 'vitest';
import { detectCmp, extract, loadLexicon, waitForBanner } from '../../../src/cmp/index.ts';
import type { CmpFacts } from '../../../src/cmp/types.ts';
import { classifyFirstLayer } from '../../utils/classify.ts';
import { useCmpServer } from './helpers.ts';

describe('generic heuristic: recognition of unknown banners', () => {
  const env = useCmpServer(['cmp/generic', 'cmp/cookiebot']);
  const lexicon = loadLexicon();

  const open = async (file: string) => (await env.open(`https://www.generic.test/${file}`)).page;

  /** Opens `file` of the generic fixture site and measures its first screen without an adapter. */
  async function measure(file: string): Promise<CmpFacts> {
    return extract(await open(file), null, 'first-screen');
  }

  async function detectAndMeasure(file: string) {
    const page = await open(file);
    const detection = await detectCmp(page);
    return { ...detection, facts: await extract(page, null, 'first-screen') };
  }

  const buttonKinds = (facts: CmpFacts) => facts.firstLayer.buttons.map((b) => b.kind).sort();

  describe('where the unknown banner sits', () => {
    it('main document: fixed bar with consent wording → heuristic facts, banner-not-recognized', async () => {
      const { adapter, detection, facts } = await detectAndMeasure('');
      expect(adapter).toBeNull();
      expect(detection.method).toBe('heuristic');
      expect(detection.recognitionConfidence).not.toBe('high');
      expect(detection.signals).toContain('heuristic:fixed');
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'settings']);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('banner-not-recognized');
      expect(cls.reasons).toEqual(['heuristic-only']);
      expect(cls.targets).toEqual({ reject: null, accept: null });
    });

    it('open shadow DOM: modal dialog found through the shadow root', async () => {
      const facts = await measure('shadow.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain('heuristic:dialog');
      expect(facts.firstLayer.buttons.filter((b) => !b.inShadowDom).map((b) => b.name)).toEqual([]);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
    });

    it('cross-origin iframe: banner body inside the frame, geometry offset to the main viewport', async () => {
      const facts = await measure('iframe.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.frameUrl).toBe('https://consent.unknown-cmp.test/banner.html');
      const accept = facts.firstLayer.buttons.find((b) => b.kind === 'accept');
      expect(accept?.box?.y).toBeGreaterThan(768 - 180 - 1);
      expect(facts.firstLayer.containerFixed).toBe(true);
    });

    it('no banner → method none, and the heuristic saw no candidate', async () => {
      const { detection, facts } = await detectAndMeasure('none.html');
      expect(detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toBeNull();
      expect(classifyFirstLayer(facts, lexicon).reasons).toEqual(['no-banner-detected']);
    });
  });

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
      const { adapter, detection, facts } = await detectAndMeasure('fi-banner.html');
      expect(adapter).toBeNull();
      expect(detection.method).toBe('heuristic');
      expect(detection.signals).toContain('heuristic:fixed');
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
      const { detection, facts } = await detectAndMeasure('policy-text.html');
      expect(detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });
  });

  describe('page chrome is not a banner, and "covers the footer" is a measured overlap', () => {
    it('fixed side menu inside <nav> with privacy words and many links → nothing recognized, footer not covered', async () => {
      const { detection, facts } = await detectAndMeasure('docs-nav.html');
      expect(detection.method).toBe('none');
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

    it.each([
      ['fixed bar in the footer', 'bar-in-footer.html', 'fixed'],
      ['static region in the header', 'region-in-header.html', 'static'],
    ])('a %s is found with accept and reject', async (_name, file, signal) => {
      const facts = await measure(file);
      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toContain(`heuristic:${signal}`);
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
      if (signal === 'fixed')
        expect(classifyFirstLayer(facts, lexicon).variant).toBe('banner-not-recognized');
    });

    it('counterexample: a fixed footer strip "Impressum · Datenschutz · Cookie-Einstellungen" (settings link, no accept/reject) is no banner', async () => {
      const { detection, facts } = await detectAndMeasure('footer-link-strip.html');
      expect(detection.method).toBe('none');
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
      ['a shipping notice with "Verstanden"', 'one-keyword-acknowledge-shipping.html', ['other'], false],
      ['a policy update with "OK"', 'one-keyword-acknowledge-policy.html', ['other'], false],
      [
        'a discount box with "Mehr Informationen"',
        'one-keyword-newsletter-details.html',
        ['settings', 'other'],
        false,
      ],
      ['a chat teaser with "Details"', 'one-keyword-chat-details.html', ['settings', 'other'], false],
      ['a newsletter box with a paid accept', 'one-keyword-newsletter.html', ['other'], undefined],
      ['a chat box with "Chat starten" and a close button', 'one-keyword-chat.html', ['other'], undefined],
    ] as const)(
      '%s remains a candidate, without a recognized banner',
      async (_name, file, controls, cookieWording) => {
        const facts = await measure(file);
        expect(facts.detection.method).toBe('none');
        expect(facts.firstLayer.bannerPresent).toBe(false);
        expect(facts.firstLayer.bannerCandidate).toMatchObject({
          reason: 'keywords',
          controls,
          ...(cookieWording === undefined ? {} : { cookieWording }),
        });
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

    it('wording hidden from screen readers but shown on screen counts: a fixed bar with an aria-hidden description is found', async () => {
      const facts = await measure('aria-hidden-text.html');

      expect(facts.detection.method).toBe('heuristic');
      const hits = facts.detection.signals.find((s) => s.startsWith('heuristic:keywords:'));
      expect(Number(hits?.split(':')[2])).toBeGreaterThanOrEqual(2);
      expect(buttonKinds(facts)).toEqual(['accept', 'settings']);
    });
  });

  describe('what the visitor sees decides, not the markup around it', () => {
    it('counterexample: a discount dialog with one keyword ("Datenschutz") and "Mehr Informationen" → no banner, the candidate is kept', async () => {
      const facts = await measure('one-keyword-newsletter-dialog.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toMatchObject({
        reason: 'keywords',
        controls: ['settings', 'other'],
        cookieWording: false,
        dialog: true,
      });
    });

    it('a dialog with the cookie keyword and only a close button is found', async () => {
      const facts = await measure('one-keyword-cookie-dialog-close.html');

      expect(facts.detection.method).toBe('heuristic');
      expect(facts.detection.signals).toEqual(
        expect.arrayContaining(['heuristic:dialog', 'heuristic:keywords:1']),
      );
    });

    it.each([
      ['inside a container with role contentinfo', 'bar-in-contentinfo.html'],
      ['as landmark (aside)', 'banner-in-landmark.html?as=aside'],
      ['as landmark (complementary)', 'banner-in-landmark.html?as=complementary'],
      ['as landmark (banner)', 'banner-in-landmark.html?as=banner'],
      ['as landmark (dialog-in-nav)', 'banner-in-landmark.html?as=dialog-in-nav'],
      ['after more elements than the scan reads in document order', 'banner-after-long-body.html'],
      [
        'floating one line high above the bottom edge, after more elements than the scan reads',
        'floating-banner-after-long-body.html',
      ],
      ['whose control has a text blob as aria-label (counted by its visible label)', 'long-aria-label.html'],
    ])('a fixed cookie bar with reject and accept %s is found', async (_name, file) => {
      const facts = await measure(file);

      expect(facts.detection.method).toBe('heuristic');
      expect(buttonKinds(facts)).toEqual(['accept', 'reject']);
    });

    it('counterexample: a fixed aside with privacy links only is page chrome, no banner and no candidate', async () => {
      const facts = await measure('banner-in-landmark.html?as=links-in-aside');

      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toBeNull();
    });

    it.each([
      ['a collapsed box', 'collapsed'],
      ['a closed <details>', 'details'],
      ['a shift out of the clipping banner', 'translated'],
    ])(
      'a banner whose hidden second layer (%s) holds more text than a banner shows is found',
      async (_name, list) => {
        const facts = await measure(`banner-with-vendor-list.html?list=${list}`);

        expect(facts.detection.method).toBe('heuristic');
        expect(facts.detection.signals).toContain('heuristic:keywords:2');
      },
    );

    it('control: a fixed bar with the cookie keyword, accept and reject, shown, is found', async () => {
      const facts = await measure('hidden-banner.html?hide=none');

      expect(facts.detection.method).toBe('heuristic');
    });

    it.each([
      ['clipped away', 'clip-path'],
      ['behind the opaque page', 'behind'],
      ['a 1 px dialog clipped for screen readers', 'sr-only-dialog'],
    ])('counterexample: the same bar %s is no banner', async (_name, hide) => {
      const facts = await measure(`hidden-banner.html?hide=${hide}`);

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });

    it('counterexample: a notice that no cookies are used, with "OK", is no banner and names no cookies', async () => {
      const facts = await measure('no-cookies-notice.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerCandidate).toMatchObject({ reason: 'keywords', cookieWording: false });
    });
  });

  describe('a dismissed candidate inside a child frame', () => {
    const frameBar = {
      reason: 'keywords',
      keywordHits: 1,
      controls: ['settings'],
      cookieWording: true,
      fixed: true,
      dialog: false,
      named: false,
    };

    const framePage = (query = '') =>
      measure(query ? `frame-one-keyword.html?${query}` : 'frame-one-keyword.html');
    const acceptFrame = (query = '') => framePage(query ? `bar=accept&${query}` : 'bar=accept');
    const visibleFrames = [
      ['a 200 px iframe at the bottom', ''],
      ['an iframe partly above the first screen, with its bar showing', 'frame=partly-above'],
      ['a 200 px top strip filled by an inner iframe', 'frame=top-strip&nested=1'],
      ['an iframe scaled to half', 'frame=scaled-half'],
      ['an iframe zoomed to half', 'frame=zoomed-half'],
      ['an iframe filling an iframe scaled to half', 'frame=scaled-half&nested=1'],
    ] as const;

    it.each([...visibleFrames, ['an iframe inside the bottom iframe', 'nested=1'] as const])(
      '%s with a settings button stays a candidate',
      async (_name, query) => {
        const facts = await framePage(query);
        expect(facts.detection.method).toBe('none');
        expect(facts.firstLayer.bannerPresent).toBe(false);
        expect(facts.firstLayer.consentFrameUnresolved ?? false).toBe(false);
        expect(facts.firstLayer.bannerCandidate).toEqual(frameBar);
      },
    );

    it('the frame candidate most like a banner outranks a notice of the main page without a lexicon control', async () => {
      const facts = await measure('frame-one-keyword-and-page-notice.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerCandidate).toEqual(frameBar);
    });

    const hiddenFrames = [
      ['display: none', 'display-none'],
      ['zero size', 'zero-size'],
      ['visibility: hidden', 'visibility-hidden'],
      ['opacity: 0', 'opacity-zero'],
      ['below the first screen', 'below-first-screen'],
      ['hidden around a nested iframe', 'visibility-hidden&nested=1'],
      ['with only its top on the first screen', 'partly-below'],
      ['in a top strip around a taller nested iframe', 'top-strip&nested=tall'],
      ['scaled to twice its size', 'scaled-double'],
      ['scaled to twice its size around a nested iframe', 'scaled-double&nested=1'],
    ] as const;

    it.each(hiddenFrames)('counterexample: the iframe with %s is no candidate', async (_name, query) => {
      const facts = await framePage(`frame=${query}`);
      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toBeNull();
    });

    it.each([
      ...visibleFrames,
      ['an iframe filling an iframe zoomed to half', 'frame=zoomed-half&nested=1'] as const,
    ])('%s with an accept button is recognized as a banner', async (_name, query) => {
      const { detection } = await acceptFrame(query);
      expect(detection.method).toBe('heuristic');
      expect(detection.signals).toContain('heuristic:frame');
    });

    it.each([
      ['scaled to half', 'scaled-half'],
      ['zoomed to half', 'zoomed-half'],
      ['scaled to half, in an iframe filling it', 'scaled-half&nested=1'],
      ['zoomed to half, in an iframe filling it', 'zoomed-half&nested=1'],
    ])(
      'the accept button of the iframe %s is reported where the main page shows it, at half its size',
      async (_name, frame) => {
        const unscaled = (await acceptFrame()).firstLayer.buttons[0]?.box;
        const facts = await acceptFrame(`frame=${frame}`);
        const box = facts.firstLayer.buttons[0]?.box;

        if (!box || !unscaled) throw new Error('the accept button has no box');
        expect(box.y).toBeGreaterThan(facts.viewport.height / 2);
        expect(box.y + box.height).toBeLessThanOrEqual(facts.viewport.height);
        expect(box.x).toBeCloseTo(unscaled.x / 2, -1);
        expect(box.width).toBeCloseTo(unscaled.width / 2, -1);
        expect(box.height).toBeCloseTo(unscaled.height / 2, -1);
      },
    );

    it('the accept button of an iframe filling a bordered and padded iframe is reported where the main page shows it', async () => {
      const outer = (await acceptFrame('frame=bordered')).firstLayer.buttons[0]?.box;
      const facts = await acceptFrame('frame=bordered&nested=1');
      const box = facts.firstLayer.buttons[0]?.box;

      if (!box || !outer) throw new Error('the accept button has no box');
      // The bar of the outer iframe and that of the iframe filling it show at the same place, inside border and padding.
      expect(outer.x).toBeGreaterThanOrEqual(30);
      expect(box).toEqual(outer);
    });

    it.each(hiddenFrames.filter(([, query]) => query !== 'display-none' && query !== 'zero-size'))(
      'counterexample: the iframe with an accept button and %s is no banner',
      async (_name, query) => {
        const facts = await acceptFrame(`frame=${query}`);
        expect(facts.detection.method).toBe('none');
        expect(facts.firstLayer.bannerPresent).toBe(false);
      },
    );

    it('counterexample: an embedded newsletter form with two keywords and a submit button is no banner', async () => {
      const facts = await measure('frame-newsletter-form.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
    });

    it('counterexample: a video player iframe with a "Datenschutz" link and player settings but no cookie wording → a candidate that is not banner-like', async () => {
      const facts = await measure('frame-video-player.html');

      expect(facts.detection.method).toBe('none');
      expect(facts.firstLayer.bannerPresent).toBe(false);
      expect(facts.firstLayer.bannerCandidate).toEqual({
        ...frameBar,
        controls: ['settings', 'other'],
        cookieWording: false,
      });
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
