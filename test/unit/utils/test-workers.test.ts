import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveTestWorkers, testWorkersSetting } from '../../utils/run/test-workers.ts';

describe('resolveTestWorkers (DSGVO_TEST_WORKERS)', () => {
  it('defaults to the number of logical cores', () => {
    expect(resolveTestWorkers(undefined, 14)).toBe(14);
    expect(resolveTestWorkers('', 14)).toBe(14);
    expect(resolveTestWorkers('  ', 14)).toBe(14);
  });

  it('takes a positive whole number as is, also above the core count', () => {
    expect(resolveTestWorkers('1', 14)).toBe(1);
    expect(resolveTestWorkers('4', 14)).toBe(4);
    expect(resolveTestWorkers(' 20 ', 14)).toBe(20);
  });

  it('takes a percentage of the logical cores, rounded down, at least 1', () => {
    expect(resolveTestWorkers('50%', 14)).toBe(7);
    expect(resolveTestWorkers('100%', 14)).toBe(14);
    expect(resolveTestWorkers('30%', 14)).toBe(4);
    expect(resolveTestWorkers('1%', 14)).toBe(1);
    expect(resolveTestWorkers('12.5%', 8)).toBe(1);
  });

  it.each(['0', '-2', '1.5', 'abc', '4x', '0%', '101%', '-5%', '%', '50 %', '1e3', 'NaN'])(
    'rejects %j with a message that names the variable and the allowed forms',
    (raw) => {
      expect(() => resolveTestWorkers(raw, 14)).toThrow(/DSGVO_TEST_WORKERS=.*positive whole number.*"50%"/);
    },
  );

  it('a zero-core report does not produce zero workers', () => {
    expect(resolveTestWorkers(undefined, 0)).toBe(1);
  });
});

describe('testWorkersSetting (environment, then .env)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-workers-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('without the variable and without .env there is no value: all cores', () => {
    expect(testWorkersSetting({}, root)).toBeUndefined();
  });

  it('reads .env in the root, and a non-empty environment variable wins over it', () => {
    writeFileSync(path.join(root, '.env'), 'DSGVO_TEST_WORKERS=50%\nOTHER=1\n');
    expect(testWorkersSetting({}, root)).toBe('50%');
    expect(testWorkersSetting({ DSGVO_TEST_WORKERS: '' }, root)).toBe('50%');
    expect(testWorkersSetting({ DSGVO_TEST_WORKERS: '4' }, root)).toBe('4');
  });
});
