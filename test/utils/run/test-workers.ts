/**
 * Worker count of the Vitest run (`maxWorkers`). `DSGVO_TEST_WORKERS` sets it: from the environment first, then from
 * `.env` in the repository root, otherwise one worker per logical core. CI pins it to the reference runner (4 vCPU).
 * A value is a positive integer ("4") or a share of the logical cores ("50%"); anything else is an error naming the
 * variable.
 */
import path from 'node:path';
import { readEnvFile } from '../../../src/core/config/dotenv.ts';

const NAME = 'DSGVO_TEST_WORKERS';

/** Block of `.env.example` after the scanner settings; scripts/emit-env-example.ts appends it. */
export const TEST_ENV_EXAMPLE = `
# ---- tests: development only, read by vitest.config.ts and not by the scanner

# Test files run in parallel (Vitest workers): a whole number or a share of the logical cores, for
# example 4 or 50%. Empty: one worker per logical core. CI sets 4, the reference runner (4 vCPU,
# 16 GB); the repository variable ${NAME} overrides it there.
# ${NAME}=
`;

/** Raw value: a non-empty environment variable wins over `.env` in `root`. */
export function testWorkersSetting(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): string | undefined {
  const fromEnv = env[NAME];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return readEnvFile(path.join(root, '.env'))?.values[NAME];
}

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
