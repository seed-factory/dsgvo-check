/** `scan` with the real HTTP and TLS collectors and only the http checks; a spy browser collector must stay unused. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { httpChecks } from '../../../src/checks/http/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport, Report } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import { scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { closedPort, withRoutes } from './helpers.ts';
import { ALL_ROUTES } from './sites.ts';

const browserSpy = vi.hoisted(() => vi.fn(async () => ({ status: 'skipped' as const, sections: {} })));
vi.mock('../../../src/collectors/browser/index.ts', () => ({ collectBrowser: browserSpy }));

let server: FixtureServer;
let closed: number;
const registry = new CheckRegistry(httpChecks);

function full(r: Report): FullReport {
  if (r.scan.status === 'failed') throw new Error('expected a full report');
  return r as FullReport;
}

beforeAll(async () => {
  server = await startFixtureServer({ routes: ALL_ROUTES, tls: { 'www.expired.test': 'expired' } });
  closed = await closedPort();
});

afterAll(async () => {
  await server?.close();
});

/** A scan with the real HTTP and TLS collectors against the fixture server; `failOn` is optional. */
function httpScan(url: string, network: NetworkConfig, failOn?: 'warning') {
  return scan({ url, network, registry, ...(failOn ? { failOn } : {}), log: silentLogger });
}

describe('scan with HDR-01, TLS-01, TLS-02', () => {
  describe('good site', () => {
    let result: Awaited<ReturnType<typeof httpScan>>;
    let report: FullReport;

    beforeAll(async () => {
      server.reset();
      result = await httpScan('https://www.redirect.test/', server.network(), 'warning');
      report = full(result.report);
    });

    it('is a valid, complete report with all three checks completed', () => {
      expectValidReport(result.report);
      expect(report.scan.status).toBe('complete');
      expect(Object.fromEntries(report.checks.map((c) => [c.id, c.status]))).toEqual({
        'HDR-01': 'completed',
        'TLS-01': 'completed',
        'TLS-02': 'completed',
      });
    });

    it('has only info findings, with their evidence', () => {
      expect(report.findings.map((f) => [f.checkId, f.variant, f.severity, f.crmCode])).toEqual([
        ['HDR-01', 'header-missing', 'info', 'T3_NO_SECURITY_HEADERS'],
        ['TLS-01', 'redirect-chain-detail', 'info', null],
      ]);
      expect(new Set(report.evidence.map((e) => e.type))).toEqual(new Set(['header', 'redirect-chain']));
    });

    it('exits 0 even with --fail-on warning', () => {
      expect(result.exitCode).toBe(0);
    });

    it('leaves the browser collector unused and touches only declared hosts', () => {
      expect(result.snapshot?.collection.browser).toMatchObject({ status: 'not-run' });
      expect(browserSpy).not.toHaveBeenCalled();
      expect(result.snapshot?.plan.probes.length).toBe(8);
      expect(server.unexpected).toEqual([]);
    });
  });

  it('expired certificate and http content: critical findings, exit 1 (threshold)', async () => {
    const result = await httpScan(
      'https://www.expired.test/',
      withRoutes(server.network(), { 'expired.test': closed }),
    );

    expectValidReport(result.report);
    const r = full(result.report);
    const critical = r.findings
      .filter((f) => f.severity === 'critical')
      .map((f) => `${f.checkId}.${f.variant}`);
    expect(critical.sort()).toEqual(['TLS-01.https-unavailable', 'TLS-02.certificate-invalid']);
    expect(r.checks.find((c) => c.id === 'HDR-01')).toMatchObject({
      status: 'inconclusive',
      reason: 'tls-invalid',
    });
    expect(r.evidence.find((e) => e.type === 'tls')).toMatchObject({
      host: 'www.expired.test',
      authorizationError: 'CERT_HAS_EXPIRED',
      trustStore: 'test',
    });
    expect(result.exitCode).toBe(1);
    expect(r.summary.exitReasons).toEqual(['threshold']);
  });

  it('target down on 80 and 443: failed report, exit 2 (unreachable)', async () => {
    const result = await httpScan(
      'https://www.down.test/',
      withRoutes(server.network(), { 'www.down.test': closed, 'down.test': closed }),
    );

    expectValidReport(result.report);
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toEqual(['unreachable']);
  });
});
