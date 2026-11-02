/**
 * AGENTS rule 2: text copied from the page into the CMP facts (accessible names of buttons,
 * text of the legal links of the banner, labels of the covered footer links) is redacted by the collector before it is
 * stored: an e-mail address loses its local part. The click selector of a button is no free text and stays usable.
 */
import { describe, expect, it } from 'vitest';
import type { CmpButton, CmpFacts } from '../../../../src/cmp/types.ts';
import { normalizeFacts } from '../../../../src/collectors/browser/cmp-bridge.ts';
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
