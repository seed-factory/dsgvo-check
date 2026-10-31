import { describe, expect, it } from 'vitest';
import { resolveTestWorkers } from '../../utils/test-workers.ts';

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
