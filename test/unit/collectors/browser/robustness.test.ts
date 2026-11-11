import type { EventEmitter } from 'node:events';
import type { Page, Response } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostClassifier, type LookupError } from '../../../../src/collectors/browser/launch/ssrf.ts';
import { valueWithin, visitPage } from '../../../../src/collectors/browser/pages/visit.ts';
import type { NetworkRecorder } from '../../../../src/collectors/browser/recording/recorder.ts';
import { defaultNetworkConfig, type ResolvedAddress } from '../../../../src/core/url/net.ts';
import { FAST_TIMING } from '../../../integration/browser/helpers.ts';
import { fakeRecorder, fakeRequest, fakeResponse } from './fakes.ts';

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

describe('valueWithin', () => {
  const live = new AbortController().signal;

  it('a promise that settles in time wins; a rejection gives the fallback without a cut', async () => {
    expect(await valueWithin(Promise.resolve(7), 1_000, live, 0)).toEqual({ value: 7 });
    expect(await valueWithin(Promise.reject(new Error('gone')), 1_000, live, 0)).toEqual({ value: 0 });
  });

  it('a promise that never settles is cut by the budget or by the abort', async () => {
    expect(await advance(valueWithin(never<number>(), 40, live, -1), 40)).toEqual({
      value: -1,
      cut: 'timeout',
    });

    const ac = new AbortController();
    const pending = valueWithin(never<number>(), 60_000, ac.signal, -1);
    ac.abort();

    expect(await pending).toEqual({ value: -1, cut: 'aborted' });
    expect(await valueWithin(never<number>(), 60_000, ac.signal, -1)).toEqual({ value: -1, cut: 'aborted' });
  });
});

function pdfResponse(url: string, ipAddress: string, over: Partial<Response> = {}): Response {
  return fakeResponse(fakeRequest(url), [], {
    url: () => url,
    headers: () => ({ 'content-type': 'application/pdf' }),
    headersArray: async () => [{ name: 'Content-Type', value: 'application/pdf' }],
    serverAddr: async () => ({ ipAddress, port: 443 }),
    ...over,
  });
}

function visitInput(
  page: Page,
  recorder: NetworkRecorder,
  hardCapMs: number,
  signal = new AbortController().signal,
) {
  return {
    page,
    recorder,
    timing: { ...FAST_TIMING, quietWindowMs: 10 },
    phaseTiming: { minDwellMs: 10, hardCapMs },
    signal,
    target: { etld1: 'example.test', host: 'www.example.test' },
    now: () => new Date(),
  };
}

const responsePage = (url: string, response: Response, onGoto = () => {}) =>
  ({
    goto: async () => {
      onGoto();
      return response;
    },
    reload: async () => response,
    waitForLoadState: async () => undefined,
    waitForNavigation: never<Response | null>,
    on: () => undefined,
    once: () => undefined,
    url: () => url,
  }) as unknown as Page;

describe('a navigation whose response metadata never arrives (PDF viewer) still ends', () => {
  const url = 'https://www.example.test/datenschutz/';
  const spec = { rawUrl: url, role: 'privacy' as const, order: 1, phase: 'A' as const, firstVisit: false };

  function visit(signal?: AbortSignal, metadataReady = false) {
    const response = pdfResponse(
      url,
      '93.184.215.14',
      metadataReady ? {} : { headersArray: never, serverAddr: never },
    );
    const recorder = {
      beginNavigation: () => 'A-n1',
      rebindNavigation: () => undefined,
      lastRequestStart: () => null,
      inflight: () => 0,
      flush: metadataReady ? async () => true : never<boolean>,
    } as unknown as NetworkRecorder;
    return visitPage(visitInput(responsePage(url, response), recorder, 300, signal), spec);
  }

  it('flush, headers and server address are cut by the page budget; URL and status are kept', async () => {
    const r = await advance(visit(), 2_000);
    expect(r.visit).toMatchObject({
      url: url,
      finalUrl: url,
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

    const r = await advance(visit(ac.signal), 0);

    expect(r.limitations).toBeUndefined();
    expect(r.visit.navigation.status).toBe(200);
  });

  it('counterexample: metadata that arrives in time is used, no limitation', async () => {
    const r = await advance(visit(undefined, true), 100);

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
    const req = fakeRequest('https://tracker.example.net/collect', {
      type: 'xhr',
      allHeaders: () => late({ cookie: '_ga=GA1.2.123456789.1700000000' }),
    });
    const setCookie = [{ name: 'set-cookie', value: 'late_cookie=1; Path=/' }];
    const res = fakeResponse(req, [], { headersArray: () => late(setCookie) } as Partial<Response>);

    // The request is never finished: the page keeps one request open, so the quiet wait ends at the hard cap.
    ctx.emit('request', req);
    ctx.emit('response', res);
  }

  /** A page whose navigation starts a beacon, exhausts the HARD_CAP and returns before the metadata arrives. */
  async function visit() {
    const { ctx, rec: recorder } = fakeRecorder({ etld1: 'example.test' });

    const main = pdfResponse(URL_, '93.184.215.13');
    const page = responsePage(URL_, main, () => beacon(ctx));
    const t0 = Date.now();
    const r = await visitPage(visitInput(page, recorder, 50), {
      rawUrl: URL_,
      role: 'start',
      order: 0,
      phase: 'A',
      firstVisit: false,
    });
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

const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code}`), { code });
const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
const PRIVATE = [{ address: '10.0.0.5', family: 4 as const }];
type Answer = (call: number) => Promise<ResolvedAddress[]>;

/** A guard whose resolver gives `answer(n)` on its n-th call; it counts the calls and records the lookup errors. */
function guard(options: { budgetMs?: number; backoffMs?: number[] }, answer: Answer) {
  let calls = 0;
  const seen: LookupError[] = [];
  const classify = hostClassifier(
    { ...defaultNetworkConfig(), lookup: () => answer(++calls) },
    { ...options, onLookupError: (e) => seen.push(e) },
  );
  return { classify, calls: () => calls, seen };
}

describe('the guard re-asks a resolver that failed for a moment', () => {
  const quick = { backoffMs: [5, 5] };

  it('EAI_AGAIN on the 1st and 2nd call, success on the 3rd → public', async () => {
    const { classify, calls, seen } = guard(quick, async (call) => {
      if (call <= 2) throw err('EAI_AGAIN');
      return PUBLIC;
    });

    expect(await advance(classify('www.example.test'), 20)).toBe('public');
    expect(calls()).toBe(3);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([
      ['EAI_AGAIN', 1],
      ['EAI_AGAIN', 2],
    ]);

    // The verdict is cached: no further lookup.
    await advance(classify('www.example.test'), 20);
    expect(calls()).toBe(3);
  });

  it('a transient resolver error is retried once', async () => {
    const { classify, calls } = guard(quick, async (call) => {
      if (call === 1) throw err('EAI_AGAIN');
      return PRIVATE;
    });

    expect(await advance(classify('intranet.example.test'), 20)).toBe('private');
    expect(calls()).toBe(2);
  });

  it('ENOTFOUND stays fail-closed: asked twice, then unresolved; the code is reported', async () => {
    const { classify, calls, seen } = guard(quick, () => Promise.reject(err('ENOTFOUND')));

    expect(await advance(classify('gone.example.test'), 20)).toBe('unresolved');
    expect(calls()).toBe(2);
    expect(seen.map((e) => e.code)).toEqual(['ENOTFOUND', 'ENOTFOUND']);
  });

  it('a failed lookup is not cached: the next document to that host is classified again', async () => {
    // An error without a code is a definitive answer: asked twice, then unresolved.
    const { classify } = guard(quick, async (call) => {
      if (call <= 2) throw new Error('getaddrinfo EAI_AGAIN');
      return PRIVATE;
    });

    expect(await advance(classify('intranet.example.test'), 20)).toBe('unresolved');
    expect(await advance(classify('intranet.example.test'), 20)).toBe('private');
  });

  it('a resolver that keeps failing transiently ends unresolved after 3 attempts, not cached', async () => {
    const { classify, calls } = guard(quick, () => Promise.reject(err('ETIMEOUT')));

    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls()).toBe(3);
    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls()).toBe(6);
  });

  it('the attempts stay within the time budget', async () => {
    const budget = { backoffMs: [60_000, 60_000], budgetMs: 100 };
    const { classify, calls } = guard(budget, () => Promise.reject(err('EAI_AGAIN')));

    expect(await advance(classify('slow.example.test'), 20)).toBe('unresolved');
    expect(calls()).toBe(1);
  });

  it('a private answer is final: no retry', async () => {
    const { classify, calls } = guard(quick, async () => PRIVATE);

    expect(await advance(classify('intranet.example.test'), 20)).toBe('private');
    expect(calls()).toBe(1);
  });
});

describe('every wait for the resolver is bounded by what is left of the shared budget', () => {
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const within = <T>(work: Promise<T>, ms = 2_500) => advance(work, ms);
  const make = (budgetMs: number, answer: Answer) => guard({ budgetMs, backoffMs: [1, 1] }, answer);

  it('a public answer that comes after the budget is not applied: unresolved, a timeout is recorded, not cached', async () => {
    const { classify, calls, seen } = make(60, async (call) => {
      if (call > 1) return PRIVATE;
      await delay(1_000);
      return PUBLIC;
    });

    expect(await within(classify('late.example.test'))).toBe('unresolved');
    expect(calls()).toBe(1);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([['ETIMEOUT', 1]]);

    // The late "public" must not be cached or applied afterwards: the next document asks again and gets its own answer.
    expect(await within(classify('late.example.test'))).toBe('private');
    expect(calls()).toBe(2);
  });

  it('a resolver whose promise never settles ends unresolved within the budget', async () => {
    const { classify, calls, seen } = make(60, () => never());

    expect(await within(classify('hang.example.test'))).toBe('unresolved');
    expect(calls()).toBe(1);
    expect(seen.map((e) => e.code)).toEqual(['ETIMEOUT']);
  });

  it('a slow definitive error is cut too: no second ask once the budget is spent', async () => {
    const { classify, calls } = make(60, async () => {
      await delay(1_000);
      throw err('ENOTFOUND');
    });

    expect(await within(classify('slow-gone.example.test'))).toBe('unresolved');
    expect(calls()).toBe(1);
  });

  it('the immediate re-ask after ENOTFOUND is bounded as well', async () => {
    const { classify, calls, seen } = make(60, (call) =>
      call === 1 ? Promise.reject(err('ENOTFOUND')) : never(),
    );

    expect(await within(classify('re-ask.example.test'))).toBe('unresolved');
    expect(calls()).toBe(2);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([
      ['ENOTFOUND', 1],
      ['ETIMEOUT', 2],
    ]);
  });

  it('the budget is shared by all attempts: a later attempt gets only the remainder', async () => {
    const { classify, calls } = make(200, async (call) => {
      if (call === 1) throw err('EAI_AGAIN');
      if (call === 2) {
        await delay(120);
        throw err('EAI_AGAIN');
      }
      return never();
    });

    expect(await within(classify('shared.example.test'))).toBe('unresolved');
    // 200 ms in all (the 3rd attempt had ~80 ms left), not 200 ms for the 3rd attempt alone.
    expect(calls()).toBe(3);
  });

  it('counterexample: a slow answer within the budget still counts (public), nothing is recorded', async () => {
    const { classify, seen } = make(2_000, async () => {
      await delay(60);
      return PUBLIC;
    });

    expect(await within(classify('slow-ok.example.test'))).toBe('public');
    expect(seen).toEqual([]);
  });

  it('counterexample: a private answer within the budget is final, no timeout record', async () => {
    const { classify, seen } = make(2_000, async () => PRIVATE);

    expect(await within(classify('intranet2.example.test'))).toBe('private');
    expect(seen).toEqual([]);
  });

  it('timers are cleared in every outcome: answer, error, timeout', async () => {
    const cases: Array<[string, Answer, string]> = [
      ['t-ok', async () => PUBLIC, 'public'],
      ['t-err', () => Promise.reject(err('ENOTFOUND')), 'unresolved'],
      ['t-hang', () => never(), 'unresolved'],
    ];
    for (const [host, answer, verdict] of cases) {
      const pending = make(60_000, answer).classify(`${host}.example.test`);
      expect(await (host === 't-hang' ? advance(pending, 60_001) : pending), host).toBe(verdict);
      expect(vi.getTimerCount(), host).toBe(0);
    }
  });
});
