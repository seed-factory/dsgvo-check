import { describe, expect, it } from 'vitest';
import { hstsOf } from '../../../../src/checks/http/shared.ts';
import { cspFrameAncestors, storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { headerCases } from './header-cases.ts';

const BASE = 'https://www.example.test/';
const CSP = 'content-security-policy';

describe('a kept header stores only what its grammar allows', () => {
  const LEAKS = [
    'alice',
    'visitorSecret',
    'secret',
    'QWxhZGRp',
    '123e4567',
    'first;',
    '4f3a9c1d2e7b4a9f',
    'smith',
    'ustermann',
    'Jürgen',
    'Müller',
    '+491701234567',
  ];

  it.each([
    ...headerCases(CSP, [
      [
        'an address in the (at) form after report-uri',
        'report-uri alice (at) example.test',
        'report-uri [redacted]@example.test',
      ],
      [
        'an address in the [at] form after report-uri',
        'report-uri alice [at] example.test',
        'report-uri [redacted]@example.test',
      ],
      [
        'an obfuscated address no mask reads, as sources',
        'script-src alice (at) www.example.test',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'a nonce keeps no payload',
        "script-src 'nonce-QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
        "script-src 'nonce-[redacted]'",
      ],
      [
        'a hash keeps no payload',
        "script-src 'sha256-QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
        "script-src 'sha256-[redacted]'",
      ],
    ]),
    [
      'an origin with a quoted blank and an encoded @',
      'x-frame-options',
      'ALLOW-FROM "alice smith"%252540example.test',
      '[redacted]',
    ],
    [
      'an origin that is a long run before an @',
      'x-frame-options',
      `ALLOW-FROM visitorSecret${'a'.repeat(80)}@example.test`,
      'ALLOW-FROM [redacted]',
    ],
    ...headerCases('link', [
      [
        'a title with an address in the (at) form',
        '</a>; title="alice (at) intranet"',
        '<https://www.example.test/a>; title=[redacted]',
      ],
      [
        'a title with an address before www',
        '</a>; title="alice (at) www.example.test"',
        '<https://www.example.test/a>; title=[redacted]',
      ],
      [
        'a title that is an identifier',
        '</a.css>; rel=preload; title="4f3a9c1d2e7b4a9f"',
        '<https://www.example.test/a.css>; rel=preload; title=[redacted]',
      ],
      [
        'a fragment of an anchor',
        '</a>; anchor="/r#visitorSecret"',
        '<https://www.example.test/a>; anchor="/r"',
      ],
      [
        'a semicolon inside the quotes of an anchor',
        '</a>; anchor="/r?x=first;visitorSecret"',
        '<https://www.example.test/a>; anchor="https://www.example.test/r?x=[redacted]"',
      ],
      [
        'a semicolon in the fragment of an anchor',
        '</a>; anchor="/r#first;visitorSecret"',
        '<https://www.example.test/a>; anchor="/r"',
      ],
      [
        'a comma and a semicolon inside the quotes of another parameter',
        '</a>; title="x,first;visitorSecret"',
        '<https://www.example.test/a>; title=[redacted]',
      ],
    ]),
    [
      'a parameter value that is no token of the header',
      'content-type',
      'text/html; token=123e4567-e89b-12d3-a456-426614174000',
      'text/html; token=[redacted]',
    ],
  ])('%s', (_label, name, value, expected) => {
    const stored = storedHeaderRecord(name, value, BASE, sanitizeUrl).value;
    expect(stored).toBe(expected);
    for (const leak of LEAKS) expect(stored).not.toContain(leak);
  });
});

describe('closed grammars: a value outside the grammar of its parameter, name or directive is redacted', () => {
  const LEAKS = [
    'alice',
    'visitorSecret',
    '123e4567',
    '4f3a9c1d2e7b4a9f',
    'smith',
    'ustermann',
    'Jürgen',
    'Müller',
    '+4917',
  ];
  const UUID = '123e4567-e89b-12d3-a456-426614174000';
  const L = '<https://www.example.test/a>';

  it.each([
    ...headerCases('link', [
      ['rel is an identifier', '</a>; rel=4f3a9c1d2e7b4a9f', `${L}; rel=[redacted]`],
      ['rel is a UUID', `</a>; rel="${UUID}"`, `${L}; rel=[redacted]`],
      ['rel holds a word after a relation', '</a>; rel=next visitorSecret', `${L}; rel=next [redacted]`],
      ['rel holds a name', '</a>; rel="alice smith"', `${L}; rel="[redacted] [redacted]"`],
      ['crossorigin is a UUID', `</a>; crossorigin="${UUID}"`, `${L}; crossorigin=[redacted]`],
      [
        'fetchpriority is an identifier',
        '</a>; fetchpriority=4f3a9c1d2e7b4a9f',
        `${L}; fetchpriority=[redacted]`,
      ],
      ['as is a name', '</a>; as=Max Mustermann', `${L}; as=[redacted] [redacted]`],
      ['hreflang is a name', '</a>; hreflang="Max Mustermann"', `${L}; hreflang=[redacted]`],
      [
        'media is words and an identifier',
        '</a>; media="alice smith 4f3a9c1d2e7b4a9f"',
        `${L}; media=[redacted]`,
      ],
      ['a parameter name is a word', '</a>; visitorSecret', `${L}; [redacted]`],
      ['unknown parameters in a row are one', '</a>; alice-smith; Max', `${L}; [redacted]`],
      ['a parameter name is an identifier', '</a>; x4f3a9c1d2e7b4a9f', `${L}; [redacted]`],
      [
        'an unknown parameter after a known one',
        '</a>; rel=next; visitorSecret=[redacted]',
        `${L}; rel=next; [redacted]`,
      ],
      [
        'an unquoted anchor with a semicolon in its query',
        '</a>; anchor=/r?x=first;visitorSecret',
        `${L}; anchor=https://www.example.test/r?x=[redacted];[redacted]`,
      ],
    ]),
    ...headerCases(CSP, [
      ['a directive name is a word', "default-src 'self'; aliceSmith", "default-src 'self'; [redacted]"],
      [
        'a semicolon in the query of a source',
        'script-src https://cdn.example.test/a?x;visitorSecret',
        'script-src https://cdn.example.test/a;[redacted]',
      ],
      [
        'a semicolon in the query of a report-uri',
        'report-uri /r?x=1;visitorSecret',
        'report-uri https://www.example.test/r?x=[redacted];[redacted]',
      ],
      [
        'a semicolon in the fragment of a report-uri',
        'report-uri /r#x;visitorSecret',
        'report-uri /r;[redacted]',
      ],
      ['a comma before a word', 'report-uri /csp,visitorSecret', 'report-uri /csp,[redacted]'],
      [
        'a word after a comma and a blank',
        'report-uri https://r.example.test/csp?ids=1, visitorSecret',
        'report-uri https://r.example.test/csp?ids=[redacted], [redacted]',
      ],
    ]),
    ['an identifier as the only token', 'x-content-type-options', UUID, '[redacted]'],
    [
      'an identifier after a referrer policy',
      'referrer-policy',
      'strict-origin-when-cross-origin, 4f3a9c1d2e7b4a9f',
      'strict-origin-when-cross-origin, [redacted]',
    ],
    [
      'a reporting group that is an identifier',
      'cross-origin-opener-policy',
      'same-origin; report-to="visitorSecret4f3a9c1d2e7b4a9f"',
      'same-origin; [redacted]',
    ],
    ['a feature that is an identifier', 'permissions-policy', 'x4f3a9c1d2e7b4a9f=*', '[redacted]'],
    ['a feature that is a name', 'permissions-policy', 'alice-smith=(self)', '[redacted]'],
    [
      'a subtype and a charset that are identifiers',
      'content-type',
      'application/4f3a9c1d2e7b4a9f; charset=4f3a9c1d2e7b4a9f',
      '[redacted]; charset=[redacted]',
    ],
    ['a Retry-After of many digits', 'retry-after', '1234567890123456', '[redacted]'],
    ...headerCases(CSP, [
      ['two words as sources', 'script-src Jürgen Müller', 'script-src [redacted] [redacted]'],
      ['two words as report-uri values', 'report-uri Max Mustermann', 'report-uri [redacted] [redacted]'],
      [
        'words after a URL',
        'report-uri https://r.example.test/a b c',
        'report-uri https://r.example.test/a [redacted] [redacted]',
      ],
      ['a UUID as a source', `script-src ${UUID}`, 'script-src [redacted]'],
      ['an opaque URL in report-uri', `report-uri x:4f3a9c1d2e7b4a9f-${UUID}`, 'report-uri x:[redacted]'],
      ['a phone number in report-uri', 'report-uri tel:+491701234567', 'report-uri tel:[redacted]'],
      [
        'a path on a ws URL in report-uri',
        'report-uri ws://r.example.test/x/visitorSecret',
        'report-uri ws:[redacted]',
      ],
    ]),
    ['an opaque Link target', 'link', '<x:visitorSecret>; rel=next', '<x:[redacted]>; rel=next'],
    ['an opaque anchor', 'link', '</a>; anchor="javascript:alice"', `${L}; anchor="javascript:[redacted]"`],
    ['an opaque report URL', 'x-xss-protection', '1; report=x:visitorSecret', '1; report=x:[redacted]'],
    ...headerCases(CSP, [
      [
        'several words and (dot) before an obfuscated address',
        'report-uri alice (dot) smith (at) mail.invalid',
        'report-uri [redacted] [redacted] [redacted]@mail.invalid',
      ],
      [
        'the same as sources',
        'script-src alice (dot) smith (at) mail.invalid',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'the German marker for the dot',
        'report-uri max (punkt) mustermann (at) firma.de',
        'report-uri [redacted] [redacted] [redacted]@firma.de',
      ],
      [
        'a word before the local part',
        'report-uri alice smith (at) mail.invalid',
        'report-uri [redacted] [redacted]@mail.invalid',
      ],
      [
        'an @ with blanks around it',
        'report-uri alice @ mail.invalid',
        'report-uri [redacted] [redacted] [redacted]',
      ],
      [
        'an @ with blanks around it, as sources',
        'script-src alice @ mail.invalid',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'a marker glued to the host',
        'script-src alice (at)www.example.test',
        'script-src [redacted] [redacted]',
      ],
      [
        'an address in a path segment of a source',
        'script-src https://cdn.example.test/u/alice@intranet',
        'script-src https://cdn.example.test/',
      ],
      [
        'a tilde name and @ in a path segment',
        'script-src https://cdn.example.test/u/~alice@',
        'script-src https://cdn.example.test',
      ],
      [
        'a name with @localhost in a path',
        'script-src https://cdn.example.test/u/alice@localhost/',
        'script-src https://cdn.example.test/',
      ],
      [
        'an identifier in a path segment of a source',
        'script-src https://cdn.example.test/u/4f3a9c1d2e7b4a9f/app.js',
        'script-src https://cdn.example.test/',
      ],
      [
        'a mask the server wrote itself in report-uri',
        'report-uri /u/alice[redacted]@mail.invalid',
        'report-uri [redacted]',
      ],
      [
        'a mask the server wrote itself before a single-label host',
        'report-uri alice[redacted]@intranet',
        'report-uri [redacted]',
      ],
    ]),
    [
      'a mask the server wrote itself in an anchor',
      'link',
      '</a>; anchor="/u/alice[redacted]@intranet"',
      `${L}; anchor=[redacted]`,
    ],
    [
      'a mask the server wrote itself in a report URL',
      'x-xss-protection',
      '1; report=/u/alice[redacted]@mail.invalid',
      '1; report=[redacted]',
    ],
    ...headerCases('strict-transport-security', [
      [
        'a repeated max-age with a value that is no number',
        'max-age=31536000; max-age=abc',
        'max-age=31536000; max-age=[redacted]',
      ],
      ['a repeated max-age without a value', 'max-age=31536000; max-age', 'max-age=31536000; max-age'],
      [
        'a repeated max-age with a negative value',
        'max-age=31536000; max-age=-1',
        'max-age=31536000; max-age=[redacted]',
      ],
      [
        'a repeated max-age with an exponent',
        'max-age=31536000; max-age=1e9',
        'max-age=31536000; max-age=[redacted]',
      ],
      [
        'a repeated includeSubDomains with a value',
        'max-age=31536000; includeSubDomains; includeSubDomains=1',
        'max-age=31536000; includeSubDomains; includeSubDomains=[redacted]',
      ],
      [
        'a max-age of more digits than a browser tells apart',
        'max-age=99999999999999999999999',
        'max-age=999999999999999',
      ],
    ]),
  ])('%s', (_label, name, value, expected) => {
    const rec = storedHeaderRecord(name, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(expected);
    for (const leak of LEAKS) expect(JSON.stringify(rec)).not.toContain(leak);
  });

  it.each([
    'max-age=31536000; max-age=abc',
    'max-age=31536000; max-age',
    'max-age=31536000; max-age=-1',
    'max-age=31536000; max-age=1e9',
    'max-age=31536000; includeSubDomains; includeSubDomains=1',
    'max-age=31536000; includeSubDomains; preload',
    'max-age=0',
    'includeSubDomains',
  ])('the HSTS verdict of the stored value is the verdict of the value as sent: %s', (value) => {
    const stored = storedHeaderRecord('strict-transport-security', value, BASE, sanitizeUrl);
    const raw = { name: 'strict-transport-security', value };
    expect(hstsOf([stored])).toEqual(hstsOf([raw]));
  });

  it.each([
    ['frame-ancestors * (at) x', 'frame-ancestors * [redacted] [redacted]'],
    ['frame-ancestors https: [at] x', 'frame-ancestors https: [redacted] [redacted]'],
  ])(
    'a hidden address keeps the wildcard and the scheme, so the stored value reads as open framing: %s',
    (value, expected) => {
      const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
      expect(rec.value).toBe(expected);
      expect(cspFrameAncestors(rec.value).restricts).toBe(false);
      expect(rec.frameAncestors?.restricts).toBe(false);
    },
  );

  it.each([
    [
      "frame-ancestors 'self' alice (at) mail.invalid",
      "frame-ancestors 'self' [redacted]",
      ["'self'", '[redacted]'],
    ],
    [
      'frame-ancestors alice (dot) smith (at) mail.invalid',
      'frame-ancestors [redacted] [redacted] [redacted]',
      ['[redacted]', '[redacted]', '[redacted]'],
    ],
    ['frame-ancestors alice@intranet', 'frame-ancestors [redacted]', ['[redacted]']],
  ])('the stored fact and the stored value agree on %s', (value, stored, sources) => {
    const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(stored);
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources });
    for (const leak of LEAKS) expect(JSON.stringify(rec)).not.toContain(leak);
  });

  it.each([
    ['x-frame-options', 'SAMEORIGIN;'],
    ['x-frame-options', '"DENY"'],
    ['link', '<https://www.example.test/wp-json/>; rel="https://api.w.org/"'],
    [
      'link',
      '<https://www.example.test/a.css>; rel="preload stylesheet"; as=style; referrerpolicy=no-referrer; blocking=render',
    ],
    [
      'link',
      '<https://www.example.test/a.css>; rel=preload; media="(min-width: 600px) and (orientation: landscape)"',
    ],
    ['link', '<https://www.example.test/a.css>; rel=alternate; hreflang=de-CH; type=text/css'],
    [
      'link',
      '<https://www.example.test/a.js>; rel=preload; as=script; crossorigin=anonymous; fetchpriority=high',
    ],
    ['permissions-policy', 'camera=(self "https://a.example.test/");report-to=main-endpoint'],
    ['content-language', 'de-CH-1996'],
    [CSP, "webrtc 'block'"],
    [CSP, "script-src-elem 'self' 'report-sha256'"],
    [CSP, 'script-src https://cdn.example.test/npm/jquery@3.7.1/dist/jquery.min.js'],
    ['strict-transport-security', 'max-age=31536000'],
  ])('counterexample: %s %j is stored as sent', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(value);
  });

  it('counterexample: an integrity value keeps the algorithm and no hash', () => {
    expect(
      storedHeaderRecord('link', '</a.js>; rel=preload; integrity="sha384-Zm9vYmFy"', BASE, sanitizeUrl)
        .value,
    ).toBe('<https://www.example.test/a.js>; rel=preload; integrity="sha384-[redacted]"');
  });
});
