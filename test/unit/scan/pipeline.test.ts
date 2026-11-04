import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors } from '../../utils/scan-harness.ts';
import { makeBrowser, makeDocumentResponse, makeHttp } from '../../utils/snapshot-builder.ts';
import { browserCheck, emptyPhase, httpCheck, opts, withBrowser } from './fixtures.ts';

describe('scan — pipeline', () => {
  it('runs collectors, derive, checks, assess and gate', async () => {
    const result = await scan(opts());

    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold']);
    expect(result.report.findings?.map((f) => `${f.checkId}.${f.variant}:${f.severity}`)).toEqual([
      'TEST-01.hit:critical',
      'TEST-02.header:warning',
    ]);
    expect(result.report.findings?.[0]?.crmCode).toBe('T1_OTHER');
    expect(result.snapshot?.derived).toBeDefined();
    expect(result.snapshot?.target.finalUrl).toBe('https://www.example.de/start');
    expectValidReport(result.report);
  });

  it('without the browser, the final URL comes from the HTTP start document', async () => {
    const result = await scan(
      opts({
        checks: ['TEST-02'],
        collectors: fakeCollectors({
          http: async () => ({
            status: 'ok',
            sections: {
              http: makeHttp({
                documents: [
                  makeDocumentResponse({
                    url: 'https://www.example.de/',
                    finalUrl: 'https://example.de/home?sid=1',
                  }),
                ],
              }),
            },
          }),
        }),
      }),
    );

    expect(result.snapshot?.target.finalUrl).toBe('https://example.de/home?sid=[redacted]');
    expect(result.snapshot?.target.finalHost).toBe('example.de');
    expect(result.report.scan.finalUrl).toBe('https://example.de/home?sid=[redacted]');
  });

  it('the browser final URL wins over the HTTP one', async () => {
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          http: async () => ({
            status: 'ok',
            sections: {
              http: makeHttp({
                documents: [
                  makeDocumentResponse({ url: 'https://www.example.de/', finalUrl: 'https://x.example.de/' }),
                ],
              }),
            },
          }),
        },
      }),
    );

    expect(result.snapshot?.target.finalUrl).toBe('https://www.example.de/start');
  });

  it('fail-on warning / none', async () => {
    expect((await scan(opts({ failOn: 'none' }))).exitCode).toBe(0);

    const onlyHttp = await scan(opts({ failOn: 'warning', checks: ['TEST-02'] }));

    expect(onlyHttp.exitCode).toBe(1);
    expect(onlyHttp.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'not-selected',
    });
  });

  it('only runs collectors needed by the selected checks', async () => {
    const called: string[] = [];
    const spy = fakeCollectors({
      browser: async () => {
        called.push('browser');
        return { status: 'ok', sections: {} };
      },
      dns: async () => {
        called.push('dns');
        return { status: 'ok', sections: {} };
      },
      http: async () => {
        called.push('http');
        return { status: 'ok', sections: { http: makeHttp() } };
      },
    });

    await scan(opts({ collectors: spy, checks: ['TEST-02'] }));

    expect(called).toEqual(['http']);
  });

  it('collector skipped (stub) → dependent checks skipped with its reason; no effect on exit code', async () => {
    const result = await scan(
      opts({
        collectors: fakeCollectors({
          browser: async () => ({ status: 'skipped', reason: 'not-implemented', sections: {} }),
        }),
        checks: ['TEST-01'],
      }),
    );

    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'not-implemented',
    });
    expect(result.exitCode).toBe(0);
  });

  it('collector ok without its section → relevant check error → exit 2 (check-error)', async () => {
    const result = await scan(opts({ collectors: fakeCollectors(), checks: ['TEST-01'] }));

    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'error',
      reason: 'collector-error:browser',
    });
    expect(result.report.scan.status).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['check-error:TEST-01']);
    expectValidReport(result.report);
  });

  it('a throwing check → error + check-error, other findings still gate with 1', async () => {
    const throwing = defineCheck({
      ...httpCheck,
      run: () => {
        throw new Error('boom');
      },
    });
    const reg = () => new CheckRegistry([browserCheck, throwing]);

    const result = await scan(opts({ registry: reg(), failOn: 'warning' }));

    expect(result.report.checks?.find((c) => c.id === 'TEST-02')).toMatchObject({
      status: 'error',
      reason: 'exception',
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold', 'check-error:TEST-02']);

    // TEST-02 can reach only `warning`: under --fail-on critical it is not relevant.
    const notRelevant = await scan(opts({ registry: reg() }));
    expect(notRelevant.report.summary.exitReasons).toEqual(['threshold']);
  });

  it('sandbox off → SCAN-SANDBOX-OFF; --strict turns it into 2', async () => {
    const soft = await scan(opts({ sandbox: 'off', checks: ['TEST-02'], failOn: 'critical' }));

    expect(soft.report.diagnostics?.map((d) => d.code)).toContain('SCAN-SANDBOX-OFF');
    expect(soft.exitCode).toBe(0);

    const strict = await scan(
      opts({ sandbox: 'off', checks: ['TEST-02'], strict: true, assumeRegion: 'de' }),
    );

    expect(strict.exitCode).toBe(2);
    expect(strict.report.summary.exitReasons).toEqual(['strict:sandbox-off']);
  });

  it('sandbox container inside the image → no SCAN-SANDBOX-OFF, no strict:sandbox-off, no sandbox-off paragraph', async () => {
    const result = await scan(
      opts({
        sandbox: 'container',
        insideContainer: true,
        checks: ['TEST-02'],
        strict: true,
        assumeRegion: 'de',
      }),
    );

    expect(result.report.scan.status).toBe('complete');
    expect(result.report.diagnostics?.map((d) => d.code) ?? []).not.toContain('SCAN-SANDBOX-OFF');
    expect(result.report.summary.exitReasons).not.toContain('strict:sandbox-off');
    expect(result.exitCode).toBe(0);
    expect(result.report.disclaimer.text).not.toMatch(/--sandbox off/);
    if (result.report.scan.status !== 'failed') {
      expect(result.report.scan.options?.sandbox).toBe('container');
      expect(result.report.scan.environment?.sandbox.mode).toBe('container');
    }
    expectValidReport(result.report);
  });

  it('sandbox container from the settings alone is checked the same way', async () => {
    const result = await scan(opts({ config: { browser: { sandbox: 'container' } } }));

    expect(result.exitCode).toBe(2);
    if (result.report.scan.status === 'failed') {
      expect(result.report.scan.failure.code).toBe('sandbox-container-outside-image');
    }
  });

  it('save-snapshot / --from-snapshot: replay without collectors gives the same findings', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const file = path.join(dir, 'site.snapshot.json');
    const first = await scan(opts({ saveSnapshot: file }));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.derived).toBeUndefined();

    const explode = async () => {
      throw new Error('collectors must not run on replay');
    };
    const replay = await scan(
      opts({
        url: undefined,
        fromSnapshot: file,
        collectors: { browser: explode, http: explode, tls: explode, dns: explode },
      }),
    );

    expect(replay.report.findings?.map((f) => f.fingerprint)).toEqual(
      first.report.findings?.map((f) => f.fingerprint),
    );
    expect(replay.report.scan.status).toBe('complete');
    expect(replay.snapshot?.derived).toBeDefined();
    if (replay.report.scan.status !== 'failed') expect(replay.report.scan.options?.fromSnapshot).toBe(true);
    expectValidReport(replay.report);
  });
});

describe('scan — --strict under --fail-on none (5.2: --strict acts independently)', () => {
  it('sandbox off → 2 with strict:sandbox-off', async () => {
    const result = await scan(
      opts({ failOn: 'none', strict: true, sandbox: 'off', assumeRegion: 'de', checks: ['TEST-02'] }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['strict:sandbox-off']);
  });

  it('nothing strict-relevant → 0', async () => {
    const result = await scan(opts({ failOn: 'none', strict: true, assumeRegion: 'de' }));

    expect(result.exitCode).toBe(0);
  });
});

describe('scan — one monotonic time scale for evidence (5.3 tMs)', () => {
  it('every collector gets the same scan clock: ms since scan.startedAt, monotonic, never reset', async () => {
    const seen: Array<{ name: string; t: number }> = [];
    const clocked =
      (name: string, sections: Record<string, unknown>) => async (ctx: { clock?: () => number }) => {
        if (!ctx.clock) throw new Error(`${name}: no scan clock`);

        const a = ctx.clock();
        await new Promise((r) => setTimeout(r, 5));
        const b = ctx.clock();
        expect(b).toBeGreaterThanOrEqual(a);

        seen.push({ name, t: a });
        return { status: 'ok' as const, sections };
      };

    const result = await scan(
      opts({
        collectors: fakeCollectors({
          http: clocked('http', { http: makeHttp() }) as never,
          browser: clocked('browser', {
            browser: makeBrowser({ phases: [{ ...emptyPhase('A') }] }),
          }) as never,
        }),
      }),
    );

    expect(result.report.scan.status).not.toBe('failed');
    const browser = seen.find((s) => s.name === 'browser');
    const http = seen.find((s) => s.name === 'http');
    expect(http?.t).toBeGreaterThanOrEqual(0);
    // The browser runs after http/tls/dns on the same clock.
    expect(browser?.t).toBeGreaterThan(http?.t ?? Number.POSITIVE_INFINITY);
  });
});
