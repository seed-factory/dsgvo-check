/**
 * L1 (P1): the HTML heuristics of the HTTP collector read untrusted markup in linear time. `findLegalLinks` gets the
 * whole body of the start page (up to `MAX_DECODED_BYTES` = 4 MiB), the other functions the first 64 KiB; a regexp
 * that restarts its scan at every `<a `, `<form `, `<!--`… (or a tag-end search that fails at every tag) was
 * quadratic: 128 KiB of `<a ` held the event loop for 3 s, 4 MiB for about an hour.
 *
 * The first block feeds hostile shapes: a small input must be quick (the old code needs seconds), and then 4 MiB must
 * be quick too. The second block pins the answers for ordinary markup (they were the same before the fix, the
 * differential fuzz against the old code found no other difference).
 */
import { describe, expect, it } from 'vitest';
import {
  detectClientRedirect,
  detectForm,
  extractMeta,
  findLegalLinks,
  parseAttributes,
} from '../../../../src/collectors/http/html.ts';

const BASE = 'http://www.example.test/start';
const KIB = 1024;
const BIG_BYTES = 4 * 1024 * KIB;
/** The old code needs 0.9 to 10 s for the small inputs; the linear one a few milliseconds. */
const SMALL_BUDGET_MS = 200;
const BIG_BUDGET_MS = 1000;

const fill = (unit: string, bytes: number): string =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

function elapsedMs(run: () => unknown): number {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
}

type Run = (html: string) => unknown;
const links: Run = (h) => findLegalLinks(h, BASE);
const redirect: Run = (h) => detectClientRedirect(h, BASE);
const meta: Run = (h) => extractMeta(h);
const form: Run = (h) => detectForm(h);

interface Hostile {
  name: string;
  run: Run;
  /** Size where the old code takes seconds. */
  smallBytes: number;
  build: (bytes: number) => string;
}

const HOSTILE: readonly Hostile[] = [
  {
    name: 'findLegalLinks: "<a " without any ">"',
    run: links,
    smallBytes: 128 * KIB,
    build: (n) => fill('<a ', n),
  },
  {
    name: 'findLegalLinks: opening tags without a closing </a>',
    run: links,
    smallBytes: 256 * KIB,
    build: (n) => fill('<a href="/x">', n),
  },
  {
    name: 'findLegalLinks: "<" in the text of one link',
    run: links,
    // 256 KiB, not 64: a tag strip that searches every "<" again (quadratic) still takes under 200 ms at 64 KiB and
    // shows only at 4 MiB, after minutes in which the runner cannot interrupt it (review m1); at 256 KiB it takes 0.9 s
    smallBytes: 256 * KIB,
    build: (n) => `<a href="/x">${fill('<', n)}</a>`,
  },
  {
    name: 'findLegalLinks: unterminated comments',
    run: links,
    smallBytes: 256 * KIB,
    build: (n) => fill('<!--', n),
  },
  {
    name: 'extractMeta: unterminated comments',
    run: meta,
    smallBytes: 256 * KIB,
    build: (n) => fill('<!--', n),
  },
  {
    name: 'detectClientRedirect: unterminated comments',
    run: redirect,
    smallBytes: 128 * KIB,
    build: (n) => fill('<!--', n),
  },
  {
    name: 'detectForm: unterminated comments',
    run: form,
    smallBytes: 256 * KIB,
    build: (n) => fill('<!--', n),
  },
  {
    name: 'detectForm: "<form " without any ">"',
    run: form,
    smallBytes: 128 * KIB,
    build: (n) => fill('<form ', n),
  },
  {
    name: 'detectForm: "<input " without any ">" inside a form',
    run: form,
    smallBytes: 128 * KIB,
    build: (n) => `<form>${fill('<input ', n)}`,
  },
  {
    name: 'detectClientRedirect: "<script " without any ">"',
    run: redirect,
    smallBytes: 128 * KIB,
    build: (n) => fill('<script ', n),
  },
  {
    name: 'detectClientRedirect: unclosed <script> elements',
    run: redirect,
    smallBytes: 512 * KIB,
    build: (n) => fill('<script>', n),
  },
  {
    name: 'extractMeta: every ">" sits inside a quoted attribute value',
    run: meta,
    smallBytes: 64 * KIB,
    build: (n) => fill('<a x=">" ', n),
  },
  {
    name: 'detectClientRedirect: every ">" sits inside a quoted attribute value',
    run: redirect,
    smallBytes: 64 * KIB,
    build: (n) => fill('<a x=">" ', n),
  },
  {
    name: 'detectForm: every ">" sits inside a quoted attribute value',
    run: form,
    smallBytes: 64 * KIB,
    build: (n) => fill('<a x=">" ', n),
  },
  {
    name: 'extractMeta: the same inside an unclosed <template>',
    run: meta,
    smallBytes: 64 * KIB,
    build: (n) => `<template>${fill('<a x=">" ', n)}`,
  },
  {
    name: 'extractMeta: single-quoted values that hold a ">"',
    run: meta,
    smallBytes: 64 * KIB,
    build: (n) => fill("<a x='>' ", n),
  },
  {
    name: 'findLegalLinks: tags with a quoted ">" and no closing </a>',
    run: links,
    smallBytes: 256 * KIB,
    build: (n) => fill('<a x=">" ', n),
  },
];

describe('P1: hostile markup is read in linear time', () => {
  it.each(HOSTILE.map((h) => [h.name, h] as const))('%s', (_name, h) => {
    const small = h.build(h.smallBytes);
    expect(elapsedMs(() => h.run(small))).toBeLessThan(SMALL_BUDGET_MS);
    const big = h.build(BIG_BYTES);
    expect(big.length).toBeGreaterThanOrEqual(BIG_BYTES);
    expect(elapsedMs(() => h.run(big))).toBeLessThan(BIG_BUDGET_MS);
  });

  it('findLegalLinks: 4 MiB of ordinary links without a legal one is a linear walk too', () => {
    const big = fill('<a href="/shop/item">Artikel</a> ', BIG_BYTES);
    expect(elapsedMs(() => findLegalLinks(big, BASE))).toBeLessThan(BIG_BUDGET_MS);
  });

  it('findLegalLinks: a legal link in the footer behind hostile markup is still found', () => {
    // an unterminated "<!--" is no comment: the footer link behind it is part of the document
    const footer = '<footer><a href="/impressum">Impressum</a></footer>';
    const small = `${fill('<!--', 256 * KIB)}${footer}`;
    expect(elapsedMs(() => findLegalLinks(small, BASE))).toBeLessThan(SMALL_BUDGET_MS);
    const big = `${fill('<!--', BIG_BYTES)}${footer}`;
    const t0 = performance.now();
    const found = findLegalLinks(big, BASE);
    expect(performance.now() - t0).toBeLessThan(BIG_BUDGET_MS);
    expect(found).toEqual({ impressum: 'http://www.example.test/impressum' });
  });

  it('findLegalLinks: the footer links behind 4 MiB of other markup are found (the body is not cut at 64 KiB)', () => {
    const big = `${fill('<p>text</p>', BIG_BYTES)}<footer><a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer>`;
    const t0 = performance.now();
    const found = findLegalLinks(big, BASE);
    expect(performance.now() - t0).toBeLessThan(BIG_BUDGET_MS);
    expect(found).toEqual({
      impressum: 'http://www.example.test/impressum',
      privacy: 'http://www.example.test/datenschutz',
    });
  });

  it('parseAttributes: long and unbalanced attribute lists stay linear', () => {
    for (const unit of ['a="', "a='", 'a= ', 'a=', 'a ', '= ', '"', '/', 'a=b ', 'a="b" ']) {
      const tag = `<x ${fill(unit, BIG_BYTES)}>`;
      expect(
        elapsedMs(() => parseAttributes(tag)),
        JSON.stringify(unit),
      ).toBeLessThan(BIG_BUDGET_MS);
    }
  });

  it('detectClientRedirect: big inline scripts with location-like text stay linear', () => {
    for (const unit of [
      "location='",
      'location = ',
      "location.replace('",
      'location.href="a" ',
      'location\n',
    ]) {
      const html = `<script>${fill(unit, BIG_BYTES)}</script>`;
      expect(
        elapsedMs(() => detectClientRedirect(html, BASE)),
        JSON.stringify(unit),
      ).toBeLessThan(BIG_BUDGET_MS);
    }
  });
});

describe('P1 counterexamples: ordinary markup is read as before', () => {
  it.each<[string, Record<string, string>]>([
    [
      `<a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a>`,
      { impressum: 'http://www.example.test/impressum', privacy: 'http://www.example.test/datenschutz' },
    ],
    [`<A HREF='/Impressum'>x</A>`, { impressum: 'http://www.example.test/Impressum' }],
    [`<a href="/x"><span>Legal</span> <b>Notice</b></a>`, { impressum: 'http://www.example.test/x' }],
    [
      `<a href="/x"><img alt="Impressum"></a><a href="/privacy-policy"><svg></svg></a>`,
      { privacy: 'http://www.example.test/privacy-policy' },
    ],
    [
      `<a href="/dse">Datenschutz</a><!-- <a href="/impressum">Impressum</a> --><a href="/legal">Impressum</a>`,
      { privacy: 'http://www.example.test/dse', impressum: 'http://www.example.test/legal' },
    ],
    [`<a href="/impressum">Impressum`, {}],
    [`<a href="/x">a</a><a href="/impressum">Impressum`, {}],
    [`<a href="/x"><a href="/impressum">Impressum</a>`, { impressum: 'http://www.example.test/x' }],
    [`<a href="/x">Impressum</a`, {}],
    [
      `<a href="/datenschutz-einstellungen">Cookie-Einstellungen</a><a href="/datenschutz">Datenschutz</a>`,
      { privacy: 'http://www.example.test/datenschutz' },
    ],
    [`<a href="/p?x=1&amp;y=2">Privacy &amp; Data</a>`, { privacy: 'http://www.example.test/p?x=1&y=2' }],
    [
      `<abbr title="x"><a href="/imprint">Imprint</a></abbr>`,
      { impressum: 'http://www.example.test/imprint' },
    ],
    [`<a-b href="/impressum">Impressum</a>`, { impressum: 'http://www.example.test/impressum' }],
    [`<a\nhref="/impressum"\n>Impressum\n</a>`, { impressum: 'http://www.example.test/impressum' }],
    [
      `<a href="/impressum">1 < 2 und 3 > 1 Impressum</a>`,
      { impressum: 'http://www.example.test/impressum' },
    ],
    [`<a href="/x">text with < never closed Impressum</a>`, { impressum: 'http://www.example.test/x' }],
    [
      `<a href="javascript:void(0)">Impressum</a><a href="mailto:a@b.test">Datenschutz</a><a href="tel:1">Privacy</a><a href="#top">Impressum</a><a>Impressum</a>`,
      {},
    ],
    [
      `<a href="https://other.test/datenschutz">Datenschutz</a><a href="/impressum">Impressum</a>`,
      { privacy: 'https://other.test/datenschutz', impressum: 'http://www.example.test/impressum' },
    ],
    [``, {}],
    [`no markup at all`, {}],
    [`<a`, {}],
    [`<a href="/impressum"`, {}],
  ])('findLegalLinks: %s', (html, expected) => {
    expect(findLegalLinks(html, BASE)).toEqual(expected);
  });

  it.each<[string, boolean]>([
    [`<form><input name="email"></form>`, true],
    [`<form></form><form><input name="email"></form>`, true],
    [`<form role="search"><input name="q"></form><form><textarea></textarea></form>`, true],
    [`<form class="site-search"><input name="x"></form>`, false],
    [`<form><input type="submit"><input type="hidden" name="a"></form><input name="outside">`, false],
    [`<FORM METHOD=post><INPUT NAME=mail></FORM>`, true],
    [`<form action="/x"`, false],
    [`<form action="/x">`, false],
    [`<form><input`, false],
    [`<form><input name="a"`, false],
    [`<form><input name="s"><input name="query"></form>`, false],
    [`<form><input type=search></form><form><select></select></form>`, true],
    [`<form id="suche"><input name="x"></form>`, false],
    [`<form><!-- <input name="email"> --></form>`, false],
    [`<form><input value="a>b" name="email"></form>`, true],
    [`<form-x><input name="email"></form-x>`, true],
    [`<form><form><input name="email"></form>`, true],
    [`<form></form><input name="email">`, false],
    [`<p>no form</p>`, false],
  ])('detectForm: %s → %s', (html, expected) => {
    expect(detectForm(html)).toBe(expected);
  });

  it.each<[string, { kind: 'meta' | 'js'; url: string | null } | null]>([
    [
      `<meta http-equiv="refresh" content="0;url=/next">`,
      { kind: 'meta', url: 'http://www.example.test/next' },
    ],
    [`<script>location.href="/js"</script>`, { kind: 'js', url: 'http://www.example.test/js' }],
    [
      `<script src=x></script><script>location.replace('/second')</script>`,
      { kind: 'js', url: 'http://www.example.test/second' },
    ],
    [
      `<script>location = "/x";</script><script>location="/y"</script>`,
      { kind: 'js', url: 'http://www.example.test/x' },
    ],
    [`<SCRIPT>location.assign("/up")</SCRIPT>`, { kind: 'js', url: 'http://www.example.test/up' }],
    [`<script>location.protocol = "https:"</script>`, { kind: 'js', url: 'https://www.example.test/start' }],
    [
      `<script>location.href = 'https://' + location.host</script>`,
      { kind: 'js', url: 'https://www.example.test/start' },
    ],
    [`<!-- <script>location.href="/c"</script> --><script>var a=1</script>`, null],
    [`<script>location.href="/unclosed"`, null],
    [
      `<script>x</script><meta http-equiv=refresh content="1; url=/m">`,
      { kind: 'meta', url: 'http://www.example.test/m' },
    ],
    [
      `<template><script>location.href="/t"</script></template>`,
      { kind: 'js', url: 'http://www.example.test/t' },
    ],
    [`<noscript><meta http-equiv="refresh" content="0;url=/n"></noscript>`, null],
    [`<scripts>location.href="/no"</scripts><script-x>location.href="/no2"</script-x>`, null],
    [``, null],
  ])('detectClientRedirect: %s', (html, expected) => {
    expect(detectClientRedirect(html, BASE)).toEqual(expected);
  });

  it.each<[string, ReturnType<typeof extractMeta>]>([
    [
      `<meta http-equiv="Content-Type" content="text/html"><meta name="Referrer" content="Origin">`,
      { httpEquiv: [{ name: 'content-type', value: 'text/html' }], referrer: 'Origin' },
    ],
    [
      `<!-- <meta name="referrer" content="unsafe-url"> --><meta name="referrer" content="no-referrer">`,
      { httpEquiv: [], referrer: 'no-referrer' },
    ],
    [`<meta name=referrer content=a><meta name=referrer content=b>`, { httpEquiv: [], referrer: 'b' }],
    [
      `<meta http-equiv=refresh content="5">`,
      { httpEquiv: [{ name: 'refresh', value: '5' }], referrer: null },
    ],
    [
      `<script>var s="<meta name=referrer content=x>"</script><meta http-equiv="x-ua-compatible" content="IE=edge">`,
      { httpEquiv: [{ name: 'x-ua-compatible', value: 'IE=edge' }], referrer: null },
    ],
    [
      `<meta http-equiv="a" content="b>c"><meta name="referrer" content="origin">`,
      { httpEquiv: [{ name: 'a', value: 'b>c' }], referrer: 'origin' },
    ],
    [`<meta name="referrer"`, { httpEquiv: [], referrer: null }],
    [`<!-- open <meta name="referrer" content="origin">`, { httpEquiv: [], referrer: 'origin' }],
  ])('extractMeta: %s', (html, expected) => {
    expect(extractMeta(html)).toEqual(expected);
  });

  it('comments: the first "-->" closes a comment, an unterminated one stays as text', () => {
    // visible through the meta tags that are (not) removed with the comment
    const m = (s: string) => extractMeta(s).referrer;
    const REF = '<meta name="referrer" content="origin">';
    expect(m(`<!--${REF}-->`)).toBeNull();
    expect(m(`<!--a-->${REF}<!--b-->`)).toBe('origin');
    expect(m(`<!--<!--${REF}-->`)).toBeNull();
    expect(m(`<!-->${REF}`)).toBe('origin');
    expect(m(`<!--->${REF}`)).toBe('origin');
    expect(m(`<!---->${REF}`)).toBe('origin');
    expect(m(`<!--${REF}`)).toBe('origin');
    expect(m(`<!-- a --><!--${REF}`)).toBe('origin');
    expect(m(`<!-- ${REF} --> ${REF.replace('origin', 'same-origin')}`)).toBe('same-origin');
  });
});
