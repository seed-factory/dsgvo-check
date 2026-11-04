/** Own service catalog: schema, coverage of the catalog's priority services, URL and cookie matching. */
import { describe, expect, it } from 'vitest';
import { loadServiceCatalog, parseCatalog, ServiceCatalog } from '../../../src/derive/catalog.ts';

const catalog = loadServiceCatalog();

const emptyCatalog = () => ({
  catalog: { name: 'x', version: '1', date: '2026-10-30', license: 'Apache-2.0' },
  categories: catalog.data.categories,
  userSuppliedParams: catalog.data.userSuppliedParams,
  consentMode: catalog.data.consentMode,
  allowlist: { version: '1', cookies: {} },
});

describe('service catalog data', () => {
  it('loads with metadata, ~60+ unique services and an allowlist version', () => {
    expect(catalog.data.catalog).toMatchObject({ name: 'dsgvo-check-services', license: 'Apache-2.0' });
    expect(catalog.byId.size).toBeGreaterThanOrEqual(60);
    // The allowlist version is catalog data and changes with the allowlist: assert the shape, not the number.
    expect(catalog.allowlistVersion).toMatch(/^\d+$/);
  });

  it('contains the services named in the check catalog and the brief', () => {
    for (const id of [
      'google-analytics',
      'google-tag-manager',
      'google-ads',
      'google-marketing-platform',
      'meta-pixel',
      'hotjar',
      'microsoft-clarity',
      'linkedin-insight-tag',
      'tiktok-pixel',
      'pinterest-tag',
      'matomo-cloud',
      'google-fonts',
      'adobe-fonts',
      'font-awesome-cdn',
      'bunny-fonts',
      'google-maps',
      'openstreetmap',
      'mapbox',
      'youtube',
      'youtube-nocookie',
      'vimeo',
      'google-recaptcha',
      'hcaptcha',
      'cloudflare-turnstile',
      'friendly-captcha',
      'elfsight',
      'trustindex',
      'instagram',
      'facebook',
      'provenexpert',
      'trustpilot',
      'calendly',
      'cookiebot',
      'usercentrics',
      'borlabs-cookie',
      'jsdelivr',
      'cdnjs',
      'unpkg',
      'cloudflare-cdn',
      'stripe',
      'paypal',
      'sentry',
      'intercom',
      'zendesk',
      'tawk-to',
    ]) {
      expect(catalog.byId.has(id), id).toBe(true);
    }
  });

  it('every domain belongs to exactly one service', () => {
    const owner = new Map<string, string>();
    const dupes: string[] = [];
    for (const s of catalog.data.services) {
      for (const d of s.domains) {
        if (owner.has(d)) dupes.push(`${d}: ${owner.get(d)} / ${s.id}`);
        owner.set(d, s.id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('services relevant for the privacy policy have aliases and a category with terms', () => {
    for (const s of catalog.data.services.filter((x) => x.policyRelevance === 'required')) {
      expect(s.aliasesDe.length + s.aliasesEn.length, s.id).toBeGreaterThan(0);
      expect(catalog.categoryTerms(s.category).length, s.category).toBeGreaterThan(0);
    }
  });

  it('dpfEntity is never claimed as checked (listed/checkedAt stay null until verified)', () => {
    for (const s of catalog.data.services) {
      if (s.dpfEntity) expect(s.dpfEntity, s.id).toMatchObject({ listed: null, checkedAt: null });
    }
  });

  it('rejects unknown fields and invalid regexes', () => {
    const base = {
      catalog: { name: 'x', version: '1', date: '2026-10-30', license: 'Apache-2.0' },
      categories: catalog.data.categories,
      userSuppliedParams: catalog.data.userSuppliedParams,
      consentMode: catalog.data.consentMode,
      allowlist: { version: '1', cookies: {} },
    };
    const svc = { id: 'a', name: 'A', category: 'analytics', policyRelevance: 'required' };

    expect(() => parseCatalog({ ...base, services: [{ ...svc, typo: 1 }] })).toThrow(/typo/);
    expect(() =>
      parseCatalog({
        ...base,
        services: [{ ...svc, signatures: [{ id: 's', anyHost: true, path: '(', kind: 'hit' }] }],
      }),
    ).toThrow(/invalid regular expression/);
    expect(() => new ServiceCatalog(parseCatalog({ ...base, services: [svc, svc] }))).toThrow(/duplicate/);
    expect(() => parseCatalog({ ...base, services: [], userSuppliedParams: ['GCLID'] })).toThrow(
      /userSuppliedParams.*lower case/,
    );
    expect(() =>
      parseCatalog({ ...base, services: [], consentMode: { gcdDenied: ['p'], gcdGranted: ['p'] } }),
    ).toThrow(/both denied and granted/);
  });

  it.each([
    ['an unanchored host pattern', { hostPatterns: ['www\\.vendor\\.[a-z]{2}'] }, /must be anchored/],
    ['a host pattern that does not compile', { hostPatterns: ['^(www$'] }, /invalid regular expression/],
    ['no hosts, host patterns or any-host', {}, /needs hosts, hostPatterns or anyHost/],
  ])('rejects a signature with %s', (_case, hosts, message) => {
    const services = [
      {
        id: 'a',
        name: 'A',
        category: 'ads',
        policyRelevance: 'required',
        signatures: [{ id: 's', path: '^/', kind: 'hit', ...hosts }],
      },
    ];
    expect(() => parseCatalog({ ...emptyCatalog(), services })).toThrow(message);
  });

  it('a service operated by its own company names it as provider, not as parent', () => {
    expect(catalog.info('sentry')).toMatchObject({
      provider: { name: 'Functional Software, Inc.', country: 'US' },
      companyAliases: expect.arrayContaining(['Functional Software', 'Functional Software, Inc.']),
    });
    expect(catalog.info('sentry')?.parent).toBeUndefined();
    expect(catalog.byId.get('sentry')?.dpfEntity).toMatchObject({ name: 'Functional Software, Inc.' });
  });
});

describe('URL matching', () => {
  const cases: Array<[string, string | null, string | null]> = [
    [
      'https://www.google-analytics.com/g/collect?v=2&tid=G-1&cid=[redacted]',
      'google-analytics',
      'ga4-collect',
    ],
    ['https://region1.google-analytics.com/g/collect', 'google-analytics', 'ga4-collect'],
    ['https://www.googletagmanager.com/gtag/js?id=G-ABC', 'google-analytics', 'gtag-ga4'],
    ['https://www.googletagmanager.com/gtag/js?id=AW-123', 'google-ads', 'gtag-aw'],
    ['https://www.googletagmanager.com/gtm.js?id=GTM-XYZ', 'google-tag-manager', 'gtm-js'],
    ['https://connect.facebook.net/en_US/fbevents.js', 'meta-pixel', 'fbevents'],
    ['https://www.facebook.com/tr/?id=1&ev=[redacted]', 'meta-pixel', 'tr'],
    ['https://connect.facebook.net/de_DE/sdk.js', 'facebook', 'sdk'],
    ['https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/', 'google-ads', 'conversion'],
    ['https://static.hotjar.com/c/hotjar-123.js?sv=6', 'hotjar', 'loader'],
    ['https://www.google.com/maps/embed?pb=[redacted]', 'google-maps', 'embed'],
    ['https://maps.googleapis.com/maps/api/staticmap?center=[redacted]', 'google-maps', 'static'],
    ['https://www.google.com/recaptcha/api.js', 'google-recaptcha', 'api'],
    ['https://fonts.googleapis.com/css2?family=Roboto', 'google-fonts', 'css'],
    ['https://fonts.gstatic.com/s/roboto/v30/x.woff2', 'google-fonts', 'font'],
    ['https://use.typekit.net/abc1234.css', 'adobe-fonts', 'kit-css'],
    [
      'https://cdn.jsdelivr.net/npm/friendly-challenge@0.9.12/widget.module.min.js',
      'friendly-captcha',
      'widget-cdn',
    ],
    ['https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js', 'jsdelivr', null],
    ['https://www.youtube-nocookie.com/embed/abc', 'youtube-nocookie', 'embed'],
    ['https://i.ytimg.com/vi/abc/hqdefault.jpg', 'youtube', 'thumbnail'],
    ['https://cdn.trustindex.io/loader.js', 'trustindex', null],
    ['https://tile.openstreetmap.org/1/2/3.png', 'openstreetmap', 'tiles'],
    ['https://www.google.com/search?q=x', null, null],
    ['https://cdn.example-unknown.net/app.js', null, null],
    // Google Ads hits on AdSense and DoubleClick hosts; the other paths of these hosts keep their own service.
    [
      'https://pagead2.googlesyndication.com/ccm/collect?tid=AW-000000001&en=page_view',
      'google-ads',
      'syndication-ccm',
    ],
    ['https://pagead2.googlesyndication.com/ccm/collect?en=page_view', 'google-adsense', null],
    [
      'https://pagead2.googlesyndication.com/pagead/conversion/000000001/?random=[redacted]',
      'google-ads',
      'syndication-conversion',
    ],
    ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'google-adsense', null],
    ['https://ad.doubleclick.net/ccm/s/collect?auid=[redacted]', 'google-ads', 'doubleclick-ccm'],
    [
      'https://ad.doubleclick.net/activity;src=1;type=x;cat=y;ord=1',
      'google-marketing-platform',
      'floodlight',
    ],
    ['https://ad.doubleclick.net/ddm/activity/src=1;type=x', 'google-marketing-platform', 'floodlight'],
    ['https://fls.doubleclick.net/activityi;src=1', 'google-marketing-platform', 'floodlight'],
    ['https://ad.doubleclick.net/ddm/trackclk/N1.2/B3', 'google-marketing-platform', null],
    ['https://www.googleadservices.com/ccm/conversion/000000001/', 'google-ads', 'conversion'],
    // Country domains of Google search: the host the visitor is served depends on the egress, not on the site.
    ['https://www.google.fr/pagead/1p-user-list/000000001/', 'google-ads', 'google-domain-hit'],
    ['https://www.google.co.uk/pagead/1p-conversion/000000001/', 'google-ads', 'google-domain-hit'],
    ['https://www.google.com.br/rmkt/collect/000000001/', 'google-ads', 'google-domain-hit'],
    ['https://www.google.com/ccm/collect?auid=[redacted]', 'google-ads', 'google-domain-hit'],
    ['https://www.google.de/gmp/conversion/000000001/', 'google-marketing-platform', 'gmp-conversion'],
    ['https://www.google.fr/ads/ga-audiences?t=sr&tid=UA-0000000-1', 'google-analytics', 'ga-audiences'],
    ['https://www.google.fr/search?q=x', null, null],
    ['https://www.google.example.test/pagead/1p-user-list/1/', null, null],
    ['https://maps.google.fr/pagead/1p-user-list/1/', null, null],
    // Self-hosted CCM19 in any install directory of any host; the path alone is not enough.
    [
      'https://consent.agency.example/cmp/public/app.js?apiKey=[redacted]&domain=[redacted]',
      'ccm19',
      'self-hosted-app',
    ],
    [
      'https://consent.agency.example/cmp/public/widget?apiKey=[redacted]&domain=[redacted]&lang=[redacted]',
      'ccm19',
      'self-hosted-api',
    ],
    ['https://cdn.example-unknown.net/public/app.js', null, null],
    // Site builder, booking, chat and translation widgets.
    ['https://static.parastorage.com/services/wix-thunderbolt/dist/main.js', 'wix', null],
    ['https://static.wixstatic.com/media/a.png', 'wix', null],
    ['https://frog.wix.com/bolt-performance?src=[redacted]', 'wix-monitoring', null],
    ['https://panorama.wixapps.net/api/v1/bulklog', 'wix-monitoring', null],
    ['https://v5.widgets.dirs21.de/quickbook.js', 'dirs21', null],
    ['https://code.tidio.co/abc.js', 'tidio', null],
    ['https://cdn.weglot.com/weglot.min.js', 'weglot', null],
  ];
  it.each(cases)('%s → %s', (url, serviceId, signature) => {
    const m = catalog.matchUrl(new URL(url));
    expect(m?.service.id ?? null).toBe(serviceId);
    expect(m?.signature?.id ?? null).toBe(signature);
  });

  it('path signatures match on any host (first-party proxy / self-hosted)', () => {
    expect(catalog.matchUrl(new URL('https://www.shop.de/metrics/g/collect?tid=G-1'))).toMatchObject({
      via: 'any-host',
      service: { id: 'google-analytics' },
    });
    expect(catalog.matchUrl(new URL('https://stats.shop.de/matomo.php?idsite=1'))).toMatchObject({
      via: 'any-host',
      service: { id: 'matomo', selfHostable: true },
    });
  });
});

describe('cookie and storage names', () => {
  it('matches tracking identifiers, domain-restricted names and globs', () => {
    expect(catalog.matchCookie('_ga', 'example.de')).toMatchObject({
      service: { id: 'google-analytics' },
      tracking: true,
    });
    expect(catalog.matchCookie('_ga_ABC123', 'example.de')?.service.id).toBe('google-analytics');
    expect(catalog.matchCookie('_gat_UA-1', 'example.de')).toMatchObject({ tracking: false });
    expect(catalog.matchCookie('IDE', 'doubleclick.net')?.service.id).toBe('google-marketing-platform');
    expect(catalog.matchCookie('IDE', 'example.de')).toBeNull();
    expect(catalog.matchCookie('_pk_id.1.a1b2', 'example.de')?.service.id).toBe('matomo');
    expect(catalog.matchStorage('_gcl_ls', 'www.example.de')?.service.id).toBe('google-ads');
  });

  it.each([
    ['rc::a', 'www.google.com', 'google-recaptcha'],
    ['rc::c', 'www.recaptcha.net', 'google-recaptcha'],
    ['ytidb::LAST_RESULT_ENTRY_KEY', 'www.youtube-nocookie.com', 'youtube-nocookie'],
    ['YtIdbMeta', 'www.youtube-nocookie.com', 'youtube-nocookie'],
    ['YtIdbMeta', 'www.youtube.com', 'youtube'],
  ])('known storage entry %s of %s is no identifier of %s', (key, origin, serviceId) => {
    expect(catalog.matchStorage(key, origin)).toMatchObject({ service: { id: serviceId }, tracking: false });
  });

  it('known storage entries are bound to the origin of their service', () => {
    expect(catalog.matchStorage('rc::a', 'www.example.de')).toBeNull();
    expect(catalog.matchStorage('YtIdbMeta', 'www.example.de')).toBeNull();
  });

  it.each([
    ['test_cookie', 'doubleclick.net', 'google-marketing-platform'],
    ['ssr-caching', 'www.example.de', 'wix'],
    ['TESTCOOKIESENABLED', 'www.youtube-nocookie.com', 'youtube-nocookie'],
  ])('known cookie %s on %s is no identifier of %s', (name, domain, serviceId) => {
    expect(catalog.matchCookie(name, domain)).toMatchObject({ service: { id: serviceId }, tracking: false });
  });

  it('allowlist classes are case-insensitive', () => {
    expect(catalog.allowlistedCookie('CookieConsent')).toBe('consent');
    expect(catalog.allowlistedCookie('phpsessid')).toBe('session');
    expect(catalog.allowlistedCookie('XSRF-TOKEN')).toBe('csrf');
    expect(catalog.allowlistedCookie('borlabs-cookie')).toBe('consent');
    expect(catalog.allowlistedCookie('_ga')).toBeNull();
    expect(catalog.allowlistedStorage('uc_settings')).toBe('consent');
  });

  it('exposes check-facing info with company aliases and category terms', () => {
    const info = catalog.info('trustindex');
    expect(info).toMatchObject({ serviceId: 'trustindex', category: 'reviews', policyRelevance: 'required' });
    expect(info?.companyAliases).toContain('Trustindex Kft.');
    expect(info?.categoryTerms).toContain('Kundenbewertungen');
    expect(catalog.info('nope')).toBeNull();
  });
});
