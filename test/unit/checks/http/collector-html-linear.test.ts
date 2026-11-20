/**
 * HTTP heuristics read untrusted markup: legal-link selection and forms accept the whole bounded body, other probes its
 * prefix; repeated incomplete tags must not restart a scan at every candidate, ordinary markup keeps the extracted facts.
 */
import { describe, expect, it } from 'vitest';
import {
  dataForms,
  detectClientRedirect,
  detectForm,
  extractMeta,
  findLegalLinks,
  parseAttributes,
} from '../../../../src/collectors/http/html.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';

const BASE = 'http://www.example.test/start';
const KIB = 1024;
const BIG_BYTES = 4 * 1024 * KIB;

const fill = (unit: string, bytes: number): string =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** Compare growth rather than a machine-dependent latency budget. Warm up and use the best sample to limit GC noise. */
function expectLinear(
  run: (input: string) => unknown,
  build: (bytes: number) => string,
  bytes: number,
): void {
  const small = build(bytes);
  const large = build(4 * bytes);
  expectLinearGrowth(
    () => run(small),
    () => run(large),
  );
}

type Run = (html: string) => unknown;
const links: Run = (h) => findLegalLinks(h, BASE);
const redirect: Run = (h) => detectClientRedirect(h, BASE);
const meta: Run = (h) => extractMeta(h);
const form: Run = (h) => detectForm(h);
const forms: Run = (h) => dataForms(h, BASE);
/** The read limit of a document: forms are looked for in all of it. */
const DOCUMENT_BYTES = 512 * KIB;

type Hostile = [name: string, run: Run, smallBytes: number, build: (bytes: number) => string];
const repeatMarkup = (markup: string) => (bytes: number) => fill(markup, bytes);

const HOSTILE: readonly Hostile[] = [
  ['findLegalLinks: "<a " without any ">"', links, 128 * KIB, repeatMarkup('<a ')],
  ['findLegalLinks: opening tags without a closing </a>', links, 256 * KIB, repeatMarkup('<a href="/x">')],
  [
    'findLegalLinks: "<" in the text of one link',
    links,
    256 * KIB,
    (n) => `<a href="/x">${fill('<', n)}</a>`,
  ],
  ['findLegalLinks: unterminated comments', links, 256 * KIB, repeatMarkup('<!--')],
  ['detectClientRedirect: unterminated comments', redirect, 128 * KIB, repeatMarkup('<!--')],
  ['detectForm: "<form " without any ">"', form, 128 * KIB, repeatMarkup('<form ')],
  [
    'detectForm: "<input " without any ">" inside a form',
    form,
    128 * KIB,
    (n) => `<form>${fill('<input ', n)}`,
  ],
  ['detectClientRedirect: "<script " without any ">"', redirect, 128 * KIB, repeatMarkup('<script ')],
  ['detectClientRedirect: unclosed <script> elements', redirect, 512 * KIB, repeatMarkup('<script>')],
  ['extractMeta: every ">" sits inside a quoted attribute value', meta, 64 * KIB, repeatMarkup('<a x=">" ')],
  [
    'detectClientRedirect: every ">" sits inside a quoted attribute value',
    redirect,
    64 * KIB,
    repeatMarkup('<a x=">" '),
  ],
  [
    'extractMeta: the same inside an unclosed <template>',
    meta,
    64 * KIB,
    (n) => `<template>${fill('<a x=">" ', n)}`,
  ],
  ['extractMeta: single-quoted values that hold a ">"', meta, 64 * KIB, repeatMarkup("<a x='>' ")],
  ['findLegalLinks: tags with a quoted ">" and no closing </a>', links, 256 * KIB, repeatMarkup('<a x=">" ')],
  // Forms are looked for in the whole document read (512 KiB), so the adversarial input reaches that size.
  [
    'dataForms: unclosed forms, each with a field',
    forms,
    DOCUMENT_BYTES / 4,
    repeatMarkup('<form method=post><textarea>'),
  ],
  ['dataForms: "<form " without any ">"', forms, DOCUMENT_BYTES / 4, repeatMarkup('<form action="/x" ')],
  [
    'dataForms: "<input " without any ">" inside one form',
    forms,
    DOCUMENT_BYTES / 4,
    (n) => `<form method="post">${fill('<input name="a" ', n)}`,
  ],
  [
    'dataForms: closed forms with a field each',
    forms,
    DOCUMENT_BYTES / 4,
    repeatMarkup('<form action="/a?b=c"><input name="e"></form>'),
  ],
  [
    'dataForms: unclosed templates and scripts before the forms',
    forms,
    DOCUMENT_BYTES / 4,
    repeatMarkup('<template><script>'),
  ],
];

describe('HTML parsing scales with hostile input size', () => {
  it.each(HOSTILE)('%s', (_name, run, bytes, build) => {
    expectLinear(run, build, bytes);
  });

  it('finds no legal link in a large ordinary product list', () => {
    const build = (n: number) => fill('<a href="/shop/item">Artikel</a> ', n);
    expectLinear(links, build, 256 * KIB);
    expect(findLegalLinks(build(BIG_BYTES), BASE)).toEqual({});
  });

  it('finds a legal footer behind an unterminated comment', () => {
    const footer = '<footer><a href="/impressum">Impressum</a></footer>';
    const build = (n: number) => `${fill('<!--', n)}${footer}`;
    expectLinear(links, build, 256 * KIB);
    expect(findLegalLinks(build(BIG_BYTES), BASE)).toEqual({
      impressum: 'http://www.example.test/impressum',
    });
  });

  it('finds a comment form at the end of a document of the full read size', () => {
    const tail = '<form action="/wp-comments-post.php" method="post"><textarea name="c"></textarea></form>';
    const big = `${fill('<p>text</p>', DOCUMENT_BYTES - tail.length)}${tail}`;
    expect(dataForms(big, BASE)).toEqual([
      { action: 'http://www.example.test/wp-comments-post.php', actionScheme: 'http', method: 'post' },
    ]);
  });

  it('finds both footer links behind a full body of ordinary markup', () => {
    const big = `${fill('<p>text</p>', BIG_BYTES)}<footer><a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer>`;
    expect(findLegalLinks(big, BASE)).toEqual({
      impressum: 'http://www.example.test/impressum',
      privacy: 'http://www.example.test/datenschutz',
    });
  });

  it.each(['a="', "a='", 'a= ', 'a=', 'a ', '= ', '"', '/', 'a=b ', 'a="b" '])(
    'parses long unbalanced attribute lists: %j',
    (unit) => expectLinear(parseAttributes, (n) => `<x ${fill(unit, n)}>`, 256 * KIB),
  );

  it.each(["location='", 'location = ', "location.replace('", 'location.href="a" ', 'location\n'])(
    'parses large inline scripts: %j',
    (unit) => expectLinear(redirect, (n) => `<script>${fill(unit, n)}</script>`, 256 * KIB),
  );
});

describe('HTML parsing of ordinary and malformed markup', () => {
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
    // A custom element is no form, like `<template-card>` is no template.
    [`<form-x><input name="email"></form-x>`, false],
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
