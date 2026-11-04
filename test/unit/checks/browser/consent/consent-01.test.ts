import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../../src/checks/browser/consent-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import type { RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { loadServiceCatalog } from '../../../../../src/derive/catalog.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import type { SiteSpec } from '../helpers.ts';
import { CONTACT, click, cmpFacts, cmpWith, phase, req, START, site } from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-01']!.find((s) => s.file === file)!.build();
const run = (phases: SiteSpec['phases'], extra: SiteSpec = {}) =>
  runCheck(consent01, site({ phases, ...extra }));

describe('CONSENT-01 requests before interaction', () => {
  it('violation: GA4 hit with identifier → one observation per service, replicated in B before the click', () => {
    const r = runCheck(consent01, scenario('violation-ga4-hit.json'));
    expect(r.status).toBe('completed');
    const [o] = observationsOf(r);
    expect(observationsOf(r)).toHaveLength(1);
    expect(o).toMatchObject({
      variant: 'tracking-completed',
      confidence: 'high',
      subject: 'google-analytics',
      serviceId: 'google-analytics',
      category: 'analytics',
      phases: ['A', 'B'],
      replicated: true,
      provider: { name: 'Google Ireland Limited', country: 'IE' },
      parent: { name: 'Google LLC', country: 'US' },
      classification: { source: 'catalog', datasetVersion: loadServiceCatalog().version },
      params: { service: 'Google Analytics', requestCount: 3 },
    });
    expect(o?.evidence[0]).toMatchObject({
      type: 'request',
      delivery: 'sent',
      result: { kind: 'response' },
      features: { identifier: { kind: 'stored-match' } },
    });
  });

  it('clean: tracker only after accept (phase C) → nothing', () => {
    expect(variantsOf(runCheck(consent01, scenario('clean-after-accept-only.json')))).toEqual([]);
  });

  it('inconclusive: direct bot signal → SCAN-BOTMODE diagnostic', () => {
    const r = runCheck(consent01, scenario('inconclusive-bot-mode.json'));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
    expect(r.outcome?.diagnostics).toEqual([
      { code: 'SCAN-BOTMODE', affects: ['CONSENT-01'], params: { signal: 'cookiebot:isSpider' } },
    ]);
  });

  it('geo signal → inconclusive with SCAN-GEO', () => {
    const r = run([phase('A', { requests: [req('a', 'https://connect.facebook.net/en_US/fbevents.js')] })], {
      cmp: cmpWith({
        phase: 'B',
        facts: [cmpFacts({ geoSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isOutOfRegion' }] })],
      }),
    });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'geo' });
  });

  it('counterexample: GTM library without a hit → library-loaded (warning), not a tracking hit', () => {
    const r = run([
      phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC')] }),
    ]);
    expect(variantsOf(r)).toEqual(['library-loaded']);
    expect(observationsOf(r)[0]).toMatchObject({ category: 'tag-manager', serviceId: 'google-tag-manager' });
  });

  it('counterexample: request blocked by CSP/browser → request-not-confirmed (info)', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://region1.google-analytics.com/g/collect?cid=[redacted]', {
            state: 'blocked-by-browser',
            identifierPresent: true,
            status: undefined,
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['request-not-completed']);
  });

  it('counterexample: only an unknown third-party domain → unknown-host (info), aggregated per eTLD+1', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://cdn.unknown-widget.net/a.js'),
          req('b', 'https://img.unknown-widget.net/b.png', { resourceType: 'image', pageUrl: CONTACT }),
        ],
      }),
    ]);
    const obs = observationsOf(r);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      variant: 'unknown-host',
      subject: 'unknown:unknown-widget.net',
      classification: { source: 'none' },
      params: { service: 'unknown-widget.net', requestCount: 2, pageCount: 2 },
    });
    expect(obs[0]?.serviceId).toBeUndefined();
  });

  it('cookieless Consent Mode ping → cookieless-ping (warning)', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]', {
            resourceType: 'ping',
            identifierPresent: true,
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['cookieless-ping']);
  });

  const gaHit = (id: string, p: Partial<Parameters<typeof req>[2]> = {}) =>
    req(id, 'https://region1.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]&en=page_view', {
      resourceType: 'ping',
      ...p,
    });

  it('GAM compression dictionary (resourceType other) and gpt.js → library-loaded, not cookieless-ping', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://securepubads.g.doubleclick.net/pagead/managed/dict/abc/def', {
            resourceType: 'other',
          }),
          req('b', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.subject, o.variant])).toEqual([
      ['google-ad-manager', 'library-loaded'],
    ]);
  });

  it('an `other` request on a path without a signature and gpt.js → library-loaded, not cookieless-ping', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://securepubads.g.doubleclick.net/pcs/anything', { resourceType: 'other' }),
          req('b', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.subject, o.variant])).toEqual([
      ['google-ad-manager', 'library-loaded'],
    ]);
  });

  it('counterexample: an ad request through fetch is still a hit (cookieless-ping without identifier)', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://securepubads.g.doubleclick.net/gampad/ads?iu=x', { resourceType: 'fetch' }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['cookieless-ping']);
  });

  it('Piano identity, experience and checkout calls over xhr/fetch (EU and non-EU hosts) → library-loaded, not cookieless-ping', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://id.piano.io/api/v1/identity/login/token?aid=x', { resourceType: 'xhr' }),
          req('b', 'https://experience.piano.io/xbuilder/experience/execute?aid=x', {
            resourceType: 'fetch',
          }),
          req('c', 'https://buy.piano.io/checkout/offer/show', { resourceType: 'fetch' }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.subject, o.variant, o.params.identifierKind])).toEqual([
      ['piano', 'library-loaded', 'none'],
    ]);
  });

  it('counterexample: the Piano engagement ping is still a hit (cookieless-ping without identifier)', () => {
    const r = run([
      phase('A', {
        requests: [req('a', 'https://c2.piano.io/page/track/engagement', { resourceType: 'xhr' })],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['cookieless-ping']);
  });

  it('a Chartbeat ping or ScorecardResearch beacon before the interaction → cookieless-ping, not tracking-completed', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://ping.chartbeat.net/ping?h=example.de&p=%2F', { resourceType: 'image' }),
          req('b', 'https://sb.scorecardresearch.com/b?c1=2&c2=1000', { resourceType: 'image' }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.subject, o.category, o.variant, o.params.identifierKind])).toEqual(
      [
        ['chartbeat', 'analytics', 'cookieless-ping', 'none'],
        ['scorecardresearch', 'analytics', 'cookieless-ping', 'none'],
      ],
    );
  });

  it('the Tealium library (utag.js) → library-loaded; a Chartbeat strategy call is no hit (counterexamples)', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://tags.tiqcdn.com/utag/acme/main/prod/utag.js', { resourceType: 'script' }),
          req('b', 'https://mab.chartbeat.com/mab_strategy/example.de/', { resourceType: 'xhr' }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.subject, o.category, o.variant])).toEqual([
      ['chartbeat', 'analytics', 'library-loaded'],
      ['tealium', 'tag-manager', 'library-loaded'],
    ]);
  });

  it('a GA4 hit issued by a service worker and answered by the network is tracking-completed, not request-not-completed', () => {
    const r = run([
      phase('A', {
        requests: [
          gaHit('a', {
            fromServiceWorker: true,
            state: 'completed',
            delivery: 'sent',
            result: { kind: 'response', status: 200 },
            provenance: 'network',
            matchesStoredIdentifier: true,
            identifierPresent: true,
            identifierNames: ['cid'],
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['tracking-completed']);
  });

  it('counterexample: the answer itself came from the service worker → request-not-completed', () => {
    const r = run([
      phase('A', {
        requests: [
          gaHit('a', {
            fromServiceWorker: true,
            state: 'from-sw',
            provenance: 'service-worker',
            matchesStoredIdentifier: true,
            identifierPresent: true,
            identifierNames: ['cid'],
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['request-not-completed']);
  });

  it('a redacted `cid` key with an empty value before redaction is no identifier → cookieless-ping', () => {
    const r = run([phase('A', { requests: [gaHit('a', { identifierPresent: false })] })]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.identifierKind])).toEqual([
      ['cookieless-ping', 'none'],
    ]);
  });

  it('a per-load identifier (generic `uuid`, no stored match, no catalog param) → cookieless-ping (warning)', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://in.hotjar.com/api/v2/client', {
            resourceType: 'xhr',
            identifierPresent: true,
            identifierNames: ['uuid'],
          }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.category, o.params.identifierKind])).toEqual([
      ['cookieless-ping', 'session-recording', 'per-load'],
    ]);
  });

  it.each<[string, Partial<RequestRecord>]>([
    ['stored-match', { identifierNames: ['cid'], matchesStoredIdentifier: true }],
    ['persistent-param', { identifierNames: ['cid'] }],
    ['user-supplied', { identifierNames: ['gclid'] }],
  ])('persistent identifier %s → tracking-completed', (kind, p) => {
    const r = run([phase('A', { requests: [gaHit('a', { identifierPresent: true, ...p })] })]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.identifierKind])).toEqual([
      ['tracking-completed', kind],
    ]);
  });

  it('response headers received, then the body aborted (beacon on navigation) → still a completed hit', () => {
    const r = run([
      phase('A', {
        requests: [
          gaHit('a', {
            identifierPresent: true,
            identifierNames: ['cid'],
            state: 'failed',
            status: 204,
            delivery: 'sent',
            result: { kind: 'failed', errorText: 'net::ERR_ABORTED' },
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['tracking-completed']);
  });

  it('Consent Mode denied does not hide a stored identifier match → tracking-completed', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]', {
            resourceType: 'ping',
            identifierPresent: true,
            identifierNames: ['cid'],
            matchesStoredIdentifier: true,
          }),
        ],
      }),
    ]);
    expect(
      observationsOf(r).map((o) => [o.variant, o.params.identifierKind, o.params.consentModeDenied]),
    ).toEqual([['tracking-completed', 'stored-match', true]]);
  });

  it('counterexample: denied ping whose `cid` is only a catalog param (per-load in Consent Mode) → cookieless-ping', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]', {
            resourceType: 'ping',
            identifierPresent: true,
            identifierNames: ['cid'],
          }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.consentModeDenied])).toEqual([
      ['cookieless-ping', true],
    ]);
  });

  it.each([
    ['cdn', 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js', 'jsdelivr'],
    ['payment', 'https://js.stripe.com/v3/', 'stripe'],
    ['consent-provider', 'https://consent.cookiebot.com/uc.js', 'cookiebot'],
    ['monitoring', 'https://browser.sentry-cdn.com/7.0.0/bundle.min.js', 'sentry'],
  ])(
    '%s before interaction → third-party-resource (info), not library-loaded',
    (category, url, serviceId) => {
      const r = run([phase('A', { requests: [req('a', url)] })]);
      expect(observationsOf(r).map((o) => [o.variant, o.category, o.serviceId])).toEqual([
        ['third-party-resource', category, serviceId],
      ]);
    },
  );

  it('a main-frame navigation to a third party (redirect via CMP or SSO) is no request finding', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://consent.cookiebot.com/redirect', {
            resourceType: 'document',
            isNavigation: true,
          }),
          req('b', 'https://connect.facebook.net/en_US/fbevents.js', {
            resourceType: 'document',
            isNavigation: true,
            isMainFrame: true,
          }),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual([]);
  });

  it('start page hit without an observed phase B → no `replicated` claim either way', () => {
    const r = run([
      phase('A', { requests: [gaHit('a', { identifierPresent: true, identifierNames: ['cid'] })] }),
      phase('B', { status: 'skipped', pages: [] }),
    ]);
    const [o] = observationsOf(r);
    expect(o?.variant).toBe('tracking-completed');
    expect(o?.replicated).toBeUndefined();
  });

  it('first-party proxy (tag gateway) → first-party-proxy with medium confidence', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', `${START}metrics/g/collect?v=2&tid=G-1&cid=[redacted]`, { identifierPresent: true }),
        ],
      }),
    ]);
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'first-party-proxy',
      confidence: 'medium',
      subject: 'google-analytics',
    });
  });

  it('routing: fonts, maps and video belong to EMBED-* and are not reported here; first-party assets never', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://fonts.gstatic.com/s/x.woff2', { resourceType: 'font' }),
          req('b', 'https://www.google.com/maps/embed?pb=[redacted]', { resourceType: 'document' }),
          req('c', 'https://www.youtube-nocookie.com/embed/abc', { resourceType: 'document' }),
          req('d', `${START}app.js`),
        ],
      }),
    ]);
    expect(variantsOf(r)).toEqual([]);
  });

  it('requests after the click in B and in C are not "before interaction"; A not replicated in B → replicated: false', () => {
    const r = run([
      phase('A', { requests: [req('a', 'https://connect.facebook.net/en_US/fbevents.js')] }),
      phase('B', {
        click: click('reject'),
        requests: [
          req('b', 'https://www.facebook.com/tr/?id=1&fbp=[redacted]', { phase: 'B', afterClick: true }),
        ],
      }),
    ]);
    const obs = observationsOf(r);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ variant: 'library-loaded', phases: ['A'], replicated: false });
  });

  it('no phase A → inconclusive', () => {
    expect(run([phase('A', { status: 'skipped', pages: [] })])).toMatchObject({
      status: 'inconclusive',
      reason: 'no-pre-consent-observation',
    });
  });

  it('missing browser section with collector skipped → skipped', () => {
    const snap = site();
    const { browser: _b, derived: _d, ...rest } = snap;
    const r = runCheck(consent01, {
      ...rest,
      collection: { browser: { status: 'skipped', reason: 'tls-blocked', durationMs: 0 } },
    });
    expect(r).toMatchObject({ status: 'skipped', reason: 'tls-blocked' });
  });
});

describe('CONSENT-01 texts name what was counted', () => {
  const body = (lang: 'de' | 'en', variant: string, params: Record<string, unknown>) =>
    renderMessage(loadTexts(lang), `CONSENT-01.${variant}`, params as never).body;

  it('unknown-host: the request count covers every host of the domain, and the text names them all', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://cdn.unknown-widget.net/a.js'),
          req('b', 'https://cdn.unknown-widget.net/b.js'),
          req('c', 'https://cdn.unknown-widget.net/c.js'),
          req('d', 'https://img.unknown-widget.net/d.png', { resourceType: 'image' }),
        ],
      }),
    ]);
    const [o] = observationsOf(r);
    expect(o?.params).toMatchObject({
      service: 'unknown-widget.net',
      host: 'cdn.unknown-widget.net',
      hosts: 'cdn.unknown-widget.net, img.unknown-widget.net',
      hostCount: 2,
      requestCount: 4,
    });
    expect(body('de', 'unknown-host', o!.params)).toContain(
      'wurden 4 Anfragen an 2 Hosts der Domain unknown-widget.net (cdn.unknown-widget.net, img.unknown-widget.net) beobachtet; sie wurden keinem Dienst des Dienstekatalogs zugeordnet',
    );
    expect(body('en', 'unknown-host', o!.params)).toContain(
      '4 requests to 2 hosts of the domain unknown-widget.net (cdn.unknown-widget.net, img.unknown-widget.net) were observed',
    );
  });

  it('unknown-host with one request: singular verb, the host named', () => {
    const [o] = observationsOf(
      run([phase('A', { requests: [req('a', 'https://cdn.unknown-widget.net/a.js')] })]),
    );
    expect(body('de', 'unknown-host', o!.params)).toContain(
      'wurde 1 Anfrage an den Host cdn.unknown-widget.net beobachtet; sie wurde keinem Dienst',
    );
    expect(body('en', 'unknown-host', o!.params)).toContain(
      '1 request to the host cdn.unknown-widget.net was observed',
    );
  });

  it('third-party-resource names only the category of its service', () => {
    const [o] = observationsOf(
      run([phase('A', { requests: [req('a', 'https://browser.sentry-cdn.com/7.0.0/bundle.min.js')] })]),
    );
    expect(o).toMatchObject({
      variant: 'third-party-resource',
      params: { category: 'monitoring', requestCount: 1 },
    });
    const de = body('de', 'third-party-resource', o!.params);
    expect(de).toContain('wurde 1 Anfrage an Sentry');
    expect(de).toContain('(Kategorie laut Dienstekatalog: Fehleranalyse)');
    expect(de).not.toMatch(/Zahlungsdienst|Einwilligungsverwaltung/);
    expect(body('en', 'third-party-resource', o!.params)).toContain(
      '1 request to Sentry (browser.sentry-cdn.com) was observed',
    );
  });

  it('without any banner the text does not speak of an interaction with it', () => {
    const requests = [req('a', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC')];
    const [none] = observationsOf(run([phase('A', { requests })]));
    expect(none?.params.bannerFound).toBe(false);
    expect(body('de', 'library-loaded', none!.params)).toMatch(
      /^Vor jeder Interaktion \(kein Einwilligungsbanner gefunden\)/,
    );
    expect(body('en', 'library-loaded', none!.params)).toMatch(
      /^Before any interaction \(no consent banner found\)/,
    );

    const [seen] = observationsOf(
      run([phase('A', { requests })], { cmp: cmpWith({ phase: 'B', facts: [cmpFacts()] }) }),
    );
    expect(seen?.params.bannerFound).toBe(true);
    expect(body('de', 'library-loaded', seen!.params)).toMatch(
      /^Vor einer Interaktion mit dem Einwilligungsbanner/,
    );
  });

  it('a font file of a host outside the catalog is left to EMBED-01; the other requests of the host stay', () => {
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://cdn.booking-widget.example/v1/sdk.js'),
          req('b', 'https://cdn.booking-widget.example/fonts/Display-Regular.ttf', { resourceType: 'font' }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.requestCount])).toEqual([['unknown-host', 1]]);
  });

  it('a tracker inside the frame of an embedded map: attributed to the tracker, linked to the map finding', () => {
    const frame = {
      frameId: 'A-f2',
      isMainFrame: false,
      frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
    };
    const r = run([
      phase('A', {
        requests: [
          req('a', 'https://www.google.com/maps/embed?pb=[redacted]', {
            ...frame,
            isNavigation: true,
            resourceType: 'document',
            pageUrl: CONTACT,
          }),
          req(
            'b',
            'https://region1.google-analytics.com/g/collect?v=2&tid=G-MAP1&cid=[redacted]&en=page_view',
            {
              ...frame,
              resourceType: 'ping',
              identifierPresent: true,
              identifierNames: ['cid'],
              pageUrl: CONTACT,
            },
          ),
          req('c', 'https://helper.unknown-host.example/t.js', { ...frame, pageUrl: CONTACT }),
        ],
      }),
    ]);
    const obs = observationsOf(r);
    // The unknown helper host of the frame is part of the map (EMBED-02), not a host of the site.
    expect(obs.map((o) => o.subject)).toEqual(['google-analytics']);
    expect(obs[0]).toMatchObject({
      params: { embeddedCount: 1, embeddedIn: 'Google Maps' },
      related: [{ checkId: 'EMBED-02', subject: 'google-maps', relation: 'embedded-in' }],
    });
    expect(body('de', obs[0]!.variant, obs[0]!.params)).toContain(
      '1 dieser Anfragen stammte aus dem Rahmen des eingebetteten Dienstes Google Maps.',
    );
  });
});
