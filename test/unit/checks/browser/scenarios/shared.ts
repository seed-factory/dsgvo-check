import type { Snapshot } from '../../../../../src/core/snapshot.ts';
import type { FixtureExpect } from '../../../../utils/snapshot-builder.ts';
import { req } from '../helpers.ts';

export const ORIGIN_IMG = 'https://www.example.de/wp-content/uploads';

export interface Scenario {
  file: string;
  description: string;
  expect: FixtureExpect;
  build: () => Snapshot;
}

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
