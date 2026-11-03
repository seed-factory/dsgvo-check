/**
 * CCM19 (Papoo Software). The JS API is not publicly documented: state is derived from `CCM.acceptedEmbeddings` and
 * validated only against our simulator; geo and bot signals are not known.
 */
import type { Page } from 'playwright-core';
import { readerInput } from '../adapters-file.ts';
import type { CategoryState, ConsentStateFact } from '../types.ts';
import { defineAdapter } from './base.ts';

interface Ccm19Read {
  present: boolean;
  ready: boolean;
  stored: boolean;
  embeddings: CategoryState | null;
}

function readCcm19(essentialEmbeddings: string[]): Ccm19Read {
  const w = globalThis as unknown as {
    CCM?: { acceptedEmbeddings?: unknown; embeddings?: unknown };
    document: { cookie: string };
    localStorage: { length: number; key(i: number): string | null };
  };
  const ccm = w.CCM;
  let stored = w.document.cookie.split(';').some((c) => c.trim().startsWith('ccm_consent'));
  try {
    for (let i = 0; i < w.localStorage.length && !stored; i++) {
      if (w.localStorage.key(i)?.startsWith('ccm_consent')) stored = true;
    }
  } catch {
    // storage blocked
  }
  const names = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.map((e) => String((e as { name?: unknown } | null)?.name ?? e)) : null;
  const essential = new RegExp(essentialEmbeddings.join('|'), 'i');
  const optional = (n: string) => !essential.test(n);
  const accepted = names(ccm?.acceptedEmbeddings);
  const all = names(ccm?.embeddings);
  let embeddings: CategoryState | null = null;
  if (accepted) {
    const acceptedOptional = accepted.filter(optional).length;
    const totalOptional = all ? all.filter(optional).length : null;
    embeddings =
      acceptedOptional === 0
        ? 'denied'
        : totalOptional !== null && acceptedOptional >= totalOptional
          ? 'granted'
          : 'partial';
  }
  return { present: !!ccm, ready: !!ccm && accepted !== null, stored, embeddings };
}

const read = (page: Page) => page.evaluate(readCcm19, readerInput('ccm19', 'essentialEmbeddings'));

export const ccm19 = defineAdapter({
  id: 'ccm19',
  async readState(page): Promise<ConsentStateFact[]> {
    const r = await read(page);
    if (!r.present) return [];
    const categories: Record<string, CategoryState> = r.embeddings ? { embeddings: r.embeddings } : {};
    return [
      {
        source: 'api',
        ready: r.ready ? 'ready' : 'loading',
        categories,
        origin: r.stored ? 'stored' : 'default',
        decision: { responded: r.stored, method: r.stored ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).ready,
});
