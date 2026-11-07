/** Site scanners of the canary runner: in-process via the programmatic API, or one CLI child process per site. */
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { removeProfilesOfPid } from '../../src/collectors/browser/launch/profile.ts';
import type { AssumeRegion, Lang, SandboxMode } from '../../src/core/report/schema.ts';
import type { Logger } from '../../src/core/runtime/logger.ts';
import { detectTrustStore, useSystemCaOption } from '../../src/core/snapshot/index.ts';
import { writeReports } from '../../src/reporters/write.ts';
import { scan } from '../../src/scan.ts';
import type { ScanOptions } from '../../src/scan-options.ts';
import type { CaSetting, Engine, ExitCode, ScanStatus, SiteRef } from './results.ts';

/** Time between SIGTERM and SIGKILL of a child scan: SIGTERM lets the CLI close its browser and remove the temp profile, SIGKILL cannot be handled. */
export const KILL_GRACE_MS = 30_000;

export interface SiteJob {
  site: SiteRef;
  mode: 'scan' | 'reanalyze';
  dir: string;
  reportPath: string;
  /** Scan: where to save the snapshot. Reanalyze: the snapshot to replay. */
  snapshotPath: string;
  logPath: string;
  timeoutMs: number;
}

export interface SiteScanResult {
  exitCode: ExitCode | null;
  scanStatus?: ScanStatus;
}

export type SiteScanner = (job: SiteJob, signal: AbortSignal) => Promise<SiteScanResult>;

export interface ScannerOptions {
  sandbox: SandboxMode;
  screenshots: boolean;
  assumeRegion: AssumeRegion | null;
  lang?: Lang;
  /** Pause between SIGTERM and SIGKILL of a child scan (default `KILL_GRACE_MS`). */
  killGraceMs?: number;
}

/** The CA setting the scans of this run see; a child scan inherits the runner's environment but not its command-line flags. */
export function caSetting(
  engine: Engine,
  env: Readonly<Record<string, string | undefined>> = process.env,
  execArgv: readonly string[] = process.execArgv,
): CaSetting {
  const argv = engine === 'cli' ? [] : execArgv;
  return {
    trustStore: detectTrustStore(env, argv),
    nodeUseSystemCa: env.NODE_USE_SYSTEM_CA ?? null,
    useSystemCaFlag: useSystemCaOption(env, argv),
    extraCaCerts: Boolean(env.NODE_EXTRA_CA_CERTS),
  };
}

/** Logger that buffers lines for `scan.log` (keeps parallel scans from interleaving on stderr). */
function bufferLogger(lines: string[]): Logger {
  const at = (level: string) => (msg: string) => {
    lines.push(`${new Date().toISOString()} ${level}: ${msg}`);
  };
  return { debug: () => {}, info: at('info'), warn: at('warn'), error: at('error') };
}

/** In-process scanner via the programmatic API; `scanOverrides` exist for offline tests. The runner watchdog is a last resort behind scan()'s own deadline. */
export function apiScanner(o: ScannerOptions & { scanOverrides?: Partial<ScanOptions> }): SiteScanner {
  const lang = o.lang ?? 'de';
  return async (job) => {
    const lines: string[] = [];
    try {
      const target: Partial<ScanOptions> =
        job.mode === 'scan'
          ? { url: job.site.url, saveSnapshot: job.snapshotPath }
          : { fromSnapshot: job.snapshotPath };

      const result = await scan({
        ...target,
        failOn: 'none',
        formats: ['json'],
        outDir: job.dir,
        timeoutMs: job.timeoutMs,
        lang,
        sandbox: o.sandbox,
        screenshots: o.screenshots,
        assumeRegion: o.assumeRegion,
        log: bufferLogger(lines),
        ...o.scanOverrides,
      });

      const written = await writeReports(result, { outDir: job.dir, formats: ['json'], lang });
      return { exitCode: written.exitCode, scanStatus: result.report.scan.status };
    } finally {
      if (lines.length > 0) await writeFile(job.logPath, `${lines.join('\n')}\n`);
    }
  };
}

/** CLI arguments for one site: a live scan of its URL, or a replay of the saved snapshot. */
function cliArgs(job: SiteJob, o: ScannerOptions, lang: Lang): string[] {
  const common = ['--fail-on', 'none', '--format', 'json', '--out', job.dir, '--lang', lang];
  if (job.mode !== 'scan') return ['--from-snapshot', job.snapshotPath, ...common];

  return [
    job.site.url,
    ...common,
    '--timeout',
    `${job.timeoutMs}ms`,
    '--sandbox',
    o.sandbox,
    '--save-snapshot',
    job.snapshotPath,
    ...(o.screenshots ? [] : ['--no-screenshots']),
    ...(o.assumeRegion ? ['--assume-region', o.assumeRegion] : []),
  ];
}

/** SIGTERM first so the CLI can clean up; SIGKILL when the child is still running after the grace period. */
function terminateChild(child: ChildProcess, graceMs: number): void {
  child.kill('SIGTERM');
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  hard.unref();
  child.once('close', () => clearTimeout(hard));
}

/** Scanner that runs the CLI in a child process per site (isolation; killed by the watchdog). */
export function cliScanner(o: ScannerOptions & { cliPath: string }): SiteScanner {
  const lang = o.lang ?? 'de';
  return (job, signal) =>
    new Promise((resolve, reject) => {
      const out = createWriteStream(job.logPath);
      const child = spawn(process.execPath, [o.cliPath, ...cliArgs(job, o, lang)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });

      const kill = () => terminateChild(child, o.killGraceMs ?? KILL_GRACE_MS);
      signal.addEventListener('abort', kill, { once: true });

      child.on('error', (err) => {
        signal.removeEventListener('abort', kill);
        out.end();
        reject(err);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        out.end();
        // A child that was killed ran no exit hook: its temp browser profile (cookies of the site) is still there.
        if (child.pid !== undefined) removeProfilesOfPid(child.pid);
        resolve({ exitCode: code === 0 || code === 1 || code === 2 ? code : null });
      });
    });
}
