/**
 * The runner records the CA setting and removes browser profiles left by child scans that must be killed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaSetting } from '../../../scripts/canary/results.ts';
import { runCanary } from '../../../scripts/canary/runner.ts';
import {
  caSetting,
  cliScanner,
  KILL_GRACE_MS,
  type SiteJob,
  type SiteScanner,
} from '../../../scripts/canary/scanners.ts';
import { parseSites } from '../../../scripts/canary/sites.ts';
import { OWNER_MARKER, PROFILE_PREFIX } from '../../../src/collectors/browser/launch/profile.ts';

afterEach(() => vi.unstubAllEnvs());

const sites = () =>
  parseSites(
    JSON.stringify({
      version: 1,
      sites: [
        {
          id: 'de-s0',
          url: 'https://www.s0.example/',
          region: 'de',
          country: 'DE',
          sector: 'media',
          sizeClass: 'medium',
          expectedCmp: 'unknown',
          selectionReason: 'Branchenmix',
          publicReference: null,
        },
      ],
    }),
    { expectedCount: null },
  );

describe('run.json records the CA setting of the scanning process', () => {
  it('api engine: command-line flag, NODE_OPTIONS and NODE_USE_SYSTEM_CA all count', () => {
    expect(caSetting('api', {}, [])).toEqual<CaSetting>({
      trustStore: 'node-bundled',
      nodeUseSystemCa: null,
      useSystemCaFlag: false,
      extraCaCerts: false,
    });
    expect(caSetting('api', {}, ['--use-system-ca'])).toMatchObject({
      trustStore: 'system',
      useSystemCaFlag: true,
    });
    expect(caSetting('api', { NODE_USE_SYSTEM_CA: '1' }, [])).toMatchObject({
      trustStore: 'system',
      nodeUseSystemCa: '1',
    });
    expect(caSetting('api', { NODE_OPTIONS: '--use-system-ca' }, [])).toMatchObject({ trustStore: 'system' });
  });

  it('the flag is the effective one, read the way Node reads it (last wins, quotes, command line over NODE_OPTIONS)', () => {
    const flag = (env: Record<string, string>, argv: string[]) => caSetting('api', env, argv).useSystemCaFlag;

    // cancelled by a later --no-use-system-ca
    expect(flag({}, ['--use-system-ca', '--no-use-system-ca'])).toBe(false);
    expect(flag({ NODE_OPTIONS: '--use-system-ca --no-use-system-ca' }, [])).toBe(false);
    expect(flag({ NODE_OPTIONS: '--use-system-ca' }, ['--no-use-system-ca'])).toBe(false);

    // quoted in NODE_OPTIONS, underscores, a value
    expect(flag({ NODE_OPTIONS: '"--use-system-ca"' }, [])).toBe(true);
    expect(flag({ NODE_OPTIONS: '--use_system_ca' }, [])).toBe(true);
    expect(flag({ NODE_OPTIONS: '--no-use-system-ca' }, ['--use-system-ca'])).toBe(true);

    // the flag and the verdict agree
    for (const [env, argv] of [
      [{ NODE_OPTIONS: '"--use-system-ca"' }, []],
      [{}, ['--use-system-ca', '--no-use-system-ca']],
      [{ NODE_OPTIONS: '--use-system-ca' }, ['--no-use-system-ca']],
    ] as const) {
      const c = caSetting('api', { ...env }, [...argv]);
      expect(c.trustStore === 'system').toBe(c.useSystemCaFlag);
    }
  });

  it("the flag is not the environment variable and not OpenSSL's own store", () => {
    expect(caSetting('api', { NODE_USE_SYSTEM_CA: '1' }, [])).toMatchObject({
      trustStore: 'system',
      useSystemCaFlag: false,
    });
    expect(caSetting('api', {}, ['--use-openssl-ca'])).toMatchObject({
      trustStore: 'system',
      useSystemCaFlag: false,
    });
    expect(caSetting('api', { NODE_USE_SYSTEM_CA: '1' }, ['--no-use-system-ca'])).toMatchObject({
      trustStore: 'node-bundled',
      useSystemCaFlag: false,
    });
  });

  it('cli engine: the child inherits the environment, not the command-line flags of the runner', () => {
    expect(caSetting('cli', {}, ['--use-system-ca'])).toMatchObject({ trustStore: 'node-bundled' });
    expect(caSetting('cli', { NODE_USE_SYSTEM_CA: '1' }, [])).toMatchObject({ trustStore: 'system' });
  });

  it('the path of NODE_EXTRA_CA_CERTS is never recorded, only that it is set', () => {
    const c = caSetting('api', { NODE_EXTRA_CA_CERTS: '/home/someone/ca.pem' }, []);

    expect(c.extraCaCerts).toBe(true);
    expect(JSON.stringify(c)).not.toContain('someone');
  });

  it('runCanary writes it into run.json', async () => {
    vi.stubEnv('NODE_USE_SYSTEM_CA', '1');
    const dir = mkdtempSync(path.join(tmpdir(), 'canary-ca-'));
    const scanner: SiteScanner = async (job: SiteJob) => {
      writeFileSync(job.reportPath, '{}');
      return { exitCode: 0 };
    };

    await runCanary(
      {
        sites: sites(),
        resultsDir: dir,
        runId: 'run-ca',
        concurrency: 1,
        pauseMs: 0,
        timeoutMs: 1000,
        watchdogReserveMs: 1000,
        retryErrors: false,
        engine: 'api',
        sitesFile: null,
      },
      { scanner, sleep: async () => {}, log: () => {} },
    );

    const run = JSON.parse(readFileSync(path.join(dir, 'run-ca', 'run.json'), 'utf8')) as { ca?: CaSetting };
    expect(run.ca).toMatchObject({ trustStore: 'system', nodeUseSystemCa: '1' });
  });
});

describe('a child scan that is killed leaves no profile behind', () => {
  it('the pause between SIGTERM and SIGKILL is long enough for an orderly exit', () => {
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(30_000);
  });

  /** Source of the "CLI" stub: it creates the profiles with owner markers, ignores SIGTERM and waits. */
  const stubSource = (profiles: Array<{ name: string; host: string | null }>) =>
    `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostname, tmpdir } from 'node:os';
for (const p of ${JSON.stringify(profiles)}) {
  const dir = path.join(tmpdir(), ${JSON.stringify(PROFILE_PREFIX)} + p.name);
  mkdirSync(path.join(dir, 'Default'), { recursive: true });
  writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
  writeFileSync(path.join(dir, ${JSON.stringify(OWNER_MARKER)}), JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: p.host ?? hostname() }));
}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

  async function waitForOwnerMarkers(dirs: string[]) {
    const t0 = Date.now();
    while (!dirs.every((d) => existsSync(path.join(d, OWNER_MARKER)))) {
      if (Date.now() - t0 > 10_000) throw new Error('stub did not start');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Runs the "CLI" stub through the runner and kills it. The stub creates temp profiles with an owner marker like
   * `profile.ts` does (`{ pid, startedAt, host }`; `host: null` = the host of the stub), then ignores SIGTERM and waits.
   */
  async function killedStub(profiles: Array<{ name: string; host: string | null }>) {
    const root = mkdtempSync(path.join(tmpdir(), 'canary-kill-'));
    const tmpRoot = path.join(root, 'tmp');
    mkdirSync(tmpRoot);
    vi.stubEnv('TMPDIR', tmpRoot);
    const stub = path.join(root, 'stub-cli.mjs');
    writeFileSync(stub, stubSource(profiles));
    const dirs = profiles.map((p) => path.join(tmpRoot, `${PROFILE_PREFIX}${p.name}`));

    const jobDir = path.join(root, 'job');
    mkdirSync(jobDir);
    const job: SiteJob = {
      site: sites()[0] as never,
      mode: 'scan',
      dir: jobDir,
      reportPath: path.join(jobDir, 'report.json'),
      snapshotPath: path.join(jobDir, 'snapshot.json'),
      logPath: path.join(jobDir, 'scan.log'),
      timeoutMs: 1000,
    };
    const scanner = cliScanner({
      sandbox: 'off',
      screenshots: false,
      assumeRegion: null,
      cliPath: stub,
      killGraceMs: 300,
    });

    const ac = new AbortController();
    const done = scanner(job, ac.signal);
    await waitForOwnerMarkers(dirs);
    ac.abort();

    return { res: await done, dirs };
  }

  it('SIGTERM ignored → SIGKILL after the grace → the profile naming the child as owner is removed', async () => {
    const { res, dirs } = await killedStub([{ name: 'stub', host: null }]);

    expect(res.exitCode).toBeNull();
    // The hard kill ran no handler and no exit hook; the runner removed what the child left.
    expect(existsSync(dirs[0] as string)).toBe(false);
  }, 30_000);

  it('a profile of the same pid from another container in the shared temp dir stays', async () => {
    const { res, dirs } = await killedStub([
      { name: 'stub-own', host: null },
      { name: 'stub-foreign', host: 'other-container' },
    ]);

    expect(res.exitCode).toBeNull();
    expect(existsSync(dirs[0] as string)).toBe(false);
    expect(existsSync(dirs[1] as string)).toBe(true);
  }, 30_000);
});
