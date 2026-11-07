/**
 * Stored link facts of a page: a mailto link keeps only the masked recipient domain, never the address or headers; a
 * link whose rel names the HTML link type `bookmark` is flagged as the permalink of an article.
 */
import { describe, expect, it } from 'vitest';
import type { RawLink } from '../../../../src/collectors/browser/in-page/dom.ts';
import { mapLinks } from '../../../../src/collectors/browser/pages/dom-facts.ts';

const raw = (attr: string, text: string, over: Partial<RawLink> = {}): RawLink => ({
  href: attr,
  attr,
  text,
  name: '',
  region: 'main',
  visible: true,
  inShadowDom: false,
  rel: '',
  hreflang: '',
  ...over,
});

const target = { etld1: 'example.de', host: 'www.example.de' };

describe('mailto links in the stored DOM facts', () => {
  it('keeps the masked recipient, drops the local part and the headers, and stays not navigable', () => {
    const { links } = mapLinks(
      { links: [raw('mailto:Info@Example-Mail.de?subject=Hallo', 'E-Mail schreiben')] },
      target,
    );

    expect(links).toEqual([
      expect.objectContaining({
        href: null,
        hrefKind: 'mailto',
        mailto: 'mailto:[redacted]@example-mail.de',
      }),
    ]);
    const stored = JSON.stringify(links);
    expect(stored).not.toMatch(/info@/i);
    expect(stored).not.toContain('Hallo');
  });

  it('masks every recipient of a list', () => {
    const { links } = mapLinks({ links: [raw('mailto:a@one.example,b@two.example', 'Schreiben')] }, target);
    expect(links[0]?.mailto).toBe('mailto:[redacted]@one.example,[redacted]@two.example');
  });

  it('other links carry no mailto field', () => {
    const { links } = mapLinks({ links: [raw('https://www.example.de/impressum', 'Impressum')] }, target);
    expect(links[0]).not.toHaveProperty('mailto');
  });
});

describe('permalinks in the stored DOM facts', () => {
  const POST = 'https://www.example.de/2025/02/beitrag/';

  it.each([
    ['bookmark', true],
    ['Bookmark', true],
    ['BOOKMARK', true],
    ['nofollow bookmark', true],
    ['bookmark\tnoopener', true],
    ['  bookmark  ', true],
    ['nofollow', false],
    ['bookmarks', false],
    ['bookmark-me', false],
    ['', false],
  ])('rel="%s" → permalink %s', (rel, permalink) => {
    const { links } = mapLinks({ links: [raw(POST, '14. März 2025', { rel })] }, target);
    if (permalink) expect(links[0]).toMatchObject({ href: POST, permalink: true });
    else expect(links[0]).not.toHaveProperty('permalink');
  });

  it('a link without rel carries no permalink field (older snapshots look the same)', () => {
    const { links } = mapLinks({ links: [raw(POST, 'Weiterlesen')] }, target);
    expect(links[0]).not.toHaveProperty('permalink');
  });
});
