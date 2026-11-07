// Browser processes of one profile: found by their `--user-data-dir`, killed when `context.close()` does not return,
// and waited for before the profile directory is removed.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { type Logger, silentLogger } from '../../../core/runtime/logger.ts';

/** After close or kill, the browser processes get this long to disappear before the profile is removed. */
const PROCESS_EXIT_BUDGET_MS = 2_000;
const PROCESS_POLL_MS = 50;
/** An upper bound for `pkill` / `pgrep`: both only scan the process table. */
const PROCESS_TOOL_TIMEOUT_MS = 2_000;

const EXIT_UNVERIFIED_WARNING = 'browser process exit could not be verified (no process table, no pgrep)';

// Pids running with `dir` as `--user-data-dir` (from `<procRoot>/<pid>/cmdline`); the directory name is unique per
// launch. `null` without a process table (macOS, BSD): unknown, not none.
export function pidsUsingProfile(dir: string, procRoot = '/proc'): number[] | null {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return null;
  }

  const wanted = `--user-data-dir=${dir}`;
  const pids: number[] = [];
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name) || Number(name) === process.pid) continue;
    if (cmdlineHas(procRoot, name, wanted)) pids.push(Number(name));
  }
  return pids;
}

function cmdlineHas(procRoot: string, pid: string, arg: string): boolean {
  try {
    return readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8')
      .split('\0')
      .includes(arg);
  } catch {
    // the process is gone, or its command line is not ours to read
    return false;
  }
}

/** The `--user-data-dir=<dir>` argument as the pattern of `pkill -f` / `pgrep -f`. */
function profilePattern(dir: string): string {
  return `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
}

/** Finds the pids before pkill so their exit can be observed without /proc. */
function profilePidsWithoutProc(dir: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile(
      'pgrep',
      ['-f', '--', profilePattern(dir)],
      { timeout: PROCESS_TOOL_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(err.code === 1 ? [] : null);
        resolve(
          stdout
            .split('\n')
            .map(Number)
            .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
        );
      },
    );
  });
}

/** `none`: nothing matched; `unavailable`: no pkill, or it failed. */
function pkillProfile(dir: string): Promise<'killed' | 'none' | 'unavailable'> {
  return new Promise((resolve) => {
    execFile(
      'pkill',
      ['-KILL', '-f', '--', profilePattern(dir)],
      { timeout: PROCESS_TOOL_TIMEOUT_MS },
      (err) => {
        if (!err) resolve('killed');
        // Exit code 1: no process matched. ENOENT, a timeout or exit code 2/3: no verdict.
        else resolve(err.code === 1 ? 'none' : 'unavailable');
      },
    );
  });
}

export interface KillOptions {
  procRoot?: string;
  kill?: (pid: number) => void;
  log?: Logger;
}

// Kills the browser processes that use `dir` as their profile when `context.close()` does not return. Node does it
// through `/proc` because the runtime image has neither `pkill` nor `ps`; without a process table `pkill` is the
// fallback. A browser that cannot be killed is reported without the profile path.
export async function killBrowserProcesses(dir: string, o: KillOptions = {}): Promise<number[]> {
  if (process.platform === 'win32') return [];
  const log = o.log ?? silentLogger;
  const kill = o.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));

  const pids = pidsUsingProfile(dir, o.procRoot);
  if (pids === null) return killWithoutProc(dir, log);

  killAll(pids, kill, log);
  return pids;
}

function killAll(pids: number[], kill: (pid: number) => void, log: Logger): void {
  let failed = 0;
  for (const pid of pids) {
    try {
      kill(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') failed++;
    }
  }
  if (failed > 0) log.warn(`browser process of a phase did not close and could not be killed (${failed})`);
}

async function killWithoutProc(dir: string, log: Logger): Promise<number[]> {
  const pids = await profilePidsWithoutProc(dir);
  const result = await pkillProfile(dir);
  if (result === 'unavailable') {
    log.warn('browser process of a phase did not close and could not be killed (no process table, no pkill)');
  } else if (pids === null && result === 'killed') {
    log.warn(EXIT_UNVERIFIED_WARNING);
  }
  return pids ?? [];
}

export async function waitForProfileProcesses(dir: string, pids: number[], log: Logger): Promise<void> {
  const pending = new Set(pids);
  const deadline = Date.now() + PROCESS_EXIT_BUDGET_MS;
  while (true) {
    for (const pid of pidsUsingProfile(dir) ?? []) pending.add(pid);
    forgetExited(pending);
    if (pending.size === 0) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log.warn('browser process still running after exit budget');
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(PROCESS_POLL_MS, remaining)));
  }
}

/** Only `ESRCH` on signal 0 says the process is gone; `EPERM` and anything else leave it pending. */
function forgetExited(pending: Set<number>): void {
  for (const pid of pending) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') pending.delete(pid);
    }
  }
}

/** true when the browser closed, false when it had to be killed. */
export async function closeWithin(
  context: BrowserContext,
  dir: string,
  ms: number,
  log?: Logger,
): Promise<boolean> {
  const closed = await closeOrTimeout(context, ms);

  const logger = log ?? silentLogger;
  const pids = !closed
    ? await killBrowserProcesses(dir, { log: logger })
    : (pidsUsingProfile(dir) ?? (await profilePidsWithoutProc(dir)));
  if (pids === null) logger.warn(EXIT_UNVERIFIED_WARNING);
  await waitForProfileProcesses(dir, pids ?? [], logger);
  return closed;
}

async function closeOrTimeout(context: BrowserContext, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    context.close().then(
      () => true,
      () => false, // a rejected close does not establish that the browser exited
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return closed;
}
