/** Full `scan` with only the MAIL-* checks against a fake authoritative DNS: no browser, no HTTP, no internet. */
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
import { type FakeDnsServer, localDnsNetwork, MAIL_SITE, startFakeDns } from './dns-server.ts';

let dns: FakeDnsServer;

beforeAll(async () => {
  dns = await startFakeDns(MAIL_SITE);
});

afterAll(async () => {
  await dns?.close();
});

const run = (failOn: 'critical' | 'warning') =>
  scan({
    url: 'https://www.example.test/',
    network: localDnsNetwork(dns),
    registry: new CheckRegistry(dnsChecks),
    checks: ['MAIL-01', 'MAIL-02'],
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
    expect(report.scan.environment.requestsIssued.dns).toBe(5);
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
    expect(report.checks.map((c) => c.status)).toEqual(['error', 'error']);
  });
});
