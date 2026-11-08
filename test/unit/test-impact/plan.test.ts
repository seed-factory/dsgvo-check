/** Test selection plan: which tests a set of changed paths pulls in, and when everything runs. */
import { describe, expect, it } from 'vitest';
import { planRun } from '../../../scripts/test-impact/plan.ts';
import { CLI_PROCESS_TESTS } from '../../../scripts/test-impact/rules.ts';

const files = [
  'src/checks/dns/mail-01.ts',
  'README.md',
  'test/data/routing.yaml',
  'test/e2e/cli.e2e.test.ts',
  'test/e2e/delivery-config.e2e.test.ts',
  'test/e2e/docker.e2e.test.ts',
  'test/e2e/settings.e2e.test.ts',
  'test/e2e/traffic-docs.e2e.test.ts',
  'test/integration/core/cli.test.ts',
  'test/integration/reporters/pdf-timeout.test.ts',
  'test/unit/core/data/sections.test.ts',
  'test/unit/core/evaluation/registry-completeness.test.ts',
  'test/unit/core/import-graph.test.ts',
  'test/unit/scan/robustness.test.ts',
  'test/utils/scan-harness.ts',
];
const consumers = new Map([['cmp', new Set(['src/cmp/lexicon-file.ts', 'test/unit/cmp/lexicon.test.ts'])]]);
const ctx = { files, consumers };
const cliTests = files.filter((file) => /\.e2e\.test\.ts$/.test(file) || CLI_PROCESS_TESTS.includes(file));

describe('planRun', () => {
  it('selects a changed check, the CLI process tests and the import graph test', () => {
    const plan = planRun(['src/checks/dns/mail-01.ts'], ctx);

    expect(plan).toEqual({
      mode: 'selective',
      related: [...cliTests, 'src/checks/dns/mail-01.ts', 'test/unit/core/import-graph.test.ts'].sort(),
      reasons: [],
    });
  });

  it('selects the consumers, the data copy, the catalog test and the CLI tests for a data file', () => {
    const plan = planRun(['test/data/cmp/lexicon.yaml'], ctx);

    expect(plan.mode).toBe('selective');
    if (plan.mode !== 'selective') return;
    expect(plan.related).toEqual(
      [
        'src/cmp/lexicon-file.ts',
        'test/unit/cmp/lexicon.test.ts',
        'test/utils/scan-harness.ts',
        'test/unit/core/data/sections.test.ts',
        ...cliTests,
      ].sort(),
    );
    expect(plan.reasons).toHaveLength(1);
    expect(plan.reasons[0]).toContain('test/data/cmp/lexicon.yaml');
  });

  it('keeps a deleted source file in the list', () => {
    const plan = planRun(['src/checks/dns/removed.ts'], ctx);

    expect(plan.mode === 'selective' && plan.related).toContain('src/checks/dns/removed.ts');
  });

  it('runs only the readers of the README', () => {
    const plan = planRun(['README.md'], ctx);

    expect(plan).toEqual({
      mode: 'selective',
      related: [
        'test/e2e/traffic-docs.e2e.test.ts',
        'test/unit/core/evaluation/registry-completeness.test.ts',
        'test/unit/scan/robustness.test.ts',
      ],
      reasons: ['README.md: text read by tests'],
    });
  });

  it('runs nothing for documentation only', () => {
    const plan = planRun(['docs/architecture.md', 'specs/dsgvo-check_TZ.md', 'AGENTS.md'], ctx);

    expect(plan.mode).toBe('selective');
    expect(plan.mode === 'selective' && plan.related).toEqual([]);
  });

  it.each([
    [
      'a test/data entry nobody reads',
      ['test/data/unread/words.yaml'],
      'no reader found for test/data/unread',
    ],
    ['a CI workflow', ['.github/workflows/ci.yml'], '.github/workflows/ci.yml: CI workflow'],
    ['an unmapped top-level file', ['mystery.bin'], 'mystery.bin: no rule'],
    [
      'an unmapped fixtures directory',
      ['test/fixtures/unknown/a.json'],
      'test/fixtures/unknown/a.json: no rule',
    ],
    [
      'the lockfile next to documentation',
      ['docs/a.md', 'package.json'],
      'package.json: toolchain or test configuration',
    ],
  ])('runs everything for %s', (_name, changed, reason) => {
    const plan = planRun(changed, ctx);

    expect(plan.mode).toBe('full');
    expect(plan.reasons.join('\n')).toContain(reason);
  });
});
