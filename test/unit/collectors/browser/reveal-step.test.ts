/**
 * The reveal step of the collector with a fake page (no browser): what it records when the page or the browser fails,
 * and that the wait for late response handlers does not abandon them.
 */
import type { BrowserType, Page, Request } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { BrowserCollection, type Session } from '../../../../src/collectors/browser/collector.ts';
import type { RawScrollFacts } from '../../../../src/collectors/browser/in-page/dom.ts';
import type { CmpApi } from '../../../../src/collectors/browser/index.ts';
import { parseConfigInput } from '../../../../src/core/config/load.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import type { PageVisit, PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import type { CollectorContext } from '../../../../src/core/snapshot/collector.ts';
import { parseTarget } from '../../../../src/core/url/url.ts';
import { makePage, makeSnapshot } from '../../../utils/snapshot-builder.ts';
import { fakeRecorder, fakeRequest, fakeResponse } from './cookies/fakes.ts';

const SECRET = 'PRIVATE_COOKIE_VALUE_42';
const KONTAKT = 'https://www.example.test/kontakt/';
const TALL: RawScrollFacts = { heightPx: 3_000, scrollY: 0, locked: false };

interface FakePage {
  evaluate?: () => Promise<unknown>;
  setViewportSize?: (size: { width: number; height: number }) => Promise<void>;
}

function setup(fake: FakePage) {
  const target = parseTarget('https://www.example.test/');
  const ctx = {
    target,
    config: parseConfigInput({}),
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    now: () => new Date(),
    log: silentLogger,
    snapshot: makeSnapshot({ target }),
  } as unknown as CollectorContext;
  const c = new BrowserCollection(ctx, {
    cmp: {} as CmpApi,
    chromium: {} as BrowserType,
    phases: ['A'],
    timing: {
      quietWindowMs: 0,
      maxInflight: 1,
      phases: {
        A: { minDwellMs: 0, hardCapMs: 4_000 },
        B: { minDwellMs: 0, hardCapMs: 4_000 },
        C: { minDwellMs: 0, hardCapMs: 4_000 },
      },
      navigationPauseMs: 0,
      navigationTimeoutMs: 1_000,
      loadTimeoutMs: 1_000,
      cmpCallTimeoutMs: 1_000,
      retryDelayMs: 0,
      deadlineReserveMs: 0,
    },
  });

  const { ctx: browserContext, rec: recorder } = fakeRecorder({
    etld1: 'example.test',
    counter: c.counter,
    start: KONTAKT,
  });

  const record: PhaseRecord = {
    phase: 'A',
    status: 'completed',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    profile: 'persistent-tmp',
    pages: [],
    requests: [],
    cookies: [],
    storage: [],
    errors: [],
  };
  const page = {
    evaluate: fake.evaluate ?? (async () => TALL),
    setViewportSize: fake.setViewportSize ?? (async () => undefined),
    viewportSize: () => ({ width: 1366, height: 768 }),
  } as unknown as Page;
  const s = {
    phase: 'A',
    page,
    recorder,
    jar: { snapshot: async () => [] },
    browser: { context: browserContext },
    record,
  } as unknown as Session;
  const visit: PageVisit = makePage({ url: KONTAKT, role: 'contact' });
  return { c, s, record, browserContext, recorder, run: () => c.reveal(s, { visit } as never), visit };
}

describe('the reveal step of the collector', () => {
  it('keeps the page out of the error it records: only its own words, never what a page script threw', async () => {
    const { run, record, visit } = setup({
      evaluate: async () => {
        throw new Error(`session=${SECRET}`);
      },
    });
    await run();

    expect(visit.reveal).toEqual({ outcome: 'failed', documentHeightPx: null });
    expect(record.errors.map((e) => [e.code, e.message])).toEqual([
      ['reveal-failed', 'document height failed'],
    ]);
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it('a viewport the browser did not set back ends the phase: no further page would see its first screen', async () => {
    const sizes: number[] = [];
    const { run, record, s, visit } = setup({
      setViewportSize: async ({ height }) => {
        sizes.push(height);
        if (height === 768) throw new Error(`Protocol error: cookie=${SECRET}`);
      },
    });
    await run();

    // One enlargement, then two attempts to set the first screen again.
    expect(sizes).toEqual([3_000, 768, 768]);
    expect(visit.reveal).toMatchObject({ outcome: 'revealed', viewportHeightPx: 3_000 });
    expect(s.viewportLost).toBe(true);
    expect(record).toMatchObject({ status: 'partial', reason: 'viewport-not-restored' });
    expect(record.errors.map((e) => e.message)).toEqual(['restore the viewport failed']);
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it('an enlargement still pending after its time limit ends the phase, even when the restore returns', async () => {
    const { run, record, s, visit } = setup({
      // Lands only after the call time limit (1 s): it could still win over the restore that follows.
      setViewportSize: ({ height }) =>
        height === 768 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 1_500)),
    });
    await run();

    expect(visit.reveal).toMatchObject({ outcome: 'failed' });
    expect(s.viewportLost).toBe(true);
    expect(record).toMatchObject({ status: 'partial', reason: 'viewport-not-restored' });
    expect(record.errors.map((e) => e.message)).toEqual(['enlarge the viewport timed out after 1000 ms']);
  });

  it('a restore still pending after its time limit is not tried again and ends the phase', async () => {
    const sizes: number[] = [];
    const { run, s } = setup({
      setViewportSize: ({ height }) => {
        sizes.push(height);
        return height === 768 ? new Promise(() => undefined) : Promise.resolve();
      },
    });
    await run();

    expect(sizes).toEqual([3_000, 768]);
    expect(s.viewportLost).toBe(true);
  });

  it('counterexample: a restore the browser confirmed leaves the phase as it was', async () => {
    const { run, record, s } = setup({});
    await run();
    expect(s.viewportLost).toBeUndefined();
    expect(record).toMatchObject({ status: 'completed', errors: [] });
  });

  it('a Set-Cookie of what the reveal loaded that arrives after the wait is still recorded', async () => {
    let req: Request | null = null;
    const { browserContext, recorder, run } = setup({
      setViewportSize: async ({ height }) => {
        if (height === 768 || req) return;
        req = fakeRequest('https://maps.example.net/tile.png');
        browserContext.emit('request', req);
        const late = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const resp = fakeResponse(req, [], {
          // Later than the collector's wait (2 s), within the handler's own budget (5 s).
          headersArray: async () => {
            await late(2_300);
            return [{ name: 'set-cookie', value: `tile_id=${SECRET}; Path=/` }];
          },
          serverAddr: async () => null,
        });
        browserContext.emit('response', resp);
      },
    });
    await run();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tile = recorder.records.find((r) => r.host === 'maps.example.net');
    expect(tile).toMatchObject({ afterReveal: true, setCookieNames: ['tile_id'] });
    expect(JSON.stringify(recorder.records)).not.toContain(SECRET);
  }, 10_000);
});
