/** Own service catalog: schema, coverage of the catalog's priority services, URL and cookie matching. */
import { describe, expect, it } from 'vitest';
import { loadServiceCatalog, parseCatalog, ServiceCatalog } from '../../../src/derive/catalog.ts';

const catalog = loadServiceCatalog();

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
