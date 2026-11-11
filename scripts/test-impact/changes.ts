/** Decides what to compare the working tree with and lists the changed files through git. */
import { spawnSync } from 'node:child_process';

export type Source =
  | { kind: 'full'; reason: string }
  | { kind: 'files'; files: string[] }
  | { kind: 'merge-base'; base: string }
  | { kind: 'merge-commit' };

export function chooseSource(o: {
  all: boolean;
  files: string[];
  base?: string;
  env: Record<string, string | undefined>;
  headIsMerge: boolean;
  hasRef: (ref: string) => boolean;
}): Source {
  if (o.all) return { kind: 'full', reason: 'requested with --all' };
  if (o.files.length > 0) return { kind: 'files', files: o.files };
  if (o.base) return { kind: 'merge-base', base: o.base };

  if (o.env.GITHUB_ACTIONS === 'true') {
    const event = o.env.GITHUB_EVENT_NAME ?? '';
    if (event !== 'pull_request')
      return { kind: 'full', reason: `${event || 'unknown event'} runs every test` };
    return o.headIsMerge
      ? { kind: 'merge-commit' }
      : { kind: 'full', reason: 'pull request checkout is not a merge commit' };
  }

  if (o.hasRef('main')) return { kind: 'merge-base', base: 'main' };
  if (o.hasRef('origin/main')) return { kind: 'merge-base', base: 'origin/main' };
  return { kind: 'full', reason: 'no main branch to compare with' };
}

export function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export const gitSucceeds = (root: string, args: string[]): boolean =>
  spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;

export const hasRef = (root: string, ref: string): boolean =>
  gitSucceeds(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);

export const headIsMerge = (root: string): boolean =>
  gitSucceeds(root, ['rev-parse', '--verify', '-q', 'HEAD^2']);

const names = (root: string, args: string[]): string[] => git(root, args).split('\0').filter(Boolean);

export function changedFiles(
  root: string,
  source: Extract<Source, { kind: 'merge-base' | 'merge-commit' }>,
): string[] {
  const diff = ['diff', '--name-only', '--no-renames', '-z'];
  const found =
    source.kind === 'merge-commit'
      ? names(root, [...diff, 'HEAD^1', 'HEAD'])
      : [
          ...names(root, [...diff, `${source.base}...HEAD`]),
          ...names(root, [...diff, '--cached']),
          ...names(root, diff),
          ...names(root, ['ls-files', '-z', '--others', '--exclude-standard']),
        ];
  return [...new Set(found)].sort();
}
