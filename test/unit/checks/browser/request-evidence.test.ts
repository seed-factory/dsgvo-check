/**
 * `request` evidence follows specification 5.3 : independent `delivery` / `result` /
 * `provenance`, one monotonic `tMs` from the scan start, navigation/action/frame/parent ids and the versioned safe
 * `features` (identifier kind, stored-identifier match, event type, Consent Mode signal). No legacy relative times.
 */
import { describe, expect, it } from 'vitest';
import { cookieEvidence, requestEvidence, storageEvidence } from '../../../../src/checks/browser/shared.ts';
import { EvidenceSchema } from '../../../../src/core/report-schema.ts';
import type { ClassifiedRequest } from '../../../../src/derive/types.ts';
import { makeCookie, makeRequest, makeStorage } from '../../../utils/snapshot-builder.ts';

const ga4Hit = makeRequest({
  id: 'B-0042',
  phase: 'B',
  url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&cid=[redacted]&en=page_view',
  resourceType: 'ping',
  method: 'POST',
  tStartMs: 120,
  tRef: 'click',
  afterClick: true,
  atMs: 41_230,
  navigationId: 'B-n1',
  actionId: 'B-a1',
  frameId: 'B-f1',
  parentRequestId: 'B-0041',
  state: 'failed',
  status: 204,
  failureText: 'net::ERR_ABORTED',
  delivery: 'sent',
  result: { kind: 'response', status: 204 },
  provenance: 'network',
  identifierPresent: true,
  identifierNames: ['cid'],
  matchesStoredIdentifier: true,
  eventType: 'page_view',
  consentSignals: { gcs: 'G100', gcd: '13l3l3l3l1' },
  parserVersion: 'request-features/2',
  observationSource: 'playwright',
});

const classified: ClassifiedRequest = {
  requestId: 'B-0042',
  phase: 'B',
  host: 'www.google-analytics.com',
  etld1: 'google-analytics.com',
  thirdParty: true,
  firstPartyProxy: false,
  serviceId: 'google-analytics-4',
  category: 'analytics',
  source: 'catalog',
  identifier: true,
  identifierKind: 'stored-match',
  identifierParam: 'cid',
  consentMode: { adStorage: 'denied', analyticsStorage: 'denied', source: 'gcs' },
  cookieless: true,
};

describe('requestEvidence (5.3)', () => {
  it('carries delivery/result/provenance, the scan-scale tMs, the ids and the safe features', () => {
    const ev = requestEvidence(ga4Hit, classified);
    expect(ev).toEqual({
      type: 'request',
      url: ga4Hit.url,
      method: 'POST',
      resourceType: 'ping',
      phase: 'B',
      page: 'https://www.example.de/',
      tMs: 41_230,
      navigationId: 'B-n1',
      actionId: 'B-a1',
      frameId: 'B-f1',
      parentRequestId: 'B-0041',
      delivery: 'sent',
      result: { kind: 'response', status: 204 },
      provenance: 'network',
      features: {
        identifier: { kind: 'stored-match', param: 'cid' },
        matchesStoredIdentifier: true,
        eventType: 'page_view',
        consentSignal: { gcs: 'G100', gcd: '13l3l3l3l1', adStorage: 'denied', analyticsStorage: 'denied' },
        parserVersion: 'request-features/2',
        observationSource: 'playwright',
      },
      thirdPartyETLD1: 'google-analytics.com',
      serviceId: 'google-analytics-4',
    });
    // Times relative to navigation/click are computed from the ids, not stored (5.3).
    for (const legacy of ['state', 'status', 'tStartMs', 'tRef', 'identifierPresent'])
      expect(ev).not.toHaveProperty(legacy);
    expect(EvidenceSchema.safeParse({ id: 'ev-1', ...ev }).success).toBe(true);
  });

  it('a record from an older snapshot: delivery/result from the legacy state, parser version 1', () => {
    const old = makeRequest({
      url: 'https://cdn.example.net/lib.js',
      state: 'completed',
      status: 200,
      identifierPresent: false,
    });
    const ev = requestEvidence(old, null);
    expect(ev).toMatchObject({
      delivery: 'sent',
      result: { kind: 'response', status: 200 },
      features: {
        identifier: { kind: 'none' },
        matchesStoredIdentifier: false,
        parserVersion: 'request-features/1',
        observationSource: 'playwright',
      },
      thirdPartyETLD1: null,
    });
    expect(ev).not.toHaveProperty('tMs');
    const blocked = requestEvidence(
      makeRequest({ url: 'https://x.example.net/', state: 'blocked-by-browser', status: undefined }),
      null,
    );
    expect(blocked).toMatchObject({ delivery: 'blocked-by-browser', result: { kind: 'none' } });
    const failed = requestEvidence(
      makeRequest({
        url: 'https://x.example.net/',
        state: 'failed',
        status: undefined,
        failureText: 'net::ERR_CONNECTION_REFUSED',
      }),
      null,
    );
    expect(failed).toMatchObject({
      delivery: 'attempted',
      result: { kind: 'failed', errorText: 'net::ERR_CONNECTION_REFUSED' },
    });
  });

  it('the same request gives the same evidence in every check (one network fact, one evidence id)', () => {
    const firstParty: ClassifiedRequest = { ...classified, thirdParty: false };
    expect(requestEvidence(ga4Hit, classified)).toEqual(requestEvidence(ga4Hit, { ...classified }));
    expect(requestEvidence(ga4Hit, firstParty)).toMatchObject({ thirdPartyETLD1: null });
  });

  it('the schema requires delivery, result and features for request evidence', () => {
    const ev = { id: 'ev-1', ...requestEvidence(ga4Hit, classified) } as Record<string, unknown>;
    for (const field of ['delivery', 'result', 'features']) {
      const { [field]: _dropped, ...rest } = ev;
      expect(EvidenceSchema.safeParse(rest).success, field).toBe(false);
    }
  });
});

describe('cookie and storage evidence on the same time scale (5.3)', () => {
  it('tMs is the scan-scale atMs with navigation/action ids; the legacy relative tMs is not exported', () => {
    const c = cookieEvidence(
      makeCookie({ name: '_ga', tMs: 15, atMs: 41_300, navigationId: 'B-n1', actionId: 'B-a1' }),
    );
    expect(c).toMatchObject({ tMs: 41_300, navigationId: 'B-n1', actionId: 'B-a1' });
    expect(cookieEvidence(makeCookie({ name: '_ga', tMs: 15 }))).not.toHaveProperty('tMs');
    const s = storageEvidence(makeStorage({ key: 'k', tMs: 15, atMs: 9_000, navigationId: 'A-n2' }));
    expect(s).toMatchObject({ tMs: 9_000, navigationId: 'A-n2' });
    expect(EvidenceSchema.safeParse({ id: 'ev-c', ...c }).success).toBe(true);
    expect(EvidenceSchema.safeParse({ id: 'ev-s', ...s }).success).toBe(true);
  });
});
