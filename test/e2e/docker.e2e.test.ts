/**
 * Container isolation and the Action's scan step, with every exit code (0/1/2). Opt-in: set
 * DSGVO_E2E_IMAGE to a built image, e.g.
 *   docker build -t dsgvo-check:dev . && DSGVO_E2E_IMAGE=dsgvo-check:dev corepack pnpm vitest run --project e2e test/e2e/docker.e2e.test.ts
 * Containers run with the hardened flags of action.yml and `--network none`. Exit codes 0 and 1 come from a saved
 * snapshot (`--from-snapshot`, no network) of a site that loads Google Analytics before consent; exit code 2 from
 * an unresolvable host and, in the Action test, from a loopback address that the scanner refuses.
 * The Action script needs bash 4+; DSGVO_E2E_ACTION_PATH can provide a suitable PATH outside Linux.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Report } from '../../src/core/report-schema.ts';
import { type Snapshot, toSavedSnapshot } from '../../src/core/snapshot.ts';
import { htmlSafetyProblems } from '../unit/reporters/html-safety.ts';
import { expectValidReport } from '../utils/report-validator.ts';
import { makeSnapshot, REPO_ROOT, SNAPSHOT_FIXTURES_DIR } from '../utils/snapshot-builder.ts';

const IMAGE = process.env.DSGVO_E2E_IMAGE;
const PROFILE = path.join(REPO_ROOT, 'docker/seccomp-chromium.json');
const ACTION_PATH =
  process.env.DSGVO_E2E_ACTION_PATH ?? (process.platform === 'linux' ? process.env.PATH : undefined);

function hardened(extra: string[] = [], opts: { seccomp?: boolean } = {}): string[] {
  const { uid, gid } = userInfo();
  return [
    'run',
    '--rm',
    '--user',
    `${uid}:${gid}`,
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    ...(opts.seccomp === false ? [] : ['--security-opt', `seccomp=${PROFILE}`]),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m',
    '--shm-size=256m',
    '--memory=2g',
    '--pids-limit=1024',
    '--network',
    'none',
    '--env',
    'HOME=/tmp',
    '--env',
    'NO_COLOR=1',
    ...extra,
  ];
}

function docker(args: string[], timeout = 180_000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

/** Saved snapshot (JSON) of a site that sends a Google Analytics hit before any consent (CONSENT-01 finding). */
function trackerSnapshot(): string {
  const fixture = JSON.parse(
    readFileSync(path.join(SNAPSHOT_FIXTURES_DIR, 'browser/CONSENT-01/violation-ga4-hit.json'), 'utf8'),
  ) as Record<string, unknown>;
  const sections = Object.fromEntries(Object.entries(fixture).filter(([k]) => !k.startsWith('$')));
  return JSON.stringify(toSavedSnapshot(makeSnapshot(sections as Partial<Snapshot>)));
}

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const SANDBOX_PROBE = `
const { chromium } = await import('/app/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
const page = await browser.newPage();
await page.goto('chrome://sandbox');
const text = await page.innerText('body');
await browser.close();
process.stdout.write(JSON.stringify({ text }));
`;

describe.skipIf(!IMAGE)('docker image', () => {
  const image = IMAGE as string;

  it('prints the help (exit 0) and runs as a non-root user', () => {
    const help = docker(['run', '--rm', image, '--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--fail-on <level>');
    const id = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']);
    expect(id.stdout.trim()).not.toBe('0');
  });

  it('labels the image with the version the CLI reports, the one of package.json', () => {
    const version = docker(['run', '--rm', image, '--version']);
    expect(version.status, version.stderr).toBe(0);
    const label = docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
      image,
    ]);
    expect(label.stdout.trim()).toBe(version.stdout.trim());
    expect(version.stdout.trim()).toBe(PACKAGE_VERSION);
  });

  it('ships the seccomp profile of this repository', () => {
    const r = docker(['run', '--rm', image, 'seccomp-profile']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(readFileSync(PROFILE, 'utf8')));
  });

  it('unreachable target with the hardened flags → exit 2, valid failed report, safe HTML', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-docker-'));
    const r = docker([
      ...hardened(['--volume', `${out}:/out`]),
      image,
      'https://does-not-exist.invalid/',
      '--out',
      '/out',
      '--format',
      'console,json,html,summary',
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as Report;
    expectValidReport(report);
    expect(report.scan.status).toBe('failed');
    expect(report.summary.exitReasons).toContain('unreachable');
    expect(htmlSafetyProblems(readFileSync(path.join(out, 'report.html'), 'utf8'))).toEqual([]);
    expect(readFileSync(path.join(out, 'summary.md'), 'utf8')).toMatch(/^## dsgvo-check/);
  });

  function scanSnapshot(failOn: string) {
    const input = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-snapshot-'));
    writeFileSync(path.join(input, 'snapshot.json'), trackerSnapshot());
    const out = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-docker-'));
    const r = docker([
      ...hardened(['--volume', `${out}:/out`, '--volume', `${input}:/in:ro`]),
      image,
      'https://www.example.de/',
      '--from-snapshot',
      '/in/snapshot.json',
      '--fail-on',
      failOn,
      '--out',
      '/out',
      '--format',
      'console,json,html,summary',
    ]);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as Report;
    expectValidReport(report);
    expect(report.summary.exitCode).toBe(r.status);
    expect(htmlSafetyProblems(readFileSync(path.join(out, 'report.html'), 'utf8'))).toEqual([]);
    expect(readFileSync(path.join(out, 'summary.md'), 'utf8')).toMatch(/^## dsgvo-check/);
    return { r, report };
  }

  it('finding at or above --fail-on with the hardened flags → exit 1 (threshold)', () => {
    const { r, report } = scanSnapshot('warning');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(report.scan.status).not.toBe('failed');
    expect(report.summary.exitReasons).toContain('threshold');
    expect(report.findings?.some((f) => f.checkId === 'CONSENT-01' && f.severity !== 'info')).toBe(true);
  });

  it('the same findings with --fail-on none → exit 0', () => {
    const { r, report } = scanSnapshot('none');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(report.summary.exitReasons).toEqual([]);
    expect(report.findings?.some((f) => f.checkId === 'CONSENT-01')).toBe(true);
  });

  it('starts Chromium with its sandbox under the seccomp profile, without any capability', () => {
    const r = docker(
      [...hardened(['--entrypoint', 'node']), image, '--input-type=module', '-e', SANDBOX_PROBE],
      240_000,
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const { text } = JSON.parse(r.stdout) as { text: string };
    expect(text).toMatch(/Layer 1 Sandbox\s+Namespace/);
    expect(text).toMatch(/PID namespaces\s+Yes/);
    expect(text).toMatch(/Seccomp-BPF sandbox\s+Yes/);
    expect(text).toMatch(/adequately sandboxed/);
  });

  it('without the profile (Docker default seccomp) the Chromium sandbox does not start', () => {
    const args = hardened(['--entrypoint', 'node'], { seccomp: false });
    const r = docker([...args, image, '--input-type=module', '-e', SANDBOX_PROBE], 240_000);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/sandbox/i);
  });

  describe.skipIf(!ACTION_PATH)('action.yml scan step', () => {
    const action = parseYaml(readFileSync(path.join(REPO_ROOT, 'action.yml'), 'utf8')) as {
      runs: { steps: Array<{ id?: string; run?: string }> };
    };
    const script = action.runs.steps.find((s) => s.id === 'scan')?.run as string;
    const resultScript = action.runs.steps.at(-1)?.run as string;

    /** Runs the scan step; `files` are written into the workspace first (paths relative to it). */
    function runStep(inputs: Record<string, string>, files: Record<string, string> = {}) {
      const workspace = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-ws-'));
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
        writeFileSync(path.join(workspace, rel), content);
      }
      const runnerTemp = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-rt-'));
      const outputFile = path.join(runnerTemp, 'github-output');
      const summaryFile = path.join(runnerTemp, 'step-summary');
      writeFileSync(outputFile, '');
      writeFileSync(summaryFile, '');
      const r = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        timeout: 240_000,
        env: {
          PATH: ACTION_PATH,
          HOME: process.env.HOME,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: runnerTemp,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_ACTION_PATH: REPO_ROOT,
          DC_URL: 'https://127.0.0.1/',
          DC_FAIL_ON: 'critical',
          DC_FORMAT: 'console,json,html',
          DC_OUT: 'dsgvo-check-report',
          DC_EXTRA_ARGS: '--lang en --max-pages 2',
          DC_IMAGE: image,
          DC_MEMORY: '2g',
          DC_CPUS: '1',
          DC_PIDS_LIMIT: '512',
          DC_JOB_SUMMARY: 'true',
          ...inputs,
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(outputFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      return { ...r, outputs, summary: readFileSync(summaryFile, 'utf8'), workspace };
    }

    function outputAfterResume(stdout: string): string[] {
      const lines = stdout.split(/\r?\n/);
      const stopIndex = lines.findIndex((line) => /^::stop-commands::[0-9a-f]{32}$/.test(line));
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      const token = lines[stopIndex]!.slice('::stop-commands::'.length);
      const resumeIndex = lines.indexOf(`::${token}::`, stopIndex + 1);
      expect(resumeIndex).toBeGreaterThan(stopIndex);
      return lines.slice(resumeIndex + 1).filter(Boolean);
    }

    it('runs the hardened container, sets outputs and appends the Job Summary', () => {
      const r = runStep({});
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.outputs['exit-code']).toBe('2');
      expect(r.outputs['json-path']).toMatch(/dsgvo-check-report\/report\.json$/);
      expect(r.outputs['html-path']).toMatch(/dsgvo-check-report\/report\.html$/);
      const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
      expectValidReport(report);
      expect(report.summary.exitReasons).toEqual(['invalid-input']);
      expect(report.disclaimer.lang).toBe('en');
      expect(r.summary).toMatch(/^## dsgvo-check/);
      expect(r.stdout).toMatch(/^::stop-commands::[0-9a-f]{32}$/m);
      expect(outputAfterResume(r.stdout)).toEqual([
        '::error title=dsgvo-check::The scan did not complete (exit code 2).',
      ]);
    });

    it.each([
      ['warning', 1],
      ['none', 0],
    ] as const)(
      'scan with findings and fail-on %s → exit-code %i, reports, Job Summary, job result',
      (failOn, code) => {
        const r = runStep(
          {
            DC_URL: 'https://www.example.test/',
            DC_FAIL_ON: failOn,
            DC_EXTRA_ARGS: '--from-snapshot /out/snapshot.json --lang en',
          },
          { 'dsgvo-check-report/snapshot.json': trackerSnapshot() },
        );
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        expect(r.outputs['exit-code']).toBe(String(code));
        const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
        expectValidReport(report);
        expect(report.scan.status).not.toBe('failed');
        expect(report.summary.exitCode).toBe(code);
        expect(report.summary.exitReasons).toEqual(code === 1 ? ['threshold'] : []);
        expect(report.findings?.some((finding) => finding.checkId === 'CONSENT-01')).toBe(true);
        expect(r.outputs['html-path']).toMatch(/dsgvo-check-report\/report\.html$/);
        expect(htmlSafetyProblems(readFileSync(r.outputs['html-path'] as string, 'utf8'))).toEqual([]);
        expect(r.summary).toMatch(/^## dsgvo-check/);
        expect(r.summary).toContain(`Exit code **${code}**`);
        expect(r.summary).toContain('CONSENT-01');
        expect(outputAfterResume(r.stdout)).toEqual(
          code === 1
            ? [
                '::error title=dsgvo-check::Findings at or above the threshold (fail-on: warning). See the Job Summary and the report.',
              ]
            : [],
        );
        // The last step of the action turns the scan's exit code into the job result.
        const result = spawnSync('bash', ['-c', resultScript], { env: { DC_EXIT_CODE: String(code) } });
        expect(result.status).toBe(code);
      },
    );

    it.each<Record<string, string>>([{ DC_URL: 'ftp://example.test/' }, { DC_FAIL_ON: 'high' }])(
      'reports invalid scanner input through the CLI: %j',
      (inputs) => {
        const r = runStep(inputs);
        expect(r.status, r.stderr).toBe(0);
        expect(r.outputs['exit-code']).toBe('2');
        const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
        expectValidReport(report);
        expect(report.scan.status).toBe('failed');
        expect(report.summary.exitCode).toBe(2);
        expect(report.summary.exitReasons).toContain('invalid-input');
        expect(r.summary).toContain('Exit code **2**');
        expect(outputAfterResume(r.stdout)).toEqual([
          '::error title=dsgvo-check::The scan did not complete (exit code 2).',
        ]);
      },
    );

    it('uses explicit Action options after repeated options from extra-args', () => {
      const r = runStep(
        {
          DC_URL: 'https://www.example.test/',
          DC_FAIL_ON: 'warning',
          DC_EXTRA_ARGS:
            '--from-snapshot /out/snapshot.json --out /etc --format pdf --fail-on none --lang en',
        },
        { 'dsgvo-check-report/snapshot.json': trackerSnapshot() },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs['exit-code']).toBe('1');
      expect(r.outputs['json-path']).toMatch(/dsgvo-check-report\/report\.json$/);
      expect(r.outputs['html-path']).toMatch(/dsgvo-check-report\/report\.html$/);
      expect(r.outputs['pdf-path']).toBe('');
      const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
      expectValidReport(report);
      expect(report.scan.options?.failOn).toBe('warning');
      expect(report.summary.exitReasons).toEqual(['threshold']);
      expect(r.summary).toContain('Exit code **1**');
    });

    it.each(['workspace', 'parent', 'absolute'] as const)(
      'uses the workflow author report directory: %s',
      (location) => {
        const authored = mkdtempSync(path.join(tmpdir(), 'dsgvo-action-report-'));
        const out =
          location === 'workspace' ? '.' : location === 'parent' ? `../${path.basename(authored)}` : authored;
        const r = runStep({ DC_OUT: out });
        expect(r.status, r.stderr).toBe(0);
        expect(r.outputs['exit-code']).toBe('2');
        expect(path.dirname(r.outputs['json-path'] as string)).toBe(path.resolve(r.workspace, out));
        const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
        expectValidReport(report);
        expect(report.summary.exitReasons).toEqual(['invalid-input']);
        expect(readFileSync(r.outputs['html-path'] as string, 'utf8')).toContain('dsgvo-check');
        expect(r.summary).toContain('Exit code **2**');
      },
    );

    it('passes shell syntax as URL data without executing it', () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-action-input-')), 'injected');
      const r = runStep({ DC_URL: `ftp://example.test/$(touch ${marker})` });
      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs['exit-code']).toBe('2');
      expect(() => readFileSync(marker)).toThrow();
    });

    it('keeps a newline URL and stale report commands outside the active workflow command stream', () => {
      const command = '::set-output name=unsafe::injected';
      const r = runStep(
        {
          DC_URL: `https://example.test/\n${command}`,
          DC_FAIL_ON: 'none',
          DC_EXTRA_ARGS: '--from-snapshot /out/snapshot.json --lang en',
        },
        {
          'dsgvo-check-report/snapshot.json': trackerSnapshot(),
          'dsgvo-check-report/annotations.txt': `${command}\n::warning::stale report command\n`,
        },
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.outputs['exit-code']).toBe('0');
      const report = JSON.parse(readFileSync(r.outputs['json-path'] as string, 'utf8')) as Report;
      expectValidReport(report);
      expect(report.findings?.some((finding) => finding.checkId === 'CONSENT-01')).toBe(true);
      expect(r.summary).toContain('Exit code **0**');
      expect(outputAfterResume(r.stdout)).toEqual([]);
      expect(r.stdout).not.toContain(command);
      expect(r.stdout).not.toContain('stale report command');
    });

    it('passes shell syntax in an image name as data and reports the Docker invocation failure', () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-action-image-')), 'injected');
      const r = runStep({ DC_IMAGE: `invalid image;$(touch ${marker})` });
      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs['exit-code']).toBe('125');
      expect(r.outputs['json-path']).toBe('');
      expect(r.outputs['html-path']).toBe('');
      expect(r.outputs['pdf-path']).toBe('');
      expect(r.summary).toBe('');
      expect(r.stderr).toMatch(/invalid reference format/i);
      expect(outputAfterResume(r.stdout)).toEqual([
        '::error title=dsgvo-check::The scan did not complete (exit code 125).',
      ]);
      expect(() => readFileSync(marker)).toThrow();
    });
  });
});
