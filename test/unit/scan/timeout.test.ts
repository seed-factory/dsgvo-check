import { describe, expect, it } from 'vitest';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { makeBrowser, makePage, makePhase } from '../../utils/snapshot-builder.ts';
import { opts, withBrowser } from './fixtures.ts';

const startVisit = (phase: 'A' | 'B' = 'A') => makePage({ url: 'https://www.example.de/', phase });

/** Browser collector that honours the abort signal: it stops and returns what it has after `delayMs`. */
const abortAware =
  (sections: () => Record<string, unknown>, delayMs = 5) =>
  (ctx: { signal: AbortSignal }) =>
    new Promise<never>((resolve) => {
      ctx.signal.addEventListener(
        'abort',
        () =>
          setTimeout(
            () => resolve({ status: 'partial', reason: 'timeout', sections: sections() } as never),
            delayMs,
          ),
        { once: true },
      );
    });

describe('scan — global timeout (5.2)', () => {
  it('global timeout before phase A finished on the start page → failed, SCAN-TIMEOUT, exit 2 (timeout)', async () => {
    const result = await scan(
      opts({
        timeoutMs: 150,
        abortGraceMs: 20,
        collectors: { ...withBrowser, browser: () => new Promise(() => {}) },
        checks: ['TEST-01'],
      }),
    );

    expect(result.report.scan.status).toBe('failed');

    // The collector handed over nothing: whether the start page was captured is unknown, the code says so.
    if (result.report.scan.status === 'failed')
      expect(result.report.scan.failure.code).toBe('browser-no-handover');

    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'error',
      reason: 'timeout',
    });
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.report.summary.exitReasons).toEqual(['timeout', 'check-error:TEST-01']);
    expect(result.exitCode).toBe(2);
    expectValidReport(result.report);
  });

  it('before phase A finished on the start page: fatal timeout even with --fail-on none; earlier findings kept', async () => {
    const result = await scan(
      opts({
        failOn: 'none',
        timeoutMs: 100,
        abortGraceMs: 200,
        collectors: { ...withBrowser, browser: abortAware(() => ({})) },
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toEqual(['timeout']);
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');

    // HTTP finished before the deadline: its finding stays in the report.
    expect(result.report.findings?.map((f) => f.checkId)).toEqual(['TEST-02']);
    expectValidReport(result.report);
  });

  it('a fatal signal of a collector cut by the deadline does not replace the timeout', async () => {
    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 200,
        collectors: {
          ...withBrowser,
          browser: (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener('abort', () =>
                resolve({
                  status: 'error',
                  sections: {},
                  fatal: {
                    reason: 'unreachable',
                    code: 'start-page-unreachable',
                    params: { reason: 'closed by abort' },
                  },
                }),
              );
            }),
        },
      }),
    );

    expect(result.report.scan.status).toBe('failed');
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe('scan-timeout');
    expect(result.report.summary.exitReasons).toContain('timeout');
    expect(result.report.summary.exitReasons).not.toContain('unreachable');
  });

  it('after the start page in phase A: facts the collector returns after the abort are kept (partial)', async () => {
    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          browser: abortAware(() => ({
            browser: makeBrowser({
              phases: [
                makePhase('A', { pages: [startVisit()] }),
                makePhase('B', { status: 'failed', reason: 'timeout' }),
              ],
            }),
            finalUrl: 'https://www.example.de/start',
          })),
        },
      }),
    );

    expect(result.report.scan.status).toBe('partial');

    // The critical finding of phase A survives the deadline in phase B → 1, not 2.
    expect(result.report.findings?.map((f) => `${f.checkId}.${f.variant}`)).toContain('TEST-01.hit');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons[0]).toBe('threshold');
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'partial', reason: 'timeout' });
    expectValidReport(result.report);
  });

  it('after the start page in phase A with --fail-on none → partial, 0', async () => {
    const result = await scan(
      opts({
        failOn: 'none',
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          browser: abortAware(() => ({
            browser: makeBrowser({ phases: [makePhase('A', { pages: [startVisit()] })] }),
          })),
        },
      }),
    );

    expect(result.report.scan.status).toBe('partial');
    expect(result.exitCode).toBe(0);
  });

  it('a collector that ignores the abort is given up after the grace period', async () => {
    const t0 = Date.now();

    const result = await scan(
      opts({
        timeoutMs: 100,
        abortGraceMs: 50,
        collectors: { ...withBrowser, browser: () => new Promise(() => {}) },
      }),
    );

    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(result.report.summary.exitReasons).toContain('timeout');
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'error', reason: 'timeout' });
  });

  it('without the browser (no phase A planned) a timeout is not fatal', async () => {
    const result = await scan(
      opts({
        checks: ['TEST-02'],
        timeoutMs: 100,
        abortGraceMs: 20,
        collectors: { ...withBrowser, http: () => new Promise(() => {}) },
      }),
    );

    expect(result.report.scan.status).toBe('partial');
    expect(result.report.summary.exitReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
