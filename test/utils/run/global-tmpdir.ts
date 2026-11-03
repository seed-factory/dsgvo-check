/**
 * Global setup of the integration and e2e projects (once per run): the run's temp directory `<tmp>/dsgvo-test-<pid>`;
 * each test file's setup (worker-tmpdir.ts) makes a subdirectory in it. It is removed after the run, with what killed workers left.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Temp directory of this test run; the setup file of each test file creates its own directory inside. */
    dsgvoTestTmpRoot: string;
  }
}

export const RUN_TMP_PREFIX = 'dsgvo-test-';
const RUN_DIR = new RegExp(`^${RUN_TMP_PREFIX}(\\d+)$`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove the directories of test runs that no longer exist (killed run, crash). Runs that are still going, in
 * other terminals, are left alone. Returns the names of the removed directories.
 */
export function sweepDeadRunDirs(base: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = RUN_DIR.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    try {
      rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(name);
    } catch {
      // not ours to remove, or still in use: the next run tries again
    }
  }
  return removed;
}

export default function setup(project: TestProject): () => void {
  const base = tmpdir();
  sweepDeadRunDirs(base);
  const root = path.join(base, `${RUN_TMP_PREFIX}${process.pid}`);
  mkdirSync(root, { recursive: true });
  project.provide('dsgvoTestTmpRoot', root);
  return () => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
