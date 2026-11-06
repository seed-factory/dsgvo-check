/** Complianz adapter against the own simulator (close button is not a reject). */
import { expect, it } from 'vitest';
import { extract, loadLexicon } from '../../../../src/cmp/index.ts';
import { classifyFirstLayer } from '../../../utils/classify.ts';
import { describeCmpScenarios, recognized } from '../helpers.ts';

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
