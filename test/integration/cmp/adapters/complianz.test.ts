/**
 * Complianz adapter against the own simulator (close button is not a reject; the plugin's object and the buttons filled
 * with data by the page).
 */
import { expect, it } from 'vitest';
import { extract, loadLexicon } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { decideAndAct, describeCmpScenarios, recognized } from '../helpers.ts';

describeCmpScenarios(
  {
    id: 'complianz',
    site: 'cmp/complianz',
    okUrl: 'https://www.complianz.test/',
    blockingUrl: 'https://www.complianz.test/blocking.html',
    version: '7.1.0',
    rejectName: /^Ablehnen$/,
    acceptName: /^Akzeptieren$/,
  },
  (env) => {
    it('the × button is measured as close, not as reject; region and consent type are config facts', async () => {
      const { page } = await env.open('https://www.complianz.test/blocking.html');
      const adapter = await recognized(page, 'complianz');
      const facts = await extract(page, adapter, 'first-screen');
      const close = facts.firstLayer.buttons.find((b) => b.vendorRole === 'close');
      expect(close).toMatchObject({ name: 'Dialog schließen', kind: 'close' });
      expect(facts.config).toMatchObject({ 'complianz.region': 'eu', 'complianz.consenttype': 'optin' });
      expect(facts.geoSignals).toEqual([]);
    });

    it('a region, consent type and version the page filled with data are stored as the plugin values they are not', async () => {
      const { page } = await env.open('https://www.complianz.test/hostile-config.html');
      const adapter = await recognized(page, 'complianz');
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.geoSignals).toEqual([{ cmpId: 'complianz', signal: 'complianz:region=other' }]);
      expect(facts.config).toEqual({
        'complianz.region': 'other',
        'complianz.consenttype': 'other',
        'complianz.version': null,
      });
      // Outside `eu` the plugin shows no banner: its special branch, as for any other region.
      expect(facts.state.every((s) => s.origin === 'special-branch')).toBe(true);
      expect(facts.detection.version).toBe('7.1.0');
      expect(JSON.stringify(facts)).not.toContain('zq7');
    });

    it('buttons the page marked up with data keep their own class selectors, and the reject still verifies', async () => {
      const { page } = await env.open('https://www.complianz.test/hostile-markup.html');
      const adapter = await recognized(page, 'complianz');
      const { facts, click } = await decideAndAct(page, adapter, 'reject');
      const deny = facts.firstLayer.buttons.find((b) => b.name === 'Ablehnen');
      expect(deny).toMatchObject({ role: 'button', selector: 'button.cmplz-btn.cmplz-deny', kind: 'reject' });
      expect(facts.firstLayer.buttons.find((b) => b.name === 'Akzeptieren')?.selector).toBe(
        'button.cmplz-btn.cmplz-accept',
      );
      expect(facts.config['complianz.consenttype']).toBe('other');
      expect(click).toMatchObject({ clicked: true, button: { role: 'button' } });
      expect((await adapter.verify(page, 'reject')).verified).toBe(true);
      const text = JSON.stringify({ facts, click });
      expect(text).not.toContain('zq7');
      expect(text).not.toContain('9f86d081884c7d659a2feaa0c55ad015');
      expect(text).not.toContain('5f4dcc3b5aa765d61d8327deb882cf99');
    });

    it('counterexample: a container whose own box is all that shows of a closed banner is no shown banner', async () => {
      const { page } = await env.open('https://www.complianz.test/closed-in-padded-container.html');
      const adapter = await recognized(page, 'complianz');

      const facts = await extract(page, adapter, 'first-screen');

      expect(facts.firstLayer).toMatchObject({
        bannerPresent: true,
        bannerVisible: false,
        containerBox: null,
      });
      expect(classifyFirstLayer(facts, loadLexicon())).toMatchObject({
        variant: 'banner-not-recognized',
        reasons: ['banner-not-visible'],
      });
    });
  },
);
