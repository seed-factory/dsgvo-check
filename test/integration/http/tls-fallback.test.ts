/**
 * A refused certificate on the target with real HTTP, TLS and browser collectors: the browser checks run on the
 * redirect target of the plain-http address when every certificate on that way is accepted, TLS-02 still reports the
 * target, and a redirect target that is private, has an invalid certificate or answers with a challenge leaves the
 * browser checks skipped without failing the scan.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tls02 } from '../../../src/checks/http/tls-02.ts';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport, Report } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, SITES_DIR, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { testDataDir } from '../../utils/scan-harness.ts';
import { stubCmpApi } from '../browser/consent/stub-cmp.ts';
import { BROWSER_PROBE_CHECK, FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

/** Longer than FAST_TIMING's so that the gap between two navigations is measurable. */
const NAVIGATION_PAUSE_MS = 400;
const RAW_TOKEN = 'raw-fixture-7';

const html = { 'content-type': 'text/html; charset=utf-8' };
const page = (title: string) =>
  `<!doctype html><html lang="de"><title>${title}</title><h1>${title}</h1></html>`;
/** http and https of `host` answer 302 to `location`, as a hoster with a default certificate does. */
const redirect = (host: string, location: string) => ({
  host,
  path: '/',
  status: 302,
  headers: { location },
  body: '',
});

let server: FixtureServer;
const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });

beforeAll(async () => {
  server = await startFixtureServer({
    sites: ['browser/cmp-stub'],
    hosts: { 'site.example.test': path.join(SITES_DIR, 'browser/cmp-stub/www') },
    tls: {
      'broken.example.test': 'self-signed',
      'broken-private.example.test': 'self-signed',
      'broken-expired.example.test': 'self-signed',
      'broken-challenged.example.test': 'self-signed',
      'expired-site.example.test': 'expired',
    },
    routes: [
      redirect('broken.example.test', `https://site.example.test/?token=${RAW_TOKEN}`),
      redirect('broken-private.example.test', 'https://intranet.example.test/'),
      redirect('broken-expired.example.test', 'https://expired-site.example.test/'),
      redirect('broken-challenged.example.test', 'https://challenged.example.test/'),
      { host: 'intranet.example.test', path: '/', status: 200, headers: html, body: page('Intranet') },
      { host: 'expired-site.example.test', path: '/', status: 200, headers: html, body: page('Abgelaufen') },
      {
        host: 'challenged.example.test',
        path: '/',
        status: 403,
        headers: { ...html, 'cf-mitigated': 'challenge', server: 'cloudflare' },
        body: page('Just a moment...'),
      },
      // the apex of the targets' registrable domain, probed by the HTTP and TLS collectors
      { host: 'example.test', path: '/', status: 404, headers: html, body: page('404') },
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

function fallbackScan(host: string, network: NetworkConfig = server.network()): Promise<ScanResult> {
  return scan({
    url: `https://${host}/`,
    network,
    registry: new CheckRegistry([tls02, BROWSER_PROBE_CHECK]),
    dataDir,
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    collectors: {
      browser: createBrowserCollector({
        timing: { ...FAST_TIMING, navigationPauseMs: NAVIGATION_PAUSE_MS },
        phases: ['A', 'B', 'C'],
        cmp: stubCmpApi(),
      }),
    },
  });
}

function full(r: Report): FullReport {
  if (r.scan.status === 'failed') throw new Error('expected a full report');
  return r as FullReport;
}

/** Documents (not subresources) the browser requested from `host`, in order. */
const browserDocuments = (host: string) =>
  server
    .requestsTo(host)
    .filter((r) => r.userAgent?.includes('Chrome/') && /\/(\?.*)?$/.test(r.path))
    .sort((a, b) => a.at - b.at);

const browserRequests = (host: string) =>
  server.requestsTo(host).filter((r) => r.userAgent?.includes('Chrome/'));

const tls02Hosts = (report: FullReport) =>
  report.findings
    .filter((f) => f.checkId === 'TLS-02' && f.variant === 'certificate-invalid')
    .flatMap((f) => report.evidence.filter((e) => f.evidenceIds.includes(e.id)))
    .map((e) => (e as { host?: string }).host);

describe('refused certificate, http redirect to a host with valid certificates', () => {
  let r: ScanResult;
  let report: FullReport;

  beforeAll(async () => {
    server.reset();
    r = await fallbackScan('broken.example.test');
    report = full(r.report);
  });

  it('runs phases A, B and C on the redirect target only', () => {
    expect(r.snapshot?.browser?.phases.map((p) => [p.phase, p.status])).toEqual([
      ['A', 'completed'],
      ['B', 'completed'],
      ['C', 'completed'],
    ]);
    const hosts = (r.snapshot?.browser?.phases ?? []).flatMap((p) =>
      p.pages.map((v) => new URL(v.finalUrl).hostname),
    );
    expect(new Set(hosts)).toEqual(new Set(['site.example.test']));
    expect(browserRequests('broken.example.test')).toEqual([]);
    expect(report.checks.find((c) => c.id === 'TEST-01')?.status).toBe('completed');
  });

  it('opens the redirect target with the query the site sent, which the snapshot keeps redacted', () => {
    expect(browserDocuments('site.example.test')[0]?.path).toBe(`/?token=${RAW_TOKEN}`);
    expect(JSON.stringify(r.snapshot)).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(r.report)).not.toContain(RAW_TOKEN);
  });

  it('keeps TLS-02 critical for the target and exits 1, with a complete, valid report', () => {
    expectValidReport(r.report);
    expect(report.scan.status).toBe('complete');
    expect(tls02Hosts(report)).toContain('broken.example.test');
    expect(report.findings.find((f) => f.checkId === 'TLS-02')?.severity).toBe('critical');
    expect(r.exitCode).toBe(1);
  });

  it('says where the browser checks ran', () => {
    expect(report.scan.entry).toEqual({
      reason: 'tls-invalid',
      requested: 'https://broken.example.test/',
      via: 'http://broken.example.test/',
      url: 'https://site.example.test/?token=[redacted]',
    });
    expect(report.diagnostics.map((d) => d.code)).toContain('SCAN-TLS-FALLBACK');
    expect(report.diagnostics.map((d) => d.code)).not.toContain('SCAN-TLS-BLOCKED');
  });

  it('keeps the pause between navigations', () => {
    const at = browserDocuments('site.example.test').map((d) => d.at);
    expect(at.length).toBeGreaterThan(3);
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(NAVIGATION_PAUSE_MS);
  });
});

describe('refused certificate, http redirect the browser checks do not follow', () => {
  it('to a host resolving to a private address (guard on): the browser opens nothing there', async () => {
    const network: NetworkConfig = {
      ...server.network(),
      allowPrivateAddresses: false,
      lookup: async (host) => [
        { address: host === 'intranet.example.test' ? '127.0.0.1' : '93.184.215.14', family: 4 },
      ],
    };
    const r = await fallbackScan('broken-private.example.test', network);
    const report = full(r.report);

    // The plain-http chain reached it only because the test network routes every host to the fixture server; the
    // browser's own guard refuses the navigation.
    expect(browserRequests('intranet.example.test')).toEqual([]);
    expect(r.snapshot?.collection.browser).toMatchObject({ error: { code: 'start-page-not-public' } });
    expect(report.checks.find((c) => c.id === 'TEST-01')).toMatchObject({
      status: 'skipped',
      reason: 'tls-fallback-failed',
    });
    expect(report.diagnostics.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toMatchObject({
      fallback: 'blocked',
    });
    expect(report.scan.status).toBe('complete');
    expect(r.exitCode).toBe(1);
  });

  it('to a host with an expired certificate: the browser is not started (fallback invalid)', async () => {
    const r = await fallbackScan('broken-expired.example.test');
    const report = full(r.report);

    expect(browserRequests('expired-site.example.test')).toEqual([]);
    expect(r.snapshot?.collection.browser).toMatchObject({ status: 'skipped', reason: 'tls-blocked' });
    expect(report.diagnostics.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toEqual({
      host: 'broken-expired.example.test',
      fallback: 'invalid',
    });
    expect(report.scan.entry).toBeUndefined();
    expect(r.exitCode).toBe(1);
  });

  it('to a host answering with a bot challenge: browser checks skipped (tls-fallback-failed), complete, exit 1', async () => {
    const r = await fallbackScan('broken-challenged.example.test');
    const report = full(r.report);

    expectValidReport(r.report);
    expect(browserDocuments('challenged.example.test').length).toBeGreaterThan(0);
    expect(r.snapshot?.collection.browser).toMatchObject({
      status: 'skipped',
      reason: 'tls-fallback-failed',
      error: { code: 'start-page-blocked' },
    });
    // The report names the protection and its signal; the scanner does not try to get past it.
    expect(report.diagnostics.find((d) => d.code === 'SCAN-TLS-BLOCKED')?.params).toMatchObject({
      fallback: 'bot-protection',
      signals: 'header:cf-mitigated, title:just a moment, status:403',
      url: 'https://challenged.example.test/',
    });
    expect(report.scan.status).toBe('complete');
    expect(report.summary.exitReasons).toEqual(['threshold']);
    expect(r.exitCode).toBe(1);
  });
});
