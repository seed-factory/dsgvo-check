// Temporary browser profiles: created per launch, registered while alive, removed on close, at process exit, or by the
// next scan when the owner died without cleaning up.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { type Logger, silentLogger } from '../../../core/runtime/logger.ts';

export const PROFILE_PREFIX = 'dsgvo-check-profile-';
/** Names the owner process (`pid`, `startedAt`, `host`); no site data. */
export const OWNER_MARKER = '.dsgvo-check-owner';
/** A profile without a marker (killed between `mkdtemp` and the marker) is removed once it is this old. */
export const UNMARKED_MAX_AGE_MS = 24 * 3_600_000;

/** Attempts to remove a profile; each `rm` retries by itself (below) when a process still holds files. */
const REMOVE_ATTEMPTS = 3;
const SYNC_RM_OPTIONS = { recursive: true, force: true, maxRetries: 2 } as const;
const ASYNC_RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 } as const;

export interface ProfileOwner {
  pid: number;
  startedAt: number;
  /** A pid says nothing about a process of another container or host sharing the temp dir. */
  host?: string;
}

async function writeOwnerMarker(dir: string): Promise<void> {
  const owner: ProfileOwner = {
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
    host: hostname(),
  };
  await writeFile(path.join(dir, OWNER_MARKER), JSON.stringify(owner)).catch(() => undefined);
}

function ownerOf(dir: string): ProfileOwner | null {
  try {
    const v = JSON.parse(readFileSync(path.join(dir, OWNER_MARKER), 'utf8')) as Partial<ProfileOwner>;
    return Number.isInteger(v.pid) && (v.pid as number) > 0
      ? {
          pid: v.pid as number,
          startedAt: Number(v.startedAt) || 0,
          ...(v.host ? { host: String(v.host) } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** `EPERM` means running under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Temp profiles hold real cookies and storage of the scanned site. One still alive at process exit is removed by the
// exit hook; after SIGKILL or a crash its owner marker lets the next scan remove it.
const liveProfiles = new Set<string>();

export function liveProfileDirs(): string[] {
  return [...liveProfiles];
}

// Re-registers the exit hook as the LAST listener: Playwright adds its own browser-SIGKILL handler on launch, and the
// profile must go after the browser.
export function exitHookLast(): void {
  process.off('exit', removeLeftoverProfilesSync);
  process.on('exit', removeLeftoverProfilesSync);
}

function trackProfile(dir: string): void {
  exitHookLast();
  liveProfiles.add(dir);
}

export async function createProfile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), PROFILE_PREFIX));
  trackProfile(dir);
  await writeOwnerMarker(dir);
  return dir;
}

export async function removeProfile(dir: string, log: Logger = silentLogger): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
    try {
      await rm(dir, ASYNC_RM_OPTIONS);
      if (!existsSync(dir)) {
        liveProfiles.delete(dir);
        return;
      }
    } catch (err) {
      failure = err;
    }
  }
  log.warn(
    `temporary browser profile not removed (${(failure as NodeJS.ErrnoException | undefined)?.code ?? 'directory exists'})`,
  );
}

export function removeLeftoverProfilesSync(): void {
  for (const dir of liveProfiles) {
    try {
      rmSync(dir, SYNC_RM_OPTIONS);
    } catch (err) {
      // The profile holds cookies of the scanned site: only the directory name is printed.
      process.stderr.write(
        `dsgvo-check: temporary browser profile not removed: ${path.basename(dir)} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
      );
    }
    liveProfiles.delete(dir);
  }
}

function profileDirsIn(tmp: string): string[] {
  try {
    return readdirSync(tmp)
      .filter((n) => n.startsWith(PROFILE_PREFIX))
      .map((n) => path.join(tmp, n));
  } catch {
    return [];
  }
}

export interface StaleProfileOptions {
  tmp?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
  maxUnmarkedAgeMs?: number;
  host?: string;
}

// Removes profiles of processes that no longer run: the marker names a dead pid, or there is no marker and the
// directory is older than a day. Profiles of running processes are never touched.
export function removeStaleProfiles(o: StaleProfileOptions = {}): string[] {
  const judge = {
    now: o.now ?? Date.now(),
    alive: o.isAlive ?? processAlive,
    maxAge: o.maxUnmarkedAgeMs ?? UNMARKED_MAX_AGE_MS,
    host: o.host ?? hostname(),
  };

  const removed: string[] = [];
  for (const dir of profileDirsIn(o.tmp ?? tmpdir())) {
    if (liveProfiles.has(dir)) continue;
    if (!isStale(dir, judge)) continue;
    try {
      rmSync(dir, SYNC_RM_OPTIONS);
      removed.push(path.basename(dir));
    } catch {
      // still in use or not ours to remove: the next scan tries again
    }
  }
  return removed;
}

function isStale(
  dir: string,
  j: { now: number; alive: (pid: number) => boolean; maxAge: number; host: string },
): boolean {
  const owner = ownerOf(dir);
  // An owner on another host cannot be probed by pid: it is judged by age like an unmarked profile.
  if (owner && (!owner.host || owner.host === j.host)) return !j.alive(owner.pid);
  try {
    return j.now - statSync(dir).mtimeMs > j.maxAge;
  } catch {
    return false;
  }
}

// A pid alone says nothing when containers share the temp dir, so a marker without a host (older versions) is not
// claimed either; the stale sweep still judges it.
export function profilesOfPid(pid: number, tmp: string = tmpdir(), host: string = hostname()): string[] {
  return profileDirsIn(tmp).filter((d) => {
    const owner = ownerOf(d);
    return owner?.pid === pid && owner.host === host;
  });
}

/** For a process of this host killed from outside (the canary runner after SIGKILL). */
export function removeProfilesOfPid(
  pid: number,
  tmp: string = tmpdir(),
  host: string = hostname(),
): string[] {
  const removed: string[] = [];
  for (const dir of profilesOfPid(pid, tmp, host)) {
    try {
      rmSync(dir, SYNC_RM_OPTIONS);
      removed.push(path.basename(dir));
    } catch {
      // best effort
    }
  }
  return removed;
}
