/**
 * Same-site links to `http://` with the real browser, HTTP and TLS collectors: the browser records them as http and
 * same-site (an upper-case `HTTP://` included), TLS-01 reports them per linked host, and neither the browser nor the
 * HTTP collector follows them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { testDataDir } from '../../utils/scan-harness.ts';
import { BROWSER_PROBE_CHECK, FAST_TIMING, TEST_SANDBOX } from './helpers.ts';
import { page, type SiteDir, writeSite } from './site-dir.ts';

let server: FixtureServer;
let site: SiteDir;
let r: ScanResult;
let report: FullReport;
const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });

const html = { 'content-type': 'text/html; charset=utf-8' };

beforeAll(async () => {
  const legal = (title: string) =>
    page(`<main><h1>${title}</h1><p>Beispiel GmbH, Musterstraße 1.</p></main>`);
  site = writeSite({
    'index.html': page(`
      <header><nav><a href="HTTP://work.example.test/">Startseite</a> <a href="/kontakt/">Kontakt</a></nav></header>
      <main><h1>Beispiel</h1><p>Willkommen.</p></main>
      <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>
      <div id="cookie-consent" class="cookie-consent" hidden>
        <p>Wir verwenden Cookies.</p><a href="http://www.example.test/datenschutz/">Datenschutz</a>
      </div>`),
    'impressum/index.html': legal('Impressum'),
    'datenschutz/index.html': legal('Datenschutzerklärung'),
    'kontakt/index.html': legal('Kontakt'),
  });
  server = await startFixtureServer({
    hosts: { 'www.example.test': site.root },
    routes: [
      // http of www redirects to https of the same host; its https answers carry no HSTS header
      {
        host: 'www.example.test',
        scheme: 'http',
        path: '/',
        status: 301,
        headers: { location: 'https://www.example.test/' },
        body: '',
      },
      { host: 'example.test', path: '/', status: 404, headers: html, body: page('404') },
    ],
  });

  r = await scan({
    url: 'https://www.example.test/',
    network: server.network(),
    registry: new CheckRegistry([tls01, BROWSER_PROBE_CHECK]),
    dataDir,
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING, phases: ['A'] }) },
  });
  if (r.report.scan.status === 'failed') throw new Error('expected a full report');
  report = r.report as FullReport;
});

afterAll(async () => {
  await server?.close();
  site?.cleanup();
});

describe('same-site http links on the start page', () => {
  it('records them as http and same-site, with their region and visibility', () => {
    const start = r.snapshot?.browser?.phases.find((p) => p.phase === 'A')?.pages[0];
    const links = start?.dom?.links ?? [];
    expect(links.find((l) => l.text === 'Startseite')).toMatchObject({
      href: 'http://work.example.test/',
      hrefKind: 'http',
      sameSite: true,
      region: 'nav',
      visible: true,
    });
    expect(links.find((l) => l.href === 'http://www.example.test/datenschutz/')).toMatchObject({
      hrefKind: 'http',
      sameSite: true,
      region: 'banner',
      visible: false,
    });
  });

  it('reports one TLS-01 finding per linked host in a valid report', () => {
    expectValidReport(r.report);
    const links = report.findings
      .filter((f) => f.checkId === 'TLS-01')
      .map((f) => [f.variant, f.severity, f.confidence, f.params.host]);
    expect(links).toEqual(
      expect.arrayContaining([
        ['internal-http-link', 'warning', 'medium', 'work.example.test'],
        ['internal-http-link-upgraded', 'info', 'high', 'www.example.test'],
      ]),
    );
    expect(report.checks.find((c) => c.id === 'TLS-01')?.status).toBe('completed');
    const evidence = report.evidence.filter((e) => e.type === 'link');
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: 'http://work.example.test/', region: 'nav', visible: true }),
      ]),
    );
  });

  it('follows none of them: no request to work.example.test, no plain-http page load by the browser', () => {
    expect(server.requestsTo('work.example.test')).toEqual([]);
    const browserHttp = server.requests.filter(
      (q) => q.scheme === 'http' && q.userAgent?.includes('Chrome/'),
    );
    expect(browserHttp).toEqual([]);
    expect(server.unexpected).toEqual([]);
  });
});
