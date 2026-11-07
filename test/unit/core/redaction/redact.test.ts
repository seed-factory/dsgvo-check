/**
 * `redactText` masks e-mail addresses, `mailto:` values and URL query/path values in free text a collector copies into
 * the snapshot; domains and service names stay (PRIV-01 matching), the function is idempotent. Addresses: address-redaction.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as api from '../../../../src/core/api.ts';
import { maskEmails, maskMailto, redactText } from '../../../../src/core/redaction/redact.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';
import { D, expectStableText, MARK } from '../url/redaction-helpers.ts';

describe('redactText: DNS TXT records', () => {
  it.each([
    // tags after an address survive, whether or not a space follows the semicolon
    [
      'v=DMARC1;p=none;rua=mailto:a@x.test;ruf=mailto:b@y.test;pct=100',
      `v=DMARC1;p=none;rua=mailto:${REDACTED}@x.test;ruf=mailto:${REDACTED}@y.test;pct=100`,
    ],
    [
      'v=DMARC1; p=reject; sp=quarantine; rua=mailto:a@x.test; pct=50',
      `v=DMARC1; p=reject; sp=quarantine; rua=mailto:${REDACTED}@x.test; pct=50`,
    ],
    [
      'v=DMARC1; p=none; rua=mailto:a@x.test,mailto:b@y.test; ruf=mailto:c@z.test; pct=100',
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@x.test,mailto:${REDACTED}@y.test; ruf=mailto:${REDACTED}@z.test; pct=100`,
    ],
    // one mailto: prefix per recipient in rua/ruf lists
    [
      'v=DMARC1; p=none; rua=mailto:dmarc@example.test,mailto:agg@other.test; fo=1',
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@example.test,mailto:${REDACTED}@other.test; fo=1`,
    ],
    // a space after "mailto:", a list with a bare second recipient, the size suffix is dropped with the address
    [
      'v=DMARC1; p=none; rua=mailto: a@x.test,b@y.test;',
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@x.test,${REDACTED}@y.test;`,
    ],
    ['rua=mailto:a@x.test,mailto:b@y.test!10m', `rua=mailto:${REDACTED}@x.test,mailto:${REDACTED}@y.test`],
    ['v=spf1 include:_spf.example.test ~all', 'v=spf1 include:_spf.example.test ~all'],
  ])('%j → %j', (input, expected) => {
    expect(expectStableText(input)).toBe(expected);
  });
});

describe('redactText: URLs inside text', () => {
  it('redacts query values that are not allowlisted and keeps allowlisted ones', () => {
    expect(expectStableText(`Siehe https://shop.example.test/p?token=${MARK}&id=G-ABC123 und weiter.`)).toBe(
      `Siehe https://shop.example.test/p?token=${REDACTED}&id=G-ABC123 und weiter.`,
    );
  });

  it('uses the allowlist it is given', () => {
    const url = `https://shop.example.test/p?stage=beta&sid=${MARK}`;
    expect(redactText(url)).toBe(`https://shop.example.test/p?stage=${REDACTED}&sid=${REDACTED}`);
    expect(redactText(url, new Set(['stage']))).toBe(
      `https://shop.example.test/p?stage=beta&sid=${REDACTED}`,
    );
  });

  it.each([
    [
      `https://ad.example.test/activity;src=1;dc_pre=${MARK};ord=${MARK}`,
      `https://ad.example.test/activity;src=${REDACTED};dc_pre=${REDACTED};ord=${REDACTED}`,
    ],
    [
      `https://u:${MARK}@sync.example.test/ibs:dpid=1&dpuuid=${MARK}#frag`,
      `https://sync.example.test/ibs:dpid=${REDACTED}&dpuuid=${REDACTED}`,
    ],
    [`'https://u:${MARK}@sync.example.test/a#frag' danach`, `'https://sync.example.test/a' danach`],
    ['https://www.example.test/a#abschnitt', 'https://www.example.test/a'],
    // an address nested in the path of an archive URL
    [
      'https://web.archive.example/web/20240329064148/mailto:info@example.test',
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    ],
  ])('redacts path parameters and drops credentials and the fragment: %s', (input, expected) => {
    expect(expectStableText(input)).toBe(expected);
  });

  // An apostrophe or a backtick inside a URL does not end the redaction.
  it.each([
    [`https://${D}/'alice@${D}?token=PRIVATE_ID`, `https://${D}/${REDACTED}@${D}?token=${REDACTED}`],
    [`https://${D}/p?token=alice's-private-id`, `https://${D}/p?token=${REDACTED}`],
    [`https://${D}/p?token=a'${MARK}`, `https://${D}/p?token=${REDACTED}`],
    [
      `https://${D}/p?a=1&token='${MARK}'&b=2`,
      `https://${D}/p?a=${REDACTED}&token=${REDACTED}&b=${REDACTED}`,
    ],
    [`https://${D}/it's/p?sid=${MARK}`, `https://${D}/it's/p?sid=${REDACTED}`],
    [`https://${D}/p?token=a\`${MARK}`, `https://${D}/p?token=${REDACTED}`],
    [`https://${D}/p;ord=a'${MARK}`, `https://${D}/p;ord=${REDACTED}`],
    [`Siehe https://${D}/p?token=alice's-id, danach.`, `Siehe https://${D}/p?token=${REDACTED}, danach.`],
  ])('an apostrophe inside the URL: %s', (input, expected) => {
    const out = expectStableText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    expect(out).not.toContain("alice's");
    expect(out).not.toContain('PRIVATE_ID');
  });

  it('agrees with sanitizeUrl on the value after an apostrophe: nothing of it survives the first pass', () => {
    const url = `https://${D}/p?token=alice's-private-id`;
    expect(redactText(url)).toBe(sanitizeUrl(url));
  });

  // Quotes and brackets around a URL are outer punctuation; a bracket with its opener inside the URL is part of it.
  // The "]" of a mask is no unbalanced bracket on the second pass (otherwise the value would read "[redacted").
  it.each([
    [`(https://shop.example.test/?sid=${MARK}).`, `(https://shop.example.test/?sid=${REDACTED}).`],
    [`„https://shop.example.test/?sid=${MARK}“`, `„https://shop.example.test/?sid=${REDACTED}“`],
    [
      `<https://shop.example.test/?sid=${MARK}>, danach`,
      `<https://shop.example.test/?sid=${REDACTED}>, danach`,
    ],
    [`'https://shop.example.test/p?sid=${MARK}'`, `'https://shop.example.test/p?sid=${REDACTED}'`],
    [`"https://shop.example.test/p?sid=${MARK}"`, `"https://shop.example.test/p?sid=${REDACTED}"`],
    [`‘https://shop.example.test/p?sid=${MARK}’`, `‘https://shop.example.test/p?sid=${REDACTED}’`],
    [`\`https://shop.example.test/p?sid=${MARK}\``, `\`https://shop.example.test/p?sid=${REDACTED}\``],
    [
      `'https://shop.example.test/p?sid=${MARK}', danach`,
      `'https://shop.example.test/p?sid=${REDACTED}', danach`,
    ],
    [`('https://shop.example.test/p?sid=${MARK}')`, `('https://shop.example.test/p?sid=${REDACTED}')`],
    [
      `window.open('https://shop.example.test/p?sid=${MARK}');`,
      `window.open('https://shop.example.test/p?sid=${REDACTED}');`,
    ],
    [
      `Link: 'https://shop.example.test/p?sid=${MARK}'.`,
      `Link: 'https://shop.example.test/p?sid=${REDACTED}'.`,
    ],
    ['[https://shop.example.test/p?sid=abc123]', `[https://shop.example.test/p?sid=${REDACTED}]`],
    [`[https://x.test/p?sid=${MARK}]`, `[https://x.test/p?sid=${REDACTED}]`],
    [`(siehe https://x.test/p?sid=${MARK})`, `(siehe https://x.test/p?sid=${REDACTED})`],
    [
      `https://x.test/p/]https://x.test/p?sid=${MARK}>`,
      `https://x.test/p/]https://x.test/p?sid=${REDACTED}>`,
    ],
    [`https://x.test/]token=${MARK}`, `https://x.test/]token=${REDACTED}`],
    [`https://x.test/a]b/p?hl=de,${MARK}@${D}\``, `https://x.test/a]b/p?hl=${REDACTED}\``],
    // only the surplus closing brackets are cut when the token has fewer openers than closers
    ['mailto:info@example.test)).', `mailto:${REDACTED}@example.test)).`],
  ])('punctuation around the URL stays outside: %s', (input, expected) => {
    expect(expectStableText(input)).toBe(expected);
  });

  it.each([
    'https://www.example.test',
    'https://www.example.test/impressum/',
    'https://www.example.test/a',
    'Mehr unter https://www.example.test/datenschutz.',
    'https://fonts.googleapis.example/css2?family=Roboto&display=swap',
    "Siehe 'https://www.example.test/impressum' und mehr.",
    "https://www.example.test/o'brien/kontakt",
    "Besuchen Sie https://www.example.test/impressum's Seite.",
    "Der Link 'https://www.example.test/a' endet hier.",
    'https://x.test/a[1]',
    'https://x.test/a[b]/c',
    'Siehe [https://x.test/a] und (https://x.test/b).',
    'https://de.wikipedia.example/wiki/Datenschutz_(Begriff)',
    '(siehe https://shop.example.test/p)',
    'https://shop.example.test/a_(b)).',
    'https://shop.example.test/a_(b)))))',
    // the brackets of the three kinds are balanced independently of each other
    'https://x.test/a_[b](c){d}]})',
    // no dot segment
    'Siehe https://x.test/.well-known/security.txt',
    'Siehe https://x.test/a/.hidden/b',
    'Siehe https://x.test/a/..b/c',
    'Siehe https://x.test/a/b.../c',
    'Siehe https://x.test/a/b/c.html',
    'Siehe https://x.test/',
  ])('a URL without anything sensitive stays as written (no normalisation of the visible text): %s', (s) => {
    expect(expectStableText(s)).toBe(s);
  });

  describe('a path segment in front of a dot segment is an address too', () => {
    it.each([
      [`https://x.test/alice%40${D}/../p`, 'https://x.test/p'],
      [`https://x.test/alice%2540${D}/../p`, 'https://x.test/p'],
      [`https://x.test/alice%252540${D}/%2e%2e/p`, 'https://x.test/p'],
      [`https://x.test/alice%40${D}/./p`, `https://x.test/${REDACTED}@${D}/p`],
      ['https://x.test/a;ord=1234567/../p', 'https://x.test/p'],
      [`https://x.test/x/alice%40${D}\\..\\p`, 'https://x.test/x/p'],
    ])('%s', (url, expected) => {
      expect(redactText(`Siehe ${url} Ende`)).toBe(`Siehe ${expected} Ende`);
      expect(redactText(expected)).toBe(expected);
    });

    it('with trailing punctuation and in brackets', () => {
      expect(redactText(`(https://x.test/alice%2540${D}/../p).`)).toBe('(https://x.test/p).');
    });
  });
});

// Legal-document text can contain long runs of closing brackets after a URL or mailto token. Recounting the whole
// prefix for every removed bracket would be quadratic, and synchronous work cannot be interrupted by the scan's
// timeout.
describe('redactText: long runs of closing brackets after a token', () => {
  it.each([
    [
      'HTTP URL with parentheses',
      (n: number) => `https://x.test/${')'.repeat(n)}`,
      (n: number) => `https://x.test/${')'.repeat(n)}`,
    ],
    [
      'HTTP URL with square brackets',
      (n: number) => `https://x.test/${']'.repeat(n)}`,
      (n: number) => `https://x.test/${']'.repeat(n)}`,
    ],
    [
      'mailto with parentheses',
      (n: number) => `mailto:info@example.test${')'.repeat(n)}`,
      (n: number) => `mailto:${REDACTED}@example.test${')'.repeat(n)}`,
    ],
    [
      'mailto with braces',
      (n: number) => `mailto:info@example.test${'}'.repeat(n)}`,
      (n: number) => `mailto:${REDACTED}@example.test${'}'.repeat(n)}`,
    ],
  ] as const)('redacts and scales with %s', (_name, input, expected) => {
    const small = input(20_000);
    const large = input(80_000);

    // 4x the input stays below the bound of linear growth (a quadratic scan would need ~16x the time)
    expectLinearGrowth(
      () => redactText(small),
      () => redactText(large),
    );
    expect(redactText(small)).toBe(expected(20_000));
  });
});

describe('redactText: general properties', () => {
  // Inputs that already run through expectStableText in this file or in address-redaction.test.ts are not
  // repeated here.
  const samples = [
    `https://ad.example.test/activity;src=1;dc_pre=${MARK}`,
    'https://web.archive.example/web/2024/mailto:info@example.test',
    'rua=mailto:dmarc@example.test,mailto:agg@other.test;',
    'Keine Besonderheiten in diesem Text.',
    '',
  ];

  it.each(samples)('is idempotent for %j', (s) => {
    expectStableText(s);
  });

  it('is linear on long inputs (document parts reach 400 000 characters)', () => {
    const started = Date.now();
    redactText('a'.repeat(400_000));
    redactText('wort '.repeat(80_000));
    redactText(`${'x@'.repeat(100_000)}`);
    redactText(`https://${'a.'.repeat(50_000)}test/`);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('maskEmails and maskMailto', () => {
  it('maskEmails masks bare addresses only', () => {
    expect(maskEmails('a.b@Example.test und mailto:c@x.test')).toBe(
      `${REDACTED}@example.test und mailto:${REDACTED}@x.test`,
    );
  });

  it('maskMailto masks recipients, drops headers and keeps one prefix per recipient', () => {
    expect(maskMailto('mailto:alice@example.test?subject=Hi&cc=bob@other.test')).toBe(
      `mailto:${REDACTED}@example.test`,
    );
    expect(maskMailto('mailto:a@x.test,mailto:b@y.test!10m')).toBe(
      `mailto:${REDACTED}@x.test,mailto:${REDACTED}@y.test`,
    );
    expect(maskMailto('mailto:?subject=x&body=alice@example.test')).toBe(`mailto:${REDACTED}`);
    expect(maskMailto('alice@example.test')).toBe(`mailto:${REDACTED}@example.test`);
  });
});

describe('api.ts exports the masks for checks and collectors (import boundary)', () => {
  it('exports redactText and maskMailto', () => {
    expect(api.redactText('info@example.test')).toBe(`${REDACTED}@example.test`);
    expect(api.maskMailto('mailto:info@example.test')).toBe(`mailto:${REDACTED}@example.test`);
  });
});
