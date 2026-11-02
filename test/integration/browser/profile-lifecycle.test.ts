/** Browser-profile lifecycle tests run with isolated temporary directories. */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  killBrowserProcesses,
  launchPhase,
  liveProfileDirs,
  OWNER_MARKER,
  PROFILE_PREFIX,
  pidsUsingProfile,
  profilesOfPid,
  removeLeftoverProfilesSync,
  removeProfilesOfPid,
  removeStaleProfiles,
} from '../../../src/collectors/browser/launch.ts';
import { defaultNetworkConfig } from '../../../src/core/net.ts';

describe('stale temp profiles are swept, profiles of running processes are not', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-sweep-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function profile(name: string, owner: { pid: number } | null, ageMs = 0): string {
    const dir = path.join(root, `${PROFILE_PREFIX}${name}`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
    // The marker as `launch` writes it, with the host of the owner.
    if (owner)
      writeFileSync(
        path.join(dir, OWNER_MARKER),
        JSON.stringify({ host: hostname(), ...owner, startedAt: 1 }),
      );
    const t = new Date(Date.now() - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes the profile of a dead owner, an old profile without marker; keeps the others', () => {
    const dead = profile('dead', { pid: 999_001 });
    const alive = profile('alive', { pid: 4242 });
    const oldUnmarked = profile('old', null, 48 * 3_600_000);
    const freshUnmarked = profile('fresh', null, 1_000);
    const other = path.join(root, 'something-else');
    mkdirSync(other);
    const removed = removeStaleProfiles({ tmp: root, isAlive: (pid) => pid === 4242 });
    expect(removed.sort()).toEqual([path.basename(dead), path.basename(oldUnmarked)].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(oldUnmarked)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(freshUnmarked)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('a profile of an owner on another host is judged by age, not by a pid that means nothing here', () => {
    const dir = path.join(root, `${PROFILE_PREFIX}elsewhere`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(
      path.join(dir, OWNER_MARKER),
      JSON.stringify({ pid: 999_003, startedAt: 1, host: 'other-container' }),
    );
    const removed = removeStaleProfiles({ tmp: root, isAlive: () => false, host: 'this-container' });
    expect(removed).not.toContain(path.basename(dir));
    expect(existsSync(dir)).toBe(true);
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(dir, old, old);
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: 'this-container' })).toContain(
      path.basename(dir),
    );
  });

  it('a profile of this very process is never swept', () => {
    const mine = profile('mine', { pid: process.pid });
    expect(removeStaleProfiles({ tmp: root })).not.toContain(path.basename(mine));
    expect(existsSync(mine)).toBe(true);
    expect(profilesOfPid(process.pid, root)).toContain(mine);
  });

  it('profiles of one pid can be removed by name of the pid (canary runner after SIGKILL)', () => {
    const a = profile('killed-a', { pid: 777_001 });
    const b = profile('killed-b', { pid: 777_001 });
    const c = profile('other-owner', { pid: 777_002 });
    expect(removeProfilesOfPid(777_001, root).sort()).toEqual([path.basename(a), path.basename(b)].sort());
    expect(existsSync(c)).toBe(true);
    expect(readdirSync(root).filter((n) => n.includes('killed'))).toEqual([]);
  });
});

describe('the removal by pid belongs to the owner of this host, not to every owner of that pid', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-pid-host-test-'));
  const made: string[] = [];
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A profile with the marker as `launch` writes it, or, with `host: null`, as older versions wrote it. */
  function profile(name: string, owner: { pid: number; host: string | null }): string {
    const dir = path.join(root, `${PROFILE_PREFIX}${name}`);
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
    const { host, ...rest } = owner;
    writeFileSync(
      path.join(dir, OWNER_MARKER),
      JSON.stringify({ ...rest, startedAt: 1, ...(host === null ? {} : { host }) }),
    );
    made.push(dir);
    return dir;
  }

  it('a shared temp dir, the same pid on two hosts: only the profile of this host is found and removed', () => {
    const own = profile('own-42', { pid: 42, host: hostname() });
    const foreign = profile('foreign-42', { pid: 42, host: 'other-container' });
    const foreignOtherPid = profile('foreign-43', { pid: 43, host: 'other-container' });
    expect(profilesOfPid(42, root)).toEqual([own]);
    expect(removeProfilesOfPid(42, root)).toEqual([path.basename(own)]);
    expect(existsSync(own)).toBe(false);
    // The live scan of the other container keeps its cookies and files.
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignOtherPid)).toBe(true);
  });

  it('the host can be named: the same lookup from the point of view of the other container', () => {
    const here = profile('here-44', { pid: 44, host: 'this-container' });
    const there = profile('there-44', { pid: 44, host: 'other-container' });
    expect(profilesOfPid(44, root, 'other-container')).toEqual([there]);
    expect(removeProfilesOfPid(44, root, 'other-container')).toEqual([path.basename(there)]);
    expect(existsSync(there)).toBe(false);
    expect(existsSync(here)).toBe(true);
  });

  it('an older marker without host is not claimed by pid (it might be a foreign one); the stale sweep still judges it', () => {
    const legacy = profile('legacy-45', { pid: 45, host: null });
    const own = profile('own-45', { pid: 45, host: hostname() });
    expect(profilesOfPid(45, root)).toEqual([own]);
    expect(removeProfilesOfPid(45, root)).toEqual([path.basename(own)]);
    expect(existsSync(legacy)).toBe(true);
    // Not forgotten: the marker names a pid that is gone here, so the next sweep removes it as before.
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([
      path.basename(legacy),
    ]);
  });

  it('counterexample: a foreign profile of a live owner is not swept either, and the age rule still takes an old one', () => {
    const foreign = profile('foreign-46', { pid: 46, host: 'other-container' });
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(foreign, old, old);
    expect(removeStaleProfiles({ tmp: root, isAlive: () => false, host: hostname() })).toEqual([
      path.basename(foreign),
    ]);
  });

  it('counterexample: the profile of this very process (marker with this host) is found by its pid', () => {
    const mine = profile('mine-pid', { pid: process.pid, host: hostname() });
    expect(profilesOfPid(process.pid, root)).toEqual([mine]);
  });
});

describe('a browser that does not close is killed by its profile, with or without pkill', () => {
  const made: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'dsgvo-r14-'));
    made.push(d);
    return d;
  };
  /** A process whose command line carries `--user-data-dir=<dir>` like a browser's (the compound command keeps argv). */
  function standIn(dir: string): ChildProcess {
    const c = spawn('/bin/sh', ['-c', 'sleep 30; :', 'x', `--user-data-dir=${dir}`], {
      stdio: 'ignore',
      env: { ...process.env },
    });
    children.push(c);
    return c;
  }
  const dead = (c: ChildProcess) =>
    new Promise<boolean>((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve(true);
      c.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
  /** `fn` with a PATH that holds no `pkill` (nor `ps`), as in the runtime image. */
  async function withoutPkill<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PATH;
    process.env.PATH = tmp();
    try {
      return await fn();
    } finally {
      process.env.PATH = saved;
    }
  }
  const hasPkill = spawnSync('/bin/sh', ['-c', 'command -v pkill']).status === 0;
  const lines = () => {
    const out: string[] = [];
    return {
      out,
      log: { debug: () => {}, info: () => {}, warn: (m: string) => out.push(m), error: () => {} },
    };
  };

  it('finds the processes of a profile by the exact argument, not by a similar one', () => {
    const proc = tmp();
    const dir = '/tmp/dsgvo-check-profile-abc123';
    const cmd = (...args: string[]) => `${args.join('\0')}\0`;
    const entry = (pid: string, content: string) => {
      mkdirSync(path.join(proc, pid));
      writeFileSync(path.join(proc, pid, 'cmdline'), content);
    };
    entry('101', cmd('/opt/chrome', '--headless', `--user-data-dir=${dir}`, '--disable-quic'));
    entry('102', cmd('/opt/chrome', `--user-data-dir=${dir}-other`));
    entry('103', cmd('/opt/chrome', `--user-data-dir=/tmp/x${dir}`));
    entry('104', cmd('node', 'script.js', dir));
    entry('105', '');
    entry(String(process.pid), cmd('node', `--user-data-dir=${dir}`));
    mkdirSync(path.join(proc, 'self'));
    writeFileSync(path.join(proc, 'self', 'cmdline'), cmd('chrome', `--user-data-dir=${dir}`));
    expect(pidsUsingProfile(dir, proc)).toEqual([101]);
  });

  it('no process table (no /proc): the answer is "unknown", not "none"', () => {
    expect(pidsUsingProfile('/tmp/dsgvo-check-profile-abc123', path.join(tmp(), 'missing'))).toBeNull();
  });

  it('kills what the process table names, nothing else', async () => {
    const proc = tmp();
    mkdirSync(path.join(proc, '4001'));
    writeFileSync(path.join(proc, '4001', 'cmdline'), 'chrome\0--user-data-dir=/tmp/p1\0');
    mkdirSync(path.join(proc, '4002'));
    writeFileSync(path.join(proc, '4002', 'cmdline'), 'chrome\0--user-data-dir=/tmp/p2\0');
    const killed: number[] = [];
    const l = lines();
    await killBrowserProcesses('/tmp/p1', { procRoot: proc, kill: (pid) => killed.push(pid), log: l.log });
    expect(killed).toEqual([4001]);
    expect(l.out).toEqual([]);
  });

  it('a stand-in browser of a hanging close is gone after the budget although pkill is missing', async () => {
    const lg = lines();
    let child: ChildProcess | undefined;
    const chromium = {
      launchPersistentContext: async (dir: string) => {
        child = standIn(dir);
        return { close: () => new Promise<void>(() => {}), pages: () => [] };
      },
    } as unknown as BrowserType;
    const b = await launchPhase(
      { chromium, sandbox: 'off', network: defaultNetworkConfig(), closeBudgetMs: 250, log: lg.log },
      'test-agent',
    );
    await withoutPkill(() => b.close());
    expect(child).toBeDefined();
    if (process.platform === 'linux') {
      expect(await dead(child as ChildProcess)).toBe(true);
      expect(lg.out).toEqual([]);
    } else {
      // No /proc and no pkill: it cannot be killed, and the report of the scan says so (no profile path in the line).
      expect(lg.out).toHaveLength(1);
      expect(lg.out[0]).toMatch(/could not be killed/);
      expect(lg.out[0]).not.toContain(PROFILE_PREFIX);
    }
  });

  it.runIf(hasPkill)('counterexample: without a process table pkill still does the job', async () => {
    const dir = tmp();
    const child = standIn(dir);
    await new Promise((r) => setTimeout(r, 150));
    const l = lines();
    await killBrowserProcesses(dir, { procRoot: path.join(tmp(), 'missing'), log: l.log });
    expect(await dead(child)).toBe(true);
    expect(l.out).toEqual([]);
  });

  it('nothing to kill is no failure: no warning when the browser is already gone', async () => {
    const l = lines();
    await killBrowserProcesses('/tmp/dsgvo-check-profile-nobody', { log: l.log });
    if (process.platform === 'linux' || hasPkill) expect(l.out).toEqual([]);
  });
});

describe('closing a phase browser removes its profile exactly once', () => {
  function slowChromium(dirs: string[], closeMs: number): BrowserType {
    return {
      launchPersistentContext: async (dir: string) => {
        dirs.push(dir);
        return {
          close: () => new Promise<void>((r) => setTimeout(r, closeMs)),
        } as unknown as BrowserContext;
      },
    } as unknown as BrowserType;
  }

  it('a second close waits for the cleanup the first one started', async () => {
    const dirs: string[] = [];
    const b = await launchPhase(
      { chromium: slowChromium(dirs, 200), sandbox: 'off', network: defaultNetworkConfig() },
      'UA',
    );
    const dir = dirs[0] as string;
    expect(existsSync(dir)).toBe(true);
    expect(liveProfileDirs()).toContain(dir);
    void b.close(); // e.g. the abort handler, not awaited
    await b.close(); // e.g. the finally block of run
    expect(existsSync(dir)).toBe(false);
    expect(liveProfileDirs()).not.toContain(dir);
  });

  it('profiles still alive at process exit are removed synchronously by the exit hook', async () => {
    const dirs: string[] = [];
    await launchPhase(
      { chromium: slowChromium(dirs, 0), sandbox: 'off', network: defaultNetworkConfig() },
      'UA',
    );
    const dir = dirs[0] as string;
    expect(existsSync(dir)).toBe(true);
    // Last exit listener: it runs after Playwright's own handler has killed the browser.
    expect(process.listeners('exit').at(-1)).toBe(removeLeftoverProfilesSync);
    removeLeftoverProfilesSync();
    expect(existsSync(dir)).toBe(false);
    expect(liveProfileDirs()).not.toContain(dir);
  });
});
