/**
 * Full scans with MAIL-01/02 against a fake authoritative DNS and the fixture server: the mail domain of an Impressum
 * address and the domain the start page redirects to are checked besides the scanned domain. No internet.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';
import { type FakeDnsServer, type FakeZone, startFakeDns } from './dns-server.ts';

/** The scanned example.test enforces DMARC and SPF; only the other domains can give findings. */
const SCANNED: FakeZone = {
  'A www.example.test': ['192.0.2.10'],
  'MX example.test': ['10 mx.example.test'],
  'TXT _dmarc.example.test': ['v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.test'],
  'TXT example.test': ['v=spf1 ip4:192.0.2.0/24 -all'],
};

function scanWith(
  server: FixtureServer,
  dns: FakeDnsServer,
  checks: string[],
  config: ScanOptions['config'] = {},
): Promise<ScanResult> {
  return scan({
    url: 'https://www.example.test/',
    config,
    network: { ...server.network(), dnsServers: [dns.server] },
    checks,
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir: mkdtempSync(path.join(tmpdir(), 'dsgvo-mail-domains-')),
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
}

const mailFindings = (report: FullReport) =>
  report.findings
    .filter((f) => f.checkId.startsWith('MAIL-'))
    .map((f) => `${f.checkId}.${f.variant}:${f.params.scope}:${f.params.domain}`)
    .sort();

describe('an Impressum address on another mail domain', () => {
  let server: FixtureServer;
  let dns: FakeDnsServer;
  let result: ScanResult;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['pipeline/mail-contact'] });
    dns = await startFakeDns({
      ...SCANNED,
      'MX example-mail.test': ['10 mx.example-mail.test'],
      'TXT example-mail.test': ['v=spf1 ip4:192.0.2.0/24 ?all'],
    });
    result = await scanWith(server, dns, ['MAIL-01', 'MAIL-02', 'LEGAL-01']);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await dns?.close();
  });

  it('gives MAIL-01 record-not-found and MAIL-02 permissive-qualifier for that domain only', () => {
    expectValidReport(result.report);
    const report = result.report as FullReport;
    expect(mailFindings(report)).toEqual([
      'MAIL-01.record-not-found:contact:example-mail.test',
      'MAIL-02.permissive-qualifier:contact:example-mail.test',
    ]);
    expect(report.findings.find((f) => f.checkId === 'MAIL-01')?.pages).toEqual([
      'https://www.example.test/impressum/',
    ]);
    expect(dns.requests).toContain('TXT _dmarc.example-mail.test');
  });

  it('queries neither the free-mail provider nor the processor named in the privacy policy', () => {
    expect(dns.requests.filter((r) => r.includes('gmx.de'))).toEqual([]);
    expect(dns.requests.filter((r) => r.includes('dpo-service.test'))).toEqual([]);
    expect(result.snapshot?.dns?.mailDomains?.map((d) => [d.domain, d.status, d.reason ?? null])).toEqual([
      ['example-mail.test', 'checked', null],
      ['gmx.de', 'skipped', 'free-mail'],
    ]);
  });

  it('counts the further queries with the others and stores no local part or mailto header', () => {
    const report = result.report as FullReport;
    expect(report.scan.environment.requestsIssued.dns).toBe(result.snapshot?.dns?.queries.length);
    for (const stored of [JSON.stringify(report), JSON.stringify(result.snapshot)]) {
      expect(stored).not.toMatch(/info@/i);
      expect(stored).not.toContain('kontakt@');
      expect(stored).not.toContain('muster.person');
      expect(stored).not.toContain('subject=Anfrage');
    }
  });
});

describe('a start page that redirects to another domain', () => {
  const zone: FakeZone = {
    ...SCANNED,
    'TXT _dmarc.example.test': ['v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@example.test'],
    'MX example-final.test': ['10 mx.example-final.test'],
    'TXT example-final.test': ['v=spf1 ip4:192.0.2.0/24 -all'],
  };
  let dns: FakeDnsServer;

  beforeAll(async () => {
    dns = await startFakeDns(zone);
  });

  afterAll(async () => {
    await dns?.close();
  });

  it('gives exactly one MAIL-01 finding, for the domain without DMARC that the redirect leads to', async () => {
    const server = await startFixtureServer({ sites: ['pipeline/mail-redirect'] });
    try {
      dns.setZone(zone);
      const result = await scanWith(server, dns, ['MAIL-01', 'MAIL-02', 'HDR-01']);

      expectValidReport(result.report);
      expect(result.snapshot?.target.finalHost).toBe('www.example-final.test');
      expect(mailFindings(result.report as FullReport)).toEqual([
        'MAIL-01.record-not-found:final:example-final.test',
      ]);
      expect(dns.requests).toContain('TXT _dmarc.www.example-final.test');
    } finally {
      await server.close();
    }
  }, 60_000);

  /** The scan when the certificate of the scanned host is invalid: the redirect target is checked all the same. */
  async function scanWithInvalidCertificate(config: ScanOptions['config'] = {}): Promise<ScanResult> {
    const server = await startFixtureServer({
      sites: ['pipeline/mail-redirect'],
      tls: { 'www.example.test': 'self-signed' },
    });
    try {
      dns.setZone(zone);
      const result = await scanWith(server, dns, ['MAIL-01', 'MAIL-02', 'TLS-02', 'LEGAL-01'], config);
      expect(dns.requests).toContain('TXT _dmarc.www.example-final.test');
      expect(mailFindings(result.report as FullReport)).toEqual([
        'MAIL-01.record-not-found:final:example-final.test',
      ]);
      return result;
    } finally {
      await server.close();
    }
  }

  it('with an invalid certificate on the scanned host the browser starts on the redirect target, which is checked', async () => {
    const result = await scanWithInvalidCertificate();

    expect(result.snapshot?.collection.browser?.status).not.toBe('skipped');
    expect(result.snapshot?.target.finalHost).toBe('www.example-final.test');
  }, 60_000);

  it('with an invalid certificate on the scanned host and the fallback off (browser not started) the redirect target is still checked', async () => {
    const result = await scanWithInvalidCertificate({ scan: { tlsFallback: 'off' } });

    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'skipped', reason: 'tls-blocked' });
    // No Impressum was read: the report says the mail domains of the Impressum were not collected.
    const mail01 = (result.report as FullReport).checks.find((c) => c.id === 'MAIL-01');
    expect(mail01?.limitations).toContain('mail-domains-not-collected');
  }, 60_000);
});
