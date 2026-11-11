/**
 * Usercentrics v3 and v2. The banner lives in open shadow DOM (measured and clicked through it); the shape of
 * `getConsentDetails()` is read defensively.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { CategoryState } from '../types.ts';
import { defineAdapter } from './base.ts';
import { flag, maybeFlag, readerResult } from './read.ts';

interface UsercentricsRead {
  v3: boolean;
  v2: boolean;
  initialized: boolean;
  categories: Record<string, CategoryState>;
  responded: boolean | 'unknown';
  method: 'explicit' | 'implied' | 'unknown';
  consentRequired: boolean | null;
}

/** In-page, self-contained, async (the v3 API returns promises). Read-only calls only. */
async function readUsercentrics(): Promise<UsercentricsRead> {
  type Fn = (...a: unknown[]) => unknown;
  type Api = Record<string, Fn | undefined>;
  type State = Omit<UsercentricsRead, 'v3' | 'v2'>;
  const w = globalThis as unknown as {
    __ucCmp?: Api;
    UC_UI?: Api;
    localStorage: { getItem(k: string): string | null };
    setTimeout: typeof setTimeout;
  };
  /** An API call that does not answer within this time counts as no answer. */
  const CALL_TIMEOUT_MS = 2000;
  /** v3 `consent.type` to the recorded answer; any other type (or none) is unknown. */
  const ANSWER_BY_CONSENT_TYPE: Record<string, Pick<State, 'responded' | 'method'>> = {
    EXPLICIT: { responded: true, method: 'explicit' },
    IMPLICIT: { responded: false, method: 'implied' },
  };

  const withTimeout = async (v: unknown): Promise<unknown> =>
    Promise.race([Promise.resolve(v), new Promise((r) => w.setTimeout(() => r(undefined), CALL_TIMEOUT_MS))]);

  const call = async (obj: Api | undefined, name: string): Promise<unknown> => {
    const f = obj?.[name];
    if (typeof f !== 'function') return undefined;
    try {
      return await withTimeout(f.call(obj));
    } catch {
      return undefined;
    }
  };

  const stateOf = (v: unknown): CategoryState => {
    if (v === true) return 'granted';
    if (v === false) return 'denied';

    const s = String(
      (v as { state?: unknown; status?: unknown } | null)?.state ??
        (v as { status?: unknown } | null)?.status ??
        '',
    );
    if (/ALL_ACCEPTED|^ACCEPTED$|^true$/i.test(s)) return 'granted';
    if (/ALL_DENIED|^DENIED$|^false$/i.test(s)) return 'denied';
    if (/SOME/i.test(s)) return 'partial';
    return 'unknown';
  };

  const emptyState = (): State => ({
    initialized: false,
    categories: {},
    responded: 'unknown',
    method: 'unknown',
    consentRequired: null,
  });

  const readV3 = async (api: Api): Promise<State> => {
    const state = emptyState();
    state.initialized = (await call(api, 'isInitialized')) === true;

    const details = (await call(api, 'getConsentDetails')) as
      | { consent?: { type?: unknown }; categories?: Record<string, unknown> }
      | undefined;
    if (details) {
      state.initialized = true;
      for (const [id, v] of Object.entries(details.categories ?? {})) {
        const essential =
          (v as { essential?: unknown } | null)?.essential === true || /^essential$/i.test(id);
        if (!essential) state.categories[id] = stateOf(v);
      }

      const type = String(details.consent?.type ?? '').toUpperCase();
      const answer = ANSWER_BY_CONSENT_TYPE[type];
      if (answer) {
        state.responded = answer.responded;
        state.method = answer.method;
      }
    }

    const req = await call(api, 'isConsentRequired');
    state.consentRequired = typeof req === 'boolean' ? req : null;
    return state;
  };

  /** v2 lists services, not categories: a category is granted when all its optional services are. */
  const categoriesOfServices = (services: unknown[]): Record<string, CategoryState> => {
    const byCat: Record<string, boolean[]> = {};
    for (const s of services as Array<{
      categorySlug?: unknown;
      isEssential?: unknown;
      consent?: { status?: unknown };
    }>) {
      if (s.isEssential === true) continue;

      const cat = typeof s.categorySlug === 'string' ? s.categorySlug : 'uncategorized';
      const list = byCat[cat] ?? [];
      list.push(s.consent?.status === true);
      byCat[cat] = list;
    }

    const categories: Record<string, CategoryState> = {};
    for (const [cat, list] of Object.entries(byCat)) {
      categories[cat] = list.every(Boolean) ? 'granted' : list.some(Boolean) ? 'partial' : 'denied';
    }
    return categories;
  };

  const readV2 = async (api: Api): Promise<State> => {
    const state = emptyState();
    state.initialized = (await call(api, 'isInitialized')) === true;

    const services = await call(api, 'getServicesBaseInfo');
    if (Array.isArray(services)) state.categories = categoriesOfServices(services);

    let interaction: string | null = null;
    try {
      interaction = w.localStorage.getItem('uc_user_interaction');
    } catch {
      interaction = null;
    }
    state.responded =
      interaction === 'true' ? true : interaction === 'false' || interaction === null ? false : 'unknown';
    state.method = state.responded === true ? 'explicit' : 'unknown';
    return state;
  };

  // Both globals are read once, before any await: a v3 loader that appears while a v2 read is in flight must not turn
  // the v2 state into a v3 one.
  const v3Api = w.__ucCmp;
  const v2Api = w.UC_UI;

  let state = emptyState();
  if (v3Api) state = await readV3(v3Api);
  else if (v2Api) state = await readV2(v2Api);

  return { v3: !!v3Api, v2: !!v2Api, ...state };
}

/**
 * The reader's answer in the shape it builds. The category ids come from the page's API; the stored state keeps only
 * names among them (`foldCategories`), so a custom category with a UUID-like id is kept as `other`.
 */
const UsercentricsAnswer = z.object({
  v3: flag,
  v2: flag,
  initialized: flag,
  categories: z
    .record(z.string(), z.enum(['denied', 'granted', 'partial', 'unknown']).catch('unknown'))
    .catch({}),
  responded: z.union([z.boolean(), z.literal('unknown')]).catch('unknown'),
  method: z.enum(['explicit', 'implied', 'unknown']).catch('unknown'),
  consentRequired: maybeFlag,
});

const read = async (page: Page): Promise<UsercentricsRead> =>
  readerResult(UsercentricsAnswer, await page.evaluate(readUsercentrics));

export const usercentrics = defineAdapter({
  id: 'usercentrics',
  async readState(page) {
    const r = await read(page);
    if (!r.v3 && !r.v2) return [];

    const geo = r.v3 && r.consentRequired === false && r.responded !== true;
    return [
      {
        source: 'api',
        ready: r.initialized ? 'ready' : 'loading',
        categories: r.categories,
        origin: geo ? 'special-branch' : r.responded === true ? 'stored' : 'default',
        decision: { responded: r.responded, method: r.method },
        scope: r.v3 ? 'v3' : 'v2',
      },
    ];
  },
  async readGeo(page) {
    const r = await read(page);
    // After an explicit answer isConsentRequired() is false as well — only without an answer it means "no banner here".
    return r.v3 && r.consentRequired === false && r.responded !== true
      ? [{ cmpId: 'usercentrics', signal: 'usercentrics:isConsentRequired=false' }]
      : [];
  },
  async readConfig(page) {
    const r = await read(page);
    return { config: { 'usercentrics.version': r.v3 ? '3' : r.v2 ? '2' : null }, closeMeansAccept: null };
  },
  isReady: async (page) => (await read(page)).initialized,
});
