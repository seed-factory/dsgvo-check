/** derive: party, first-party proxies, identifiers, Consent Mode, stages, cookie/storage classification. */
import { describe, expect, it } from 'vitest';
import type { IframeFact } from '../../../src/core/snapshot/browser.ts';
import { parseCatalog, ServiceCatalog } from '../../../src/derive/catalog.ts';
import { decodeConsentMode, derive, loadServiceCatalog, timingOf } from '../../../src/derive/index.ts';
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
import { deriveA, snap } from './derive-phase.ts';

const req = (url: string, p: Parameters<typeof makeRequest>[0] extends infer T ? Partial<T> : never = {}) =>
  makeRequest({ url, ...p });

describe('derive: requests', () => {
  it('third party is decided by eTLD+1; www and apex are the same party', () => {
    const d = deriveA({
      requests: [
        req('https://example.de/app.js', { id: 'r1' }),
        req('https://cdn.example.de/a.css', { id: 'r2' }),
        req('https://cdn.other-site.de/x.js', { id: 'r3' }),
      ],
    });
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
    const d = deriveA({
      requests: [
        req('https://www.googletagmanager.com/gtag/js?id=G-ABC', { id: 'lib' }),
        req('https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=[redacted]&en=page_view', {
          id: 'hit',
          resourceType: 'ping',
          identifierPresent: true,
          identifierNames: ['cid'],
        }),
      ],
    });
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
    const d = deriveA({
      requests: [
        req('https://www.example.de/metrics/g/collect?v=2&tid=G-1&cid=[redacted]', { id: 'proxy' }),
        req('https://www.example.de/matomo/matomo.php?idsite=1&_id=[redacted]', {
          id: 'matomo',
          identifierPresent: true,
          identifierNames: ['_id'],
        }),
      ],
    });
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
    const d = deriveA({
      requests: [
        req(`https://www.example.de${app}`, { id: 'own' }),
        req(`https://consent.agency.example${app}`, { id: 'agency' }),
      ],
    });
    expect(
      d.requests.map((r) => [r.requestId, r.serviceId, r.thirdParty, r.selfHosted, r.firstPartyProxy]),
    ).toEqual([
      ['own', 'ccm19', false, true, false],
      ['agency', 'ccm19', true, undefined, false],
    ]);
  });

  it('identifier from the collector: a bare identifierPresent is not persistent; stored match and sent tracking cookie are', () => {
    const d = deriveA({
      requests: [
        req('https://in.hotjar.com/api/v2/client', { id: 'a', identifierPresent: true }),
        req('https://bat.bing.com/action/0?ti=1', { id: 'b', matchesStoredIdentifier: true }),
        req('https://ad.doubleclick.net/activity', { id: 'c', sentCookieNames: ['IDE'] }),
        req('https://ad.doubleclick.net/activity2', { id: 'd', sentCookieNames: ['test_cookie'] }),
      ],
    });
    expect(d.requests.map((r) => [r.identifier, r.identifierKind])).toEqual([
      [false, 'per-load'],
      [true, 'stored-match'],
      [true, 'sent-cookie'],
      [false, 'none'],
    ]);
  });

  it('a redacted identifier key in the URL is no evidence; the collector names decide (before redaction)', () => {
    const d = deriveA({
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
    });
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind])).toEqual([
      ['empty', false, 'none'],
      ['cid', true, 'persistent-param'],
    ]);
    expect(d.requests[1]?.identifierParam).toBe('cid');
  });

  it('identifier kind – stored match, sent tracking cookie, catalog param, user-supplied, per-load, none', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]';
    const d = deriveA({
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
    });
    expect(d.requests.map((r) => [r.requestId, r.identifierKind, r.identifier])).toEqual([
      ['stored', 'stored-match', true],
      // No request value was compared with the cookie: the collector's `matchesStoredIdentifier` stays unset.
      ['cookie', 'sent-cookie', true],
      ['param', 'persistent-param', true],
      ['click', 'user-supplied', true],
      ['random', 'per-load', false],
      ['plain', 'none', false],
    ]);
    expect(d.services.find((s) => s.serviceId === 'hotjar')?.identifierSeen).toBe(false);
  });

  it('delivery and response are independent facts – a body error after the response keeps the exchange', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = deriveA({
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
    });
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
          req('https://dpm.sync-vendor.example/ibs:dpid=[redacted]&dpuuid=[redacted]', {
            id: 'path-id',
            resourceType: 'image',
            identifierPresent: true,
            identifierNames: ['dpuuid'],
          }),
          // Counterexample: the same endpoint without an identifier value is no identifier.
          req('https://dpm.sync-vendor.example/ibs:dpid=[redacted]', { id: 'none', resourceType: 'image' }),
        ],
      },
      { catalog },
    );
    expect(d.requests.map((r) => [r.requestId, r.identifier, r.identifierKind, r.identifierParam])).toEqual([
      ['path-id', true, 'persistent-param', 'dpuuid'],
      ['none', false, 'none', undefined],
    ]);
  });

  it('a domain-only match with resourceType `other` is a loaded resource, no hit (compression dictionary)', () => {
    const dict = 'https://securepubads.g.doubleclick.net/pagead/managed/dict/abc/def';
    const d = deriveA({
      requests: [
        req(dict, { id: 'dict', resourceType: 'other' }),
        req('https://securepubads.g.doubleclick.net/tag/js/gpt.js', { id: 'gpt', resourceType: 'script' }),
        // Counterexamples: real transport types stay hits for tracking categories.
        req('https://securepubads.g.doubleclick.net/gampad/ads?iu=x', {
          id: 'ads-fetch',
          resourceType: 'fetch',
        }),
        req('https://securepubads.g.doubleclick.net/gampad/ads?iu=y', { id: 'ads-xhr', resourceType: 'xhr' }),
        req('https://securepubads.g.doubleclick.net/pcs/view?x=1', { id: 'ping', resourceType: 'ping' }),
        req('https://securepubads.g.doubleclick.net/pixel', { id: 'beacon', resourceType: 'beacon' }),
        req('https://securepubads.g.doubleclick.net/pixel.gif', { id: 'image', resourceType: 'image' }),
      ],
    });
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
    const only = deriveA({ requests: [req(dict, { id: 'dict', resourceType: 'other' })] });
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('`other` on a path without any signature is a loaded resource by the resource type alone', () => {
    // No signature covers /pcs/anything: the `other` branch of the resource-type mapping decides, not the catalog.
    const url = 'https://securepubads.g.doubleclick.net/pcs/anything';
    const d = deriveA({
      requests: [
        req(url, { id: 'other', resourceType: 'other' }),
        // Counterexample: the same URL over a transport type is still a hit.
        req(url, { id: 'ping', resourceType: 'ping' }),
      ],
    });
    expect(d.requests.map((r) => [r.requestId, r.signatureId, r.kind, r.stage])).toEqual([
      ['other', undefined, 'resource', 'loaded'],
      ['ping', undefined, 'hit', 'event-sent'],
    ]);
    const only = deriveA({ requests: [req(url, { id: 'other', resourceType: 'other' })] });
    expect(only.services.find((s) => s.serviceId === 'google-ad-manager')?.stages).toEqual(['loaded']);
  });

  it('fromServiceWorker marks the initiator, not the answer: a network-answered SW request is delivered', () => {
    const ga = 'https://www.google-analytics.com/g/collect?v=2&tid=G-1';
    const d = deriveA({
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
        req(ga, { id: 'sw-answer', state: 'from-sw', provenance: 'service-worker', fromServiceWorker: true }),
        req(ga, { id: 'sw-provenance', state: 'completed', provenance: 'service-worker' }),
        req(ga, { id: 'cache', state: 'from-cache' }),
        req(ga, { id: 'plain', state: 'completed' }),
      ],
    });
    expect(d.requests.map((r) => [r.requestId, r.delivered])).toEqual([
      ['sw-initiator', true],
      ['sw-answer', false],
      ['sw-provenance', false],
      ['cache', false],
      ['plain', true],
    ]);
  });

  it('Consent Mode: cookieless ping when the relevant storage is denied', () => {
    const d = deriveA({
      requests: [
        req('https://www.google-analytics.com/g/collect?gcs=G100&cid=[redacted]', { id: 'a' }),
        req('https://www.google-analytics.com/g/collect?gcs=G101', { id: 'b' }),
        req('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/', {
          id: 'c',
          consentSignals: { gcd: '13p3p3p3p5' },
        }),
      ],
    });
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

  it('a video image is a thumbnail only by its catalog signature; a player beacon image is other', () => {
    const d = deriveA({
      requests: [
        req('https://i1.ytimg.com/vi/abc/hqdefault.jpg', { id: 'yt', resourceType: 'image' }),
        req('https://img.youtube.com/vi/abc/0.jpg', { id: 'img', resourceType: 'image' }),
        req('https://i.vimeocdn.com/video/123456789-abc_640', { id: 'vimeo', resourceType: 'image' }),
        req('https://www.youtube-nocookie.com/generate_204?abc', { id: 'beacon', resourceType: 'image' }),
        req('https://www.youtube.com/s/player/abc/player_ias.vflset/de_DE/base.js', {
          id: 'player',
          resourceType: 'script',
        }),
      ],
    });
    const integration = (id: string) => d.requests.find((r) => r.requestId === id)?.integration;
    expect(['yt', 'img', 'vimeo', 'beacon', 'player'].map(integration)).toEqual([
      'thumbnail',
      'thumbnail',
      'thumbnail',
      'other',
      'other',
    ]);
  });

  it('skips non-http requests', () => {
    const d = deriveA({ requests: [req('https://x.de/a', { id: 'a', url: 'data:image/png' })] });

    expect(d.requests).toEqual([]);
  });
});

describe('derive: requests of embedded frames', () => {
  const inFrame = (frameId: string, frameUrl: string | undefined) =>
    ({ isMainFrame: false, frameId, ...(frameUrl ? { frameUrl } : {}) }) as const;
  const player = inFrame('A-f2', 'https://www.youtube-nocookie.com/embed/abc?autoplay=[redacted]');

  it("a player's fonts and hosts of no catalog service belong to the player; services of their own keep theirs", () => {
    const d = deriveA({
      requests: [
        req('https://www.youtube-nocookie.com/embed/abc', { id: 'doc', resourceType: 'document', ...player }),
        req('https://fonts.gstatic.com/s/roboto/v48/a.woff2', {
          id: 'font',
          resourceType: 'font',
          ...player,
        }),
        req('https://www.google.com/js/th/a.js', { id: 'helper', resourceType: 'script', ...player }),
        req('https://helper.video-cdn.example/b', { id: 'xhr', resourceType: 'xhr', ...player }),
        req('https://googleads.g.doubleclick.net/pagead/id', { id: 'ads', resourceType: 'fetch', ...player }),
        req('https://fonts.gstatic.com/s/roboto/v48/a.woff2', { id: 'site-font', resourceType: 'font' }),
      ],
    });
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
      const d = deriveA({
        requests: [
          ...(loadsApi
            ? [req('https://maps.googleapis.com/maps/api/js?key=[redacted]', { id: 'api', ...frame })]
            : []),
          req('https://fonts.googleapis.com/css?family=Roboto', {
            id: 'css',
            resourceType: 'stylesheet',
            ...frame,
          }),
          req('https://fonts.gstatic.com/s/roboto/v48/a.woff2', {
            id: 'font',
            resourceType: 'font',
            ...frame,
          }),
          req('https://helper.unknown-host.example/a.js', { id: 'helper', resourceType: 'script', ...frame }),
        ],
      });
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

  it.each([
    ['an unknown host', 'https://static.builder.example', [null, 'none']],
    ['a CDN of the catalog (Wix)', 'https://static.parastorage.com', ['wix', 'catalog']],
  ])(
    "a builder's frame on %s takes the embed it loads; the builder's own hosts stay its own",
    (_case, origin, own) => {
      const builder = inFrame('A-f3', `${origin}/map.html?lang=[redacted]`);
      const d = deriveA({
        requests: [
          req(`${origin}/map.js`, { id: 'own', resourceType: 'script', ...builder }),
          req('https://fonts.googleapis.com/css?family=Roboto', {
            id: 'css',
            resourceType: 'stylesheet',
            ...builder,
          }),
          req('https://maps.googleapis.com/maps/api/js?key=[redacted]', { id: 'api', ...builder }),
        ],
      });
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
      const d = deriveA({
        requests: [
          req(embedUrl, { id: 'embed', resourceType: 'script', ...frame }),
          req('https://cdn.other-site.de/x.js', { id: 'unknown', resourceType: 'script', ...frame }),
          req('https://fonts.gstatic.com/s/inter/v1/a.woff2', { id: 'font', resourceType: 'font', ...frame }),
        ],
      });
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
    const d = deriveA({
      requests: [
        req('https://fonts.gstatic.com/s/roboto/v48/a.woff2', { id: 'font', resourceType: 'font', ...frame }),
        req('https://cdn.other-site.de/x.js', { id: 'unknown', ...frame }),
      ],
    });
    expect(d.requests.map((r) => [r.requestId, r.serviceId, r.source, r.frameServiceId])).toEqual([
      ['font', 'google-fonts', 'catalog', undefined],
      ['unknown', null, 'none', undefined],
    ]);
  });

  it.each([
    [
      'its first document is a redirect of the site to the player',
      [
        req('https://www.example.de/player', {
          id: 'hop',
          resourceType: 'document',
          isNavigation: true,
          ...inFrame('A-f9', 'https://www.example.de/player'),
          status: 302,
        }),
      ],
    ],
    [
      'its first request was made before the frame had an address',
      [req('https://cdn.other-site.de/boot.js', { id: 'hop', isMainFrame: false, frameId: 'A-f9' })],
    ],
  ])('a frame takes the service of its document when %s', (_case, before) => {
    const frame = inFrame('A-f9', 'https://www.youtube-nocookie.com/embed/abc');
    const d = deriveA({
      requests: [
        ...before,
        req('https://www.youtube-nocookie.com/embed/abc', {
          id: 'doc',
          resourceType: 'document',
          isNavigation: true,
          ...frame,
        }),
        req('https://i.ytimg.com/vi/abc/hqdefault.jpg', { id: 'thumb', resourceType: 'image', ...frame }),
        req('https://helper.video-cdn.example/b', { id: 'xhr', resourceType: 'xhr', ...frame }),
      ],
    });
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
    const d = deriveA({
      pages: [
        makePage({
          url: 'https://www.example.de/videos',
          dom: makeDom({
            iframes: [
              iframe('https://www.youtube-nocookie.com/embed/abc', { loading: 'lazy' }),
              iframe('https://www.example.de/widget.html'),
              iframe(null, { srcdoc: true }),
              iframe('about:blank'),
            ],
          }),
        }),
      ],
    });
    expect(d.frames).toEqual([
      {
        phase: 'A',
        pageUrl: 'https://www.example.de/videos',
        src: 'https://www.youtube-nocookie.com/embed/abc',
        thirdParty: true,
        serviceId: 'youtube-nocookie',
        category: 'video',
      },
      {
        phase: 'A',
        pageUrl: 'https://www.example.de/videos',
        src: 'https://www.example.de/widget.html',
        thirdParty: false,
        serviceId: null,
        category: 'unknown',
      },
    ]);
  });
});

describe('derive: cookies and storage', () => {
  it('known tracking identifiers, allowlist, unknown third party, setter context', () => {
    const d = deriveA({
      cookies: [
        makeCookie({ name: '_ga' }),
        makeCookie({ name: 'CookieConsent' }),
        makeCookie({ name: 'IDE', domain: 'doubleclick.net', firstParty: false }),
        makeCookie({ name: 'xyz', domain: 'tracker-unknown.com', firstParty: false }),
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
      makeCookie({ name: 'IDE', domain: 'doubleclick.net', firstParty: false, setter, setterHost });
    const serviceOf = (cookie: ReturnType<typeof makeCookie>) => deriveA({ cookies: [cookie] }).cookies[0];

    // The Google Ads conversion host answered with it: Google Ads, still a tracking identifier from the catalog.
    expect(serviceOf(ide('http-response', 'googleads.g.doubleclick.net'))).toMatchObject({
      serviceId: 'google-ads',
      tracking: true,
      source: 'catalog',
    });
    // A Floodlight host of the Marketing Platform keeps it there.
    expect(serviceOf(ide('http-response', 'ad.doubleclick.net'))?.serviceId).toBe(
      'google-marketing-platform',
    );
    // A script names the host it was loaded from, which may be the loader of another service.
    expect(serviceOf(ide('script', 'googleads.g.doubleclick.net'))?.serviceId).toBe(
      'google-marketing-platform',
    );
    // A host of another company never takes over a catalog cookie.
    expect(serviceOf(ide('http-response', 'static.hotjar.com'))?.serviceId).toBe('google-marketing-platform');
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
        makeCookie({
          name: 'test_cookie',
          domain: 'doubleclick.net',
          firstParty: false,
          lifetime: { kind: 'persistent', days: 0 },
        }),
        makeCookie({ name: '_gat_UA-0000000-1', lifetime: { kind: 'persistent', days: 0 } }),
      ],
      storage: [
        makeStorage({ key: 'rc::a', origin: 'https://www.google.com', firstParty: false }),
        makeStorage({
          key: 'ytidb::LAST_RESULT_ENTRY_KEY',
          origin: 'https://www.youtube-nocookie.com',
          firstParty: false,
        }),
        makeStorage({
          key: 'YtIdbMeta',
          storageType: 'indexedDB',
          origin: 'https://www.youtube-nocookie.com',
          firstParty: false,
        }),
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
        makeStorage({ key: 'yt-remote-device-id', origin: 'https://www.youtube.com', firstParty: false }),
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
        attribution: 'dsgvo-check service catalogue, © dsgvo-check contributors, Apache-2.0',
      },
    ]);
  });

  it('a service known only by its cookie was observed on the pages that wrote it', () => {
    const d = deriveA({
      cookies: [
        makeCookie({
          name: 'IDE',
          domain: 'doubleclick.net',
          firstParty: false,
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
      requests: [req('https://static.hotjar.com/c/hotjar-1.js', { id: 'a', state: 'failed' })],
    });

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

  it('the gcd letters come from the catalog, not from code', () => {
    const base = loadServiceCatalog().data;
    const own = new ServiceCatalog(
      parseCatalog({
        ...base,
        services: [],
        consentMode: { gcdDenied: ['z'], gcdGranted: ['y'] },
      }),
    );
    expect(decodeConsentMode(undefined, '11z1y1l1l', own)).toEqual({
      adStorage: 'denied',
      analyticsStorage: 'granted',
      source: 'gcd',
    });
    expect(decodeConsentMode(undefined, '11z1y1l1l')).toBeNull();
  });

  it('timingOf', () => {
    expect(timingOf({ phase: 'A' }, true)).toBe('before-interaction');
    expect(timingOf({ phase: 'B' }, false)).toBe('before-interaction');
    expect(timingOf({ phase: 'B' }, true)).toBe('after-reject');
    expect(timingOf({ phase: 'C' }, true)).toBe('after-accept');
  });
});
