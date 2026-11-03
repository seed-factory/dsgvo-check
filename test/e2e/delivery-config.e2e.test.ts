/** Delivery contracts: isolation, versioned releases and complete report artifacts. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from '../utils/snapshot-builder.ts';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const yaml = (rel: string) => parseYaml(read(rel)) as Record<string, unknown>;
const VERSION = (JSON.parse(read('package.json')) as { version: string }).version;
const IMAGE = `ghcr.io/seed-factory/dsgvo-check:${VERSION}`;
const GITLAB_TEMPLATE = 'templates/gitlab/dsgvo-check.gitlab-ci.yml';
const ACTION_TAG = /^[\w.-]+\/[\w.-]+@v\d+(?:\.\d+)*$/;

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'examples/github-failing/.github/workflows/dsgvo-check.yml',
];

function workflowSteps(rel: string): Step[] {
  const wf = yaml(rel) as { jobs: Record<string, { steps: Step[] }> };
  return Object.values(wf.jobs).flatMap((job) => job.steps);
}

describe('composite action', () => {
  const action = yaml('action.yml') as {
    runs: { using: string; steps: Step[] };
    inputs: Record<string, { default?: string; required?: boolean; description?: string }>;
    outputs: Record<string, unknown>;
  };
  const scan = action.runs.steps.find((step) => step.id === 'scan') as Step;

  it('preserves its public inputs and exposes each report path', () => {
    expect(action.runs.using).toBe('composite');
    for (const name of [
      'url',
      'fail-on',
      'format',
      'out',
      'extra-args',
      'image',
      'memory',
      'cpus',
      'pids-limit',
      'job-summary',
      'upload-artifact',
      'artifact-name',
      'retention-days',
    ]) {
      expect(action.inputs).toHaveProperty(name);
    }
    expect(action.inputs.url?.required).toBe(true);
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'html-path', 'json-path', 'pdf-path']);
    expect(action.inputs.image?.default).toBe(IMAGE);
    expect(action.inputs.format?.default).toBe('console,json,html');
    expect(action.inputs.format?.description).toContain('pdf');
  });

  it('passes inputs through environment variables and lets explicit action options win', () => {
    for (const step of action.runs.steps) if (step.run) expect(step.run).not.toContain('${{');
    const run = scan.run as string;
    expect(run).toContain('read -r -a extra <<< "$DC_EXTRA_ARGS"');
    expect(run).toContain(`"$DC_IMAGE" "$DC_URL" \${extra[@]+"\${extra[@]}"} --fail-on "$DC_FAIL_ON"`);
    expect(run).toContain('--format "$formats" --out /out');
    expect(run).not.toMatch(/\bjq\b|=~|\bcase\b|docker image inspect|docker pull|eval /);
    expect(run).toContain('mkdir -p -- "$out"');
  });

  it('isolates the scanner and disables workflow commands while it runs', () => {
    const run = scan.run as string;
    for (const flag of [
      '--cap-drop=ALL',
      '--security-opt no-new-privileges',
      '--security-opt "seccomp=$profile"',
      '--read-only',
      '--tmpfs /tmp',
      '--shm-size=',
      '--memory=',
      '--memory-swap=',
      '--cpus=',
      '--pids-limit=',
      '--user "$(id -u):$(id -g)"',
      '--volume "$out:/out"',
    ]) {
      expect(run).toContain(flag);
    }
    expect(run).toContain('docker/seccomp-chromium.json');
    expect(run).not.toMatch(
      /docker\.sock|--privileged|--cap-add|--env-file|--network[ =]host|GITHUB_TOKEN|secrets\./,
    );
    expect(run.match(/--env /g)).toHaveLength(2);
    expect(run).toContain('--env HOME=/tmp --env NO_COLOR=1');
    expect(run.indexOf('::stop-commands::')).toBeLessThan(run.indexOf('docker run'));
    expect(run.indexOf('echo "::$token::"')).toBeGreaterThan(run.indexOf('docker run'));
    expect(run).toContain('Findings at or above the threshold');
    expect(run).toContain('The scan did not complete');
    expect(run).toContain('[[ ! -f "$out/report.$kind" ]]');
    expect(run).toContain('for kind in json html pdf');
  });

  it('uploads the complete report directory, including explicitly requested PDF', () => {
    const upload = action.runs.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toBe('actions/upload-artifact@v7');
    expect(upload?.with?.path).toBe(`\${{ steps.scan.outputs.out-dir }}`);
    for (const step of action.runs.steps) if (step.uses) expect(step.uses).toMatch(ACTION_TAG);
  });
});

describe('workflows', () => {
  it.each(WORKFLOWS)('%s uses action tags and does not persist credentials', (rel) => {
    expect(yaml(rel).permissions).toEqual({});
    for (const step of workflowSteps(rel)) {
      if (step.uses && !step.uses.startsWith('./')) expect(step.uses, rel).toMatch(ACTION_TAG);
      if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
      if (step.run) expect(step.run).not.toMatch(/\$\{\{\s*(inputs|github\.event)/);
    }
    expect(read(rel)).not.toContain('pull_request_target');
  });

  it('uses the current scanner release in the example', () => {
    expect(read('examples/github-failing/.github/workflows/dsgvo-check.yml')).toContain(
      `uses: seed-factory/dsgvo-check@v${VERSION}`,
    );
  });

  it('runs all checks on Node 24 and 26 and tests the hardened Chromium sandbox', () => {
    const ci = yaml('.github/workflows/ci.yml') as {
      jobs: { test: { strategy: { matrix: { node: string[] } } } };
    };
    expect(ci.jobs.test.strategy.matrix.node).toEqual(['24', '26']);
    const steps = workflowSteps('.github/workflows/ci.yml');
    const runs = steps.map((step) => step.run ?? '').join('\n');
    for (const cmd of ['typecheck', 'lint', 'test:unit', 'test:integration', 'build', 'test:e2e']) {
      expect(runs).toContain(`corepack pnpm ${cmd}`);
    }
    expect(runs).toContain('install --with-deps --no-shell chromium');
    expect(runs).toContain('docker build');
    const index = (cmd: string) => steps.findIndex((step) => step.run?.includes(cmd));
    const integration = steps[index('corepack pnpm test:integration')] as Step;
    expect(integration.env?.DSGVO_CHECK_TEST_SANDBOX).toBe('require');
    expect(index('kernel.apparmor_restrict_unprivileged_userns=0')).toBeGreaterThanOrEqual(0);
    expect(index('kernel.apparmor_restrict_unprivileged_userns=0')).toBeLessThan(
      index('corepack pnpm test:integration'),
    );
  });

  it('checks offline HTML/PDF conversion and retains its report artifact for 14 days', () => {
    const ci = yaml('.github/workflows/ci.yml') as { jobs: { test: { steps: Step[] } } };
    const steps = ci.jobs.test.steps;
    expect(
      steps.some((step) =>
        step.run?.includes(
          'report test/fixtures/reports/sample-full.report.json --format html,pdf --out report-preview',
        ),
      ),
    ).toBe(true);
    const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v7');
    expect(upload?.with?.['retention-days']).toBe(14);
    expect(upload?.with?.path).toBe('report-preview/');
  });
});

describe('release', () => {
  const release = yaml('.github/workflows/release.yml') as {
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }>;
  };
  const steps = workflowSteps('.github/workflows/release.yml');
  const at = (re: RegExp) => steps.findIndex((step) => re.test(step.run ?? ''));

  it('starts manually and grants write access only to its release job', () => {
    expect(Object.keys(release.on)).toEqual(['workflow_dispatch']);
    expect(release.permissions).toEqual({});
    const jobs = Object.values(release.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  it('builds and tests the image before publishing its version tag and the matching Action tag', () => {
    const order = [
      at(/docker build/),
      at(/test\/e2e\/docker\.e2e\.test\.ts/),
      at(/docker push/),
      at(/git tag -a/),
      at(/git .*push origin/),
    ];
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const text = read('.github/workflows/release.yml');
    expect(text).toContain('docker tag dsgvo-check:release "$IMAGE:$VERSION"');
    expect(text).not.toMatch(/RepoDigests|pin-image|git commit/);
    expect(existsSync(path.join(REPO_ROOT, '.github/scripts/pin-image.sh'))).toBe(false);
    const validation = steps.find((step) => step.id === 'version');
    expect(validation?.env?.VERSION).toBe(`\${{ inputs.version }}`);
    expect(validation?.run).toBe('node .github/scripts/release.ts');
  });
});

describe('GitLab template', () => {
  const tpl = yaml(GITLAB_TEMPLATE) as {
    variables: Record<string, string>;
    '.dsgvo-check': {
      image: { entrypoint: string[] };
      artifacts: { when: string; expire_in: string; access: string; paths: string[] };
      allow_failure: boolean;
      script: string[];
    };
  };

  it('preserves the sandbox and uploads reports on failure with developer access', () => {
    const job = tpl['.dsgvo-check'];
    expect(job.image.entrypoint).toEqual(['']);
    expect(job.artifacts).toMatchObject({ when: 'always', expire_in: '14 days', access: 'developer' });
    expect(job.artifacts.paths).toContain('$DSGVO_CHECK_OUT/');
    expect(job.allow_failure).toBe(false);
    expect(job.script.join('\n')).toContain('--sandbox "$DSGVO_CHECK_SANDBOX"');
    expect(tpl.variables.DSGVO_CHECK_SANDBOX).toBe('require');
    expect(tpl.variables.DSGVO_CHECK_FORMAT).toBe('console,json,html,summary');
    expect(tpl.variables.DSGVO_CHECK_IMAGE).toBe(IMAGE);
  });

  it('documents include:remote with integrity', () => {
    const text = read(GITLAB_TEMPLATE);
    for (const fragment of ['include:', 'remote:', 'integrity: sha256-']) expect(text).toContain(fragment);
  });
});

describe('Dockerfile and seccomp profile', () => {
  const dockerfile = read('Dockerfile');

  it('uses two Debian/Node stages, the full Chromium, a non-root user and tini', () => {
    expect(dockerfile.match(/^FROM node:24-bookworm-slim.*$/gm)).toHaveLength(2);
    expect(dockerfile).toContain('corepack pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('corepack pnpm prune --prod --ignore-scripts');
    expect(dockerfile).toContain('playwright-core/cli.js install-deps chromium');
    expect(dockerfile).toContain('playwright-core/cli.js install --no-shell chromium');
    expect(dockerfile).toContain('apt-get purge -y --auto-remove xvfb');
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dsgvo-check"]');
    expect(dockerfile).not.toMatch(/HEALTHCHECK|--no-sandbox/);
    expect(dockerfile.indexOf('COPY --from=build /app/node_modules ./node_modules')).toBeGreaterThan(
      dockerfile.indexOf('install --no-shell chromium'),
    );
    expect(dockerfile.indexOf('ARG REVISION=')).toBeGreaterThan(dockerfile.lastIndexOf('RUN '));
  });

  it('keeps image labels in sync with package.json and CI build arguments', () => {
    expect(dockerfile.match(/^ARG VERSION=(\S+)$/m)?.[1]).toBe(VERSION);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.version="\$\{VERSION\}"/);
    const builds = [
      ...workflowSteps('.github/workflows/ci.yml'),
      ...workflowSteps('.github/workflows/release.yml'),
    ]
      .map((step) => step.run ?? '')
      .filter((run) => run.includes('docker build'));
    expect(builds.length).toBeGreaterThanOrEqual(2);
    for (const run of builds) {
      expect(run).toContain('--build-arg VERSION=');
      expect(run).toContain('"$VERSION"');
      expect(run).toContain('--build-arg REVISION="$GITHUB_SHA"');
    }
    expect(read('.github/scripts/version.ts')).toContain('../../package.json');
    expect(read('.github/scripts/release.ts')).toContain('../../package.json');
  });

  it('allows only the files and directories copied into the image', () => {
    const lines = read('.dockerignore').trim().split(/\r?\n/);
    expect(lines[0]).toBe('*');
    const sources = dockerfile
      .split('\n')
      .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
      .flatMap((line) =>
        line
          .trim()
          .split(/\s+/)
          .slice(1, -1)
          .filter((part) => !part.startsWith('--')),
      );
    for (const source of sources) {
      expect(existsSync(path.join(REPO_ROOT, source)), source).toBe(true);
      expect(lines, source).toContain(`!${source}`);
    }
    for (const directory of ['src', 'data']) expect(lines).toContain(`!${directory}/**`);
    expect(lines).toContain('!docker');
    expect(lines).toContain('docker/**');
  });
  it('the seccomp profile is the Docker default plus the Chromium sandbox syscalls', () => {
    const profile = JSON.parse(read('docker/seccomp-chromium.json')) as {
      defaultAction: string;
      syscalls: Array<{
        names: string[];
        action: string;
        errnoRet?: number;
        includes?: unknown;
        excludes?: unknown;
      }>;
    };
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    const first = profile.syscalls[0];
    expect(first?.names.sort()).toEqual(['chroot', 'clone', 'setns', 'unshare']);
    expect(first?.action).toBe('SCMP_ACT_ALLOW');
    expect(first?.includes).toBeUndefined();
    const clone3 = profile.syscalls.find((s) => s.names.includes('clone3') && s.action === 'SCMP_ACT_ERRNO');
    expect(clone3?.errnoRet).toBe(38); // ENOSYS → glibc falls back to clone
    const unconditional = profile.syscalls.filter(
      (s) => s.action === 'SCMP_ACT_ALLOW' && !s.includes && !s.excludes,
    );
    const allowed = new Set(unconditional.flatMap((s) => s.names));
    for (const forbidden of [
      'mount',
      'umount2',
      'pivot_root',
      'bpf',
      'init_module',
      'kexec_load',
      'ptrace',
    ]) {
      expect(allowed.has(forbidden), forbidden).toBe(false);
    }
  });
});
