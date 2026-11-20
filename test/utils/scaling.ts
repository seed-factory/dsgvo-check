import { expect } from 'vitest';

/** A batch shorter than this is dominated by timer resolution, so the batch size doubles until it is longer. */
const MIN_BATCH_MS = 5;
const CALIBRATION_ROUNDS = 3;
const MEASURE_ROUNDS = 5;
/** Largest accepted slowdown of the large input relative to the small one. */
const MAX_SLOWDOWN = 12;

/** Compare growth using batches long enough to reduce timer and scheduling noise. */
export function expectLinearGrowth(small: () => unknown, large: () => unknown): void {
  // Warm-up, so compilation and cache fills are not measured.
  small();
  large();

  const measure = (run: () => unknown, count: number): number => {
    const start = performance.now();
    for (let i = 0; i < count; i++) run();
    return performance.now() - start;
  };

  // Calibration selects the batch size; it is not a limit on application performance.
  let count = 1;
  while (
    Math.min(...Array.from({ length: CALIBRATION_ROUNDS }, () => measure(small, count))) < MIN_BATCH_MS
  ) {
    count *= 2;
  }

  const best = (run: () => unknown) =>
    Math.min(...Array.from({ length: MEASURE_ROUNDS }, () => measure(run, count)));
  expect(best(large) / best(small)).toBeLessThan(MAX_SLOWDOWN);
}
