import { describe, expect, it } from 'vitest';
import { hstsOf } from '../../../../src/checks/http/shared.ts';
import { storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { headerCases } from './header-cases.ts';

const BASE = 'https://www.example.test/';
const NAME_REDACTED = '[redacted]';
const CSP = 'content-security-policy';

describe('stored by grammar: addresses hidden in a directive, opaque URLs, parameters and header names', () => {
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  it.each([
    ...headerCases(CSP, [
      // a directive that hides an address keeps nothing glued behind the domain of the mask
      [
        'a query behind the mask',
        "default-src 'self'; report-uri alice (at) example.test?token=visitorSecret#frag",
        "default-src 'self'; report-uri [redacted]@example.test",
      ],
      [
        'a quoted local part with a query behind the mask',
        'report-uri "alice smith"@example.test?u=visitorSecret',
        'report-uri [redacted]@example.test',
      ],
      [
        'a fragment behind the mask',
        'report-uri alice [at] example.test#visitorSecret',
        'report-uri [redacted]@example.test',
      ],
      [
        'a path with an ID behind the mask',
        `report-uri alice(at)example.test/${UUID}`,
        'report-uri [redacted]@example.test',
      ],
      // a host with a dot may be the local part
      [
        'a dotted local part before (at)',
        'script-src alice.smith (at) www.example.test',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'a dotted local part before (at) and a (dot) domain',
        'script-src alice.smith (at) example (dot) test',
        'script-src [redacted] [redacted] [redacted] [redacted] [redacted]',
      ],
      [
        'a dotted local part before a blank @',
        'script-src alice.smith @ mail.example.test',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'a dotted local part before a glued @',
        'script-src alice.smith @mail.example.test',
        'script-src [redacted] [redacted]',
      ],
      [
        'a dotted local part before a blank %40',
        'script-src alice.smith %40 mail.example.test',
        'script-src [redacted] [redacted] [redacted]',
      ],
      [
        'a dotted local part before a blank %2540',
        'script-src alice.smith %2540 mail.example.test',
        'script-src [redacted] [redacted] [redacted]',
      ],
      // an address whose local part is the host
      ['? inside an address', 'script-src alice.smith?@mail.example.test', 'script-src [redacted]'],
      ['# inside an address', 'script-src alice.smith#@mail.example.test', 'script-src [redacted]'],
      ['/ inside an address', 'script-src alice.smith/@mail.example.test', 'script-src [redacted]'],
      [
        'a scheme before an address with #',
        'script-src https://alice.smith#@mail.example.test',
        'script-src [redacted]',
      ],
      // an @ in a path is a version only when a number follows
      [
        'a host-like version in a path',
        'script-src https://cdn.example.test/u/alice.smith@1x.example.de/a.js',
        'script-src https://cdn.example.test/',
      ],
    ]),
    ...headerCases('content-type', [
      // a parameter name may be the local part of an address
      ['an address split at "="', 'text/html; alice=@example.test', 'text/html; [redacted]'],
      ['an address split at "=" with (at)', 'text/html; alice=(at) example.test', 'text/html; [redacted]'],
      ['an encoded address split at "="', 'text/html; alice_smith=%40example.test', 'text/html; [redacted]'],
      [
        'a quoted local part after a name',
        'text/html; charset=utf-8; alice="smith"@example.test',
        'text/html; charset=utf-8; [redacted]',
      ],
    ]),
    // the URL headers
    ['Location: tel:', 'location', 'tel:+4915112345678', 'tel:[redacted]'],
    ['Location: javascript:', 'location', 'javascript:visitorSecret', 'javascript:[redacted]'],
    ['Location: urn:', 'location', `urn:uuid:${UUID}`, 'urn:[redacted]'],
    ['Location: an app scheme', 'location', 'myapp://callback/visitorSecret', 'myapp:[redacted]'],
    ['Content-Location: about:', 'content-location', 'about:visitorSecret', 'about:[redacted]'],
    ['Location: @ in a path', 'location', '/u/alice@intranet', '[redacted]'],
    ['Content-Location: @ in a path', 'content-location', '/u/~alice@localhost/', '[redacted]'],
    [
      'Location: a visible [redacted] the server wrote',
      'location',
      'https://x.test/u/alice[redacted]@mail.invalid',
      '[redacted]',
    ],
    ['Link: @ in a path', 'link', '</u/alice@intranet>; rel=next', '<[redacted]>; rel=next'],
    ['Link: a bare @', 'link', '</u/~alice@>', '<[redacted]>'],
    ['Link: a host-like version', 'link', '</u/alice@2x.mail.test>', '<[redacted]>'],
    [
      'Refresh: javascript:',
      'refresh',
      "0; url=javascript:alert('visitorSecret')",
      '0; url=javascript:[redacted]',
    ],
    ['Refresh: tel:', 'refresh', '0; url=tel:+4915112345678', '0; url=tel:[redacted]'],
    // a URL starts after the controls and blanks the parser skips
    [
      'a control before a scheme in Link',
      'link',
      '<\u0001x:visitorSecret>; rel=next',
      '<x:[redacted]>; rel=next',
    ],
    ['a control before tel: in Link', 'link', '<\u0001tel:+4915112345678>', '<tel:[redacted]>'],
    [
      'a control before javascript: in report-uri',
      CSP,
      'report-uri \u0001javascript:alert(visitorSecret.x)',
      'report-uri javascript:[redacted]',
    ],
    [
      'a control before a scheme in anchor',
      'link',
      '</a>; anchor="\u0001javascript:visitorSecret.x"',
      '<https://www.example.test/a>; anchor="javascript:[redacted]"',
    ],
    [
      'a control before a scheme in report=',
      'x-xss-protection',
      '1; report=\u0001myapp:visitorSecret/x',
      '1; report=myapp:[redacted]',
    ],
    // a delay is a short number
    ['Refresh: a phone number as the delay', 'refresh', '4915112345678; url=/x', '[redacted]'],
    ['Refresh: a long fraction', 'refresh', '0.4915112345678', '[redacted]'],
    ['Refresh: counterexample, a fraction', 'refresh', '0.5; url=/x', '0.5; url=https://www.example.test/x'],
  ])('%s', (_label, name, value, expected) => {
    const out = storedHeaderRecord(name, value, BASE, sanitizeUrl).value;
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|visitorSecret|4915112|123e4567/);
  });

  it.each([
    'frame-ancestors alice.smith (at) www.example.test',
    'frame-ancestors alice.smith @ mail.example.test',
    'frame-ancestors alice.smith?@mail.example.test',
    'frame-ancestors alice.smith/@mail.example.test',
  ])('the sources of the frameAncestors fact hold no local part: %s', (value) => {
    const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
    expect(rec.frameAncestors?.present).toBe(true);
    expect(JSON.stringify(rec)).not.toContain('alice');
  });

  it.each([
    [
      'a package scope and a numeric version in a path',
      'script-src https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.8/dist/umd/popper.min.js',
      'script-src https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.8/dist/umd/popper.min.js',
    ],
    [
      'a numeric version with a pre-release',
      'script-src https://cdn.example.test/npm/pkg@1.2.3-beta.1/a.js',
      'script-src https://cdn.example.test/npm/pkg@1.2.3-beta.1/a.js',
    ],
    [
      'scheme sources of apps, a dotted host after a hidden marker kept with its scheme',
      "default-src 'self' android-webview-video-poster: gap: file: content: capacitor:; form-action 'self' mailto: tel:",
      "default-src 'self' android-webview-video-poster: gap: file: content: capacitor:; form-action 'self' mailto: tel:",
    ],
    [
      'trusted-types policy names with # and .',
      "trusted-types angular#unsafe-bypass goog#html default 'allow-duplicates'",
      "trusted-types angular#unsafe-bypass goog#html default 'allow-duplicates'",
    ],
  ])('counterexample: %s', (_label, value, expected) => {
    expect(storedHeaderRecord(CSP, value, 'https://www.example.test/', (u) => u).value).toBe(expected);
  });

  it.each([
    'ch-ua-wow64=*',
    'vibrate=(), push=(), notifications=(), speaker=()',
    'layout-animations=(self), legacy-image-formats=(self), oversized-images=(self), unoptimized-images=(self), unsized-media=(self)',
    'private-aggregation=(), shared-storage=(), shared-storage-select-url=(), deferred-fetch=(), deferred-fetch-minimal=()',
    'digital-credentials-get=(), captured-surface-control=(), all-screens-capture=(), autofill=()',
    'language-detector=(), summarizer=(), translator=(), writer=(), rewriter=(), language-model=()',
    'local-network-access=(), popins=(), web-printing=(), on-device-speech-recognition=()',
  ])('counterexample: Permissions-Policy features of current browsers are kept: %s', (value) => {
    expect(storedHeaderRecord('permissions-policy', value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    ['link', '</a>; rel=expect'],
    ['link', '</keys>; rel=ohttp-keys'],
  ])('counterexample: a link relation of the registry is kept: %s %s', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, (u) => u).value).toBe(
      value
        .replace('</a>', '<https://www.example.test/a>')
        .replace('</keys>', '<https://www.example.test/keys>'),
    );
  });

  it.each([
    'max-age=31536000; foo="x;max-age=0"',
    'max-age=31536000; a="; max-age=0',
    'max-age=31536000; a="; includeSubDomains; includeSubDomains',
    'max-age=0, "x; max-age=100',
    'max-age=0, x="a; max-age=5"',
    'max-age=1, x="a; max-age=2',
    'max-age="31536000"; includeSubDomains',
    'max-age=5", max-age=6',
    'max-age=1, max-age="2',
    'max-age=1; x="a,b"; max-age=2',
  ])('the HSTS verdict of the stored value follows the quotes like the value as sent: %s', (value) => {
    const stored = storedHeaderRecord('strict-transport-security', value, BASE, sanitizeUrl);
    expect(stored.value).not.toContain('"');
    expect(hstsOf([stored])).toEqual(hstsOf([{ name: 'strict-transport-security', value }]));
  });

  it.each([
    ['x-frame-options', '"x, DENY, y"', '[redacted], DENY, [redacted]'],
    ['referrer-policy', 'no-referrer, "a, unsafe-url, b"', 'no-referrer, [redacted], unsafe-url, [redacted]'],
  ])('a list without quoted strings splits at every comma: %s %s', (name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });
});

describe('stored by grammar: ids in allowed query values, address markers in names, closed feature lists', () => {
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  it.each([
    ['a UUID in an allowed query value', 'location', `/p?hl=${UUID}`, `${BASE}p?hl=[redacted]`],
    [
      'a token in an allowed query value',
      'content-location',
      '/p?hl=Xk2mQ9pLw8eR1tZ3aB4cD5',
      `${BASE}p?hl=[redacted]`,
    ],
    [
      'an address marker in an allowed query value',
      'location',
      '/p?hl=alice@intranet',
      `${BASE}p?hl=[redacted]`,
    ],
    [
      'an obfuscated marker in an allowed query value',
      'location',
      '/p?hl=alice(at)intranet',
      `${BASE}p?hl=[redacted]`,
    ],
    ['an address marker behind display=', 'location', '/p?display=alice@corp', `${BASE}p?display=[redacted]`],
    ['counterexample: a language in an allowed query value', 'location', '/p?hl=de-DE', `${BASE}p?hl=de-DE`],
    [
      'counterexample: versions in an allowed query value',
      'location',
      '/p?ver=6.4.2&v=2.1.0',
      `${BASE}p?ver=6.4.2&v=2.1.0`,
    ],
    [
      'counterexample: a tag id in an allowed query value',
      'location',
      '/gtag/js?id=G-ABCDEF1234',
      `${BASE}gtag/js?id=G-ABCDEF1234`,
    ],
  ])('%s', (_label, name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });

  it.each([
    ['an id behind a client hint', 'ch-ua-12345678901234567890=*'],
    ['a word behind a client hint', 'ch-ua-visitor=*'],
    ['a client hint that is not listed', 'ch-prefers-contrast=*'],
  ])('a Permissions-Policy feature that is %s is redacted', (_label, value) => {
    expect(storedHeaderRecord('permissions-policy', value, BASE, sanitizeUrl).value).toBe(NAME_REDACTED);
  });

  it.each([
    'ch-ua',
    'ch-ua-arch',
    'ch-ua-bitness',
    'ch-ua-form-factors',
    'ch-ua-full-version',
    'ch-ua-full-version-list',
    'ch-ua-mobile',
    'ch-ua-model',
    'ch-ua-platform',
    'ch-ua-platform-version',
    'ch-ua-wow64',
    'ch-device-memory',
    'ch-dpr',
    'ch-width',
    'ch-viewport-width',
    'ch-viewport-height',
    'ch-downlink',
    'ch-ect',
    'ch-rtt',
    'ch-save-data',
    'ch-prefers-color-scheme',
    'ch-prefers-reduced-motion',
    'ch-prefers-reduced-transparency',
  ])('counterexample: the client hint feature %s is kept', (feature) => {
    expect(storedHeaderRecord('permissions-policy', `${feature}=(self)`, BASE, sanitizeUrl).value).toBe(
      `${feature}=(self)`,
    );
  });

  it.each([
    ['a calendar extension', 'en-US-u-ca-gregory'],
    ['a private use extension', 'de-DE-x-private'],
    ['two extensions in a list', 'en-u-ca-gregory, de-x-private'],
  ])('Content-Language with %s is kept', (_label, value) => {
    expect(storedHeaderRecord('content-language', value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    ['an id in a private use extension', 'de-x-4f3a9c1d', NAME_REDACTED],
    ['a subtag beyond eight characters', 'en-u-ca-gregorian1', NAME_REDACTED],
    ['an extension without a subtag', 'en-US-u', NAME_REDACTED],
    ['a tag beyond the length cap', `en-u-${'ca-'.repeat(12)}gregory`, NAME_REDACTED],
  ])('Content-Language with %s is redacted', (_label, value, expected) => {
    expect(storedHeaderRecord('content-language', value, BASE, sanitizeUrl).value).toBe(expected);
  });
});
