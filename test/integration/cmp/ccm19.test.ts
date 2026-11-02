/** : CCM19 adapter against the own simulator (late widget injection). */
import { describeCmpScenarios } from './helpers.ts';

describeCmpScenarios({
  id: 'ccm19',
  site: 'cmp/ccm19',
  okUrl: 'https://www.ccm19.test/',
  blockingUrl: 'https://www.ccm19.test/blocking.html',
  version: null,
  rejectName: /^Ablehnen$/,
  acceptName: /^Alle akzeptieren$/,
});
