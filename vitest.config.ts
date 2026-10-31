import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import { resolveTestWorkers } from './test/utils/test-workers.ts';

const shared = {
  environment: 'node' as const,
  // Fixed locale/time zone for deterministic texts and dates (engineering research §2.9).
  env: { TZ: 'Europe/Berlin', LANG: 'de_DE.UTF-8' },
};

/**
 * Test files run in parallel, one forked worker per file, as many workers as the machine has logical cores.
 * `DSGVO_TEST_WORKERS` overrides it: a number ("4") or a share of the cores ("50%"), see test/utils/test-workers.ts.
 * `maxWorkers` is global in Vitest 5: it is one pool for all projects of a run.
 */
const maxWorkers = resolveTestWorkers(process.env.DSGVO_TEST_WORKERS, availableParallelism());

/**
 * Integration and e2e start real Chromium (a fresh one without a persistent profile per scan) and local servers,
 * and several files run side by side. What they share is kept apart so that the files stay independent:
 * - temp dir: `worker-tmpdir.ts` gives every file its own `TMPDIR` (profiles `dsgvo-check-profile-*`, output dirs);
 * - ports: servers listen on port 0 (a random free port); the target hostnames are virtual (`--host-resolver-rules`);
 * - repo files: tests write only below their temp dir.
 */
const isolated = {
  setupFiles: ['test/utils/worker-tmpdir.ts'],
  // The temp dir of the run: removed after the run with whatever terminated workers and skipped files left in it.
  globalSetup: ['test/utils/global-tmpdir.ts'],
};

export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          ...isolated,
          pool: 'forks',
        },
      },
      {
        test: {
          ...shared,
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          ...isolated,
          pool: 'forks',
        },
      },
      {
        test: {
          ...shared,
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          // Real sites: one scan at a time, politely (AGENTS.md rule 1). Not part of the parallel runs.
          fileParallelism: false,
          pool: 'forks',
        },
      },
    ],
  },
});
