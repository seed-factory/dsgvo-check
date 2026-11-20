/** Set-Cookie writes are attributed by request time and valid response-host/domain ownership.
 * A late click marker must update response origins; a foreign-domain claim cannot become a cookie setter. */
import type { BrowserContext } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker, type Moment } from '../../../../../src/collectors/browser/recording/jar.ts';
import type { NetworkRecorder } from '../../../../../src/collectors/browser/recording/recorder.ts';
import { fakeContext, fakePage, fakeRecorder, fakeRequest, fakeResponse, jarCookie } from '../fakes.ts';

const target = { etld1: 'example.test', host: 'www.example.test' };
const START = 'https://www.example.test/';
const pre: Moment = { phase: 'B', pageUrl: START, tMs: 10, tRef: 'navigation', afterClick: false };
const post: Moment = { ...pre, tRef: 'click', afterClick: true, tMs: 500 };
const noFrames = fakePage([]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A phase-B recorder that answers one request at a time, like the collector feeds it. */
const liveRecorder = () => fakeRecorder({ phase: 'B', etld1: target.etld1, start: START });

const flags = (jar: JarTracker, name: string, domain: string) =>
  jar.cookies.filter((c) => c.name === name && c.domain === domain).map((c) => c.afterClick);

async function readJar(rec: NetworkRecorder, context = fakeContext([])) {
  const jar = new JarTracker(target, rec.setCookieOrigins);
  await jar.snapshot(context, noFrames, pre);
  return jar;
}

/** The jar as read before the press, with a pause so the press time lies after it. */
async function jarBeforePress(rec: NetworkRecorder, context: BrowserContext) {
  const jar = await readJar(rec, context);
  await sleep(5);
  return jar;
}

/** The press happens now; one request is answered after it and the jar is read again. */
async function pressThenRespond(
  { rec, send }: ReturnType<typeof liveRecorder>,
  jar: JarTracker,
  context: BrowserContext,
  url: string,
  setCookie: string[],
) {
  rec.markClickAt(performance.now());
  jar.markClick(Date.now());
  await send(url, setCookie);
  await jar.snapshot(context, noFrames, post);
}

describe('the late markClickAt re-times the Set-Cookie origins of the re-marked requests', () => {
  /** The cookie existed before the press; the jar was read before the press (like `act` does). */
  async function existingGa() {
    const { rec, send } = liveRecorder();
    await send('https://www.example.test/before.gif', ['_ga=V1; Path=/']);
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    const jar = await jarBeforePress(rec, context);
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
    await jar.snapshot(context, noFrames, post);

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
    const context = fakeContext([
      jarCookie('uid', 'www.example.test'),
      jarCookie('uid', 'tracker-a.test'),
      jarCookie('uid', 'tracker-b.test'),
    ]);
    const jar = await jarBeforePress(rec, context);
    const pressAt = performance.now();
    await sleep(5);

    await send('https://tracker-b.test/q.gif', ['uid=4; Path=/']);
    await send('https://tracker-a.test/q.gif', ['uid=5; Path=/other']);
    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 12);
    await jar.snapshot(context, noFrames, post);

    expect(flags(jar, 'uid', 'www.example.test')).toEqual([false]);
    expect(flags(jar, 'uid', 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'uid', 'tracker-b.test')).toEqual([false, true]);
  });

  it('counterexample: a response to a request that started BEFORE the press is not a write after the click', async () => {
    const { ctx, rec } = liveRecorder();
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    await jar.snapshot(context, noFrames, pre);

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
    await jar.snapshot(context, noFrames, post);

    expect(rec.records[0]?.afterClick).toBe(false);
    expect([...rec.setCookieOrigins.values()].map((o) => o.afterClick)).toEqual([undefined]);
    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
  });

  it('counterexample: a response that sets the key only before the press never gives a second record', async () => {
    const { rec, jar, context, pressAt } = await existingGa();

    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 1);
    await jar.snapshot(context, noFrames, post);

    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
  });

  it('a response handled after markClickAt for a request started after it is marked as before (unchanged)', async () => {
    const { rec, send, jar, context, pressAt } = await existingGa();

    rec.markClickAt(pressAt);
    jar.markClick(Date.now() - 1);
    await sleep(5);
    await send('https://www.example.test/after.gif', ['_ga=V2; Path=/']);
    await jar.snapshot(context, noFrames, post);

    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false, true]);
  });
});

describe('a Domain= the response host may not set is no setter and no write after the click', () => {
  const FOREIGN = 'https://foreign-vendor.test/pixel.gif';

  it('foreign response claiming the Domain= of an existing cookie, after the click: no second accepted record', async () => {
    const recorder = liveRecorder();
    // The jar is what the browser keeps: the foreign Domain= was rejected, the cookie is unchanged.
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    const jar = await jarBeforePress(recorder.rec, context);

    await pressThenRespond(recorder, jar, context, FOREIGN, ['_ga=V2; Domain=www.example.test; Path=/']);

    expect(flags(jar, '_ga', 'www.example.test')).toEqual([false]);
    expect(jar.cookies.filter((c) => c.state === 'accepted')).toHaveLength(1);
  });

  it('the same host with a Domain= it may not set (a public suffix): the existing host-only cookie is untouched', async () => {
    const recorder = liveRecorder();
    // The browser rejected `Domain=test` and kept the host-only cookie of www.example.test as it was.
    const context = fakeContext([jarCookie('_ga', 'www.example.test')]);
    const jar = await jarBeforePress(recorder.rec, context);

    await pressThenRespond(recorder, jar, context, 'https://www.example.test/p.gif', [
      '_ga=V2; Domain=test; Path=/',
    ]);

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
    const jar = await readJar(rec, fakeContext([jarCookie('_ga', 'www.example.test')]));

    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
    expect(jar.cookies[0]?.setterHost).toBeUndefined();
  });

  it.each([
    ['a parent domain of another site', 'https://foreign-vendor.test/p.gif', 'example.test'],
    ['a sibling subdomain', 'https://cdn.example.test/p.gif', 'www.example.test'],
  ])('rejected Domain= (%s): the existing cookie keeps no second record', async (_what, url, domain) => {
    const recorder = liveRecorder();
    const context = fakeContext([jarCookie('_ga', domain)]);
    const jar = await jarBeforePress(recorder.rec, context);

    await pressThenRespond(recorder, jar, context, url, [`_ga=V2; Domain=${domain}; Path=/`]);

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
      const jar = await readJar(rec);
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
    const jar = await readJar(rec, fakeContext([jarCookie('uid', 'www.example.test')]));

    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'www.example.test' });
  });

  it('without a jar cookie the rejected response is an attempted cookie of ITS host, not of the claimed first party', async () => {
    const { rec, send } = liveRecorder();
    await send(FOREIGN, ['_ga=V2; Domain=www.example.test; Path=/']);
    const jar = await readJar(rec);
    jar.finalize(pre);

    expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.firstParty, c.setterHost])).toEqual([
      ['_ga', 'attempted', 'foreign-vendor.test', false, 'foreign-vendor.test'],
    ]);
  });

  // Counterexamples: what the browser accepts keeps working.
  it('counterexample: a subdomain may set the Domain= of its parent; that cookie is attributed and re-marked', async () => {
    const recorder = liveRecorder();
    const { rec, send } = recorder;
    await send('https://gum.tracker-a.test/sync.gif', ['uid=1; Domain=tracker-a.test; Path=/']);
    const context = fakeContext([jarCookie('uid', '.tracker-a.test')]);
    const jar = await jarBeforePress(rec, context);

    await pressThenRespond(recorder, jar, context, 'https://gum.tracker-a.test/sync2.gif', [
      'uid=2; Domain=.Tracker-A.Test; Path=/',
    ]);

    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: 'gum.tracker-a.test' });
    expect(flags(jar, 'uid', 'tracker-a.test')).toEqual([false, true]);
    expect([...rec.setCookieOrigins.values()].map((o) => o.domain)).toEqual(['tracker-a.test']);
  });

  it.each([
    ['the response host', 'tracker-a.test', '.tracker-a.test'],
    ['a public suffix equal to the response host', 'test', 'test'],
    ['an IP host', '203.0.113.7', '203.0.113.7'],
  ])('counterexample: Domain= equal to %s is accepted', async (_name, host, cookieDomain) => {
    const { rec, send } = liveRecorder();
    await send(`https://${host}/p.gif`, [`uid=1; Domain=${host}; Path=/`]);
    const jar = await readJar(rec, fakeContext([jarCookie('uid', cookieDomain)]));
    expect(jar.cookies[0]).toMatchObject({ setter: 'http-response', setterHost: host });
  });
});

describe('a cookie name with an address: matched by the name as sent, stored as [redacted]', () => {
  const NAMES = ['alice@example.test', 'bob@example.test'];

  it('the accepted cookie keeps its setter and no second record is made for the Set-Cookie', async () => {
    const { rec, send } = liveRecorder();
    await send('https://www.example.test/a.gif', [`${NAMES[0]}=SECRET; Path=/`]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie(NAMES[0] as string, 'www.example.test')]), noFrames, pre);
    jar.finalize(pre);

    expect(jar.cookies.map((c) => [c.name, c.state, c.setter])).toEqual([
      ['[redacted]', 'accepted', 'http-response'],
    ]);
    expect(rec.records[0]?.setCookieNames).toEqual(['[redacted]']);
    expect(JSON.stringify([jar.cookies, rec.records])).not.toMatch(/alice|SECRET/);
  });

  it('a refused cookie is one attempted record, and two such cookies stay two', async () => {
    const { rec, send } = liveRecorder();
    await send(
      'https://www.example.test/a.gif',
      NAMES.map((name) => `${name}=SECRET; Path=/`),
    );
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([]), noFrames, pre);
    jar.finalize(pre);

    expect(jar.cookies.map((c) => [c.name, c.state])).toEqual([
      ['[redacted]', 'attempted'],
      ['[redacted]', 'attempted'],
    ]);
    expect(JSON.stringify(jar.cookies)).not.toMatch(/alice|bob/);
  });
});
