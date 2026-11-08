/**
 * Text copied from the page into the CMP facts (button names, banner legal link text, covered footer link labels) is
 * redacted by the collector before storing: an e-mail address loses its local part; the click selector stays usable.
 */
import { describe, expect, it } from 'vitest';
import type { CmpButton, CmpFacts } from '../../../../src/cmp/types.ts';
import { normalizeFacts, normalizeSettings } from '../../../../src/collectors/browser/cmp-bridge.ts';
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

describe('normalizeFacts: identifiers in CMP control labels', () => {
  it.each([
    ['an identifier word', 'Accept 4f3a9c1d2e7b4a9f', 'Accept [redacted]'],
    ['hex groups joined by blanks', 'Accept 4f3a 9c1d 2e7b 4a9f', 'Accept [redacted]'],
    ['digit groups joined by blanks', 'Einwilligungs-ID 123 456 789', 'Einwilligungs-ID [redacted]'],
    ['counterexample: an accept label', 'Alle akzeptieren', 'Alle akzeptieren'],
    ['counterexample: a reject label', 'Nur notwendige Cookies', 'Nur notwendige Cookies'],
    ['counterexample: a partner count', 'Partner (12)', 'Partner (12)'],
    ['counterexample: a settings label in capitals', 'DATENSCHUTZEINSTELLUNGEN', 'DATENSCHUTZEINSTELLUNGEN'],
    ['counterexample: a reject label in capitals', 'NUR-NOTWENDIGE-COOKIES', 'NUR-NOTWENDIGE-COOKIES'],
  ])('a button label with %s', (_case, label, stored) => {
    const f = facts();
    f.firstLayer.buttons[0]!.name = label;
    expect(normalizeFacts(f, 'B', 'https://www.example.test/').firstLayer.buttons[0]?.name).toBe(stored);
  });

  it('a covered footer link label loses an identifier word; the text of a legal link keeps its register number', () => {
    const f = facts();
    f.firstLayer.coveredFooterLinks![0]!.label = 'Impressum 4f3a9c1d2e7b4a9f';
    f.firstLayer.legalLinks![0]!.text = 'HRB 123456';
    const out = normalizeFacts(f, 'B', 'https://www.example.test/');
    expect(out.firstLayer.coveredFooterLinks![0]!.label).toBe('Impressum [redacted]');
    expect(out.firstLayer.legalLinks![0]!.text).toBe('HRB 123456');
  });

  it.each(['DATENSCHUTZERKLAERUNG', 'DATENSCHUTZBESTIMMUNGEN', 'ANBIETERKENNZEICHNUNG'])(
    'counterexample: a covered footer link %s keeps its label',
    (label) => {
      const f = facts();
      f.firstLayer.coveredFooterLinks![0]!.label = label;
      expect(
        normalizeFacts(f, 'B', 'https://www.example.test/').firstLayer.coveredFooterLinks![0]!.label,
      ).toBe(label);
    },
  );

  it('a settings layer button label loses an identifier word', () => {
    const layer = normalizeSettings({
      ...makeCmpFacts().firstLayer,
      buttons: [button('Save 4f3a9c1d2e7b4a9f')],
    } as never);
    expect(layer.buttons[0]?.name).toBe('Save [redacted]');
  });
});
