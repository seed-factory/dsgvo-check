/**
 * The quiet decision counts only requests of the current navigation and document: never-ending requests of an earlier
 * page must not hold the next page until HARD_CAP, and stay in the records unchanged. Fake Playwright objects.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Request, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { NetworkRecorder } from '../../../../../src/collectors/browser/recording/recorder.ts';

interface FakeFrame {
  parentFrame(): FakeFrame | null;
  url(): string;
}

function frame(parent: FakeFrame | null = null, url = 'https://www.example.test/'): FakeFrame {
  return { parentFrame: () => parent, url: () => url };
}

function request(
  url: string,
  o: { frame?: FakeFrame; nav?: boolean; from?: Request; type?: string } = {},
): Request {
  const f = o.frame ?? frame();
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => f,
    isNavigationRequest: () => o.nav ?? false,
    redirectedFrom: () => o.from ?? null,
    method: () => 'GET',
    resourceType: () => o.type ?? 'fetch',
    failure: () => null,
    allHeaders: async () => ({}),
  } as unknown as Request;
}

function response(req: Request, status: number): Response {
  return {
    request: () => req,
    status: () => status,
    fromServiceWorker: () => false,
    headersArray: async () => [],
    serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
  } as unknown as Response;
}

function setup() {
  const ctx = new EventEmitter();
  const counter = { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder('A', 'example.test', counter, false);
  rec.attach(ctx as unknown as BrowserContext);
  return { ctx, rec, main: frame() };
}

const URL_1 = 'https://www.example.test/';
const URL_2 = 'https://www.example.test/impressum/';

describe('NetworkRecorder.inflight: the quiet decision looks at the current navigation only', () => {
  it('requests of the previous page that never end do not count on the next page', () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    ctx.emit('request', request(URL_1, { frame: main, nav: true, type: 'document' }));
    for (const n of [1, 2, 3]) ctx.emit('request', request(`https://www.example.test/poll-${n}`));
    expect(rec.inflight()).toBe(4);

    // the next page starts from zero
    rec.beginNavigation(URL_2);
    expect(rec.inflight()).toBe(0);
    ctx.emit('request', request(URL_2, { frame: main, nav: true, type: 'document' }));
    expect(rec.inflight()).toBe(1);
    ctx.emit('request', request('https://www.example.test/app.js', { type: 'script' }));
    expect(rec.inflight()).toBe(2);
  });

  it('counterexample: requests of the current navigation still count, a finished one does not', () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    const doc = request(URL_1, { frame: main, nav: true, type: 'document' });
    const a = request('https://www.example.test/a');
    const b = request('https://www.example.test/b');
    ctx.emit('request', doc);
    ctx.emit('request', a);
    ctx.emit('request', b);
    expect(rec.inflight()).toBe(3);

    ctx.emit('requestfinished', a);
    ctx.emit('requestfailed', b);
    expect(rec.inflight()).toBe(1);

    // A request cannot come back to life: an event of an earlier page's request that arrives late changes nothing.
    rec.beginNavigation(URL_2);
    ctx.emit('requestfinished', doc);
    expect(rec.inflight()).toBe(0);
  });

  it('a late end of a request of the previous page does not hide a request of the current one', () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    const old = request('https://www.example.test/slow');
    ctx.emit('request', old);

    rec.beginNavigation(URL_2);
    ctx.emit('request', request(URL_2, { frame: main, nav: true, type: 'document' }));
    ctx.emit('request', request('https://www.example.test/next'));
    ctx.emit('requestfinished', old);

    expect(rec.inflight()).toBe(2);
  });

  it('a new document of the main frame (JS redirect) drops the requests of the document it replaced', () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    ctx.emit('request', request(URL_1, { frame: main, nav: true, type: 'document' }));
    ctx.emit('request', request('https://www.example.test/x1'));
    ctx.emit('request', request('https://www.example.test/x2'));
    expect(rec.inflight()).toBe(3);

    // The page replaces itself: a new document request of the same main frame inside the same navigation.
    ctx.emit('request', request(URL_2, { frame: main, nav: true, type: 'document' }));
    expect(rec.inflight()).toBe(1);
    ctx.emit('request', request('https://www.example.test/y1'));
    expect(rec.inflight()).toBe(2);
  });

  it('counterexamples: an HTTP redirect, a subframe document and another page do not reset the count', () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    const first = request('http://www.example.test/', { frame: main, nav: true, type: 'document' });
    ctx.emit('request', first);
    ctx.emit('request', request('https://www.example.test/x1'));

    // Redirect hop of the same navigation.
    ctx.emit('request', request(URL_1, { frame: main, nav: true, from: first, type: 'document' }));
    expect(rec.inflight()).toBe(3);

    // A subframe document is not a new document of the page.
    const sub = frame(main, 'https://widget.example.test/');
    ctx.emit('request', request('https://widget.example.test/', { frame: sub, nav: true, type: 'document' }));
    expect(rec.inflight()).toBe(4);

    // A document request of a frame tree that is not the page's main frame (a popup) leaves the page alone.
    ctx.emit(
      'request',
      request('https://popup.example.test/', { frame: frame(), nav: true, type: 'document' }),
    );
    expect(rec.inflight()).toBe(5);
  });

  it('records of the previous page stay in the snapshot as observed: state and delivery are untouched', async () => {
    const { ctx, rec, main } = setup();
    rec.beginNavigation(URL_1);
    ctx.emit('request', request(URL_1, { frame: main, nav: true, type: 'document' }));
    const hung = request('https://www.example.test/poll');
    const answered = request('https://www.example.test/ok');
    ctx.emit('request', hung);
    ctx.emit('request', answered);
    ctx.emit('response', response(answered, 200));
    await rec.flush();
    const before = JSON.stringify(rec.records);

    rec.beginNavigation(URL_2);
    ctx.emit('request', request(URL_2, { frame: main, nav: true, type: 'document' }));

    expect(JSON.stringify(rec.records.slice(0, 3))).toBe(before);
    expect(rec.records[1]).toMatchObject({ navigationId: 'A-n1', state: 'attempted', delivery: 'attempted' });
    expect(rec.records[2]).toMatchObject({ state: 'completed', delivery: 'sent' });
    expect(rec.records[3]).toMatchObject({ navigationId: 'A-n2' });
    expect(rec.inflight()).toBe(1);
  });

  it('long-lived resource types still never count', () => {
    const { ctx, rec } = setup();
    rec.beginNavigation(URL_1);
    ctx.emit('request', request('wss://www.example.test/socket', { type: 'websocket' }));
    ctx.emit('request', request('https://www.example.test/events', { type: 'eventsource' }));
    expect(rec.inflight()).toBe(0);
  });
});
