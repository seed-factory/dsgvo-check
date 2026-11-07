/**
 * Start-page conditions: WAF/challenge → blocked, 5xx twice or connection failure → unreachable, 429 after the retry →
 * SCAN-THROTTLED, invalid certificate → skipped (tls-blocked); on the redirect target of a refused certificate each of
 * them only skips the browser (tls-fallback-failed); abort leaves no browser process or temp profile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type BrowserType, chromium, type LaunchOptions } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveProfileDirs } from '../../../../src/collectors/browser/launch/profile.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { collect, waitUntil } from '../helpers.ts';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/fatal'] });
});

afterAll(async () => {
  await server?.close();
});

describe('fatal start-page conditions', () => {
  it('Cloudflare-like challenge with 403 → blocked (SCAN-BLOCKED), the visit is kept as evidence', async () => {
    const run = await collect(server, { url: 'https://blocked.example.test/' });

    expect(run.result.status).toBe('error');
    expect(run.result.fatal).toMatchObject({ reason: 'blocked', code: 'start-page-blocked' });
    const start = run.result.sections.browser?.phases[0]?.pages[0];
    expect(start?.challenge).toMatchObject({ detected: true, kind: 'cloudflare' });
    expect(start?.challenge.signals).toEqual(expect.arrayContaining(['header:cf-mitigated', 'status:403']));
  });

  it('503 on the start page twice → unreachable', async () => {
    const run = await collect(server, { url: 'https://down.example.test/' });

    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-5xx' });
    expect(server.requestsTo('down.example.test').filter((r) => r.path === '/')).toHaveLength(2);
  });

  it('connection failure → unreachable', async () => {
    // Any port other than 80/443 is not mapped by the test resolver rules → ERR_NAME_NOT_RESOLVED.
    const run = await collect(server, { url: 'https://www.example.test:8443/' });
    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
  });

  it('invalid certificate → skipped with tls-blocked (no fatal)', async () => {
    const run = await collect(server, { url: 'https://expired.example.test/' });
    expect(run.result).toMatchObject({ status: 'skipped', reason: 'tls-blocked' });
    expect(run.result.fatal).toBeUndefined();
  });

  it('429 on the start page twice → SCAN-THROTTLED, partial, no fatal (5.2: code by the other rules)', async () => {
    const run = await collect(server, {
      url: 'https://throttled.example.test/',
      deps: { phases: ['A', 'B', 'C'] },
    });

    expect(run.result.fatal).toBeUndefined();
    expect(run.result.status).toBe('partial');
    expect(run.result.diagnostics?.map((d) => d.code)).toContain('SCAN-THROTTLED');
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'throttled'],
      ['B', 'skipped', 'throttled'],
      ['C', 'skipped', 'throttled'],
    ]);
    // One retry, then no new navigation to the host (no legal fallbacks, no B/C start page). The favicon is
    // fetched by Chrome itself after each document.
    const paths = server.requestsTo('throttled.example.test').map((r) => r.path);
    expect(paths.filter((p) => p !== '/favicon.ico')).toEqual(['/', '/']);
  });

  it('abort during the start navigation: error/timeout, no fatal, browser and profile cleaned up', async () => {
    const ac = new AbortController();
    const dirs: string[] = [];
    const spy = {
      launchPersistentContext: (dir: string, opts: LaunchOptions) => {
        dirs.push(dir);
        return chromium.launchPersistentContext(dir, opts);
      },
    } as unknown as BrowserType;
    // Abort only once the collection has really started: the fixture server holds the start page open.
    const started = waitUntil(() => server.requestsTo('slow.example.test').length > 0, 20);
    const pending = collect(server, {
      url: 'https://slow.example.test/',
      signal: ac.signal,
      deps: { chromium: spy },
    });
    await started;

    const t0 = Date.now();
    ac.abort();
    const run = await pending;

    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(run.result).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(run.result.fatal).toBeUndefined();
    // Cleanup finished before collect resolved: no profile directory and no Chromium process using it.
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    expect(liveProfileDirs().filter((d) => dirs.includes(d))).toEqual([]);
    const ps = execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' });
    for (const dir of dirs) expect(ps.includes(dir)).toBe(false);
  });

  describe('on the redirect target of a refused certificate', () => {
    const fallback = (url: string) =>
      collect(server, {
        url: 'https://expired.example.test/',
        entry: { reason: 'tls-invalid', url, via: 'http://expired.example.test/' },
      });

    it.each([
      ['a challenge', 'https://blocked.example.test/', 'start-page-blocked'],
      ['503 twice', 'https://down.example.test/', 'start-page-5xx'],
      ['an invalid certificate', 'https://expired.example.test/', 'start-page-tls'],
      ['a connection failure', 'https://www.example.test:8443/', 'start-page-unreachable'],
      // not fatal on the target itself (throttled), but nothing to evaluate there either
      [
        '429 twice without a challenge signature',
        'https://throttled.example.test/',
        'start-page-not-evaluable',
      ],
    ])('%s → skipped with tls-fallback-failed, no fatal, no phase record', async (_name, url, code) => {
      const run = await fallback(url);

      expect(run.result).toMatchObject({ status: 'skipped', reason: 'tls-fallback-failed', error: { code } });
      expect(run.result.fatal).toBeUndefined();
      expect(run.result.sections).toEqual({});
      // Only a block page leaves the labels of its protection signals, for the report to name them.
      expect(run.result.error?.params?.signals !== undefined).toBe(code === 'start-page-blocked');
    });

    it('never navigates to the target whose certificate was refused', async () => {
      const toTarget = () => server.requestsTo('expired.example.test').length;
      const toEntry = () => server.requestsTo('blocked.example.test').length;
      const before = { target: toTarget(), entry: toEntry() };
      await fallback('https://blocked.example.test/');

      expect(toEntry()).toBeGreaterThan(before.entry);
      expect(toTarget()).toBe(before.target);
    });
  });

  it('touches only declared hosts', () => {
    // Chrome's own connectivity probe after a network error is browser traffic, not page traffic.
    expect(server.unexpected).toEqual([]);
  });
});
