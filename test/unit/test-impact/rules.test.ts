/** The rule table covers the real repository: every tracked file is mapped and no glob is dead. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanDataConsumers } from '../../../scripts/test-impact/data-consumers.ts';
import { RULES } from '../../../scripts/test-impact/rules.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const repoFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const matches = (file: string, glob: string) => path.posix.matchesGlob(file, glob);

const consumers = scanDataConsumers(
  repoFiles
    .filter((file) => /^(src|test)\/.*\.ts$/.test(file))
    .map((file) => ({ path: file, text: readFileSync(path.join(root, file), 'utf8') })),
);
const dataEntries = [
  ...new Set(repoFiles.filter((f) => f.startsWith('test/data/')).map((f) => f.split('/')[2])),
];

describe('test impact rules', () => {
  it('map every file of the repository', () => {
    const unmapped = repoFiles.filter(
      (file) => !RULES.some((rule) => rule.globs.some((g) => matches(file, g))),
    );

    expect(unmapped).toEqual([]);
  });

  it('have no glob that matches nothing', () => {
    const globs = RULES.flatMap((rule) => [
      ...rule.globs,
      ...(rule.effect.kind === 'readers' ? rule.effect.globs : []),
    ]);
    const dead = globs.filter((glob) => !repoFiles.some((file) => matches(file, glob)));

    expect(dead).toEqual([]);
  });

  it.each(dataEntries)('finds a reader of test/data/%s in src', (entry) => {
    const readers = [...(consumers.get(entry as string) ?? [])];

    expect(readers.some((file) => file.startsWith('src/'))).toBe(true);
  });

  it.each([
    ['cmp', 'src/cmp/lexicon-file.ts'],
    ['report', 'src/reporters/html.ts'],
    ['ruleset', 'src/core/data/load.ts'],
    ['texts', 'src/core/data/load.ts'],
    ['routing.yaml', 'src/core/data/load.ts'],
  ])('maps test/data/%s to %s', (entry, reader) => {
    const found = consumers.get(entry) ?? new Set();

    expect(found).toContain(reader);
  });
});
