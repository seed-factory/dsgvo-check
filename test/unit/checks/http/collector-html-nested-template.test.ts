/**
 * Inert `<template>` content with nesting: the first `</template>` closes the innermost one only, markup inside the
 * outer one is not part of the document, a real `<meta>` or form after it stays visible.
 */
import { describe, expect, it } from 'vitest';
import { detectClientRedirect, detectForm, extractMeta } from '../../../../src/collectors/http/html.ts';

const BASE = 'http://www.example.test/start';
const META = '<meta http-equiv="refresh" content="0;url=https://www.example.test/next">';
const FORM = '<form method="post"><input name="email"></form>';
const NEXT = { kind: 'meta', url: 'https://www.example.test/next' };

describe('nested <template> hides the markup of the outer one', () => {
  it.each([
    ['inner template first, meta after it', `<template><template></template>${META}</template>`],
    ['meta before the inner template', `<template>${META}<template></template></template>`],
    ['meta inside the inner template', `<template><template>${META}</template></template>`],
    [
      'three levels, meta between the closings',
      `<template><template><template></template>${META}</template></template>`,
    ],
    [
      'inner template has attributes and another case',
      `<TEMPLATE id="a"><Template shadowrootmode="open"></Template>${META}</TEMPLATE>`,
    ],
    [
      'a <template/> still opens a template (the slash is ignored)',
      `<template><template/></template>${META}</template>`,
    ],
    [
      'comment inside, closing in a comment is no closing',
      `<template><template></template><!-- </template> -->${META}</template>`,
    ],
    ['an unclosed outer template runs to the end', `<template><template></template>${META}`],
  ])('no redirect: %s', (_label, html) => {
    expect(detectClientRedirect(html, BASE)).toBeNull();
  });

  it('a </template> inside a script of the template does not close the template', () => {
    const html = `<template><script>var s = "</template>";</script>${META}</template>`;
    expect(detectClientRedirect(html, BASE)).toBeNull();
  });

  it('a form inside nested templates is not a form of the document', () => {
    expect(detectForm(`<template><template></template>${FORM}</template>`)).toBe(false);
    expect(detectForm(`<template><template>${FORM}</template></template>`)).toBe(false);
  });
});

describe('counterexamples: what the fix must not hide', () => {
  it.each([
    ['real meta after the outer template', `<template><template></template></template>${META}`],
    ['real meta after two sibling templates', `<template>a</template><template>b</template>${META}`],
    ['real meta before the template', `${META}<template><template></template></template>`],
    [
      'real meta between two nested templates',
      `<template><template></template></template>${META}<template><template></template></template>`,
    ],
    ['a stray </template> closes nothing', `</template>${META}`],
    ['real meta after a flat template', `<template>x</template>${META}`],
  ])('meta is found: %s', (_label, html) => {
    expect(detectClientRedirect(html, BASE)).toEqual(NEXT);
  });

  it('a real form after the outer template is found', () => {
    expect(detectForm(`<template><template></template></template>${FORM}`)).toBe(true);
  });

  it('the other inert elements keep their behaviour (first closing tag ends them, no nesting)', () => {
    expect(detectClientRedirect(`<noscript><noscript></noscript>${META}`, BASE)).toEqual(NEXT);
    expect(detectClientRedirect(`<noscript>${META}</noscript>`, BASE)).toBeNull();
    expect(detectClientRedirect(`<textarea>${META}</textarea>`, BASE)).toBeNull();
    expect(detectClientRedirect(`<style>${META}</style>${META}`, BASE)).toEqual(NEXT);
  });

  it('a script that sits next to a template still yields its JS redirect', () => {
    const html = `<template><template></template></template><script>location.replace('https://www.example.test/js')</script>`;
    expect(detectClientRedirect(html, BASE)).toEqual({ kind: 'js', url: 'https://www.example.test/js' });
  });
});

describe('the name of an inert element ends at whitespace, "/" or ">"', () => {
  it('an element that only starts like template/script/style is no inert element', () => {
    expect(detectClientRedirect(`<template-card>x</template-card>${META}`, BASE)).toEqual(NEXT);
    expect(detectClientRedirect(`<script-loader>x</script-loader>${META}`, BASE)).toEqual(NEXT);
    expect(detectForm(`<style-guide>x</style-guide>${FORM}`)).toBe(true);
    // ...and inside a template such an element does not count as a nested template
    expect(detectClientRedirect(`<template><template-card></template-card></template>${META}`, BASE)).toEqual(
      NEXT,
    );
  });
});

describe('text that looks like a tag inside an attribute value is no tag', () => {
  it.each([
    [
      'a literal <template> in a value inside a template',
      `<template><div data-x="<template>"></div></template>${META}`,
    ],
    ['the same with single quotes', `<template><div data-x='<template>'></div></template>${META}`],
    ['a literal <template> in a value outside any template', `<div data-x="<template>"></div>${META}`],
    ['a literal <script> in a value outside any script', `<div data-x="<script>"></div>${META}`],
    [
      'a literal <script> in a value inside a template',
      `<template><div data-x="<script>"></div></template>${META}`,
    ],
    ['a ">" in a value does not end the tag', `<div data-x="a>b <template>"></div>${META}`],
    ['spaces around "=" before the quote', `<template><div data-x = "<template>"></div></template>${META}`],
  ])('the real meta after it is found: %s', (_label, html) => {
    expect(detectClientRedirect(html, BASE)).toEqual(NEXT);
  });

  it.each([
    [
      'a literal </template> in a value of a tag inside the template',
      `<template><div title="</template>">${META}</div></template>`,
    ],
    [
      'a literal </template> in a single-quoted value',
      `<template><div title='</template>'>${META}</div></template>`,
    ],
    [
      'a literal </script> in a value inside a template',
      `<template><div title="</script>">${META}</div></template>`,
    ],
  ])('the inert meta stays inert: %s', (_label, html) => {
    expect(detectClientRedirect(html, BASE)).toBeNull();
  });

  it('a form after a value with a literal template tag is found; one inside the template is not', () => {
    expect(detectForm(`<div data-x="<template>"></div>${FORM}`)).toBe(true);
    expect(detectForm(`<template><div title="</template>">${FORM}</div></template>`)).toBe(false);
  });

  it('counterexamples: quotes that are no attribute values change nothing', () => {
    // an apostrophe in an attribute name or in the middle of an unquoted value
    expect(detectClientRedirect(`<template><p don't></p></template>${META}`, BASE)).toEqual(NEXT);
    expect(detectClientRedirect(`<template><p a=b'c></p></template>${META}`, BASE)).toEqual(NEXT);
    // a "<" that starts no tag
    expect(detectClientRedirect(`<p>5 < 6 and 7 <8 are numbers</p>${META}`, BASE)).toEqual(NEXT);
    // an unterminated tag at the end hides nothing that came before it
    expect(detectClientRedirect(`<div title="x`, BASE)).toBeNull();
    expect(detectClientRedirect(`${META}<template>x</template><div title="x`, BASE)).toEqual(NEXT);
  });

  it('the search for a tag end stays fast on input without any ">"', () => {
    const t0 = Date.now();
    detectClientRedirect(`<script ${'x '.repeat(30000)}`, BASE);
    detectClientRedirect(`<template>${'<div a="'.repeat(8000)}`, BASE);
    detectClientRedirect(`<template>${'<a '.repeat(20000)}`, BASE);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('extractMeta reads the markup of the document, not of inert elements', () => {
  it.each([
    [
      'template',
      '<template><meta http-equiv="content-security-policy" content="frame-ancestors portal.invalid/x"></template>',
    ],
    [
      'noscript',
      '<noscript><meta http-equiv="content-security-policy" content="frame-ancestors \'none\'"></noscript>',
    ],
    [
      'nested template',
      '<template><template></template><meta http-equiv="content-security-policy" content="default-src \'self\'"></template>',
    ],
    ['comment', '<!-- <meta http-equiv="content-security-policy" content="default-src \'self\'"> -->'],
  ])('an inert http-equiv meta in %s is no meta of the document', (_label, inert) => {
    expect(extractMeta(`${inert}<meta name="referrer" content="unsafe-url">`)).toEqual({
      httpEquiv: [],
      referrer: 'unsafe-url',
    });
  });

  it('an inert referrer meta is not the referrer of the document', () => {
    expect(
      extractMeta('<template><meta name="referrer" content="unsafe-url"></template>').referrer,
    ).toBeNull();
    expect(
      extractMeta('<noscript><meta name="referrer" content="unsafe-url"></noscript>').referrer,
    ).toBeNull();
  });

  it('real metas before and after an inert element are found, the one inside is not', () => {
    const m = extractMeta(
      `<meta http-equiv="X-UA-Compatible" content="IE=edge"><template><meta http-equiv="refresh" content="0"></template><meta name="referrer" content="no-referrer"><meta http-equiv="content-security-policy" content="img-src data:">`,
    );
    expect(m.httpEquiv.map((h) => h.name)).toEqual(['x-ua-compatible', 'content-security-policy']);
    expect(m.referrer).toBe('no-referrer');
  });
});
