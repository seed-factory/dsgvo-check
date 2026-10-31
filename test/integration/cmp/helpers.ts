/**
 * Shared L2 scenarios for the seven CMP adapters against our own simulators in test/fixture-server/sites/cmp/<cmp>/
 * (hand-written HTML/JS that mimics DOM ids, the global API and the consent cookie — no vendor code).
 * Every scenario runs in a fresh persistent profile (like a fresh phase) with a plain Chrome UA.
 */
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signalKinds } from '../../../src/cmp/detection.ts';
import {
  classifyFirstLayer,
  extract,
  loadLexicon,
  waitForBanner,
  waitForCmp,
} from '../../../src/cmp/index.ts';
import type { ClickOutcome, CmpAdapter, CmpFacts, KnownCmpId } from '../../../src/cmp/types.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';

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
  return {
    get server() {
      return ctx.server;
    },
    async open(url: string, ua?: string): Promise<Session> {
      const s = await openSession(ctx.server, url, ua);
      ctx.sessions.push(s);
      return s;
    },
  };
}

export async function recognized(page: Page, id: KnownCmpId): Promise<CmpAdapter> {
  const { adapter, detection } = await waitForCmp(page, { timeoutMs: 8000 });
  expect(adapter?.id).toBe(id);
  expect(detection.method).toBe('adapter');
  expect(detection.recognitionConfidence).toBe('high');
  expect(signalKinds(detection.signals).size).toBeGreaterThanOrEqual(2);
  return adapter as CmpAdapter;
}

/**
 * The collector's D12 flow: measure the first screen, let the pure `classifyFirstLayer` decide, and have the adapter
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
  blockingUrl: string;
  version?: string | null;
  rejectName: RegExp;
  acceptName: RegExp;
}

export function describeCmpScenarios(
  s: CmpScenario,
  extra?: (env: ReturnType<typeof useCmpServer>) => void,
): void {
  describe(`${s.id} (simulator)`, () => {
    const env = useCmpServer([s.site]);
    const lexicon = loadLexicon();

    it('recognizes the CMP with high confidence and measures a first layer with a reject → ok', async () => {
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });
      if (s.version !== undefined) expect(facts.detection.version).toBe(s.version);
      expect(facts.detection.versionSupported).not.toBe(false);
      expect(facts.firstLayer.bannerVisible).toBe(true);
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
      expect(facts.state.length).toBeGreaterThan(0);
      expect(facts.state.every((st) => st.decision?.responded !== true)).toBe(true);
      expect(facts.geoSignals).toEqual([]);
      expect(facts.botSignals).toEqual([]);
    });

    it('reject: clicks only the unambiguous reject, verifies it by state and after reload', async () => {
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const { click } = await decideAndAct(page, adapter, 'reject');
      expect(click.error).toBeUndefined();
      expect(click.clicked).toBe(true);
      expect(click.button?.kind).toBe('reject');
      const verify = await adapter.verify(page, 'reject');
      expect(verify.reason).toBeUndefined();
      expect(verify.verified).toBe(true);
      expect(verify.persistedAfterReload).toBe(true);
      expect(verify.method).toContain('persisted-after-reload');
      expect(verify.method).toContain('ui-closed');
      expect(verify.stateAfter.some((st) => st.origin === 'action')).toBe(true);
      expect(verify.stateAfter.some((st) => st.origin === 'stored')).toBe(true);
      const after = await adapter.extract(page, 'after-reload');
      expect(after.firstLayer.bannerVisible).toBe(false);
    });

    it('blocking variant without reject on the first layer → blocking-no-reject, nothing is clicked', async () => {
      const { page } = await env.open(s.blockingUrl);
      const adapter = await recognized(page, s.id);
      expect(await waitForBanner(page, adapter, { timeoutMs: 8000 })).toBe(true);
      const facts = await extract(page, adapter, 'first-screen');
      expect(facts.blocking.overlay || facts.blocking.scrollLock || facts.blocking.inert).toBe(true);
      expect(facts.firstLayer.buttons.some((b) => b.kind === 'reject' && b.layer === 1)).toBe(false);
      const cls = classifyFirstLayer(facts, lexicon);
      expect(cls.variant).toBe('blocking-no-reject');
      expect(cls.confidence).toBe('high');
      expect(cls.acceptAvailableAtFirstLayer).toBe(true);
      const click = await adapter.reject(page, { facts });
      expect(click.clicked).toBe(false);
      expect(click.error).toMatch(/^no-unambiguous-reject:blocking-no-reject/);
      expect(await waitForBanner(page, adapter, { timeoutMs: 100 })).toBe(true);
    });

    it('accept: clicks accept and verifies the granted state after reload', async () => {
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const { click } = await decideAndAct(page, adapter, 'accept');
      expect(click.clicked).toBe(true);
      expect(click.button?.name).toMatch(s.acceptName);
      const verify = await adapter.verify(page, 'accept');
      expect(verify.reason).toBeUndefined();
      expect(verify.verified).toBe(true);
      expect(verify.persistedAfterReload).toBe(true);
    });

    // S-31 (D12): the adapter executes the target core chose and decides nothing itself.
    it('act(page, action, target) clicks exactly the target chosen by classifyFirstLayer', async () => {
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
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
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const facts = await extract(page, adapter, 'first-screen');
      // The default lexicon would pick a reject here; core's decision (here: none) must win.
      expect(classifyFirstLayer(facts, lexicon).targets?.reject).not.toBeNull();
      const click = await adapter.reject(page, { facts, target: null });
      expect(click).toMatchObject({ clicked: false, button: null, error: 'no-unambiguous-reject' });
      const noTarget = await adapter.act?.(page, 'reject', null);
      expect(noTarget).toMatchObject({ clicked: false, error: 'no-unambiguous-reject' });
      expect(await waitForBanner(page, adapter, { timeoutMs: 100 })).toBe(true);
    });

    it('without facts and without a target the adapter does not measure and click on its own', async () => {
      const { page } = await env.open(s.okUrl);
      const adapter = await recognized(page, s.id);
      await waitForBanner(page, adapter, { timeoutMs: 8000 });
      const click = await adapter.reject(page);
      expect(click).toMatchObject({ clicked: false, button: null, error: 'no-target' });
      expect(await waitForBanner(page, adapter, { timeoutMs: 100 })).toBe(true);
    });

    extra?.(env);
  });
}
