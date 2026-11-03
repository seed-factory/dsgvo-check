/** derive: party, first-party proxies, identifiers, Consent Mode, stages, cookie/storage classification. */
import { describe, expect, it } from 'vitest';
import { parseCatalog, ServiceCatalog } from '../../../src/derive/catalog.ts';
import { decodeConsentMode, derive, loadServiceCatalog, timingOf } from '../../../src/derive/index.ts';
import {
  makeBrowser,
  makeCookie,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeStorage,
  makeTarget,
} from '../../utils/snapshot-builder.ts';

const snap = (phases: ReturnType<typeof makePhase>[], target = makeTarget('https://www.example.de/')) =>
  makeSnapshot({ target, browser: makeBrowser({ phases }) });

const req = (url: string, p: Parameters<typeof makeRequest>[0] extends infer T ? Partial<T> : never = {}) =>
  makeRequest({ url, ...p });

describe('derive: requests', () => {
  it('third party is decided by eTLD+1; www and apex are the same party', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://example.de/app.js', { id: 'r1' }),
            req('https://cdn.example.de/a.css', { id: 'r2' }),
            req('https://cdn.other-site.de/x.js', { id: 'r3' }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.thirdParty, r.etld1])).toEqual([
      ['r1', false, 'example.de'],
      ['r2', false, 'example.de'],
      ['r3', true, 'other-site.de'],
    ]);
    expect(d.requests[2]).toMatchObject({ serviceId: null, category: 'unknown', source: 'none' });
    expect(d.firstPartyEtld1s).toEqual(['example.de']);
  });

  it('the input host stays first party when the start page redirects to another domain', () => {
    const target = makeTarget('https://example.de/', 'https://www.example-shop.de/');
    const d = derive(
      snap([makePhase('A', { requests: [req('https://example.de/x.js', { id: 'r1' })] })], target),
    );
    expect(d.requests[0]?.thirdParty).toBe(false);
    expect(d.firstPartyEtld1s).toEqual(['example-shop.de', 'example.de']);
  });

  it('classifies catalog services with kind, stage, identifier and catalog source', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://www.googletagmanager.com/gtag/js?id=G-ABC', { id: 'lib' }),
            req('https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=[redacted]&en=page_view', {
              id: 'hit',
              resourceType: 'ping',
              identifierPresent: true,
              identifierNames: ['cid'],
            }),
          ],
        }),
      ]),
    );
    expect(d.requests[0]).toMatchObject({
      serviceId: 'google-analytics',
      category: 'analytics',
      kind: 'library',
      stage: 'loaded',
      identifier: false,
      signatureId: 'google-analytics:gtag-ga4',
    });
    expect(d.requests[1]).toMatchObject({
      kind: 'hit',
      stage: 'event-sent',
      identifier: true,
      identifierKind: 'persistent-param',
      delivered: true,
    });
    expect(d.catalog['google-analytics']).toMatchObject({
      provider: { name: 'Google Ireland Limited', country: 'IE' },
      parent: { name: 'Google LLC', country: 'US' },
    });
  });

  it('first-party proxy (tag gateway / sGTM) vs self-hosted Matomo', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://www.example.de/metrics/g/collect?v=2&tid=G-1&cid=[redacted]', { id: 'proxy' }),
            req('https://www.example.de/matomo/matomo.php?idsite=1&_id=[redacted]', {
              id: 'matomo',
              identifierPresent: true,
              identifierNames: ['_id'],
            }),
          ],
        }),
      ]),
    );
    expect(d.requests[0]).toMatchObject({
      thirdParty: false,
      firstPartyProxy: true,
      serviceId: 'google-analytics',
    });
    expect(d.requests[1]).toMatchObject({
      thirdParty: false,
      firstPartyProxy: false,
      selfHosted: true,
      serviceId: 'matomo',
      identifier: true,
    });
  });

  it('identifier from the collector: a bare identifierPresent is not persistent; stored match and sent tracking cookie are', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://in.hotjar.com/api/v2/client', { id: 'a', identifierPresent: true }),
            req('https://bat.bing.com/action/0?ti=1', { id: 'b', matchesStoredIdentifier: true }),
            req('https://ad.doubleclick.net/activity', { id: 'c', sentCookieNames: ['IDE'] }),
            req('https://ad.doubleclick.net/activity2', { id: 'd', sentCookieNames: ['test_cookie'] }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.identifier, r.identifierKind])).toEqual([
      [false, 'per-load'],
      [true, 'stored-match'],
      [true, 'stored-match'],
      [false, 'none'],
    ]);
  });

  it('a redacted identifier key in the URL is no evidence; the collector names decide (before redaction)', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            // `cid=` was empty before redaction: identifierPresent false, no names.
            req('https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]', {
              id: 'empty',
              resourceType: 'ping',
            }),
            req('https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]', {
              id: 'cid',
              resourceType: 'ping',
              identifierPresent: true,
              identifierNames: ['cid'],
            }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind])).toEqual([
      ['empty', false, 'none'],
      ['cid', true, 'persistent-param'],
    ]);
    expect(d.requests[1]?.identifierParam).toBe('cid');
  });

  it('identifier kind – stored match, sent tracking cookie, catalog param, user-supplied, per-load, none', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]';
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req(ga, {
              id: 'stored',
              identifierPresent: true,
              identifierNames: ['cid'],
              matchesStoredIdentifier: true,
            }),
            req('https://ad.doubleclick.net/activity', {
              id: 'cookie',
              identifierPresent: true,
              identifierNames: ['IDE'],
              sentCookieNames: ['IDE'],
            }),
            req(ga, { id: 'param', identifierPresent: true, identifierNames: ['cid'] }),
            req('https://www.facebook.com/tr/?id=1', {
              id: 'click',
              identifierPresent: true,
              identifierNames: ['fbclid'],
            }),
            // `uuid` is a generic identifier name, not a catalog identifier param of Hotjar's ingest.
            req('https://in.hotjar.com/api/v2/client', {
              id: 'random',
              identifierPresent: true,
              identifierNames: ['uuid'],
            }),
            req('https://in.hotjar.com/api/v2/client?x=1', { id: 'plain' }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.identifierKind, r.identifier])).toEqual([
      ['stored', 'stored-match', true],
      ['cookie', 'stored-match', true],
      ['param', 'persistent-param', true],
      ['click', 'user-supplied', true],
      ['random', 'per-load', false],
      ['plain', 'none', false],
    ]);
    expect(d.services.find((s) => s.serviceId === 'hotjar')?.identifierSeen).toBe(false);
  });

  it('delivery and response are independent facts – a body error after the response keeps the exchange', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            // Headers 204 received, then the body was aborted: the recorder ends in `failed`.
            req(ga, {
              id: 'aborted-body',
              state: 'failed',
              status: 204,
              delivery: 'sent',
              result: { kind: 'failed', errorText: 'net::ERR_ABORTED' },
              failureText: 'net::ERR_ABORTED',
            }),
            req(ga, {
              id: 'no-response',
              state: 'failed',
              status: undefined,
              delivery: 'attempted',
              result: { kind: 'failed', errorText: 'net::ERR_CONNECTION_RESET' },
            }),
            req(ga, {
              id: 'csp',
              state: 'blocked-by-browser',
              status: undefined,
              delivery: 'blocked-by-browser',
              result: { kind: 'failed', errorText: 'net::ERR_BLOCKED_BY_CLIENT' },
            }),
            req(ga, { id: 'sw', state: 'from-sw', provenance: 'service-worker', fromServiceWorker: true }),
            req(ga, { id: 'ok', delivery: 'sent', result: { kind: 'response', status: 204 } }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.delivered])).toEqual([
      ['aborted-body', true],
      ['no-response', false],
      ['csp', false],
      ['sw', false],
      ['ok', true],
    ]);
    expect(d.services[0]?.stages).toEqual(['event-sent']);
  });

  it('names read from the URL path (before redaction) make a path-form sync a persistent-param when the signature declares them', () => {
    const base = loadServiceCatalog().data;
    const catalog = new ServiceCatalog(
      parseCatalog({
        catalog: base.catalog,
        categories: base.categories,
        allowlist: { version: '1', cookies: {} },
        services: [
          {
            id: 'sync-vendor',
            name: 'Sync Vendor',
            category: 'ads',
            policyRelevance: 'required',
            domains: ['sync-vendor.example'],
            signatures: [
              {
                id: 'sync',
                hosts: ['dpm.sync-vendor.example'],
                path: '^/ibs:',
                kind: 'hit',
                identifierParams: ['dpuuid'],
              },
            ],
          },
        ],
      }),
    );
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            // The URL is redacted by the collector; the names come from the features read before redaction.
            req('https://dpm.sync-vendor.example/ibs:dpid=[redacted]&dpuuid=[redacted]', {
              id: 'path-id',
              resourceType: 'image',
              identifierPresent: true,
              identifierNames: ['dpuuid'],
            }),
            // Counterexample: the same endpoint without an identifier value is no identifier.
            req('https://dpm.sync-vendor.example/ibs:dpid=[redacted]', { id: 'none', resourceType: 'image' }),
          ],
        }),
      ]),
      { catalog },
    );
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind, r.identifierParam])).toEqual([
      ['path-id', true, 'persistent-param', 'dpuuid'],
      ['none', false, 'none', undefined],
    ]);
  });

  it('a domain-only match with resourceType `other` is a loaded resource, no hit (compression dictionary)', () => {
    const dict = 'https://securepubads.g.doubleclick.net/pagead/managed/dict/abc/def';
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req(dict, { id: 'dict', resourceType: 'other' }),
            req('https://securepubads.g.doubleclick.net/tag/js/gpt.js', {
              id: 'gpt',
              resourceType: 'script',
            }),
            // Counterexamples: real transport types stay hits for tracking categories.
            req('https://securepubads.g.doubleclick.net/gampad/ads?iu=x', {
              id: 'ads-fetch',
              resourceType: 'fetch',
            }),
            req('https://securepubads.g.doubleclick.net/gampad/ads?iu=y', {
              id: 'ads-xhr',
              resourceType: 'xhr',
            }),
            req('https://securepubads.g.doubleclick.net/pcs/view?x=1', { id: 'ping', resourceType: 'ping' }),
            req('https://securepubads.g.doubleclick.net/pixel', { id: 'beacon', resourceType: 'beacon' }),
            req('https://securepubads.g.doubleclick.net/pixel.gif', { id: 'image', resourceType: 'image' }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.serviceId, r.kind, r.stage])).toEqual([
      ['dict', 'google-ad-manager', 'resource', 'loaded'],
      ['gpt', 'google-ad-manager', 'library', 'loaded'],
      ['ads-fetch', 'google-ad-manager', 'hit', 'event-sent'],
      ['ads-xhr', 'google-ad-manager', 'hit', 'event-sent'],
      ['ping', 'google-ad-manager', 'hit', 'event-sent'],
      ['beacon', 'google-ad-manager', 'hit', 'event-sent'],
      ['image', 'google-ad-manager', 'hit', 'event-sent'],
    ]);
    // The dictionary alone must not raise the service to `event-sent`.
    const only = derive(
      snap([makePhase('A', { requests: [req(dict, { id: 'dict', resourceType: 'other' })] })]),
    );
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('`other` on a path without any signature is a loaded resource by the resource type alone', () => {
    // No signature covers /pcs/anything: the `other` branch of the resource-type mapping decides, not the catalog.
    const url = 'https://securepubads.g.doubleclick.net/pcs/anything';
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req(url, { id: 'other', resourceType: 'other' }),
            // Counterexample: the same URL over a transport type is still a hit.
            req(url, { id: 'ping', resourceType: 'ping' }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.signatureId, r.kind, r.stage])).toEqual([
      ['other', undefined, 'resource', 'loaded'],
      ['ping', undefined, 'hit', 'event-sent'],
    ]);
    const only = derive(
      snap([makePhase('A', { requests: [req(url, { id: 'other', resourceType: 'other' })] })]),
    );
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('fromServiceWorker marks the initiator, not the answer: a network-answered SW request is delivered', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            // Issued by a service worker, answered by the network (provenance network, state completed).
            req(ga, {
              id: 'sw-initiator',
              fromServiceWorker: true,
              state: 'completed',
              delivery: 'sent',
              status: 200,
              result: { kind: 'response', status: 200 },
              provenance: 'network',
            }),
            // Counterexamples: the answer itself came from the service worker or a cache.
            req(ga, {
              id: 'sw-answer',
              state: 'from-sw',
              provenance: 'service-worker',
              fromServiceWorker: true,
            }),
            req(ga, { id: 'sw-provenance', state: 'completed', provenance: 'service-worker' }),
            req(ga, { id: 'cache', state: 'from-cache' }),
            req(ga, { id: 'plain', state: 'completed' }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => [r.requestId, r.delivered])).toEqual([
      ['sw-initiator', true],
      ['sw-answer', false],
      ['sw-provenance', false],
      ['cache', false],
      ['plain', true],
    ]);
  });

  it('Consent Mode: cookieless ping when the relevant storage is denied', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://www.google-analytics.com/g/collect?gcs=G100&cid=[redacted]', { id: 'a' }),
            req('https://www.google-analytics.com/g/collect?gcs=G101', { id: 'b' }),
            req('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/', {
              id: 'c',
              consentSignals: { gcd: '13p3p3p3p5' },
            }),
          ],
        }),
      ]),
    );
    expect(d.requests.map((r) => r.cookieless)).toEqual([true, false, true]);
    expect(d.requests[2]?.consentMode).toEqual({
      adStorage: 'denied',
      analyticsStorage: 'denied',
      source: 'gcd',
    });
  });

  it('maps integration types and timing relative to the click', () => {
    const d = derive(
      snap([
        makePhase('B', {
          click: {
            action: 'reject',
            cmpId: 'cookiebot',
            name: 'Ablehnen',
            clickedAt: 0,
            pageUrl: 'https://www.example.de/',
            success: true,
          },
          requests: [
            req('https://www.google.com/maps/embed?pb=[redacted]', {
              id: 'a',
              phase: 'B',
              resourceType: 'document',
            }),
            req('https://tile.openstreetmap.org/1/2/3.png', {
              id: 'b',
              phase: 'B',
              afterClick: true,
              resourceType: 'image',
            }),
          ],
        }),
      ]),
    );
    expect(d.requests[0]).toMatchObject({ integration: 'iframe', timing: 'before-interaction' });
    expect(d.requests[1]).toMatchObject({ integration: 'tiles', timing: 'after-reject' });
  });

  it('skips non-http requests', () => {
    const d = derive(
      snap([makePhase('A', { requests: [req('https://x.de/a', { id: 'a', url: 'data:image/png' })] })]),
    );
    expect(d.requests).toEqual([]);
  });
});

describe('derive: cookies and storage', () => {
  it('known tracking identifiers, allowlist, unknown third party, setter context', () => {
    const d = derive(
      snap([
        makePhase('A', {
          cookies: [
            makeCookie({ name: '_ga' }),
            makeCookie({ name: 'CookieConsent' }),
            makeCookie({ name: 'IDE', domain: 'doubleclick.net', firstParty: false }),
            makeCookie({ name: 'xyz', domain: 'tracker-unknown.com', firstParty: false }),
            makeCookie({ name: 'vid', setterHost: 'static.hotjar.com' }),
            makeCookie({ name: 'sess', lifetime: { kind: 'session' } }),
          ],
        }),
      ]),
    );
    const byName = Object.fromEntries(d.cookies.map((c) => [c.key.name, c]));
    expect(byName._ga).toMatchObject({
      serviceId: 'google-analytics',
      tracking: true,
      allowlisted: false,
      source: 'catalog',
    });
    expect(byName.CookieConsent).toMatchObject({
      tracking: false,
      allowlisted: true,
      allowlistClass: 'consent',
    });
    expect(byName.IDE).toMatchObject({
      serviceId: 'google-marketing-platform',
      tracking: true,
      thirdParty: true,
    });
    expect(byName.xyz).toMatchObject({
      serviceId: null,
      tracking: false,
      thirdParty: true,
      etld1: 'tracker-unknown.com',
    });
    expect(byName.vid).toMatchObject({ serviceId: 'hotjar', tracking: false, source: 'heuristic' });
    expect(byName.sess).toMatchObject({ persistent: false });
    // The version of the catalog allowlist is catalog data (it changes with the allowlist), not a constant here.
    expect(d.allowlistVersion).toBe(loadServiceCatalog().allowlistVersion);
  });

  it('storage keys: tracking, allowlisted, third-party origin', () => {
    const d = derive(
      snap([
        makePhase('A', {
          storage: [
            makeStorage({ key: '_gcl_ls' }),
            makeStorage({ key: 'uc_settings' }),
            makeStorage({ key: 'yt-remote-device-id', origin: 'https://www.youtube.com', firstParty: false }),
            makeStorage({ key: 'tmp', storageType: 'sessionStorage' }),
          ],
        }),
      ]),
    );
    expect(d.storage.map((s) => [s.key, s.serviceId, s.tracking, s.allowlisted, s.persistent])).toEqual([
      ['_gcl_ls', 'google-ads', true, false, true],
      ['uc_settings', null, false, true, true],
      ['yt-remote-device-id', 'youtube', true, false, true],
      ['tmp', null, false, false, false],
    ]);
  });
});

describe('derive: service inventory (TRACK-01 stages)', () => {
  it('aggregates stages, timings, identifier and pages per service', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [
            req('https://connect.facebook.net/en_US/fbevents.js', {
              id: 'a',
              pageUrl: 'https://www.example.de/',
            }),
            req('https://connect.facebook.net/signals/config/123', {
              id: 'b',
              pageUrl: 'https://www.example.de/',
            }),
          ],
          cookies: [makeCookie({ name: '_fbp' })],
        }),
        makePhase('C', {
          requests: [
            req('https://www.facebook.com/tr/?id=1&fbp=[redacted]', {
              id: 'c',
              phase: 'C',
              afterClick: true,
              pageUrl: 'https://www.example.de/kontakt',
              resourceType: 'image',
              identifierPresent: true,
              identifierNames: ['fbp'],
            }),
            req('https://www.facebook.com/tr/?id=2', {
              id: 'd',
              phase: 'C',
              afterClick: true,
              state: 'failed',
            }),
          ],
        }),
      ]),
    );
    const meta = d.services.find((s) => s.serviceId === 'meta-pixel');
    expect(meta).toMatchObject({
      category: 'ads',
      phases: ['A', 'C'],
      stages: ['loaded', 'initialised', 'event-sent'],
      identifierSeen: true,
      timings: ['before-interaction', 'after-accept'],
      pages: ['https://www.example.de/', 'https://www.example.de/kontakt'],
    });
    expect(meta?.requestIds).toEqual(['a', 'b', 'c', 'd']);
    expect(d.catalogVersion).toBe('0.2.0');
    expect(d.datasets).toEqual([
      {
        name: 'dsgvo-check-services',
        version: '0.2.0',
        date: '2026-10-30',
        license: 'Apache-2.0',
        attribution: 'dsgvo-check service catalog, © dsgvo-check contributors, Apache-2.0',
      },
    ]);
  });

  it('a failed request does not prove a stage', () => {
    const d = derive(
      snap([
        makePhase('A', {
          requests: [req('https://static.hotjar.com/c/hotjar-1.js', { id: 'a', state: 'failed' })],
        }),
      ]),
    );
    expect(d.services[0]).toMatchObject({ serviceId: 'hotjar', stages: [], delivered: false });
  });

  it('empty browser section gives an empty classification', () => {
    const d = derive(makeSnapshot({ browser: makeBrowser() }));
    expect(d).toMatchObject({ requests: [], cookies: [], storage: [], services: [], catalog: {} });
  });
});

describe('helpers', () => {
  it.each([
    ['G100', undefined, { adStorage: 'denied', analyticsStorage: 'denied', source: 'gcs' }],
    ['G111', undefined, { adStorage: 'granted', analyticsStorage: 'granted', source: 'gcs' }],
    ['G101', undefined, { adStorage: 'denied', analyticsStorage: 'granted', source: 'gcs' }],
    [undefined, '13r3r3r3r5', { adStorage: 'granted', analyticsStorage: 'granted', source: 'gcd' }],
    [undefined, '11l1l1l1l5', null],
    [undefined, undefined, null],
  ])('decodeConsentMode(%s, %s)', (gcs, gcd, want) => {
    expect(decodeConsentMode(gcs, gcd)).toEqual(want);
  });

  it('timingOf', () => {
    expect(timingOf({ phase: 'A' }, true)).toBe('before-interaction');
    expect(timingOf({ phase: 'B' }, false)).toBe('before-interaction');
    expect(timingOf({ phase: 'B' }, true)).toBe('after-reject');
    expect(timingOf({ phase: 'C' }, true)).toBe('after-accept');
  });
});
