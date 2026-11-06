/**
 * Kinds of provider details in the text of a document and the blocks they are counted in: a section with its
 * subsections, inside one place and one frame, hidden text left out.
 */
import { describe, expect, it } from 'vitest';
import {
  bestBlock,
  blocksOf,
  detailKinds,
  detailsMatcher,
  shownHeading,
} from '../../../../../src/checks/browser/impressum-details.ts';
import { providerDetailsSection } from '../../../../../src/collectors/browser/legal/sections.ts';
import { loadDataDir } from '../../../../../src/core/data/load.ts';
import type { DocumentPart } from '../../../../../src/core/snapshot/browser.ts';
import { makeDocument } from '../../../../utils/snapshot-builder.ts';

const data = providerDetailsSection.parse(loadDataDir('legal'));
const m = detailsMatcher(data);
const kinds = (text: string) => detailKinds(m, text).size;

describe('kinds of provider details in a text', () => {
  it.each([
    ['register entry', 'Amtsgericht Musterstadt, HRB 12345', 1],
    ['VAT ID, spelled with dots', 'Ust.-Id.-Nr.: DE123456789', 1],
    ['VAT ID, spelled with a hyphen', 'USt-IdNr. DE123456789', 1],
    ['representative', 'Vertreten durch die Geschäftsführerin Erika Mustermann', 1],
    ['statement under § 5 DDG', 'Angaben gemäß § 5 DDG', 1],
    [
      'person responsible for the content',
      'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: Max Muster',
      1,
    ],
    [
      'English legal notice',
      'Commercial register: HRB 12345. VAT ID: DE123456789. Managing director: Erika Muster',
      3,
    ],
    [
      'all five kinds',
      'Angaben gemäß § 5 DDG. Inhaber: Max Muster. Steuernummer 12/345. VR 1234. § 18 MStV',
      5,
    ],
    [
      'several phrases of one kind count once',
      'Handelsregister, Registergericht: Amtsgericht Musterstadt, HRB 1',
      1,
    ],
  ])('%s', (_name, text, n) => {
    expect(kinds(text)).toBe(n);
  });

  it.each([
    ['a compound that starts with a phrase', 'Vorstandsvorsitzender und Inhaberschaft'],
    ['a word that ends with a phrase', 'Unser Steuerberater berät gern'],
    ['an address and a phone number', 'Musterstraße 1, 10115 Berlin, Telefon 030 123456'],
    ['a paragraph sign of another law', 'gemäß § 15 TMG und Art. 6 DSGVO'],
  ])('counterexample: %s is no provider detail', (_name, text) => {
    expect(kinds(text)).toBe(0);
  });
});

type Spec = Partial<DocumentPart> & { text: string };
const doc = (specs: Spec[], contentHeadings?: string[]) =>
  makeDocument({
    kind: 'impressum',
    parts: specs.map((p, i) => ({
      id: `p${i}`,
      origin: 'visible',
      sourceUrl: 'https://www.example.test/',
      ...p,
    })),
    ...(contentHeadings ? { contentHeadings } : {}),
  });
const blocks = (specs: Spec[], contentHeadings?: string[]) => blocksOf(doc(specs, contentHeadings), m);
const block = (specs: Spec[], path: string) => blocks(specs).find((b) => b.path === path);

describe('blocks of a document', () => {
  // As the reader stores it, a part starts with the visible text of the heading that opens it.
  it('a section counts the parts of its subsections, with the text of their headings', () => {
    const b = block(
      [
        { section: 'Impressum', text: 'Impressum' },
        {
          section: 'Impressum > Angaben gemäß § 5 DDG',
          text: 'Angaben gemäß § 5 DDG Beispiel GmbH, Musterstraße 1',
        },
        {
          section: 'Impressum > Registereintrag',
          text: 'Registereintrag Amtsgericht Musterstadt, HRB 12345',
        },
        { section: 'Impressum > Vertretung', text: 'Vertretung Geschäftsführung: Erika Mustermann' },
      ],
      'Impressum',
    );

    expect(b?.kinds).toBe(3);
    expect(b?.heading).toBe('Impressum');
  });

  it('the headings above a block do not count for it', () => {
    const b = block(
      [
        { section: 'Angaben gemäß § 5 DDG', text: 'Angaben gemäß § 5 DDG Beispiel GmbH' },
        { section: 'Angaben gemäß § 5 DDG > Kontakt', text: 'Kontakt Telefon 030 123456' },
      ],
      'Angaben gemäß § 5 DDG > Kontakt',
    );

    expect(b?.kinds).toBe(0);
  });

  it('counterexample: hidden words of a heading count only where the text shows them', () => {
    // The heading path keeps the whole text of the heading element; the hidden span is no visible text.
    const b = block(
      [
        { section: 'Impressum', text: 'Impressum' },
        {
          section: 'Impressum > Kontaktdaten Geschäftsführung HRB USt-IdNr.',
          text: 'Kontaktdaten Musterstraße 1, 10115 Berlin',
        },
        {
          section: 'Impressum > Kontaktdaten Geschäftsführung HRB USt-IdNr.',
          origin: 'hidden-irrelevant',
          text: 'Geschäftsführung HRB USt-IdNr.',
        },
      ],
      'Impressum',
    );

    expect(b?.kinds).toBe(0);
  });

  it('counterexample: sibling sections are blocks of their own', () => {
    const all = blocks([
      { section: 'Anfahrt', text: 'Neben dem Amtsgericht' },
      { section: 'Team', text: 'Inhaber Max Muster' },
      { section: 'Buchhaltung', text: 'Steuernummer auf Anfrage' },
    ]);

    expect(all.map((b) => [b.path, b.kinds])).toEqual([
      ['Anfahrt', 1],
      ['Team', 1],
      ['Buchhaltung', 1],
    ]);
  });

  it('counterexample: content and page chrome under one heading are two blocks', () => {
    const all = blocks([
      { section: 'Kontakt', place: 'content', text: 'Amtsgericht Musterstadt, HRB 12345' },
      {
        section: 'Kontakt',
        place: 'chrome',
        text: 'Geschäftsführung: Erika Mustermann. USt-IdNr. DE123456789',
      },
    ]);

    expect(all.map((b) => [b.place, b.kinds])).toEqual([
      ['content', 1],
      ['chrome', 2],
    ]);
  });

  it('counterexample: the text of a frame is no part of the section in front of it', () => {
    const all = blocks([
      { section: 'Kontakt', text: 'Amtsgericht Musterstadt, HRB 12345' },
      { section: 'Kontakt', frameUrl: 'https://www.example.test/frame', text: 'USt-IdNr. DE123456789' },
    ]);

    expect(all.map((b) => b.kinds)).toEqual([1, 1]);
  });

  it('counterexample: hidden text is left out', () => {
    const b = block(
      [
        { section: 'Impressum', text: 'Amtsgericht Musterstadt, HRB 12345' },
        {
          section: 'Impressum',
          origin: 'hidden-irrelevant',
          text: 'Geschäftsführung. USt-IdNr. DE123456789',
        },
      ],
      'Impressum',
    );

    expect(b?.kinds).toBe(1);
  });

  it('text before the first heading is a block of its own, not the whole page', () => {
    const all = blocks([
      { text: 'Amtsgericht Musterstadt, HRB 12345' },
      { section: 'Kontakt', text: 'Geschäftsführung. USt-IdNr. DE123456789' },
    ]);

    expect(all.map((b) => [b.path, b.kinds])).toEqual([
      ['', 1],
      ['Kontakt', 2],
    ]);
  });

  it('with as many kinds, the innermost heading names the block', () => {
    const best = bestBlock(
      blocks([
        { section: 'Kontakt', text: 'Schreiben Sie uns.' },
        { section: 'Kontakt > Impressum', text: 'Geschäftsführung. HRB 12345. USt-IdNr. DE123456789' },
      ]),
    );

    expect(best?.path).toBe('Kontakt > Impressum');
  });

  it('chrome text under the heading of the content section in front of it names no section', () => {
    const [footer] = blocks(
      [{ section: 'Anfahrt', place: 'chrome', text: 'Geschäftsführung. HRB 12345. USt-IdNr. DE123456789' }],
      ['Anfahrt'],
    );

    expect(shownHeading(footer!)).toBeNull();
  });

  it('counterexample: a heading of the chrome itself names the section', () => {
    const [footer] = blocks(
      [{ section: 'Start > Impressum', place: 'chrome', text: 'Geschäftsführung. HRB 12345' }],
      ['Start'],
    ).filter((b) => b.depth === 2);

    expect(shownHeading(footer!)).toBe('Impressum');
  });
});
