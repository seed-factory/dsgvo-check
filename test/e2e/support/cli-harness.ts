/**
 * Builds dist/, starts the fixture server and a fake DNS for the e2e sites and runs `node dist/cli.js` as a
 * subprocess whose network `network-hook.ts` routes to them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../../../src/core/report/schema.ts';
import { type FixtureServer, type RouteSpec, startFixtureServer } from '../../fixture-server/server.ts';
import { type FakeDnsServer, type FakeZone, startFakeDns } from '../../integration/dns/dns-server.ts';
import { REPO_ROOT } from '../../utils/snapshot-builder.ts';
import type { E2eNetworkConfig } from './network-hook.ts';

/** Built CLI; `DSGVO_E2E_CLI` points to another build (e.g. an installed package) and skips the build step. */
export const CLI = process.env.DSGVO_E2E_CLI ?? path.join(REPO_ROOT, 'dist/cli.js');
const HOOK = fileURLToPath(new URL('./network-hook.ts', import.meta.url));
const SITES = fileURLToPath(new URL('../sites/', import.meta.url));

/** A hung CLI is killed shortly before the e2e test timeout (300 s), so the test fails with its output instead of timing out blind. */
const DEFAULT_CLI_TIMEOUT_MS = 280_000;

/** Marker contained in every cookie and storage value the fixture sites set; it must never reach a report. */
export const SECRET_MARKER = 'E2ESECRET';

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

const SHOP_DOMAINS = ['clean-shop.test', 'tracker-shop.test'];
const ANALYTICS_HOST = 'www.google-analytics.com';

/** Site directory per host name the fixture server answers for. */
const FIXTURE_HOSTS: Record<string, string> = {
  'www.clean-shop.test': path.join(SITES, 'clean/www'),
  'www.tracker-shop.test': path.join(SITES, 'tracker/www'),
  [ANALYTICS_HOST]: path.join(SITES, 'tracker/ga'),
};

function fixtureRoutes(): RouteSpec[] {
  const routes: RouteSpec[] = [];
  for (const domain of SHOP_DOMAINS) {
    // http → https on the same host first, then apex → www (TLS-01: first hop stays on the host).
    const home = `https://www.${domain}/`;
    routes.push(redirectAll(domain, 'http', `https://${domain}/`), redirectAll(domain, 'https', home));
    routes.push(redirectAll(`www.${domain}`, 'http', home));
  }
  routes.push({ host: ANALYTICS_HOST, path: '/g/collect', status: 204 });
  // The tracker start page also sets a session cookie over HTTP, so the leak checks cover a Set-Cookie value, not
  // only the values analytics.js writes in the page.
  routes.push({
    host: 'www.tracker-shop.test',
    scheme: 'https',
    path: '/',
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `shop_session=${SECRET_MARKER}-SESSION-4711; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
    body: readFileSync(path.join(SITES, 'tracker/www/index.html'), 'utf8'),
  });
  return routes;
}

/**
 * Mail records the DNS checks read: the fixture domains neither send nor accept mail (SPF -all, DMARC reject, null MX).
 * The site names resolve to loopback, where the fixture server listens; every other name is NXDOMAIN.
 */
function startFixtureDns(): Promise<FakeDnsServer> {
  const mail = (domain: string): FakeZone => ({
    [`TXT _dmarc.${domain}`]: [`v=DMARC1; p=reject; rua=mailto:dmarc@${domain}`],
    [`TXT ${domain}`]: ['v=spf1 -all'],
    [`MX ${domain}`]: ['0 .'],
    [`A ${domain}`]: ['127.0.0.1'],
    [`A www.${domain}`]: ['127.0.0.1'],
  });
  return startFakeDns({
    ...mail('clean-shop.test'),
    ...mail('tracker-shop.test'),
    [`A ${ANALYTICS_HOST}`]: ['127.0.0.1'],
  });
}

/** Fixture sites: www.clean-shop.test (no third parties) and www.tracker-shop.test (analytics before consent). */
export async function startE2eEnvironment(): Promise<E2eEnvironment> {
  const server = await startFixtureServer({ hosts: FIXTURE_HOSTS, routes: fixtureRoutes() });
  const dns = await startFixtureDns();

  const network: E2eNetworkConfig = {
    httpPort: server.httpPort,
    httpsPort: server.httpsPort,
    hosts: [...Object.keys(FIXTURE_HOSTS), ...SHOP_DOMAINS],
    browserArgs: server.browserArgs(),
    caPem: [server.pki.caPem],
    dnsServers: [dns.server],
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

/** Minimal child environment, so a result never depends on the developer's shell or CI variables. */
function childEnvironment(
  env: E2eEnvironment | null,
  opts: { stepSummary?: string; env?: Record<string, string> },
): NodeJS.ProcessEnv {
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
  Object.assign(childEnv, opts.env);

  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  return childEnv;
}

/** The report files a finished run left in `outDir`, and all text output joined for leak checks. */
function collectRun(outcome: Pick<CliRun, 'code' | 'signal' | 'stdout' | 'stderr'>, outDir: string): CliRun {
  const jsonText = readIf(path.join(outDir, 'report.json'));
  const texts = [outcome.stdout, outcome.stderr];
  for (const f of readdirSync(outDir, { recursive: true }) as string[]) {
    if (/\.(json|html|md|txt|log)$/.test(f)) texts.push(readFileSync(path.join(outDir, f), 'utf8'));
  }

  return {
    ...outcome,
    outDir,
    json: jsonText ? (JSON.parse(jsonText) as Report) : null,
    html: readIf(path.join(outDir, 'report.html')),
    summary: readIf(path.join(outDir, 'summary.md')),
    allText: texts.join('\n'),
  };
}

/**
 * Run the built CLI asynchronously (the fixture server lives in this process, so spawnSync would deadlock).
 * The child gets a minimal environment: no GITHUB_STEP_SUMMARY unless `stepSummary` is given; `env` adds variables and
 * `dotenv` becomes the `.env` file of its working directory (the output directory).
 */
export function runCli(
  env: E2eEnvironment | null,
  args: string[],
  opts: { stepSummary?: string; timeoutMs?: number; env?: Record<string, string>; dotenv?: string } = {},
): Promise<CliRun> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-out-'));
  if (opts.dotenv !== undefined) writeFileSync(path.join(outDir, '.env'), opts.dotenv);

  const nodeArgs = env ? ['--import', pathToFileURL(HOOK).href, CLI] : [CLI];
  const child = spawn(process.execPath, [...nodeArgs, ...args, '--out', outDir], {
    cwd: outDir,
    env: childEnvironment(env, opts),
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
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(collectRun({ code, signal, stdout, stderr }, outDir));
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
