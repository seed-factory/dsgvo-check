/**
 * `request` evidence: independent `delivery` / `result` / `provenance`, one monotonic `tMs` from the scan start,
 * navigation/action/frame/parent ids and the versioned safe `features`. No legacy relative times.
 */
import { describe, expect, it } from 'vitest';
import {
  cookieEvidence,
  distinctRequestEvidence,
  MAX_EVIDENCE,
  requestEvidence,
  requestEvidenceByMoment,
  requestEvidencePerContext,
  storageEvidence,
} from '../../../../src/checks/browser/evidence.ts';
import { EvidenceSchema } from '../../../../src/core/report/schema.ts';
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
    // Times relative to navigation/click are computed from the ids, not stored.
    for (const legacy of ['state', 'status', 'tStartMs', 'tRef', 'identifierPresent'])
      expect(ev).not.toHaveProperty(legacy);
    expect(() => EvidenceSchema.parse({ id: 'ev-1', ...ev })).not.toThrow();
  });

  it('marks what phase B or C recorded before its click: the first screen, before the reject or the accept', () => {
    const before = { ...ga4Hit, afterClick: false, actionId: undefined };
    expect(requestEvidence(before, null)).toMatchObject({ phase: 'B', beforeClick: true });
    expect(requestEvidence(ga4Hit, null)).not.toHaveProperty('beforeClick');
    expect(requestEvidence({ ...before, phase: 'A' }, null)).not.toHaveProperty('beforeClick');
    expect(cookieEvidence(makeCookie({ name: '_ga', phase: 'C', afterClick: false }))).toMatchObject({
      beforeClick: true,
    });
    expect(storageEvidence(makeStorage({ key: 'k', phase: 'B', afterClick: true }))).not.toHaveProperty(
      'beforeClick',
    );
    expect(EvidenceSchema.safeParse({ id: 'ev-1', ...requestEvidence(before, null) }).success).toBe(true);
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
    expect(() => EvidenceSchema.parse({ id: 'ev-c', ...c })).not.toThrow();
    expect(() => EvidenceSchema.parse({ id: 'ev-s', ...s })).not.toThrow();
  });
});

describe('distinctRequestEvidence', () => {
  const lib = (id: string, pageUrl: string, p = {}) =>
    makeRequest({
      id,
      url: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST',
      pageUrl,
      navigationId: `${id}-n`,
      atMs: Number(id.length) * 100,
      ...p,
    });
  const hit = (id: string, pageUrl: string) =>
    makeRequest({
      id,
      url: 'https://www.google.com/ccm/collect?frm=[redacted]',
      pageUrl,
      resourceType: 'ping',
    });

  it('a request repeated on several pages is one item; the order of first occurrence is kept', () => {
    const items = [
      { r: lib('a', 'https://www.example.de/'), c: null },
      { r: hit('b', 'https://www.example.de/'), c: null },
      { r: lib('cc', 'https://www.example.de/kontakt'), c: null },
      { r: hit('ddd', 'https://www.example.de/kontakt'), c: null },
      { r: lib('eeee', 'https://www.example.de/impressum', { phase: 'B' }), c: null },
    ];
    const ev = distinctRequestEvidence(items);
    expect(ev.map((e) => [(e as { url: string }).url, (e as { page: string }).page])).toEqual([
      ['https://www.googletagmanager.com/gtm.js?id=GTM-TEST', 'https://www.example.de/'],
      ['https://www.google.com/ccm/collect?frm=[redacted]', 'https://www.example.de/'],
    ]);
  });

  it('counterexample: the same URL with another result or inside an embedded frame stays a separate item', () => {
    const ev = distinctRequestEvidence([
      { r: lib('a', 'https://www.example.de/'), c: null },
      {
        r: lib('b', 'https://www.example.de/', { status: 304, result: { kind: 'response', status: 304 } }),
        c: null,
      },
      { r: lib('c', 'https://www.example.de/', { frameUrl: 'https://maps.example/embed' }), c: null },
    ]);
    expect(ev).toHaveLength(3);
  });

  it('stops at the cap', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      r: makeRequest({ id: `x${i}`, url: `https://cdn.example/${i}.js` }),
      c: null,
    }));
    expect(distinctRequestEvidence(items)).toHaveLength(10);
    expect(distinctRequestEvidence(items, 3)).toHaveLength(3);
  });
});

describe('requestEvidenceByMoment', () => {
  const KONTAKT = 'https://www.example.test/kontakt/';
  const tile = (i: number) => `https://maps.googleapis.com/maps/vt?pb=[redacted]&tile=${i}`;
  const tileBefore = (i: number) => ({
    r: makeRequest({ id: `A-${i}`, url: tile(i), pageUrl: KONTAKT, resourceType: 'image' }),
    c: { timing: 'before-interaction' } as ClassifiedRequest,
  });
  const tileAfterReject = (i: number, p = {}) => ({
    r: makeRequest({
      id: `B-${i}`,
      phase: 'B',
      url: tile(i),
      pageUrl: KONTAKT,
      resourceType: 'image',
      afterClick: true,
      ...p,
    }),
    c: { timing: 'after-reject' } as ClassifiedRequest,
  });
  const afterClickItems = (ev: ReturnType<typeof requestEvidenceByMoment>) =>
    ev.filter((e) => e.type === 'request' && e.phase === 'B' && !('beforeClick' in e));
  const twelve = Array.from({ length: 12 }, (_, i) => i);

  it('keeps places for requests after the reject when the same URLs already filled the cap before it', () => {
    const items = [...twelve.map(tileBefore), ...twelve.map((i) => tileAfterReject(i))];
    // The old helper drops every repeat after the reject: the excerpt then shows phase A only.
    expect(afterClickItems(distinctRequestEvidence(items))).toEqual([]);

    const ev = requestEvidenceByMoment(items);
    expect(ev).toHaveLength(MAX_EVIDENCE);
    expect(afterClickItems(ev)).toHaveLength(3);
    expect(ev.filter((e) => e.type === 'request' && e.phase === 'A')).toHaveLength(MAX_EVIDENCE - 3);
  });

  it('fills the cap with requests after the reject when there are few before it, and the reverse', () => {
    const fewBefore = requestEvidenceByMoment([
      tileBefore(0),
      tileBefore(1),
      ...twelve.map((i) => tileAfterReject(i)),
    ]);
    expect(fewBefore).toHaveLength(MAX_EVIDENCE);
    expect(afterClickItems(fewBefore)).toHaveLength(MAX_EVIDENCE - 2);

    const fewAfter = requestEvidenceByMoment([...twelve.map(tileBefore), tileAfterReject(0)]);
    expect(fewAfter).toHaveLength(MAX_EVIDENCE);
    expect(afterClickItems(fewAfter)).toHaveLength(1);
  });

  it('dedupes inside each moment: a request repeated on other pages after the reject is one item', () => {
    const ev = requestEvidenceByMoment([
      tileBefore(0),
      tileAfterReject(0),
      tileAfterReject(0, { id: 'B-x', pageUrl: 'https://www.example.test/' }),
    ]);
    expect(ev.map((e) => (e.type === 'request' ? [e.phase, e.page] : null))).toEqual([
      ['A', KONTAKT],
      ['B', KONTAKT],
    ]);
  });

  it('counterexample: phase B before its click is the same moment as phase A, not after the reject', () => {
    const beforeClick = {
      r: makeRequest({ id: 'B-0', phase: 'B', url: tile(0), pageUrl: KONTAKT, resourceType: 'image' }),
      c: { timing: 'before-interaction' } as ClassifiedRequest,
    };
    const ev = requestEvidenceByMoment([tileBefore(0), beforeClick]);
    expect(ev).toHaveLength(1);
    expect(afterClickItems(ev)).toEqual([]);
  });

  it('takes the moment from the record when a request has no classification', () => {
    const ev = requestEvidenceByMoment([
      { r: tileBefore(0).r, c: null },
      { r: tileAfterReject(0).r, c: undefined },
    ]);
    expect(afterClickItems(ev)).toHaveLength(1);
  });

  it('keeps the given order and the given cap, and the reserve never exceeds the cap', () => {
    const items = [...twelve.map(tileBefore), ...twelve.map((i) => tileAfterReject(i))];
    const ev = requestEvidenceByMoment(items, { max: 4, reserveAfterReject: 6 });
    expect(ev.map((e) => (e.type === 'request' ? e.phase : null))).toEqual(['B', 'B', 'B', 'B']);
    const two = requestEvidenceByMoment(items, { max: 5, reserveAfterReject: 2 });
    expect(two.map((e) => (e.type === 'request' ? e.phase : null))).toEqual(['A', 'A', 'A', 'B', 'B']);
    expect(requestEvidenceByMoment([], { max: 5 })).toEqual([]);
  });
});

describe('requestEvidencePerContext', () => {
  const font = (id: string, phase: 'A' | 'B' | 'C', pageUrl: string, p = {}) => ({
    r: makeRequest({
      id,
      phase,
      url: 'https://fonts.googleapis.com/css?family=Roboto',
      pageUrl,
      resourceType: 'stylesheet',
      ...p,
    }),
    c: null,
  });
  const START_PAGE = 'https://www.example.test/';
  const KONTAKT = 'https://www.example.test/kontakt/';

  it('gives one representative per (phase, page), the first in the given order', () => {
    const ev = requestEvidencePerContext([
      font('A-1', 'A', START_PAGE),
      font('A-2', 'A', START_PAGE, { url: 'https://fonts.gstatic.com/s/roboto/v1/a.woff2' }),
      font('A-3', 'A', KONTAKT),
      font('B-1', 'B', START_PAGE),
      font('B-2', 'B', START_PAGE, { afterClick: true }),
      font('C-1', 'C', KONTAKT, { afterClick: true }),
    ]);
    expect(ev.map((e) => (e.type === 'request' ? [e.phase, e.page, e.url] : null))).toEqual([
      ['A', START_PAGE, 'https://fonts.googleapis.com/css?family=Roboto'],
      ['A', KONTAKT, 'https://fonts.googleapis.com/css?family=Roboto'],
      ['B', START_PAGE, 'https://fonts.googleapis.com/css?family=Roboto'],
      ['C', KONTAKT, 'https://fonts.googleapis.com/css?family=Roboto'],
    ]);
    // The same evidence a check gets for the request anywhere else.
    expect(ev[0]).toEqual(requestEvidence(font('A-1', 'A', START_PAGE).r, null));
  });

  it('stops at the cap', () => {
    const items = Array.from({ length: 30 }, (_, i) => font(`A-${i}`, 'A', `${START_PAGE}p${i}/`));
    expect(requestEvidencePerContext(items)).toHaveLength(MAX_EVIDENCE);
    expect(requestEvidencePerContext(items, 3)).toHaveLength(3);
  });
});
