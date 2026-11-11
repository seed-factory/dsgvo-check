/**
 * The seam between the page reader (`documentInPage` sorts headings into chrome and content) and `extractDocument`,
 * which confirms the type only by content headings, in the main document and same-origin frames. Fake page, no browser.
 */
import { describe, expect, it } from 'vitest';
import type { RawDocument } from '../../../../../src/collectors/browser/in-page/document.ts';
import { extractDocument } from '../../../../../src/collectors/browser/legal/documents.ts';
import { legalPage, rawPolicy } from './fakes.ts';

const TEXT = 'Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. '.repeat(4);

const raw = (over: Partial<RawDocument> = {}) =>
  rawPolicy({
    title: 'Muster GmbH',
    h1: '',
    parts: [{ section: 'Leistungen', text: TEXT, origin: 'visible' }],
    textLength: TEXT.length,
    ...over,
  });

const withHeading = (headingPlaces?: RawDocument['headingPlaces']) =>
  raw({ parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }], headingPlaces });

const ctx = {
  id: 'doc-impressum-1',
  kind: 'impressum' as const,
  phase: 'A' as const,
  url: 'https://www.example.test/impressum',
  foundVia: 'fallback' as const,
  status: 200,
  contentType: 'text/html',
};

describe('extractDocument: only headings of the content confirm the type', () => {
  const read = (main: RawDocument, children: RawDocument[] = []) =>
    extractDocument(
      legalPage(
        ctx.url,
        main,
        children.map((doc, i) => [`${ctx.url}/frame-${i}`, doc]),
      ),
      ctx,
    );

  const chrome = { chrome: ['Impressum'], content: [] };
  const content = { chrome: [], content: ['Impressum'] };

  it('a section heading that the reader placed in the chrome does not confirm the type', async () => {
    expect((await read(withHeading(chrome))).errors).toContain('unconfirmed');
  });

  it.each([
    ['in the content', content],
    ['in the chrome and in the content', { ...content, chrome: chrome.chrome }],
    ['from a reader without places', undefined],
  ] as const)('a heading %s confirms the type', async (_name, headingPlaces) => {
    expect((await read(withHeading(headingPlaces))).errors).toEqual([]);
  });

  it('a same-origin frame confirms the type only through its content heading', async () => {
    expect((await read(raw(), [withHeading(chrome)])).errors).toContain('unconfirmed');
    expect((await read(raw(), [withHeading(content)])).errors).toEqual([]);
  });

  it('the h1 passed on by the reader decides with the title: h1 of the content confirms, no h1 does not', async () => {
    expect((await read(raw({ h1: 'Impressum' }))).errors).toEqual([]);
    expect((await read(raw({ h1: '' }))).errors).toContain('unconfirmed');
  });
});
