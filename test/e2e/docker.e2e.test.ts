/**
 * Container isolation and the Action's scan step with every exit code. Opt-in: set DSGVO_E2E_IMAGE to a built image
 * (`docker build -t dsgvo-check:dev .`). Exit 0/1 come from a saved snapshot (`--from-snapshot`), exit 2 from an
 * unresolvable host or a loopback target. The Action script needs bash 4+; DSGVO_E2E_ACTION_PATH adds a PATH for it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Report } from '../../src/core/report/schema.ts';
import { toSavedSnapshot } from '../../src/core/snapshot/index.ts';
import { SCENARIOS } from '../unit/checks/browser/scenarios/index.ts';
import { htmlSafetyProblems } from '../utils/report/html-safety.ts';
import { expectValidReport } from '../utils/report/validator.ts';
import { REPO_ROOT } from '../utils/snapshot-builder.ts';

const IMAGE = process.env.DSGVO_E2E_IMAGE;
const PROFILE = path.join(REPO_ROOT, 'docker/seccomp-chromium.json');
const ACTION_PATH =
  process.env.DSGVO_E2E_ACTION_PATH ?? (process.platform === 'linux' ? process.env.PATH : undefined);
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const DOCKER_TIMEOUT_MS = 180_000;
/** For a Chromium launch or a whole scan inside the container; the CLI help and `docker inspect` need far less. */
const SLOW_TIMEOUT_MS = 240_000;

/** Opens chrome://sandbox in a sandboxed Chromium and prints what the page says about the sandbox layers. */
const SANDBOX_PROBE = `
const { chromium } = await import('/app/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
const page = await browser.newPage();
await page.goto('chrome://sandbox');
const text = await page.innerText('body');
await browser.close();
process.stdout.write(JSON.stringify({ text }));
`;

/** `docker run` arguments of a hardened container (non-root, no capabilities, read-only root, no network), plus `extra`. */
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

function docker(args: string[], timeout = DOCKER_TIMEOUT_MS) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

/** Saved snapshot (JSON) of a site that sends a Google Analytics hit before any consent (CONSENT-01 finding). */
function trackerSnapshot(): string {
  const scenario = SCENARIOS['CONSENT-01']?.find((s) => s.file === 'violation-ga4-hit.json');
  if (!scenario) throw new Error('CONSENT-01 scenario violation-ga4-hit.json not found');
  return JSON.stringify(toSavedSnapshot(scenario.build()));
}

function readReport(file: string): Report {
  return JSON.parse(readFileSync(file, 'utf8')) as Report;
}

/** Ids of the checks that produced a finding; `toContain` on it names the ids found when an assertion fails. */
function findingCheckIds(report: Report): string[] {
  return report.findings?.map((f) => f.checkId) ?? [];
}

describe.skipIf(!IMAGE)('docker image', () => {
  const image = IMAGE as string;

  it('prints the help (exit 0)', () => {
    const help = docker(['run', '--rm', image, '--help']);

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--fail-on <level>');
  });

  it('runs as a non-root user', () => {
    const id = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']);

    expect(id.stdout.trim()).not.toBe('0');
  });

  it('labels the image with the version the CLI reports, the one of package.json', () => {
    const version = docker(['run', '--rm', image, '--version']);
    const label = docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
      image,
    ]);

    expect(version.status, version.stderr).toBe(0);
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
    const report = readReport(path.join(out, 'report.json'));
    expectValidReport(report);
    expect(report.scan.status).toBe('failed');
    expect(report.summary.exitReasons).toContain('unreachable');
    expect(htmlSafetyProblems(readFileSync(path.join(out, 'report.html'), 'utf8'))).toEqual([]);
    expect(readFileSync(path.join(out, 'summary.md'), 'utf8')).toMatch(/^## dsgvo-check/);
  });

  /** Scans the tracker snapshot offline in the hardened container and checks what every exit code has in common. */
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

    const report = readReport(path.join(out, 'report.json'));
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
    const aboveInfo = report.findings?.filter((f) => f.severity !== 'info').map((f) => f.checkId);
    expect(aboveInfo).toContain('CONSENT-01');
  });

  it('the same findings with --fail-on none → exit 0', () => {
    const { r, report } = scanSnapshot('none');

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(report.summary.exitReasons).toEqual([]);
    expect(findingCheckIds(report)).toContain('CONSENT-01');
  });

  it('starts Chromium with its sandbox under the seccomp profile, without any capability', () => {
    const r = docker(
      [...hardened(['--entrypoint', 'node']), image, '--input-type=module', '-e', SANDBOX_PROBE],
      SLOW_TIMEOUT_MS,
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

    const r = docker([...args, image, '--input-type=module', '-e', SANDBOX_PROBE], SLOW_TIMEOUT_MS);

    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/sandbox/i);
  });

  describe.skipIf(!ACTION_PATH)('action.yml scan step', () => {
    const action = parseYaml(readFileSync(path.join(REPO_ROOT, 'action.yml'), 'utf8')) as {
      runs: { steps: Array<{ id?: string; run?: string }> };
    };
    const script = action.runs.steps.find((s) => s.id === 'scan')?.run as string;
    const resultScript = action.runs.steps.at(-1)?.run as string;

    /** A fresh workspace directory with `files` (paths relative to it) written into it. */
    function makeWorkspace(files: Record<string, string>): string {
      const workspace = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-ws-'));
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
        writeFileSync(path.join(workspace, rel), content);
      }
      return workspace;
    }

    /** The `name=value` lines the step appended to its GITHUB_OUTPUT file. */
    function parseOutputs(text: string): Record<string, string> {
      return Object.fromEntries(
        text
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
    }

    /** Runs the scan step; `files` are written into the workspace first (paths relative to it). */
    function runStep(inputs: Record<string, string>, files: Record<string, string> = {}) {
      const workspace = makeWorkspace(files);
      const runnerTemp = mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-rt-'));
      const outputFile = path.join(runnerTemp, 'github-output');
      const summaryFile = path.join(runnerTemp, 'step-summary');
      writeFileSync(outputFile, '');
      writeFileSync(summaryFile, '');

      const r = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        timeout: SLOW_TIMEOUT_MS,
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

      const outputs = parseOutputs(readFileSync(outputFile, 'utf8'));
      return { ...r, outputs, summary: readFileSync(summaryFile, 'utf8'), workspace };
    }

    /** Lines the step printed after its `::stop-commands::<token>` / `::<token>::` pair, i.e. the ones GitHub would act on. */
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

      const report = readReport(r.outputs['json-path'] as string);
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

        const report = readReport(r.outputs['json-path'] as string);
        expectValidReport(report);
        expect(report.scan.status).not.toBe('failed');
        expect(report.summary.exitCode).toBe(code);
        expect(report.summary.exitReasons).toEqual(code === 1 ? ['threshold'] : []);
        expect(findingCheckIds(report)).toContain('CONSENT-01');

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

        const report = readReport(r.outputs['json-path'] as string);
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

      const report = readReport(r.outputs['json-path'] as string);
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

        const report = readReport(r.outputs['json-path'] as string);
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

      const report = readReport(r.outputs['json-path'] as string);
      expectValidReport(report);
      expect(findingCheckIds(report)).toContain('CONSENT-01');
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
