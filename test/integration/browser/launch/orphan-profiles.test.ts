/**
 * Profiles of killed scans: SIGKILL runs no exit hook, so the profile (real cookies of the scanned site) stays in the
 * temp dir. It names its owner; the next scan removes profiles of dead owners and leaves running ones alone.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OWNER_MARKER,
  PROFILE_PREFIX,
  profilesOfPid,
  removeProfilesOfPid,
} from '../../../../src/collectors/browser/launch/launch.ts';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { collect, TEST_SANDBOX } from '../helpers.ts';

const CHILD = fileURLToPath(new URL('./support/profile-child.ts', import.meta.url));

const html = (body: string) =>
  `<!doctype html><html lang="de"><head><title>Start</title></head><body>${body}</body></html>`;
const site: DynamicHandler = {
  host: 'sweep.example.test',
  path: /.*/,
  handle: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html('<h1>Start</h1>'));
  },
};

let server: FixtureServer;
const children: ChildProcess[] = [];
const created: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer({ handlers: [site] });
});

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  for (const c of children) if (c.pid) removeProfilesOfPid(c.pid);
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  await server?.close();
  // The collector runs of this file leave nothing behind either.
  expect(profilesOfPid(process.pid)).toEqual([]);
});

function startChild(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, TEST_SANDBOX], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`child not ready: ${out}`)), 60_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('exit', () => clearTimeout(timer));
  });
}

const exited = (c: ChildProcess) =>
  new Promise<void>((resolve) =>
    c.exitCode !== null || c.signalCode !== null ? resolve() : c.on('exit', () => resolve()),
  );

const processesUsing = (dir: string) =>
  execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).includes(dir);

describe('a scan killed with SIGKILL leaves its profile; the next scan removes it', () => {
  it('the profile of the killed process stays, names its owner, and is swept by the next collector run; a running process keeps its own', async () => {
    const killed = await startChild();
    const running = await startChild();
    const killedPid = killed.pid as number;
    const runningPid = running.pid as number;
    const [killedProfile] = profilesOfPid(killedPid);
    const [runningProfile] = profilesOfPid(runningPid);
    expect(killedProfile).toBeDefined();
    expect(runningProfile).toBeDefined();
    expect(path.basename(killedProfile as string).startsWith(PROFILE_PREFIX)).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(killedProfile as string, OWNER_MARKER), 'utf8'));
    expect(marker).toMatchObject({ pid: killedPid, host: hostname() });

    killed.kill('SIGKILL');
    await exited(killed);
    // No hook ran: the profile with the site's cookies is still there (the situation of the canary run).
    expect(existsSync(killedProfile as string)).toBe(true);

    // The orphaned browser ends with its parent (pipe transport); until then it may still write into its profile.
    const t0 = Date.now();
    while (processesUsing(killedProfile as string) && Date.now() - t0 < 20_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // A new scan starts: the stale profile goes, the one of the running process stays.
    const run = await collect(server, { url: 'https://sweep.example.test/', maxPages: 1 });
    expect(run.result.status).toBe('ok');
    expect(existsSync(killedProfile as string)).toBe(false);
    expect(existsSync(runningProfile as string)).toBe(true);

    // The canary runner removes the profiles of a child it killed by pid, without waiting for the next scan.
    running.kill('SIGKILL');
    await exited(running);
    expect(existsSync(runningProfile as string)).toBe(true);
    // Same as above: the orphaned browser of the killed child ends with its parent and may write into its profile
    // until then, and a profile that is written to while it is removed comes back.
    const t1 = Date.now();
    while (processesUsing(runningProfile as string) && Date.now() - t1 < 20_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(removeProfilesOfPid(runningPid).map((n) => path.join(tmpdir(), n))).toContain(runningProfile);
    expect(existsSync(runningProfile as string)).toBe(false);
    expect(processesUsing(killedProfile as string)).toBe(false);
  }, 120_000);

  it('a profile of a dead owner and one without marker: only the dead one goes (collector start)', async () => {
    const deadPid = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      c.on('exit', () => resolve(c.pid as number));
    });
    const dead = path.join(tmpdir(), `${PROFILE_PREFIX}test-dead-${process.pid}`);
    const unmarked = path.join(tmpdir(), `${PROFILE_PREFIX}test-unmarked-${process.pid}`);
    const mine = path.join(tmpdir(), `${PROFILE_PREFIX}test-mine-${process.pid}`);
    for (const dir of [dead, unmarked, mine]) {
      mkdirSync(path.join(dir, 'Default'), { recursive: true });
      created.push(dir);
    }
    writeFileSync(path.join(dead, OWNER_MARKER), JSON.stringify({ pid: deadPid, startedAt: 1 }));
    writeFileSync(path.join(mine, OWNER_MARKER), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    await collect(server, { url: 'https://sweep.example.test/', maxPages: 1 });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(unmarked)).toBe(true); // fresh and unmarked: might be a profile that is just being created
    expect(existsSync(mine)).toBe(true);
    rmSync(mine, { recursive: true, force: true });
    rmSync(unmarked, { recursive: true, force: true });
  }, 120_000);
});
