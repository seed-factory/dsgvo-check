/** Tracking signatures distinguish libraries and service calls from events and persistent identifiers. */
import { describe, expect, it } from 'vitest';
import { derive } from '../../../src/derive/index.ts';
import {
  makeBrowser,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeTarget,
} from '../../utils/snapshot-builder.ts';

type RequestExtra = Omit<Parameters<typeof makeRequest>[0], 'url'>;

const requestsOf = (...items: Array<[string, RequestExtra?]>) =>
  derive(
    makeSnapshot({
      target: makeTarget('https://www.example.de/'),
      browser: makeBrowser({
        phases: [
          makePhase('A', {
            requests: items.map(([url, extra = {}], i) => makeRequest({ id: `r${i}`, url, ...extra })),
          }),
        ],
      }),
    }),
  ).requests;

describe('the Google Ad Manager dictionary, library and ad request', () => {
  it('the compression dictionary (resourceType other) is a loaded resource, not an event', () => {
    const [dict] = requestsOf([
      'https://securepubads.g.doubleclick.net/pagead/managed/dict/m1/gpt',
      { resourceType: 'other' },
    ]);
    expect(dict).toMatchObject({
      serviceId: 'google-ad-manager',
      signatureId: 'google-ad-manager:compression-dictionary',
      kind: 'resource',
      stage: 'loaded',
    });
  });

  it('the dictionary stays a resource over fetch and xhr too (the signature decides, not the resource type)', () => {
    const [viaFetch, viaXhr] = requestsOf(
      ['https://pubads.g.doubleclick.net/pagead/managed/dict/m1/ima', { resourceType: 'fetch' }],
      ['https://pubads.g.doubleclick.net/pagead/managed/dict/m1/ima', { resourceType: 'xhr' }],
    );
    expect(viaFetch).toMatchObject({ kind: 'resource', stage: 'loaded' });
    expect(viaXhr).toMatchObject({ kind: 'resource', stage: 'loaded' });
  });

  it('gpt.js is a library; the ad request stays a hit (counter-example)', () => {
    const [gpt, ads] = requestsOf(
      ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', { resourceType: 'script' }],
      ['https://securepubads.g.doubleclick.net/gampad/ads?iu=%2F1%2Fx', { resourceType: 'fetch' }],
    );
    expect(gpt).toMatchObject({
      signatureId: 'google-ad-manager:gpt-library',
      kind: 'library',
      stage: 'loaded',
    });
    expect(ads).toMatchObject({
      signatureId: 'google-ad-manager:ad-request',
      kind: 'hit',
      stage: 'event-sent',
    });
  });

  it('another endpoint of the domain-only match keeps the old behaviour (counter-example)', () => {
    const [ping] = requestsOf([
      'https://securepubads.g.doubleclick.net/pcs/view?x=1',
      { resourceType: 'ping' },
    ]);
    expect(ping).toMatchObject({ serviceId: 'google-ad-manager', kind: 'hit', stage: 'event-sent' });
  });
});

describe('HubSpot and Adobe service calls', () => {
  it('CMS tools menu, CTA, embed counter and live chat are loaded resources', () => {
    const items = requestsOf(
      [
        'https://app-eu1.hubspot.com/content-tools-menu/api/v1/tools-menu/has-permission-json',
        { resourceType: 'xhr' },
      ],
      ['https://app-eu1.hubspot.com/ctas/v2/public/cs/cta-json', { resourceType: 'xhr' }],
      ['https://track-eu1.hubspot.com/embed/v3/counters.gif', { resourceType: 'image' }],
      ['https://api-eu1.hubspot.com/livechat-public/v1/message/public', { resourceType: 'xhr' }],
    );
    for (const r of items) {
      expect(r, r.requestId).toMatchObject({ serviceId: 'hubspot', kind: 'resource', stage: 'loaded' });
    }
  });

  it('the tracking pixel stays a hit (counter-example); an unknown xhr keeps the old behaviour', () => {
    const [pixel, other] = requestsOf(
      ['https://track-eu1.hubspot.com/__ptq.gif?k=1', { resourceType: 'image' }],
      ['https://api-eu1.hubspot.com/unknown/v1/thing', { resourceType: 'xhr' }],
    );
    expect(pixel).toMatchObject({ signatureId: 'hubspot:tracking-pixel', kind: 'hit', stage: 'event-sent' });
    expect(other).toMatchObject({ serviceId: 'hubspot', kind: 'hit' });
  });

  it('the Experience Edge consent call is a resource, the beacon stays a hit', () => {
    const [consent, beacon] = requestsOf(
      ['https://adobedc.demdex.net/ee/v1/privacy/set-consent?configId=x', { resourceType: 'fetch' }],
      ['https://example.sc.omtrdc.net/b/ss/example/1/JS-2.0/s123', { resourceType: 'image' }],
    );
    expect(consent).toMatchObject({ serviceId: 'adobe-analytics', kind: 'resource', stage: 'loaded' });
    expect(beacon).toMatchObject({ serviceId: 'adobe-analytics', kind: 'hit', stage: 'event-sent' });
  });
});

describe('identifier names in path parameters make a persistent identifier', () => {
  const FLOODLIGHT =
    'https://1234567.fls.doubleclick.net/activityi;src=1;type=t;cat=c;dc_pre=[redacted];ord=[redacted]';

  it('Floodlight: the seen dc_pre is persistent; without the name it is per-load or none', () => {
    const [seen, unseen] = requestsOf(
      [FLOODLIGHT, { resourceType: 'image', identifierPresent: true, identifierNames: ['dc_pre'] }],
      [FLOODLIGHT, { resourceType: 'image', identifierPresent: false, identifierNames: [] }],
    );
    expect(seen).toMatchObject({
      serviceId: 'google-marketing-platform',
      identifier: true,
      identifierKind: 'persistent-param',
      identifierParam: 'dc_pre',
    });
    expect(unseen).toMatchObject({ identifier: false, identifierKind: 'none' });
  });

  it('the ddm activity and gmp conversion sinks carry their ids over the same names', () => {
    const [ddm, gmp] = requestsOf(
      [
        'https://ade.googlesyndication.com/ddm/activity/src=1;type=t;dc_dbm_token=[redacted];ord=[redacted]',
        { resourceType: 'image', identifierPresent: true, identifierNames: ['dc_dbm_token'] },
      ],
      [
        'https://www.google.com/gmp/conversion/_dc_unique_id=[redacted]/x',
        { resourceType: 'image', identifierPresent: true, identifierNames: ['_dc_unique_id'] },
      ],
    );
    expect(ddm).toMatchObject({ identifierKind: 'persistent-param', identifierParam: 'dc_dbm_token' });
    expect(gmp).toMatchObject({ identifierKind: 'persistent-param', identifierParam: '_dc_unique_id' });
  });

  it('Audience Manager sync: dpuuid is persistent, dpid alone is not an identifier (counter-example)', () => {
    const [sync, noId] = requestsOf(
      [
        'https://dpm.demdex.net/ibs:dpid=[redacted]&dpuuid=[redacted]',
        { resourceType: 'image', identifierPresent: true, identifierNames: ['dpuuid'] },
      ],
      ['https://dpm.demdex.net/ibs:dpid=[redacted]', { resourceType: 'image' }],
    );
    expect(sync).toMatchObject({
      serviceId: 'adobe-analytics',
      signatureId: 'adobe-analytics:ibs-sync',
      identifier: true,
      identifierKind: 'persistent-param',
      identifierParam: 'dpuuid',
    });
    expect(noId).toMatchObject({ identifier: false, identifierKind: 'none' });
  });
});
