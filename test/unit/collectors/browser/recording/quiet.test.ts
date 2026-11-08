/** Pure: the "quiet" algorithm replacing networkidle. */
import { describe, expect, it } from 'vitest';
import { quietDecision } from '../../../../../src/collectors/browser/recording/quiet.ts';

const p = { minDwellMs: 6_000, hardCapMs: 20_000, quietWindowMs: 2_000, maxInflight: 1 };

describe('quietDecision', () => {
  it('waits at least MIN_DWELL even when the network is idle', () => {
    expect(quietDecision({ elapsedMs: 3_000, sinceLastStartMs: 3_000, inflight: 0 }, p)).toBe('wait');
  });

  it('stops after MIN_DWELL once the 2 s window is quiet with ≤ 1 request in flight', () => {
    expect(quietDecision({ elapsedMs: 6_000, sinceLastStartMs: 2_000, inflight: 1 }, p)).toBe('quiet');
  });

  it('keeps waiting while requests start inside the window or more than one is in flight', () => {
    expect(quietDecision({ elapsedMs: 9_000, sinceLastStartMs: 1_999, inflight: 0 }, p)).toBe('wait');
    expect(quietDecision({ elapsedMs: 9_000, sinceLastStartMs: 5_000, inflight: 2 }, p)).toBe('wait');
  });

  it('gives up at HARD_CAP', () => {
    expect(quietDecision({ elapsedMs: 20_000, sinceLastStartMs: 10, inflight: 9 }, p)).toBe('hard-cap');
  });
});
