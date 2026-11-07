import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newRunId, parseRunnerArgs } from '../../../scripts/canary/args.ts';
import { type SiteMeta, siteRef } from '../../../scripts/canary/results.ts';
import { reanalyzeRun, runCanary, runPool } from '../../../scripts/canary/runner.ts';
import { apiScanner, type SiteJob, type SiteScanner } from '../../../scripts/canary/scanners.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';
import { fakeCollectors, publicLookup } from '../../utils/scan-harness.ts';
import { FIXED_NOW } from '../../utils/snapshot-builder.ts';
import { runOptions, sites } from './runner-inputs.ts';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'canary-run-'));
const readMeta = (runDir: string, id: string): SiteMeta =>
  JSON.parse(readFileSync(path.join(runDir, id, 'meta.json'), 'utf8')) as SiteMeta;
const noSleep = async () => {};
/** Runner dependencies without pauses and log output. */
const quiet = (scanner: SiteScanner) => ({ scanner, sleep: noSleep, log: () => {} });

/** Fake scanner: writes report.json (+ snapshot.json) like the real API would. */
function fakeScanner(opts: { delayMs?: number; failIds?: string[]; throwIds?: string[] } = {}) {
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const scanner: SiteScanner = async (job: SiteJob) => {
    started.push(job.site.id);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      if (opts.throwIds?.includes(job.site.id)) throw new Error(`boom at ${job.site.url}`);

      const failed = opts.failIds?.includes(job.site.id);
      const report = failed ? sampleFailedReport() : sampleFullReport();
      writeFileSync(job.reportPath, JSON.stringify(report));
      if (!failed) writeFileSync(job.snapshotPath, JSON.stringify({ snapshotVersion: 1 }));
      return { exitCode: failed ? 2 : 0 };
    } finally {
      inFlight--;
    }
  };

  return { scanner, started, max: () => maxInFlight };
}

describe('runPool', () => {
  it('dispatches items in corpus order with at most `concurrency` in flight', async () => {
    const dispatched: number[] = [];
    let inFlight = 0;
    let max = 0;

    await runPool([0, 1, 2, 3, 4], { concurrency: 2, pauseMs: 0, sleep: async () => {} }, async (item) => {
      dispatched.push(item);
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, item === 0 ? 20 : 1));
      inFlight--;
    });

    expect(dispatched).toEqual([0, 1, 2, 3, 4]);
    expect(max).toBe(2);
  });
});

describe('parseRunnerArgs', () => {
  it('has polite defaults', () => {
    const a = parseRunnerArgs([], FIXED_NOW);

    expect(a).toMatchObject({
      concurrency: 3,
      pauseMs: 5000,
      timeoutMs: 240_000,
      engine: 'api',
      sandbox: 'require',
      screenshots: true,
      regions: null,
      ids: null,
      limit: null,
      expectedCount: null,
      reanalyze: null,
      confirm: false,
      dryRun: false,
      retryErrors: false,
      runId: '20261030-120000',
    });
  });

  it('parses filters and options', () => {
    const a = parseRunnerArgs(
      [
        '--region',
        'de,non-eu',
        '--id',
        'de-a,de-b',
        '--limit',
        '7',
        '--expected-count',
        '100',
        '--concurrency',
        '2',
        '--timeout',
        '3m',
        '--pause',
        '2s',
        '--run-id',
        'r1',
        '--engine',
        'cli',
        '--no-screenshots',
        '--confirm',
      ],
      FIXED_NOW,
    );

    expect(a).toMatchObject({
      regions: ['de', 'non-eu'],
      ids: ['de-a', 'de-b'],
      limit: 7,
      expectedCount: 100,
      concurrency: 2,
      timeoutMs: 180_000,
      pauseMs: 2000,
      runId: 'r1',
      engine: 'cli',
      screenshots: false,
      confirm: true,
    });
  });

  it.each([
    [['--sandbox', 'off'], { sandbox: 'off', assumeRegion: null }],
    [['--assume-region', 'eea'], { sandbox: 'require', assumeRegion: 'eea' }],
    [['--assume-region', 'de'], { sandbox: 'require', assumeRegion: 'de' }],
  ])('takes %j from the report schema values', (argv, expected) => {
    expect(parseRunnerArgs(argv, FIXED_NOW)).toMatchObject(expected);
  });

  it.each([
    [['--sandbox', 'maybe'], '--sandbox: expected require|off'],
    [['--assume-region', 'us'], '--assume-region: expected eea|de'],
    [['--assume-region', ''], '--assume-region: expected eea|de'],
  ])('rejects %j with the allowed values', (argv, message) => {
    expect(() => parseRunnerArgs(argv, FIXED_NOW)).toThrow(message);
  });

  it('names a reanalysis run after its source run', () => {
    const a = parseRunnerArgs(['--reanalyze', '20261029-080000'], FIXED_NOW);

    expect(a.reanalyze).toBe('20261029-080000');
    expect(a.runId).toBe('20261029-080000.re-20261030-120000');
  });

  it.each([
    [['--concurrency', '0']],
    [['--concurrency', '9']],
    [['--pause', '1s']],
    [['--timeout', 'soon']],
    [['--region', 'mars']],
    [['--limit', '-1']],
    [['--expected-count', '0']],
    [['--expected-count', '2.5']],
    [['--run-id', '../escape']],
    [['--engine', 'browser']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => parseRunnerArgs(argv as string[], FIXED_NOW)).toThrow();
  });

  it('builds sortable run ids in UTC', () => {
    expect(newRunId(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102-030405');
  });
});

describe('runCanary', () => {
  it('scans in corpus order with bounded concurrency and writes meta.json per site', async () => {
    const dir = tmp();
    const list = sites(5);
    const fake = fakeScanner({ failIds: ['de-s3'] });
    const sleeps: number[] = [];

    const res = await runCanary(runOptions(dir, list), {
      scanner: fake.scanner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
    });

    // Dispatch order is pinned by the runPool test; with 2 workers the scanner calls may interleave (async mkdir).
    expect([...fake.started].sort()).toEqual(['de-s0', 'de-s1', 'de-s2', 'de-s3', 'de-s4']);
    expect(fake.max()).toBeLessThanOrEqual(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(4);
    expect(res).toMatchObject({ planned: 5, scanned: 5, skipped: 0, errors: 0 });

    const runDir = path.join(dir, 'run-a');
    const ok = readMeta(runDir, 'de-s0');
    expect(ok).toMatchObject({
      runId: 'run-a',
      mode: 'scan',
      exitCode: 0,
      scanStatus: 'complete',
      error: null,
      files: { report: true, snapshot: true },
      site: { id: 'de-s0', region: 'de', expectedCmp: 'unknown' },
    });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(readMeta(runDir, 'de-s3')).toMatchObject({ exitCode: 2, scanStatus: 'failed', error: null });

    const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    expect(run.sites.map((s: { id: string }) => s.id)).toEqual(list.map((s) => s.id));
    expect(run.options).toMatchObject({ concurrency: 2, timeoutMs: 1000, engine: 'api' });
  });

  it('resumes: finished sites are skipped, runner errors only with retryErrors', async () => {
    const dir = tmp();
    const list = sites(3);

    // first run: one site throws
    const first = fakeScanner({ throwIds: ['de-s1'] });
    await runCanary(runOptions(dir, list), quiet(first.scanner));
    const err = readMeta(path.join(dir, 'run-a'), 'de-s1');
    expect(err.error).toMatchObject({ code: 'runner-exception' });
    expect(err.exitCode).toBeNull();

    // second run: everything is finished or recorded, so nothing is scanned
    const second = fakeScanner();
    const res = await runCanary(runOptions(dir, list), quiet(second.scanner));
    expect(second.started).toEqual([]);
    expect(res).toMatchObject({ planned: 3, scanned: 0, skipped: 3 });

    // third run: retryErrors picks up only the failed site
    const third = fakeScanner();
    await runCanary(runOptions(dir, list, { retryErrors: true }), quiet(third.scanner));
    expect(third.started).toEqual(['de-s1']);
    expect(readMeta(path.join(dir, 'run-a'), 'de-s1').error).toBeNull();
  });

  it('records a missing report and a watchdog timeout as runner errors', async () => {
    const dir = tmp();
    const list = sites(2);
    let aborted = false;
    const scanner: SiteScanner = async (job, signal) => {
      if (job.site.id === 'de-s0') return { exitCode: 0 };
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {});
    };

    await runCanary(runOptions(dir, list, { timeoutMs: 5, watchdogReserveMs: 5 }), quiet(scanner));

    const runDir = path.join(dir, 'run-a');
    expect(readMeta(runDir, 'de-s0').error).toMatchObject({ code: 'report-missing' });
    expect(readMeta(runDir, 'de-s1').error).toMatchObject({ code: 'watchdog-timeout' });
    expect(aborted).toBe(true);
  });
});

describe('API scanner (offline: fake collectors, empty registry)', () => {
  const overrides = {
    collectors: fakeCollectors(),
    network: { lookup: publicLookup },
    registry: new CheckRegistry([]),
    now: () => FIXED_NOW,
  };
  const apiOptions = (scanOverrides: typeof overrides) => ({
    sandbox: 'require' as const,
    screenshots: false,
    assumeRegion: null,
    scanOverrides,
  });

  it('writes report.json and snapshot.json, and reanalyzes from the saved snapshot without network', async () => {
    const dir = tmp();
    const list = sites(1);

    await runCanary(
      runOptions(dir, list, {
        runId: 'live',
        concurrency: 1,
        pauseMs: 0,
        timeoutMs: 30_000,
        watchdogReserveMs: 5_000,
        sitesFile: 'x',
      }),
      quiet(apiScanner(apiOptions(overrides))),
    );

    const meta = readMeta(path.join(dir, 'live'), 'de-s0');
    expect(meta).toMatchObject({ exitCode: 0, error: null, files: { report: true, snapshot: true } });
    expect(['complete', 'partial']).toContain(meta.scanStatus);

    // Reanalysis must not touch the network: a lookup that throws proves it.
    const offline = apiScanner(
      apiOptions({
        ...overrides,
        network: {
          lookup: async () => {
            throw new Error('network used during reanalysis');
          },
        },
      }),
    );
    const res = await reanalyzeRun(
      {
        resultsDir: dir,
        fromRunId: 'live',
        runId: 'live.re',
        concurrency: 2,
        timeoutMs: 30_000,
        watchdogReserveMs: 5_000,
        filter: {},
      },
      quiet(offline),
    );

    expect(res).toMatchObject({ planned: 1, scanned: 1, kept: 0 });
    const re = readMeta(path.join(dir, 'live.re'), 'de-s0');
    expect(re).toMatchObject({ mode: 'reanalyze', reanalyzedFrom: 'live', error: null, exitCode: 0 });
    expect(existsSync(path.join(dir, 'live.re', 'de-s0', 'snapshot.json'))).toBe(true);
    const report = JSON.parse(readFileSync(path.join(dir, 'live.re', 'de-s0', 'report.json'), 'utf8'));
    expect(report.scan.options.fromSnapshot).toBe(true);
  });

  it('keeps the original result when the source scan failed or has no snapshot', async () => {
    const dir = tmp();
    const src = path.join(dir, 'src', 'de-s0');
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, 'report.json'), JSON.stringify(sampleFailedReport()));
    const meta: Partial<SiteMeta> = {
      metaVersion: 1,
      runId: 'src',
      mode: 'scan',
      site: siteRef(sites(1)[0]!),
      exitCode: 2,
      scanStatus: 'failed',
      durationMs: 1234,
      error: null,
      files: { report: true, snapshot: false },
    };
    writeFileSync(path.join(src, 'meta.json'), JSON.stringify(meta));
    let called = false;

    const res = await reanalyzeRun(
      {
        resultsDir: dir,
        fromRunId: 'src',
        runId: 'src.re',
        concurrency: 1,
        timeoutMs: 1000,
        watchdogReserveMs: 1000,
        filter: {},
      },
      quiet(async () => {
        called = true;
        return { exitCode: 0 };
      }),
    );

    expect(called).toBe(false);
    expect(res).toMatchObject({ planned: 1, scanned: 0, kept: 1 });
    const re = readMeta(path.join(dir, 'src.re'), 'de-s0');
    expect(re).toMatchObject({
      mode: 'reanalyze',
      kept: 'original-failed',
      exitCode: 2,
      scanStatus: 'failed',
    });
    expect(existsSync(path.join(dir, 'src.re', 'de-s0', 'report.json'))).toBe(true);
  });
});
