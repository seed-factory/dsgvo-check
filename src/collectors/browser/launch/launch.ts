// Chromium launch: Chrome for Testing in new headless, a fresh persistent profile per phase in a temp dir (removed
// afterwards), de-DE / Europe/Berlin, 1366×768, downloads and QUIC off, popup blocker on. The UA is the real Chrome UA
// (HeadlessChrome → Chrome) plus the scanner token.
import type { BrowserContext, BrowserType, LaunchOptions, Page } from 'playwright-core';
import type { SandboxMode } from '../../../core/report/schema.ts';
import { type Logger, silentLogger } from '../../../core/runtime/logger.ts';
import { ACCEPT_LANGUAGE } from '../../../core/runtime/user-agent.ts';
import type { FatalSignal } from '../../../core/snapshot/collector.ts';
import type { NetworkConfig } from '../../../core/url/net.ts';
import { BROWSER_CHANNEL, LOCALE, TIMEZONE, VIEWPORT } from '../config.ts';
import { errorText } from '../util.ts';
import { closeWithin, killBrowserProcesses, waitForProfileProcesses } from './processes.ts';
import { createProfile, exitHookLast, removeProfile } from './profile.ts';

/** `context.close()` gets this long before the browser processes are killed. */
export const CLOSE_BUDGET_MS = 3_000;

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
/** An upper bound: chrome://version is a local page. */
const VERSION_PAGE_TIMEOUT_MS = 10_000;

/** Playwright's message when the browser build is not downloaded. */
const BROWSER_NOT_INSTALLED =
  /Executable doesn't exist|browserType\.launch.*install|please run the following command/i;
/** Chromium's messages when its sandbox cannot start (user namespaces, setuid helper). */
const SANDBOX_UNAVAILABLE =
  /sandbox|namespace|setuid|zygote|apparmor|clone\(|Operation not permitted|No usable sandbox/i;

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

async function launch(cfg: LaunchConfig, userAgent: string | undefined): Promise<PhaseBrowser> {
  const dir = await createProfile();

  const closeBudgetMs = cfg.closeBudgetMs ?? CLOSE_BUDGET_MS;
  const context = await launchContext(cfg, userAgent, dir);
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

function chromiumArgs(network: NetworkConfig): string[] {
  const out = ['--disable-quic'];
  if (network.proxy) out.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  out.push(...(network.test?.browserArgs ?? []));
  return out;
}

/** A failed launch takes its browser processes and its profile with it. */
async function launchContext(
  cfg: LaunchConfig,
  userAgent: string | undefined,
  dir: string,
): Promise<BrowserContext> {
  const proxy = proxyOption(cfg.network.proxy);
  try {
    return await cfg.chromium.launchPersistentContext(dir, {
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
      args: chromiumArgs(cfg.network),
      // Keep Chrome's popup blocker (Playwright disables it); the SSRF guard covers the remaining popups.
      ignoreDefaultArgs: ['--disable-popup-blocking'],
      timeout: cfg.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
  } catch (err) {
    const log = cfg.log ?? silentLogger;
    const pids = await killBrowserProcesses(dir, { log });
    await waitForProfileProcesses(dir, pids, log);
    await removeProfile(dir, log);
    throw err;
  }
}

export function launchPhase(cfg: LaunchConfig, userAgent: string): Promise<PhaseBrowser> {
  return launch(cfg, userAgent);
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

    const commandLine = await chromeCommandLine(page);
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

/** The effective Chromium flags as chrome://version shows them; empty when the page cannot be read. */
async function chromeCommandLine(page: Page): Promise<string> {
  try {
    await page.goto('chrome://version', { timeout: VERSION_PAGE_TIMEOUT_MS });
    return await page.evaluate("String((document.querySelector('#command_line') || {}).textContent || '')");
  } catch {
    return '';
  }
}

/** Maps a launch failure to a scan-level fatal (sandbox → sandbox-unavailable, missing browser → exit 2). */
export function classifyLaunchError(
  err: unknown,
  sandbox: SandboxMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): FatalSignal {
  const msg = errorText(err);
  if (BROWSER_NOT_INSTALLED.test(msg)) {
    return {
      reason: 'browser-unavailable',
      code: 'browser-not-installed',
    };
  }
  if (sandbox === 'require' && SANDBOX_UNAVAILABLE.test(msg)) {
    return {
      reason: 'sandbox-unavailable',
      code: 'sandbox-failed',
      // Inside the dsgvo-check image the text points to the image's default mode instead of host remedies.
      params: { container: env.DSGVO_CHECK_CONTAINER === '1' ? 'yes' : 'no' },
    };
  }
  return {
    reason: 'browser-unavailable',
    code: 'browser-launch-failed',
    params: { message: msg.split('\n')[0] ?? '' },
  };
}
