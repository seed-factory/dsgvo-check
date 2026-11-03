// Chromium launch: Chrome for Testing in new headless, a fresh persistent profile per phase in a temp dir (removed
// afterwards), de-DE / Europe/Berlin, 1366×768, downloads and QUIC off, popup blocker on. The UA is the real Chrome UA
// (HeadlessChrome → Chrome) plus the scanner token.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType, LaunchOptions } from 'playwright-core';
import type { SandboxMode } from '../../../core/report/schema.ts';
import { type Logger, silentLogger } from '../../../core/runtime/logger.ts';
import { ACCEPT_LANGUAGE } from '../../../core/runtime/user-agent.ts';
import type { FatalSignal } from '../../../core/snapshot/collector.ts';
import type { NetworkConfig } from '../../../core/url/net.ts';
import { BROWSER_CHANNEL, LOCALE, TIMEZONE, VIEWPORT } from '../config.ts';
import { errorText } from '../util.ts';

export interface LaunchConfig {
  chromium: BrowserType;
  sandbox: SandboxMode;
  network: NetworkConfig;
  executablePath?: string;
  /** Report printing disables script execution and starts offline. */
  javaScriptEnabled?: boolean;
  offline?: boolean;
  timeoutMs?: number;
  closeBudgetMs?: number;
  log?: Logger;
}

export interface EngineProbe {
  /** May contain HeadlessChrome. */
  rawUserAgent: string;
  version: string;
  disabledFeatures: string[];
  sandbox: boolean;
}

export interface PhaseBrowser {
  context: BrowserContext;
  close(): Promise<void>;
}

function proxyOption(proxy: string | null): LaunchOptions['proxy'] | undefined {
  if (!proxy) return undefined;
  try {
    const u = new URL(proxy);
    const server = `${u.protocol}//${u.host}`;
    return {
      server,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return { server: proxy };
  }
}

function args(network: NetworkConfig): string[] {
  const out = ['--disable-quic'];
  if (network.proxy) out.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  out.push(...(network.test?.browserArgs ?? []));
  return out;
}

// Temp profiles hold real cookies and storage of the scanned site. One still alive at process exit is removed by the
// exit hook; after SIGKILL or a crash its owner marker lets the next scan remove it.
const liveProfiles = new Set<string>();

export function liveProfileDirs(): string[] {
  return [...liveProfiles];
}

export const PROFILE_PREFIX = 'dsgvo-check-profile-';
/** Names the owner process (`pid`, `startedAt`, `host`); no site data. */
export const OWNER_MARKER = '.dsgvo-check-owner';
/** A profile without a marker (killed between `mkdtemp` and the marker) is removed once it is this old. */
export const UNMARKED_MAX_AGE_MS = 24 * 3_600_000;

export interface ProfileOwner {
  pid: number;
  startedAt: number;
  /** A pid says nothing about a process of another container or host sharing the temp dir. */
  host?: string;
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
  const now = o.now ?? Date.now();
  const alive = o.isAlive ?? processAlive;
  const maxAge = o.maxUnmarkedAgeMs ?? UNMARKED_MAX_AGE_MS;
  const host = o.host ?? hostname();
  const removed: string[] = [];
  for (const dir of profileDirsIn(o.tmp ?? tmpdir())) {
    if (liveProfiles.has(dir)) continue;
    const owner = ownerOf(dir);
    let stale: boolean;
    // An owner on another host cannot be probed by pid: it is judged by age like an unmarked profile.
    if (owner && (!owner.host || owner.host === host)) stale = !alive(owner.pid);
    else {
      try {
        stale = now - statSync(dir).mtimeMs > maxAge;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(path.basename(dir));
    } catch {
      // still in use or not ours to remove: the next scan tries again
    }
  }
  return removed;
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
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(path.basename(dir));
    } catch {
      // best effort
    }
  }
  return removed;
}

export function removeLeftoverProfilesSync(): void {
  for (const dir of liveProfiles) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch (err) {
      // The profile holds cookies of the scanned site: only the directory name is printed.
      process.stderr.write(
        `dsgvo-check: temporary browser profile not removed: ${path.basename(dir)} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
      );
    }
    liveProfiles.delete(dir);
  }
}

// Re-registers the exit hook as the LAST listener: Playwright adds its own browser-SIGKILL handler on launch, and the
// profile must go after the browser.
function exitHookLast(): void {
  process.off('exit', removeLeftoverProfilesSync);
  process.on('exit', removeLeftoverProfilesSync);
}

function trackProfile(dir: string): void {
  exitHookLast();
  liveProfiles.add(dir);
}

async function removeProfile(dir: string, log: Logger = silentLogger): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
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

const PROCESS_EXIT_BUDGET_MS = 2_000;
const PROCESS_POLL_MS = 50;

async function waitForProfileProcesses(dir: string, pids: number[], log: Logger): Promise<void> {
  const pending = new Set(pids);
  const deadline = Date.now() + PROCESS_EXIT_BUDGET_MS;
  while (true) {
    for (const pid of pidsUsingProfile(dir) ?? []) pending.add(pid);
    for (const pid of pending) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') pending.delete(pid);
      }
    }
    if (pending.size === 0) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log.warn('browser process still running after exit budget');
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(PROCESS_POLL_MS, remaining)));
  }
}

export const CLOSE_BUDGET_MS = 3_000;

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
    try {
      if (
        readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8')
          .split('\0')
          .includes(wanted)
      ) {
        pids.push(Number(name));
      }
    } catch {
      // the process is gone, or its command line is not ours to read
    }
  }
  return pids;
}

/** `none`: nothing matched; `unavailable`: no pkill, or it failed. */
function pkillProfile(dir: string): Promise<'killed' | 'none' | 'unavailable'> {
  const pattern = `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  return new Promise((resolve) => {
    execFile('pkill', ['-KILL', '-f', '--', pattern], { timeout: 2_000 }, (err) => {
      if (!err) resolve('killed');
      // Exit code 1: no process matched. ENOENT, a timeout or exit code 2/3: no verdict.
      else resolve(err.code === 1 ? 'none' : 'unavailable');
    });
  });
}

/** Finds the pids before pkill so their exit can be observed without /proc. */
function profilePidsWithoutProc(dir: string): Promise<number[] | null> {
  const pattern = `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', '--', pattern], { timeout: 2_000 }, (err, stdout) => {
      if (err) return resolve(err.code === 1 ? [] : null);
      resolve(
        stdout
          .split('\n')
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
      );
    });
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
  if (pids !== null) {
    let failed = 0;
    for (const pid of pids) {
      try {
        kill(pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') failed++;
      }
    }
    if (failed > 0) log.warn(`browser process of a phase did not close and could not be killed (${failed})`);
    return pids;
  }
  const fallbackPids = await profilePidsWithoutProc(dir);
  const result = await pkillProfile(dir);
  if (result === 'unavailable') {
    log.warn('browser process of a phase did not close and could not be killed (no process table, no pkill)');
  } else if (fallbackPids === null && result === 'killed') {
    log.warn('browser process exit could not be verified (no process table, no pgrep)');
  }
  return fallbackPids ?? [];
}

/** true when the browser closed, false when it had to be killed. */
async function closeWithin(context: BrowserContext, dir: string, ms: number, log?: Logger): Promise<boolean> {
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
  const logger = log ?? silentLogger;
  const pids = !closed
    ? await killBrowserProcesses(dir, { log: logger })
    : (pidsUsingProfile(dir) ?? (await profilePidsWithoutProc(dir)));
  if (pids === null) logger.warn('browser process exit could not be verified (no process table, no pgrep)');
  await waitForProfileProcesses(dir, pids ?? [], logger);
  return closed;
}

async function launch(cfg: LaunchConfig, userAgent: string | undefined): Promise<PhaseBrowser> {
  const dir = await mkdtemp(path.join(tmpdir(), PROFILE_PREFIX));
  trackProfile(dir);
  const owner: ProfileOwner = {
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
    host: hostname(),
  };
  await writeFile(path.join(dir, OWNER_MARKER), JSON.stringify(owner)).catch(() => undefined);
  const proxy = proxyOption(cfg.network.proxy);
  const closeBudgetMs = cfg.closeBudgetMs ?? CLOSE_BUDGET_MS;
  let context: BrowserContext;
  try {
    context = await cfg.chromium.launchPersistentContext(dir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      chromiumSandbox: cfg.sandbox === 'require',
      ...(cfg.executablePath ? { executablePath: cfg.executablePath } : {}),
      locale: LOCALE,
      timezoneId: TIMEZONE,
      viewport: VIEWPORT,
      ...(userAgent ? { userAgent } : {}),
      extraHTTPHeaders: { 'Accept-Language': ACCEPT_LANGUAGE },
      acceptDownloads: false,
      ...(cfg.javaScriptEnabled === undefined ? {} : { javaScriptEnabled: cfg.javaScriptEnabled }),
      ...(cfg.offline === undefined ? {} : { offline: cfg.offline }),
      serviceWorkers: 'allow',
      ...(proxy ? { proxy } : {}),
      args: args(cfg.network),
      // Keep Chrome's popup blocker (Playwright disables it); the SSRF guard covers the remaining popups.
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      timeout: cfg.timeoutMs ?? 60_000,
    });
  } catch (err) {
    const log = cfg.log ?? silentLogger;
    const pids = await killBrowserProcesses(dir, { log });
    await waitForProfileProcesses(dir, pids, log);
    await removeProfile(dir, log);
    throw err;
  }
  exitHookLast();
  // One cleanup per profile: every close() returns the same promise, so a later caller waits until the profile is
  // removed.
  let closing: Promise<void> | null = null;
  return {
    context,
    close: () => {
      closing ??= (async () => {
        await closeWithin(context, dir, closeBudgetMs, cfg.log);
        await removeProfile(dir, cfg.log);
      })();
      return closing;
    },
  };
}

// Launches once to learn the real UA, version and effective flags (chrome://version); fails fast when the sandbox or
// the browser is not available.
export async function probeEngine(cfg: LaunchConfig): Promise<EngineProbe> {
  const b = await launch(cfg, undefined);
  try {
    const page = b.context.pages()[0] ?? (await b.context.newPage());
    const cdp = await b.context.newCDPSession(page);
    const v = (await cdp.send('Browser.getVersion')) as { product: string; userAgent: string };
    await cdp.detach().catch(() => undefined);
    let commandLine = '';
    try {
      await page.goto('chrome://version', { timeout: 10_000 });
      commandLine = await page.evaluate(
        "String((document.querySelector('#command_line') || {}).textContent || '')",
      );
    } catch {
      commandLine = '';
    }
    const features = /--disable-features=(\S+)/.exec(commandLine)?.[1];
    return {
      rawUserAgent: v.userAgent,
      version: v.product.replace(/^[^/]*\//, ''),
      disabledFeatures: features ? features.split(',').filter(Boolean) : [],
      sandbox: cfg.sandbox === 'require' && !commandLine.includes('--no-sandbox'),
    };
  } finally {
    await b.close();
  }
}

export function launchPhase(cfg: LaunchConfig, userAgent: string): Promise<PhaseBrowser> {
  return launch(cfg, userAgent);
}

/** Maps a launch failure to a scan-level fatal (sandbox → sandbox-unavailable, missing browser → exit 2). */
export function classifyLaunchError(
  err: unknown,
  sandbox: SandboxMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): FatalSignal {
  const msg = errorText(err);
  if (/Executable doesn't exist|browserType\.launch.*install|please run the following command/i.test(msg)) {
    return {
      reason: 'browser-unavailable',
      code: 'browser-not-installed',
    };
  }
  if (
    sandbox === 'require' &&
    /sandbox|namespace|setuid|zygote|apparmor|clone\(|Operation not permitted|No usable sandbox/i.test(msg)
  ) {
    return {
      reason: 'sandbox-unavailable',
      code: 'sandbox-failed',
      // Inside the dsgvo-check image the text names the exact fix (seccomp profile export and docker run line).
      params: { container: env.DSGVO_CHECK_CONTAINER === '1' ? 'yes' : 'no' },
    };
  }
  return {
    reason: 'browser-unavailable',
    code: 'browser-launch-failed',
    params: { message: msg.split('\n')[0] ?? '' },
  };
}
