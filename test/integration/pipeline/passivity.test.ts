import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ScanResult } from '../../../src/scan.ts';
import { SITES_DIR } from '../../fixture-server/server.ts';
import { useFixtureServer } from '../../fixture-server/use-fixture-server.ts';
import { scanFixture, writeFixtureReports } from './helpers.ts';

const TC_STRING = 'TCSTRINGPRIVATEFIXTUREVALUE';
let result: ScanResult;
let outDir: string;

const server = useFixtureServer(
  () => ({
    sites: ['pipeline/passive'],
    hosts: { 'consent.example.test': path.join(SITES_DIR, 'cmp/cookiebot/cb') },
  }),
  async (server) => {
    outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-passive-'));
    result = await scanFixture(server, {
      url: 'https://www.example.test/',
      outDir,
      checks: ['CONSENT-01', 'CONSENT-02', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05', 'HDR-01'],
    });
  },
);

it('all scan phases and HTTP probes use GET or HEAD and do not submit forms', () => {
  expect(result.report.scan.status).toBe('complete');
  expect(result.snapshot?.browser?.phases.map((phase) => [phase.phase, phase.status])).toEqual([
    ['A', 'completed'],
    ['B', 'completed'],
    ['C', 'completed'],
  ]);
  expect(result.snapshot?.http?.requestsIssued).toBeGreaterThan(0);
  expect(server().requests.length).toBeGreaterThan(0);
  expect(server().requests.filter((request) => !['GET', 'HEAD'].includes(request.method))).toEqual([]);
  expect(server().requests.filter((request) => request.path.startsWith('/submitted'))).toEqual([]);
  expect(server().unexpected).toEqual([]);
});

it('keeps the TC-String out of snapshots and reports', async () => {
  const cookies = result.snapshot?.browser?.phases.flatMap((phase) => phase.cookies) ?? [];
  expect(cookies.map((cookie) => cookie.name)).toContain('euconsent-v2');
  expect(JSON.stringify(result.snapshot)).not.toContain(TC_STRING);

  const { json, html, summary, console: consoleText } = await writeFixtureReports(result, outDir);
  for (const [file, content] of [
    ['report.json', json],
    ['report.html', html],
    ['summary.md', summary],
  ]) {
    expect(content, file).not.toContain(TC_STRING);
  }
  expect(consoleText).not.toContain(TC_STRING);
});
