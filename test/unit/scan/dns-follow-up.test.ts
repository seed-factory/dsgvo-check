/**
 * The DNS stage of the further mail domains runs after the browser and after the HTTP final-URL fallback, so it knows
 * the final host even when the browser was skipped; its section replaces the first stage's, and a failure is noted in
 * the section instead of failing the scan.
 */
import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../src/checks/dns/mail-01.ts';
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import type { CollectorContext, DnsCollector } from '../../../src/core/snapshot/collector.ts';
import type { DnsSection } from '../../../src/core/snapshot/dns.ts';
import { scan } from '../../../src/scan.ts';
import {
  makeDns,
  makeDocumentResponse,
  makeHttp,
  makeTls,
  makeTlsEndpoint,
} from '../../utils/snapshot-builder.ts';
import { zoneQueries } from '../checks/dns/zone.ts';
import { browserCheck, opts, withBrowser } from './fixtures.ts';

const FIRST: DnsSection = makeDns({
  domain: 'example.de',
  host: 'www.example.de',
  queries: zoneQueries({
    'MX example.de': ['10 mx.example.de'],
    'TXT _dmarc.www.example.de': 'NXDOMAIN',
    'TXT _dmarc.example.de': ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
  }),
});

const firstStage: DnsCollector = async () => ({ status: 'ok', sections: { dns: structuredClone(FIRST) } });

/** The HTTP client followed the redirect of the start page to another domain. */
const redirectedHttp = async () => ({
  status: 'ok' as const,
  sections: {
    http: makeHttp({
      documents: [
        makeDocumentResponse({
          url: 'https://www.example.de/',
          finalUrl: 'https://www.example.net/',
          role: 'start',
        }),
      ],
    }),
  },
});

/** Needs the HTTP start document (final URL) and the TLS verdict that skips the browser. */
const transportCheck = defineCheck({
  id: 'TEST-02',
  module: 'http',
  requires: ['http', 'tls'],
  variants: [{ variant: 'header' }],
  run: () => [],
});

const invalidCertificate = async () => ({
  status: 'ok' as const,
  sections: {
    tls: makeTls({
      endpoints: [makeTlsEndpoint({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' })],
    }),
  },
});

describe('scan — DNS stage of the further mail domains', () => {
  it('runs after the browser stage, with the HTTP final host when the browser was skipped (tls-blocked)', async () => {
    const calls: string[] = [];
    let seen: CollectorContext | null = null;
    const result = await scan(
      opts({
        registry: new CheckRegistry([mail01, browserCheck, transportCheck]),
        collectors: {
          ...withBrowser,
          http: redirectedHttp,
          tls: invalidCertificate,
          dns: firstStage,
          browser: async () => {
            calls.push('browser');
            return { status: 'ok', sections: {} };
          },
          dnsFollowUp: async (ctx) => {
            calls.push('dnsFollowUp');
            seen = ctx;
            const dns = ctx.snapshot.dns as DnsSection;
            return {
              status: 'ok',
              sections: {
                dns: {
                  ...dns,
                  mailDomains: [],
                  mailDomainStage: { contacts: 'not-collected', durationMs: 7 },
                },
              },
            };
          },
        },
      }),
    );

    expect(calls).toEqual(['dnsFollowUp']);
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'skipped', reason: 'tls-blocked' });
    expect((seen as CollectorContext | null)?.snapshot.target.finalHost).toBe('www.example.net');
    expect(result.snapshot?.dns?.mailDomainStage).toEqual({ contacts: 'not-collected', durationMs: 7 });
    const mail = (result.report as FullReport).checks.find((c) => c.id === 'MAIL-01');
    expect(mail).toMatchObject({ status: 'partial', limitations: ['mail-domains-not-collected'] });
  });

  it('runs after a browser that ran', async () => {
    const calls: string[] = [];
    await scan(
      opts({
        registry: new CheckRegistry([mail01, browserCheck]),
        collectors: {
          ...withBrowser,
          dns: firstStage,
          browser: async (ctx) => {
            calls.push('browser');
            return withBrowser.browser(ctx);
          },
          dnsFollowUp: async () => {
            calls.push('dnsFollowUp');
            return { status: 'ok', sections: {} };
          },
        },
      }),
    );
    expect(calls).toEqual(['browser', 'dnsFollowUp']);
  });

  it('a failing stage keeps the first section and notes the failure, so MAIL-01 says the domains are unknown', async () => {
    const result = await scan(
      opts({
        registry: new CheckRegistry([mail01]),
        collectors: {
          ...withBrowser,
          dns: firstStage,
          dnsFollowUp: async () => {
            throw new Error('resolver gone');
          },
        },
      }),
    );

    expect(result.report.scan.status).not.toBe('failed');
    expect(result.snapshot?.dns?.queries).toEqual(FIRST.queries);
    expect(result.snapshot?.dns?.mailDomainStage).toMatchObject({
      contacts: 'not-collected',
      error: { code: 'collector-exception', message: 'resolver gone' },
    });
    const mail = (result.report as FullReport).checks.find((c) => c.id === 'MAIL-01');
    expect(mail).toMatchObject({ status: 'partial', limitations: ['mail-domains-not-collected'] });
  });

  it('the deadline during the stage → scan partial with SCAN-TIMEOUT; what it handed over in the grace period is kept', async () => {
    const result = await scan(
      opts({
        registry: new CheckRegistry([mail01]),
        timeoutMs: 100,
        abortGraceMs: 500,
        collectors: {
          ...withBrowser,
          dns: firstStage,
          dnsFollowUp: (ctx) =>
            new Promise((resolve) => {
              const dns = ctx.snapshot.dns as DnsSection;
              ctx.signal.addEventListener('abort', () =>
                resolve({
                  status: 'partial',
                  sections: {
                    dns: {
                      ...dns,
                      mailDomains: [
                        {
                          domain: 'example-mail.de',
                          host: 'example-mail.de',
                          orgDomain: 'example-mail.de',
                          roles: ['contact'],
                          sources: [],
                          status: 'skipped',
                          reason: 'aborted',
                          budget: { limit: 30, used: 0 },
                        },
                      ],
                      mailDomainStage: { contacts: 'impressum', durationMs: 100 },
                    },
                  },
                }),
              );
            }),
        },
      }),
    );

    expect(result.report.scan.status).toBe('partial');
    expect(result.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(result.snapshot?.dns?.mailDomains?.[0]).toMatchObject({ status: 'skipped', reason: 'aborted' });
    const mail = (result.report as FullReport).checks.find((c) => c.id === 'MAIL-01');
    expect(mail).toMatchObject({
      status: 'partial',
      limitations: ['mail-domain-unresolved:example-mail.de'],
    });
  });

  it('without a DNS section (no MAIL check selected) the stage does not run', async () => {
    let called = false;
    await scan(
      opts({
        collectors: {
          ...withBrowser,
          dnsFollowUp: async () => {
            called = true;
            return { status: 'ok', sections: {} };
          },
        },
      }),
    );
    expect(called).toBe(false);
  });
});
