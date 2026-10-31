// biome-ignore-all lint/suspicious/noExplicitAny: in-page callbacks run in Chromium; tsconfig has no DOM lib
/**
 * Minimal CMP stub for the `browser/cmp-stub` fixture site: implements the `CmpApi` the collector uses and a
 * `CmpAdapter` for the hand-written banner. Stands in for M2's adapters in collector tests only; the production
 * collector uses `src/cmp/index.ts`.
 */
import type { Page } from 'playwright-core';
import type {
  CmpAdapter,
  CmpButton,
  CmpDetection,
  CmpFacts,
  ConsentStateFact,
  KnownCmpId,
  VerifyResult,
} from '../../../src/cmp/types.ts';
import type { CmpApi } from '../../../src/collectors/browser/index.ts';

declare const document: any;
declare const window: any;

const DETECTION: CmpDetection = {
  cmpId: 'stub',
  method: 'adapter',
  version: '1.0.0',
  versionSupported: true,
  recognitionConfidence: 'high',
  signals: ['dom:#stub-cmp', 'global:StubCmp'],
};

async function present(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('#stub-cmp') && window.StubCmp));
}

async function state(page: Page): Promise<ConsentStateFact[]> {
  const s: string = await page.evaluate(() => (window.StubCmp ? window.StubCmp.state() : 'unknown'));
  const analytics = s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'unknown';
  return [
    {
      source: 'api',
      ready: 'ready',
      categories: { analytics },
      origin: s === 'unknown' ? 'default' : 'action',
    },
  ];
}

async function facts(page: Page, moment: CmpFacts['moment']): Promise<CmpFacts> {
  const raw = await page.evaluate(() => {
    const root = document.querySelector('#stub-cmp');
    if (!root) return null;
    const visible = root.checkVisibility();
    const buttons = Array.from(root.querySelectorAll('button')).map((b: any) => {
      const r = b.getBoundingClientRect();
      return {
        id: b.id,
        name: b.textContent.trim(),
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    });
    return { visible, buttons };
  });
  const buttons: CmpButton[] = (raw?.buttons ?? []).map(
    (b: { id: string; name: string; box: CmpButton['box'] }) => ({
      role: 'button',
      name: b.name,
      tag: 'button',
      kind: b.id === 'stub-reject' ? 'reject' : 'accept',
      kindConfidence: 'high',
      layer: 1,
      box: b.box,
      visibleAtFirstScreen: Boolean(raw?.visible),
      actionableAtFirstScreen: Boolean(raw?.visible),
      contrast: null,
      selector: `#${b.id}`,
    }),
  );
  return {
    phase: 'B',
    pageUrl: page.url(),
    moment,
    takenAt: new Date().toISOString(),
    viewport: page.viewportSize() ?? { width: 0, height: 0 },
    detection: raw
      ? DETECTION
      : { ...DETECTION, cmpId: null, method: 'none', recognitionConfidence: 'low', signals: [] },
    firstLayer: {
      bannerPresent: Boolean(raw),
      bannerVisible: Boolean(raw?.visible),
      buttons,
      purAbo: false,
      closeMeansAccept: null,
    },
    blocking: { overlay: false, scrollLock: false, inert: false, coveredRatio: 0.2, method: [] },
    state: raw ? await state(page) : [],
    geoSignals: [],
    botSignals: [],
    config: {},
  };
}

async function click(page: Page, action: 'reject' | 'accept') {
  const name = action === 'reject' ? 'Ablehnen' : 'Alle akzeptieren';
  await page.locator(action === 'reject' ? '#stub-reject' : '#stub-accept').click({ timeout: 5_000 });
  return {
    action,
    clicked: true,
    button: { name, role: 'button', kind: action, kindConfidence: 'high' as const },
  };
}

export const stubAdapter: CmpAdapter = {
  id: 'stub' as KnownCmpId,
  name: 'Stub CMP',
  supportedVersions: '1.x',
  detect: async (page) => ((await present(page)) ? DETECTION : null),
  extract: (page, moment) => facts(page, moment),
  state,
  geoSignals: async () => [],
  botSignals: async () => [],
  firstLayer: async (page) => (await facts(page, 'first-screen')).firstLayer,
  reject: (page) => click(page, 'reject'),
  accept: (page) => click(page, 'accept'),
  verify: async (page, action): Promise<VerifyResult> => {
    const after = await state(page);
    const want = action === 'reject' ? 'denied' : 'granted';
    return {
      action,
      verified: after[0]?.categories.analytics === want,
      method: ['api:stub'],
      stateAfter: after,
      persistedAfterReload: null,
    };
  },
};

/**
 * Calls are counted so tests can see that the collector went through the CMP API. `overrides` replace adapter
 * methods (e.g. a reject that fires a request before pressing the button).
 */
export function stubCmpApi(overrides: Partial<CmpAdapter> = {}): CmpApi & { calls: string[] } {
  const calls: string[] = [];
  const adapter: CmpAdapter = { ...stubAdapter, ...overrides };
  return {
    calls,
    detectCmp: async (page) => {
      calls.push('detect');
      return (await present(page))
        ? { adapter, detection: DETECTION }
        : {
            adapter: null,
            detection: {
              ...DETECTION,
              cmpId: null,
              method: 'none',
              recognitionConfidence: 'low',
              signals: [],
            },
          };
    },
    extract: async (page, _adapter, moment) => {
      calls.push(`extract:${moment}`);
      return facts(page, moment);
    },
  };
}
