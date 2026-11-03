/**
 * CookieHub. Only read-only API calls: `denyAll()` and the like are never used, since CookieHub forbids bypassing the
 * UI. Geo and bot signals are not known.
 */
import type { Page } from 'playwright-core';
import { defineAdapter, toCategoryStates } from './base.ts';

interface CookiehubRead {
  present: boolean;
  ready: boolean;
  answered: boolean | null;
  categories: Record<string, boolean | null>;
  cookiePresent: boolean;
}

function readCookiehub(): CookiehubRead {
  const w = globalThis as unknown as {
    cookiehub?: { hasAnswered?: () => unknown; hasConsented?: (c: string) => unknown };
    document: { cookie: string };
  };
  const ch = w.cookiehub;
  const call = (f: () => unknown): boolean | null => {
    try {
      const v = f();
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  };
  const answered = typeof ch?.hasAnswered === 'function' ? call(() => ch.hasAnswered?.()) : null;
  const categories: Record<string, boolean | null> = {};
  if (typeof ch?.hasConsented === 'function') {
    for (const c of ['preferences', 'analytics', 'marketing'])
      categories[c] = call(() => ch.hasConsented?.(c));
  }
  return {
    present: !!ch,
    ready: answered !== null,
    answered,
    categories,
    cookiePresent: w.document.cookie.split(';').some((c) => c.trim().startsWith('cookiehub=')),
  };
}

const read = (page: Page) => page.evaluate(readCookiehub);

export const cookiehub = defineAdapter({
  id: 'cookiehub',
  name: 'CookieHub',
  supportedVersions: null,
  // `hasConsented(category)` answers per name; the categories of the installation cannot be listed.
  categoriesUnlisted: true,
  detect: {
    globals: ['cookiehub'],
    scripts: [{ label: 'cdn.cookiehub.eu', pattern: '^https://cdn\\.cookiehub\\.(eu|net|com)/' }],
    dom: ['.ch2-container', '.ch2-dialog'],
    cookies: ['^cookiehub$'],
  },
  banner: {
    containers: ['.ch2-container .ch2-dialog', '.ch2-dialog'],
    overlays: ['.ch2-container .ch2-overlay'],
    vendorRoles: [
      { selector: '.ch2-allow-all-btn', role: 'accept' },
      { selector: '.ch2-deny-all-btn', role: 'reject' },
      { selector: '.ch2-open-settings-btn', role: 'settings' },
      { selector: '.ch2-save-settings-btn', role: 'save' },
      { selector: '.ch2-close-btn', role: 'close' },
    ],
  },
  async readState(page) {
    const r = await read(page);
    if (!r.present) return [];
    return [
      {
        source: 'api',
        ready: r.ready ? 'ready' : 'loading',
        categories: toCategoryStates(r.categories),
        origin: r.answered ? 'stored' : 'default',
        decision: { responded: r.answered ?? 'unknown', method: r.answered ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).ready,
});
