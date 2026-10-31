/**
 * Chromium launch (D08, D10, D25): Chrome for Testing in new headless (`channel: 'chromium'`), a fresh persistent
 * profile in a temp dir per phase (removed afterwards), `chromiumSandbox` per `--sandbox`, de-DE / Europe/Berlin,
 * 1366×768, downloads off, QUIC off, popup blocker on. The UA is the real Chrome UA (HeadlessChrome → Chrome) plus
 * the D10 token.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType, LaunchOptions } from 'playwright-core';
import type { FatalSignal } from '../../core/collector.ts';
import { type Logger, silentLogger } from '../../core/logger.ts';
import type { NetworkConfig } from '../../core/net.ts';
import { ACCEPT_LANGUAGE } from '../../core/user-agent.ts';
import { BROWSER_CHANNEL, LOCALE, TIMEZONE, VIEWPORT } from './config.ts';
import { errorText } from './util.ts';

export interface LaunchConfig {
  chromium: BrowserType;
  sandbox: 'require' | 'off';
  network: NetworkConfig;
  executablePath?: string;
  /** Budget of `context.close()` before the browser is killed. Default `CLOSE_BUDGET_MS`. */
  closeBudgetMs?: number;
  /** Where a browser that could not be killed is reported (R14). Default: nowhere. */
  log?: Logger;
}

export interface EngineProbe {
  /** `navigator.userAgent` of the launched browser (may contain HeadlessChrome). */
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

/**
 * Temp profiles not yet removed. They hold real cookies and storage of the scanned site: a profile still alive when
 * the process exits (e.g. `process.exit` right after a timeout while `context.close()` hangs) is removed
 * synchronously by the exit hook (S-35, FC-10). A process that is killed (SIGKILL, crash) runs no hook: its profile
 * carries an owner marker, and the next scan removes profiles whose owner is gone (G57).
 */
const liveProfiles = new Set<string>();

export function liveProfileDirs(): string[] {
  return [...liveProfiles];
}

export const PROFILE_PREFIX = 'dsgvo-check-profile-';
/** File in the profile directory naming the owner process: `{ pid, startedAt, host }` (no site data). */
export const OWNER_MARKER = '.dsgvo-check-owner';
/** A profile without an owner marker (killed between `mkdtemp` and the marker) is removed once it is this old. */
export const UNMARKED_MAX_AGE_MS = 24 * 3_600_000;

export interface ProfileOwner {
  pid: number;
  /** Epoch ms when the owner process started. */
  startedAt: number;
  /** Host name of the owner: a pid says nothing about a process of another container or host sharing the temp dir. */
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

/** Is a process with this pid running? `EPERM` = running under another user. */
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
  /** Directory that holds the profiles. Default: the OS temp dir. */
  tmp?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
  maxUnmarkedAgeMs?: number;
  /** Host name of this process (default `os.hostname()`). */
  host?: string;
}

/**
 * Remove profile directories of processes that no longer run (killed or crashed before their exit hook): the owner
 * marker names a pid that is gone, or there is no marker and the directory is older than a day. Profiles of running
 * processes (parallel scans, tests) are never touched. Returns the names of the removed directories.
 */
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
    // An owner on another host (shared temp dir) cannot be probed by pid: it is judged by age like an unmarked profile.
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

/**
 * Profiles whose owner marker names `pid` on `host` (default: this host). A pid alone says nothing when several
 * containers share the temp dir: the same number can belong to a live scan of another one (S-robustness-2). A marker
 * without a host (older versions) is not claimed either, as it might be a foreign one; the stale sweep still judges it.
 */
export function profilesOfPid(pid: number, tmp: string = tmpdir(), host: string = hostname()): string[] {
  return profileDirsIn(tmp).filter((d) => {
    const owner = ownerOf(d);
    return owner?.pid === pid && owner.host === host;
  });
}

/** Remove the profiles of a process of this host that was killed from outside (the canary runner after SIGKILL). */
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
      // Not silent: the profile holds cookies of the scanned site. Only the directory name is printed.
      process.stderr.write(
        `dsgvo-check: temporary browser profile not removed: ${path.basename(dir)} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
      );
    }
    liveProfiles.delete(dir);
  }
}

/**
 * (Re-)register the exit hook as the LAST exit listener: Playwright adds its own handler (SIGKILL of the browser) when
 * it launches a process, and the profile must be removed after the browser is gone.
 */
function exitHookLast(): void {
  process.off('exit', removeLeftoverProfilesSync);
  process.on('exit', removeLeftoverProfilesSync);
}

function trackProfile(dir: string): void {
  exitHookLast();
  liveProfiles.add(dir);
}

async function removeProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  liveProfiles.delete(dir);
}

/** Budget of `context.close()`; a browser that does not close in time is killed (G51). */
export const CLOSE_BUDGET_MS = 3_000;

/**
 * Pids of the processes that run with `dir` as their profile: the exact argument `--user-data-dir=<dir>` in
 * `<procRoot>/<pid>/cmdline` (NUL-separated). The directory name is unique per launch, so nothing else matches.
 * This process is never in the list. `null` when there is no process table (macOS, BSD): "unknown", not "none".
 */
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

/** `pkill -f` on the profile argument: `killed`, `none` (nothing matched) or `unavailable` (no pkill, or it failed). */
function pkillProfile(dir: string): Promise<'killed' | 'none' | 'unavailable'> {
  const pattern = `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  return new Promise((resolve) => {
    execFile('pkill', ['-KILL', '-f', '--', pattern], { timeout: 2_000 }, (err) => {
      if (!err) resolve('killed');
      // Exit code 1: no process matched (the browser is gone already). ENOENT, a timeout or exit code 2/3: no verdict.
      else resolve(err.code === 1 ? 'none' : 'unavailable');
    });
  });
}

export interface KillOptions {
  /** Process table. Default `/proc`. */
  procRoot?: string;
  /** Kill one process. Default `SIGKILL`. */
  kill?: (pid: number) => void;
  log?: Logger;
}

/**
 * Kill the browser processes that use `dir` as their profile; used when `context.close()` does not return (G51). Node
 * does it itself through the process table (`/proc`, Linux): the runtime image has neither `pkill` nor `ps`. Without
 * a process table `pkill` is the way (POSIX). A browser that cannot be killed at all is reported (R14), without the
 * path of the profile.
 */
export async function killBrowserProcesses(dir: string, o: KillOptions = {}): Promise<void> {
  if (process.platform === 'win32') return;
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
    return;
  }
  if ((await pkillProfile(dir)) === 'unavailable') {
    log.warn('browser process of a phase did not close and could not be killed (no process table, no pkill)');
  }
}

/** `context.close()` with a budget: true when the browser closed, false when it had to be killed. */
async function closeWithin(context: BrowserContext, dir: string, ms: number, log?: Logger): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    context.close().then(
      () => true,
      () => true, // an error on close: the browser is gone or going
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) await killBrowserProcesses(dir, log ? { log } : {});
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
      serviceWorkers: 'allow',
      ...(proxy ? { proxy } : {}),
      args: args(cfg.network),
      // Keep Chrome's popup blocker (Playwright disables it): pages cannot open windows without a user gesture. The
      // SSRF guard covers the remaining popups (FP-01).
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      timeout: 60_000,
    });
  } catch (err) {
    await removeProfile(dir);
    throw err;
  }
  exitHookLast();
  // One cleanup per profile: every close() (abort handler, finally blocks) returns the same promise, so a later
  // caller really waits until the browser is closed and the profile is removed.
  let closing: Promise<void> | null = null;
  return {
    context,
    close: () => {
      closing ??= (async () => {
        await closeWithin(context, dir, closeBudgetMs, cfg.log);
        await removeProfile(dir);
      })();
      return closing;
    },
  };
}

/**
 * Launch once to learn the real UA, version and effective flags (chrome://version). Fails fast when the sandbox
 * or the browser is not available (→ `classifyLaunchError`).
 */
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

/** D25: inside the dsgvo-check image (`DSGVO_CHECK_CONTAINER=1`) the sandbox error prints the exact fix. */
const CONTAINER_SANDBOX_HINT =
  ' Im Docker-Image: Profil exportieren mit "docker run --rm <image> seccomp-profile > dsgvo-check-seccomp.json" ' +
  'und den Container so starten: "docker run --rm --cap-drop=ALL --security-opt no-new-privileges ' +
  '--security-opt seccomp=dsgvo-check-seccomp.json <image> <url>".';

/** Map a launch failure to a scan-level fatal (5.2: sandbox → sandbox-unavailable, missing browser → exit 2). */
export function classifyLaunchError(
  err: unknown,
  sandbox: 'require' | 'off',
  env: Readonly<Record<string, string | undefined>> = process.env,
): FatalSignal {
  const msg = errorText(err);
  if (/Executable doesn't exist|browserType\.launch.*install|please run the following command/i.test(msg)) {
    return {
      reason: 'browser-unavailable',
      code: 'browser-not-installed',
      message: 'Chromium ist nicht installiert. Bitte "dsgvo-check install" ausführen.',
    };
  }
  if (
    sandbox === 'require' &&
    /sandbox|namespace|setuid|zygote|apparmor|clone\(|Operation not permitted|No usable sandbox/i.test(msg)
  ) {
    return {
      reason: 'sandbox-unavailable',
      code: 'sandbox-failed',
      message:
        'Die Chromium-Sandbox konnte nicht gestartet werden (z. B. AppArmor-Einschränkung für User Namespaces oder ' +
        'Docker ohne Seccomp-Profil). Möglichkeiten: das Docker-Image mit dem mitgelieferten Seccomp-Profil ' +
        'verwenden, die Systemeinstellung selbst anpassen oder ausdrücklich --sandbox off setzen.' +
        (env.DSGVO_CHECK_CONTAINER === '1' ? CONTAINER_SANDBOX_HINT : ''),
    };
  }
  return {
    reason: 'browser-unavailable',
    code: 'browser-launch-failed',
    message: `Chromium konnte nicht gestartet werden: ${msg.split('\n')[0]}`,
  };
}
