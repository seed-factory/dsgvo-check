import { describe, expect, it } from 'vitest';
import { browserTiming, DEFAULT_TIMING } from '../../../../src/collectors/browser/config.ts';
import { parseConfigInput } from '../../../../src/core/config/load.ts';

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
