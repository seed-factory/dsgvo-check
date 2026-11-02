/** Set-Cookie writes are attributed by request time and valid response-host/domain ownership.
 * A late click marker must update response origins; a foreign-domain claim cannot become a cookie setter. */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Cookie, Page, Request, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker, type Moment } from '../../../../src/collectors/browser/jar.ts';
import { NetworkRecorder } from '../../../../src/collectors/browser/recorder.ts';

const target = { etld1: 'example.test', host: 'www.example.test' };
const START = 'https://www.example.test/';
const pre: Moment = { phase: 'B', pageUrl: START, tMs: 10, tRef: 'navigation', afterClick: false };
const post: Moment = { ...pre, tRef: 'click', afterClick: true, tMs: 500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type JarCookie = Pick<
  Cookie,
  'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'
> & { partitionKey?: string };

const jarCookie = (name: string, domain: string, o: Partial<JarCookie> = {}): JarCookie => ({
  name,
  value: 'SECRET_VALUE',
  domain,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: 'None',
  ...o,
});

const fakeContext = (cookies: JarCookie[]): BrowserContext =>
  ({ cookies: async () => cookies }) as unknown as BrowserContext;

const fakePage = { frames: () => [] } as unknown as Page;

function fakeRequest(url: string): Request {
  const frame = { parentFrame: () => null, url: () => START };
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => frame,
    isNavigationRequest: () => false,
    redirectedFrom: () => null,
    method: () => 'GET',
    resourceType: () => 'image',
    failure: () => null,
    allHeaders: async () => ({}),
  } as unknown as Request;
}

function fakeResponse(req: Request, setCookie: string[]): Response {
  return {
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    headersArray: async () => setCookie.map((value) => ({ name: 'Set-Cookie', value })),
    serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
  } as unknown as Response;
}

/** A phase-B recorder that answers one request at a time, like the collector feeds it. */
function liveRecorder() {
  const ctx = new EventEmitter();
  const counter = { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder('B', target.etld1, counter, false);
  rec.attach(ctx as unknown as BrowserContext);
  rec.beginNavigation(START);
  const send = async (url: string, lines: string[]) => {
    const req = fakeRequest(url);
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, lines));
    await rec.flush();
  };
  return { rec, send };
}

const flags = (jar: JarTracker, name: string, domain: string) =>
  jar.cookies.filter((c) => c.name === name && c.domain === domain).map((c) => c.afterClick);

describe('the late markClickAt re-times the Set-Cookie origins of the re-marked requests', () => {
  /** The cookie existed before the press; the jar was read before the press (like `act` does). */
  async function existingGa() {
    const { rec, send } = liveRecorder();
    await send('https://www.example.test/before.gif', ['_ga=V1; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    return { rec, send, jar, context, pressAt: performance.now() };
  }

  it('request and response after the press but before markClickAt: the existing cookie gets its afterClick record', async () => {
    const { rec, send, jar, context, pressAt } = await existingGa();
    await sleep(5);
    // The press happened; the adapter call has not returned yet, so the recorder still believes "before the click".
    await send('https://www.example.test/after.gif', ['_ga=V2; Path=/']);
    expect(rec.isAfterClick).toBe(false);
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 6);
    await jar.snapshot(context, fakePage, post);
    expect(rec.records.at(-1)).toMatchObject({ afterClick: true, tRef: 'click' });
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false, true]);
    // The first writer stays the setter of both records.
    expect(jar.cookies.map((c) => [c.setter, c.setterHost])).toEqual([
      ['http-response', 'www.example.test'],
      ['http-response', 'www.example.test'],
    ]);
    expect(JSON.stringify(jar.cookies)).not.toContain('SECRET');
  });

  it('the re-marked key is the exact key: another tracker and another Path= are not marked', async () => {
    const { rec, send } = liveRecorder();
    await send('https://www.example.test/a.gif', ['uid=1; Path=/']);
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await send('https://tracker-b.test/p.gif', ['uid=3; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([
      jarCookie('uid', 'www.example.test'),
      jarCookie('uid', 'tracker-a.test'),
      jarCookie('uid', 'tracker-b.test'),
    ]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    const pressAt = performance.now();
    await sleep(5);
    await send('https://tracker-b.test/q.gif', ['uid=4; Path=/']);
    await send('https://tracker-a.test/q.gif', ['uid=5; Path=/other']);
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 12);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, 'uid', 'www.example.test')).toEqual([false]);
    expect(flags(jar, 'uid', 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'uid', 'tracker-b.test')).toEqual([false, true]);
  });

  it('counterexample: a response to a request that started BEFORE the press is not a write after the click', async () => {
    const ctx = new EventEmitter();
    const rec = new NetworkRecorder('B', target.etld1, { limit: 2000, issued: 0, truncated: false }, false);
    rec.attach(ctx as unknown as BrowserContext);
    rec.beginNavigation(START);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    await jar.snapshot(context, fakePage, pre);
    // The request starts, then the press happens, then the response of the earlier request is handled.
    const req = fakeRequest('https://www.example.test/slow.gif');
    ctx.emit('request', req);
    await sleep(5);
    const pressAt = performance.now();
    await sleep(5);
    ctx.emit('response', fakeResponse(req, ['_ga=V2; Path=/']));
    await rec.flush();
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 6);
    await jar.snapshot(context, fakePage, post);
    expect(rec.records[0]?.afterClick).toBe(false);
    expect([...rec.setCookieOrigins.values()].map((o) => o.afterClick)).toEqual([undefined]);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
  });

  it('counterexample: a response that sets the key only before the press never gives a second record', async () => {
    const { rec, jar, context, pressAt } = await existingGa();
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 1);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
  });

  it('a response handled after markClickAt for a request started after it is marked as before (unchanged)', async () => {
    const { rec, send, jar, context, pressAt } = await existingGa();
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 1);
    await sleep(5);
    await send('https://www.example.test/after.gif', ['_ga=V2; Path=/']);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false, true]);
  });
});

describe('a Domain= the response host may not set is no setter and no write after the click', () => {
  const FOREIGN = 'https://foreign-vendor.test/pixel.gif';

  it('foreign response claiming the Domain= of an existing cookie, after the click: no second accepted record', async () => {
    const { rec, send } = liveRecorder();
    const jar = new JarTracker(target, rec.setCookieOrigins);
    // The jar is what the browser keeps: the foreign Domain= was rejected, the cookie is unchanged.
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await send(FOREIGN, ['_ga=V2; Domain=www.example.test; Path=/']);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
    expect(jar.cookies.filter((c) => c.state === 'accepted')).toHaveLength(1);
  });

  it('the same host with a Domain= it may not set (a public suffix): the existing host-only cookie is untouched', async () => {
    const { rec, send } = liveRecorder();
    const jar = new JarTracker(target, rec.setCookieOrigins);
    // The browser rejected `Domain=test` and kept the host-only cookie of www.example.test as it was.
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await send('https://www.example.test/p.gif', ['_ga=V2; Domain=test; Path=/']);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
    expect(jar.cookies.filter((c) => c.name === '_ga' && c.state === 'accepted')).toHaveLength(1);
    expect(jar.cookies.find((c) => c.name === '_ga' && c.state === 'accepted')).toMatchObject({
      firstParty: true,
      setter: 'unknown',
    });
  });

  it('the existing cookie is not attributed to the foreign response (setter unknown)', async () => {
    const { rec, send } = liveRecorder();
    await send(FOREIGN, ['_ga=V2; Domain=www.example.test; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('_ga', 'www.example.test')]), fakePage, pre);
    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
    expect(jar.cookies[0]?.setterHost).toBeUndefined();
  });

  it.each([
    ['a parent domain of another site', 'https://foreign-vendor.test/p.gif', 'example.test'],
    ['a sibling subdomain', 'https://cdn.example.test/p.gif', 'www.example.test'],
  ])('rejected Domain= (%s): the existing cookie keeps no second record', async (_what, url, domain) => {
    const { rec, send } = liveRecorder();
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('_ga', domain)]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await send(url, [`_ga=V2; Domain=${domain}; Path=/`]);
    await jar.snapshot(context, fakePage, post);
    expect(flags(jar, '_ga', domain)).toEqual([false]);
  });

  it.each([
    ['a public suffix above the host', 'https://www.example.test/p.gif', 'test', 'www.example.test'],
    ['a sub-label of an IP host', 'https://203.0.113.7/p.gif', '113.7', '203.0.113.7'],
  ])(
    'rejected Domain= (%s): the attempted record is a cookie of the response host',
    async (_what, url, domain, host) => {
      const { rec, send } = liveRecorder();
      await send(url, [`_ga=V2; Domain=${domain}; Path=/`]);
      const jar = new JarTracker(target, rec.setCookieOrigins);
      await jar.snapshot(fakeContext([]), fakePage, pre);
      jar.finalize(pre);
      expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.setterHost])).toEqual([
        ['_ga', 'attempted', host, host],
      ]);
    },
  );

  it('a rejected claim does not swallow a later valid host-only Set-Cookie of the claimed host', async () => {
    const { rec, send } = liveRecorder();
    await send(FOREIGN, ['uid=1; Domain=www.example.test; Path=/']);
    await send('https://www.example.test/own.gif', ['uid=2; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', 'www.example.test')]), fakePage, pre);
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'www.example.test' });
  });

  it('without a jar cookie the rejected response is an attempted cookie of ITS host, not of the claimed first party', async () => {
    const { rec, send } = liveRecorder();
    await send(FOREIGN, ['_ga=V2; Domain=www.example.test; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([]), fakePage, pre);
    jar.finalize(pre);
    expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.firstParty, c.setterHost])).toEqual([
      ['_ga', 'attempted', 'foreign-vendor.test', false, 'foreign-vendor.test'],
    ]);
  });

  // Counterexamples: what the browser accepts keeps working.
  it('counterexample: a subdomain may set the Domain= of its parent; that cookie is attributed and re-marked', async () => {
    const { rec, send } = liveRecorder();
    await send('https://gum.tracker-a.test/sync.gif', ['uid=1; Domain=tracker-a.test; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('uid', '.tracker-a.test')]);
    await jar.snapshot(context, fakePage, pre);
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await send('https://gum.tracker-a.test/sync2.gif', ['uid=2; Domain=.Tracker-A.Test; Path=/']);
    await jar.snapshot(context, fakePage, post);
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'gum.tracker-a.test' });
    expect(flags(jar, 'uid', 'tracker-a.test')).toEqual([false, true]);
    expect([...rec.setCookieOrigins.values()].map((o) => o.domain)).toEqual(['tracker-a.test']);
  });

  it('counterexample: Domain= equal to the response host is accepted', async () => {
    const { rec, send } = liveRecorder();
    await send('https://tracker-a.test/p.gif', ['uid=1; Domain=tracker-a.test; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', '.tracker-a.test')]), fakePage, pre);
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'tracker-a.test' });
  });

  it('counterexample: a public suffix equal to the response host is a host-only cookie (RFC 6265 5.3 step 5)', async () => {
    const { rec, send } = liveRecorder();
    await send('https://test/p.gif', ['uid=1; Domain=test; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', 'test')]), fakePage, pre);
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'test' });
  });

  it('counterexample: an IP host may set a cookie for itself', async () => {
    const { rec, send } = liveRecorder();
    await send('https://203.0.113.7/p.gif', ['uid=1; Domain=203.0.113.7; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', '203.0.113.7')]), fakePage, pre);
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: '203.0.113.7' });
  });
});
