/**
 * CCM19 (Papoo Software). Signals: `window.CCM`, script `…ccm19…/app.js?apiKey=…`, `#ccm-widget`, stored consent
 * `ccm_consent*` (cookie or localStorage, depending on the installation). ⚠ The JS API is not publicly documented:
 * state is derived from `CCM.acceptedEmbeddings` (optional = not CCM19/essential) and is validated only against our
 * simulator; geo and bot signals are not known (gap).
 */
import type { Page } from 'playwright-core';
import type { CategoryState, ConsentStateFact } from '../types.ts';
import { defineAdapter } from './base.ts';

interface Ccm19Read {
  present: boolean;
  ready: boolean;
  stored: boolean;
  embeddings: CategoryState | null;
}

/** In-page, self-contained. */
function readCcm19(): Ccm19Read {
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
  const optional = (n: string) => !/ccm19|essen[tz]i|notwendig|technisch|necessary/i.test(n);
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

const read = (page: Page) => page.evaluate(readCcm19);

export const ccm19 = defineAdapter({
  id: 'ccm19',
  name: 'CCM19',
  supportedVersions: null,
  detect: {
    globals: ['CCM'],
    scripts: [{ label: 'ccm19 app.js?apiKey', pattern: 'ccm19[^?]*/app\\.js\\?(.*&)?apiKey=' }],
    dom: ['#ccm-widget'],
    cookies: ['^ccm_consent'],
    storage: ['^ccm_consent'],
  },
  banner: {
    containers: ['#ccm-widget.ccm-show .ccm-modal-inner', '#ccm-widget .ccm-modal', '#ccm-widget'],
    overlays: ['#ccm-widget .ccm-modal--overlay'],
    vendorRoles: [
      { selector: '.ccm--decline-cookies', role: 'reject' },
      { selector: '[data-full-consent="true"]', role: 'accept' },
      { selector: '.ccm--ctrl-init', role: 'settings' },
      { selector: '.ccm--save-settings:not([data-full-consent="true"])', role: 'save' },
      { selector: '.ccm-modal--close', role: 'close' },
    ],
  },
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
