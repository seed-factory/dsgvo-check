/**
 * Worker count of the Vitest run (`maxWorkers` in vitest.config.ts).
 *
 * Default: one worker per logical core of the machine that runs the tests. `DSGVO_TEST_WORKERS` overrides it with a
 * positive integer ("4") or a percentage of the logical cores ("50%"). Anything else is an error that names the
 * variable, so a typo does not silently fall back to another degree of parallelism.
 */

const NAME = 'DSGVO_TEST_WORKERS';

export function resolveTestWorkers(raw: string | undefined, cores: number): number {
  const all = Math.max(1, Math.floor(cores));
  const value = raw?.trim();
  if (value === undefined || value === '') return all;

  const count = /^(\d+)$/.exec(value);
  if (count) {
    const n = Number(count[1]);
    if (n >= 1 && Number.isSafeInteger(n)) return n;
  }

  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (percent) {
    const p = Number(percent[1]);
    if (p > 0 && p <= 100) return Math.max(1, Math.floor((all * p) / 100));
  }

  throw new Error(
    `${NAME}=${JSON.stringify(raw)} is not valid: use a positive whole number (for example "4") or a percentage of the ${all} logical cores from 1% to 100% (for example "50%"). Unset it to use all ${all} cores.`,
  );
}
