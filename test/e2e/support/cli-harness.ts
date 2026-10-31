/**
 * L3 harness: builds dist/, starts the fixture server (test/fixture-server) with the e2e sites plus a fake DNS
 * server, and runs `node dist/cli.js` as a subprocess whose network is routed to them by `network-hook.ts`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report } from '../../../src/core/report-schema.ts';
import { type FixtureServer, type RouteSpec, startFixtureServer } from '../../fixture-server/server.ts';
import { REPO_ROOT } from '../../utils/snapshot-builder.ts';
import { type FakeDnsServer, startFakeDns } from './dns-server.ts';
import type { E2eNetworkConfig } from './network-hook.ts';

/** Built CLI; `DSGVO_E2E_CLI` points to another build (e.g. an installed package) and skips the build step. */
export const CLI = process.env.DSGVO_E2E_CLI ?? path.join(REPO_ROOT, 'dist/cli.js');
const HOOK = fileURLToPath(new URL('./network-hook.ts', import.meta.url));
const SITES = fileURLToPath(new URL('../sites/', import.meta.url));

/** Marker contained in every cookie and storage value the fixture sites set; it must never reach a report. */
export const SECRET_MARKER = 'E2ESECRET';

/** `DSGVO_E2E_STRICT=1` (CI): a pipeline that is not fully implemented is a failure, not a skip. */
export const STRICT = process.env.DSGVO_E2E_STRICT === '1';

/** Build dist/ (unless DSGVO_E2E_SKIP_BUILD=1 and it exists). Type errors fail `pnpm typecheck`, not this step. */
export function ensureBuilt(): void {
  if ((process.env.DSGVO_E2E_SKIP_BUILD === '1' || process.env.DSGVO_E2E_CLI) && existsSync(CLI)) return;
  const tsc = path.join(REPO_ROOT, 'node_modules/.bin/tsc');
  const r = spawnSync(tsc, ['-p', 'tsconfig.build.json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    if (!existsSync(CLI)) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
    console.warn(`e2e: tsc reported errors, testing the emitted dist/ anyway:\n${r.stdout.slice(0, 2000)}`);
  }
}

const redirectAll = (host: string, scheme: 'http' | 'https', location: string): RouteSpec => ({
  host,
  scheme,
  path: '.*',
  pathRegex: true,
  status: 301,
  headers: { location },
});

export interface E2eEnvironment {
  server: FixtureServer;
  dns: FakeDnsServer;
  network: E2eNetworkConfig;
  close(): Promise<void>;
}

/** Fixture sites: www.clean-shop.test (no third parties) and www.tracker-shop.test (analytics before consent). */
export async function startE2eEnvironment(): Promise<E2eEnvironment> {
  const hosts: Record<string, string> = {
    'www.clean-shop.test': path.join(SITES, 'clean/www'),
    'www.tracker-shop.test': path.join(SITES, 'tracker/www'),
    'www.google-analytics.com': path.join(SITES, 'tracker/ga'),
  };
  const routes: RouteSpec[] = [];
  for (const domain of ['clean-shop.test', 'tracker-shop.test']) {
    // http → https on the same host first, then apex → www (TLS-01: first hop stays on the host).
    const home = `https://www.${domain}/`;
    routes.push(redirectAll(domain, 'http', `https://${domain}/`), redirectAll(domain, 'https', home));
    routes.push(redirectAll(`www.${domain}`, 'http', home));
  }
  routes.push({ host: 'www.google-analytics.com', path: '/g/collect', status: 204 });
  const server = await startFixtureServer({ hosts, routes });

  const mail = (domain: string) => ({
    [`_dmarc.${domain}`]: [`v=DMARC1; p=reject; rua=mailto:dmarc@${domain}`],
    [domain]: ['v=spf1 -all'],
  });
  const dns = await startFakeDns({
    txt: { ...mail('clean-shop.test'), ...mail('tracker-shop.test') },
    mx: { 'clean-shop.test': [[0, '.']], 'tracker-shop.test': [[0, '.']] },
    names: ['www.clean-shop.test', 'www.tracker-shop.test', 'www.google-analytics.com'],
  });
  const network: E2eNetworkConfig = {
    httpPort: server.httpPort,
    httpsPort: server.httpsPort,
    hosts: [...Object.keys(hosts), 'clean-shop.test', 'tracker-shop.test'],
    browserArgs: server.browserArgs(),
    caPem: [server.pki.caPem],
    dnsServers: [dns.address],
  };
  return {
    server,
    dns,
    network,
    close: async () => {
      await server.close();
      await dns.close();
    },
  };
}

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outDir: string;
  json: Report | null;
  html: string | null;
  summary: string | null;
  /** All text output: stdout, stderr and every text file in outDir. */
  allText: string;
}

function readIf(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Run the built CLI asynchronously (the fixture server lives in this process, so spawnSync would deadlock).
 * The child gets a minimal environment: no GITHUB_STEP_SUMMARY unless `stepSummary` is given.
 */
export function runCli(
  env: E2eEnvironment | null,
  args: string[],
  opts: { stepSummary?: string; timeoutMs?: number } = {},
): Promise<CliRun> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-out-'));
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    TZ: 'Europe/Berlin',
    LANG: 'de_DE.UTF-8',
    NO_COLOR: '1',
  };
  if (env) childEnv.DSGVO_E2E_NETWORK = JSON.stringify(env.network);
  if (opts.stepSummary) childEnv.GITHUB_STEP_SUMMARY = opts.stepSummary;
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];

  const nodeArgs = env ? ['--import', HOOK, CLI] : [CLI];
  const child = spawn(process.execPath, [...nodeArgs, ...args, '--out', outDir], {
    cwd: outDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 280_000);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const jsonText = readIf(path.join(outDir, 'report.json'));
      const html = readIf(path.join(outDir, 'report.html'));
      const summary = readIf(path.join(outDir, 'summary.md'));
      const texts = [stdout, stderr];
      for (const f of readdirSync(outDir, { recursive: true }) as string[]) {
        if (/\.(json|html|md|txt|log)$/.test(f)) texts.push(readFileSync(path.join(outDir, f), 'utf8'));
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        outDir,
        json: jsonText ? (JSON.parse(jsonText) as Report) : null,
        html,
        summary,
        allText: texts.join('\n'),
      });
    });
  });
}

/** True when the browser collector and the browser checks are implemented (not the scaffold stubs). */
export function pipelineGaps(report: Report, requiredChecks: readonly string[]): string[] {
  const gaps: string[] = [];
  const browser = report.scan.coverage?.collectors.browser;
  if (!browser) gaps.push('browser collector did not run');
  else if (browser.status === 'skipped' && browser.reason === 'not-implemented') {
    gaps.push('browser collector is the scaffold stub (not-implemented)');
  }
  const ids = new Set((report.checks ?? []).map((c) => c.id));
  for (const id of requiredChecks) if (!ids.has(id)) gaps.push(`check ${id} is not registered`);
  return gaps;
}
