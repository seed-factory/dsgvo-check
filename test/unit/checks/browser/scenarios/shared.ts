import { BOT_USER_AGENT_SIGNAL, type BotSignal, type CmpSection } from '../../../../../src/cmp/types.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import type { FixtureExpect } from '../../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, req } from '../helpers.ts';

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

/** Reject confirmed by state: changed by our click (`action`), then read back after the reload. */
export const confirmedReject = (): CmpSection => {
  const denied = {
    source: 'api',
    ready: 'ready',
    categories: { statistics: 'denied', marketing: 'denied' },
    decision: { responded: true, method: 'explicit' },
  } as const;
  return cmpWith({
    phase: 'B',
    facts: [cmpFacts(), cmpFacts({ moment: 'after-reload', state: [{ ...denied, origin: 'stored' }] })],
    click: {
      action: 'reject',
      clicked: true,
      button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
    },
    verify: {
      action: 'reject',
      verified: true,
      method: ['api:all-denied', 'persisted-after-reload'],
      stateAfter: [{ ...denied, origin: 'action' }],
      persistedAfterReload: true,
    },
  });
};
