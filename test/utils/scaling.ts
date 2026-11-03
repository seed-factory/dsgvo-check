import { expect } from 'vitest';

/** Compare growth using batches long enough to reduce timer and scheduling noise. */
export function expectLinearGrowth(small: () => unknown, large: () => unknown): void {
  small();
  large();
  const measure = (run: () => unknown, count: number): number => {
    const start = performance.now();
    for (let i = 0; i < count; i++) run();
    return performance.now() - start;
  };
  let count = 1;
  // Calibration selects the batch size; it is not a limit on application performance.
  while (Math.min(...Array.from({ length: 3 }, () => measure(small, count))) < 5) count *= 2;
  const best = (run: () => unknown) => Math.min(...Array.from({ length: 5 }, () => measure(run, count)));
  expect(best(large) / best(small)).toBeLessThan(12);
}
