import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors, nxdomainLookup } from '../../utils/scan-harness.ts';
import { opts, withBrowser } from './fixtures.ts';

describe('scan — target redaction', () => {
  it('query values of the target never reach snapshot, report or saved snapshot; collectors get the raw URL', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'));
    const file = path.join(dir, 'site.snapshot.json');
    const seen: string[] = [];

    const result = await scan(
      opts({
        url: 'https://www.example.de/?token=secret#frag',
        saveSnapshot: file,
        collectors: {
          ...withBrowser,
          browser: async (ctx) => {
            seen.push(ctx.target.url);
            return withBrowser.browser(ctx);
          },
        },
      }),
    );

    // the collectors get the raw URL, everything stored gets the redacted one
    expect(seen).toEqual(['https://www.example.de/?token=secret']);
    expect(result.report.scan.target).toBe('https://www.example.de/?token=[redacted]');
    expect(JSON.stringify(result.report)).not.toContain('secret');
    expect(JSON.stringify(result.snapshot)).not.toContain('secret');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });

  it.each([
    ['credentials', 'https://demo-user:demo-password@example.de/?sid=demo-session'],
    ['invalid URL', 'https://demo-user:demo-password@exa mple.de/?sid=demo-session'],
    ['unsupported scheme', 'ftp://demo-user:demo-password@example.de/?sid=demo-session'],
  ])('failed report for a rejected target (%s) carries no credentials or query values', async (_n, url) => {
    const result = await scan(opts({ url }));

    expect(result.exitCode).toBe(2);
    const json = JSON.stringify(result.report);
    for (const secret of ['demo-user', 'demo-password', 'demo-session']) expect(json).not.toContain(secret);
    expectValidReport(result.report);
  });

  it('a fatal error after parsing keeps the redacted target', async () => {
    const result = await scan(
      opts({ url: 'https://www.example.de/?token=secret', network: { lookup: nxdomainLookup } }),
    );

    expect(result.report.scan.target).toBe('https://www.example.de/?token=[redacted]');
  });
});

describe('scan — preflight', () => {
  it('an IPv6 literal target is classified without DNS (no brackets sent to the resolver)', async () => {
    const asked: string[] = [];
    const lookup = async (host: string) => {
      asked.push(host);
      return nxdomainLookup(host);
    };

    const result = await scan(
      opts({ url: 'https://[2606:4700:4700::1111]/', checks: ['TEST-02'], network: { lookup } }),
    );

    expect(asked).toEqual([]);
    expect(result.report.scan.status).not.toBe('failed');
    expect(result.report.scan.target).toBe('https://[2606:4700:4700::1111]/');
  });

  it.each([
    ['https://[::1]/', 'target-not-public'],
    ['https://127.0.0.1/', 'target-not-public'],
    ['https://[64:ff9b::a9fe:a9fe]/', 'target-not-public'],
  ])('IP literal %s → invalid-input/%s', async (url, code) => {
    const result = await scan(opts({ url, network: { lookup: nxdomainLookup } }));

    expect(result.report.scan.status).toBe('failed');
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe(code);
  });

  it('a host with public and non-public addresses is rejected up front (same policy as the browser guard)', async () => {
    let collectorsRan = false;

    const result = await scan(
      opts({
        network: {
          lookup: async () => [
            { address: '93.184.215.14', family: 4 as const },
            { address: '10.0.0.5', family: 4 as const },
          ],
        },
        collectors: fakeCollectors({
          http: async () => {
            collectorsRan = true;
            return { status: 'ok', sections: {} };
          },
        }),
      }),
    );

    expect(collectorsRan).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.exitReasons).toEqual(['invalid-input']);
    if (result.report.scan.status === 'failed') {
      expect(result.report.scan.failure.code).toBe('target-mixed-addresses');
      expect(result.report.scan.failure.message).toContain('10.0.0.5');
    }
    expectValidReport(result.report);
  });
});
