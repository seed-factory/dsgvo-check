/**
 * The collector's code runs in the page, and a page can throw its own data from inside it (a getter that throws a
 * consent ID). Only the kind of failure reaches the snapshot: a legal document whose text could not be read says so,
 * without the page's text. Markers start with `zq9`.
 */
import { describe, expect, it } from 'vitest';
import { persisted } from './helpers.ts';
import { LOREM, page, useSite } from './site-dir.ts';

/** Every read of the document title throws the page's own data. */
const HOSTILE = `<script>Object.defineProperty(document, 'title', { get() { throw new Error('zq9secret consent ' + 'zq9id-0001'); } });</script>`;
const FOOTER = '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutz</a></footer>';

const site = useSite(
  {
    'index.html': page(`<main><h1>Willkommen</h1><a href="/kontakt/">Kontakt</a></main>${FOOTER}`),
    'kontakt/index.html': page(`<main><h1>Kontakt</h1><p>${LOREM}</p></main>${FOOTER}`, HOSTILE),
    'impressum/index.html': page(
      `<main><h1>Impressum</h1><p>Beispiel GmbH, Musterstraße 1</p></main>${FOOTER}`,
    ),
    'datenschutz/index.html': page(
      `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(8)}</p></main>${FOOTER}`,
      HOSTILE,
    ),
  },
  { collect: { maxPages: 4 } },
);

describe('an error the page throws inside the collector', () => {
  it('leaves only the kind of failure: no part of the page text is in the result', () => {
    const out = persisted(site.run);
    expect(out).not.toContain('zq9');
    expect(out).toContain('evaluation failed');
  });

  it('the phase records the failure by its kind', () => {
    const errors = site.run.result.sections.browser?.phases[0]?.errors ?? [];
    expect(errors).toEqual([
      {
        code: 'document-extract-failed',
        message: 'evaluation failed',
        phase: 'A',
        url: 'https://www.example.test/datenschutz/',
      },
    ]);
  });
});
