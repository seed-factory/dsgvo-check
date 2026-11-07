import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tls02 } from '../../../src/checks/http/tls-02.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { CollectorContext, Collectors } from '../../../src/core/snapshot/collector.ts';
import { sanitizeUrl } from '../../../src/core/url/url.ts';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import {
  makeBrowser,
  makeChain,
  makeDocumentResponse,
  makeHttp,
  makePage,
  makePhase,
  makeTlsEndpoint,
} from '../../utils/snapshot-builder.ts';
import {
  brokenTarget,
  browserCheck,
  httpHop,
  httpsHop,
  opts,
  RAW_FINAL,
  refusedTls,
  STORED_FINAL,
  TARGET,
  tlsCheck,
  VIA,
  withBrowser,
} from './fixtures.ts';

/** A browser collector that notes whether the scan started it. */
function spyBrowser() {
  const spy: { started: boolean; browser: Collectors['browser'] } = {
    started: false,
    browser: async (ctx) => {
      spy.started = true;
      return withBrowser.browser(ctx);
    },
  };
  return spy;
}

describe('scan — invalid certificate on the target', () => {
  it('invalid certificate on the target → browser not started, browser checks skipped (tls-blocked)', async () => {
    const spy = spyBrowser();
    const result = await scan(
      opts({
        collectors: { ...withBrowser, browser: spy.browser, tls: refusedTls() },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(spy.started).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-blocked',
    });
    // the report says why the browser checks did not run instead of leaving only `skipped`, and that the plain-http
    // address offered no other way in
    expect(result.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SCAN-TLS-BLOCKED',
        affects: ['TEST-01'],
        params: { host: 'www.example.de', fallback: 'none' },
      }),
    );
    expect(result.snapshot?.plan).toMatchObject({ tlsFallback: 'none' });
    expect(result.snapshot?.plan.browserEntry).toBeUndefined();
  });

  it('invalid certificate on an explicit target port → tls-blocked as well', async () => {
    const spy = spyBrowser();
    const result = await scan(
      opts({
        url: 'https://www.example.de:8443/',
        collectors: { ...withBrowser, browser: spy.browser, tls: refusedTls({ port: 8443 }) },
        registry: new CheckRegistry([browserCheck, tlsCheck]),
      }),
    );
    expect(spy.started).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({ reason: 'tls-blocked' });
  });

  // Chrome completes an incomplete chain via AIA, so it does not block the browser; a wrong host name still does.
  it.each([
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', hostnameMatches: true, started: true },
    { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', hostnameMatches: true, started: true },
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', hostnameMatches: false, started: false },
  ])(
    'incomplete chain ($code), host name matches: $hostnameMatches → browser started: $started',
    async ({ code, hostnameMatches, started }) => {
      const spy = spyBrowser();
      const tls = refusedTls({ authorizationError: code, chainComplete: false, hostnameMatches });
      const result = await scan(
        opts({
          collectors: { ...withBrowser, browser: spy.browser, tls },
          registry: new CheckRegistry([browserCheck, tlsCheck]),
        }),
      );
      expect(spy.started).toBe(started);
      expect(result.report.diagnostics?.some((d) => d.code === 'SCAN-TLS-BLOCKED')).toBe(!started);
    },
  );
});

describe('scan — invalid certificate, plain-http address redirects to another host with valid certificates', () => {
  /** HTTP collector: http://broken → 302 → https://site (accepted); https://broken is the refused start document. */
  const redirectingHttp =
    (finalStatus = 200): Collectors['http'] =>
    async () => {
      const hops = [httpHop(VIA, 302, STORED_FINAL), httpsHop(STORED_FINAL, finalStatus)];
      return {
        status: 'ok',
        sections: {
          http: makeHttp({
            chains: [
              makeChain({ id: 'chain-target-http', startUrl: VIA, hops, final: hops[1] ?? null }),
              makeChain({ id: 'chain-target-https', startUrl: TARGET, outcome: 'tls-error', final: null }),
            ],
            documents: [
              makeDocumentResponse({
                url: TARGET,
                status: null,
                chainId: 'chain-target-https',
                foundVia: 'target',
              }),
            ],
            finalTls: [makeTlsEndpoint({ host: 'site.example.test', role: 'final' })],
          }),
        },
        handover: { chainUrls: { 'chain-target-http': { start: VIA, final: RAW_FINAL } } },
      };
    };

  const brokenTls = refusedTls(brokenTarget());

  /** A browser that records the context it was started with and visits the start page it was given. */
  function recordingBrowser(seen: CollectorContext[]): Collectors['browser'] {
    return async (ctx) => {
      seen.push(ctx);
      const start = ctx.entry?.url ?? ctx.target.url;
      return {
        status: 'ok',
        sections: {
          browser: makeBrowser({
            phases: [
              makePhase('A', { pages: [makePage({ url: sanitizeUrl(start), phase: 'A', role: 'start' })] }),
            ],
          }),
          finalUrl: start,
        },
      };
    };
  }

  const registry = () => new CheckRegistry([browserCheck, tls02]);
  const fallbackScan = (collectors: Partial<Collectors>, over: Parameters<typeof opts>[0] = {}) =>
    scan(
      opts({
        url: TARGET,
        collectors: { ...withBrowser, http: redirectingHttp(), tls: brokenTls, ...collectors },
        registry: registry(),
        ...over,
      }),
    );
  const codes = (r: Awaited<ReturnType<typeof scan>>) => r.report.diagnostics?.map((d) => d.code) ?? [];
  const tls02Variants = (r: Awaited<ReturnType<typeof scan>>) =>
    (r.report.findings ?? []).filter((f) => f.checkId === 'TLS-02').map((f) => `${f.variant}:${f.severity}`);

  it('starts the browser on the raw redirect target and runs the browser checks there', async () => {
    const seen: CollectorContext[] = [];
    const result = await fallbackScan({ browser: recordingBrowser(seen) });

    // The query of the redirect target reaches the browser as the site sent it (the snapshot holds it redacted).
    expect(seen.map((c) => c.entry)).toEqual([{ reason: 'tls-invalid', url: RAW_FINAL, via: VIA }]);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({ status: 'completed' });
    expect(result.snapshot?.plan.browserEntry).toEqual({
      reason: 'tls-invalid',
      via: VIA,
      url: STORED_FINAL,
    });
    expect(result.snapshot?.plan.tlsFallback).toBeUndefined();
  });

  it('says where the browser checks ran instead of reporting them blocked', async () => {
    const result = await fallbackScan({ browser: recordingBrowser([]) });
    if (result.report.scan.status === 'failed') throw new Error('expected a full report');

    expect(codes(result)).toContain('SCAN-TLS-FALLBACK');
    expect(codes(result)).not.toContain('SCAN-TLS-BLOCKED');
    expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-FALLBACK')).toMatchObject({
      affects: ['TEST-01'],
      params: { host: 'broken.example.test', via: VIA, url: STORED_FINAL },
    });
    expect(result.report.scan.entry).toEqual({
      reason: 'tls-invalid',
      requested: TARGET,
      via: VIA,
      url: STORED_FINAL,
    });
    expectValidReport(result.report);
  });

  it('keeps the refused certificate as a critical TLS-02 finding: complete, exit 1 as before', async () => {
    const result = await fallbackScan({ browser: recordingBrowser([]) });

    expect(tls02Variants(result)).toContain('certificate-invalid:critical');
    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(1);
  });

  it('keeps the raw query out of the snapshot and the report', async () => {
    const result = await fallbackScan({ browser: recordingBrowser([]) });

    expect(JSON.stringify(result.snapshot)).not.toContain('raw-fixture-7');
    expect(JSON.stringify(result.report)).not.toContain('raw-fixture-7');
  });

  it('a saved snapshot re-evaluates to the same entry and diagnostics, whatever the setting of the replay', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'snap-')), 'site.snapshot.json');
    const first = await fallbackScan({ browser: recordingBrowser([]) }, { saveSnapshot: file });
    const explode = async () => {
      throw new Error('collectors must not run on replay');
    };
    const replay = await scan(
      opts({
        url: undefined,
        fromSnapshot: file,
        registry: registry(),
        collectors: { browser: explode, http: explode, tls: explode, dns: explode },
        config: { scan: { tlsFallback: 'off' } },
      }),
    );

    expect(readFileSync(file, 'utf8')).not.toContain('raw-fixture-7');
    expect(replay.report.diagnostics).toEqual(first.report.diagnostics);
    if (replay.report.scan.status === 'failed' || first.report.scan.status === 'failed')
      throw new Error('failed');
    expect(replay.report.scan.entry).toEqual(first.report.scan.entry);
    expect(replay.exitCode).toBe(1);
  });

  it('a redirect target the browser could not evaluate → browser checks skipped (tls-fallback-failed), complete, exit 1', async () => {
    const result = await fallbackScan({
      browser: async () => ({
        status: 'skipped',
        reason: 'tls-fallback-failed',
        sections: {},
        error: { code: 'start-page-not-evaluable', message: 'empty-document' },
      }),
    });

    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold']);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-fallback-failed',
    });
    expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')).toMatchObject({
      affects: ['TEST-01'],
      params: { host: 'broken.example.test', fallback: 'blocked', via: VIA, url: STORED_FINAL },
    });
    expect(codes(result)).not.toContain('SCAN-TLS-FALLBACK');
    if (result.report.scan.status !== 'failed') expect(result.report.scan.entry).toBeUndefined();
    expect(tls02Variants(result)).toContain('certificate-invalid:critical');
  });

  // The protection is named with its signal, so the report says why the browser got nothing there (never a bypass).
  describe('bot or WAF protection on the redirect target', () => {
    const SIGNALS = 'header:x-vercel-mitigated';
    const blockedParams = (signals: string) => ({
      host: 'broken.example.test',
      fallback: 'bot-protection',
      signals,
      via: VIA,
      url: STORED_FINAL,
    });

    it('a start page there that is a block page: SCAN-TLS-BLOCKED names the protection and its signal', async () => {
      const result = await fallbackScan({
        browser: async () => ({
          status: 'skipped',
          reason: 'tls-fallback-failed',
          sections: {},
          error: { code: 'start-page-blocked', message: `signals=${SIGNALS}`, params: { signals: SIGNALS } },
        }),
      });

      expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')).toMatchObject({
        affects: ['TEST-01'],
        params: blockedParams(SIGNALS),
      });
      expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
        status: 'skipped',
        reason: 'tls-fallback-failed',
      });
      expectValidReport(result.report);
    });

    it('a fatal block of the browser there keeps its signals in the snapshot and names them alike', async () => {
      const result = await fallbackScan({
        browser: async () => ({
          status: 'error',
          reason: 'start-page-blocked',
          sections: {},
          fatal: {
            reason: 'blocked',
            code: 'start-page-blocked',
            params: { signals: 'header:cf-mitigated' },
          },
        }),
      });

      expect(result.snapshot?.collection.browser?.error).toEqual({
        code: 'start-page-blocked',
        message: 'signals=header:cf-mitigated',
        params: { signals: 'header:cf-mitigated' },
      });
      expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toEqual(
        blockedParams('header:cf-mitigated'),
      );
    });

    it('lists at most the capped number of signals', async () => {
      const many = Array.from({ length: 14 }, (_, i) => `header:x-block-${i}`);
      const result = await fallbackScan({
        browser: async () => ({
          status: 'skipped',
          reason: 'tls-fallback-failed',
          sections: {},
          error: { code: 'start-page-blocked', message: 'blocked', params: { signals: many.join(', ') } },
        }),
      });

      const params = result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params;
      expect(String(params?.signals).split(', ')).toEqual(many.slice(0, 10));
    });

    it.each([
      [
        'a start page that gives nothing to evaluate',
        { code: 'start-page-not-evaluable', message: 'empty-document' },
      ],
      [
        'a start page answering 5xx twice',
        { code: 'start-page-5xx', message: 'status=503', params: { status: 503 } },
      ],
      [
        'a block page of an older snapshot without its signals',
        { code: 'start-page-blocked', message: 'signals=x' },
      ],
      [
        'a plain 403 page without a protection signature',
        { code: 'start-page-blocked', message: 'signals=status:403', params: { signals: 'status:403' } },
      ],
    ])('counterexample: %s keeps the general wording (fallback blocked, no signal)', async (_case, error) => {
      const result = await fallbackScan({
        browser: async () => ({ status: 'skipped', reason: 'tls-fallback-failed', sections: {}, error }),
      });

      const params = result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params;
      expect(params).toEqual({
        host: 'broken.example.test',
        fallback: 'blocked',
        via: VIA,
        url: STORED_FINAL,
      });
    });
  });

  it.each([
    ['the sandbox does not start', 'sandbox-unavailable', 'sandbox-unavailable'],
    ['Chromium is missing', 'browser-unavailable', 'browser-missing'],
    ['the start page there is blocked', 'blocked', 'start-page-blocked'],
  ] as const)(
    'a fatal of the browser on the redirect target (%s) → browser skipped (tls-fallback-failed), complete, exit 1',
    async (_name, reason, code) => {
      const result = await fallbackScan({
        browser: async () => ({ status: 'error', reason: code, sections: {}, fatal: { reason, code } }),
      });

      expect(result.report.scan.status).toBe('complete');
      expect(result.exitCode).toBe(1);
      expect(result.snapshot?.collection.browser).toMatchObject({
        status: 'skipped',
        reason: 'tls-fallback-failed',
        error: { code },
      });
      expect(codes(result)).toContain('SCAN-TLS-BLOCKED');
      expect(codes(result)).not.toContain('SCAN-TLS-FALLBACK');
      expectValidReport(result.report);
    },
  );

  it('an exception of phase A before the start page there (no fatal) → browser skipped (tls-fallback-failed), complete, exit 1', async () => {
    const result = await fallbackScan({
      browser: async () => ({
        status: 'error',
        reason: 'exception',
        sections: {},
        error: { code: 'phase-a-failed', message: 'launch of the phase browser failed' },
      }),
    });

    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.exitReasons).toEqual(['threshold']);
    expect(result.snapshot?.collection.browser).toMatchObject({
      status: 'skipped',
      reason: 'tls-fallback-failed',
      error: { code: 'phase-a-failed' },
    });
    expect(codes(result)).not.toContain('SCAN-TLS-FALLBACK');
    if (result.report.scan.status !== 'failed') expect(result.report.scan.entry).toBeUndefined();
  });

  it('the global timeout before the redirect target was visited → no failed report, exit 1 as without the attempt', async () => {
    const result = await fallbackScan(
      {
        browser: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => setTimeout(() => resolve({ status: 'error', reason: 'timeout', sections: {} }), 5),
              { once: true },
            );
          }),
      },
      { timeoutMs: 150, abortGraceMs: 200 },
    );

    expect(result.report.scan.status).toBe('partial');
    expect(result.exitCode).toBe(1);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-fallback-failed',
    });
    expect(codes(result)).toContain('SCAN-TLS-BLOCKED');
    expectValidReport(result.report);
  });

  it('a redirect target that answered 500 is not tried: SCAN-TLS-BLOCKED with fallback none', async () => {
    const spy = spyBrowser();
    const result = await fallbackScan({ http: redirectingHttp(500), browser: spy.browser });

    expect(spy.started).toBe(false);
    expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toEqual({
      host: 'broken.example.test',
      fallback: 'none',
    });
  });

  it('switched off with DSGVO_CHECK_SCAN_TLS_FALLBACK=off: the browser is not started (fallback off)', async () => {
    const spy = spyBrowser();
    const result = await fallbackScan({ browser: spy.browser }, { config: { scan: { tlsFallback: 'off' } } });

    expect(spy.started).toBe(false);
    expect(result.report.checks?.find((c) => c.id === 'TEST-01')).toMatchObject({ reason: 'tls-blocked' });
    expect(result.report.diagnostics?.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toEqual({
      host: 'broken.example.test',
      fallback: 'off',
    });
    expect(result.exitCode).toBe(1);
  });
});
