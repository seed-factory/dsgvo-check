/** The browser collector reads its timings and limits from the settings of the scan unless a test injects its own. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { collect } from './helpers.ts';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/selection'] });
});

afterAll(async () => {
  await server?.close();
});

describe('browser collector: settings', () => {
  it('timing and request limit come from ctx.config when deps name none', async () => {
    const run = await collect(server, {
      maxPages: 1,
      deps: { timing: undefined },
      config: {
        browser: {
          phaseAMinDwellMs: 500,
          phaseAHardCapMs: 1_500,
          quietWindowMs: 300,
          navigationPauseMs: 2_500,
          requestLimit: 150,
        },
      },
    });
    const browser = run.result.sections.browser;
    expect(browser?.requestCap.limit).toBe(150);
    const pages = browser?.phases[0]?.pages ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const p of pages) {
      // production timing would stay at least 6 s
      expect(p.navigation.dwellMs).toBeGreaterThanOrEqual(500);
      expect(p.navigation.dwellMs).toBeLessThan(4_000);
    }
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]?.navigation;
      const gap =
        Date.parse(pages[i]?.navigation.startedAt as string) -
        (Date.parse(prev?.startedAt as string) + (prev?.dwellMs as number));
      expect(gap).toBeGreaterThanOrEqual(2_400);
    }
  });

  it('the built-in settings keep the request limit of 2000', async () => {
    const run = await collect(server, { maxPages: 1 });
    expect(run.result.sections.browser?.requestCap.limit).toBe(2_000);
  });
});
