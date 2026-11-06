/** What the adapters know about each vendor is data (test/data/cmp): its shape, its consistency and its use. */
import { describe, expect, it } from 'vitest';
import {
  adaptersSection,
  essentialCategorySection,
  probeSection,
  supportedVersionsOf,
} from '../../../src/cmp/adapters-data.ts';
import { confidenceFromSignals } from '../../../src/cmp/detection.ts';
import { adapters } from '../../../src/cmp/index.ts';
import { KNOWN_CMP_IDS } from '../../../src/cmp/types.ts';
import { DataError, loadDataDir } from '../../../src/core/data/load.ts';

const merged = loadDataDir('cmp');
const data = adaptersSection.parse(merged);

/** The merged cmp directory with the adapter entries edited. */
const withAdapters = (edit: (all: Record<string, Record<string, unknown>>) => void) => {
  const all = structuredClone(merged.adapters) as Record<string, Record<string, unknown>>;
  edit(all);
  return { ...merged, adapters: all };
};

describe('adapter data', () => {
  it('has one entry per adapter of the registry, in the registry', () => {
    expect(Object.keys(data).sort()).toEqual([...KNOWN_CMP_IDS].sort());
    expect(adapters.map((a) => a.id)).toEqual([...KNOWN_CMP_IDS]);
  });

  it('adapter name and tested range are read from it', () => {
    for (const a of adapters) {
      expect(a.name).toBe(data[a.id].name);
      expect(a.supportedVersions).toBe(supportedVersionsOf(data[a.id].supportedMajors));
    }
    expect(supportedVersionsOf([2, 3])).toBe('2.x || 3.x');
    expect(supportedVersionsOf(undefined)).toBeNull();
  });

  it.each(KNOWN_CMP_IDS)('%s can be recognised with high confidence from its own signals', (id) => {
    const d = data[id].detect;
    const signals = [
      ...d.globals.map((g) => `global:${g}`),
      ...d.scripts.map((s) => `script:${s.label}`),
      ...d.dom.map((x) => `dom:${x}`),
      ...d.cookies.map((c) => `cookie:${c}`),
      ...d.storage.map((k) => `storage:${k}`),
    ];
    expect(confidenceFromSignals(signals)).toBe('high');
  });

  it.each(KNOWN_CMP_IDS)('%s: a version rule names a signal the adapter detects', (id) => {
    const { detect, version } = data[id];
    for (const r of version.rules) {
      if (r.global !== undefined) expect(detect.globals).toContain(r.global);
      if (r.dom !== undefined) expect(detect.dom).toContain(r.dom);
      if (r.script !== undefined) expect(detect.scripts.map((s) => s.label)).toContain(r.script);
    }
  });

  it.each(KNOWN_CMP_IDS)('%s: banner containers are listed and vendor roles are distinct selectors', (id) => {
    const { banner } = data[id];
    expect(banner.containers.length).toBeGreaterThan(0);
    const selectors = banner.vendorRoles.map((r) => r.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it('an adapter id without code or an adapter without data is an error naming the id', () => {
    expect(() => adaptersSection.parse(withAdapters((all) => delete all.cookiehub))).toThrow(
      /adapters\.cookiehub/,
    );
    expect(() =>
      adaptersSection.parse(
        withAdapters((all) => (all['new-cmp'] = structuredClone(all.cookiehub) as never)),
      ),
    ).toThrow(DataError);
  });

  it.each([
    ['borlabs', 'botUserAgent'],
    ['borlabs', 'optionalGroups'],
    ['ccm19', 'essentialEmbeddings'],
    ['ccm19', 'closedDialog'],
    ['real-cookie-banner', 'botUserAgent'],
    ['shopware', 'answerCookie'],
    ['shopware', 'consentCookies'],
    ['wix', 'optionalGroups'],
    ['cookieman', 'answerCookie'],
    ['cookieman', 'groupsSource'],
  ])('%s needs "%s" for its page reader', (id, key) => {
    const broken = withAdapters((all) => delete all[id]?.[key]);
    expect(() => adaptersSection.parse(broken)).toThrow(new RegExp(`adapters\\.${id}\\.${key}: ${id} needs`));
  });

  // A Shopware reject is confirmed by the absence of these names, so the list holds the permission cookies of Shopware
  // itself: never the answer cookie, which every answer sets, and no name twice.
  it("shopware's permission cookies: Shopware's own names, distinct, without the answer cookie", () => {
    const { consentCookies, answerCookie } = data.shopware;
    expect(consentCookies).toEqual(
      expect.arrayContaining([
        'google-analytics-enabled',
        'google-ads-enabled',
        'wishlist-enabled',
        'youtube-video',
      ]),
    );
    expect(new Set(consentCookies).size).toBe(consentCookies?.length);
    expect(consentCookies).not.toContain(answerCookie);
  });

  it.each([
    ['the answer cookie among the permission cookies', ['cookie-preference'], /answer cookie/],
    ['a name twice', ['youtube-video', 'youtube-video'], /twice/],
    ['no cookie name', ['google analytics'], /cookie name/],
    ['a name with a value', ['google-analytics-enabled=1'], /cookie name/],
  ])('shopware permission cookies: %s is a data error', (_case, names, message) => {
    const broken = withAdapters((all) => {
      (all.shopware as Record<string, unknown>).consentCookies = names;
    });
    expect(() => adaptersSection.parse(broken)).toThrow(message);
  });

  it('a version rule names exactly one signal', () => {
    const both = withAdapters((all) => {
      const version = all.borlabs?.version as { rules: unknown[] };
      version.rules.push({ dom: '#x', global: 'X', version: '1' });
    });
    expect(() => adaptersSection.parse(both)).toThrow(/exactly one of global, dom, script/);
  });
});

describe('essential consent categories', () => {
  const essential = essentialCategorySection.parse(merged);

  it.each([
    'necessary',
    'Essential',
    'security_storage',
    'functionality_storage',
    'technisch-notwendig',
    'Notwendig',
  ])('%s is essential', (name) => expect(essential.test(name)).toBe(true));

  it.each(['statistics', 'marketing', 'ad_storage', 'necessary-extra', 'not necessary'])(
    '%s is not essential (the whole name must match)',
    (name) => expect(essential.test(name)).toBe(false),
  );
});

describe('probe data', () => {
  it('lists the attributes a button selector is built from', () => {
    expect(probeSection.parse(merged).selectorAttributes).toContain('data-testid');
  });
});
