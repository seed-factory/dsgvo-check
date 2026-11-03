/**
 * Pure: / on the seam between the page reader and `extractDocument`. The reader
 * (`documentInPage`) sorts the headings into chrome and content; `extractDocument` confirms the type only by the
 * headings of the content, in the main document and in a same-origin frame. The page itself is a fake (no browser).
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../../../../src/collectors/browser/documents.ts';
import type { RawDocument } from '../../../../src/collectors/browser/in-page-document.ts';

const TEXT = 'Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. '.repeat(4);

function raw(over: Partial<RawDocument>): RawDocument {
  return {
    lang: 'de',
    title: 'Muster GmbH',
    h1: '',
    parts: [{ section: 'Leistungen', text: TEXT, origin: 'visible' }],
    expandablesFound: 0,
    expandablesWithContent: 0,
    textLength: TEXT.length,
    truncated: false,
    ...over,
  };
}

function fakePage(main: RawDocument, frames: RawDocument[] = []): Page {
  const url = 'https://www.example.test/impressum';
  const mainFrame = { url: () => url, evaluate: async () => main };
  const children = frames.map((f, i) => ({ url: () => `${url}/frame-${i}`, evaluate: async () => f }));
  return {
    url: () => url,
    evaluate: async () => main,
    frames: () => [mainFrame, ...children],
    mainFrame: () => mainFrame,
  } as unknown as Page;
}

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
  it('a section heading that the reader placed in the chrome does not confirm the type', async () => {
    const page = fakePage(
      raw({
        parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }],
        headingPlaces: { chrome: ['Impressum'], content: [] },
      }),
    );
    expect((await extractDocument(page, ctx)).errors).toContain('unconfirmed');
  });

  it('counterexample: the same heading placed in the content confirms it', async () => {
    const page = fakePage(
      raw({
        parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }],
        headingPlaces: { chrome: [], content: ['Impressum'] },
      }),
    );
    expect((await extractDocument(page, ctx)).errors).toEqual([]);
  });

  it('counterexample: a heading in the chrome and in the content (a footer column next to the real one) stays', async () => {
    const page = fakePage(
      raw({
        parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }],
        headingPlaces: { chrome: ['Impressum'], content: ['Impressum'] },
      }),
    );
    expect((await extractDocument(page, ctx)).errors).toEqual([]);
  });

  it('a chrome heading of a same-origin frame does not confirm the type either; a content heading does', async () => {
    const chromeFrame = fakePage(raw({}), [
      raw({
        parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }],
        headingPlaces: { chrome: ['Impressum'], content: [] },
      }),
    ]);
    expect((await extractDocument(chromeFrame, ctx)).errors).toContain('unconfirmed');
    const contentFrame = fakePage(raw({}), [
      raw({
        parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }],
        headingPlaces: { chrome: [], content: ['Impressum'] },
      }),
    ]);
    expect((await extractDocument(contentFrame, ctx)).errors).toEqual([]);
  });

  it('a reader without places (an older result) leaves every heading in force', async () => {
    const page = fakePage(raw({ parts: [{ section: 'Impressum', text: TEXT, origin: 'visible' }] }));
    expect((await extractDocument(page, ctx)).errors).toEqual([]);
  });

  it('the h1 passed on by the reader decides with the title: h1 of the content confirms, no h1 does not', async () => {
    expect((await extractDocument(fakePage(raw({ h1: 'Impressum' })), ctx)).errors).toEqual([]);
    expect((await extractDocument(fakePage(raw({ h1: '' })), ctx)).errors).toContain('unconfirmed');
  });
});
