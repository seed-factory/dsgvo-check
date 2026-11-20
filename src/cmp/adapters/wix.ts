/**
 * The cookie banner of Wix sites. Read only through `consentPolicyManager.getCurrentConsentPolicy()`: while the visitor
 * has not answered, Wix reports its default policy (`defaultPolicy: true`). Essential processing is always on.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { readerInput } from '../adapters-file.ts';
import { defineAdapter, toCategoryStates } from './base.ts';
import { categoryFlags, flag, maybeFlag, readerResult } from './read.ts';

interface WixRead {
  present: boolean;
  /** The policy could be read. */
  ready: boolean;
  defaultPolicy: boolean | null;
  categories: Record<string, boolean | null>;
}

/**
 * In-page, self-contained; `optionalGroups` are the policy categories besides `essential` and `dataToThirdParty`, which
 * stays on whatever the visitor answers in the banner (see adapters.yaml).
 */
function readWix(optionalGroups: string[]): WixRead {
  interface Manager {
    getCurrentConsentPolicy?: () => { defaultPolicy?: unknown; policy?: Record<string, unknown> } | null;
  }
  const w = globalThis as unknown as { consentPolicyManager?: Manager };
  const manager = w.consentPolicyManager;

  let current: ReturnType<NonNullable<Manager['getCurrentConsentPolicy']>> = null;
  try {
    current =
      typeof manager?.getCurrentConsentPolicy === 'function' ? manager.getCurrentConsentPolicy() : null;
  } catch {
    current = null;
  }

  const policy = current?.policy;
  const categories: Record<string, boolean | null> = {};
  if (policy && typeof policy === 'object') {
    for (const c of optionalGroups)
      categories[c] = typeof policy[c] === 'boolean' ? (policy[c] as boolean) : null;
  }

  return {
    present: !!manager,
    ready: !!policy && typeof policy === 'object',
    defaultPolicy: typeof current?.defaultPolicy === 'boolean' ? current.defaultPolicy : null,
    categories,
  };
}

const WixAnswer = z.object({
  present: flag,
  ready: flag,
  defaultPolicy: maybeFlag,
  categories: categoryFlags,
});

const read = async (page: Page): Promise<WixRead> =>
  readerResult(WixAnswer, await page.evaluate(readWix, readerInput('wix', 'optionalGroups')));

export const wix = defineAdapter({
  id: 'wix',
  async readState(page) {
    const r = await read(page);
    if (!r.present) return [];

    const responded = r.defaultPolicy === null ? 'unknown' : !r.defaultPolicy;
    return [
      {
        source: 'api',
        ready: r.ready ? 'ready' : 'loading',
        categories: toCategoryStates(r.categories),
        origin: responded === true ? 'stored' : 'default',
        decision: { responded, method: responded === true ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).ready,
});
