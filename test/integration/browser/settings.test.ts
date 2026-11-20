/** The browser collector reads its timings and limits from the settings of the scan unless a test injects its own. */

import { beforeAll, describe, expect, it } from 'vitest';
import { useFixtureServer } from '../../fixture-server/use-fixture-server.ts';
import { type CollectRun, collect } from './helpers.ts';

const server = useFixtureServer(() => ({ sites: ['browser/selection'] }));

/** Far below the production timing (a page would stay at least 6 s), so that a test run is fast. */
const SETTINGS = {
  phaseAMinDwellMs: 500,
  phaseAHardCapMs: 1_500,
  quietWindowMs: 300,
  navigationPauseMs: 2_500,
  requestLimit: 150,
};
/** Scheduling slack allowed between the configured pause and the measured gap between two page visits. */
const PAUSE_TOLERANCE_MS = 100;
/** A page stays well under this when the settings above apply. */
const DWELL_CEILING_MS = 4_000;

describe('browser collector: settings', () => {
  describe('timing and request limit come from ctx.config when deps name none', () => {
    let browser: CollectRun['result']['sections']['browser'];

    beforeAll(async () => {
      const run = await collect(server(), {
        maxPages: 1,
        deps: { timing: undefined },
        config: { browser: SETTINGS },
      });
      browser = run.result.sections.browser;
    });

    it('takes the request limit from the settings', () => {
      expect(browser?.requestCap.limit).toBe(SETTINGS.requestLimit);
    });

    it('keeps every page for at least the configured dwell, and far less than production timing would', () => {
      const pages = browser?.phases[0]?.pages ?? [];

      expect(pages.length).toBeGreaterThanOrEqual(3);
      for (const p of pages) {
        expect(p.navigation.dwellMs).toBeGreaterThanOrEqual(SETTINGS.phaseAMinDwellMs);
        expect(p.navigation.dwellMs).toBeLessThan(DWELL_CEILING_MS);
      }
    });

    it('pauses between two page visits for the configured navigation pause', () => {
      const pages = browser?.phases[0]?.pages ?? [];

      for (let i = 1; i < pages.length; i++) {
        const prev = pages[i - 1]?.navigation;
        const gap =
          Date.parse(pages[i]?.navigation.startedAt as string) -
          (Date.parse(prev?.startedAt as string) + (prev?.dwellMs as number));
        expect(gap).toBeGreaterThanOrEqual(SETTINGS.navigationPauseMs - PAUSE_TOLERANCE_MS);
      }
    });
  });
});
