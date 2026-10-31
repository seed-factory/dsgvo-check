/**
 * Pure (no browser): robustness of the browser collector's building blocks (canary-2 triage) — the error code of a
 * failed navigation (G56), bounded waits on response metadata (G49), the resolver policy of the SSRF guard (G52)
 * and the sweep of stale temp profiles (G57).
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType, Page, Request, Response } from 'playwright-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  killBrowserProcesses,
  launchPhase,
  OWNER_MARKER,
  PROFILE_PREFIX,
  pidsUsingProfile,
  profilesOfPid,
  removeProfilesOfPid,
  removeStaleProfiles,
} from '../../../../src/collectors/browser/launch.ts';
import { NetworkRecorder } from '../../../../src/collectors/browser/recorder.ts';
import { hostClassifier, type LookupError } from '../../../../src/collectors/browser/ssrf.ts';
import { navigationErrorCode, settleWithin, visitPage } from '../../../../src/collectors/browser/visit.ts';
import { defaultNetworkConfig, type Lookup } from '../../../../src/core/net.ts';
import { FAST_TIMING } from '../helpers.ts';

const never = <T>() => new Promise<T>(() => {});

// ------------------------------------------------------------------ G56

describe('G56: the code of a failed navigation keeps its digits', () => {
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

// ------------------------------------------------------------------ G49

describe('G49: settleWithin', () => {
  const live = new AbortController().signal;

  it('a promise that settles in time wins; a rejection gives the fallback without a cut', async () => {
    expect(await settleWithin(Promise.resolve(7), 1_000, live, 0)).toEqual({ value: 7 });
    expect(await settleWithin(Promise.reject(new Error('gone')), 1_000, live, 0)).toEqual({ value: 0 });
  });

  it('a promise that never settles is cut by the budget or by the abort', async () => {
    const t0 = Date.now();
    expect(await settleWithin(never<number>(), 40, live, -1)).toEqual({ value: -1, cut: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    const ac = new AbortController();
    const pending = settleWithin(never<number>(), 60_000, ac.signal, -1);
    ac.abort();
    expect(await pending).toEqual({ value: -1, cut: 'aborted' });
    expect(await settleWithin(never<number>(), 60_000, ac.signal, -1)).toEqual({ value: -1, cut: 'aborted' });
  });
});

describe('G49: a navigation whose response metadata never arrives (PDF viewer) still ends', () => {
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
    const t0 = Date.now();
    const r = await visitPage(input(fakes(), new AbortController().signal), spec);
    expect(Date.now() - t0).toBeLessThan(8_000);
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
    const t0 = Date.now();
    const r = await visitPage(input(fakes(), ac.signal), spec);
    expect(Date.now() - t0).toBeLessThan(2_000);
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
    const r = await visitPage(input(f, new AbortController().signal), spec);
    expect(r.visit.navigation.serverIp).toBe('93.184.215.14');
    expect(r.limitations).toBeUndefined();
  });
});

// ------------------------------------------------------------------ R30 (G49)

describe('R30: response metadata that arrives after the page budget is kept until the phase ends', () => {
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
    const { r, recorder, visitMs } = await visit();
    // The page budget ran out before the metadata arrived: this is the scenario.
    expect(visitMs).toBeLessThan(LATE_MS);
    expect(r.limitations?.map((l) => l.code)).toContain('recorder-flush-timeout');
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    // The flush of the phase end (collector: 2 s) waits for the handlers, which are still within their own budget.
    expect(await recorder.flush({ timeoutMs: 3_000 })).toBe(true);
    expect(recorder.records[0]).toMatchObject({
      setCookieNames: ['late_cookie'],
      connectedIp: { value: '93.184.215.14' },
      sentCookieNames: ['_ga'],
      identifierPresent: true,
    });
    recorder.dispose();
  });

  it('counterexample: what the phase is sealed without is dropped — nothing is written after dispose()', async () => {
    const { recorder } = await visit();
    recorder.dispose();
    await new Promise((resolve) => setTimeout(resolve, LATE_MS + 300));
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    expect(recorder.records[0]?.connectedIp).toBeUndefined();
  });

  it('counterexample: a phase-end flush that gives up abandons the handlers still pending', async () => {
    const { recorder } = await visit();
    expect(await recorder.flush({ timeoutMs: 50 })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, LATE_MS + 300));
    expect(recorder.records[0]?.setCookieNames).toBeUndefined();
    recorder.dispose();
  });
});

// ------------------------------------------------------------------ G52

describe('G52: the guard re-asks a resolver that failed for a moment', () => {
  const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code}`), { code });
  const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
  const quick = { backoffMs: [5, 5] } as const;
  const classifier = (lookup: Lookup, errors: LookupError[] = []) =>
    hostClassifier({ ...defaultNetworkConfig(), lookup }, { ...quick, onLookupError: (e) => errors.push(e) });

  it('EAI_AGAIN on the 1st and 2nd call, success on the 3rd → public (old code: unresolved)', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = classifier(async () => {
      calls++;
      if (calls <= 2) throw err('EAI_AGAIN');
      return PUBLIC;
    }, seen);
    expect(await classify('www.example.test')).toBe('public');
    expect(calls).toBe(3);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([
      ['EAI_AGAIN', 1],
      ['EAI_AGAIN', 2],
    ]);
    // The verdict is cached: no further lookup.
    await classify('www.example.test');
    expect(calls).toBe(3);
  });

  it('ENOTFOUND stays fail-closed: asked twice, then unresolved; the code is reported', async () => {
    let calls = 0;
    const seen: LookupError[] = [];
    const classify = classifier(async () => {
      calls++;
      throw err('ENOTFOUND');
    }, seen);
    expect(await classify('gone.example.test')).toBe('unresolved');
    expect(calls).toBe(2);
    expect(seen.map((e) => e.code)).toEqual(['ENOTFOUND', 'ENOTFOUND']);
  });

  it('a resolver that keeps failing transiently ends unresolved after 3 attempts, not cached', async () => {
    let calls = 0;
    const classify = classifier(async () => {
      calls++;
      throw err('ETIMEOUT');
    });
    expect(await classify('slow.example.test')).toBe('unresolved');
    expect(calls).toBe(3);
    expect(await classify('slow.example.test')).toBe('unresolved');
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
    const t0 = Date.now();
    expect(await classify('slow.example.test')).toBe('unresolved');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  it('a private answer is final: no retry', async () => {
    let calls = 0;
    const classify = classifier(async () => {
      calls++;
      return [{ address: '10.0.0.5', family: 4 as const }];
    });
    expect(await classify('intranet.example.test')).toBe('private');
    expect(calls).toBe(1);
  });
});

// ------------------------------------------------------------------ S-robustness-1

describe('S-robustness-1 (G52): every wait for the resolver is bounded by what is left of the shared budget', () => {
  const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code}`), { code });
  const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** A guard against a hang: the old code waits for the resolver without a bound, the test must fail by assertion. */
  const within = async <T>(work: Promise<T>, ms = 2_500): Promise<T | 'hung'> =>
    Promise.race([work, delay(ms).then(() => 'hung' as const)]);
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
    const t0 = Date.now();
    expect(await within(classify('late.example.test'))).toBe('unresolved');
    expect(Date.now() - t0).toBeLessThan(800);
    expect(calls).toBe(1);
    expect(seen.map((e) => [e.code, e.attempt])).toEqual([['ETIMEOUT', 1]]);
    // The late "public" must not be cached or applied afterwards: the next document asks again and gets its own answer.
    expect(await within(classify('late.example.test'))).toBe('private');
    expect(calls).toBe(2);
  });

  it('a resolver whose promise never settles ends unresolved within the budget (old code: waits for ever)', async () => {
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
    const t0 = Date.now();
    expect(await within(classify('hang.example.test'))).toBe('unresolved');
    expect(Date.now() - t0).toBeLessThan(800);
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
    const t0 = Date.now();
    expect(await within(classify('slow-gone.example.test'))).toBe('unresolved');
    expect(Date.now() - t0).toBeLessThan(800);
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
    const t0 = Date.now();
    expect(await within(classify('re-ask.example.test'))).toBe('unresolved');
    expect(Date.now() - t0).toBeLessThan(800);
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
    const t0 = Date.now();
    expect(await within(classify('shared.example.test'))).toBe('unresolved');
    // 200 ms in all (the 3rd attempt had ~80 ms left), not 200 ms for the 3rd attempt alone.
    expect(Date.now() - t0).toBeLessThan(700);
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
    vi.useFakeTimers();
    try {
      const okay = make(async () => PUBLIC, 60_000);
      expect(await okay('t-ok.example.test')).toBe('public');
      expect(vi.getTimerCount()).toBe(0);

      const failing = make(async () => Promise.reject(err('ENOTFOUND')), 60_000);
      expect(await failing('t-err.example.test')).toBe('unresolved');
      expect(vi.getTimerCount()).toBe(0);

      const hanging = make(() => never(), 60_000);
      const pending = hanging('t-hang.example.test');
      await vi.advanceTimersByTimeAsync(60_001);
      // Not awaited bare: the old code never settles here, which must be an assertion, not a test timeout.
      expect(await Promise.race([pending, Promise.resolve('hung')])).toBe('unresolved');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------ G57

describe('G57: stale temp profiles are swept, profiles of running processes are not', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-sweep-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function profile(name: string, owner: { pid: number } | null, ageMs = 0): string {
    const dir = path.join(root, `${PROFILE_PREFIX}${name}`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
    // The marker as `launch()` writes it, with the host of the owner (S-robustness-2).
    if (owner)
      writeFileSync(
        path.join(dir, OWNER_MARKER),
        JSON.stringify({ host: hostname(), ...owner, startedAt: 1 }),
      );
    const t = new Date(Date.now() - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes the profile of a dead owner, an old profile without marker; keeps the others', () => {
    const dead = profile('dead', { pid: 999_001 });
    const alive = profile('alive', { pid: 4242 });
    const oldUnmarked = profile('old', null, 48 * 3_600_000);
    const freshUnmarked = profile('fresh', null, 1_000);
    const other = path.join(root, 'something-else');
    mkdirSync(other);
    const removed = removeStaleProfiles({ tmp: root, isAlive: (pid) => pid === 4242 });
    expect(removed.sort()).toEqual([path.basename(dead), path.basename(oldUnmarked)].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(oldUnmarked)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(freshUnmarked)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('a profile of an owner on another host is judged by age, not by a pid that means nothing here', () => {
    const dir = path.join(root, `${PROFILE_PREFIX}elsewhere`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(
      path.join(dir, OWNER_MARKER),
      JSON.stringify({ pid: 999_003, startedAt: 1, host: 'other-container' }),
    );
    const removed = removeStaleProfiles({ tmp: root, isAlive: () => false, host: 'this-container' });
    expect(removed).not.toContain(path.basename(dir));
    expect(existsSync(dir)).toBe(true);
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(dir, old, old);
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: 'this-container' })).toContain(
      path.basename(dir),
    );
  });

  it('a profile of this very process is never swept', () => {
    const mine = profile('mine', { pid: process.pid });
    expect(removeStaleProfiles({ tmp: root })).not.toContain(path.basename(mine));
    expect(existsSync(mine)).toBe(true);
    expect(profilesOfPid(process.pid, root)).toContain(mine);
  });

  it('profiles of one pid can be removed by name of the pid (canary runner after SIGKILL)', () => {
    const a = profile('killed-a', { pid: 777_001 });
    const b = profile('killed-b', { pid: 777_001 });
    const c = profile('other-owner', { pid: 777_002 });
    expect(removeProfilesOfPid(777_001, root).sort()).toEqual([path.basename(a), path.basename(b)].sort());
    expect(existsSync(c)).toBe(true);
    expect(readdirSync(root).filter((n) => n.includes('killed'))).toEqual([]);
  });
});

// ------------------------------------------------------------------ S-robustness-2

describe('S-robustness-2 (G57): the removal by pid belongs to the owner of this host, not to every owner of that pid', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-pid-host-test-'));
  const made: string[] = [];
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A profile with the marker as `launch()` writes it, or, with `host: null`, as older versions wrote it. */
  function profile(name: string, owner: { pid: number; host: string | null }): string {
    const dir = path.join(root, `${PROFILE_PREFIX}${name}`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
    const { host, ...rest } = owner;
    writeFileSync(
      path.join(dir, OWNER_MARKER),
      JSON.stringify({ ...rest, startedAt: 1, ...(host === null ? {} : { host }) }),
    );
    made.push(dir);
    return dir;
  }

  it('a shared temp dir, the same pid on two hosts: only the profile of this host is found and removed (old code: both)', () => {
    const own = profile('own-42', { pid: 42, host: hostname() });
    const foreign = profile('foreign-42', { pid: 42, host: 'other-container' });
    const foreignOtherPid = profile('foreign-43', { pid: 43, host: 'other-container' });
    expect(profilesOfPid(42, root)).toEqual([own]);
    expect(removeProfilesOfPid(42, root)).toEqual([path.basename(own)]);
    expect(existsSync(own)).toBe(false);
    // The live scan of the other container keeps its cookies and files.
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignOtherPid)).toBe(true);
  });

  it('the host can be named: the same lookup from the point of view of the other container', () => {
    const here = profile('here-44', { pid: 44, host: 'this-container' });
    const there = profile('there-44', { pid: 44, host: 'other-container' });
    expect(profilesOfPid(44, root, 'other-container')).toEqual([there]);
    expect(removeProfilesOfPid(44, root, 'other-container')).toEqual([path.basename(there)]);
    expect(existsSync(there)).toBe(false);
    expect(existsSync(here)).toBe(true);
  });

  it('an older marker without host is not claimed by pid (it might be a foreign one); the stale sweep still judges it', () => {
    const legacy = profile('legacy-45', { pid: 45, host: null });
    const own = profile('own-45', { pid: 45, host: hostname() });
    expect(profilesOfPid(45, root)).toEqual([own]);
    expect(removeProfilesOfPid(45, root)).toEqual([path.basename(own)]);
    expect(existsSync(legacy)).toBe(true);
    // Not forgotten: the marker names a pid that is gone here, so the next sweep removes it as before.
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([
      path.basename(legacy),
    ]);
  });

  it('counterexample: a foreign profile of a live owner is not swept either, and the age rule still takes an old one', () => {
    const foreign = profile('foreign-46', { pid: 46, host: 'other-container' });
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(foreign, old, old);
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([
      path.basename(foreign),
    ]);
  });

  it('counterexample: the profile of this very process (marker with this host) is found by its pid', () => {
    const mine = profile('mine-pid', { pid: process.pid, host: hostname() });
    expect(profilesOfPid(process.pid, root)).toEqual([mine]);
  });
});

// ------------------------------------------------------------------ R14 (G51): the browser that does not close is killed without pkill

describe('R14: a browser that does not close is killed by its profile, with or without pkill', () => {
  const made: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dsgvo-r14-'));
    made.push(d);
    return d;
  };
  /** A process whose command line carries `--user-data-dir=<dir>` like a browser's (the compound command keeps argv). */
  function standIn(dir: string): ChildProcess {
    const c = spawn('/bin/sh', ['-c', 'sleep 30; :', 'x', `--user-data-dir=${dir}`], {
      stdio: 'ignore',
      env: { ...process.env },
    });
    children.push(c);
    return c;
  }
  const dead = (c: ChildProcess) =>
    new Promise<boolean>((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve(true);
      c.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
  /** `fn` with a PATH that holds no `pkill` (nor `ps`), as in the runtime image. */
  async function withoutPkill<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PATH;
    process.env.PATH = tmp();
    try {
      return await fn();
    } finally {
      process.env.PATH = saved;
    }
  }
  const hasPkill = spawnSync('/bin/sh', ['-c', 'command -v pkill']).status === 0;
  const lines = () => {
    const out: string[] = [];
    return {
      out,
      log: { debug: () => {}, info: () => {}, warn: (m: string) => out.push(m), error: () => {} },
    };
  };

  it('finds the processes of a profile by the exact argument, not by a similar one', () => {
    const proc = tmp();
    const dir = '/tmp/dsgvo-check-profile-abc123';
    const cmd = (...args: string[]) => `${args.join('\0')}\0`;
    const entry = (pid: string, content: string) => {
      mkdirSync(path.join(proc, pid));
      writeFileSync(path.join(proc, pid, 'cmdline'), content);
    };
    entry('101', cmd('/opt/chrome', '--headless', `--user-data-dir=${dir}`, '--disable-quic'));
    entry('102', cmd('/opt/chrome', `--user-data-dir=${dir}-other`));
    entry('103', cmd('/opt/chrome', `--user-data-dir=/tmp/x${dir}`));
    entry('104', cmd('node', 'script.js', dir));
    entry('105', '');
    entry(String(process.pid), cmd('node', `--user-data-dir=${dir}`));
    mkdirSync(path.join(proc, 'self'));
    writeFileSync(path.join(proc, 'self', 'cmdline'), cmd('chrome', `--user-data-dir=${dir}`));
    expect(pidsUsingProfile(dir, proc)).toEqual([101]);
  });

  it('no process table (no /proc): the answer is "unknown", not "none"', () => {
    expect(pidsUsingProfile('/tmp/dsgvo-check-profile-abc123', path.join(tmp(), 'missing'))).toBeNull();
  });

  it('kills what the process table names, nothing else', async () => {
    const proc = tmp();
    mkdirSync(path.join(proc, '4001'));
    writeFileSync(path.join(proc, '4001', 'cmdline'), 'chrome\0--user-data-dir=/tmp/p1\0');
    mkdirSync(path.join(proc, '4002'));
    writeFileSync(path.join(proc, '4002', 'cmdline'), 'chrome\0--user-data-dir=/tmp/p2\0');
    const killed: number[] = [];
    const l = lines();
    await killBrowserProcesses('/tmp/p1', { procRoot: proc, kill: (pid) => killed.push(pid), log: l.log });
    expect(killed).toEqual([4001]);
    expect(l.out).toEqual([]);
  });

  it('a stand-in browser of a hanging close is gone after the budget although pkill is missing (old code: alive)', async () => {
    const lg = lines();
    let child: ChildProcess | undefined;
    const chromium = {
      launchPersistentContext: async (dir: string) => {
        child = standIn(dir);
        return { close: () => new Promise<void>(() => {}), pages: () => [] };
      },
    } as unknown as BrowserType;
    const b = await launchPhase(
      { chromium, sandbox: 'off', network: defaultNetworkConfig(), closeBudgetMs: 250, log: lg.log },
      'test-agent',
    );
    await withoutPkill(() => b.close());
    expect(child).toBeDefined();
    if (process.platform === 'linux') {
      expect(await dead(child as ChildProcess)).toBe(true);
      expect(lg.out).toEqual([]);
    } else {
      // No /proc and no pkill: it cannot be killed, and the report of the scan says so (no profile path in the line).
      expect(lg.out).toHaveLength(1);
      expect(lg.out[0]).toMatch(/could not be killed/);
      expect(lg.out[0]).not.toContain(PROFILE_PREFIX);
    }
  });

  it.runIf(hasPkill)('counterexample: without a process table pkill still does the job', async () => {
    const dir = tmp();
    const child = standIn(dir);
    await new Promise((r) => setTimeout(r, 150));
    const l = lines();
    await killBrowserProcesses(dir, { procRoot: path.join(tmp(), 'missing'), log: l.log });
    expect(await dead(child)).toBe(true);
    expect(l.out).toEqual([]);
  });

  it('nothing to kill is no failure: no warning when the browser is already gone', async () => {
    const l = lines();
    await killBrowserProcesses('/tmp/dsgvo-check-profile-nobody', { log: l.log });
    if (process.platform === 'linux' || hasPkill) expect(l.out).toEqual([]);
  });
});
