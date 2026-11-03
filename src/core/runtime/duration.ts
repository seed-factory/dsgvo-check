import { InvalidInputError } from './errors.ts';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Parse `--timeout` values like `8m`, `90s`, `1h30m`, `500ms`; a bare number means seconds. */
export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * (UNITS[m[2] as string] as number);
    consumed += m[0].length;
  }
  if (consumed !== s.length || consumed === 0 || total <= 0) {
    throw new InvalidInputError('invalid-duration', { value: input });
  }
  return Math.round(total);
}

/** The inverse of `parseDuration` for the help text: `480000` → `8m`, `90000` → `90s`, `1500` → `1500ms`. */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
