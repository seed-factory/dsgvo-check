/**
 * The record the collector makes of a consent dialog: the catalog services its text names, each with the catalog's own
 * term that matched, found with the search of PRIV-01. Nothing of the text is kept, so no consent ID, UID or TC string
 * the dialog prints reaches the snapshot, whatever its shape; the bridge hands out nothing but that record.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { matchLevel } from '../../../../src/checks/browser/priv-01.ts';
import type { CmpAdapter } from '../../../../src/cmp/types.ts';
import { type CmpApi, CmpBridge } from '../../../../src/collectors/browser/cmp-bridge.ts';
import {
  type DialogSource,
  dialogMentionsOf,
  loadServiceTerms,
} from '../../../../src/collectors/browser/dialog-mentions.ts';
import {
  CMP_DIALOG_TEXT_MAX_CHARS,
  CmpDialogMentionsSchema,
} from '../../../../src/core/snapshot/cmp-dialog.ts';
import type { CollectorError } from '../../../../src/core/snapshot/common.ts';
import { normalizeText, serviceNameTerms } from '../../../../src/core/text/search.ts';
import { loadServiceCatalog } from '../../../../src/derive/catalog.ts';
import { DEFAULT_CLASSIFY } from '../../../utils/classify.ts';

const borlabs = { id: 'borlabs', name: 'Borlabs Cookie' } as CmpAdapter;
const source: DialogSource = {
  adapter: borlabs,
  version: '3.2.1',
  pageUrl: 'https://www.example.test/',
  takenAt: '2026-11-01T10:00:00.000Z',
};
const mentionsOf = (text: string, truncated = false) => dialogMentionsOf({ text, truncated }, source);
const named = (text: string, truncated = false) =>
  mentionsOf(text, truncated)?.services.map((m) => [m.serviceId, m.term]);

/** Identifiers a dialog prints about the visitor, in the shapes pages use, with what stands around them. */
const IDS: Array<{ shape: string; before: string; id: string; after?: string }> = [
  { shape: 'after a colon', before: 'Consent-ID: ', id: 'zqa7Kp2Xr9Lm4Qa8Zt1Wn6Yb3' },
  { shape: 'after an en dash, letters only', before: 'UID – ', id: 'zqbonlylettershere' },
  { shape: 'after a pipe', before: 'Einwilligungs-ID | ', id: 'zqcpipeseparated' },
  { shape: 'after a hash', before: 'Consent ID #', id: 'zqdhashprefixed' },
  {
    shape: 'after an alias in brackets',
    before: 'Ihre Einwilligungs-ID (UID): ',
    id: 'zqeabcde-fghijklm-nopqrstu',
  },
  { shape: 'in square brackets', before: 'Ihre ID [', id: 'zqfbracketed', after: ']' },
  { shape: 'in round brackets', before: 'Kennung (', id: 'zqgroundbrackets', after: ')' },
  { shape: 'glued to its label', before: 'ConsentID', id: 'zqhgluedtothelabel' },
  { shape: 'after Unicode hyphens', before: 'Consent\u2010ID\u2011', id: 'zqiunicodehyphens' },
  { shape: 'after an em dash', before: 'Session-ID\u2014', id: 'zqjemdashed' },
  { shape: 'after a minus sign', before: 'User-ID \u2212', id: 'zqkminussigned' },
  { shape: 'after "lautet", letters only', before: 'Ihre Einwilligungs-ID lautet ', id: 'zqllettersonly' },
  { shape: 'as a UUID', before: 'Nutzer ', id: '6f9619ff-8b86-d011-b42d-00c04fc964ff' },
  {
    shape: 'as a TC string',
    before: 'TC-String ',
    id: 'CPzqmAAPzqmAAAGABCENB-CgAAAAAAAAAAYgAAAAAAAA.YAAAAAAAAAAA',
  },
  { shape: 'as a time stamp in milliseconds', before: 'Einwilligungsdatum ', id: '1762423200123' },
];

/** A Borlabs dialog with its collapsed details as the page holds it, the visitor's identifiers between the services. */
const DIALOG = [
  'Datenschutzeinstellungen Alle akzeptieren Cookie-Details',
  'Name Google Tag Manager Anbieter Google Ireland Limited, Gordon House, Barrow Street, Dublin 4',
  'Datenschutzerklärung https://policies.google.com/privacy?uid=zqnquery Fragen an zqomail@example.test',
  ...IDS.map((i) => `${i.before}${i.id}${i.after ?? ''}`),
  'Name Google AdWords Anbieter Google Ireland Limited Zweck Conversion-Tracking',
].join(' ');

describe('dialogMentionsOf: the dialog as the snapshot keeps it', () => {
  const record = mentionsOf(DIALOG);
  const catalog = loadServiceCatalog();

  it('names the services of the Cookie-Details by the catalog term that matched, in the order of their ids', () => {
    expect(record).toEqual({
      cmpId: 'borlabs',
      cmpName: 'Borlabs Cookie',
      version: '3.2.1',
      phase: 'A',
      pageUrl: 'https://www.example.test/',
      takenAt: '2026-11-01T10:00:00.000Z',
      services: [
        { serviceId: 'google-ads', term: 'Google AdWords' },
        { serviceId: 'google-tag-manager', term: 'Google Tag Manager' },
      ],
      truncated: false,
    });
    expect(CmpDialogMentionsSchema.parse(record)).toEqual(record);
  });

  it.each(IDS)('no identifier $shape is in the record', ({ id }) => {
    expect(JSON.stringify(record)).not.toContain(id);
  });

  it('of the page only catalog terms: each is one of the names of its service, no other text is there', () => {
    for (const m of record?.services ?? [])
      expect(serviceNameTerms(catalog.info(m.serviceId)!)).toContain(m.term);
    const json = JSON.stringify(record);
    for (const text of [
      'zq',
      'Gordon House',
      'Datenschutzeinstellungen',
      'Conversion-Tracking',
      'example.test/privacy',
    ])
      expect(json).not.toContain(text);
  });

  it.each([
    ['with hyphens', 'Name Google-Tag-Manager Anbieter', [['google-tag-manager', 'Google Tag Manager']]],
    [
      'with umlauts spelled out',
      'Name Google Uebersetzer Anbieter',
      [['google-translate', 'Google Übersetzer']],
    ],
    [
      'with a combining mark',
      'Name Google U\u0308bersetzer Anbieter',
      [['google-translate', 'Google Übersetzer']],
    ],
    ['as a longer name only', 'Name Google AdSense Anbieter', [['google-adsense', 'Google AdSense']]],
    [
      'by provider, domain and category only',
      'Google Ireland Limited www.googletagmanager.com Tag-Manager',
      [],
    ],
  ])('a dialog that names a service %s', (_, text, expected) => {
    expect(named(text)).toEqual(expected);
  });

  it('a catalog service is in the record exactly when PRIV-01 finds it in the same text by name', () => {
    const texts = [
      DIALOG,
      'Name Google AdSense Anbieter',
      'Wir nutzen Matomo, Hotjar und den Facebook-Pixel.',
    ];
    for (const text of texts) {
      const found = new Set(named(text)?.map(([id]) => id));
      for (const { serviceId } of loadServiceTerms()) {
        const byName = matchLevel(catalog.info(serviceId)!, normalizeText(text), false).level === 'named';
        expect(found.has(serviceId), `${serviceId} in "${text.slice(0, 40)}"`).toBe(byName);
      }
    }
  });

  it('a text the page cut at the limit loses its last token: Google Ads cut from Google AdSense is no mention', () => {
    expect(mentionsOf('Name Google Tag Manager Name Google Ads', true)).toMatchObject({
      services: [{ serviceId: 'google-tag-manager', term: 'Google Tag Manager' }],
      truncated: true,
    });
  });

  it('a text longer than the limit is searched up to it and marked truncated', () => {
    const long = `${'Wir nutzen Cookies. '.repeat(CMP_DIALOG_TEXT_MAX_CHARS / 20)}Name Google Tag Manager`;
    expect(mentionsOf(long)).toMatchObject({ services: [], truncated: true });
  });

  it('counterexample: a record that does not fit the schema is not made', () => {
    const unnamed = { ...source, adapter: { ...borlabs, name: '' } };
    expect(dialogMentionsOf({ text: DIALOG, truncated: false }, unnamed)).toBeNull();
  });
});

describe('CmpBridge.dialogMentions', () => {
  const page = {} as Page;
  const url = 'https://www.example.test/';

  it('reads through the API with the protective limit and hands out only the record', async () => {
    const asked: number[] = [];
    const api = {
      dialogText: async (_p: Page, _a: CmpAdapter, maxChars: number) => {
        asked.push(maxChars);
        return { text: DIALOG, truncated: false };
      },
    } as CmpApi;
    const bridge = new CmpBridge(api, 1_000, [], 'A', DEFAULT_CLASSIFY);
    const read = await bridge.dialogMentions(page, borlabs, '3.2.1', url);
    expect(asked).toEqual([CMP_DIALOG_TEXT_MAX_CHARS]);
    expect(read).toEqual({ ...mentionsOf(DIALOG), takenAt: expect.any(String) });
    expect(JSON.stringify(read)).not.toContain('zq');
  });

  it('a failed read is recorded as one phase error with its own code and says it failed', async () => {
    const errors: CollectorError[] = [];
    const api = {
      dialogText: async () => {
        throw new Error('page.evaluate: Execution context was destroyed');
      },
    } as unknown as CmpApi;
    const bridge = new CmpBridge(api, 1_000, errors, 'A', DEFAULT_CLASSIFY);
    expect(await bridge.dialogMentions(page, borlabs, null, url)).toBe('failed');
    expect(errors.map((e) => e.code)).toEqual(['cmp-dialog-mentions-failed']);
  });

  it('a record that does not fit the snapshot schema counts as failed, and is not stored', async () => {
    const api = { dialogText: async () => ({ text: DIALOG, truncated: false }) } as unknown as CmpApi;
    const unnamed = { id: 'borlabs', name: '' } as CmpAdapter;
    const bridge = new CmpBridge(api, 1_000, [], 'A', DEFAULT_CLASSIFY);
    expect(await bridge.dialogMentions(page, unnamed, null, url)).toBe('failed');
  });

  it.each([
    ['an API without the reader (a test stub)', {} as CmpApi],
    ['a dialog without its container', { dialogText: async () => null } as unknown as CmpApi],
  ])('%s: nothing read, and no failure', async (_, api) => {
    const errors: CollectorError[] = [];
    const bridge = new CmpBridge(api, 1_000, errors, 'A', DEFAULT_CLASSIFY);
    expect(await bridge.dialogMentions(page, borlabs, null, url)).toBe('absent');
    expect(errors).toEqual([]);
  });
});
