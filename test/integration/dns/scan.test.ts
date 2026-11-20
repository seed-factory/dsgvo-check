/** Full `scan` with only the MAIL-* checks against a fake authoritative DNS: no browser, no HTTP, no internet. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dnsChecks } from '../../../src/checks/dns/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { type FakeDnsServer, type FakeZone, localDnsNetwork, MAIL_SITE, startFakeDns } from './dns-server.ts';

let dns: FakeDnsServer;

beforeAll(async () => {
  dns = await startFakeDns(MAIL_SITE);
});

afterAll(async () => {
  await dns?.close();
});

const run = (failOn: 'critical' | 'warning', checks = ['MAIL-01', 'MAIL-02']) =>
  scan({
    url: 'https://www.example.test/',
    network: localDnsNetwork(dns),
    registry: new CheckRegistry(dnsChecks),
    checks,
    failOn,
    outDir: mkdtempSync(path.join(tmpdir(), 'dsgvo-dns-')),
    log: silentLogger,
  });

describe('scan with only the MAIL-* checks', () => {
  it('reports DMARC p=none and SPF ~all without DMARC enforcement (exit 1 with --fail-on warning)', async () => {
    dns.setZone(MAIL_SITE);

    const result = await run('warning');

    expectValidReport(result.report);
    expect(result.exitCode).toBe(1);
    expect(result.report.scan.status).not.toBe('failed');
    const report = result.report as FullReport;
    expect(report.findings.map((f) => `${f.checkId}.${f.variant}:${f.severity}`).sort()).toEqual([
      'MAIL-01.policy-none:warning',
      'MAIL-02.softfail-without-enforcement:warning',
    ]);
    expect(report.findings.map((f) => f.crmCode)).toEqual(['T3_MAIL_UNPROTECTED', 'T3_MAIL_UNPROTECTED']);
    expect(report.evidence.filter((e) => e.type === 'dns').length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('dmarc-reports@');
    // MX, DMARC walk and SPF tree, then the seven common DKIM selector names.
    expect(report.scan.environment.requestsIssued.dns).toBe(12);
  });

  it('warnings do not gate with the default --fail-on critical', async () => {
    dns.setZone(MAIL_SITE);
    expect((await run('critical')).exitCode).toBe(0);
  });

  it('SERVFAIL after retry → check-error (exit 2 with --fail-on warning), never a "record-not-found" finding', async () => {
    dns.setZone({
      'MX example.test': ['10 mx.example.test'],
      'TXT _dmarc.www.example.test': 'SERVFAIL',
      'TXT _dmarc.example.test': 'SERVFAIL',
      'TXT _dmarc.test': 'SERVFAIL',
      'TXT example.test': 'SERVFAIL',
    });
    const result = await run('warning');

    expectValidReport(result.report);
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(
      expect.arrayContaining(['check-error:MAIL-01', 'check-error:MAIL-02']),
    );
    const report = result.report as FullReport;
    expect(report.findings).toEqual([]);
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'MAIL-01:error',
      'MAIL-02:error',
      'MAIL-03:skipped',
    ]);
  });
});

/** www.example.test on Microsoft 365: its MX host and SPF include make selector1 and selector2 the given selectors. */
const M365_SITE: FakeZone = {
  'A www.example.test': ['192.0.2.10'],
  'MX example.test': ['0 example-test.mail.protection.outlook.com'],
  'TXT _dmarc.example.test': ['v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.test'],
  'TXT example.test': ['v=spf1 include:spf.protection.outlook.com -all'],
  'TXT spf.protection.outlook.com': ['v=spf1 ip4:192.0.2.0/24 -all'],
  // Microsoft 365 publishes the keys in the tenant domain; the customer domain points there with a CNAME.
  'CNAME selector1._domainkey.example.test': [
    'selector1-example-test._domainkey.example-test.onmicrosoft.com',
  ],
  'CNAME selector2._domainkey.example.test': [
    'selector2-example-test._domainkey.example-test.onmicrosoft.com',
  ],
};

/** A 2048-bit RSA public key as SubjectPublicKeyInfo, the form DKIM generators publish. */
const KEY_2048 = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');

describe('scan with MAIL-03 (DKIM)', () => {
  const dkim = (report: FullReport) =>
    report.findings.filter((f) => f.checkId === 'MAIL-03').map((f) => `${f.variant}:${f.severity}`);

  it('a key behind the CNAME of selector1 is followed by the resolver: no finding', async () => {
    dns.setZone({
      ...M365_SITE,
      'TXT selector1-example-test._domainkey.example-test.onmicrosoft.com': [
        ['v=DKIM1; k=rsa; p=', KEY_2048.slice(0, 200), KEY_2048.slice(200)],
      ],
    });

    const result = await run('warning', ['MAIL-03']);

    expectValidReport(result.report);
    const report = result.report as FullReport;
    // Without the browser no Impressum was read, so only the further mail domains stay open.
    expect(report.checks.find((c) => c.id === 'MAIL-03')).toMatchObject({
      status: 'partial',
      limitations: ['mail-domains-not-collected'],
    });
    expect(dkim(report)).toEqual([]);
    expect(dns.requests.indexOf('TXT selector1._domainkey.example.test')).toBeGreaterThan(
      dns.requests.indexOf('TXT spf.protection.outlook.com'),
    );
  });

  it('dangling CNAMEs on the Microsoft 365 selectors: given-selector-missing (warning, exit 1 with --fail-on warning)', async () => {
    dns.setZone(M365_SITE);

    const result = await run('warning', ['MAIL-03']);

    expectValidReport(result.report);
    expect(result.exitCode).toBe(1);
    const report = result.report as FullReport;
    expect(dkim(report)).toEqual(['given-selector-missing:warning']);
    const finding = report.findings.find((f) => f.checkId === 'MAIL-03');
    expect(finding).toMatchObject({
      crmCode: 'T3_MAIL_UNPROTECTED',
      params: { provider: 'microsoft-365', selectors: 'selector1, selector2' },
    });
  });
});
