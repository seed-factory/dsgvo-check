import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_TMP_PREFIX, sweepDeadRunDirs } from '../../utils/global-tmpdir.ts';

describe('sweepDeadRunDirs', () => {
  let base: string;
  let deadPid: number;

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'sweep-test-'));
    deadPid = await new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      c.on('exit', () => resolve(c.pid as number));
    });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('removes the directory of a run that is gone, keeps the one of a running process and other names', () => {
    const dead = `${RUN_TMP_PREFIX}${deadPid}`;
    const running = `${RUN_TMP_PREFIX}${process.pid}`;
    const others = [`${RUN_TMP_PREFIX}x${deadPid}`, `${RUN_TMP_PREFIX}${deadPid}-w1`, `other-${deadPid}`];
    for (const name of [dead, running, ...others]) {
      mkdirSync(path.join(base, name, 'w1-1'), { recursive: true });
      writeFileSync(path.join(base, name, 'w1-1', 'file'), 'x');
    }

    expect(sweepDeadRunDirs(base)).toEqual([dead]);
    expect(existsSync(path.join(base, dead))).toBe(false);
    expect(existsSync(path.join(base, running))).toBe(true);
    for (const name of others) expect(existsSync(path.join(base, name))).toBe(true);
  });

  it('a missing base directory is not an error', () => {
    expect(sweepDeadRunDirs(path.join(base, 'missing'))).toEqual([]);
  });
});
