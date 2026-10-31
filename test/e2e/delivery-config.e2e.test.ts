/**
 * L3 static checks of the delivery files (D24/D25): composite Action, project CI, release workflow, example
 * workflow, GitLab template, Dockerfile, .dockerignore and the seccomp profile. No Docker and no network needed
 * (shell scripts run with bash only up to their input checks).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from '../utils/snapshot-builder.ts';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const yaml = (rel: string) => parseYaml(read(rel)) as Record<string, unknown>;

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

/** D24: the image is pulled by digest, never by a mutable tag. */
const IMAGE_BY_DIGEST = /^ghcr\.io\/seed-factory\/dsgvo-check@sha256:[0-9a-f]{64}$/;
/** Placeholder digest on the default branch; the release job replaces it before tagging. */
const UNRELEASED_IMAGE = `ghcr.io/seed-factory/dsgvo-check@sha256:${'0'.repeat(64)}`;
const GITLAB_TEMPLATE = 'templates/gitlab/dsgvo-check.gitlab-ci.yml';

function workflowSteps(rel: string): Step[] {
  const wf = yaml(rel) as { jobs: Record<string, { steps: Step[] }> };
  return Object.values(wf.jobs).flatMap((j) => j.steps);
}

describe('action.yml (composite → docker run)', () => {
  const action = yaml('action.yml') as {
    runs: { using: string; steps: Step[] };
    inputs: Record<string, { default?: string; required?: boolean }>;
    outputs: Record<string, unknown>;
  };
  const scan = action.runs.steps.find((s) => s.id === 'scan') as Step;

  it('is a composite action with the required inputs and outputs', () => {
    expect(action.runs.using).toBe('composite');
    for (const i of ['url', 'fail-on', 'format', 'out', 'extra-args', 'image'])
      expect(action.inputs).toHaveProperty(i);
    expect(action.inputs.url?.required).toBe(true);
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'html-path', 'json-path']);
  });

  it('pulls the image by digest by default, never by a mutable tag (D24)', () => {
    expect(action.inputs.image?.default).toMatch(IMAGE_BY_DIGEST);
  });

  it('refuses the unreleased placeholder digest before touching Docker', () => {
    const outputFile = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-action-')), 'github-output');
    const r = spawnSync('bash', ['-c', `: > "$GITHUB_OUTPUT"\n${scan.run as string}`], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GITHUB_OUTPUT: outputFile,
        DC_URL: 'https://www.example.de/',
        DC_FAIL_ON: 'critical',
        DC_FORMAT: 'console,json,html',
        DC_OUT: 'dsgvo-check-report',
        DC_EXTRA_ARGS: '',
        DC_IMAGE: UNRELEASED_IMAGE,
        DC_MEMORY: '3g',
        DC_CPUS: '2',
        DC_PIDS_LIMIT: '1024',
        DC_JOB_SUMMARY: 'true',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/^::error title=dsgvo-check::.*not a release.*'image'/m);
    expect(readFileSync(outputFile, 'utf8')).toBe('exit-code=2\n');
  });

  it('warns when it has to pull an image that is not pinned by digest', () => {
    expect(scan.run).toContain('[[ "$DC_IMAGE" == *@sha256:* ]] || echo "::warning title=dsgvo-check::');
  });

  it('never interpolates expressions into shell scripts (inputs go through env)', () => {
    for (const step of action.runs.steps) if (step.run) expect(step.run).not.toContain('${{');
  });

  it('runs the container hardened, without secrets, docker.sock or runner environment', () => {
    const run = scan.run as string;
    for (const flag of [
      '--cap-drop=ALL',
      '--security-opt no-new-privileges',
      '--security-opt "seccomp=$profile"',
      '--read-only',
      '--tmpfs /tmp',
      '--memory=',
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
    expect(run.match(/--env /g)).toHaveLength(2); // HOME and NO_COLOR only
    expect(run).toContain('::stop-commands::');
  });

  it('pins every used action by commit SHA', () => {
    for (const step of action.runs.steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});

describe('workflows', () => {
  it.each(WORKFLOWS)('%s pins actions by SHA and does not persist credentials', (rel) => {
    const wf = yaml(rel) as { permissions?: unknown };
    expect(wf.permissions).toEqual({});
    for (const step of workflowSteps(rel)) {
      if (!step.uses || step.uses.startsWith('./')) continue;
      expect(step.uses, rel).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (step.uses.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
    }
    for (const step of workflowSteps(rel))
      if (step.run) expect(step.run).not.toMatch(/\$\{\{\s*(inputs|github\.event)/);
    expect(read(rel)).not.toContain('pull_request_target');
  });

  it('the example pins this action by commit SHA with the release tag as a comment', () => {
    const text = read('examples/github-failing/.github/workflows/dsgvo-check.yml');
    expect(text).toMatch(/^\s+- uses: seed-factory\/dsgvo-check@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
    expect(text).not.toMatch(/seed-factory\/dsgvo-check@v\d/);
  });

  it('CI runs typecheck, lint, unit, integration, build and e2e on Node 24 and 26', () => {
    const ci = yaml('.github/workflows/ci.yml') as {
      jobs: { test: { strategy: { matrix: { node: string[] } } } };
    };
    expect(ci.jobs.test.strategy.matrix.node).toEqual(['24', '26']);
    const runs = workflowSteps('.github/workflows/ci.yml')
      .map((s) => s.run ?? '')
      .join('\n');
    for (const cmd of ['typecheck', 'lint', 'test:unit', 'test:integration', 'build', 'test:e2e']) {
      expect(runs).toContain(`corepack pnpm ${cmd}`);
    }
    expect(runs).toContain('install --with-deps --no-shell chromium');
    expect(runs).toContain('docker build');
  });

  it('CI runs the L2 browser tests with the Chromium sandbox required, after allowing user namespaces', () => {
    const steps = workflowSteps('.github/workflows/ci.yml');
    const index = (cmd: string) => steps.findIndex((s) => s.run?.includes(cmd));
    const integration = steps[index('corepack pnpm test:integration')] as Step;
    // test/integration/browser/helpers.ts picks `off` on Linux unless this is set.
    expect(integration.env?.DSGVO_CHECK_TEST_SANDBOX).toBe('require');
    expect(index('kernel.apparmor_restrict_unprivileged_userns=0')).toBeGreaterThanOrEqual(0);
    expect(index('kernel.apparmor_restrict_unprivileged_userns=0')).toBeLessThan(
      index('corepack pnpm test:integration'),
    );
  });
});

describe('release (D24: image → digest → commit in action.yml → tag)', () => {
  const release = yaml('.github/workflows/release.yml') as {
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }>;
  };
  const jobs = Object.values(release.jobs);
  const steps = workflowSteps('.github/workflows/release.yml');
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ''));

  it('is started by hand and only the release job may write contents and packages', () => {
    expect(Object.keys(release.on)).toEqual(['workflow_dispatch']);
    expect(release.permissions).toEqual({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  it('builds and tests the image, pushes it, pins its digest, then tags the pinned commit', () => {
    const order = [
      at(/docker build/),
      at(/test\/e2e\/docker\.e2e\.test\.ts/),
      at(/docker push/),
      at(/\.github\/scripts\/pin-image\.sh "\$ref"/),
      at(/git commit/),
      at(/git tag -a "v\$VERSION"/),
      at(/git .*push origin "refs\/tags\/v\$VERSION"/),
    ];
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const pin = steps[at(/pin-image\.sh/)]?.run as string;
    expect(pin).toContain('RepoDigests');
    const versionCheck = steps.find((s) => (s.run ?? '').includes('jq -r .version package.json'));
    expect(versionCheck?.env?.VERSION).toMatch(/^\$\{\{ inputs\.version \}\}$/);
  });

  describe('.github/scripts/pin-image.sh', () => {
    const digest = `ghcr.io/seed-factory/dsgvo-check@sha256:${'ab'.repeat(32)}`;
    function sandbox(): string {
      const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-pin-'));
      mkdirSync(path.join(root, 'templates/gitlab'), { recursive: true });
      copyFileSync(path.join(REPO_ROOT, 'action.yml'), path.join(root, 'action.yml'));
      copyFileSync(path.join(REPO_ROOT, GITLAB_TEMPLATE), path.join(root, GITLAB_TEMPLATE));
      return root;
    }
    const pin = (ref: string, root: string) =>
      spawnSync('bash', [path.join(REPO_ROOT, '.github/scripts/pin-image.sh'), ref, root], {
        encoding: 'utf8',
      });

    it('replaces exactly the image defaults of action.yml and the GitLab template', () => {
      const root = sandbox();
      const r = pin(digest, root);
      expect(r.status, r.stderr).toBe(0);
      const action = parseYaml(readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
        inputs: Record<string, { default?: string }>;
      };
      expect(action.inputs.image?.default).toBe(digest);
      const tpl = parseYaml(readFileSync(path.join(root, GITLAB_TEMPLATE), 'utf8')) as {
        variables: Record<string, string>;
      };
      expect(tpl.variables.DSGVO_CHECK_IMAGE).toBe(digest);
      const changed = (rel: string) => {
        const before = read(rel).split('\n');
        const after = readFileSync(path.join(root, rel), 'utf8').split('\n');
        expect(after).toHaveLength(before.length);
        return before.filter((l, i) => l !== after[i]);
      };
      expect(changed('action.yml')).toHaveLength(1);
      expect(changed(GITLAB_TEMPLATE)).toHaveLength(1);
    });

    it.each([
      'ghcr.io/seed-factory/dsgvo-check:0.1.0',
      'ghcr.io/seed-factory/dsgvo-check@sha256:abc',
      `ghcr.io/other/dsgvo-check@sha256:${'ab'.repeat(32)}`,
    ])('rejects %s', (ref) => {
      const root = sandbox();
      expect(pin(ref, root).status).not.toBe(0);
      expect(readFileSync(path.join(root, 'action.yml'), 'utf8')).toBe(read('action.yml'));
    });
  });
});

describe('GitLab template', () => {
  const tpl = yaml('templates/gitlab/dsgvo-check.gitlab-ci.yml') as Record<
    string,
    {
      image?: { name: string; entrypoint: string[] };
      artifacts?: { when: string; expire_in: string };
      allow_failure?: boolean;
      script?: string[];
    }
  >;
  const job = tpl['.dsgvo-check'];

  it('keeps artifacts on failure, does not allow failure and overrides the entrypoint', () => {
    expect(job?.image?.entrypoint).toEqual(['']);
    expect(job?.artifacts?.when).toBe('always');
    expect(job?.artifacts?.expire_in).toBe('14 days');
    expect(job?.allow_failure).toBe(false);
    expect(job?.script?.join('\n')).toContain('--sandbox "$DSGVO_CHECK_SANDBOX"');
    expect((tpl.variables as unknown as Record<string, string>).DSGVO_CHECK_SANDBOX).toBe('require');
  });

  it('pulls the image by digest by default, never by a mutable tag (D24)', () => {
    expect((tpl.variables as unknown as Record<string, string>).DSGVO_CHECK_IMAGE).toMatch(IMAGE_BY_DIGEST);
  });

  it('documents include:remote with integrity', () => {
    const text = read('templates/gitlab/dsgvo-check.gitlab-ci.yml');
    expect(text).toContain('include:');
    expect(text).toContain('remote:');
    expect(text).toContain('integrity: sha256-');
  });
});

describe('Dockerfile and seccomp profile', () => {
  const dockerfile = read('Dockerfile');

  it('uses node:24-bookworm-slim, the full Chromium via playwright-core, a non-root user and tini', () => {
    expect(dockerfile).toContain('ARG NODE_IMAGE=node:24-bookworm-slim');
    expect(dockerfile).toContain('corepack pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('playwright-core/cli.js install-deps chromium');
    expect(dockerfile).toContain('playwright-core/cli.js install --no-shell chromium');
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dsgvo-check"]');
    expect(dockerfile).not.toMatch(/HEALTHCHECK|--no-sandbox/);
  });

  it('labels the image with the package version: CI passes it from package.json, the default matches', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(dockerfile).toMatch(/^ARG VERSION=(\S+)$/m);
    expect(dockerfile.match(/^ARG VERSION=(\S+)$/m)?.[1]).toBe(version);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.version="\$\{VERSION\}"/);
    const builds = [
      ...workflowSteps('.github/workflows/ci.yml'),
      ...workflowSteps('.github/workflows/release.yml'),
    ]
      .map((s) => s.run ?? '')
      .filter((r) => /docker build/.test(r));
    expect(builds.length).toBeGreaterThanOrEqual(2);
    for (const run of builds) {
      expect(run).toMatch(/--build-arg VERSION="\$\(jq -r \.version package\.json\)"/);
      expect(run).toContain('--build-arg REVISION="$GITHUB_SHA"');
    }
  });

  it('.dockerignore keeps the build context small', () => {
    const lines = read('.dockerignore').split('\n');
    for (const p of ['node_modules', '.git', 'dist', 'test', 'docs', 'specs', 'coverage', 'canary']) {
      expect(lines).toContain(p);
    }
    for (const needed of ['src', 'data', 'schema', 'docker', 'package.json', 'pnpm-lock.yaml']) {
      expect(lines).not.toContain(needed);
    }
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
