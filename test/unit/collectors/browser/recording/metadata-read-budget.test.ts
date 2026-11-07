/**
 * Pure tests (no browser): `headersArray()`, `serverAddr()` and `frame.evaluate()` that never settle end by a local
 * budget or an aborted signal, keep the facts collected so far and do not change a stored record afterwards.
 */
import type { EventEmitter } from 'node:events';
import type { Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker } from '../../../../../src/collectors/browser/recording/jar.ts';
import type { RecorderOptions } from '../../../../../src/collectors/browser/recording/recorder.ts';
import {
  fakeContext,
  fakePage,
  fakeRecorder,
  fakeRequest,
  fakeResponse,
  jarCookie,
  moment,
  recorded,
  START,
  target,
} from '../cookies/fakes.ts';

describe('NetworkRecorder: response metadata that never settles is bounded', () => {
  const never = () => new Promise<never>(() => undefined);
  /** Generous upper bound for "ends by the local budget", far below the 60 s budgets that must not be waited for. */
  const PROMPT_MS = 1_500;

  /** A phase-A recorder on a fresh context whose navigation to START has begun. */
  const startedRecorder = (options: RecorderOptions) => fakeRecorder({ options, start: START });

  /** A document request whose response metadata never arrives. */
  function emitHangingDocument(ctx: EventEmitter) {
    const req = fakeRequest('https://www.example.de/doc.pdf', { type: 'document' });
    ctx.emit('request', req);
    ctx.emit(
      'response',
      fakeResponse(req, [], { headersArray: never, serverAddr: never } as Partial<Response>),
    );
  }

  it('headersArray/serverAddr hanging: flush ends by the local budget, URL, status and state stay', async () => {
    const { ctx, rec } = startedRecorder({ metaTimeoutMs: 60 });
    emitHangingDocument(ctx);

    const t0 = Date.now();
    await rec.flush();

    expect(Date.now() - t0).toBeLessThan(PROMPT_MS);
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
    let release: (v: Array<{ name: string; value: string }>) => void = () => undefined;
    const late = new Promise<Array<{ name: string; value: string }>>((r) => {
      release = r;
    });
    const { ctx, rec } = startedRecorder({ metaTimeoutMs: 40 });
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
    const abort = new AbortController();
    const { ctx, rec } = startedRecorder({ metaTimeoutMs: 60_000, signal: abort.signal });
    emitHangingDocument(ctx);
    setTimeout(() => abort.abort(), 30);

    const t0 = Date.now();
    await rec.flush();

    expect(Date.now() - t0).toBeLessThan(PROMPT_MS);
    expect(rec.records[0]).toMatchObject({ status: 200, state: 'completed' });
  });

  it('flush({ timeoutMs }) returns false when pending work is abandoned', async () => {
    const { ctx, rec } = startedRecorder({ metaTimeoutMs: 60_000 });
    const req = fakeRequest('https://www.example.de/doc.pdf', { type: 'document' });
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
    expect(errors.length, 'the hung frame is reported through onError').toBeGreaterThan(0);
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
