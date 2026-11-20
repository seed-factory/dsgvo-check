/**
 * Setup file of the integration and e2e projects: every test file runs with its own temporary directory, because workers
 * share the machine's temp dir while tests delete `dsgvo-check-profile-*` there. Each file gets `<run dir>/w<VITEST_POOL_ID>-<pid>`
 * as `TMPDIR`, removed after the file and on process exit. The path stays short: Chromium's unix socket path is limited to ~100 characters.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, inject } from 'vitest';

const g = globalThis as { __dsgvoTestRealTmp?: string };
// With `--no-isolate` this module runs again in the same process: keep the first, real temp dir to restore.
g.__dsgvoTestRealTmp ??= tmpdir();
const realTmp = g.__dsgvoTestRealTmp;

const root = inject('dsgvoTestTmpRoot');
if (!root)
  throw new Error('test/utils/run/worker-tmpdir.ts needs test/utils/run/global-tmpdir.ts as globalSetup');

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    process.stderr.write(
      `test setup: temporary directory not removed: ${path.basename(dir)} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
    );
  }
}

const dir = path.join(root, `w${process.env.VITEST_POOL_ID ?? '0'}-${process.pid}`);
mkdirSync(dir, { recursive: true });
process.env.TMPDIR = dir;

// Registered first, so it runs last among the afterAll hooks of the file (stack order): the tests' own cleanup is done.
afterAll(() => {
  removeDir(dir);
  process.env.TMPDIR = realTmp;
});

// A worker that exits with an open handle never reaches afterAll.
process.once('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
