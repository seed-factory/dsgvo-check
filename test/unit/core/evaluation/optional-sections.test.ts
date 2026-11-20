/**
 * Optional sections of a check: read when the scan has them, never a reason to skip the check or to start their
 * collector. The slice names the optional sections the scan meant to collect and did not get.
 */
import { describe, expect, it } from 'vitest';
import { defineCheck } from '../../../../src/core/evaluation/check.ts';
import { CheckRegistry, RegistryError } from '../../../../src/core/evaluation/registry.ts';
import type { CollectorStatus, SnapshotSectionKey } from '../../../../src/core/snapshot/index.ts';
import { sliceSnapshot } from '../../../../src/core/snapshot/index.ts';
import { requiredCollectors } from '../../../../src/scan-collect.ts';
import { makeBrowser, makeHttp, makeSnapshot, runCheck } from '../../../utils/snapshot-builder.ts';

const seen: Array<{ browser: boolean; unavailable: readonly string[] }> = [];

const readsBrowserIfThere = defineCheck({
  id: 'OPT-01',
  module: 'http',
  requires: ['http'],
  optional: ['browser'],
  variants: [{ variant: 'seen' }],
  run(slice) {
    seen.push({ browser: slice.browser !== undefined, unavailable: slice.unavailable });
    return [];
  },
});

const browserStatus = (status: CollectorStatus['status'], reason?: string) => ({
  browser: { status, durationMs: 0, ...(reason ? { reason } : {}) },
});

describe('sliceSnapshot with optional sections', () => {
  it('copies a present optional section next to the required ones', () => {
    const snapshot = makeSnapshot({ http: makeHttp(), browser: makeBrowser() });
    const sliced = sliceSnapshot(snapshot, ['http'], ['browser']);
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;
    expect(sliced.slice.browser).toBe(snapshot.browser);
    expect(sliced.slice.http).toBe(snapshot.http);
    expect(sliced.slice.unavailable).toEqual([]);
  });

  it('an absent optional section is not reported missing', () => {
    const sliced = sliceSnapshot(makeSnapshot({ http: makeHttp() }), ['http'], ['browser']);
    expect(sliced).toMatchObject({ ok: true });
    if (!sliced.ok) return;
    expect('browser' in sliced.slice).toBe(false);
  });

  it('a required section stays required when optional ones are given', () => {
    expect(sliceSnapshot(makeSnapshot({ browser: makeBrowser() }), ['http'], ['browser'])).toEqual({
      ok: false,
      missing: ['http'],
    });
  });

  it.each<[string, Partial<Record<'browser', CollectorStatus>>, boolean, string[]]>([
    ['browser not selected (not-run)', browserStatus('not-run', 'not-required'), false, []],
    ['no collector status (older snapshot)', {}, false, []],
    ['browser skipped (tls-blocked)', browserStatus('skipped', 'tls-blocked'), false, ['browser']],
    [
      'browser skipped (sandbox-unavailable)',
      browserStatus('skipped', 'sandbox-unavailable'),
      false,
      ['browser'],
    ],
    ['browser failed', browserStatus('error'), false, ['browser']],
    ['browser cut by the deadline', browserStatus('error', 'timeout'), false, ['browser']],
    ['browser ok without its section', browserStatus('ok'), false, ['browser']],
    ['no status after the global timeout', {}, true, ['browser']],
  ])('%s → unavailable %j', (_name, collection, timedOut, unavailable) => {
    const snapshot = makeSnapshot({ http: makeHttp(), collection });
    const sliced = sliceSnapshot(snapshot, ['http'], ['browser'], timedOut);
    if (!sliced.ok) throw new Error('expected a slice');
    expect(sliced.slice.unavailable).toEqual(unavailable);
  });

  it('derived data counts as unavailable when the browser was meant to run and did not', () => {
    const snapshot = makeSnapshot({ http: makeHttp(), collection: browserStatus('skipped', 'tls-blocked') });
    const sliced = sliceSnapshot(snapshot, ['http'], ['derived']);
    if (!sliced.ok) throw new Error('expected a slice');
    expect(sliced.slice.unavailable).toEqual(['derived']);
  });
});

describe('executeCheck with optional sections', () => {
  it('runs the check without its optional section and tells it whether the section was meant to be there', () => {
    seen.length = 0;
    const notRun = runCheck(
      readsBrowserIfThere,
      makeSnapshot({ http: makeHttp(), collection: browserStatus('not-run', 'not-required') }),
    );
    const skipped = runCheck(
      readsBrowserIfThere,
      makeSnapshot({ http: makeHttp(), collection: browserStatus('skipped', 'tls-blocked') }),
    );
    const present = runCheck(readsBrowserIfThere, makeSnapshot({ http: makeHttp(), browser: makeBrowser() }));
    expect([notRun.status, skipped.status, present.status]).toEqual(['completed', 'completed', 'completed']);
    expect(seen).toEqual([
      { browser: false, unavailable: [] },
      { browser: false, unavailable: ['browser'] },
      { browser: true, unavailable: [] },
    ]);
  });
});

describe('registry validates optional sections', () => {
  const withOptional = (optional: readonly string[], requires: readonly SnapshotSectionKey[] = ['http']) =>
    defineCheck({
      id: 'OPT-02',
      module: 'http',
      requires,
      optional: optional as SnapshotSectionKey[],
      variants: [{ variant: 'seen' }],
      run: () => [],
    });

  it('accepts known optional sections', () => {
    expect(() => new CheckRegistry([withOptional(['browser', 'documents'])])).not.toThrow();
  });

  it('rejects an unknown optional section', () => {
    expect(() => new CheckRegistry([withOptional(['browsr'])])).toThrow(
      new RegistryError('OPT-02: unknown optional section "browsr"'),
    );
  });

  it('rejects a section that is both required and optional', () => {
    expect(() => new CheckRegistry([withOptional(['http'])])).toThrow(
      new RegistryError('OPT-02: section "http" is both required and optional'),
    );
  });
});

describe('requiredCollectors', () => {
  it('starts the collectors of required sections only, not those of optional ones', () => {
    expect([...requiredCollectors([readsBrowserIfThere])]).toEqual(['http']);
  });

  it('a required browser section still starts the browser', () => {
    const browserCheck = defineCheck({
      id: 'OPT-03',
      module: 'browser',
      requires: ['derived'],
      optional: ['http'],
      variants: [{ variant: 'seen' }],
      run: () => [],
    });
    expect([...requiredCollectors([browserCheck])]).toEqual(['browser']);
  });
});
