/**
 * Pure tests (no browser): `headersArray()`, `serverAddr()` and `frame.evaluate()` that never settle end by a local
 * budget or an aborted signal, keep the facts collected so far and do not change a stored record afterwards.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker } from '../../../../src/collectors/browser/jar.ts';
import { NetworkRecorder } from '../../../../src/collectors/browser/recorder.ts';
import {
  fakeContext,
  fakePage,
  fakeRequest,
  fakeResponse,
  jarCookie,
  moment,
  recorded,
  START,
  target,
} from './cookie-fakes.ts';

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
