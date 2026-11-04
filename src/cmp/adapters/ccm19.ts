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

/** In-page, self-contained. */
function readCcm19(essentialEmbeddings: string[]): Ccm19Read {
  const w = globalThis as unknown as {
    CCM?: { acceptedEmbeddings?: unknown; embeddings?: unknown };
    document: { cookie: string };
    localStorage: { length: number; key(i: number): string | null };
  };
  const ccm = w.CCM;

  /** A `ccm_consent` cookie or storage key exists, i.e. the visitor answered. */
  const isConsentStored = (): boolean => {
    if (w.document.cookie.split(';').some((c) => c.trim().startsWith('ccm_consent'))) return true;
    try {
      for (let i = 0; i < w.localStorage.length; i++) {
        if (w.localStorage.key(i)?.startsWith('ccm_consent')) return true;
      }
    } catch {
      // storage blocked
    }
    return false;
  };

  const names = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.map((e) => String((e as { name?: unknown } | null)?.name ?? e)) : null;
  const essential = new RegExp(essentialEmbeddings.join('|'), 'i');
  const optional = (n: string) => !essential.test(n);

  /** Embeddings by what was accepted: no optional one is `denied`, all of them `granted`, otherwise `partial`. */
  const embeddingsState = (accepted: string[] | null): CategoryState | null => {
    if (!accepted) return null;

    const acceptedOptional = accepted.filter(optional).length;
    const all = names(ccm?.embeddings);
    const totalOptional = all ? all.filter(optional).length : null;
    if (acceptedOptional === 0) return 'denied';
    return totalOptional !== null && acceptedOptional >= totalOptional ? 'granted' : 'partial';
  };

  const accepted = names(ccm?.acceptedEmbeddings);
  return {
    present: !!ccm,
    ready: !!ccm && accepted !== null,
    stored: isConsentStored(),
    embeddings: embeddingsState(accepted),
  };
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
