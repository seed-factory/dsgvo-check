/**
 * Profiles of killed scans: SIGKILL runs no exit hook, so the profile (real cookies of the scanned site) stays in the
 * temp dir. It names its owner; the next scan removes profiles of dead owners and leaves running ones alone.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OWNER_MARKER,
  PROFILE_PREFIX,
  profilesOfPid,
  removeProfilesOfPid,
} from '../../../../src/collectors/browser/launch/profile.ts';
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

beforeAll(async () => {
  server = await startFixtureServer({ handlers: [site] });
});

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  for (const c of children) if (c.pid) removeProfilesOfPid(c.pid);
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

/** How long to wait for the orphaned browser of a killed child to end with its parent, and how often to look. */
const PROFILE_RELEASE_WAIT_MS = 20_000;
const PROFILE_POLL_MS = 200;

const exited = (c: ChildProcess) =>
  new Promise<void>((resolve) =>
    c.exitCode !== null || c.signalCode !== null ? resolve() : c.on('exit', () => resolve()),
  );

const processesUsing = (dir: string) =>
  execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).includes(dir);

/**
 * The orphaned browser of a killed child ends with its parent (pipe transport); until then it may still write into its
 * profile, and a profile that is written to while it is removed comes back.
 */
async function waitUntilProfileUnused(dir: string) {
  const t0 = Date.now();
  while (processesUsing(dir) && Date.now() - t0 < PROFILE_RELEASE_WAIT_MS) {
    await new Promise((r) => setTimeout(r, PROFILE_POLL_MS));
  }
}

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
    const killedName = path.basename(killedProfile as string);
    expect(killedName.startsWith(PROFILE_PREFIX), `unexpected profile name ${killedName}`).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(killedProfile as string, OWNER_MARKER), 'utf8'));
    expect(marker).toMatchObject({ pid: killedPid, host: hostname() });

    // SIGKILL runs no hook: the profile with the site's cookies is still there.
    killed.kill('SIGKILL');
    await exited(killed);
    expect(existsSync(killedProfile as string)).toBe(true);
    await waitUntilProfileUnused(killedProfile as string);

    // A new scan starts: the stale profile goes, the one of the running process stays.
    const run = await collect(server, { url: 'https://sweep.example.test/', maxPages: 1 });
    expect(run.result.status).toBe('ok');
    expect(existsSync(killedProfile as string)).toBe(false);
    expect(existsSync(runningProfile as string)).toBe(true);

    // The canary runner removes the profiles of a child it killed by pid, without waiting for the next scan.
    running.kill('SIGKILL');
    await exited(running);
    expect(existsSync(runningProfile as string)).toBe(true);
    await waitUntilProfileUnused(runningProfile as string);
    expect(removeProfilesOfPid(runningPid).map((n) => path.join(tmpdir(), n))).toContain(runningProfile);
    expect(existsSync(runningProfile as string)).toBe(false);
    expect(processesUsing(killedProfile as string)).toBe(false);
  }, 120_000);
});
