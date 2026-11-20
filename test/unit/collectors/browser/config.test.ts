import { describe, expect, it } from 'vitest';
import { browserTiming, DEFAULT_TIMING } from '../../../../src/collectors/browser/config.ts';
import { revealDwellMs } from '../../../../src/collectors/browser/pages/reveal.ts';
import { parseConfigInput } from '../../../../src/core/config/load.ts';
import { DEFAULT_CONFIG } from '../../../../src/core/config/schema.ts';

describe('browser timing from the settings', () => {
  it('the built-in settings give the timing the collector always had', () => {
    expect(DEFAULT_TIMING).toEqual({
      quietWindowMs: 2_000,
      maxInflight: 1,
      phases: {
        A: { minDwellMs: 6_000, hardCapMs: 20_000 },
        B: { minDwellMs: 4_000, hardCapMs: 12_000 },
        C: { minDwellMs: 4_000, hardCapMs: 12_000 },
      },
      navigationPauseMs: 1_500,
      navigationTimeoutMs: 30_000,
      loadTimeoutMs: 15_000,
      cmpCallTimeoutMs: 15_000,
      retryDelayMs: 3_000,
      deadlineReserveMs: 20_000,
    });
  });

  it('every setting lands in its own place', () => {
    const { browser } = parseConfigInput({
      browser: {
        quietWindowMs: 1,
        maxInflight: 2,
        phaseAMinDwellMs: 10,
        phaseAHardCapMs: 11,
        phaseBMinDwellMs: 20,
        phaseBHardCapMs: 21,
        phaseCMinDwellMs: 30,
        phaseCHardCapMs: 31,
        navigationPauseMs: 2_000,
        navigationTimeoutMs: 5_000,
        loadTimeoutMs: 6_000,
        cmpCallTimeoutMs: 7_000,
        retryDelayMs: 8_000,
        deadlineReserveMs: 9,
      },
    });
    expect(browserTiming(browser)).toEqual({
      quietWindowMs: 1,
      maxInflight: 2,
      phases: {
        A: { minDwellMs: 10, hardCapMs: 11 },
        B: { minDwellMs: 20, hardCapMs: 21 },
        C: { minDwellMs: 30, hardCapMs: 31 },
      },
      navigationPauseMs: 2_000,
      navigationTimeoutMs: 5_000,
      loadTimeoutMs: 6_000,
      cmpCallTimeoutMs: 7_000,
      retryDelayMs: 8_000,
      deadlineReserveMs: 9,
    });
  });
});

describe('stay on the content below the first screen', () => {
  it('lasts up to 3 s by default in every phase, within its hard cap', () => {
    for (const p of ['A', 'B', 'C'] as const) {
      expect(revealDwellMs(DEFAULT_CONFIG.browser.revealDwellMs, DEFAULT_TIMING.phases[p])).toBe(3_000);
    }
    expect(DEFAULT_CONFIG.browser.revealMaxHeightPx).toBe(10_000);
  });

  it('never outlasts the hard cap of the phase, and 0 switches it off', () => {
    const phase = { minDwellMs: 400, hardCapMs: 4_000 };
    expect(revealDwellMs(60_000, phase)).toBe(4_000);
    expect(revealDwellMs(1_500, phase)).toBe(1_500);
    expect(revealDwellMs(0, phase)).toBe(0);
    expect(revealDwellMs(3_000, { minDwellMs: 0, hardCapMs: 0 })).toBe(0);
  });
});
