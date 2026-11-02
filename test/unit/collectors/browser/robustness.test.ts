import { EventEmitter } from 'node:events';
import type { BrowserContext, Page, Request, Response } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkRecorder } from '../../../../src/collectors/browser/recorder.ts';
import { hostClassifier, type LookupError } from '../../../../src/collectors/browser/ssrf.ts';
import { navigationErrorCode, settleWithin, visitPage } from '../../../../src/collectors/browser/visit.ts';
import { defaultNetworkConfig, type Lookup } from '../../../../src/core/net.ts';
import { FAST_TIMING } from '../../../integration/browser/helpers.ts';

const never = <T>() => new Promise<T>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Advance the simulated deadline and assert completion before awaiting a potentially never-ending promise. */
async function advance<T>(work: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  let result: T | undefined;
  void work.then((value) => {
    settled = true;
    result = value;
  });
  await vi.advanceTimersByTimeAsync(ms);
  expect(settled, `operation must settle within ${ms} simulated milliseconds`).toBe(true);
  return result as T;
}

describe('the code of a failed navigation keeps its digits', () => {
  it.each([
    ['page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.example.test/', 'ERR_HTTP2_PROTOCOL_ERROR'],
    ['page.goto: net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example.test/', 'ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_QUIC_PROTOCOL_ERROR', 'ERR_QUIC_PROTOCOL_ERROR'],
  ])('%s → %s', (message, code) => {
    expect(navigationErrorCode(message)).toBe(code);
  });

  it('counterexamples: timeouts, downloads and unknown errors keep their own codes', () => {
    expect(navigationErrorCode('page.goto: Timeout 30000ms exceeded.')).toBe('timeout');
    expect(navigationErrorCode('page.goto: Download is starting')).toBe('download');
    expect(navigationErrorCode('something else')).toBe('navigation-error');
  });
});

describe('settleWithin', () => {
  const live = new AbortController().signal;

  it('a promise that settles in time wins; a rejection gives the fallback without a cut', async () => {
    expect(await settleWithin(Promise.resolve(7), 1_000, live, 0)).toEqual({ value: 7 });
    expect(await settleWithin(Promise.reject(new Error('gone')), 1_000, live, 0)).toEqual({ value: 0 });
  });

  it('a promise that never settles is cut by the budget or by the abort', async () => {
    expect(await advance(settleWithin(never<number>(), 40, live, -1), 40)).toEqual({
      value: -1,
      cut: 'timeout',
    });
    const ac = new AbortController();
    const pending = settleWithin(never<number>(), 60_000, ac.signal, -1);
    ac.abort();
    expect(await pending).toEqual({ value: -1, cut: 'aborted' });
    expect(await settleWithin(never<number>(), 60_000, ac.signal, -1)).toEqual({ value: -1, cut: 'aborted' });
  });
});

describe('a navigation whose response metadata never arrives (PDF viewer) still ends', () => {
  const URL_ = 'https://www.example.test/datenschutz/';
  function fakes(over: { flush?: () => Promise<boolean> } = {}) {
    const response = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/pdf' }),
      headersArray: () => never(),
      serverAddr: () => never(),
      url: () => URL_,
      request: () => ({ redirectedFrom: () => null }),
    } as unknown as Response;
    const page = {
      goto: async () => response,
      reload: async () => response,
      waitForLoadState: async () => undefined,
      url: () => URL_,
    } as unknown as Page;
    const recorder = {
      beginNavigation: () => 'A-n1',
      rebindNavigation: () => undefined,
      lastRequestStart: () => null,
      inflight: () => 0,
      flush: over.flush ?? (() => never<boolean>()),
    } as unknown as NetworkRecorder;
    return { page, recorder };
  }
  const input = (f: ReturnType<typeof fakes>, signal: AbortSignal) => ({
    page: f.page,
    recorder: f.recorder,
    timing: { ...FAST_TIMING, quietWindowMs: 10 },
    phaseTiming: { minDwellMs: 10, hardCapMs: 300 },
    signal,
    target: { etld1: 'example.test', host: 'www.example.test' },
    now: () => new Date(),
  });
  const spec = { rawUrl: URL_, role: 'privacy' as const, order: 1, phase: 'A' as const, firstVisit: false };

  it('flush, headers and server address are cut by the page budget; URL and status are kept', async () => {
    const r = await advance(visitPage(input(fakes(), new AbortController().signal), spec), 2_000);
    expect(r.visit).toMatchObject({
      url: URL_,
      finalUrl: URL_,
      navigation: { status: 200, serverIp: null },
      evaluable: false,
      notEvaluableReason: 'not-html',
      dom: null,
    });
    // The content type from the response event is enough to see that this is no HTML page.
    expect(r.contentType).toBe('application/pdf');
    expect(r.limitations?.map((l) => l.code)).toEqual([
      'recorder-flush-timeout',
      'response-headers-timeout',
      'server-address-timeout',
    ]);
  });

  it('after the scan abort nothing is waited for', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await advance(visitPage(input(fakes(), ac.signal), spec), 0);
    expect(r.limitations).toBeUndefined();
    expect(r.visit.navigation.status).toBe(200);
  });

  it('counterexample: metadata that arrives in time is used, no limitation', async () => {
    const f = fakes({ flush: async () => true });
    const response = (await (f.page.goto as () => Promise<Response>)()) as unknown as {
      headersArray: () => Promise<unknown>;
      serverAddr: () => Promise<unknown>;
    };
    response.headersArray = async () => [{ name: 'Content-Type', value: 'application/pdf' }];
    response.serverAddr = async () => ({ ipAddress: '93.184.215.14', port: 443 });
    const r = await advance(visitPage(input(f, new AbortController().signal), spec), 100);
    expect(r.visit.navigation.serverIp).toBe('93.184.215.14');
    expect(r.limitations).toBeUndefined();
  });
});

describe('response metadata that arrives after the page budget is kept until the phase ends', () => {
  const URL_ = 'https://www.example.test/';
  /** The metadata of the beacon arrives later than the floor of the page budget, within the budget of the recorder. */
  const LATE_MS = 900;
  const late = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), LATE_MS));

  function beacon(ctx: EventEmitter) {
    const frame = { parentFrame: () => null, url: () => URL_ };
    const req = {
      url: () => 'https://tracker.example.net/collect',
      postData: () => null,
      serviceWorker: () => null,
      frame: () => frame,
      isNavigationRequest: () => false,
      redirectedFrom: () => null,
      method: () => 'GET',
      resourceType: () => 'xhr',
      failure: () => null,
      allHeaders: () => late({ cookie: '_ga=GA1.2.123456789.1700000000' }),
    } as unknown as Request;
    const res = {
      request: () => req,
      status: () => 200,
      fromServiceWorker: () => false,
      headersArray: () => late([{ name: 'set-cookie', value: 'late_cookie=1; Path=/' }]),
      serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
    } as unknown as Response;
    // The request is never finished: the page keeps one request open, so the quiet wait ends at the hard cap.
    ctx.emit('request', req);
    ctx.emit('response', res);
  }

  /** A page whose navigation starts a beacon, exhausts the HARD_CAP and returns before the metadata arrives. */
  async function visit() {
    const ctx = new EventEmitter();
    const counter = { limit: 2000, issued: 0, truncated: false };
    const recorder = new NetworkRecorder('A', 'example.test', counter, false);
    recorder.attach(ctx as unknown as BrowserContext);
    const main = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/pdf' }),
      headersArray: async () => [{ name: 'Content-Type', value: 'application/pdf' }],
      serverAddr: async () => ({ ipAddress: '93.184.215.13', port: 443 }),
      url: () => URL_,
      request: () => ({ redirectedFrom: () => null }),
    } as unknown as Response;
    const page = {
      goto: async () => {
        beacon(ctx);
        return main;
      },
      reload: async () => main,
      waitForLoadState: async () => undefined,
      url: () => URL_,
    } as unknown as Page;
    const t0 = Date.now();
    const r = await visitPage(
      {
        page,
        recorder,
        timing: { ...FAST_TIMING, quietWindowMs: 10 },
        phaseTiming: { minDwellMs: 10, hardCapMs: 50 },
        signal: new AbortController().signal,
        target: { etld1: 'example.test', host: 'www.example.test' },
        now: () => new Date(),
      },
      { rawUrl: URL_, role: 'start', order: 0, phase: 'A', firstVisit: false },
    );
    return { r, recorder, visitMs: Date.now() - t0 };
  }

  it('the visit does not wait for them, and the phase-end flush finds them in the records', async () => {
    const { r, recorder, visitMs } = await advance(visit(), 600);
    // The page budget ran out before the metadata arrived: this is the scenario.
    expect(visitMs).toBeLessThan(LATE_MS);
    expect(r.limitations?.map((l) => l.code)).toContain('recorder-flush-timeout');
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    // The flush of the phase end (collector: 2 s) waits for the handlers, which are still within their own budget.
    expect(await advance(recorder.flush({ timeoutMs: 3_000 }), 2_000)).toBe(true);
    expect(recorder.records[0]).toMatchObject({
      setCookieNames: ['late_cookie'],
      connectedIp: { value: '93.184.215.14' },
      sentCookieNames: ['_ga'],
      identifierPresent: true,
    });
    recorder.dispose();
  });

  it('counterexample: what the phase is sealed without is dropped — nothing is written after dispose', async () => {
    const { recorder } = await advance(visit(), 600);
    recorder.dispose();
    await vi.advanceTimersByTimeAsync(LATE_MS + 300);
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    expect(recorder.records[0]?.connectedIp).toBeUndefined();
  });

  it('counterexample: a phase-end flush that gives up abandons the handlers still pending', async () => {
    const { recorder } = await advance(visit(), 600);
    expect(await advance(recorder.flush({ timeoutMs: 50 }), 50)).toBe(false);
    await vi.advanceTimersByTimeAsync(LATE_MS + 300);
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    recorder.dispose();
  });
});

describe('the guard re-asks a resolver that failed for a moment', () => {
  const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code}`), { code });
  const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
  const quick = { backoffMs: [5, 5] } as const;
  const classifier = (lookup: Lookup, errors: LookupError[] = []) =>
    hostClassifier({ ...defaultNetworkConfig(), lookup }, { ...quick, onLookupError: (e) => errors.push(e) });

  it('EAI_AGAIN on the 1st and 2nd call, success on the 3rd → public', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = classifier(async () => {
      calls++;
      if (calls <= 2) throw err('EAI_AGAIN');
      return PUBLIC;
    }, seen);
    expect(await advance(classify('www.example.test'), 20)).toBe('public');
    expect(calls).toBe(3);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([
      ['EAI_AGAIN', 1],
      ['EAI_AGAIN', 2],
    ]);
    // The verdict is cached: no further lookup.
    await advance(classify('www.example.test'), 20);
    expect(calls).toBe(3);
  });

  it('ENOTFOUND stays fail-closed: asked twice, then unresolved; the code is reported', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = classifier(async () => {
      calls++;
      throw err('ENOTFOUND');
    }, seen);
    expect(await advance(classify('gone.example.test'), 20)).toBe('unresolved');
    expect(calls).toBe(2);
    expect(seen.map((e) => e.code)).toEqual(['ENOTFOUND', 'ENOTFOUND']);
  });

  it('a resolver that keeps failing transiently ends unresolved after 3 attempts, not cached', async () => {
    let calls = 0;
    const classify = classifier(async () => {
      calls++;
      throw err('ETIMEOUT');
    });
    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls).toBe(3);
    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls).toBe(6);
  });

  it('the attempts stay within the time budget', async () => {
    let calls = 0;
    const classify = hostClassifier(
      {
        ...defaultNetworkConfig(),
        lookup: async () => {
          calls++;
          throw err('EAI_AGAIN');
        },
      },
      { backoffMs: [60_000, 60_000], budgetMs: 100 },
    );
    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls).toBe(1);
  });

  it('a private answer is final: no retry', async () => {
    let calls = 0;
    const classify = classifier(async () => {
      calls++;
      return [{ address: '10.0.0.5', family: 4 as const }];
    });
    expect(await advance(classify('intranet.example.test'), 20)).toBe('private');
    expect(calls).toBe(1);
  });
});

describe('every wait for the resolver is bounded by what is left of the shared budget', () => {
  const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code}`), { code });
  const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const within = <T>(work: Promise<T>, ms = 2_500) => advance(work, ms);
  const make = (lookup: Lookup, budgetMs: number, seen: LookupError[] = [], backoffMs: number[] = [1, 1]) =>
    hostClassifier(
      { ...defaultNetworkConfig(), lookup },
      { budgetMs, backoffMs, onLookupError: (e) => seen.push(e) },
    );

  it('a public answer that comes after the budget is not applied: unresolved, a timeout is recorded, not cached', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = make(
      async () => {
        calls++;
        if (calls === 1) {
          await delay(1_000);
          return PUBLIC;
        }
        return [{ address: '10.0.0.5', family: 4 as const }];
      },
      60,
      seen,
    );
    expect(await within(classify('late.example.test'))).toBe('unresolved');
    expect(calls).toBe(1);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([['ETIMEOUT', 1]]);
    // The late "public" must not be cached or applied afterwards: the next document asks again and gets its own answer.
    expect(await within(classify('late.example.test'))).toBe('private');
    expect(calls).toBe(2);
  });

  it('a resolver whose promise never settles ends unresolved within the budget', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = make(
      () => {
        calls++;
        return never();
      },
      60,
      seen,
    );
    expect(await within(classify('hang.example.test'))).toBe('unresolved');
    expect(calls).toBe(1);
    expect(seen.map((e) => e.code)).toEqual(['ETIMEOUT']);
  });

  it('a slow definitive error is cut too: no second ask once the budget is spent', async () => {
    let calls = 0;
    const classify = make(async () => {
      calls++;
      await delay(1_000);
      throw err('ENOTFOUND');
    }, 60);
    expect(await within(classify('slow-gone.example.test'))).toBe('unresolved');
    expect(calls).toBe(1);
  });

  it('the immediate re-ask after ENOTFOUND is bounded as well', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = make(
      () => {
        calls++;
        return calls === 1 ? Promise.reject(err('ENOTFOUND')) : never();
      },
      60,
      seen,
    );
    expect(await within(classify('re-ask.example.test'))).toBe('unresolved');
    expect(calls).toBe(2);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([
      ['ENOTFOUND', 1],
      ['ETIMEOUT', 2],
    ]);
  });

  it('the budget is shared by all attempts: a later attempt gets only the remainder', async () => {
    let calls = 0;
    const classify = make(
      async () => {
        calls++;
        if (calls === 1) throw err('EAI_AGAIN');
        if (calls === 2) {
          await delay(120);
          throw err('EAI_AGAIN');
        }
        return never();
      },
      200,
      [],
      [1, 1],
    );
    expect(await within(classify('shared.example.test'))).toBe('unresolved');
    // 200 ms in all (the 3rd attempt had ~80 ms left), not 200 ms for the 3rd attempt alone.
    expect(calls).toBe(3);
  });

  it('counterexample: a slow answer within the budget still counts (public), nothing is recorded', async () => {
    const seen: LookupError[] = [];
    const classify = make(
      async () => {
        await delay(60);
        return PUBLIC;
      },
      2_000,
      seen,
    );
    expect(await within(classify('slow-ok.example.test'))).toBe('public');
    expect(seen).toEqual([]);
  });

  it('counterexample: a private answer within the budget is final, no timeout record', async () => {
    const seen: LookupError[] = [];
    const classify = make(async () => [{ address: '10.0.0.5', family: 4 as const }], 2_000, seen);
    expect(await within(classify('intranet2.example.test'))).toBe('private');
    expect(seen).toEqual([]);
  });

  it('timers are cleared in every outcome: answer, error, timeout', async () => {
    const okay = make(async () => PUBLIC, 60_000);
    expect(await okay('t-ok.example.test')).toBe('public');
    expect(vi.getTimerCount()).toBe(0);

    const failing = make(async () => Promise.reject(err('ENOTFOUND')), 60_000);
    expect(await failing('t-err.example.test')).toBe('unresolved');
    expect(vi.getTimerCount()).toBe(0);

    const hanging = make(() => never(), 60_000);
    expect(await advance(hanging('t-hang.example.test'), 60_001)).toBe('unresolved');
    expect(vi.getTimerCount()).toBe(0);
  });
});
