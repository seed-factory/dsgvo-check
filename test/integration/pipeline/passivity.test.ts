import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, SITES_DIR, startFixtureServer } from '../../fixture-server/server.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

const TC_STRING = 'TCSTRINGPRIVATEFIXTUREVALUE';
let server: FixtureServer;
let result: ScanResult;
let outDir: string;

beforeAll(async () => {
  server = await startFixtureServer({
    sites: ['pipeline/passive'],
    hosts: { 'consent.example.test': path.join(SITES_DIR, 'cmp/cookiebot/cb') },
  });
  outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-passive-'));
  result = await scan({
    url: 'https://www.example.test/',
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    outDir,
    checks: ['CONSENT-01', 'CONSENT-02', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05', 'HDR-01'],
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

it('all scan phases and HTTP probes use GET or HEAD and do not submit forms', () => {
  expect(result.report.scan.status).toBe('complete');
  expect(result.snapshot?.browser?.phases.map((phase) => [phase.phase, phase.status])).toEqual([
    ['A', 'completed'],
    ['B', 'completed'],
    ['C', 'completed'],
  ]);
  expect(result.snapshot?.http?.requestsIssued).toBeGreaterThan(0);
  expect(server.requests.length).toBeGreaterThan(0);
  expect(server.requests.filter((request) => !['GET', 'HEAD'].includes(request.method))).toEqual([]);
  expect(server.requests.filter((request) => request.path.startsWith('/submitted'))).toEqual([]);
  expect(server.unexpected).toEqual([]);
});

it('keeps the TC-String out of snapshots and reports', async () => {
  const cookies = result.snapshot?.browser?.phases.flatMap((phase) => phase.cookies) ?? [];
  expect(cookies.map((cookie) => cookie.name)).toContain('euconsent-v2');
  expect(JSON.stringify(result.snapshot)).not.toContain(TC_STRING);

  const written = await writeReports(result, {
    outDir,
    formats: ['console', 'json', 'html', 'summary'],
    lang: 'de',
  });
  expect(written.errors).toEqual([]);
  for (const file of ['report.json', 'report.html', 'summary.md']) {
    expect(readFileSync(path.join(outDir, file), 'utf8'), file).not.toContain(TC_STRING);
  }
  expect(written.console).not.toContain(TC_STRING);
});
