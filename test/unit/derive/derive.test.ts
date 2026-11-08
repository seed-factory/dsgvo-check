/** derive: party, first-party proxies, identifiers, Consent Mode, stages, cookie/storage classification. */
import { describe, expect, it } from 'vitest';
import type { IframeFact, RequestRecord } from '../../../src/core/snapshot/browser.ts';
import { parseCatalog, ServiceCatalog } from '../../../src/derive/catalog.ts';
import { derive, loadServiceCatalog } from '../../../src/derive/index.ts';
import {
  makeBrowser,
  makeCookie,
  makeDom,
  makePage,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeStorage,
  makeTarget,
} from '../../utils/snapshot-builder.ts';
import { deriveA, derivePhases, deriveRequests, snap } from './derive-phase.ts';

type RequestExtra = Omit<Parameters<typeof makeRequest>[0], 'id' | 'url'>;

const req = (id: string, url: string, extra: RequestExtra = {}) => makeRequest({ id, url, ...extra });

type CookieExtra = Omit<Parameters<typeof makeCookie>[0], 'name' | 'domain' | 'firstParty'>;
type StorageExtra = Omit<Parameters<typeof makeStorage>[0], 'key' | 'origin' | 'firstParty'>;

const thirdPartyCookie = (name: string, domain: string, extra: CookieExtra = {}) =>
  makeCookie({ name, domain, firstParty: false, ...extra });

const thirdPartyStorage = (key: string, origin: string, extra: StorageExtra = {}) =>
  makeStorage({ key, origin, firstParty: false, ...extra });

describe('derive: requests', () => {
  it('third party is decided by eTLD+1; www and apex are the same party', () => {
    const d = deriveRequests(
      req('r1', 'https://example.de/app.js'),
      req('r2', 'https://cdn.example.de/a.css'),
      req('r3', 'https://cdn.other-site.de/x.js'),
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
    const d = derive(snap([makePhase('A', { requests: [req('r1', 'https://example.de/x.js')] })], target));
    expect(d.requests[0]?.thirdParty).toBe(false);
    expect(d.firstPartyEtld1s).toEqual(['example-shop.de', 'example.de']);
  });

  it('classifies catalog services with kind, stage, identifier and catalog source', () => {
    const d = deriveRequests(
      req('lib', 'https://www.googletagmanager.com/gtag/js?id=G-ABC'),
      req('hit', 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=[redacted]&en=page_view', {
        resourceType: 'ping',
        identifierPresent: true,
        identifierNames: ['cid'],
      }),
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
    const d = deriveRequests(
      req('proxy', 'https://www.example.de/metrics/g/collect?v=2&tid=G-1&cid=[redacted]'),
      req('matomo', 'https://www.example.de/matomo/matomo.php?idsite=1&_id=[redacted]', {
        identifierPresent: true,
        identifierNames: ['_id'],
      }),
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

  it('a self-hosted CMP on the site is self-hosted, on another host a third-party CMP; never a first-party proxy', () => {
    const app = '/consent/public/app.js?apiKey=[redacted]&domain=[redacted]';
    const d = deriveRequests(
      req('own', `https://www.example.de${app}`),
      req('agency', `https://consent.agency.example${app}`),
    );
    expect(
      d.requests.map((r) => [r.requestId, r.serviceId, r.thirdParty, r.selfHosted, r.firstPartyProxy]),
    ).toEqual([
      ['own', 'ccm19', false, true, false],
      ['agency', 'ccm19', true, undefined, false],
    ]);
  });

  it('a redacted identifier key in the URL is no evidence; the collector names decide (before redaction)', () => {
    const d = deriveRequests(
      // `cid=` was empty before redaction: identifierPresent false, no names.
      req('empty', 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]', {
        resourceType: 'ping',
      }),
      req('cid', 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]', {
        resourceType: 'ping',
        identifierPresent: true,
        identifierNames: ['cid'],
      }),
    );
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind])).toEqual([
      ['empty', false, 'none'],
      ['cid', true, 'persistent-param'],
    ]);
    expect(d.requests[1]?.identifierParam).toBe('cid');
  });

  it('identifier kind – stored match, sent tracking cookie, catalog param, user-supplied, per-load, none', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]';
    const floodlight = 'https://ad.doubleclick.net/activity';
    const hotjar = 'https://in.hotjar.com/api/v2/client';
    const named = (name: string) => ({ identifierPresent: true, identifierNames: [name] });
    const cases = [
      [req('stored', ga, { ...named('cid'), matchesStoredIdentifier: true }), 'stored-match', true],
      [
        req('stored-only', 'https://bat.bing.com/action/0?ti=1', { matchesStoredIdentifier: true }),
        'stored-match',
        true,
      ],
      // No request value was compared with the cookie: the collector's `matchesStoredIdentifier` stays unset.
      [req('cookie', floodlight, { ...named('IDE'), sentCookieNames: ['IDE'] }), 'sent-cookie', true],
      [req('cookie-only', floodlight, { sentCookieNames: ['IDE'] }), 'sent-cookie', true],
      [req('unknown-cookie', `${floodlight}2`, { sentCookieNames: ['test_cookie'] }), 'none', false],
      [req('param', ga, named('cid')), 'persistent-param', true],
      [req('click', 'https://www.facebook.com/tr/?id=1', named('fbclid')), 'user-supplied', true],
      // `uuid` is a generic identifier name, not a catalog identifier param of Hotjar's ingest.
      [req('random', hotjar, named('uuid')), 'per-load', false],
      [req('bare', hotjar, { identifierPresent: true }), 'per-load', false],
      [req('plain', `${hotjar}?x=1`), 'none', false],
    ] as const;
    const d = deriveRequests(...cases.map(([request]) => request));
    expect(d.requests.map((r) => [r.requestId, r.identifierKind, r.identifier])).toEqual(
      cases.map(([request, kind, identifier]) => [request.id, kind, identifier]),
    );
    expect(d.services.find((s) => s.serviceId === 'hotjar')?.identifierSeen).toBe(false);
  });

  it('delivery and response are independent facts – a body error after the response keeps the exchange', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = deriveRequests(
      // Headers 204 received, then the body was aborted: the recorder ends in `failed`.
      req('aborted-body', ga, {
        state: 'failed',
        status: 204,
        delivery: 'sent',
        result: { kind: 'failed', errorText: 'net::ERR_ABORTED' },
        failureText: 'net::ERR_ABORTED',
      }),
      req('no-response', ga, {
        state: 'failed',
        status: undefined,
        delivery: 'attempted',
        result: { kind: 'failed', errorText: 'net::ERR_CONNECTION_RESET' },
      }),
      req('csp', ga, {
        state: 'blocked-by-browser',
        status: undefined,
        delivery: 'blocked-by-browser',
        result: { kind: 'failed', errorText: 'net::ERR_BLOCKED_BY_CLIENT' },
      }),
      req('sw', ga, { state: 'from-sw', provenance: 'service-worker', fromServiceWorker: true }),
      req('ok', ga, { delivery: 'sent', result: { kind: 'response', status: 204 } }),
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
        userSuppliedParams: base.userSuppliedParams,
        consentMode: base.consentMode,
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
    const d = deriveA(
      {
        requests: [
          // The URL is redacted by the collector; the names come from the features read before redaction.
          req('path-id', 'https://dpm.sync-vendor.example/ibs:dpid=[redacted]&dpuuid=[redacted]', {
            resourceType: 'image',
            identifierPresent: true,
            identifierNames: ['dpuuid'],
          }),
          // Counterexample: the same endpoint without an identifier value is no identifier.
          req('none', 'https://dpm.sync-vendor.example/ibs:dpid=[redacted]', { resourceType: 'image' }),
        ],
      },
      { catalog },
    );
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind, r.identifierParam])).toEqual([
      ['path-id', true, 'persistent-param', 'dpuuid'],
      ['none', false, 'none', undefined],
    ]);
  });

  it('a compression dictionary is a loaded resource, not a tracking event', () => {
    const dict = '/pagead/managed/dict/abc/def';
    const ads = (id: string, path: string, resourceType: RequestRecord['resourceType']) =>
      req(id, `https://securepubads.g.doubleclick.net${path}`, { resourceType });
    const cases = [
      [ads('dict', dict, 'other'), 'resource', 'loaded'],
      [ads('gpt', '/tag/js/gpt.js', 'script'), 'library', 'loaded'],
      // Counterexamples: real transport types stay hits for tracking categories.
      [ads('ads-fetch', '/gampad/ads?iu=x', 'fetch'), 'hit', 'event-sent'],
      [ads('ads-xhr', '/gampad/ads?iu=y', 'xhr'), 'hit', 'event-sent'],
      [ads('ping', '/pcs/view?x=1', 'ping'), 'hit', 'event-sent'],
      [ads('beacon', '/pixel', 'beacon'), 'hit', 'event-sent'],
      [ads('image', '/pixel.gif', 'image'), 'hit', 'event-sent'],
    ] as const;
    const d = deriveRequests(...cases.map(([request]) => request));
    expect(d.requests.map((r) => [r.requestId, r.serviceId, r.kind, r.stage])).toEqual(
      cases.map(([request, kind, stage]) => [request.id, 'google-ad-manager', kind, stage]),
    );
    // The dictionary alone must not raise the service to `event-sent`.
    const only = deriveRequests(ads('dict', dict, 'other'));
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('`other` on a path without any signature is a loaded resource by the resource type alone', () => {
    // No signature covers /pcs/anything: the `other` branch of the resource-type mapping decides, not the catalog.
    const url = 'https://securepubads.g.doubleclick.net/pcs/anything';
    const d = deriveRequests(
      req('other', url, { resourceType: 'other' }),
      // Counterexample: the same URL over a transport type is still a hit.
      req('ping', url, { resourceType: 'ping' }),
    );
    expect(d.requests.map((r) => [r.requestId, r.signatureId, r.kind, r.stage])).toEqual([
      ['other', undefined, 'resource', 'loaded'],
      ['ping', undefined, 'hit', 'event-sent'],
    ]);
    const only = deriveRequests(req('other', url, { resourceType: 'other' }));
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('fromServiceWorker marks the initiator, not the answer: a network-answered SW request is delivered', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = deriveRequests(
      // Issued by a service worker, answered by the network (provenance network, state completed).
      req('sw-initiator', ga, {
        fromServiceWorker: true,
        state: 'completed',
        delivery: 'sent',
        status: 200,
        result: { kind: 'response', status: 200 },
        provenance: 'network',
      }),
      // Counterexamples: the answer itself came from the service worker or a cache.
      req('sw-answer', ga, { state: 'from-sw', provenance: 'service-worker', fromServiceWorker: true }),
      req('sw-provenance', ga, { state: 'completed', provenance: 'service-worker' }),
      req('cache', ga, { state: 'from-cache' }),
      req('plain', ga, { state: 'completed' }),
    );
    expect(d.requests.map((r) => [r.requestId, r.delivered])).toEqual([
      ['sw-initiator', true],
      ['sw-answer', false],
      ['sw-provenance', false],
      ['cache', false],
      ['plain', true],
    ]);
  });

  it('Consent Mode reports the state and detects cookieless requests for the relevant storage', () => {
    const analytics = 'https://www.google-analytics.com/g/collect';
    const ads = 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/';
    const cases = [
      [`${analytics}?gcs=G100&cid=[redacted]`, {}, ['denied', 'denied', 'gcs'], true],
      [`${analytics}?gcs=G101`, {}, ['denied', 'granted', 'gcs'], false],
      [`${analytics}?gcs=G111`, {}, ['granted', 'granted', 'gcs'], false],
      [ads, { gcd: '13p3p3p3p5' }, ['denied', 'denied', 'gcd'], true],
      [ads, { gcd: '13r3r3r3r5' }, ['granted', 'granted', 'gcd'], false],
      [ads, { gcd: '11l1l1l1l5' }, null, undefined],
      [ads, {}, null, undefined],
    ] as const;
    const { requests } = deriveA({
      requests: cases.map(([url, consentSignals], index) => req(`r${index}`, url, { consentSignals })),
    });
    const outcomes = requests.map(({ consentMode, cookieless }) => [
      consentMode ? [consentMode.adStorage, consentMode.analyticsStorage, consentMode.source] : null,
      cookieless,
    ]);
    expect(outcomes).toEqual(cases.map(([, , consent, cookieless]) => [consent, cookieless]));
  });

  it('maps integration types and timing relative to the click', () => {
    const d = derivePhases(
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
          req('a', 'https://www.google.com/maps/embed?pb=[redacted]', {
            phase: 'B',
            resourceType: 'document',
          }),
          req('b', 'https://tile.openstreetmap.org/1/2/3.png', {
            phase: 'B',
            afterClick: true,
            resourceType: 'image',
          }),
        ],
      }),
    );
    expect(d.requests[0]).toMatchObject({ integration: 'iframe', timing: 'before-interaction' });
    expect(d.requests[1]).toMatchObject({ integration: 'tiles', timing: 'after-reject' });
  });

  it('a video image is a thumbnail only by its catalog signature; a player beacon image is other', () => {
    const cases = [
      ['yt', 'https://i1.ytimg.com/vi/abc/hqdefault.jpg', 'image', 'thumbnail'],
      ['img', 'https://img.youtube.com/vi/abc/0.jpg', 'image', 'thumbnail'],
      ['vimeo', 'https://i.vimeocdn.com/video/123456789-abc_640', 'image', 'thumbnail'],
      ['beacon', 'https://www.youtube-nocookie.com/generate_204?abc', 'image', 'other'],
      ['player', 'https://www.youtube.com/s/player/abc/player_ias.vflset/de_DE/base.js', 'script', 'other'],
    ] as const;
    const d = deriveRequests(...cases.map(([id, url, resourceType]) => req(id, url, { resourceType })));
    expect(cases.map(([id]) => d.requests.find((r) => r.requestId === id)?.integration)).toEqual(
      cases.map(([, , , integration]) => integration),
    );
  });

  it('skips non-http requests', () => {
    const d = deriveRequests(req('a', 'data:image/png'));

    expect(d.requests).toEqual([]);
  });
});

describe('derive: requests of embedded frames', () => {
  const inFrame =
    (frameId: string, frameUrl?: string) =>
    (
      id: string,
      url: string,
      resourceType: RequestRecord['resourceType'] = 'script',
      extra: RequestExtra = {},
    ) =>
      req(id, url, {
        resourceType,
        ...extra,
        isMainFrame: false,
        frameId,
        ...(frameUrl ? { frameUrl } : {}),
      });
  const player = inFrame('A-f2', 'https://www.youtube-nocookie.com/embed/abc?autoplay=[redacted]');

  it("a player's fonts and hosts of no catalog service belong to the player; services of their own keep theirs", () => {
    const d = deriveRequests(
      player('doc', 'https://www.youtube-nocookie.com/embed/abc', 'document'),
      player('font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', 'font'),
      player('helper', 'https://www.google.com/js/th/a.js', 'script'),
      player('xhr', 'https://helper.video-cdn.example/b', 'xhr'),
      player('ads', 'https://googleads.g.doubleclick.net/pagead/id', 'fetch'),
      req('site-font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', { resourceType: 'font' }),
    );
    const row = (id: string) => {
      const r = d.requests.find((x) => x.requestId === id);
      return [r?.serviceId, r?.category, r?.source, r?.kind, r?.frameServiceId];
    };
    expect(row('doc')).toEqual(['youtube-nocookie', 'video', 'catalog', 'embed', 'youtube-nocookie']);
    expect(row('font')).toEqual(['youtube-nocookie', 'video', 'embed-frame', 'font', 'youtube-nocookie']);
    expect(row('helper')).toEqual([
      'youtube-nocookie',
      'video',
      'embed-frame',
      'library',
      'youtube-nocookie',
    ]);
    expect(row('xhr')).toEqual(['youtube-nocookie', 'video', 'embed-frame', 'resource', 'youtube-nocookie']);
    expect(row('ads')).toEqual(['google-ads', 'ads', 'catalog', 'hit', 'youtube-nocookie']);
    expect(row('site-font')).toEqual(['google-fonts', 'fonts', 'catalog', 'font', undefined]);
    // The player's font is no use of Google Fonts by the site: only the site's own font request counts for it.
    expect(d.services.find((s) => s.serviceId === 'google-fonts')?.requestIds).toEqual(['site-font']);

    // The catalog still knows what the embed's resource is: the player's font is a Google Fonts font, its helper host
    // is of no catalog service. The site's own requests need no second name.
    const resource = (id: string) => {
      const r = d.requests.find((x) => x.requestId === id);
      return [r?.resourceServiceId, r?.resourceCategory];
    };
    expect(resource('font')).toEqual(['google-fonts', 'fonts']);
    expect(resource('helper')).toEqual([undefined, undefined]);
    expect(resource('xhr')).toEqual([undefined, undefined]);
    expect(resource('ads')).toEqual([undefined, undefined]);
    expect(resource('site-font')).toEqual([undefined, undefined]);
  });

  it.each([
    [
      'a builder frame that loads Google Maps',
      'https://static.builder.example/map.html?lang=[redacted]',
      true,
    ],
    ['the Google Maps embed frame itself', 'https://www.google.com/maps/embed?pb=[redacted]', false],
  ])(
    'the fonts of %s keep their catalog service as the resource, while the map owns the request',
    (_case, frameUrl, loadsApi) => {
      const frame = inFrame('A-f9', frameUrl);
      const d = deriveRequests(
        ...(loadsApi ? [frame('api', 'https://maps.googleapis.com/maps/api/js?key=[redacted]')] : []),
        frame('css', 'https://fonts.googleapis.com/css?family=Roboto', 'stylesheet'),
        frame('font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', 'font'),
        frame('helper', 'https://helper.unknown-host.example/a.js', 'script'),
      );
      const row = (id: string) => {
        const r = d.requests.find((x) => x.requestId === id);
        return [
          r?.serviceId,
          r?.category,
          r?.source,
          r?.frameServiceId,
          r?.resourceServiceId,
          r?.resourceCategory,
        ];
      };
      expect(['css', 'font', 'helper'].map(row)).toEqual([
        ['google-maps', 'maps', 'embed-frame', 'google-maps', 'google-fonts', 'fonts'],
        ['google-maps', 'maps', 'embed-frame', 'google-maps', 'google-fonts', 'fonts'],
        ['google-maps', 'maps', 'embed-frame', 'google-maps', undefined, undefined],
      ]);
      // The map frame's fonts stay out of the site's own use of Google Fonts, but the lookup knows the font service,
      // so a finding about the frame's fonts names it with its provider.
      expect(d.services.find((s) => s.serviceId === 'google-fonts')).toBeUndefined();
      expect(d.catalog['google-fonts']).toMatchObject({
        name: 'Google Fonts',
        provider: { name: 'Google Ireland Limited', country: 'IE' },
      });
    },
  );

  it("a frame resource keeps its kind for its own service, as the site's request would have it", () => {
    const map = inFrame('A-f4', 'https://www.google.com/maps/embed?pb=[redacted]');
    const d = deriveRequests(
      map('css', 'https://fonts.googleapis.com/css?family=Roboto', 'stylesheet'),
      map('font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', 'font'),
      map('kit', 'https://use.typekit.net/abc1234.css', 'stylesheet'),
      map('usage', 'https://p.typekit.net/p.css?s=[redacted]', 'stylesheet'),
      map('helper', 'https://helper.unknown-host.example/a.js', 'script'),
      req('site-usage', 'https://p.typekit.net/p.css?s=[redacted]', { resourceType: 'stylesheet' }),
    );
    const row = (id: string) => {
      const r = d.requests.find((x) => x.requestId === id);
      return [id, r?.serviceId, r?.kind, r?.resourceServiceId, r?.resourceKind];
    };
    // `kind` is the request for the map; `resourceKind` what the font service's signature says: the usage counter of
    // Adobe Fonts is a hit in the frame as on the site, though the frame fetched it as a stylesheet.
    expect(['css', 'font', 'kit', 'usage', 'helper', 'site-usage'].map(row)).toEqual([
      ['css', 'google-maps', 'stylesheet', 'google-fonts', 'stylesheet'],
      ['font', 'google-maps', 'font', 'google-fonts', 'font'],
      ['kit', 'google-maps', 'stylesheet', 'adobe-fonts', 'stylesheet'],
      ['usage', 'google-maps', 'stylesheet', 'adobe-fonts', 'hit'],
      ['helper', 'google-maps', 'library', undefined, undefined],
      ['site-usage', 'adobe-fonts', 'hit', undefined, undefined],
    ]);
  });

  it.each([
    ['an unknown host', 'https://static.builder.example', [null, 'none']],
    ['a CDN of the catalog (Wix)', 'https://static.parastorage.com', ['wix', 'catalog']],
  ])(
    "a builder's frame on %s takes the embed it loads; the builder's own hosts stay its own",
    (_case, origin, own) => {
      const builder = inFrame('A-f3', `${origin}/map.html?lang=[redacted]`);
      const d = deriveRequests(
        builder('own', `${origin}/map.js`, 'script'),
        builder('css', 'https://fonts.googleapis.com/css?family=Roboto', 'stylesheet'),
        builder('api', 'https://maps.googleapis.com/maps/api/js?key=[redacted]'),
      );
      expect(d.requests.map((r) => [r.requestId, r.serviceId, r.source, r.frameServiceId])).toEqual([
        ['own', ...own, 'google-maps'],
        ['css', 'google-maps', 'embed-frame', 'google-maps'],
        ['api', 'google-maps', 'catalog', 'google-maps'],
      ]);
      expect(d.requests.find((r) => r.requestId === 'css')).toMatchObject({
        resourceServiceId: 'google-fonts',
        resourceCategory: 'fonts',
      });
    },
  );

  it.each([
    [
      'a payment frame (Stripe) that loads hCaptcha',
      inFrame('A-f7', 'https://js.stripe.com/v3/hcaptcha-inner-abc.html'),
      'https://js.hcaptcha.com/1/api.js',
      'hcaptcha',
    ],
    [
      'an ad frame (Google Ads) that loads the YouTube player API',
      inFrame('A-f8', 'https://googleads.g.doubleclick.net/pagead/ads?client=[redacted]'),
      'https://www.youtube.com/iframe_api',
      'youtube',
    ],
  ])(
    '%s takes no embed: the other requests of the frame keep their own classification',
    (_case, frame, embedUrl, embedId) => {
      const d = deriveRequests(
        frame('embed', embedUrl, 'script'),
        frame('unknown', 'https://cdn.other-site.de/x.js', 'script'),
        frame('font', 'https://fonts.gstatic.com/s/inter/v1/a.woff2', 'font'),
      );
      expect(d.requests.map((r) => [r.requestId, r.serviceId, r.source, r.frameServiceId])).toEqual([
        ['embed', embedId, 'catalog', undefined],
        ['unknown', null, 'none', undefined],
        ['font', 'google-fonts', 'catalog', undefined],
      ]);
      expect(d.services.find((s) => s.serviceId === embedId)?.requestIds).toEqual(['embed']);
    },
  );

  it.each([
    ['a frame of the site', inFrame('A-f4', 'https://www.example.de/widget.html')],
    ['a frame without a document URL', inFrame('A-f5', undefined)],
    ['a frame of no embedded service', inFrame('A-f6', 'https://ads.adserver.example/frame.html')],
  ])('%s is no embed: its requests keep their own classification', (_case, frame) => {
    const d = deriveRequests(
      frame('font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', 'font'),
      frame('unknown', 'https://cdn.other-site.de/x.js'),
    );
    expect(d.requests.map((r) => [r.requestId, r.serviceId, r.source, r.frameServiceId])).toEqual([
      ['font', 'google-fonts', 'catalog', undefined],
      ['unknown', null, 'none', undefined],
    ]);
  });

  it.each([
    [
      'its first document is a redirect of the site to the player',
      [
        inFrame('A-f9', 'https://www.example.de/player')('hop', 'https://www.example.de/player', 'document', {
          isNavigation: true,
          status: 302,
        }),
      ],
    ],
    [
      'its first request was made before the frame had an address',
      [req('hop', 'https://cdn.other-site.de/boot.js', { isMainFrame: false, frameId: 'A-f9' })],
    ],
  ])('a frame takes the service of its document when %s', (_case, before) => {
    const frame = inFrame('A-f9', 'https://www.youtube-nocookie.com/embed/abc');
    const d = deriveRequests(
      ...before,
      frame('doc', 'https://www.youtube-nocookie.com/embed/abc', 'document', { isNavigation: true }),
      frame('thumb', 'https://i.ytimg.com/vi/abc/hqdefault.jpg', 'image'),
      frame('xhr', 'https://helper.video-cdn.example/b', 'xhr'),
    );
    const row = (id: string) => {
      const r = d.requests.find((x) => x.requestId === id);
      return [r?.serviceId, r?.source, r?.frameServiceId];
    };
    expect(['doc', 'thumb', 'xhr'].map(row)).toEqual([
      ['youtube-nocookie', 'catalog', 'youtube-nocookie'],
      ['youtube', 'catalog', 'youtube-nocookie'],
      ['youtube-nocookie', 'embed-frame', 'youtube-nocookie'],
    ]);
  });
});

describe('derive: iframes of visited pages', () => {
  it('classifies the src of every frame of a page by the catalog, the site itself as first party', () => {
    const iframe = (src: string | null, p: Partial<IframeFact> = {}): IframeFact => ({
      src,
      srcdoc: false,
      visible: true,
      depth: 1,
      ...p,
    });
    const pageUrl = 'https://www.example.de/videos';
    const video = 'https://www.youtube-nocookie.com/embed/abc';
    const widget = 'https://www.example.de/widget.html';
    const d = deriveA({
      pages: [
        makePage({
          url: pageUrl,
          dom: makeDom({
            iframes: [
              iframe(video, { loading: 'lazy' }),
              iframe(widget),
              iframe(null, { srcdoc: true }),
              iframe('about:blank'),
            ],
          }),
        }),
      ],
    });
    const visit = { phase: 'A', pageUrl };
    expect(d.frames).toEqual([
      { ...visit, src: video, thirdParty: true, serviceId: 'youtube-nocookie', category: 'video' },
      { ...visit, src: widget, thirdParty: false, serviceId: null, category: 'unknown' },
    ]);
  });
});

describe('derive: cookies and storage', () => {
  it('known tracking identifiers, allowlist, unknown third party, setter context', () => {
    const d = deriveA({
      cookies: [
        makeCookie({ name: '_ga' }),
        makeCookie({ name: 'CookieConsent' }),
        thirdPartyCookie('IDE', 'doubleclick.net'),
        thirdPartyCookie('xyz', 'tracker-unknown.com'),
        makeCookie({ name: 'vid', setterHost: 'static.hotjar.com' }),
        makeCookie({ name: 'sess', lifetime: { kind: 'session' } }),
      ],
    });

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

  it('a cookie name shared by services of one company belongs to the service whose host set it in its response', () => {
    const ide = (setter: 'http-response' | 'script', setterHost: string) =>
      thirdPartyCookie('IDE', 'doubleclick.net', { setter, setterHost });
    const cases = [
      // The Google Ads conversion host answered with it: Google Ads, still a tracking identifier from the catalog.
      [
        'http-response',
        'googleads.g.doubleclick.net',
        { serviceId: 'google-ads', tracking: true, source: 'catalog' },
      ],
      // A Floodlight host of the Marketing Platform keeps it there.
      ['http-response', 'ad.doubleclick.net', { serviceId: 'google-marketing-platform' }],
      // A script names the host it was loaded from, which may be the loader of another service.
      ['script', 'googleads.g.doubleclick.net', { serviceId: 'google-marketing-platform' }],
      // A host of another company never takes over a catalog cookie.
      ['http-response', 'static.hotjar.com', { serviceId: 'google-marketing-platform' }],
    ] as const;

    for (const [setter, host, expected] of cases) {
      expect(deriveA({ cookies: [ide(setter, host)] }).cookies[0], `${setter} ${host}`).toMatchObject(
        expected,
      );
    }
  });

  it('a cookie that expires within the threshold is short-lived like a session cookie; the setting moves the line', () => {
    const cookies = [
      makeCookie({ name: 'minutes', lifetime: { kind: 'persistent', days: 0 } }),
      makeCookie({ name: 'hours', lifetime: { kind: 'persistent', days: 0.9 } }),
      makeCookie({ name: 'day', lifetime: { kind: 'persistent', days: 1 } }),
      makeCookie({ name: 'month', lifetime: { kind: 'persistent', days: 30 } }),
      makeCookie({ name: 'undated', lifetime: { kind: 'persistent' } }),
      makeCookie({ name: 'session', lifetime: { kind: 'session' } }),
    ];
    const persistent = (minDays?: number) =>
      deriveA({ cookies }, minDays === undefined ? {} : { persistentCookieMinDays: minDays })
        .cookies.filter((c) => c.persistent)
        .map((c) => c.key.name);

    expect(persistent()).toEqual(['day', 'month', 'undated']);
    expect(persistent(0)).toEqual(['minutes', 'hours', 'day', 'month', 'undated']);
    expect(persistent(31)).toEqual(['undated']);
  });

  it('a known cookie or storage entry that is no identifier keeps its service from the catalog', () => {
    const d = deriveA({
      cookies: [
        thirdPartyCookie('test_cookie', 'doubleclick.net', {
          lifetime: { kind: 'persistent', days: 0 },
        }),
        makeCookie({ name: '_gat_UA-0000000-1', lifetime: { kind: 'persistent', days: 0 } }),
      ],
      storage: [
        thirdPartyStorage('rc::a', 'https://www.google.com'),
        thirdPartyStorage('ytidb::LAST_RESULT_ENTRY_KEY', 'https://www.youtube-nocookie.com'),
        thirdPartyStorage('YtIdbMeta', 'https://www.youtube-nocookie.com', { storageType: 'indexedDB' }),
      ],
    });
    expect(d.cookies.map((c) => [c.key.name, c.serviceId, c.source, c.tracking, c.persistent])).toEqual([
      ['test_cookie', 'google-marketing-platform', 'catalog', false, false],
      ['_gat_UA-0000000-1', 'google-analytics', 'catalog', false, false],
    ]);
    expect(d.storage.map((s) => [s.key, s.serviceId, s.source, s.tracking])).toEqual([
      ['rc::a', 'google-recaptcha', 'catalog', false],
      ['ytidb::LAST_RESULT_ENTRY_KEY', 'youtube-nocookie', 'catalog', false],
      ['YtIdbMeta', 'youtube-nocookie', 'catalog', false],
    ]);
  });

  it('storage keys: tracking, allowlisted, third-party origin', () => {
    const d = deriveA({
      storage: [
        makeStorage({ key: '_gcl_ls' }),
        makeStorage({ key: 'uc_settings' }),
        thirdPartyStorage('yt-remote-device-id', 'https://www.youtube.com'),
        makeStorage({ key: 'tmp', storageType: 'sessionStorage' }),
      ],
    });

    expect(d.storage.map((s) => [s.key, s.serviceId, s.tracking, s.allowlisted, s.persistent])).toEqual([
      ['_gcl_ls', 'google-ads', true, false, true],
      ['uc_settings', null, false, true, true],
      ['yt-remote-device-id', 'youtube', true, false, true],
      ['tmp', null, false, false, false],
    ]);
  });
});

describe('derive: names of catalog services', () => {
  it('lists every service a policy may name, observed or not, with its aliases and companies', () => {
    const d = deriveA({});
    expect(d.catalog).toEqual({});

    const fonts = d.serviceNames?.find((s) => s.serviceId === 'google-fonts');
    expect(fonts).toEqual({
      serviceId: 'google-fonts',
      name: 'Google Fonts',
      category: 'fonts',
      aliases: ['Google Fonts', 'Google Web Fonts', 'Google Webfonts'],
      companyAliases: ['Google Ireland Ltd', 'Google Ireland Ltd.', 'Google Ireland Limited', 'Google LLC'],
      provider: { name: 'Google Ireland Limited', country: 'IE' },
      parent: { name: 'Google LLC', country: 'US' },
    });
  });

  it('leaves out entries of no policy relevance, such as the generic Google cookie entry named "Google"', () => {
    const catalog = loadServiceCatalog();
    const ids = deriveA({}, { catalog }).serviceNames?.map((s) => s.serviceId);
    expect(ids).not.toContain('google-cookies');
    expect(ids).toContain('cookiebot');
    expect(ids).toEqual(
      catalog.data.services
        .filter((s) => s.policyRelevance !== 'none')
        .map((s) => s.id)
        .sort(),
    );
  });

  it('a service without parties or aliases has empty lists and no party fields', () => {
    const base = loadServiceCatalog().data;
    const own = new ServiceCatalog(
      parseCatalog({
        ...base,
        services: [
          { id: 'bare-widget', name: 'Bare Widget', category: 'widget', policyRelevance: 'optional' },
        ],
      }),
    );
    expect(deriveA({}, { catalog: own }).serviceNames).toEqual([
      { serviceId: 'bare-widget', name: 'Bare Widget', category: 'widget', aliases: [], companyAliases: [] },
    ]);
  });
});

describe('derive: service inventory (TRACK-01 stages)', () => {
  it('aggregates stages, timings, identifier and pages per service', () => {
    const d = derivePhases(
      makePhase('A', {
        requests: [
          req('a', 'https://connect.facebook.net/en_US/fbevents.js', {
            pageUrl: 'https://www.example.de/',
          }),
          req('b', 'https://connect.facebook.net/signals/config/123', {
            pageUrl: 'https://www.example.de/',
          }),
        ],
        cookies: [makeCookie({ name: '_fbp' })],
      }),
      makePhase('C', {
        requests: [
          req('c', 'https://www.facebook.com/tr/?id=1&fbp=[redacted]', {
            phase: 'C',
            afterClick: true,
            pageUrl: 'https://www.example.de/kontakt',
            resourceType: 'image',
            identifierPresent: true,
            identifierNames: ['fbp'],
          }),
          req('d', 'https://www.facebook.com/tr/?id=2', {
            phase: 'C',
            afterClick: true,
            state: 'failed',
          }),
        ],
      }),
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
        attribution: 'dsgvo-check service catalogue, © dsgvo-check contributors, Apache-2.0',
      },
    ]);
  });

  it('a service known only by its cookie was observed on the pages that wrote it', () => {
    const d = deriveA({
      cookies: [
        thirdPartyCookie('IDE', 'doubleclick.net', {
          pageUrl: 'https://www.example.de/kontakt',
        }),
      ],
    });
    expect(d.services).toMatchObject([
      {
        serviceId: 'google-marketing-platform',
        requestIds: [],
        pages: ['https://www.example.de/kontakt'],
        stages: ['initialised'],
      },
    ]);
  });

  it('a failed request does not prove a stage', () => {
    const d = deriveA({
      requests: [req('a', 'https://static.hotjar.com/c/hotjar-1.js', { state: 'failed' })],
    });

    expect(d.services[0]).toMatchObject({ serviceId: 'hotjar', stages: [], delivered: false });
  });

  it('empty browser section gives an empty classification', () => {
    const d = derive(makeSnapshot({ browser: makeBrowser() }));

    expect(d).toMatchObject({ requests: [], cookies: [], storage: [], services: [], catalog: {} });
  });
});

describe('derive: consent facts from snapshots', () => {
  it('uses the Consent Mode letters configured in the catalog', () => {
    const base = loadServiceCatalog().data;
    const catalog = new ServiceCatalog(
      parseCatalog({ ...base, services: [], consentMode: { gcdDenied: ['z'], gcdGranted: ['y'] } }),
    );
    const requests = [
      makeRequest({ url: 'https://example.test/pixel', consentSignals: { gcd: '11z1y1l1l' } }),
    ];

    expect(deriveA({ requests }, { catalog }).requests[0]?.consentMode).toEqual({
      adStorage: 'denied',
      analyticsStorage: 'granted',
      source: 'gcd',
    });
    expect(deriveA({ requests }).requests[0]?.consentMode).toBeNull();
  });

  it('keeps request timing when an older snapshot has no click record', () => {
    const cases = [
      ['A', true, 'before-interaction'],
      ['B', false, 'before-interaction'],
      ['B', true, 'after-reject'],
      ['C', true, 'after-accept'],
    ] as const;
    const phases = cases.map(([phase, afterClick], index) =>
      makePhase(phase, {
        requests: [req(`r${index}`, 'https://example.test/pixel', { phase, afterClick })],
      }),
    );
    expect(derivePhases(...phases).requests.map((request) => request.timing)).toEqual(
      cases.map(([, , timing]) => timing),
    );
  });
});
