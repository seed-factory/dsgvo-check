/**
 * The network recorder with fake Playwright objects (no browser): one monotonic `atMs` scale from the scan start,
 * navigation/action/frame/parent ids, independent `delivery` / `result`; a body error keeps the response.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Request, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { REQUEST_FEATURES_VERSION } from '../../../../../src/collectors/browser/recording/features.ts';
import { NetworkRecorder } from '../../../../../src/collectors/browser/recording/recorder.ts';

interface FakeFrame {
  parentFrame(): FakeFrame | null;
  url(): string;
}

function frame(parent: FakeFrame | null, url = 'https://www.example.de/'): FakeFrame {
  return { parentFrame: () => parent, url: () => url };
}

function request(
  url: string,
  o: { frame?: FakeFrame; nav?: boolean; from?: Request; type?: string; failure?: string } = {},
): Request {
  const f = o.frame ?? frame(null);
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => f,
    isNavigationRequest: () => o.nav ?? false,
    redirectedFrom: () => o.from ?? null,
    method: () => 'GET',
    resourceType: () => o.type ?? 'image',
    failure: () => (o.failure ? { errorText: o.failure } : null),
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

function setup(clock?: () => number) {
  const ctx = new EventEmitter();
  const counter = { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder('B', 'example.de', counter, false, clock);
  rec.attach(ctx as unknown as BrowserContext);
  return { ctx, rec };
}

describe('NetworkRecorder: 5.3 request fields', () => {
  it('atMs is on the scan clock, ids link navigation, click, frame and redirect', async () => {
    let now = 1_000;
    const { ctx, rec } = setup(() => now);
    const main = frame(null);
    const sub = frame(main, 'https://widget.example.net/frame');

    // navigation 1: a document, its redirect, a request of a sub-frame
    const nav1 = rec.beginNavigation('https://www.example.de/');
    const first = request('http://www.example.de/', { frame: main, nav: true, type: 'document' });
    ctx.emit('request', first);
    now = 1_050;
    const second = request('https://www.example.de/', {
      frame: main,
      nav: true,
      from: first,
      type: 'document',
    });
    ctx.emit('request', second);
    now = 2_000;
    ctx.emit('request', request('https://widget.example.net/x.js', { frame: sub, type: 'script' }));

    // the click, a request after it, then the reload as navigation 2
    now = 3_000;
    rec.markClickAt(performance.now());
    now = 3_400;
    ctx.emit('request', request('https://www.google-analytics.com/g/collect?en=x', { frame: main }));
    const nav2 = rec.beginNavigation('https://www.example.de/');
    now = 5_000;
    ctx.emit('request', request('https://www.example.de/', { frame: main, nav: true, type: 'document' }));

    const [a, b, c, d, e] = rec.records;
    expect(nav1).toBe('B-n1');
    expect(nav2).toBe('B-n2');
    expect(rec.records.map((r) => r.atMs)).toEqual([1_000, 1_050, 2_000, 3_400, 5_000]);
    expect(rec.records.map((r) => r.navigationId)).toEqual(['B-n1', 'B-n1', 'B-n1', 'B-n1', 'B-n2']);
    expect(b?.parentRequestId).toBe(a?.id);
    expect(a?.parentRequestId).toBeUndefined();
    expect(a?.frameId).toBe(b?.frameId);
    expect(c?.frameId).toBeDefined();
    expect(c?.frameId).not.toBe(a?.frameId);

    // The click is an action of the phase; requests after it carry its id (also after the reload).
    expect(rec.actionId).toBe('B-a1');
    expect([a, b, c].map((r) => r?.actionId)).toEqual([undefined, undefined, undefined]);
    expect(d?.actionId).toBe('B-a1');
    expect(e?.actionId).toBe('B-a1');

    for (const r of rec.records) {
      expect(r).toMatchObject({ parserVersion: REQUEST_FEATURES_VERSION, observationSource: 'playwright' });
    }
  });

  it('a body error after the response keeps delivery `sent` and result `response`', async () => {
    const { ctx, rec } = setup();
    rec.beginNavigation('https://www.example.de/');
    const hit = request('https://www.google-analytics.com/g/collect?en=page_view');
    ctx.emit('request', hit);
    ctx.emit('response', response(hit, 204));
    await rec.flush();

    ctx.emit('requestfailed', request('unused'));
    ctx.emit('requestfailed', Object.assign(hit, { failure: () => ({ errorText: 'net::ERR_ABORTED' }) }));

    const r = rec.records[0];
    expect(r).toMatchObject({ delivery: 'sent', result: { kind: 'response', status: 204 } });
    expect(r?.failureText).toBe('net::ERR_ABORTED');
  });

  it('flush without a timeout waits for a slow handler (an unlimited wait is no 1 ms timer)', async () => {
    const { ctx, rec } = setup();
    rec.beginNavigation('https://www.example.de/');
    const slow = request('https://www.example.net/slow.js');
    ctx.emit('request', slow);
    const res = {
      ...response(slow, 200),
      headersArray: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ name: 'set-cookie', value: 'late_cookie=1; Path=/' }]), 80),
        ),
    } as unknown as Response;
    ctx.emit('response', res);
    expect(await rec.flush()).toBe(true);
    expect(rec.records[0]).toMatchObject({
      state: 'completed',
      status: 200,
      setCookieNames: ['late_cookie'],
    });
  });

  it('an identifier in a path parameter is a feature of the record (read before redaction)', () => {
    const { ctx, rec } = setup();
    rec.beginNavigation('https://www.example.de/');
    ctx.emit(
      'request',
      request('https://ad.doubleclick.net/ddm/activity/src=1;dc_pre=PATH_MARKER_VALUE;ord=123'),
    );
    ctx.emit('request', request('https://ad.doubleclick.net/ddm/activity/src=1;ord=123'));
    const [withId, without] = rec.records;
    expect(withId).toMatchObject({ identifierPresent: true, identifierNames: ['dc_pre'] });
    expect(without).toMatchObject({ identifierPresent: false });
    expect(without?.identifierNames).toBeUndefined();
    // Names only: the value is kept in memory for the stored-identifier correlation and never in the record.
    expect(JSON.stringify(rec.records)).not.toContain('PATH_MARKER_VALUE=');
  });

  it('aborted before any response → result `aborted`; other failures → `failed`', () => {
    const { ctx, rec } = setup();
    rec.beginNavigation('https://www.example.de/');
    const aborted = request('https://cdn.example.net/a.js', { failure: 'net::ERR_ABORTED' });
    const refused = request('https://cdn.example.net/b.js', { failure: 'net::ERR_CONNECTION_REFUSED' });
    ctx.emit('request', aborted);
    ctx.emit('request', refused);
    ctx.emit('requestfailed', aborted);
    ctx.emit('requestfailed', refused);
    expect(rec.records.map((r) => [r.delivery, r.result])).toEqual([
      ['attempted', { kind: 'aborted' }],
      ['attempted', { kind: 'failed', errorText: 'net::ERR_CONNECTION_REFUSED' }],
    ]);
  });
});
