import { describe, expect, it } from 'vitest';
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { CollectorContext } from '../../../src/core/snapshot/collector.ts';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors } from '../../utils/scan-harness.ts';
import { makeBrowser, makeHttp } from '../../utils/snapshot-builder.ts';
import { emptyPhase, opts } from './fixtures.ts';

describe('scan — settings', () => {
  it('a scan without settings reports none', async () => {
    const { report } = await scan(opts());
    expect(report.scan.status).toBe('complete');
    expect(report.scan.options).not.toHaveProperty('settings');
    expectValidReport(report);
  });

  it('settings equal to the defaults are not reported either', async () => {
    const { report } = await scan(
      opts({ config: { http: { maxRedirects: 5 }, browser: { quietWindowMs: 2000 } } }),
    );
    expect(report.scan.options).not.toHaveProperty('settings');
  });

  it('reports the settings that differ, by variable name, without the proxy, paths and what the options show', async () => {
    const { report } = await scan(
      opts({
        config: {
          scan: { proxy: 'http://user:secret@proxy.example:3128', maxPages: 2 },
          browser: { quietWindowMs: 3_000, screenshotMaxViewportShare: 0.4 },
          tls: { expiringDays: 21 },
          dns: { servers: ['1.1.1.1'] },
          report: { outDir: '/home/runner/work/out' },
        },
      }),
    );
    expect(report.scan.status).toBe('complete');
    expect(report.scan.options).toMatchObject({
      maxPages: 2,
      proxy: true,
      settings: {
        DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: 3_000,
        DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE: 0.4,
        DSGVO_CHECK_TLS_EXPIRING_DAYS: 21,
        DSGVO_CHECK_DNS_SERVERS: '1.1.1.1',
      },
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/home/runner');
    expectValidReport(report);
  });

  it('an option of the caller wins over the same setting', async () => {
    const { report } = await scan(opts({ maxPages: 3, config: { scan: { maxPages: 9 } } }));
    expect(report.scan.options?.maxPages).toBe(3);
  });

  it('an invalid setting ends the scan as invalid input, naming the setting', async () => {
    const result = await scan(opts({ config: { browser: { navigationPauseMs: 1_000 } } }));

    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['invalid-input']);
    expect(result.report.scan.failure).toMatchObject({ code: 'invalid-config' });
    expect(result.report.scan.failure?.message).toBe(
      'Ungültige Einstellung(en): browser.navigationPauseMs (config-Option): muss mindestens 1500 sein: nur strengere Werte sind erlaubt, der Scan bleibt passiv',
    );
  });

  it('words the refusal in the language of the scan', async () => {
    const result = await scan(opts({ lang: 'en', config: { browser: { navigationPauseMs: 1_000 } } }));

    expect(result.report.scan.failure?.message).toBe(
      'Invalid setting(s): browser.navigationPauseMs (config option): must be at least 1500: values may only be made stricter, the scan stays passive',
    );
  });

  it('the collectors see the settings and the DNS servers of the settings', async () => {
    const seen: CollectorContext[] = [];
    const collectors = fakeCollectors({
      http: async (ctx) => {
        seen.push(ctx);
        return { status: 'ok', sections: { http: makeHttp() } };
      },
      dns: async (ctx) => {
        seen.push(ctx);
        return { status: 'ok', sections: {} };
      },
    });
    const probe = defineCheck({
      id: 'TEST-02',
      module: 'http',
      requires: ['http', 'dns'],
      variants: [{ variant: 'header' }],
      run: () => [],
    });

    await scan(
      opts({
        collectors,
        registry: new CheckRegistry([probe]),
        config: { http: { maxRedirects: 2 }, dns: { servers: ['9.9.9.9'], queryBudget: 10 } },
      }),
    );

    expect(seen).toHaveLength(2);
    for (const ctx of seen) {
      expect(ctx.config.http.maxRedirects).toBe(2);
      expect(ctx.config.dns.queryBudget).toBe(10);
      expect(ctx.network.dnsServers).toEqual(['9.9.9.9']);
    }
  });

  it('checks get the thresholds of the settings through their context', async () => {
    let seen: unknown;
    const check = defineCheck({
      id: 'TEST-01',
      module: 'browser',
      requires: ['browser'],
      variants: [{ variant: 'hit' }],
      run: (_slice, ctx) => {
        seen = ctx.thresholds;
        return [];
      },
    });

    await scan(
      opts({
        registry: new CheckRegistry([check]),
        collectors: fakeCollectors({
          browser: async () => ({
            status: 'ok',
            sections: { browser: makeBrowser({ phases: [{ ...emptyPhase('A') }] }) },
          }),
        }),
        config: { cmp: { blockingCoveredRatio: 0.6 }, tls: { expiringDays: 7, approachingDays: 20 } },
      }),
    );

    expect(seen).toEqual({
      cmp: { blockingCoveredRatio: 0.6, minCandidatePages: 2 },
      tls: {
        shortLivedDays: 10,
        expiringDays: 7,
        expiringLifetimeShare: 0.25,
        approachingDays: 20,
        approachingLifetimeShare: 0.5,
      },
    });
  });
});
