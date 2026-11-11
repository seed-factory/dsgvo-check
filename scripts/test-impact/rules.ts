/** Maps repo paths to the tests they can affect: code is resolved by Vitest's import graph, everything else is listed here. */

export type Effect =
  | { kind: 'full'; reason: string }
  | { kind: 'none'; reason: string }
  | { kind: 'code' }
  | { kind: 'readers'; globs: string[]; reason: string }
  | { kind: 'data' };

export type Rule = { globs: string[]; effect: Effect };

const full = (globs: string[], reason: string): Rule => ({ globs, effect: { kind: 'full', reason } });
const none = (globs: string[], reason: string): Rule => ({ globs, effect: { kind: 'none', reason } });
const code = (globs: string[]): Rule => ({ globs, effect: { kind: 'code' } });
const data = (globs: string[]): Rule => ({ globs, effect: { kind: 'data' } });
const readers = (globs: string[], reason: string, files: string[]): Rule => ({
  globs,
  effect: { kind: 'readers', globs: files, reason },
});

// They run src/cli.ts or the built dist/cli.js in a child process, so the import graph does not see src/**.
export const CLI_PROCESS_TESTS = [
  'test/e2e/*.e2e.test.ts',
  'test/integration/core/cli.test.ts',
  'test/integration/reporters/pdf-timeout.test.ts',
];

export const RULES: Rule[] = [
  full(
    ['package.json', 'pnpm-lock.yaml', '.npmrc', '.node-version', 'tsconfig*.json', 'vitest.config.ts'],
    'toolchain or test configuration',
  ),
  full(['.github/workflows/**'], 'CI workflow'),
  full(['Dockerfile', '.dockerignore'], 'container image'),
  full(['scripts/test-impact/**'], 'test selection itself'),

  none(
    ['docs/**', 'specs/**', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', '.gitignore', '.editorconfig'],
    'no test reads it',
  ),
  none(['.github/CODEOWNERS'], 'repository ownership metadata'),

  code(['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts']),

  readers(['src/**'], 'run in the CLI child process', CLI_PROCESS_TESTS),
  readers(['src/checks/**', 'src/cmp/**', 'src/core/**'], 'source text read by the import graph test', [
    'test/unit/core/import-graph.test.ts',
  ]),
  readers(['src/cli.ts', 'src/reporters/**'], 'source text read by the report label keys helper', [
    'test/unit/reporters/html/report-label-keys.ts',
  ]),

  data(['test/data/**']),
  readers(['test/data/**'], 'data read without an import', [
    'test/utils/scan-harness.ts',
    'test/unit/core/data/sections.test.ts',
    ...CLI_PROCESS_TESTS,
  ]),

  readers(['test/fixtures/snapshots/**'], 'check fixtures', [
    'test/utils/completeness.ts',
    'test/unit/checks/http/data.test.ts',
  ]),
  readers(['test/fixtures/reports/**'], 'sample reports', [
    'test/unit/reporters/sample-report.test.ts',
    'test/e2e/docker.e2e.test.ts',
    'test/e2e/settings.e2e.test.ts',
  ]),
  readers(['test/fixtures/cmp/**'], 'captured CMP markup', [
    'test/integration/cmp/adapters/wix-captured-markup.test.ts',
  ]),
  readers(['test/fixture-server/sites/**'], 'fixture sites served at request time', [
    'test/fixture-server/server.ts',
    'test/unit/cmp/bot-user-agent.test.ts',
  ]),
  readers(
    ['test/e2e/sites/**', 'test/e2e/support/network-hook.ts'],
    'e2e sites and the network hook of the CLI child process',
    ['test/e2e/support/cli-harness.ts'],
  ),
  readers(['test/integration/browser/launch/support/profile-child.ts'], 'spawned by the test', [
    'test/integration/browser/launch/orphan-profiles.test.ts',
  ]),
  readers(['test/utils/preload/stalled-pdf-hook.ts'], 'preloaded with --import', [
    'test/integration/reporters/pdf-timeout.test.ts',
  ]),

  readers(['README.md', 'README.de.md'], 'text read by tests', [
    'test/e2e/traffic-docs.e2e.test.ts',
    'test/unit/scan/robustness.test.ts',
    'test/unit/core/evaluation/registry-completeness.test.ts',
  ]),
  readers(['.env.example', 'scripts/emit-env-example.ts'], 'env example check', [
    'test/unit/core/config/env-example.test.ts',
  ]),
  readers(['scripts/emit-registry.ts'], 'registry check', [
    'test/unit/core/evaluation/registry-completeness.test.ts',
  ]),
  readers(['action.yml'], 'delivery config', [
    'test/e2e/delivery-config.e2e.test.ts',
    'test/e2e/docker.e2e.test.ts',
  ]),
  readers(
    ['templates/**', 'examples/**', 'examples/**/.github/**', '.github/scripts/**', 'NOTICE', 'biome.json'],
    'delivery config',
    ['test/e2e/delivery-config.e2e.test.ts'],
  ),
  readers(['canary/sites.example.yaml'], 'canary corpus', ['test/unit/canary/corpus.test.ts']),
];
