/**
 * What the HTTP collector stores of `<meta http-equiv>` names: the name is untrusted page text, so it is kept only in
 * the shape of a header name (≤ 40 characters of `[a-z0-9._-]`) and the record count is bounded. HDR-01 reads one name.
 */
import { describe, expect, it } from 'vitest';
import { extractMeta } from '../../../../src/collectors/http/html.ts';
import { storedMetaHttpEquiv } from '../../../../src/collectors/http/index.ts';

const BASE = 'http://www.example.test/';
const meta = (name: string, content: string) => ({ name: name.toLowerCase(), value: content });

describe('the names of <meta http-equiv> are bounded when they are stored', () => {
  it('a name that carries an address is not stored', () => {
    const out = storedMetaHttpEquiv([meta('zq7alice@mail.invalid', 'v'), meta('refresh', '0')], BASE);
    expect(out.map((m) => m.name)).toEqual(['refresh']);
    expect(JSON.stringify(out)).not.toContain('zq7');
  });

  it.each([
    ['a name of 30 000 characters', 'x'.repeat(30_000)],
    ['a name of 41 characters', 'a'.repeat(41)],
    ['a name with a blank', 'content security policy'],
    ['a name with an at sign', 'a@b'],
    ['a name with a slash', 'a/b'],
    ['a name with a quote', 'a"b'],
    ['a name that starts with a hyphen', '-refresh'],
    ['a non-ASCII name', 'refreshä'],
  ])('%s is not stored', (_label, name) => {
    expect(storedMetaHttpEquiv([meta(name, 'v')], BASE)).toEqual([]);
  });

  it.each([
    'refresh',
    'content-security-policy',
    'x-ua-compatible',
    'content-type',
    'default-style',
    'a'.repeat(40),
    'x_custom.v2',
  ])('a name of the shape of a header name is stored: %s', (name) => {
    expect(storedMetaHttpEquiv([meta(name, 'v')], BASE).map((m) => m.name)).toEqual([name]);
  });

  it('a hostile document of short tags with distinct names is stored in a bounded number of records', () => {
    const tags = Array.from({ length: 1549 }, (_, i) => `<meta http-equiv="h${i}-yyyyy" content="v">`);
    const html = tags.join('').slice(0, 64 * 1024);
    const parsed = extractMeta(html);
    expect(parsed.httpEquiv.length).toBeGreaterThan(1000);
    const out = storedMetaHttpEquiv(parsed.httpEquiv, BASE);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(out).length).toBeLessThan(4_000);
    // the first ones are the ones that are kept, in document order
    expect(out.map((m) => m.name)).toEqual(parsed.httpEquiv.slice(0, out.length).map((m) => m.name));
  });

  it('a hostile document of long names with an address in each stores nothing of them', () => {
    const name = `${'x'.repeat(30_000)}zq7bob@mail.invalid`;
    const out = storedMetaHttpEquiv(
      extractMeta(`<meta http-equiv="${name}" content="v">`.repeat(2)).httpEquiv,
      BASE,
    );
    expect(out).toEqual([]);
  });

  it('counterexample: an ordinary set is stored as before (values reduced like a response header)', () => {
    const html = [
      '<meta http-equiv="Refresh" content="0; url=/next?email=zq7alice@mail.invalid&amp;sid=zq7session">',
      '<meta http-equiv="Content-Security-Policy" content="frame-ancestors portal.invalid/users/zq7alice%40mail.invalid">',
      '<meta http-equiv="set-cookie" content="zq7id=zq7cookievalue; path=/">',
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    ].join('');
    const out = storedMetaHttpEquiv(extractMeta(html).httpEquiv, BASE);
    expect(out.map((m) => m.name)).toEqual([
      'refresh',
      'content-security-policy',
      'set-cookie',
      'x-ua-compatible',
    ]);
    expect(out.find((m) => m.name === 'content-security-policy')?.value).toBe(
      'frame-ancestors portal.invalid',
    );
    expect(out.find((m) => m.name === 'set-cookie')?.value).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('zq7');
  });

  it('the values of kept meta tags lose relative URLs with a query and addresses, like the response headers', () => {
    const html = [
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; report-uri /csp?visitor=zq7alice">',
      '<meta http-equiv="X-Frame-Options" content="ALLOW-FROM zq7max@example.test">',
      '<meta http-equiv="Link" content="</a.css>; rel=preload, https://cdn.example.test/p?uid=zq7alice">',
      '<meta http-equiv="Content-Language" content="mailto:zq7max@example.test">',
    ].join('');
    expect(storedMetaHttpEquiv(extractMeta(html).httpEquiv, BASE)).toEqual([
      {
        name: 'content-security-policy',
        value: "default-src 'self'; report-uri http://www.example.test/csp?visitor=[redacted]",
      },
      { name: 'x-frame-options', value: 'ALLOW-FROM [redacted]@example.test' },
      {
        name: 'link',
        value: '<http://www.example.test/a.css>; rel=preload, https://cdn.example.test/p?uid=[redacted]',
      },
      { name: 'content-language', value: 'mailto:[redacted]@example.test' },
    ]);
  });

  it('a query value with a comma and a quote glued to a CSP URL do not keep the text after them', () => {
    const html = [
      '<meta http-equiv="X-Frame-Options" content="ALLOW-FROM /embed?ref=a,zq7tail">',
      `<meta http-equiv="Content-Security-Policy" content='report-uri https://r.example.test/csp"zq7meta@mail.example'>`,
    ].join('');
    expect(storedMetaHttpEquiv(extractMeta(html).httpEquiv, BASE)).toEqual([
      { name: 'x-frame-options', value: 'ALLOW-FROM http://www.example.test/embed?ref=[redacted]' },
      { name: 'content-security-policy', value: 'report-uri https://r.example.test' },
    ]);
  });

  it('a meta tag named like a product header is no response header: its value stays redacted, without product facts', () => {
    const html = [
      '<meta http-equiv="X-Powered-By" content="PHP/7.2.34">',
      '<meta name="generator" content="WordPress 6.4.2">',
    ].join('');
    expect(storedMetaHttpEquiv(extractMeta(html).httpEquiv, BASE)).toEqual([
      { name: 'x-powered-by', value: '[redacted]' },
    ]);
  });

  it('counterexample: a document with a few records loses none of them', () => {
    const records = Array.from({ length: 32 }, (_, i) => meta(`h${i}`, 'v'));
    expect(storedMetaHttpEquiv(records, BASE)).toHaveLength(32);
    expect(storedMetaHttpEquiv([...records, meta('refresh', '0')], BASE)).toHaveLength(32);
  });

  it('counts CSP within the 32 stored records', () => {
    // Characterizes the existing limit, including CSP at and beyond the boundary.
    const records = [
      ...Array.from({ length: 31 }, (_, i) => meta(`h${i}`, 'v')),
      meta('content-security-policy', "default-src 'self'"),
      meta('content-security-policy', "img-src 'none'"),
    ];
    const out = storedMetaHttpEquiv(records, BASE);
    expect(out).toHaveLength(32);
    expect(out.at(-1)?.value).toBe("default-src 'self'");
  });
});
