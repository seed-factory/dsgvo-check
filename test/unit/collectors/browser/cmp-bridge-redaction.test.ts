/**
 * Text copied from the page into the CMP facts (button names, banner legal link text, covered footer link labels) and
 * the text of the consent dialog are redacted by the collector before storing: an e-mail address loses its local part,
 * a consent ID or UID the dialog prints is replaced; the click selector and the service names stay usable.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { CmpAdapter, CmpButton, CmpFacts } from '../../../../src/cmp/types.ts';
import {
  type CmpApi,
  CmpBridge,
  type DialogTextSource,
  normalizeDialogText,
  normalizeFacts,
} from '../../../../src/collectors/browser/cmp-bridge.ts';
import { CMP_DIALOG_TEXT_MAX_CHARS, CmpDialogTextSchema } from '../../../../src/core/snapshot/cmp-dialog.ts';
import type { CollectorError } from '../../../../src/core/snapshot/common.ts';
import { DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { makeCmpFacts } from '../../../utils/snapshot-builder.ts';

const button = (name: string, p: Partial<CmpButton> = {}): CmpButton => ({
  role: 'button',
  name,
  tag: 'button',
  kind: 'settings',
  kindConfidence: 'high',
  layer: 1,
  box: { x: 10, y: 600, width: 160, height: 44 },
  visibleAtFirstScreen: true,
  actionableAtFirstScreen: true,
  contrast: 7,
  ...p,
});

const facts = (): CmpFacts => {
  const f = makeCmpFacts();
  f.firstLayer = {
    bannerPresent: true,
    bannerVisible: true,
    buttons: [
      button('Einstellungen – Fragen an zq7btn@example.test', { selector: '#settings' }),
      button('Alle akzeptieren', { kind: 'accept', selector: '#accept' }),
    ],
    purAbo: false,
    closeMeansAccept: null,
    legalLinks: [{ text: 'Datenschutz – Fragen an zq7cmp@example.test', href: null }],
    coveredFooterLinks: [
      {
        label: 'zq7text@example.test (Datenschutz)',
        box: { x: 0, y: 700, width: 100, height: 20 },
        coveredBy: 'banner',
      },
    ],
  };
  return f;
};

describe('normalizeFacts: text copied from the page', () => {
  const out = normalizeFacts(facts(), 'B', 'https://www.example.test/');

  it('masks an address in the accessible name of a button', () => {
    expect(out.firstLayer.buttons.map((b) => b.name)).toEqual([
      'Einstellungen – Fragen an [redacted]@example.test',
      'Alle akzeptieren',
    ]);
  });

  it('masks an address in the text of a legal link of the banner', () => {
    expect(out.firstLayer.legalLinks?.map((l) => l.text)).toEqual([
      'Datenschutz – Fragen an [redacted]@example.test',
    ]);
  });

  it('masks an address in the label of a covered footer link', () => {
    expect(out.firstLayer.coveredFooterLinks?.map((l) => l.label)).toEqual([
      '[redacted]@example.test (Datenschutz)',
    ]);
  });

  it('nothing of the local parts is left in the facts, and the click selector is untouched', () => {
    expect(JSON.stringify(out)).not.toContain('zq7');
    expect(out.firstLayer.buttons.map((b) => b.selector)).toEqual(['#settings', '#accept']);
  });

  it('counterexample: names and labels without an address, and domains, stay as they are', () => {
    const f = facts();
    f.firstLayer.coveredFooterLinks = [
      { label: 'Impressum', box: { x: 0, y: 700, width: 100, height: 20 }, coveredBy: 'overlay' },
    ];
    f.firstLayer.legalLinks = [{ text: 'Datenschutzerklärung', href: null }];
    const o = normalizeFacts(f, 'B', 'https://www.example.test/');
    expect(o.firstLayer.coveredFooterLinks?.[0]?.label).toBe('Impressum');
    expect(o.firstLayer.legalLinks?.[0]?.text).toBe('Datenschutzerklärung');
    expect(o.firstLayer.buttons[1]?.name).toBe('Alle akzeptieren');
  });
});

const borlabs = { id: 'borlabs', name: 'Borlabs Cookie' } as CmpAdapter;
const source: DialogTextSource = {
  adapter: borlabs,
  version: '3.2.1',
  pageUrl: 'https://www.example.test/',
  takenAt: '2026-11-01T10:00:00.000Z',
};
/** A Borlabs dialog with its collapsed details as the page holds it: the visitor's IDs carry the marker `zq7`. */
const DIALOG =
  'Datenschutzeinstellungen Alle akzeptieren Cookie-Details Name Google Tag Manager Anbieter Google Ireland ' +
  'Limited Datenschutzerklärung https://policies.google.com/privacy?uid=zq7query Fragen an zq7mail@example.test ' +
  'Ihre Einwilligungs-ID: zq7Kp2Xr9Lm4Qa8Zt1Wn6Yb3 UID: zq7a9k2m-4hf8wz3p-b6ne1rtc Einwilligungsdatum 06.11.2026';

describe('normalizeDialogText: the text of the consent dialog', () => {
  const out = normalizeDialogText({ text: DIALOG, truncated: false }, source);

  it('a consent ID and a UID that the dialog prints are not stored, nor an address or a query value', () => {
    expect(JSON.stringify(out)).not.toContain('zq7');
    expect(out?.text).toContain('Ihre Einwilligungs-ID: [redacted] UID: [redacted]');
    expect(out?.text).toContain('[redacted]@example.test');
  });

  it('service names, provider, date and the CMP stay; the record fits the snapshot schema', () => {
    expect(out?.text).toContain('Name Google Tag Manager Anbieter Google Ireland Limited');
    expect(out?.text).toContain('Einwilligungsdatum 06.11.2026');
    expect(CmpDialogTextSchema.parse(out)).toMatchObject({
      id: 'cmp-dialog',
      cmpId: 'borlabs',
      cmpName: 'Borlabs Cookie',
      version: '3.2.1',
      phase: 'A',
      pageUrl: 'https://www.example.test/',
      truncated: false,
    });
  });

  it('a text the page cut at the limit loses its last token, which may be the start of an ID', () => {
    const cut = normalizeDialogText({ text: 'Name Google Tag Manager UID zq7a9k', truncated: true }, source);
    expect(cut).toMatchObject({ text: 'Name Google Tag Manager UID', truncated: true });
  });

  it('a text longer than the limit is cut at a space and marked truncated', () => {
    const long = normalizeDialogText(
      { text: 'Google Tag Manager '.repeat(10_000), truncated: false },
      source,
    );
    expect(long?.truncated).toBe(true);
    expect(long?.text.length).toBeLessThanOrEqual(CMP_DIALOG_TEXT_MAX_CHARS);
    expect(long?.text.endsWith('Manager')).toBe(true);
  });

  it('counterexample: a record that does not fit the schema is not stored', () => {
    const unnamed = { ...source, adapter: { id: 'borlabs', name: '' } as CmpAdapter };
    expect(normalizeDialogText({ text: DIALOG, truncated: false }, unnamed)).toBeNull();
  });
});

describe('CmpBridge.dialogText', () => {
  const page = {} as Page;

  it('reads through the API with the protective limit and hands out only the redacted record', async () => {
    const asked: number[] = [];
    const api = {
      dialogText: async (_p: Page, _a: CmpAdapter, maxChars: number) => {
        asked.push(maxChars);
        return { text: DIALOG, truncated: false };
      },
    } as CmpApi;
    const text = await new CmpBridge(api, 1_000, [], 'A', DEFAULT_CLASSIFY).dialogText(
      page,
      borlabs,
      '3.2.1',
      'https://www.example.test/',
    );
    expect(asked).toEqual([CMP_DIALOG_TEXT_MAX_CHARS]);
    expect(text?.text).toContain('Google Tag Manager');
    expect(JSON.stringify(text)).not.toContain('zq7');
  });

  it('a failed read is recorded as one phase error with its own code and gives no record', async () => {
    const errors: CollectorError[] = [];
    const api = {
      dialogText: async () => {
        throw new Error('page.evaluate: Execution context was destroyed');
      },
    } as unknown as CmpApi;
    const bridge = new CmpBridge(api, 1_000, errors, 'A', DEFAULT_CLASSIFY);
    expect(await bridge.dialogText(page, borlabs, null, 'https://www.example.test/')).toBeNull();
    expect(errors.map((e) => e.code)).toEqual(['cmp-dialog-text-failed']);
  });

  it('an API without the reader (a test stub) reads nothing', async () => {
    const bridge = new CmpBridge({} as CmpApi, 1_000, [], 'A', DEFAULT_CLASSIFY);
    expect(await bridge.dialogText(page, borlabs, null, 'https://www.example.test/')).toBeNull();
  });
});
