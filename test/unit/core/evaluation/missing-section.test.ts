/** A check whose section is missing takes its status from the collector that should have produced it. */
import { describe, expect, it } from 'vitest';
import { missingSectionResult } from '../../../../src/core/evaluation/execute.ts';
import type { CollectorName, SnapshotSectionKey } from '../../../../src/core/snapshot/index.ts';
import { makeSnapshot } from '../../../utils/snapshot-builder.ts';

type Status = NonNullable<ReturnType<typeof makeSnapshot>['collection'][CollectorName]>['status'];

const result = (
  missing: SnapshotSectionKey,
  collector: CollectorName,
  status: Status | null,
  reason?: string,
  timedOut = false,
) =>
  missingSectionResult(
    [missing],
    makeSnapshot({
      collection:
        status === null ? {} : { [collector]: { status, durationMs: 0, ...(reason ? { reason } : {}) } },
    }),
    timedOut,
  );

describe('missingSectionResult', () => {
  it.each<[string, SnapshotSectionKey, CollectorName, Status | null, string | undefined, boolean, object]>([
    [
      'http skipped with a reason',
      'http',
      'http',
      'skipped',
      'not-required',
      false,
      { status: 'skipped', reason: 'not-required' },
    ],
    [
      'http skipped without a reason',
      'http',
      'http',
      'skipped',
      undefined,
      false,
      { status: 'skipped', reason: 'collector-skipped' },
    ],
    [
      'tls cut by the deadline',
      'tls',
      'tls',
      'partial',
      'timeout',
      false,
      { status: 'error', reason: 'timeout' },
    ],
    [
      'dns never reported before the deadline',
      'dns',
      'dns',
      null,
      undefined,
      true,
      { status: 'error', reason: 'timeout' },
    ],
    [
      'dns ran without the section',
      'dns',
      'dns',
      'ok',
      undefined,
      false,
      { status: 'error', reason: 'collector-error:dns' },
    ],
    [
      'browser failed',
      'documents',
      'browser',
      'error',
      undefined,
      false,
      { status: 'error', reason: 'collector-error:browser' },
    ],
    [
      'derived data of a skipped browser',
      'derived',
      'browser',
      'skipped',
      'sandbox-unavailable',
      false,
      { status: 'skipped', reason: 'sandbox-unavailable' },
    ],
    [
      'derived data of a browser that ran',
      'derived',
      'browser',
      'ok',
      undefined,
      false,
      { status: 'error', reason: 'collector-error:browser' },
    ],
    [
      'a core section has no collector',
      'environment',
      'browser',
      'error',
      undefined,
      false,
      { status: 'skipped', reason: 'not-collected' },
    ],
    [
      'a core section missing after the deadline',
      'plan',
      'browser',
      'ok',
      undefined,
      true,
      { status: 'error', reason: 'timeout' },
    ],
    [
      'no collector reported',
      'http',
      'http',
      null,
      undefined,
      false,
      { status: 'skipped', reason: 'not-collected' },
    ],
  ])('%s', (_name, missing, collector, status, reason, timedOut, expected) => {
    expect(result(missing, collector, status, reason, timedOut)).toMatchObject(expected);
  });
});
