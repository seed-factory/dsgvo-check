/**
 * L2 smoke: real Chromium (CfT new headless) and Node clients reach only the local fixture server.
 * A fake site loads a fake www.google-analytics.com; the request is visible in Playwright events.
 */
import { request } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/core/logger.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { testDispatcher } from '../../utils/network.ts';
import { expectValidReport } from '../../utils/report-validator.ts';

let server: FixtureServer;
let browser: TestBrowser;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['core/smoke'] });
  browser = await launchTestBrowser(server);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('Chromium → fixture server', () => {
  it('loads the fake site and the fake Google Analytics without internet', async () => {
    const page = await browser.context.newPage();
    const hit = page.waitForRequest((r) => r.url().startsWith('https://www.google-analytics.com/g/collect'));
    const response = await page.goto('https://www.example.test/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['strict-transport-security']).toBe('max-age=31536000');
    await hit;

    const urls = browser.requests.map((r) => r.url());
    expect(urls).toContain('https://www.google-analytics.com/analytics.js');
    expect(urls.some((u) => u.startsWith('https://fonts.googleapis.com/css2'))).toBe(true);
    expect(server.requestsTo('www.google-analytics.com').map((r) => r.path)).toContain('/analytics.js');
    expect(server.unexpected).toEqual([]);

    const cookies = await browser.context.cookies();
    expect(cookies.map((c) => c.name)).toContain('_ga');
    const serverAddr = await response?.serverAddr();
    expect(serverAddr?.ipAddress).toBe('127.0.0.1');
    await page.close();
  });

  it('serves declarative redirects on http (port 80 remapped)', async () => {
    const page = await browser.context.newPage();
    const response = await page.goto('http://example.test/');
    expect(page.url()).toBe('https://www.example.test/');
    expect(response?.request().redirectedFrom()?.url()).toBe('http://example.test/');
    await page.close();
  });

  it('broken certificates stay broken for Chromium', async () => {
    // Pages showing a certificate error are not closed: closing a chrome-error page can block for many seconds.
    // They are closed with the context in afterAll.
    for (const host of ['expired.example.test', 'selfsigned.example.test', 'wrongname.example.test']) {
      const page = await browser.context.newPage();
      const error = await page.goto(`https://${host}/`, { timeout: 20_000 }).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(error, host).toMatch(/ERR_CERT/);
    }
  });

  it('other ports do not leak to the internet', async () => {
    const page = await browser.context.newPage();
    await expect(page.goto('http://www.example.test:8080/', { timeout: 15_000 })).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/,
    );
    await page.close();
  });
});

describe('Node clients → fixture server (test connect + test CA)', () => {
  it('undici reaches virtual hosts with SNI and sees Set-Cookie', async () => {
    const dispatcher = testDispatcher(server.network());
    const res = await request('https://www.example.test/set-cookie', { dispatcher });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual([
      'fixture_session=abc; Path=/; HttpOnly',
      'fixture_pref=1; Path=/; Max-Age=3600',
    ]);
    await res.body.text();
    const redirect = await request('http://example.test/', { dispatcher });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('https://www.example.test/');
    await redirect.body.text();
    await dispatcher.close();
  });

  it.each([
    ['expired.example.test', 'CERT_HAS_EXPIRED'],
    ['selfsigned.example.test', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['wrongname.example.test', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ])('%s → %s', async (host, code) => {
    const dispatcher = testDispatcher(server.network());
    await expect(request(`https://${host}/`, { dispatcher })).rejects.toMatchObject({ code });
    await dispatcher.close();
  });
});

describe('scan() with the fixture network', () => {
  it('passes preflight for a fixture host and produces a valid report', async () => {
    const result = await scan({
      url: 'https://www.example.test/',
      network: server.network(),
      registry: new CheckRegistry([]),
      log: silentLogger,
    });
    expect(result.report.scan.status).toBe('complete');
    expect(result.exitCode).toBe(0);
    expectValidReport(result.report);
  });

  it('without allowPrivateAddresses a loopback target is refused (SSRF guard)', async () => {
    const result = await scan({
      url: 'https://www.example.test/',
      network: { ...server.network(), allowPrivateAddresses: false },
      registry: new CheckRegistry([]),
      log: silentLogger,
    });
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['invalid-input']);
  });
});
