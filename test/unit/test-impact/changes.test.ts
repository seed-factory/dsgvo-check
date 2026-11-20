/** Choosing what to diff against and listing changed files from git. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changedFiles, chooseSource } from '../../../scripts/test-impact/changes.ts';

const base = { all: false, files: [], env: {}, headIsMerge: false, hasRef: () => false };

describe('chooseSource', () => {
  it.each([
    [
      '--all wins',
      { all: true, files: ['a.ts'], base: 'x' },
      { kind: 'full', reason: 'requested with --all' },
    ],
    ['--files wins over --base', { files: ['a.ts'], base: 'x' }, { kind: 'files', files: ['a.ts'] }],
    ['--base', { base: 'release' }, { kind: 'merge-base', base: 'release' }],
    [
      'pull request merge commit',
      { env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }, headIsMerge: true },
      { kind: 'merge-commit' },
    ],
    [
      'pull request without a merge commit',
      { env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' } },
      { kind: 'full', reason: 'pull request checkout is not a merge commit' },
    ],
    [
      'push in CI',
      { env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, headIsMerge: true },
      { kind: 'full', reason: 'push runs every test' },
    ],
    ['local main', { hasRef: (ref: string) => ref === 'main' }, { kind: 'merge-base', base: 'main' }],
    [
      'local origin/main',
      { hasRef: (ref: string) => ref === 'origin/main' },
      { kind: 'merge-base', base: 'origin/main' },
    ],
    ['no main branch', {}, { kind: 'full', reason: 'no main branch to compare with' }],
  ])('%s', (_name, options, expected) => {
    expect(chooseSource({ ...base, ...options })).toEqual(expected);
  });
});

describe('changedFiles', () => {
  const repos: string[] = [];
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

  function makeRepo() {
    const repo = mkdtempSync(path.join(tmpdir(), 'test-impact-'));
    repos.push(repo);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=test',
          '-c',
          'user.email=test@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv },
      );
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
    };

    git('init', '-b', 'main');
    for (const file of [
      'keep.txt',
      'modify.txt',
      'old-name.txt',
      'delete.txt',
      'staged.txt',
      'unstaged.txt',
    ]) {
      write(file, `${file}\n`);
    }
    write('.gitignore', 'ignored.log\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    return { repo, git, write };
  }

  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  it('lists committed, staged, unstaged and untracked changes against the merge base', () => {
    const { repo, git, write } = makeRepo();
    git('switch', '-c', 'feature');
    write('modify.txt', 'changed\n');
    renameSync(path.join(repo, 'old-name.txt'), path.join(repo, 'new-name.txt'));
    rmSync(path.join(repo, 'delete.txt'));
    git('add', '-A');
    git('commit', '-m', 'feature');
    write('staged.txt', 'staged\n');
    git('add', 'staged.txt');
    write('unstaged.txt', 'unstaged\n');
    write('untracked.txt', 'new\n');
    write('ignored.log', 'noise\n');

    expect(changedFiles(repo, { kind: 'merge-base', base: 'main' })).toEqual([
      'delete.txt',
      'modify.txt',
      'new-name.txt',
      'old-name.txt',
      'staged.txt',
      'unstaged.txt',
      'untracked.txt',
    ]);
  });

  it('lists the files of a pull request from its merge commit', () => {
    const { repo, git, write } = makeRepo();
    git('switch', '-c', 'feature');
    write('modify.txt', 'changed\n');
    renameSync(path.join(repo, 'old-name.txt'), path.join(repo, 'new-name.txt'));
    rmSync(path.join(repo, 'delete.txt'));
    write('added.txt', 'added\n');
    git('add', '-A');
    git('commit', '-m', 'feature');
    git('switch', 'main');
    write('main-only.txt', 'main\n');
    git('add', 'main-only.txt');
    git('commit', '-m', 'main moves on');
    git('merge', '--no-ff', 'feature', '-m', 'merge pull request');

    expect(changedFiles(repo, { kind: 'merge-commit' })).toEqual([
      'added.txt',
      'delete.txt',
      'modify.txt',
      'new-name.txt',
      'old-name.txt',
    ]);
  });
});
