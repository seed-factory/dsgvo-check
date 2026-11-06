/**
 * CCM19 (Papoo Software). The JS API is not publicly documented: state is derived from `CCM.acceptedEmbeddings` and
 * validated only against our simulator; geo and bot signals are not known. CCM19 renders its widget hidden with
 * disabled controls and opens it later; a widget it never opens is reported as `dialogNotOpened`.
 */
import type { Page } from 'playwright-core';
import { readerInput } from '../adapters-file.ts';
import type { CategoryState, ConsentStateFact } from '../types.ts';
import { defineAdapter } from './base.ts';

interface Ccm19Input {
  essentialEmbeddings: string[];
  closedDialog: { container: string; controls: string };
}

interface Ccm19Read {
  present: boolean;
  ready: boolean;
  stored: boolean;
  embeddings: CategoryState | null;
  /** The widget is in the page, not rendered, and every one of its controls is disabled. */
  closed: boolean;
}

/** In-page, self-contained. */
function readCcm19(input: Ccm19Input): Ccm19Read {
  interface DElement {
    hidden: boolean;
    disabled?: boolean;
    hasAttribute(name: string): boolean;
    getClientRects(): { length: number };
    querySelectorAll(sel: string): ArrayLike<DElement>;
  }
  const w = globalThis as unknown as {
    CCM?: { acceptedEmbeddings?: unknown; embeddings?: unknown };
    document: { cookie: string; querySelector(sel: string): DElement | null };
    localStorage: { length: number; key(i: number): string | null };
    getComputedStyle(el: DElement): { display: string; visibility: string };
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

  /** Hidden by the attribute, by its style or without any box, and not one control enabled. */
  const isClosed = (): boolean => {
    let el: DElement | null = null;
    try {
      el = w.document.querySelector(input.closedDialog.container);
    } catch {
      return false;
    }
    if (!el) return false;
    const style = w.getComputedStyle(el);
    const notRendered =
      el.hidden ||
      el.hasAttribute('hidden') ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      el.getClientRects().length === 0;
    if (!notRendered) return false;

    const controls = Array.from(el.querySelectorAll(input.closedDialog.controls));
    return controls.length > 0 && controls.every((c) => c.disabled === true || c.hasAttribute('disabled'));
  };

  const names = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.map((e) => String((e as { name?: unknown } | null)?.name ?? e)) : null;
  const essential = new RegExp(input.essentialEmbeddings.join('|'), 'i');
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
    closed: isClosed(),
  };
}

const read = (page: Page) =>
  page.evaluate(readCcm19, {
    essentialEmbeddings: readerInput('ccm19', 'essentialEmbeddings'),
    closedDialog: readerInput('ccm19', 'closedDialog'),
  });

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
  // A widget kept closed for a visitor who answered is the normal case, not one that was never opened.
  async readDialogNotOpened(page) {
    const r = await read(page);
    return r.closed && !r.stored;
  },
  isReady: async (page) => (await read(page)).ready,
});
