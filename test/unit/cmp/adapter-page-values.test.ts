/**
 * What the adapters take from the page reaches the facts only as names or closed sets. The readers run in the page's own
 * world, so the page can make them return anything: the Node side maps a vendor setting to the vendor's own values,
 * folds category keys that are no names into `other`, keeps signals of the vendor's own detection only, and records a
 * failed click or reload by its kind. A stub page answers as a hostile page would; markers start with `zq7`.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { clickButton, foldCategories } from '../../../src/cmp/adapters/base.ts';
import { borlabs } from '../../../src/cmp/adapters/borlabs.ts';
import { ccm19 } from '../../../src/cmp/adapters/ccm19.ts';
import { complianz } from '../../../src/cmp/adapters/complianz.ts';
import { cookiebot } from '../../../src/cmp/adapters/cookiebot.ts';
import { cookieman } from '../../../src/cmp/adapters/cookieman.ts';
import { realCookieBanner } from '../../../src/cmp/adapters/real-cookie-banner.ts';
import { shopware } from '../../../src/cmp/adapters/shopware.ts';
import { usercentrics } from '../../../src/cmp/adapters/usercentrics.ts';
import type { ProbeResult } from '../../../src/cmp/page/probe-types.ts';
import type { CategoryState } from '../../../src/cmp/types.ts';

/** The probe's answer for a page without a banner. */
const NO_BANNER: ProbeResult = {
  found: false,
  containerCount: 0,
  visible: false,
  containerBox: null,
  containerFixed: false,
  containerSelector: null,
  textLength: 0,
  purAbo: false,
  keywordHits: [],
  buttons: [],
  buttonsTruncated: false,
  animating: false,
  blocking: {
    overlay: false,
    scrollLock: false,
    inert: false,
    coveredRatio: null,
    method: [],
    ariaModal: false,
  },
  viewport: { width: 1366, height: 768 },
  coveredLinks: [],
  heuristic: null,
  rejectedCandidate: null,
};

const NO_TCF = { present: false, gdprApplies: null, cmpId: null };

/** A page whose in-page functions answer by name (`readComplianz`, `tcfPingProbe`…) with what the test gives. */
function stubPage(answers: Record<string, unknown>, extra: Record<string, unknown> = {}): Page {
  const all: Record<string, unknown> = { tcfPingProbe: NO_TCF, cmpPageProbe: NO_BANNER, ...answers };
  return {
    evaluate: async (fn: { name: string }) => {
      if (Object.hasOwn(all, fn.name)) return structuredClone(all[fn.name]);
      throw new Error(`no answer for ${fn.name || 'an anonymous function'}`);
    },
    url: () => 'https://www.example.test/',
    ...extra,
  } as unknown as Page;
}

const complianzAnswer = (p: Record<string, unknown> = {}) => ({
  present: true,
  apiCategories: { preferences: false, statistics: false, marketing: false },
  cookieCategories: { preferences: null, statistics: null, marketing: null },
  anyCategoryCookie: false,
  bannerDismissed: false,
  region: 'eu',
  consentType: 'optin',
  version: '7.1.0',
  isBot: false,
  isSpeedbot: false,
  ...p,
});

describe('Complianz: region, consent type and version from the `complianz` object', () => {
  it('a hostile region and consent type become `other`, a version that is none is dropped', async () => {
    const page = stubPage({
      readComplianz: complianzAnswer({
        region: 'eu?cid=zq7abc&mail=alice@example.test',
        consentType: 'optin&uid=zq7u',
        version: 'zq7-not-a-version',
      }),
    });
    const facts = await complianz.extract(page, 'first-screen');
    expect(facts.geoSignals).toEqual([{ cmpId: 'complianz', signal: 'complianz:region=other' }]);
    expect(facts.config).toEqual({
      'complianz.region': 'other',
      'complianz.consenttype': 'other',
      'complianz.version': null,
    });
    // Any region but `eu` is the plugin's special branch, as before.
    expect(facts.state.map((s) => s.origin)).toEqual(['special-branch']);
    expect(JSON.stringify(facts)).not.toContain('zq7');
  });

  it.each([
    ['eu', 'optin', []],
    ['us', 'optout', [{ cmpId: 'complianz', signal: 'complianz:region=us', detail: 'consenttype=optout' }]],
    ['uk', 'optin', [{ cmpId: 'complianz', signal: 'complianz:region=uk', detail: 'consenttype=optin' }]],
    [
      'ca',
      'optinstats',
      [{ cmpId: 'complianz', signal: 'complianz:region=ca', detail: 'consenttype=optinstats' }],
    ],
    ['other', null, [{ cmpId: 'complianz', signal: 'complianz:region=other' }]],
    [null, 'optin', []],
  ])('counterexample: region %j with consent type %j', async (region, consentType, geo) => {
    const page = stubPage({ readComplianz: complianzAnswer({ region, consentType }) });
    expect(await complianz.geoSignals(page)).toEqual(geo);
    const facts = await complianz.extract(page, 'first-screen');
    expect(facts.config).toMatchObject({ 'complianz.region': region, 'complianz.consenttype': consentType });
    expect(facts.state[0]?.origin).toBe(region !== null && region !== 'eu' ? 'special-branch' : 'default');
  });

  it.each([
    ['a client id in the format of a _ga cookie', '1.2.1234567890.1700000000'],
    ['a phone number', '49.15112345678'],
    ['a phone number in short groups', '0151.123.4567'],
    ['an IP address', '203.0.113.42'],
    ['an overlong dotted run', `1.${'4915112345678'.repeat(20)}`],
  ])('%s is no version: %j', async (_case, version) => {
    const page = stubPage({ readComplianz: complianzAnswer({ version }) });
    const facts = await complianz.extract(page, 'first-screen');
    expect(facts.config['complianz.version']).toBeNull();
    expect(JSON.stringify(facts)).not.toContain(version);
  });

  it('counterexample: a dotted version is kept', async () => {
    const facts = await complianz.extract(stubPage({ readComplianz: complianzAnswer() }), 'first-screen');
    expect(facts.config['complianz.version']).toBe('7.1.0');
  });
});

const cookiebotAnswer = (p: Record<string, unknown> = {}) => ({
  apiPresent: true,
  apiLoaded: true,
  hasResponse: true,
  method: 'explicit',
  categories: { preferences: false, statistics: false, marketing: false },
  isOutOfRegion: false,
  gdprApplies: true,
  spider: false,
  cookiePresent: false,
  cookieOutOfRegion: false,
  cookieCategories: {},
  cookieMethod: null,
  blockingMode: 'auto',
  ...p,
});

describe('Cookiebot: consent method and blocking mode in the config facts', () => {
  it.each([
    [
      'a hostile API method and blocking mode',
      { method: 'zq7method@example.test', blockingMode: 'auto?cid=zq7bm' },
      null,
      'other',
    ],
    [
      'a hostile cookie method behind a hostile API method',
      { method: 'zq7', cookieMethod: 'zq7forged=alice@example.test' },
      null,
      'auto',
    ],
    [
      'a hostile API method, the cookie method of the vendor',
      { method: 'zq7', cookieMethod: 'implied' },
      'implied',
      'auto',
    ],
    ['counterexample: the vendor values', {}, 'explicit', 'auto'],
    ['counterexample: a blocking mode in capitals', { blockingMode: 'Manual' }, 'explicit', 'manual'],
    ['counterexample: no blocking mode', { blockingMode: null }, 'explicit', null],
  ])('%s', async (_case, answer, method, mode) => {
    const facts = await cookiebot.extract(
      stubPage({ readCookiebot: cookiebotAnswer(answer) }),
      'first-screen',
    );
    expect(facts.config).toEqual({ 'cookiebot.consentMethod': method, 'cookiebot.blockingMode': mode });
    expect(JSON.stringify(facts)).not.toContain('zq7');
  });
});

const borlabsAnswer = (groups: unknown) => ({
  hasGlobal: true,
  cookiePresent: true,
  groups,
  geoIp: false,
  cookiesForBots: false,
  hideOnThisPage: false,
  afterInteraction: false,
  respectDnt: false,
  bannerVisible: false,
  uaBot: false,
});

describe('category keys from the page', () => {
  it.each([
    [
      'Borlabs: keys of the consent cookie value',
      borlabs,
      { readBorlabs: borlabsAnswer(['essential', 'statistics', 'uid=zq7borlabs@example.test']) },
      { statistics: 'granted', marketing: 'denied', 'external-media': 'denied', other: 'granted' },
    ],
    [
      'counterexample: Borlabs with its own group slugs',
      borlabs,
      { readBorlabs: borlabsAnswer(['essential', 'statistics', 'marketing']) },
      { statistics: 'granted', marketing: 'granted', 'external-media': 'denied' },
    ],
    [
      'Usercentrics: ids of the API, a value that is no state',
      usercentrics,
      {
        readUsercentrics: {
          v3: true,
          v2: false,
          initialized: true,
          categories: {
            'cid=zq7uc&x=1': 'denied',
            marketing: 'denied',
            'customCategory-123e4567-e89b-12d3-a456-426614174000': 'granted',
            functional: 'zq7',
          },
          responded: true,
          method: 'explicit',
          consentRequired: true,
        },
      },
      { marketing: 'denied', functional: 'unknown', other: 'partial' },
    ],
    [
      'Real Cookie Banner: group slugs and ids',
      realCookieBanner,
      {
        readRcb: {
          present: true,
          cookiePresent: true,
          categories: { 'zq7rcb?token=abc': false, statistik: true, '2': false },
          acceptAllForBots: false,
          respectDnt: false,
          uaBot: false,
          bannerVisible: false,
        },
      },
      { '2': 'denied', statistik: 'granted', other: 'denied' },
    ],
    [
      'cookieman: group names of the modal',
      cookieman,
      {
        readCookieman: {
          present: true,
          configured: true,
          source: 'cookie',
          answered: true,
          categories: { 'zq7cm=alice@example.test': false, marketing: true },
        },
      },
      { marketing: 'granted', other: 'denied' },
    ],
    [
      'Shopware: only the listed permission cookies',
      shopware,
      {
        readShopware: {
          storefront: true,
          answered: true,
          present: { 'zq7=x': true, 'google-analytics-enabled': true },
        },
      },
      {
        'google-analytics-enabled': 'granted',
        'google-ads-enabled': 'denied',
        'wishlist-enabled': 'denied',
        'youtube-video': 'denied',
        'vimeo-video': 'denied',
      },
    ],
  ])('%s', async (_case, adapter, answers, categories) => {
    const [state] = await adapter.state(stubPage(answers));
    expect(state?.categories).toEqual(categories);
    expect(JSON.stringify(state)).not.toContain('zq7');
  });

  it('fields the reader builds from fixed words keep only those words', async () => {
    const [uc] = await usercentrics.state(
      stubPage({
        readUsercentrics: {
          v3: true,
          v2: false,
          initialized: true,
          categories: {},
          responded: 'zq7',
          method: 'zq7',
          consentRequired: 'zq7',
        },
      }),
    );
    expect(uc?.decision).toEqual({ responded: 'unknown', method: 'unknown' });
    const [cm] = await cookieman.state(
      stubPage({
        readCookieman: { present: true, configured: true, source: 'zq7', answered: false, categories: {} },
      }),
    );
    expect(cm?.source).toBe('cookie');
    const [ccm] = await ccm19.state(
      stubPage({ readCcm19: { present: true, ready: true, stored: true, embeddings: 'zq7', closed: false } }),
    );
    expect(ccm?.categories).toEqual({});
  });

  it('a reader answer that is no object leaves no state', async () => {
    expect(await borlabs.state(stubPage({ readBorlabs: 'zq7alice@example.test' }))).toEqual([]);
  });
});

describe('foldCategories', () => {
  const states = (n: number, s: CategoryState) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, s]));

  it.each([
    [
      'names stay',
      { statistics: 'denied', marketing: 'granted' },
      { statistics: 'denied', marketing: 'granted' },
    ],
    ['keys that are no names agree', { 'a=1': 'denied', 'b@x': 'denied' }, { other: 'denied' }],
    ['keys that are no names differ', { 'a=1': 'denied', 'b@x': 'granted' }, { other: 'partial' }],
    ['a key `other` joins them', { other: 'granted', 'a=1': 'granted' }, { other: 'granted' }],
    [
      'tokens cut into short parts fold',
      { 'Ab3d-9Kx2-mQ7z-P4wR-t8Yn': 'denied', x9Kq_Lm3P_zR7t_Wb2N_vC5s: 'denied', statistics: 'denied' },
      { statistics: 'denied', other: 'denied' },
    ],
    ['a value that is no state', { statistics: 'zq7' }, { statistics: 'unknown' }],
  ])('%s', (_case, input, expected) => {
    expect(foldCategories(input)).toEqual(expected);
  });

  it('keys past the cap are folded too, so an all-denied state stays all denied', () => {
    const folded = foldCategories(states(40, 'denied'));
    expect(Object.keys(folded)).toHaveLength(33);
    expect(Object.values(folded).every((v) => v === 'denied')).toBe(true);
  });
});

const detectAnswer = (p: Record<string, unknown> = {}) => ({
  globals: ['Cookiebot'],
  versions: {},
  scripts: ['consent.cookiebot.com/uc.js'],
  scriptUrls: ['https://consent.cookiebot.com/uc.js'],
  dom: ['#CybotCookiebotDialog'],
  cookies: ['CookieConsent'],
  storage: [],
  ...p,
});

describe('detection signals', () => {
  it('only globals, scripts and selectors of the vendor, and cookie names its pattern matches', async () => {
    const detection = await cookiebot.detect(
      stubPage({
        cmpDetectProbe: detectAnswer({
          globals: ['Cookiebot', 'zq7=alice@example.test'],
          scripts: ['consent.cookiebot.com/uc.js', 'zq7'],
          dom: ['#CybotCookiebotDialog', '#zq7'],
          cookies: ['CookieConsent', 'CookieConsentzq7', 7, `CookieConsent${'x'.repeat(200)}`],
          storage: ['zq7'],
        }),
      }),
    );
    expect(detection?.signals).toEqual([
      'global:Cookiebot',
      'script:consent.cookiebot.com/uc.js',
      'dom:#CybotCookiebotDialog',
      'cookie:CookieConsent',
    ]);
  });

  // The probe splits `document.cookie` with built-ins the page can replace, so what it returns as a name may be a pair.
  it.each([
    ['a name with its value', 'cmplz_ref=zq7COOKIEVALUE'],
    ['two cookies', 'cmplz_ref=zq7; cmplz_x'],
    ['a name with a blank', 'cmplz_ref zq7'],
    ['a fullwidth equals sign', 'cmplz_ref\uff1dzq7'],
  ])('a cookie or storage name that is no name is no signal: %s', async (_case, name) => {
    const detection = await complianz.detect(
      stubPage({
        cmpDetectProbe: detectAnswer({
          globals: ['complianz'],
          scripts: [],
          scriptUrls: [],
          dom: ['#cmplz-cookiebanner-container'],
          cookies: [name],
        }),
      }),
    );
    expect(detection?.signals).toEqual(['global:complianz', 'dom:#cmplz-cookiebanner-container']);
    const ccm = await ccm19.detect(
      stubPage({
        cmpDetectProbe: detectAnswer({
          globals: ['CCM'],
          scripts: [],
          scriptUrls: [],
          dom: [],
          cookies: [],
          storage: [name.replace('cmplz_ref', 'ccm_consent'), 'ccm_consent'],
        }),
      }),
    );
    expect(ccm?.signals).toEqual(['global:CCM', 'storage:ccm_consent']);
  });

  it('counterexample: the Real Cookie Banner cookie name with its colons is a signal', async () => {
    const detection = await realCookieBanner.detect(
      stubPage({
        cmpDetectProbe: detectAnswer({
          globals: ['consentApi'],
          scripts: [],
          scriptUrls: [],
          dom: [],
          cookies: ['real_cookie_banner-v:3_blog:1_path:sim'],
        }),
      }),
    );
    expect(detection?.signals).toEqual([
      'global:consentApi',
      'cookie:real_cookie_banner-v:3_blog:1_path:sim',
    ]);
  });

  it('counterexample: a cookie name with the vendor prefix is kept as the page set it', async () => {
    const detection = await complianz.detect(
      stubPage({
        cmpDetectProbe: detectAnswer({
          globals: ['complianz'],
          scripts: [],
          scriptUrls: [],
          dom: ['#cmplz-cookiebanner-container'],
          cookies: ['cmplz_marketing'],
        }),
      }),
    );
    expect(detection?.signals).toEqual([
      'global:complianz',
      'dom:#cmplz-cookiebanner-container',
      'cookie:cmplz_marketing',
    ]);
  });

  it.each(['7.1.0?sid=zq7', '1.2.1234567890.1700000000', '49.15112345678'])(
    'a forged version global is no version: %j',
    async (forged) => {
      const detection = await complianz.detect(
        stubPage({
          cmpDetectProbe: detectAnswer({
            globals: ['complianz'],
            versions: { 'complianz.version': forged },
            scripts: [],
            scriptUrls: [],
            dom: ['#cmplz-cookiebanner-container'],
            cookies: [],
          }),
        }),
      );
      expect(detection?.version).toBeNull();
    },
  );
});

describe('TCF geo signal', () => {
  it.each([
    [
      'a CMP id that is no number',
      { present: true, gdprApplies: false, cmpId: 'zq7=alice@example.test' },
      [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false' }],
    ],
    [
      'a CMP id beyond the 12-bit field',
      { present: true, gdprApplies: false, cmpId: 40960 },
      [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false' }],
    ],
    ['an answer that only looks true', { present: 'zq7', gdprApplies: false, cmpId: 7 }, []],
    ['gdprApplies that is no boolean', { present: true, gdprApplies: 0, cmpId: 7 }, []],
    [
      'counterexample: a CMP id',
      { present: true, gdprApplies: false, cmpId: 300 },
      [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false', detail: 'cmpId=300' }],
    ],
    ['counterexample: GDPR applies', { present: true, gdprApplies: true, cmpId: 300 }, []],
  ])('%s', async (_case, ping, expected) => {
    expect(
      await cookiebot.geoSignals(stubPage({ readCookiebot: cookiebotAnswer(), tcfPingProbe: ping })),
    ).toEqual(expected);
  });
});

describe('a failed click or reload keeps its kind only', () => {
  const clickPage = (err: Error) =>
    ({
      locator: () => ({
        count: async () => 1,
        click: async () => {
          throw err;
        },
      }),
    }) as unknown as Page;

  it.each([
    [
      'strict mode, which repeats the selector',
      'locator.click: Error: strict mode violation: locator(\'button.zq7dup\') resolved to 2 elements:\n  1) <button class="zq7dup">',
      'target-ambiguous',
    ],
    [
      'a timeout with the call log',
      'locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator(\'#zq7\')\n  - <div data-x="zq7cover"></div> intercepts pointer events',
      'click-failed:timed out',
    ],
    [
      'a closed page',
      'locator.click: Target page, context or browser has been closed',
      'click-failed:page closed',
    ],
    [
      'any other failure',
      'locator.click: Element is not attached to the DOM <button id="zq7">',
      'click-failed',
    ],
  ])('%s', async (_case, message, error) => {
    expect(await clickButton(clickPage(new Error(message)), { selector: '#accept' })).toEqual({
      clicked: false,
      error,
    });
  });

  it.each([
    [
      'a reload that fails with the URL the page went to',
      'page.reload: net::ERR_ABORTED at https://www.example.test/?sid=zq7abc',
      'reload-failed',
    ],
    [
      'a reload of a page that closed',
      'page.reload: Target page, context or browser has been closed (zq7)',
      'reload-failed:page closed',
    ],
  ])('%s', async (_case, message, reason) => {
    const page = stubPage(
      { readCookiebot: cookiebotAnswer() },
      {
        reload: async () => {
          throw new Error(message);
        },
      },
    );
    const verify = await cookiebot.verify(page, 'reject', { timeoutMs: 100 });
    expect(verify.reason).toBe(reason);
    expect(JSON.stringify(verify)).not.toContain('zq7');
  });
});
