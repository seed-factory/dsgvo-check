/**
 * The step that requests the http:// addresses of pages with a form runs after the browser and after the DNS follow-up,
 * when the scan has an HTTP and a browser section; its section replaces the HTTP collector's, its probes join the plan,
 * and a failure is noted in the section so that TLS-01 does not read the further pages as free of forms.
 */
import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../src/checks/dns/mail-01.ts';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import type { CollectorContext, HttpCollector } from '../../../src/core/snapshot/collector.ts';
import type { HttpSection } from '../../../src/core/snapshot/http.ts';
import { scan } from '../../../src/scan.ts';
import {
  makeBrowser,
  makeChain,
  makeDns,
  makeHop,
  makeHttp,
  makePage,
  makePhase,
} from '../../utils/snapshot-builder.ts';
import { browserCheck, opts, withBrowser } from './fixtures.ts';

/** http:// of the target redirects to https, which works: TLS-01 has nothing of its own to report. */
const HTTP: HttpSection = makeHttp({
  chains: [
    makeChain({
      startUrl: 'http://www.example.de/',
      hops: [
        makeHop({ url: 'http://www.example.de/', status: 301, location: 'https://www.example.de/' }),
        makeHop({ url: 'https://www.example.de/', status: 200, tlsAuthorized: true }),
      ],
      outcome: 'ok',
    }),
    makeChain({
      startUrl: 'https://www.example.de/',
      hops: [makeHop({ url: 'https://www.example.de/', status: 200, tlsAuthorized: true })],
      outcome: 'ok',
    }),
  ],
});
const httpStage = async () => ({ status: 'ok' as const, sections: { http: structuredClone(HTTP) } });

/** Phase A read the start page, so TLS-01 also has the links of the pages. */
const browserStage = async () => ({
  status: 'ok' as const,
  sections: {
    browser: makeBrowser({
      phases: [makePhase('A', { pages: [makePage({ url: 'https://www.example.de/' })] })],
    }),
    finalUrl: 'https://www.example.de/',
  },
});

const STAGE = { budget: 3, candidates: 1, durationMs: 9 };

/** A twin step that answers with one requested address. */
const twinStep: HttpCollector = async (ctx) => ({
  status: 'ok',
  sections: {
    http: {
      ...(ctx.snapshot.http as HttpSection),
      twins: [
        {
          page: 'https://www.example.de/blog/post-1/',
          url: 'http://www.example.de/blog/post-1/',
          hop: makeHop({
            url: 'http://www.example.de/blog/post-1/',
            status: 301,
            location: 'https://www.example.de/blog/post-1/',
          }),
          outcome: 'ok',
        },
      ],
      formTwinStage: STAGE,
    },
  },
  probes: [{ kind: 'http', class: 'T', target: 'http://www.example.de/blog/post-1/', purpose: 'form-twin' }],
});

const tlsResult = (report: unknown) => (report as FullReport).checks.find((c) => c.id === 'TLS-01');

describe('scan — the http:// addresses of pages with a form', () => {
  it('run after the browser and the DNS follow-up, with both sections in the context; its section replaces the first', async () => {
    const calls: string[] = [];
    let seen: CollectorContext | null = null;
    const result = await scan(
      opts({
        registry: new CheckRegistry([tls01, mail01, browserCheck]),
        collectors: {
          ...withBrowser,
          http: httpStage,
          dns: async () => ({ status: 'ok', sections: { dns: makeDns({ domain: 'example.de' }) } }),
          browser: async () => {
            calls.push('browser');
            return browserStage();
          },
          dnsFollowUp: async () => {
            calls.push('dnsFollowUp');
            return { status: 'ok', sections: {} };
          },
          httpFormTwins: async (ctx) => {
            calls.push('httpFormTwins');
            seen = ctx;
            return twinStep(ctx);
          },
        },
      }),
    );

    expect(calls).toEqual(['browser', 'dnsFollowUp', 'httpFormTwins']);
    const ctx = seen as CollectorContext | null;
    expect(ctx?.snapshot.browser?.phases.map((p) => p.phase)).toEqual(['A']);
    expect(ctx?.snapshot.http?.chains).toHaveLength(2);
    expect(result.snapshot?.http?.twins?.map((t) => t.url)).toEqual(['http://www.example.de/blog/post-1/']);
    expect(result.snapshot?.http?.formTwinStage).toEqual(STAGE);
    expect(result.snapshot?.plan.probes).toContainEqual({
      kind: 'http',
      class: 'T',
      target: 'http://www.example.de/blog/post-1/',
      purpose: 'form-twin',
    });
    expect(tlsResult(result.report)).toMatchObject({ status: 'completed', limitations: [] });
  });

  it('a failing step keeps the HTTP section and notes the failure: TLS-01 says the further pages are unknown', async () => {
    const result = await scan(
      opts({
        registry: new CheckRegistry([tls01, browserCheck]),
        collectors: {
          ...withBrowser,
          http: httpStage,
          browser: browserStage,
          httpFormTwins: async () => {
            throw new Error('client gone');
          },
        },
      }),
    );

    expect(result.report.scan.status).not.toBe('failed');
    expect(result.snapshot?.http?.chains).toEqual(HTTP.chains);
    expect(result.snapshot?.http?.formTwinStage).toMatchObject({
      budget: 3,
      candidates: null,
      error: { code: 'collector-exception', message: 'client gone' },
    });
    expect(tlsResult(result.report)).toMatchObject({
      status: 'partial',
      limitations: ['http-form-twins-not-collected'],
    });
  });

  it('the deadline during the step → SCAN-TIMEOUT; what it handed over in the grace period is kept', async () => {
    const result = await scan(
      opts({
        registry: new CheckRegistry([tls01, browserCheck]),
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          http: httpStage,
          browser: browserStage,
          httpFormTwins: (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                const http = ctx.snapshot.http as HttpSection;
                resolve({
                  status: 'partial',
                  sections: {
                    http: {
                      ...http,
                      twins: [
                        {
                          page: 'https://www.example.de/kontakt/',
                          url: 'http://www.example.de/kontakt/',
                          hop: null,
                          outcome: 'timeout',
                          error: { code: 'timeout', message: 'scan deadline reached' },
                        },
                      ],
                      formTwinStage: STAGE,
                    },
                  },
                });
              });
            }),
        },
      }),
    );

    expect(result.report.scan.status).toBe('partial');
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.snapshot?.http?.twins?.[0]).toMatchObject({ outcome: 'timeout' });
    expect(tlsResult(result.report)).toMatchObject({
      status: 'partial',
      limitations: ['http-form-twin-undecided:https://www.example.de/kontakt/'],
    });
  });

  it.each([
    ['the browser is not needed (--checks TLS-01)', [tls01]],
    ['the browser ran, but no HTTP check asked for the HTTP section', [browserCheck]],
  ])('does not run when %s', async (_name, checks) => {
    let called = false;
    await scan(
      opts({
        registry: new CheckRegistry(checks),
        collectors: {
          ...withBrowser,
          http: httpStage,
          httpFormTwins: async () => {
            called = true;
            return { status: 'ok', sections: {} };
          },
        },
      }),
    );
    expect(called).toBe(false);
  });
});
