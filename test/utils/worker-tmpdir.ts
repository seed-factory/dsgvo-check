/**
 * Setup file of the integration and e2e projects: every test file runs with its own temporary directory.
 *
 * Several workers run at the same time and share the machine's temp dir. Tests look for and delete
 * `dsgvo-check-profile-*` there (G57), and the `collect()` helper leaves one output directory per call. So each file
 * gets `<run dir>/w<VITEST_POOL_ID>-<pid>` as `TMPDIR` (read by `os.tmpdir()` on every call, inherited by child
 * processes and by Chromium). The directory is removed after the file and again when the process exits; the run
 * dir (global-tmpdir.ts) is removed after the run, which also takes what a terminated worker or a skipped file left.
 *
 * The path stays short: Chromium puts unix sockets below it and a socket path is limited to about 100 characters.
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
if (!root) throw new Error('test/utils/worker-tmpdir.ts needs test/utils/global-tmpdir.ts as globalSetup');

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
