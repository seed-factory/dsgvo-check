/**
 * The TYPO3 extension cookieman. Its consent groups are site configuration (`groupsSource`, an attribute of the modal);
 * the answer is read through `cookieman.hasConsented(group)` when the page offers it, else from the answer cookie
 * (`answerCookie`), which lists the accepted groups. Only one boolean per group leaves the page.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { readerInput } from '../adapters-file.ts';
import { defineAdapter, toCategoryStates } from './base.ts';
import { categoryFlags, flag, readerResult } from './read.ts';

interface CookiemanRead {
  present: boolean;
  /** The groups of the site's configuration could be read. */
  configured: boolean;
  source: 'api' | 'cookie';
  answered: boolean;
  /** Optional groups only: a group the configuration marks as not deselectable is always on. */
  categories: Record<string, boolean | null>;
}

interface CookiemanArgs {
  answerCookie: string;
  groupsSource: { selector: string; attribute: string };
}

/** In-page, self-contained. The cookie value is parsed here and never leaves the page. */
function readCookieman({ answerCookie, groupsSource }: CookiemanArgs): CookiemanRead {
  const w = globalThis as unknown as {
    cookieman?: { hasConsented?: (group: string) => unknown };
    document: {
      cookie: string;
      querySelector(selector: string): { getAttribute(n: string): string | null } | null;
    };
  };
  const api = w.cookieman;

  const optionalGroups = (): string[] | null => {
    let raw: string | null | undefined = null;
    try {
      raw = w.document.querySelector(groupsSource.selector)?.getAttribute(groupsSource.attribute);
    } catch {
      raw = null;
    }
    if (!raw) return null;
    try {
      const groups = (JSON.parse(raw) as { groups?: Record<string, { disabled?: unknown }> }).groups;
      if (!groups || typeof groups !== 'object') return null;
      return Object.keys(groups).filter((g) => {
        const disabled = groups[g]?.disabled;
        return !(disabled === true || disabled === 1 || disabled === '1');
      });
    } catch {
      return null;
    }
  };

  const consentedGroups = (): string[] | null => {
    const entry = w.document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${answerCookie}=`));
    if (entry === undefined) return null;
    let value = entry.slice(answerCookie.length + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    return value.split('|').filter(Boolean);
  };

  const fromApi = (group: string): boolean | null => {
    if (typeof api?.hasConsented !== 'function') return null;
    try {
      const v = api.hasConsented(group);
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  };

  const groups = optionalGroups();
  const consented = consentedGroups();
  const useApi = typeof api?.hasConsented === 'function';
  const categories: Record<string, boolean | null> = {};
  for (const g of groups ?? []) {
    // Without an answer cookieman loads no optional group.
    categories[g] = useApi ? fromApi(g) : consented ? consented.includes(g) : false;
  }

  return {
    present: !!api,
    configured: groups !== null,
    source: useApi ? 'api' : 'cookie',
    answered: consented !== null,
    categories,
  };
}

/** The reader's answer; the group names come from the page's markup, the stored state keeps only names (`foldCategories`). */
const CookiemanAnswer = z.object({
  present: flag,
  configured: flag,
  source: z.enum(['api', 'cookie']).catch('cookie'),
  answered: flag,
  categories: categoryFlags,
});

const read = async (page: Page): Promise<CookiemanRead> =>
  readerResult(
    CookiemanAnswer,
    await page.evaluate(readCookieman, {
      answerCookie: readerInput('cookieman', 'answerCookie'),
      groupsSource: readerInput('cookieman', 'groupsSource'),
    }),
  );

export const cookieman = defineAdapter({
  id: 'cookieman',
  async readState(page) {
    const r = await read(page);
    if (!r.present) return [];

    return [
      {
        source: r.source,
        ready: r.configured ? 'ready' : 'loading',
        categories: toCategoryStates(r.categories),
        origin: r.answered ? 'stored' : 'default',
        decision: { responded: r.answered, method: r.answered ? 'explicit' : 'unknown' },
      },
    ];
  },
  isReady: async (page) => (await read(page)).configured,
});
