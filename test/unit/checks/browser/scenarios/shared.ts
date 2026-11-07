import { BOT_USER_AGENT_SIGNAL, type BotSignal } from '../../../../../src/cmp/types.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import type { FixtureExpect } from '../../../../utils/snapshot-builder.ts';
import { req } from '../helpers.ts';

export const ORIGIN_IMG = 'https://www.example.de/wp-content/uploads';

export interface Scenario {
  file: string;
  description: string;
  expect: FixtureExpect;
  build: () => Snapshot;
}

/** The bot signal of a CMP whose own crawler test matched the scanner's User-Agent and so kept its dialog closed. */
export const crawlerTestSignal: BotSignal = {
  cmpId: 'ccm19',
  signal: BOT_USER_AGENT_SIGNAL,
  detail: 'CCM19 isBotBrowser (app.js)',
};

export const ga = {
  lib: (id: string, p = {}) => req(id, 'https://www.googletagmanager.com/gtag/js?id=G-TEST1', p),
  /** GA4 page_view whose non-empty `cid` (catalog identifier param) was seen by the collector before redaction. */
  hit: (id: string, p = {}) =>
    req(id, 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1&cid=[redacted]&en=page_view', {
      resourceType: 'ping',
      identifierPresent: true,
      identifierNames: ['cid'],
      eventType: 'page_view',
      ...p,
    }),
};
