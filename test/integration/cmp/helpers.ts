/**
 * Shared scenarios for the CMP adapters against our own simulators in test/fixture-server/sites/cmp/<cmp>/
 * (hand-written HTML/JS, no vendor code), each in a fresh persistent profile with a plain Chrome UA.
 */
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signalKinds } from '../../../src/cmp/detection.ts';
import { extract, loadLexicon, waitForBanner, waitForCmp } from '../../../src/cmp/index.ts';
import type { ClickOutcome, CmpAdapter, CmpFacts, KnownCmpId, VerifyResult } from '../../../src/cmp/types.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../utils/classify.ts';

/** A normal desktop Chrome UA: no `HeadlessChrome`, no bot tokens. */
export const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export interface Session {
  browser: TestBrowser;
  page: Page;
}

export async function openSession(
  server: FixtureServer,
  url: string,
  ua: string = CHROME_UA,
): Promise<Session> {
  const browser = await launchTestBrowser(server, { args: [`--user-agent=${ua}`] });
  const page = browser.context.pages()[0] ?? (await browser.context.newPage());
  await page.goto(url, { waitUntil: 'load' });
  return { browser, page };
}

/** Fixture server + sessions closed after the suite; `unexpected` checked after every test. */
export function useCmpServer(sites: string[]) {
  const ctx: { server: FixtureServer; sessions: Session[] } = {
    server: undefined as unknown as FixtureServer,
    sessions: [],
  };
  beforeAll(async () => {
    ctx.server = await startFixtureServer({ sites });
  });
  afterEach(async () => {
    for (const s of ctx.sessions.splice(0)) await s.browser.close().catch(() => undefined);
    expect(ctx.server.unexpected).toEqual([]);
  });
  afterAll(async () => {
    await ctx.server?.close();
  });
  const open = async (url: string, ua?: string): Promise<Session> => {
    const s = await openSession(ctx.server, url, ua);
    ctx.sessions.push(s);
    return s;
  };
  return {
    get server() {
      return ctx.server;
    },
    open,
    /**
     * Opens `url` and expects `id` to be recognized; with `banner` it also waits for the banner, whether it appeared is
     * checked by the tests that care.
     */
    async openRecognized(url: string, id: KnownCmpId, opts: { ua?: string; banner?: boolean } = {}) {
      const { page } = await open(url, opts.ua);
      const adapter = await recognized(page, id);
      if (opts.banner) await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS });
      return { page, adapter };
    },
  };
}

/** Requests to `host` since `since` (ms epoch): the request log is shared by the tests of a suite. */
export function requestsSince(server: FixtureServer, host: string, since: number): number {
  return server.requestsTo(host).filter((r) => r.at >= since).length;
}

/** How long the tests wait for a CMP to be recognized or its banner to show up. */
export const CMP_WAIT_MS = 8_000;
/** A short look to confirm that the banner is still open after a refused click. */
const STILL_OPEN_PROBE_MS = 100;

export async function recognized(page: Page, id: KnownCmpId): Promise<CmpAdapter> {
  const { adapter, detection } = await waitForCmp(page, { timeoutMs: CMP_WAIT_MS });
  expect(adapter?.id).toBe(id);
  expect(detection.method).toBe('adapter');
  expect(detection.recognitionConfidence).toBe('high');
  expect(signalKinds(detection.signals).size).toBeGreaterThanOrEqual(2);
  return adapter as CmpAdapter;
}

/**
 * The collector's flow: measure the first screen, let the pure `classifyFirstLayer` decide, and have the adapter
 * execute exactly that target (`act(page, action, target)`).
 */
export async function decideAndAct(
  page: Page,
  adapter: CmpAdapter,
  action: 'reject' | 'accept',
): Promise<{ facts: CmpFacts; click: ClickOutcome }> {
  const facts = await extract(page, adapter, 'first-screen', { phase: action === 'reject' ? 'B' : 'C' });
  const target = classifyFirstLayer(facts, loadLexicon()).targets?.[action] ?? null;
  if (!adapter.act) throw new Error(`${adapter.id}: no act(page, action, target)`);
  return { facts, click: await adapter.act(page, action, target) };
}

export interface CmpScenario {
  id: KnownCmpId;
  site: string;
  okUrl: string;
  /** A blocking first layer without reject (→ blocking-no-reject), where the CMP offers one. */
  blockingUrl?: string;
  /** A non-blocking first layer without reject (→ nonblocking-no-reject). */
  nonblockingNoRejectUrl?: string;
  version?: string | null;
  rejectName: RegExp;
  acceptName: RegExp;
}

/** Verified by the categories of the state, right after the click and again after the reload. */
function expectVerifiedByState(verify: VerifyResult): void {
  expect(verify.reason).toBeUndefined();
  expect(verify.verified).toBe(true);
  expect(verify.persistedAfterReload).toBe(true);
  expect(verify.method).toContain('persisted-after-reload');
}

/** The first layer without reject: the table names the variant and no reject is clicked. */
async function expectNoRejectClicked(
  page: Page,
  adapter: CmpAdapter,
  facts: CmpFacts,
  variant: 'blocking-no-reject' | 'nonblocking-no-reject',
): Promise<void> {
  expect(facts.firstLayer.buttons.filter((b) => b.kind === 'reject' && b.layer === 1)).toEqual([]);
  const cls = classifyFirstLayer(facts, loadLexicon());
  expect(cls.variant).toBe(variant);
  expect(cls.confidence).toBe('high');
  expect(cls.acceptAvailableAtFirstLayer).toBe(true);

  const click = await adapter.reject(page, { facts, ...DEFAULT_CLASSIFY });

  expect(click.clicked).toBe(false);
  expect(click.error).toMatch(new RegExp(`^no-unambiguous-reject:${variant}`));
  expect(await waitForBanner(page, adapter, { timeoutMs: STILL_OPEN_PROBE_MS })).toBe(true);
}

export function describeCmpScenarios(
  s: CmpScenario,
  extra?: (env: ReturnType<typeof useCmpServer>) => void,
): void {
  describe(`${s.id} (simulator)`, () => {
    const env = useCmpServer([s.site]);
    const lexicon = loadLexicon();

    it('recognizes the CMP with high confidence and measures a first layer with a reject → ok', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id);
      expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });

      if (s.version !== undefined) expect(facts.detection.version).toBe(s.version);
      expect(facts.detection.versionSupported).not.toBe(false);
      expect(facts.firstLayer.bannerVisible).toBe(true);
      expect(facts.firstLayer.dialogNotOpened).toBeUndefined();
      const reject = facts.firstLayer.buttons.find((b) => b.kind === 'reject' && b.layer === 1);
      const accept = facts.firstLayer.buttons.find((b) => b.kind === 'accept' && b.layer === 1);
      expect(reject?.name).toMatch(s.rejectName);
      expect(reject?.actionableAtFirstScreen).toBe(true);
      expect(reject?.contrast).toBeGreaterThan(1);
      expect(accept?.name).toMatch(s.acceptName);
      expect(accept?.actionableAtFirstScreen).toBe(true);

      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('ok');
      expect(cls.targets?.reject?.name).toMatch(s.rejectName);

      // Measuring alone responds to nothing: no decision recorded, no geo or bot signal.
      expect(facts.state.length).toBeGreaterThan(0);
      expect(facts.state.filter((st) => st.decision?.responded === true)).toEqual([]);
      expect(facts.geoSignals).toEqual([]);
      expect(facts.botSignals).toEqual([]);
    });

    it('reject: clicks only the unambiguous reject, the banner closes, the state is read before and after the reload', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id, { banner: true });

      const { click } = await decideAndAct(page, adapter, 'reject');

      expect(click.error).toBeUndefined();
      expect(click.clicked).toBe(true);
      expect(click.button?.kind).toBe('reject');
      const verify = await adapter.verify(page, 'reject');
      expectVerifiedByState(verify);
      expect(verify.method).toContain('ui-closed');
      expect(verify.stateAfter.map((st) => st.origin)).toContain('action');
      expect(verify.stateAfter.map((st) => st.origin)).toContain('stored');
      const after = await adapter.extract(page, 'after-reload');
      expect(after.firstLayer.bannerVisible).toBe(false);
    });

    const blockingUrl = s.blockingUrl;
    if (blockingUrl) {
      it('blocking variant without reject on the first layer → blocking-no-reject, nothing is clicked', async () => {
        const { page, adapter } = await env.openRecognized(blockingUrl, s.id);
        expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

        const facts = await extract(page, adapter, 'first-screen');

        const { overlay, scrollLock, inert } = facts.blocking;
        expect([overlay, scrollLock, inert]).toContain(true);
        await expectNoRejectClicked(page, adapter, facts, 'blocking-no-reject');
      });
    }

    const nonblockingUrl = s.nonblockingNoRejectUrl;
    if (nonblockingUrl) {
      it('bar without reject on the first layer → nonblocking-no-reject, nothing is clicked', async () => {
        const { page, adapter } = await env.openRecognized(nonblockingUrl, s.id);
        expect(await waitForBanner(page, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);

        const facts = await extract(page, adapter, 'first-screen');

        const { overlay, scrollLock, inert } = facts.blocking;
        expect([overlay, scrollLock, inert]).toEqual([false, false, false]);
        await expectNoRejectClicked(page, adapter, facts, 'nonblocking-no-reject');
      });
    }

    it('accept: clicks accept, then reads the state again after the reload', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id, { banner: true });

      const { click } = await decideAndAct(page, adapter, 'accept');

      expect(click.clicked).toBe(true);
      expect(click.button?.name).toMatch(s.acceptName);
      expectVerifiedByState(await adapter.verify(page, 'accept'));
    });

    // The adapter executes the target core chose and decides nothing itself.
    it('act(page, action, target) clicks exactly the target chosen by classifyFirstLayer', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id, { banner: true });
      const facts = await extract(page, adapter, 'first-screen');
      const target = classifyFirstLayer(facts, lexicon).targets?.reject ?? null;
      expect(target).not.toBeNull();
      expect(typeof adapter.act).toBe('function');

      const click = await adapter.act?.(page, 'reject', target);

      expect(click?.clicked).toBe(true);
      expect(click?.button).toEqual({
        name: target?.name,
        role: target?.role,
        kind: target?.kind,
        kindConfidence: target?.kindConfidence,
      });
    });

    it('a null target from core is not overridden by a decision of the adapter', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id, { banner: true });
      const facts = await extract(page, adapter, 'first-screen');
      // The default lexicon would pick a reject here; core's decision (here: none) must win.
      expect(classifyFirstLayer(facts, lexicon).targets?.reject).not.toBeNull();

      const click = await adapter.reject(page, { facts, target: null, ...DEFAULT_CLASSIFY });
      const noTarget = await adapter.act?.(page, 'reject', null);

      expect(click).toMatchObject({ clicked: false, button: null, error: 'no-unambiguous-reject' });
      expect(noTarget).toMatchObject({ clicked: false, error: 'no-unambiguous-reject' });
      expect(await waitForBanner(page, adapter, { timeoutMs: STILL_OPEN_PROBE_MS })).toBe(true);
    });

    it('without facts and without a target the adapter does not measure and click on its own', async () => {
      const { page, adapter } = await env.openRecognized(s.okUrl, s.id, { banner: true });

      const click = await adapter.reject(page);

      expect(click).toMatchObject({ clicked: false, button: null, error: 'no-target' });
      expect(await waitForBanner(page, adapter, { timeoutMs: STILL_OPEN_PROBE_MS })).toBe(true);
    });

    extra?.(env);
  });
}
