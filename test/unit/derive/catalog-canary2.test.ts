/**
 * Catalog entries from the canary2 fixes: G31 (ad-tech, analytics, tag and consent vendors) and G36 (consent-state
 * allowlist). Synthetic requests only: vendor domains from the catalog, no corpus site names or ids.
 */
import { describe, expect, it } from 'vitest';
import { loadServiceCatalog } from '../../../src/derive/catalog.ts';
import { derive } from '../../../src/derive/index.ts';
import {
  makeBrowser,
  makeCookie,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeStorage,
  makeTarget,
} from '../../utils/snapshot-builder.ts';

const catalog = loadServiceCatalog();

const snap = (phases: ReturnType<typeof makePhase>[]) =>
  makeSnapshot({ target: makeTarget('https://www.example.de/'), browser: makeBrowser({ phases }) });

type RequestExtra = Omit<Parameters<typeof makeRequest>[0], 'url'>;

/** Requests of one phase A page, derived; `extra` sets the collector facts (identifier names, resource type). */
const requestsOf = (...items: Array<[string, RequestExtra?]>) =>
  derive(
    snap([
      makePhase('A', {
        requests: items.map(([url, extra = {}], i) => makeRequest({ id: `r${i}`, url, ...extra })),
      }),
    ]),
  ).requests;

/** G31: service and domain of every new vendor (one entry per domain of the vendor). */
const VENDOR_DOMAINS: Array<[serviceId: string, domain: string]> = [
  ['the-trade-desk', 'adsrvr.org'],
  ['xandr', 'adnxs.com'],
  ['pubmatic', 'pubmatic.com'],
  ['magnite', 'rubiconproject.com'],
  ['bidswitch', 'bidswitch.net'],
  ['equativ', 'smartadserver.com'],
  ['amazon-ads', 'amazon-adsystem.com'],
  ['lotame', 'crwdcntrl.net'],
  ['id5', 'id5-sync.com'],
  ['teads', 'teads.tv'],
  ['taboola', 'taboola.com'],
  ['outbrain', 'outbrain.com'],
  ['index-exchange', 'casalemedia.com'],
  ['index-exchange', 'indexww.com'],
  ['openx', 'openx.net'],
  ['openx', 'openxcdn.net'],
  ['adform', 'adform.net'],
  ['google-ima', 'imasdk.googleapis.com'],
  ['scorecardresearch', 'scorecardresearch.com'],
  ['piano', 'piano.io'],
  ['piano', 'cxense.com'],
  ['tealium', 'tiqcdn.com'],
  ['tealium', 'tealiumiq.com'],
  ['chartbeat', 'chartbeat.com'],
  ['chartbeat', 'chartbeat.net'],
  ['optimizely', 'optimizely.com'],
  ['piwik-pro', 'piwik.pro'],
  ['nielsen', 'imrworldwide.com'],
  ['siteimprove', 'siteimproveanalytics.com'],
  ['siteimprove', 'siteimproveanalytics.io'],
  ['sourcepoint', 'privacy-mgmt.com'],
  ['funding-choices', 'fundingchoicesmessages.google.com'],
];

describe('G31: a request to a new vendor domain is classified as that service', () => {
  it('covers all 26 new services', () => {
    const ids = new Set(VENDOR_DOMAINS.map(([id]) => id));
    expect(ids.size).toBe(26);
    for (const id of ids) expect(catalog.byId.has(id), id).toBe(true);
  });

  it.each(VENDOR_DOMAINS)('%s: subdomain of %s', (serviceId, domain) => {
    const [r] = requestsOf([`https://edge.${domain}/canary2-synthetic?x=1`]);
    expect(r).toMatchObject({ serviceId, source: 'catalog' });
  });
});

describe('G31: signatures and identifiers stay conservative', () => {
  it('signature hits carry the signature id, kind and stage', () => {
    const [ping, script, sync] = requestsOf(
      ['https://ping.chartbeat.net/ping?h=1'],
      ['https://static.chartbeat.com/js/chartbeat.js'],
      ['https://sync.outbrain.com/cookie-sync?x=1', { identifierPresent: true, identifierNames: ['uid'] }],
    );
    expect(ping).toMatchObject({
      serviceId: 'chartbeat',
      signatureId: 'chartbeat:ping',
      kind: 'hit',
      stage: 'event-sent',
    });
    expect(script).toMatchObject({ signatureId: 'chartbeat:script', kind: 'library', stage: 'loaded' });
    expect(sync).toMatchObject({
      serviceId: 'outbrain',
      identifier: true,
      identifierKind: 'persistent-param',
      identifierParam: 'uid',
    });
  });

  it('narrow signatures keep thumbnails, widget config and checkout traffic out of the event stage', () => {
    const [thumb, geo, checkout, widgets] = requestsOf(
      ['https://images.taboola.com/taboola/image/fetch/f_jpg/x.jpg', { resourceType: 'image' }],
      ['https://ut.pubmatic.com/geo?x=1', { resourceType: 'xhr' }],
      ['https://buy-eu.piano.io/checkout/general/loadTranslationMap?x=1', { resourceType: 'xhr' }],
      ['https://kumain.piwik.pro/abc/privacy-widgets.json', { resourceType: 'xhr' }],
    );
    expect(thumb).toMatchObject({
      serviceId: 'taboola',
      signatureId: 'taboola:thumbnails',
      kind: 'image',
      stage: 'loaded',
    });
    expect(geo).toMatchObject({
      serviceId: 'pubmatic',
      signatureId: 'pubmatic:geo',
      kind: 'resource',
      stage: 'loaded',
    });
    expect(checkout).toMatchObject({ serviceId: 'piano', kind: 'resource', stage: 'loaded' });
    expect(widgets).toMatchObject({ serviceId: 'piwik-pro', kind: 'resource', stage: 'loaded' });
  });

  it('identifierParams count only when the identifier parameter was seen', () => {
    const [seen, unseen] = requestsOf(
      [
        'https://criteo-sync.teads.tv/um?uid=[redacted]',
        { identifierPresent: true, identifierNames: ['uid'] },
      ],
      ['https://sync.teads.tv/um?x=1'],
    );
    expect(seen).toMatchObject({ serviceId: 'teads', identifierKind: 'persistent-param', identifier: true });
    expect(unseen).toMatchObject({ serviceId: 'teads', identifierKind: 'none', identifier: false });
  });

  it('identifier parameters seen in the snapshot of the ad-tech sync and ad requests', () => {
    const [bid, adRequest] = requestsOf(
      [
        'https://x.bidswitch.net/sync?ssp=1&user_id=[redacted]',
        { identifierPresent: true, identifierNames: ['user_id'] },
      ],
      [
        'https://aax-eu.amazon-adsystem.com/s/iu3?uuid=[redacted]',
        { identifierPresent: true, identifierNames: ['uuid'], resourceType: 'fetch' },
      ],
    );
    expect(bid).toMatchObject({
      serviceId: 'bidswitch',
      identifierKind: 'persistent-param',
      identifier: true,
    });
    expect(adRequest).toMatchObject({
      serviceId: 'amazon-ads',
      signatureId: 'amazon-ads:ad-request',
      identifierKind: 'persistent-param',
      identifier: true,
    });
  });

  it('known identifier cookies and storage keys of the new vendors are tracking; domain-restricted names need the domain', () => {
    const d = derive(
      snap([
        makePhase('A', {
          cookies: [
            makeCookie({ name: '_cb' }),
            makeCookie({ name: 'uid', domain: 'c1.adform.net', firstParty: false }),
            makeCookie({ name: 'uid', domain: 'other.example.test', firstParty: false }),
            makeCookie({ name: 'utag_main' }),
          ],
          storage: [makeStorage({ key: 'id5id' })],
        }),
      ]),
    );
    expect(d.cookies.map((c) => [c.key.name, c.serviceId, c.tracking])).toEqual([
      ['_cb', 'chartbeat', true],
      ['uid', 'adform', true],
      ['uid', null, false],
      ['utag_main', 'tealium', true],
    ]);
    expect(d.storage[0]).toMatchObject({ serviceId: 'id5', tracking: true });
  });
});

describe('G31: a domain-only match never lifts a service call of the vendor to the event stage', () => {
  /** Identity, experience, checkout and REST hosts of the vendor, EU and non-EU: service calls over xhr/fetch. */
  const SERVICE_CALLS: Array<[url: string, resourceType: string]> = [
    ['https://id.piano.io/api/v1/identity/login/token?aid=x', 'xhr'],
    ['https://id-eu.piano.io/id/api/v1/identity/token/verify', 'xhr'],
    ['https://experience.piano.io/xbuilder/experience/execute?aid=x', 'fetch'],
    ['https://experience-eu.piano.io/xbuilder/experience/execute?aid=x', 'fetch'],
    ['https://buy.piano.io/checkout/offer/show', 'fetch'],
    ['https://buy-eu.piano.io/checkout/offer/show', 'fetch'],
    ['https://api.piano.io/api/v3/anon/template/loadTemplateContext', 'xhr'],
  ];

  it.each(SERVICE_CALLS)('%s (%s) is a loaded resource of a signature, not an event', (url, resourceType) => {
    const [r] = requestsOf([url, { resourceType }]);
    expect(r).toMatchObject({ serviceId: 'piano', kind: 'resource', stage: 'loaded' });
    expect(r?.signatureId).toMatch(/^piano:/);
  });

  it('counter-example: the engagement endpoint of the tracking host stays an event, also on the EU host', () => {
    const [us, eu] = requestsOf(
      ['https://c2.piano.io/page/track/engagement', { resourceType: 'xhr' }],
      ['https://c2-eu.piano.io/page/track/engagement', { resourceType: 'fetch' }],
    );
    expect(us).toMatchObject({ signatureId: 'piano:engagement', kind: 'hit', stage: 'event-sent' });
    expect(eu).toMatchObject({ signatureId: 'piano:engagement', kind: 'hit', stage: 'event-sent' });
  });

  it('the vendor domains stay in the catalog: an unknown path on a vendor host is still classified (PRIV-01 inventory)', () => {
    const [r] = requestsOf(['https://id.piano.io/unlisted/path', { resourceType: 'image' }]);
    expect(r).toMatchObject({ serviceId: 'piano', source: 'catalog' });
  });
});

describe('G36: consent-state allowlist', () => {
  /** consentmanager, Sourcepoint and Google Funding Choices consent state (cookies and storage). */
  const COOKIE_KEYS = [
    '__cmpcpc',
    '__cmpcpc_expire',
    '__cmpcvc',
    '__cmpiab',
    '__cmpiabli',
    '__cmpiabx144007',
    '__cmpcccx144007',
    '__cmpcccx144007_expire',
    '__cmpfcc',
    'FCCDCF',
    'FCNEC',
    '_sp_su',
    '_sp_v1_ss',
    '_sp_v1_p',
    '_sp_v1_data',
  ];
  const STORAGE_KEYS = [
    '__cmpcpc_expire',
    '__cmpcpc_.example.test',
    '__cmpcccx144007_expire',
    '__cmpiablix144007',
    'ucData_abc123',
    '_sp_local_state',
    '_sp_non_keyed_local_state',
  ];

  it('every new consent-state key is classified as allowlisted consent, not tracking, in cookies and storage', () => {
    const d = derive(
      snap([
        makePhase('A', {
          cookies: COOKIE_KEYS.map((name) =>
            makeCookie({ name, domain: 'cmp.example.test', firstParty: false }),
          ),
          storage: STORAGE_KEYS.map((key) => makeStorage({ key, origin: 'https://cmp.example.test' })),
        }),
      ]),
    );
    expect(d.cookies).toHaveLength(COOKIE_KEYS.length);
    expect(d.storage).toHaveLength(STORAGE_KEYS.length);
    for (const c of d.cookies)
      expect(c, c.key.name).toMatchObject({ allowlisted: true, allowlistClass: 'consent', tracking: false });
    for (const s of d.storage)
      expect(s, s.key).toMatchObject({ allowlisted: true, allowlistClass: 'consent', tracking: false });
  });

  it('visitor identifiers and unknown keys on the same CMP origin are not allowlisted', () => {
    expect(catalog.allowlistedCookie('__cmpiuid')).toBeNull();
    expect(catalog.allowlistedCookie('__cmpiuid_expire')).toBeNull();
    expect(catalog.allowlistedCookie('consentUUID')).toBeNull();
    // `_sp_v1_*` is narrowed to the observed names: the glob would also cover `_sp_v1_uid`, presumed identifier.
    expect(catalog.allowlistedCookie('_sp_v1_uid')).toBeNull();
    expect(catalog.allowlistedStorage('__cmpiuid_.example.test')).toBeNull();
    expect(catalog.allowlistedStorage('random_key_on_cmp_origin')).toBeNull();
  });
});
