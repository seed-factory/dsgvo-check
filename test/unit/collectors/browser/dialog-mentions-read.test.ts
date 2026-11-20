/**
 * When the browser collector reads the consent dialog for the catalog services it names (no browser, a stub CMP API):
 * only on a first screen of phase A where the CMP's own adapter recognised the banner with confidence `high`, once per
 * scan, on the first such page. A failed read is not repeated on a later page; the section says it failed, so that
 * PRIV-01 can name it.
 */
import type { BrowserType, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { CmpAdapter, CmpDetection, CmpFacts } from '../../../../src/cmp/types.ts';
import { type CmpApi, CmpBridge } from '../../../../src/collectors/browser/cmp-bridge.ts';
import { BrowserCollection, type Session } from '../../../../src/collectors/browser/collector.ts';
import { parseConfigInput } from '../../../../src/core/config/load.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import type { PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import type { CollectorContext } from '../../../../src/core/snapshot/collector.ts';
import { parseTarget } from '../../../../src/core/url/url.ts';
import { DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { makeCmpFacts, makePage, makeSnapshot } from '../../../utils/snapshot-builder.ts';
import { fakeRecorder } from './fakes.ts';

const HOME = 'https://www.example.test/';
const KONTAKT = 'https://www.example.test/kontakt/';
const borlabs = { id: 'borlabs', name: 'Borlabs Cookie' } as CmpAdapter;

const byAdapter: CmpDetection = {
  cmpId: 'borlabs',
  method: 'adapter',
  version: '3.2.1',
  versionSupported: true,
  recognitionConfidence: 'high',
  signals: [],
};

interface Stub {
  detection?: CmpDetection;
  adapter?: CmpAdapter | null;
  bannerPresent?: boolean;
  /** What the reader does on each call, in order; the last one repeats. */
  reads?: Array<'text' | 'throw' | 'none'>;
}

function setup(stub: Stub = {}) {
  const target = parseTarget(HOME);
  const ctx = {
    target,
    config: parseConfigInput({}),
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    now: () => new Date(),
    log: silentLogger,
    snapshot: makeSnapshot({ target }),
  } as unknown as CollectorContext;

  const reads = stub.reads ?? ['text'];
  let calls = 0;
  const api: CmpApi = {
    detectCmp: async () => ({
      adapter: stub.adapter === undefined ? borlabs : stub.adapter,
      detection: stub.detection ?? byAdapter,
    }),
    extract: async (): Promise<CmpFacts> => {
      const f = makeCmpFacts({ detection: stub.detection ?? byAdapter });
      f.firstLayer = { ...f.firstLayer, bannerPresent: stub.bannerPresent ?? true, bannerVisible: true };
      return f;
    },
    dialogText: async () => {
      const what = reads[Math.min(calls, reads.length - 1)];
      calls++;
      if (what === 'throw') throw new Error('page.evaluate: Timeout 1000ms exceeded');
      return what === 'none' ? null : { text: 'Cookie-Details Name Google Tag Manager', truncated: false };
    },
  };

  const c = new BrowserCollection(ctx, { cmp: api, chromium: {} as BrowserType, phases: ['A'] });
  const { ctx: browserContext, rec: recorder } = fakeRecorder({
    etld1: 'example.test',
    counter: c.counter,
    start: HOME,
  });
  const record: PhaseRecord = {
    phase: 'A',
    status: 'completed',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    profile: 'persistent-tmp',
    pages: [],
    requests: [],
    cookies: [],
    storage: [],
    errors: [],
  };
  const session = (phase: 'A' | 'B') =>
    ({
      phase,
      page: {} as Page,
      recorder,
      jar: { snapshot: async () => [] },
      browser: { context: browserContext },
      cmp: new CmpBridge(api, 1_000, record.errors, phase, DEFAULT_CLASSIFY),
      cmpFacts: { phase, facts: [] },
      record,
    }) as unknown as Session;
  const visit = (url: string) => ({ visit: makePage({ url }) }) as never;
  const s = session('A');
  return {
    c,
    record,
    calls: () => calls,
    firstScreen: (url: string) => c.afterPage(s, visit(url), 'first-screen'),
    afterPage: (phase: 'A' | 'B', url: string, moment: CmpFacts['moment']) =>
      c.afterPage(session(phase), visit(url), moment, borlabs),
  };
}

describe('the collector reads the dialog for the services it names', () => {
  it('of the first page of phase A whose banner the own adapter recognised with high confidence, once', async () => {
    const t = setup();
    await t.firstScreen(HOME);
    await t.firstScreen(KONTAKT);

    expect(t.calls()).toBe(1);
    expect(t.c.cmpSection.dialogMentions).toMatchObject({
      cmpId: 'borlabs',
      pageUrl: HOME,
      version: '3.2.1',
      services: [{ serviceId: 'google-tag-manager', term: 'Google Tag Manager' }],
    });
    expect(JSON.stringify(t.c.cmpSection)).not.toContain('Cookie-Details');
    expect(t.c.cmpSection.dialogMentionsFailed).toBeUndefined();
  });

  it.each<[string, Stub]>([
    ['the generic heuristic found the banner', { detection: { ...byAdapter, method: 'heuristic' } }],
    [
      'the adapter recognised it with medium confidence',
      { detection: { ...byAdapter, recognitionConfidence: 'medium' } },
    ],
    ['the detection names another CMP than the adapter', { detection: { ...byAdapter, cmpId: 'cookiebot' } }],
    ['no banner is in the page', { bannerPresent: false }],
    ['no adapter recognised a CMP', { adapter: null }],
  ])('counterexample: not when %s', async (_, stub) => {
    const t = setup(stub);
    await t.firstScreen(HOME);

    expect(t.calls()).toBe(0);
    expect(t.c.cmpSection.dialogMentions).toBeUndefined();
    expect(t.c.cmpSection.dialogMentionsFailed).toBeUndefined();
  });

  it.each<[string, 'A' | 'B', CmpFacts['moment']]>([
    ['in phase B', 'B', 'first-screen'],
    ['after a reload', 'A', 'after-reload'],
  ])('counterexample: not %s', async (_, phase, moment) => {
    const t = setup();
    await t.afterPage(phase, HOME, moment);

    expect(t.calls()).toBe(0);
    expect(t.c.cmpSection.dialogMentions).toBeUndefined();
  });

  it('a failed read is recorded, not repeated on the next page, and leaves no text', async () => {
    const t = setup({ reads: ['throw', 'text'] });
    await t.firstScreen(HOME);
    await t.firstScreen(KONTAKT);

    expect(t.calls()).toBe(1);
    expect(t.c.cmpSection.dialogMentions).toBeUndefined();
    expect(t.c.cmpSection.dialogMentionsFailed).toBe(true);
    expect(t.record.errors.map((e) => [e.code, e.url])).toEqual([['cmp-dialog-mentions-failed', HOME]]);
  });

  it('a dialog whose container is not there is no failure: nothing is stored or marked', async () => {
    const t = setup({ reads: ['none'] });
    await t.firstScreen(HOME);

    expect(t.calls()).toBe(1);
    expect(t.c.cmpSection.dialogMentions).toBeUndefined();
    expect(t.c.cmpSection.dialogMentionsFailed).toBeUndefined();
    expect(t.record.errors).toEqual([]);
  });
});
