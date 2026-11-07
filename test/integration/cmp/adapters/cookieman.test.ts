/** cookieman (TYPO3) adapter against the own simulator, including its `CookieConsent` cookie shared with Cookiebot. */
import { describe, expect, it } from 'vitest';
import { detectCmp, extract, loadLexicon } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { decideAndAct, describeCmpScenarios, recognized, requestsSince, useCmpServer } from '../helpers.ts';

const SITE = 'https://www.cookieman.test';
const TRACKER = 'stats.cookieman.test';

describeCmpScenarios(
  {
    id: 'cookieman',
    site: 'cmp/cookieman',
    okUrl: `${SITE}/`,
    blockingUrl: `${SITE}/blocking.html`,
    version: null,
    rejectName: /^Deny all cookies$/,
    acceptName: /^Accept all cookies$/,
  },
  (env) => {
    it('groups from the site configuration: the fixed group is left out, marketing denied, then stored', async () => {
      const since = Date.now();
      const { page, adapter } = await env.openRecognized(`${SITE}/`, 'cookieman', { banner: true });
      expect(await adapter.state(page)).toEqual([
        {
          source: 'api',
          ready: 'ready',
          categories: { marketing: 'denied' },
          origin: 'default',
          decision: { responded: false, method: 'unknown' },
        },
      ]);

      expect((await decideAndAct(page, adapter, 'reject')).click.clicked).toBe(true);
      await page.reload({ waitUntil: 'load' });

      expect(await adapter.state(page)).toEqual([
        {
          source: 'api',
          ready: 'ready',
          categories: { marketing: 'denied' },
          origin: 'stored',
          decision: { responded: true, method: 'explicit' },
        },
      ]);
      // After the answer the `CookieConsent` cookie also gives Cookiebot a signal; cookieman still wins.
      expect(await recognized(page, 'cookieman')).toBe(adapter);
      expect(requestsSince(env.server, TRACKER, since)).toBe(0);
    });

    it('accept grants marketing and loads the local tracker', async () => {
      const since = Date.now();
      const { page, adapter } = await env.openRecognized(`${SITE}/`, 'cookieman', { banner: true });

      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);

      expect((await adapter.state(page))[0]?.categories).toEqual({ marketing: 'granted' });
      await expect.poll(() => requestsSince(env.server, TRACKER, since)).toBeGreaterThan(0);
    });

    it('never stores the cookie value: only one boolean per group leaves the page', async () => {
      const { page, adapter } = await env.openRecognized(`${SITE}/`, 'cookieman', { banner: true });
      expect((await decideAndAct(page, adapter, 'accept')).click.clicked).toBe(true);

      const facts = await adapter.extract(page, 'after-click');

      expect(JSON.stringify(facts)).not.toMatch(/mandatory(\||%7C)marketing/i);
    });

    it('deny and accept also carry data-cookieman-save, yet they are reject and accept; save stays hidden', async () => {
      const { page, adapter } = await env.openRecognized(`${SITE}/de.html`, 'cookieman', { banner: true });

      const facts = await extract(page, adapter, 'first-screen');

      const first = facts.firstLayer.buttons.filter((b) => b.layer === 1);
      expect(first.map((b) => [b.name, b.kind, b.vendorRole ?? null])).toEqual([
        ['Datenschutzerklärung', 'link', null],
        ['Impressum', 'link', null],
        ['Einstellungen', 'settings', 'settings'],
        ['Alle Cookies ablehnen', 'reject', 'reject'],
        ['Alle Cookies akzeptieren', 'accept', 'accept'],
      ]);
      expect(facts.firstLayer.buttons.find((b) => b.vendorRole === 'save')).toMatchObject({
        name: 'Speichern',
        layer: 2,
      });
      expect(facts.blocking.overlay).toBe(true);
      const cls = classifyFirstLayer(facts, loadLexicon());
      expect(cls.variant).toBe('ok');
      expect(cls.targets?.reject?.name).toBe('Alle Cookies ablehnen');
    });
  },
);

describe('cookieman and the CookieConsent cookie of Cookiebot', () => {
  const env = useCmpServer(['cmp/cookieman']);

  it('the cookieman markup outranks a Cookiebot signal that is only the CookieConsent cookie', async () => {
    const { page } = await env.open(`${SITE}/markup-only.html`);

    const { adapter, detection } = await detectCmp(page);

    expect(adapter?.id).toBe('cookieman');
    expect(detection).toMatchObject({ recognitionConfidence: 'medium', signals: ['dom:#cookieman-modal'] });
  });

  it('counterexample: a CookieConsent cookie without cookieman is no cookieman', async () => {
    const { page } = await env.open(`${SITE}/cookie-only.html`);

    const { adapter, detection } = await detectCmp(page);

    expect(adapter?.id).not.toBe('cookieman');
    expect(detection.cmpId).not.toBe('cookieman');
    expect(detection.recognitionConfidence).not.toBe('high');
  });
});
