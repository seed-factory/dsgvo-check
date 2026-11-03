/** `scan` with the real HTTP and TLS collectors and only the http checks; a spy browser collector must stay unused. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { httpChecks } from '../../../src/checks/http/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport, Report } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
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

describe('scan with HDR-01, TLS-01, TLS-02', () => {
  it('good site: complete, only info findings, exit 0 even with --fail-on warning', async () => {
    server.reset();
    const result = await scan({
      url: 'https://www.redirect.test/',
      network: server.network(),
      registry,
      failOn: 'warning',
      log: silentLogger,
    });
    expectValidReport(result.report);
    const r = full(result.report);
    expect(r.scan.status).toBe('complete');
    expect(Object.fromEntries(r.checks.map((c) => [c.id, c.status]))).toEqual({
      'HDR-01': 'completed',
      'TLS-01': 'completed',
      'TLS-02': 'completed',
    });
    expect(r.findings.map((f) => [f.checkId, f.variant, f.severity, f.crmCode])).toEqual([
      ['HDR-01', 'header-missing', 'info', 'T3_NO_SECURITY_HEADERS'],
      ['TLS-01', 'redirect-chain-detail', 'info', null],
    ]);
    const types = new Set(r.evidence.map((e) => e.type));
    expect(types).toEqual(new Set(['header', 'redirect-chain']));
    expect(result.exitCode).toBe(0);
    expect(result.snapshot?.collection.browser).toMatchObject({ status: 'not-run' });
    expect(browserSpy).not.toHaveBeenCalled();
    expect(result.snapshot?.plan.probes.length).toBe(8);
    expect(server.unexpected).toEqual([]);
  });

  it('expired certificate and http content: critical findings, exit 1 (threshold)', async () => {
    const result = await scan({
      url: 'https://www.expired.test/',
      network: withRoutes(server.network(), { 'expired.test': closed }),
      registry,
      log: silentLogger,
    });
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
    const tlsEvidence = r.evidence.find((e) => e.type === 'tls');
    expect(tlsEvidence).toMatchObject({
      host: 'www.expired.test',
      authorizationError: 'CERT_HAS_EXPIRED',
      trustStore: 'test',
    });
    expect(result.exitCode).toBe(1);
    expect(r.summary.exitReasons).toEqual(['threshold']);
  });

  it('target down on 80 and 443: failed report, exit 2 (unreachable)', async () => {
    const result = await scan({
      url: 'https://www.down.test/',
      network: withRoutes(server.network(), { 'www.down.test': closed, 'down.test': closed }),
      registry,
      log: silentLogger,
    });
    expectValidReport(result.report);
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toEqual(['unreachable']);
  });
});
