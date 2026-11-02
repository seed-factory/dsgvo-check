/**
 * Pure tests (no browser) for the attribution of cookies to their setters and for the bounded metadata reads of the
 * recorder and the jar:
 * - A cookie is attributed to a `Set-Cookie` response only when name, domain, path and partition match; a
 * same-named cookie of another domain keeps its own setter; ambiguity → `unknown`.
 * - The domain of an `attempted` script cookie is the Domain= attribute or the host of the DOCUMENT of the frame
 * (never the host of the script); `firstParty` is judged against the target, `setterHost` stays the script host.
 * - `headersArray()`, `serverAddr()` and `frame.evaluate()` that never settle end by a local budget, keep the
 * facts collected so far and do not change a stored record afterwards.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Cookie, Page, Request, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { parseSetCookies } from '../../../../src/collectors/browser/features.ts';
import { JarTracker, type Moment } from '../../../../src/collectors/browser/jar.ts';
import { NetworkRecorder } from '../../../../src/collectors/browser/recorder.ts';

const target = { etld1: 'example.de', host: 'www.example.de' };
const START = 'https://www.example.de/';
const moment: Moment = {
  phase: 'A',
  pageUrl: START,
  tMs: 10,
  tRef: 'navigation',
  afterClick: false,
};

interface FakeFrameSpec {
  url: string;
  cookieWrites?: Array<Record<string, unknown>>;
  /** evaluate never settles (a PDF viewer or a wedged frame). */
  hang?: boolean;
  /** Index of the parent frame in the list (`about:blank` and `about:srcdoc` frames inherit its origin). */
  parent?: number;
}

interface FakeFrame {
  url: () => string;
  parentFrame: () => FakeFrame | null;
  evaluate: (fn: (...a: unknown[]) => unknown) => Promise<unknown>;
}

function fakePage(frames: FakeFrameSpec[]): Page {
  const list: FakeFrame[] = frames.map((f) => ({
    url: () => f.url,
    parentFrame: () => (f.parent === undefined ? null : (list[f.parent] ?? null)),
    evaluate: (fn: (...a: unknown[]) => unknown): Promise<unknown> => {
      if (f.hang) return new Promise(() => undefined);
      switch (fn.name) {
        case 'cookieWritesInPage':
          return Promise.resolve((f.cookieWrites ?? []).slice());
        case 'storageInPage':
          return Promise.resolve({
            origin: /^https?:/.test(f.url) ? new URL(f.url).origin : 'null',
            local: [],
            session: [],
            idb: [],
          });
        case 'storageWritesInPage':
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    },
  }));
  return { frames: () => list, mainFrame: () => list[0] } as unknown as Page;
}

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

function fakeRequest(url: string, type = 'image'): Request {
  const frame = { parentFrame: () => null, url: () => START };
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => frame,
    isNavigationRequest: () => false,
    redirectedFrom: () => null,
    method: () => 'GET',
    resourceType: () => type,
    failure: () => null,
    allHeaders: async () => ({}),
  } as unknown as Request;
}

function fakeResponse(req: Request, setCookie: string[], o: Partial<Response> = {}): Response {
  return {
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    headersArray: async () => setCookie.map((value) => ({ name: 'Set-Cookie', value })),
    serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
    ...o,
  } as unknown as Response;
}

/** A recorder fed with `Set-Cookie` responses: [response URL, Set-Cookie header lines]. */
async function recorded(
  responses: Array<[string, string[]]>,
  options?: ConstructorParameters<typeof NetworkRecorder>[5],
) {
  const ctx = new EventEmitter();
  const counter = { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder('A', 'example.de', counter, false, undefined, options);
  rec.attach(ctx as unknown as BrowserContext);
  rec.beginNavigation(START);
  for (const [url, lines] of responses) {
    const req = fakeRequest(url);
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, lines));
  }
  await rec.flush();
  return rec;
}

describe('parseSetCookies: attributes without values', () => {
  it('name, Domain, Path and Partitioned; the value never appears in the result', () => {
    const out = parseSetCookies([
      'uid=SECRET_UID; Domain=.Tracker-A.Test; Path=/p; Secure; SameSite=None; Partitioned',
      ' plain = SECRET_PLAIN ; HttpOnly',
      '=bad',
      'novalue',
    ]);
    expect(out).toEqual([
      { name: 'uid', domain: 'tracker-a.test', path: '/p', partitioned: true },
      { name: 'plain', partitioned: false },
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('several cookies in one joined header value (separated by a line break)', () => {
    expect(
      parseSetCookies(['a=1; Path=/x\nb=2; Domain=example.de']).map((c) => [c.name, c.path, c.domain]),
    ).toEqual([
      ['a', '/x', undefined],
      ['b', undefined, 'example.de'],
    ]);
  });
});

describe('NetworkRecorder: Set-Cookie origins are keyed by name, domain, path and partition', () => {
  it('host-only cookie: domain = response host, path = default path of the request URL', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/pixel.gif?x=1', ['uid=S1; Path=/; Secure']],
      ['https://tracker-b.test/a/b/pixel.gif', ['uid=S2; Secure']],
      ['https://cdn.tracker-c.test/p.gif', ['uid=S3; Domain=.tracker-c.test; Partitioned']],
    ]);
    const origins = [...rec.setCookieOrigins.values()];
    expect(origins.map((o) => [o.name, o.host, o.domain, o.path, o.partitioned])).toEqual([
      ['uid', 'tracker-a.test', undefined, '/', false],
      ['uid', 'tracker-b.test', undefined, '/a/b', false],
      ['uid', 'cdn.tracker-c.test', 'tracker-c.test', '/', true],
    ]);
    expect(origins.every((o) => typeof o.at === 'number')).toBe(true);
    expect(JSON.stringify(origins)).not.toMatch(/S1|S2|S3/);
  });

  it('three trackers set the same cookie name: three origins, not one', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/p.gif', ['uid=1']],
      ['https://tracker-b.test/p.gif', ['uid=2']],
      ['https://tracker-a.test/other.gif', ['uid=3']],
    ]);
    // The second response of the same host, name, domain, path and partition keeps the first writer.
    expect(rec.setCookieOrigins.size).toBe(2);
    expect(rec.records.map((r) => r.setCookieNames)).toEqual([['uid'], ['uid'], ['uid']]);
  });
});

describe('JarTracker: the setter of a cookie must be able to set it', () => {
  const writeFrom = (name: string, script: string, o: Record<string, unknown> = {}) => ({
    name,
    t: Date.now(),
    script,
    deletion: false,
    ...o,
  });

  it('same cookie name from three origins: every record keeps its own setter', async () => {
    const rec = await recorded([
      ['https://gum.tracker-a.test/sync.gif', ['uid=A; Domain=tracker-a.test; Path=/']],
      ['https://tracker-b.test/sync.gif', ['uid=B; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const page = fakePage([{ url: START, cookieWrites: [writeFrom('uid', 'https://cdn.script.test/t.js')] }]);
    await jar.snapshot(
      fakeContext([
        jarCookie('uid', '.tracker-a.test'),
        jarCookie('uid', 'www.example.de'),
        jarCookie('uid', 'tracker-b.test'),
      ]),
      page,
      moment,
    );
    const by = (domain: string) => jar.cookies.find((c) => c.name === 'uid' && c.domain === domain);
    expect(by('tracker-a.test')).toMatchObject({ setter: 'http-response', setterHost: 'gum.tracker-a.test' });
    expect(by('tracker-b.test')).toMatchObject({ setter: 'http-response', setterHost: 'tracker-b.test' });
    expect(by('www.example.de')).toMatchObject({
      firstParty: true,
      setter: 'script',
      setterHost: 'cdn.script.test',
    });
  });

  it('a first-party cookie is not attributed to a tracker response of the same name', async () => {
    const rec = await recorded([['https://tracker-a.test/sync.gif', ['cto_bundle=A; Path=/']]]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(
      fakeContext([jarCookie('cto_bundle', 'www.example.de')]),
      fakePage([{ url: START }]),
      moment,
    );
    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
    expect(jar.cookies[0]?.setterHost).toBeUndefined();
  });

  it('path and partition must match too; otherwise the setter is unknown', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/sync.gif', ['a=1; Path=/app']],
      ['https://tracker-a.test/sync.gif', ['b=1; Path=/; Partitioned']],
      ['https://tracker-a.test/sync.gif', ['c=1; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(
      fakeContext([
        jarCookie('a', 'tracker-a.test', { path: '/other' }),
        jarCookie('b', 'tracker-a.test'),
        jarCookie('c', 'tracker-a.test', { partitionKey: 'https://example.de' }),
      ]),
      fakePage([{ url: START }]),
      moment,
    );
    expect(jar.cookies.map((c) => [c.name, c.setter])).toEqual([
      ['a', 'unknown'],
      ['b', 'unknown'],
      ['c', 'unknown'],
    ]);
  });

  it('a script on a tracker document cannot be the setter of a first-party cookie', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([
      {
        url: 'https://widget.tracker-a.test/frame.html',
        cookieWrites: [writeFrom('sid', 'https://widget.tracker-a.test/w.js')],
      },
    ]);
    await jar.snapshot(fakeContext([jarCookie('sid', 'www.example.de')]), page, moment);
    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
  });

  it('counterexample: a same-named rejected cookie of another domain does not change the attribution', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/sync.gif', ['uid=A; Path=/']],
      ['https://tracker-c.test/sync.gif', ['uid=C; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', 'tracker-a.test')]), fakePage([{ url: START }]), moment);
    jar.finalize(moment);
    const uid = jar.cookies.filter((c) => c.name === 'uid');
    expect(uid.map((c) => [c.state, c.domain, c.setterHost])).toEqual([
      ['accepted', 'tracker-a.test', 'tracker-a.test'],
      ['attempted', 'tracker-c.test', 'tracker-c.test'],
    ]);
  });
});

describe('JarTracker: domain of an attempted script cookie', () => {
  const write = (o: Record<string, unknown> = {}) => ({
    name: '_probe',
    t: Date.now(),
    script: 'https://cdn.tracker-a.test/t.js?account=SECRET_ACCOUNT',
    deletion: false,
    ...o,
  });
  const attempted = (jar: JarTracker) => jar.cookies.filter((c) => c.state === 'attempted');

  it('a third-party script on a first-party page: the cookie belongs to the document, not to the script host', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(fakeContext([]), fakePage([{ url: START, cookieWrites: [write()] }]), moment);
    jar.finalize(moment);
    expect(attempted(jar)).toHaveLength(1);
    expect(attempted(jar)[0]).toMatchObject({
      name: '_probe',
      domain: 'www.example.de',
      firstParty: true,
      setter: 'script',
      setterHost: 'cdn.tracker-a.test',
    });
    expect(JSON.stringify(jar.cookies)).not.toContain('SECRET_ACCOUNT');
  });

  it('the same script inside a third-party frame: domain = host of that frame, third party', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(
      fakeContext([]),
      fakePage([{ url: 'https://widget.tracker-b.test/frame.html', cookieWrites: [write()] }]),
      moment,
    );
    jar.finalize(moment);
    expect(attempted(jar)[0]).toMatchObject({
      domain: 'widget.tracker-b.test',
      firstParty: false,
      setter: 'script',
      setterHost: 'cdn.tracker-a.test',
    });
  });

  it('the parsed Domain= attribute of the write wins over the host of the document', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(
      fakeContext([]),
      fakePage([{ url: START, cookieWrites: [write({ domain: 'example.de', host: 'www.example.de' })] }]),
      moment,
    );
    jar.finalize(moment);
    expect(attempted(jar)[0]).toMatchObject({ domain: 'example.de', firstParty: true });
  });

  it('the same name written in two frames gives two records, one per domain', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(
      fakeContext([]),
      fakePage([
        { url: START, cookieWrites: [write()] },
        { url: 'https://widget.tracker-b.test/frame.html', cookieWrites: [write()] },
      ]),
      moment,
    );
    jar.finalize(moment);
    expect(attempted(jar).map((c) => [c.domain, c.firstParty])).toEqual([
      ['www.example.de', true],
      ['widget.tracker-b.test', false],
    ]);
  });

  it('a jar cookie of another domain with the same name does not hide the attempted record', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(
      fakeContext([jarCookie('_probe', 'tracker-z.test')]),
      fakePage([{ url: START, cookieWrites: [write()] }]),
      moment,
    );
    jar.finalize(moment);
    expect(attempted(jar).map((c) => c.domain)).toEqual(['www.example.de']);
  });

  it('the host of an attempted Set-Cookie response is its domain unless Domain= says otherwise', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/p.gif', ['h=1; Path=/']],
      ['https://gum.tracker-b.test/p.gif', ['d=1; Domain=tracker-b.test; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([]), fakePage([{ url: START }]), moment);
    jar.finalize(moment);
    expect(attempted(jar).map((c) => [c.name, c.domain, c.setterHost, c.firstParty])).toEqual([
      ['h', 'tracker-a.test', 'tracker-a.test', false],
      ['d', 'tracker-b.test', 'gum.tracker-b.test', false],
    ]);
  });
});

describe('JarTracker: a Set-Cookie after the click marks only the cookie it can be', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const post: Moment = { ...moment, phase: 'B', tRef: 'click', afterClick: true, tMs: 500 };

  /** A phase-B recorder that answers one request at a time, like the collector feeds it. */
  function liveRecorder() {
    const ctx = new EventEmitter();
    const counter = { limit: 2000, issued: 0, truncated: false };
    const rec = new NetworkRecorder('B', 'example.de', counter, false);
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

  /** Three same-named cookies (first party, tracker A, tracker B), all set by responses before the click. */
  async function threeUids(extra: Partial<JarCookie> = {}) {
    const { rec, send } = liveRecorder();
    await send('https://www.example.de/a.gif', ['uid=1; Path=/']);
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await send('https://tracker-b.test/p.gif', ['uid=3; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([
      jarCookie('uid', 'www.example.de', extra),
      jarCookie('uid', 'tracker-a.test', extra),
      jarCookie('uid', 'tracker-b.test', extra),
    ]);
    const page = fakePage([{ url: START }]);
    await jar.snapshot(context, page, { ...moment, phase: 'B' });
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    return { rec, send, jar, context, page };
  }
  const flags = (jar: JarTracker, domain: string) =>
    jar.cookies.filter((c) => c.name === 'uid' && c.domain === domain).map((c) => c.afterClick);

  it('one tracker re-sets the cookie after "Ablehnen": only its cookie gets the second, afterClick record', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/']);
    await jar.snapshot(context, page, post);
    expect(flags(jar, 'www.example.de')).toEqual([false]);
    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'tracker-b.test')).toEqual([false, true]);
    expect(JSON.stringify(jar.cookies)).not.toMatch(/SECRET/);
  });

  it('a first-party response after the click marks the first-party cookie only', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://www.example.de/b.gif', ['uid=9; Path=/']);
    await jar.snapshot(context, page, post);
    expect(flags(jar, 'www.example.de')).toEqual([false, true]);
    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

  it('counterexample: the same name with another Path= after the click is another cookie', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/other']);
    await jar.snapshot(context, page, post);
    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

  it('counterexample: a partitioned Set-Cookie after the click is not the unpartitioned cookie', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/; Partitioned']);
    await jar.snapshot(context, page, post);
    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

  it('counterexample: a Set-Cookie sent before the click does not make a later snapshot an afterClick write', async () => {
    const { rec, send } = liveRecorder();
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('uid', 'tracker-a.test')]);
    const page = fakePage([{ url: START }]);
    await jar.snapshot(context, page, { ...moment, phase: 'B' });
    await sleep(5);
    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await jar.snapshot(context, page, post);
    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
  });

  it('the recorder marks the origin of a key re-sent after the click; the first writer stays the setter', async () => {
    const { rec, send } = liveRecorder();
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await sleep(5);
    rec.markClickAt(performance.now());
    await send('https://tracker-a.test/q.gif', ['uid=3; Path=/']);
    const [origin, ...rest] = [...rec.setCookieOrigins.values()];
    expect(rest).toEqual([]);
    expect(origin).toMatchObject({
      name: 'uid',
      host: 'tracker-a.test',
      url: 'https://tracker-a.test/p.gif',
    });
    expect(origin?.afterClick).toBe(true);
  });
});

describe('JarTracker: a script write from an about:blank or srcdoc frame', () => {
  const blankWrite = (o: Record<string, unknown> = {}) => ({
    name: 'ab_test',
    t: Date.now(),
    script: 'https://cdn.vendor.test/t.js?account=SECRET_ACCOUNT',
    deletion: false,
    host: null,
    domain: null,
    ...o,
  });

  it.each(['about:blank', 'about:srcdoc'])(
    '%s frame of the target: the cookie in the jar is accepted with the script as its setter, no attempted record',
    async (url) => {
      const jar = new JarTracker(target, new Map());
      const page = fakePage([{ url: START }, { url, parent: 0, cookieWrites: [blankWrite()] }]);
      await jar.snapshot(fakeContext([jarCookie('ab_test', 'www.example.de')]), page, moment);
      jar.finalize(moment);
      expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.setter, c.setterHost])).toEqual([
        ['ab_test', 'accepted', 'www.example.de', 'script', 'cdn.vendor.test'],
      ]);
      expect(JSON.stringify(jar.cookies)).not.toContain('SECRET_ACCOUNT');
    },
  );

  it('an about:blank frame inside an about:blank frame inherits through the chain', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([
      { url: START },
      { url: 'about:blank', parent: 0 },
      { url: 'about:blank', parent: 1, cookieWrites: [blankWrite()] },
    ]);
    await jar.snapshot(fakeContext([jarCookie('ab_test', 'www.example.de')]), page, moment);
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.state, c.setter])).toEqual([['accepted', 'script']]);
  });

  it('a write that never reached the jar is attempted for the host of the inherited document', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([{ url: START }, { url: 'about:blank', parent: 0, cookieWrites: [blankWrite()] }]);
    await jar.snapshot(fakeContext([]), page, moment);
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.state, c.domain, c.firstParty, c.setterHost])).toEqual([
      ['attempted', 'www.example.de', true, 'cdn.vendor.test'],
    ]);
  });

  it('counterexample: an about:blank frame inside a third-party frame cannot set a first-party cookie', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([
      { url: START },
      { url: 'https://widget.tracker-b.test/frame.html', parent: 0 },
      { url: 'about:blank', parent: 1, cookieWrites: [blankWrite()] },
    ]);
    await jar.snapshot(fakeContext([jarCookie('ab_test', 'www.example.de')]), page, moment);
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.state, c.domain, c.setter])).toEqual([
      ['accepted', 'www.example.de', 'unknown'],
      ['attempted', 'widget.tracker-b.test', 'script'],
    ]);
  });

  it('counterexample: a frame without any known document host proves nothing → no attempted record', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([{ url: 'about:blank', cookieWrites: [blankWrite()] }]);
    await jar.snapshot(fakeContext([jarCookie('ab_test', 'www.example.de')]), page, moment);
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.state, c.setter])).toEqual([['accepted', 'unknown']]);
  });
});

describe('NetworkRecorder: response metadata that never settles is bounded', () => {
  const never = () => new Promise<never>(() => undefined);

  it('headersArray/serverAddr hanging: flush ends by the local budget, URL, status and state stay', async () => {
    const ctx = new EventEmitter();
    const rec = new NetworkRecorder(
      'A',
      'example.de',
      { limit: 2000, issued: 0, truncated: false },
      false,
      undefined,
      {
        metaTimeoutMs: 60,
      },
    );
    rec.attach(ctx as unknown as BrowserContext);
    rec.beginNavigation(START);
    const req = fakeRequest('https://www.example.de/doc.pdf', 'document');
    ctx.emit('request', req);
    ctx.emit(
      'response',
      fakeResponse(req, [], { headersArray: never, serverAddr: never } as Partial<Response>),
    );
    const t0 = Date.now();
    await rec.flush();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(rec.records[0]).toMatchObject({
      url: 'https://www.example.de/doc.pdf',
      status: 200,
      state: 'completed',
      delivery: 'sent',
      result: { kind: 'response', status: 200 },
    });
    expect(rec.records[0]?.connectedIp).toBeUndefined();
  });

  it('a late answer after the budget does not change the stored record', async () => {
    const ctx = new EventEmitter();
    let release: (v: Array<{ name: string; value: string }>) => void = () => undefined;
    const late = new Promise<Array<{ name: string; value: string }>>((r) => {
      release = r;
    });
    const rec = new NetworkRecorder(
      'A',
      'example.de',
      { limit: 2000, issued: 0, truncated: false },
      false,
      undefined,
      {
        metaTimeoutMs: 40,
      },
    );
    rec.attach(ctx as unknown as BrowserContext);
    rec.beginNavigation(START);
    const req = fakeRequest('https://tracker-a.test/p.gif');
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, [], { headersArray: () => late } as Partial<Response>));
    await rec.flush();
    release([{ name: 'Set-Cookie', value: 'uid=LATE; Path=/' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.records[0]?.setCookieNames).toBeUndefined();
    expect(rec.setCookieOrigins.size).toBe(0);
  });

  it('an aborted signal ends the wait at once', async () => {
    const ctx = new EventEmitter();
    const abort = new AbortController();
    const rec = new NetworkRecorder(
      'A',
      'example.de',
      { limit: 2000, issued: 0, truncated: false },
      false,
      undefined,
      {
        metaTimeoutMs: 60_000,
        signal: abort.signal,
      },
    );
    rec.attach(ctx as unknown as BrowserContext);
    rec.beginNavigation(START);
    const req = fakeRequest('https://www.example.de/doc.pdf', 'document');
    ctx.emit('request', req);
    ctx.emit(
      'response',
      fakeResponse(req, [], { headersArray: never, serverAddr: never } as Partial<Response>),
    );
    setTimeout(() => abort.abort(), 30);
    const t0 = Date.now();
    await rec.flush();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(rec.records[0]).toMatchObject({ status: 200, state: 'completed' });
  });

  it('flush({ timeoutMs }) returns false when pending work is abandoned', async () => {
    const ctx = new EventEmitter();
    const rec = new NetworkRecorder(
      'A',
      'example.de',
      { limit: 2000, issued: 0, truncated: false },
      false,
      undefined,
      {
        metaTimeoutMs: 60_000,
      },
    );
    rec.attach(ctx as unknown as BrowserContext);
    rec.beginNavigation(START);
    const req = fakeRequest('https://www.example.de/doc.pdf', 'document');
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, [], { headersArray: never } as Partial<Response>));
    expect(await rec.flush({ timeoutMs: 40 })).toBe(false);
    const quiet = await recorded([['https://tracker-a.test/p.gif', ['uid=1']]]);
    expect(await quiet.flush({ timeoutMs: 40 })).toBe(true);
  });
});

describe('JarTracker: frame.evaluate that never settles is bounded', () => {
  it('a hung (PDF viewer) frame: snapshot ends in under 2 s, reports the error, keeps the jar cookies', async () => {
    const errors: string[] = [];
    const jar = new JarTracker(target, new Map(), { onError: (what) => errors.push(what) });
    const t0 = Date.now();
    const values = await jar.snapshot(
      fakeContext([jarCookie('sid', 'www.example.de')]),
      fakePage([{ url: 'https://www.example.de/datenschutz.pdf', hang: true }]),
      moment,
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(jar.cookies.map((c) => c.name)).toEqual(['sid']);
    expect(values).toEqual(['SECRET_VALUE']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('an aborted signal skips the in-page reads without waiting', async () => {
    const abort = new AbortController();
    abort.abort();
    const jar = new JarTracker(target, new Map(), {
      signal: abort.signal,
      evalTimeoutMs: 60_000,
    });
    const t0 = Date.now();
    await jar.snapshot(
      fakeContext([jarCookie('sid', 'www.example.de')]),
      fakePage([{ url: START, hang: true }]),
      moment,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(jar.cookies.map((c) => c.name)).toEqual(['sid']);
  });

  it('control: responsive frames are read in full', async () => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(
      fakeContext([]),
      fakePage([
        { url: START, cookieWrites: [{ name: '_probe', t: Date.now(), script: null, deletion: false }] },
      ]),
      moment,
    );
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.name, c.state])).toEqual([['_probe', 'attempted']]);
  });
});
