/** Address redaction removes the complete local part across quoting, Unicode and malformed percent escapes.
 * URL queries, mailto values, path structure and repeated application preserve the privacy invariant. */
import { describe, expect, it } from 'vitest';
import { maskEmails, maskMailto, redactText } from '../../../src/core/redact.ts';
import { REDACTED, sanitizeUrl } from '../../../src/core/url.ts';

const MARK = 'zq7marker';
const D = 'example.invalid';

/** mulberry32: the same sequence on every run, no extra dependency. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Both functions are idempotent: the output of the first pass is a fixed point. */
function expectStable(input: string): string {
  const once = redactText(input);
  expect(redactText(once), `redactText(redactText(${JSON.stringify(input)}))`).toBe(once);
  return once;
}

function expectStableUrl(input: string): string {
  const once = sanitizeUrl(input);
  expect(sanitizeUrl(once), `sanitizeUrl(sanitizeUrl(${JSON.stringify(input)}))`).toBe(once);
  return once;
}

describe('the whole local part goes, whatever characters it has', () => {
  const specials = [
    '!',
    '#',
    '$',
    '&',
    "'",
    '*',
    '+',
    '-',
    '/',
    '=',
    '?',
    '^',
    '_',
    '`',
    '{',
    '|',
    '}',
    '~',
    '%',
  ];

  it.each(specials)('masks %j inside the local part (free text, bare address, sentence)', (ch) => {
    const address = `${MARK}a${ch}${MARK}b@${D}`;
    expect(redactText(address)).toBe(`${REDACTED}@${D}`);
    expect(maskEmails(address)).toBe(`${REDACTED}@${D}`);
    expect(redactText(`Kontakt: ${address}.`)).toBe(`Kontakt: ${REDACTED}@${D}.`);
    expect(redactText(`Kontakt (${address}), Tel. 030`)).toBe(`Kontakt (${REDACTED}@${D}), Tel. 030`);
    expectStable(address);
  });

  it('masks representative inputs: first!last@…', () => {
    expect(redactText(`first!last@${D}`)).toBe(`${REDACTED}@${D}`);
    expect(maskEmails(`first!last@${D}`)).toBe(`${REDACTED}@${D}`);
  });

  it.each([
    [`"alice.smith"@${D}`, `${REDACTED}@${D}`],
    [`"john smith"@${D}`, `${REDACTED}@${D}`],
    [`"a\\"b"@${D}`, `${REDACTED}@${D}`],
    [`"a@b"@${D}`, `${REDACTED}@${D}`],
    [`"a,b;c"@${D}`, `${REDACTED}@${D}`],
    [`Schreiben Sie an "alice.smith"@${D}, danke.`, `Schreiben Sie an ${REDACTED}@${D}, danke.`],
    [`mailto:"alice.smith"@${D}`, `mailto:${REDACTED}@${D}`],
  ])('masks the quoted local part: %j', (input, expected) => {
    const out = redactText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('john');
    expect(maskEmails(input)).toBe(expected);
    expectStable(input);
  });

  it('keeps no fragment of the local part in a serialized snapshot', () => {
    const snapshot = {
      dom: {
        links: [
          { text: `${MARK}first!${MARK}last@${D}`, accessibleName: `"${MARK}.alice"@${D}` },
          { text: `R&D ${MARK}r&d@${D}`, href: `https://${D}/${MARK}one!${MARK}two@${D}` },
        ],
      },
    };
    const redacted = {
      dom: {
        links: snapshot.dom.links.map((l) => ({
          text: redactText(l.text),
          accessibleName: redactText(l.accessibleName ?? ''),
          href: sanitizeUrl(l.href ?? `https://${D}/`),
        })),
      },
    };
    expect(JSON.stringify(redacted)).not.toContain(MARK);
  });

  it.each([
    [`https://${D}/first!last@${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/first%21last%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/r&d@${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%22alice.smith%22%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%22alice.smith%22@${D}`, `https://${D}/${REDACTED}@${D}`],
  ])('masks the same addresses in the path of a URL: %s', (input, expected) => {
    const out = expectStableUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/first|alice|r&d/);
    // the same URL inside text
    expect(expectStable(`Siehe ${input}.`)).toBe(`Siehe ${expected}.`);
  });

  it('keeps the structure of a URL path: a "/" is a border of the segment, also next to an address', () => {
    expect(sanitizeUrl(`https://${D}/kontakt/first!last@${D}/mehr`)).toBe(
      `https://${D}/kontakt/${REDACTED}@${D}/mehr`,
    );
    const out = sanitizeUrl(`https://${D}/a%2Fb%40${D}/c`);
    expect(out.split('/').length).toBe(`https://${D}/a%2Fb%40${D}/c`.split('/').length);
    expect(out).not.toMatch(/b@/);
  });

  describe('counterexamples: what is not an address stays as written', () => {
    it.each([
      '@media screen',
      'Folgen Sie @beispiel auf Social Media',
      `${REDACTED}@${D}`,
      `mailto:${REDACTED}@${D}`,
      'Version 2@2x und logo@2x.png',
      'react@18.3.1 und lodash@4.17.21',
      'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
      'Er sagte "Hallo" und ging, "Tschüss" folgte.',
      '"Hallo" @example.test',
      'Preis: 5 $ & 6 # 7 = 8 ? 9 / 10',
      'a ! b @ c',
      'Frage: wer@ ist da?',
    ])('%j', (s) => {
      expect(redactText(s)).toBe(s);
      expect(maskEmails(s)).toBe(s);
    });

    it('does not take the text in front of a separator for a part of the address', () => {
      expect(redactText(`Mail: a@x.test, b!c@y.test; "d"@z.test (e*f@w.test)`)).toBe(
        `Mail: ${REDACTED}@x.test, ${REDACTED}@y.test; ${REDACTED}@z.test (${REDACTED}@w.test)`,
      );
      expect(redactText(`<${MARK}!x@${D}>`)).toBe(`<${REDACTED}@${D}>`);
    });

    it('does not turn a query or a path border of a URL into a part of an address', () => {
      // a URL with allowlisted parameters and an "@" that is no address (font axes) is not cut by the mask
      const url = 'https://fonts.googleapis.example/css2?family=Roboto&display=swap';
      expect(redactText(url)).toBe(url);
      expect(redactText(`${url} und Version 3@2x`)).toBe(`${url} und Version 3@2x`);
      expect(redactText(`https://www.example.test/impressum/ und Kontakt@${D}`)).toBe(
        `https://www.example.test/impressum/ und ${REDACTED}@${D}`,
      );
    });
  });

  it('masks an address that is glued to a URL, and still redacts the URL (text nodes joined without a blank)', () => {
    // The tokens are taken first: the domain of the address must not swallow the start of the URL after it.
    expect(expectStable(`kontakt@x.test${'https://shop.example.test/p?sid='}${MARK}`)).toBe(
      `${REDACTED}@x.testhttps://shop.example.test/p?sid=${REDACTED}`,
    );
    expect(expectStable(`${MARK}!a@x.testmailto:b@y.test`)).toBe(
      `${REDACTED}@x.testmailto:${REDACTED}@y.test`,
    );
  });

  it('takes a chain "a@b.test@c.test" for one address (the second pass must not find a new one)', () => {
    expect(expectStable(`a@b.test@c.test`)).toBe(`${REDACTED}@c.test`);
    expect(expectStable(`${MARK}@x.test@y.test@z.test.`)).toBe(`${REDACTED}@z.test.`);
    expect(expectStableUrl(`https://${D}/a@b.test@c.test`)).toBe(`https://${D}/${REDACTED}@c.test`);
    // an "@" that does not continue into a domain is not part of the chain
    expect(expectStable('a@b.test @c.test und x@y')).toBe(`${REDACTED}@b.test @c.test und x@y`);
  });

  it('mailto: gives one prefix to the first recipient also when it carries its own', () => {
    expect(expectStable('mailto:mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStable('mailto:,mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStable('mailto: %40-')).toBe(`mailto:${REDACTED}`);
  });

  it('randomized: no fragment of a generated local part survives and the result is stable', () => {
    const rnd = random(20261031);
    const alphabet = "abcXYZ019!#$%&'*+-/=?^_`{|}~.".split('');
    const pick = () => alphabet[Math.floor(rnd() * alphabet.length)];
    for (let i = 0; i < 3000; i++) {
      const local = `${MARK}${Array.from({ length: 1 + Math.floor(rnd() * 24) }, pick).join('')}`;
      const out = expectStable(`Kontakt: ${local}@${D}.`);
      expect(out, local).toBe(`Kontakt: ${REDACTED}@${D}.`);
    }
    // in a path segment: the characters that are the structure of a URL are left out
    const pathAlphabet = "abcXYZ019!$&'*+-^_`{|}~.".split('');
    const pickPath = () => pathAlphabet[Math.floor(rnd() * pathAlphabet.length)];
    for (let i = 0; i < 3000; i++) {
      const local = `${MARK}${Array.from({ length: 1 + Math.floor(rnd() * 24) }, pickPath).join('')}`;
      const out = expectStableUrl(`https://${D}/kontakt/${local}@${D}`);
      expect(out, local).toBe(`https://${D}/kontakt/${REDACTED}@${D}`);
    }
  });
});

describe('an apostrophe inside a URL does not end the redaction', () => {
  it('redacts the query after an apostrophe in the path (representative inputs)', () => {
    const input = `https://${D}/'alice@${D}?token=PRIVATE_ID`;
    const once = redactText(input);
    expect(once).toBe(`https://${D}/${REDACTED}@${D}?token=${REDACTED}`);
    expect(once).not.toContain('PRIVATE_ID');
    expect(redactText(once)).toBe(once);
  });

  it.each([
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
  ])('%s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    expect(out).not.toContain("alice's");
  });

  it('agrees with sanitizeUrl on the value: nothing of it survives the first pass', () => {
    const url = `https://${D}/p?token=alice's-private-id`;
    expect(redactText(url)).toBe(sanitizeUrl(url));
  });

  describe('counterexamples: the quotes around a URL are still the outer quotes', () => {
    it.each([
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
    ])('%s', (input, expected) => {
      expect(expectStable(input)).toBe(expected);
    });

    it.each([
      "Siehe 'https://www.example.test/impressum' und mehr.",
      "https://www.example.test/o'brien/kontakt",
      "Besuchen Sie https://www.example.test/impressum's Seite.",
      "Der Link 'https://www.example.test/a' endet hier.",
      'https://www.example.test/a#abschnitt'.replace('#abschnitt', ''),
    ])('leaves a URL without anything sensitive as written: %s', (s) => {
      expect(redactText(s)).toBe(s);
    });

    it('still drops the fragment and the credentials', () => {
      expect(redactText(`'https://u:${MARK}@sync.example.test/a#frag' danach`)).toBe(
        `'https://sync.example.test/a' danach`,
      );
    });

    it('keeps the mailto: recipient with an apostrophe in one piece', () => {
      expect(redactText("mailto:o'brien@example.test")).toBe(`mailto:${REDACTED}@example.test`);
      expect(expectStable("Mail an mailto:o'brien@example.test.")).toBe(
        `Mail an mailto:${REDACTED}@example.test.`,
      );
      expect(redactText("'mailto:info@example.test'")).toContain(`${REDACTED}@example.test`);
      expect(redactText("'mailto:info@example.test'")).not.toContain('info@');
    });
  });
});

describe('"mailto: " followed by a percent-encoded address', () => {
  it.each([
    ['mailto: %61lice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    ['mailto:   %61lice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    ['mailto:\t%61lice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    ['mailto:\n%61lice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    ['MAILTO: alice%40Example.INVALID', `mailto:${REDACTED}@example.invalid`],
    [
      'mailto: alice%40example.invalid,bob%40other.invalid',
      `mailto:${REDACTED}@example.invalid,${REDACTED}@other.invalid`,
    ],
    // an invalid escape somewhere in the body does not switch the detection off
    ['mailto: %ZZ%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    ['mailto: al%E9ice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
    // an address encoded twice
    ['mailto: alice%2540example.invalid', `mailto:${REDACTED}`],
    ['See mailto: %61lice%40example.invalid.', `See mailto:${REDACTED}@example.invalid.`],
    [
      'v=DMARC1; p=none; rua=mailto: %61lice%40example.invalid; pct=100',
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@example.invalid; pct=100`,
    ],
  ])('%j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|bob|%40|%61/i);
  });

  it('is the composition of the two cases that were covered one by one', () => {
    // a space only, an encoded "@" only
    expect(redactText('mailto: alice@example.invalid')).toBe(`mailto:${REDACTED}@example.invalid`);
    expect(redactText('mailto:%61lice%40example.invalid')).toBe(`mailto:${REDACTED}@example.invalid`);
    // and together
    expect(redactText('mailto: %61lice%40example.invalid')).toBe(
      maskMailto('mailto: %61lice%40example.invalid'),
    );
  });

  describe('counterexamples: prose after "mailto:" stays', () => {
    it.each([
      'mailto: Kontakt aufnehmen',
      'mailto: Kontakt%20aufnehmen',
      'Hinweis (mailto: siehe unten) bitte lesen',
      'mailto: 100% Datenschutz',
      'mailto: %C3%9Cber uns',
      'mailto: %ZZ nicht erreichbar',
      'mailto: ',
    ])('%j', (s) => {
      expect(redactText(s)).toBe(s);
    });
  });
});

describe('an invalid escape does not cancel the mask of an encoded address in the path', () => {
  it.each([
    [`https://${D}/alice%40${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/alice%40${D}%E9`, `https://${D}/${REDACTED}@${D}%25E9`],
    [`https://${D}/alice%40${D}%`, `https://${D}/${REDACTED}@${D}%25`],
    [`https://${D}/alice%40${D}%4`, `https://${D}/${REDACTED}@${D}%254`],
    [`https://${D}/%ZZalice%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%E9alice%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/m%C3%BCller%ZZ%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/kontakt/alice%40${D}%ZZ/mehr`, `https://${D}/kontakt/${REDACTED}@${D}%25ZZ/mehr`],
    [`https://${D}/alice%40${D}%ZZ%E9%C3`, `https://${D}/${REDACTED}@${D}%25ZZ%25E9%25C3`],
  ])('%s', (input, expected) => {
    const out = expectStableUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|%40|[^\]]@/i);
    // the same URL inside text, and as part of a longer sentence
    expect(expectStable(`Siehe ${input}.`)).toBe(`Siehe ${expected}.`);
  });

  it('keeps the structural escapes of the segment next to an invalid one', () => {
    const input = `https://${D}/a%2Fb%40${D}%ZZ/c`;
    const out = expectStableUrl(input);
    expect(out.split('/').length).toBe(input.split('/').length);
    expect(out).not.toMatch(/b@/);
    expect(out).toContain('%2F');
  });

  describe('counterexamples: no address, no change', () => {
    it.each([
      `https://${D}/100%ZZ`,
      `https://${D}/kontakt%E9/info`,
      `https://${D}/a%2Fb/info%40`,
      `https://${D}/%C3%BCber/uns`,
      `https://${D}/prozent%25ZZ`,
    ])('%s', (url) => {
      expect(sanitizeUrl(url)).toBe(url);
    });

    // : this used to expect the URL back unchanged ("%2540 is the text %40, not an address"). A query value
    // (`containsAddress`) and a `mailto:` body (`hasAddress`) look three rounds deep, and "better hidden" decided:
    // the path does the same now. A text that shows no address in three rounds stays (url-opaque-and-encoded-privacy).
    it('decodes up to three rounds like the query and mailto: %2540 is %40 is "@"', () => {
      expect(sanitizeUrl(`https://${D}/alice%2540${D}`)).toBe(`https://${D}/${REDACTED}@${D}`);
      expect(sanitizeUrl(`https://${D}/alice%252540${D}`)).toBe(`https://${D}/${REDACTED}@${D}`);
      const url = `https://${D}/alice%25252540${D}`;
      expect(sanitizeUrl(url)).toBe(url);
    });

    it('valid escapes are decoded as before', () => {
      expect(sanitizeUrl(`https://${D}/%C3%BCber/m%C3%BCller%40${D}/100%25`)).toBe(
        `https://${D}/%C3%BCber/${REDACTED}@${D}/100%25`,
      );
    });
  });

  it('randomized: any mix of valid and invalid escapes around %40 is masked and stable', () => {
    const rnd = random(20261032);
    const pieces = ['a', 'b', '%ZZ', '%E9', '%C3', '%C3%BC', '%', '%4', '%25', '%2D', '%7E', '.', '_', '%21'];
    const pick = () => pieces[Math.floor(rnd() * pieces.length)];
    for (let i = 0; i < 4000; i++) {
      const before = Array.from({ length: Math.floor(rnd() * 4) }, pick).join('');
      const after = Array.from({ length: Math.floor(rnd() * 4) }, pick).join('');
      const url = `https://${D}/${MARK}${before}%40${D}${after}`;
      const out = expectStableUrl(url);
      expect(out, url).not.toContain(MARK);
      expect(out, url).toContain(`${REDACTED}@${D}`);
    }
  });
});

describe('an address glued to a URL does not survive in a kept query value or key', () => {
  const FONTS = 'https://fonts.googleapis.example/css';

  it.each([
    // the apostrophe and the backtick no longer end the token: the address lands inside the allowlisted value
    [`['${FONTS}?family=Roboto','${MARK}@${D}']`, `['${FONTS}?family=${REDACTED}']`],
    [`https://x.test/p?hl=de\`${MARK}@${D}\``, `https://x.test/p?hl=${REDACTED}\``],
    [`'https://x.test/p?hl=de','mailto:${MARK}@${D}'`, `'https://x.test/p?hl=${REDACTED}'`],
    // the same without a quote: it was never masked
    [`https://x.test/p?hl=de,${MARK}@${D}`, `https://x.test/p?hl=${REDACTED}`],
    [`https://x.test/p?hl=de.${MARK}@${D}`, `https://x.test/p?hl=${REDACTED}`],
    [`https://x.test/p?display=swap&hl=de'${MARK}@${D}`, `https://x.test/p?display=swap&hl=${REDACTED}`],
    // percent-encoded, also twice
    [`https://x.test/p?family=Roboto%2C${MARK}%40${D}`, `https://x.test/p?family=${REDACTED}`],
    [`https://x.test/p?hl=de%2C${MARK}%2540${D}`, `https://x.test/p?hl=${REDACTED}`],
  ])('the value goes: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  it.each([
    [`https://${D}/unsubscribe?${MARK}@${D}`, `https://${D}/unsubscribe?${REDACTED}=${REDACTED}`],
    [`https://x.test/p?${MARK}%40${D}=1`, `https://x.test/p?${REDACTED}=${REDACTED}`],
    [`https://x.test/p?${MARK}%2540${D}=1`, `https://x.test/p?${REDACTED}=${REDACTED}`],
    [
      `https://x.test/p?a=1&${MARK}@${D}&b=2`,
      `https://x.test/p?a=${REDACTED}&${REDACTED}=${REDACTED}&b=${REDACTED}`,
    ],
  ])('the key goes: %s', (input, expected) => {
    const out = expectStableUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    // redactText agrees with sanitizeUrl on a bare URL
    expect(expectStable(input)).toBe(expected);
  });

  describe('counterexamples: a kept value without an address stays as it was', () => {
    it.each([
      [`${FONTS}?family=Roboto','Open+Sans`, `${FONTS}?family=Roboto%27%2C%27Open+Sans`],
      [`['${FONTS}?family=Roboto','Open+Sans']`, `['${FONTS}?family=Roboto%27%2C%27Open+Sans']`],
      [
        'https://fonts.googleapis.example/css2?family=Open+Sans:wght@400;700&display=swap',
        'https://fonts.googleapis.example/css2?family=Open+Sans%3Awght%40400%3B700&display=swap',
      ],
      [
        'https://fonts.googleapis.example/css2?family=Roboto:ital,wght@0,400;1,700&display=swap',
        'https://fonts.googleapis.example/css2?family=Roboto%3Aital%2Cwght%400%2C400%3B1%2C700&display=swap',
      ],
      ['https://x.test/p?family=Roboto@2x.png&hl=de', 'https://x.test/p?family=Roboto%402x.png&hl=de'],
      [
        'https://x.test/p?hl=de&display=swap&v=2.1.0&id=G-ABC123',
        'https://x.test/p?hl=de&display=swap&v=2.1.0&id=G-ABC123',
      ],
    ])('%s', (input, expected) => {
      expect(expectStable(input)).toBe(expected);
    });

    it('a masked address stays a fixed point inside a value', () => {
      const url = `https://x.test/p?hl=${REDACTED}&${REDACTED}=${REDACTED}`;
      expect(expectStableUrl(url)).toBe(url);
    });
  });

  it('randomized: the marker of an address next to an allowlisted parameter never survives', () => {
    const rnd = random(20261034);
    const glue = ["'", '`', ',', '.', ';', ')', '%2C', '%27', '+', '-', '_', '|', '~', '!'];
    const names = ['family', 'hl', 'display', 'subset', 'render', 'output', 'libraries', 'en', 'ver', 'tok'];
    const forms = (m: string) => [`${m}@${D}`, `mailto:${m}@${D}`, `${m}%40${D}`, `"${m}"@${D}`];
    for (let i = 0; i < 4000; i++) {
      const g = glue[Math.floor(rnd() * glue.length)] as string;
      const name = names[Math.floor(rnd() * names.length)] as string;
      const form = forms(MARK)[Math.floor(rnd() * 4)] as string;
      const url = `https://x.test/p?${name}=de${g}${form}`;
      const out = expectStable(`'${url}'`);
      expect(out, url).not.toContain(MARK);
      expectStableUrl(url);
    }
  });
});

describe('a quoted address after "mailto:" or glued to a token is stable', () => {
  it.each([
    [`mailto: "${MARK}"@${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:\t"${MARK}"@${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:\n"${MARK}"@${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:   "${MARK} smith"@${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:"${MARK}"@${D}`, `mailto:${REDACTED}@${D}`],
    [`MAILTO: "${MARK}"@${D}`, `mailto:${REDACTED}@${D}`],
    ['mailto:"x"@mail.example%2Etest', `mailto:${REDACTED}@mail.example.test`],
    [`mailto: "${MARK}"@${D}.`, `mailto:${REDACTED}@${D}.`],
    [`Mail an mailto: "${MARK}"@${D}, danke`, `Mail an mailto:${REDACTED}@${D}, danke`],
  ])('mailto: %j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  it.each([
    [`https://x.test/p?id="${MARK}"@${D}`, `https://x.test/p?id=${REDACTED}`],
    [`https://x.test/p/"${MARK}"@${D}`, `https://x.test/p/${REDACTED}@${D}`],
    [`https://x.test/p?id="${MARK}"@${D}"b"@e.test`, `https://x.test/p?id=${REDACTED}`],
    [`mailto:a@d.test"${MARK}"@d.test`, `mailto:${REDACTED}@d.test`],
    [`mailto:a@d.test"${MARK}"@d.test"b"@e.test`, `mailto:${REDACTED}@e.test`],
  ])('a quoted address that follows a token without a blank: %j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  describe('counterexamples: a quote that is not a local part stays', () => {
    it.each([
      'mailto: "Kontakt" aufnehmen',
      'mailto: "Kontakt aufnehmen"',
      'mailto: "Kontakt"',
      '<a href="https://shop.example.test/p">"Kontakt"</a>',
      'Er sagte "Kontakt"@ und ging.',
    ])('%j', (s) => {
      expect(expectStable(s)).toBe(s);
    });

    it('a quote after a URL is still its closing quote', () => {
      expect(expectStable(`<a href="https://shop.example.test/p?sid=${MARK}">"Kontakt"</a>`)).toBe(
        `<a href="https://shop.example.test/p?sid=${REDACTED}">"Kontakt"</a>`,
      );
      expect(expectStable(`"https://shop.example.test/p?sid=${MARK}" "${MARK}"@${D}`)).toBe(
        `"https://shop.example.test/p?sid=${REDACTED}" ${REDACTED}@${D}`,
      );
    });
  });
});

describe('"mailto: " followed by a URL', () => {
  it.each([
    [
      `mailto: https://shop.example.test/p?sid=${MARK}`,
      `mailto: https://shop.example.test/p?sid=${REDACTED}`,
    ],
    [
      `mailto:\nhttps://shop.example.test/p;ord=${MARK}`,
      `mailto:\nhttps://shop.example.test/p;ord=${REDACTED}`,
    ],
    [
      `mailto:   https://shop.example.test/p?sid=${MARK}.`,
      `mailto:   https://shop.example.test/p?sid=${REDACTED}.`,
    ],
    [
      `Fragen? mailto: https://shop.example.test/p?sid=${MARK}, dann weiter`,
      `Fragen? mailto: https://shop.example.test/p?sid=${REDACTED}, dann weiter`,
    ],
  ])('%j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  it.each([
    // a URL glued to a recipient is a URL of its own: the `;` of a matrix parameter is not the end of a DMARC tag (what
    // follows the domain of a recipient is dropped, as always)
    [
      `mailto:a@x.test#https://x.test/p;ord=${MARK}`,
      `mailto:${REDACTED}@x.testhttps://x.test/p;ord=${REDACTED}`,
    ],
    [
      `mailto:a@x.test,https://x.test/p?sid=${MARK}`,
      `mailto:${REDACTED}@x.test,https://x.test/p?sid=${REDACTED}`,
    ],
    [
      `mailto:"a b"@x.test|https://x.test/p;ord=${MARK}`,
      `mailto:${REDACTED}@x.testhttps://x.test/p;ord=${REDACTED}`,
    ],
    // without a blank the URL is no recipient either
    [`mailto:https://shop.example.test/p?sid=${MARK}`, `mailto:https://shop.example.test/p?sid=${REDACTED}`],
    // a token inside prose
    ['mailto: Kontakt,mailto:info', `mailto: Kontakt,mailto:${REDACTED}`],
  ])('a URL next to a recipient, or a token inside prose: %j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  it('a DMARC record keeps its tags (the `;` still ends a recipient)', () => {
    const record = `v=DMARC1; p=none; rua=mailto:a@x.test,mailto:b@y.test; ruf=mailto:c@z.test; pct=100`;
    expect(expectStable(record)).toBe(
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@x.test,mailto:${REDACTED}@y.test; ruf=mailto:${REDACTED}@z.test; pct=100`,
    );
  });

  describe('counterexamples: prose after "mailto:" stays', () => {
    it.each([
      'mailto: Kontakt aufnehmen',
      'mailto: https://shop.example.test/impressum',
      'mailto: siehe https://shop.example.test/p',
      '(mailto: siehe unten)',
    ])('%j', (s) => {
      expect(expectStable(s)).toBe(s);
    });
  });
});

describe('non-ASCII characters in the local part', () => {
  const odd = ['😀', '™', '·', '–', '€', '©', '½', '♥', '‍', '👨‍👩‍👧', 'é', 'ß', 'ø', '中', 'ж'];

  it.each(odd)('masks the whole local part with %j at the end, in the middle and at the start', (ch) => {
    expect(expectStable(`${MARK}${ch}@${D}`)).toBe(`${REDACTED}@${D}`);
    expect(expectStable(`${MARK}${ch}x@${D}`)).toBe(`${REDACTED}@${D}`);
    expect(expectStable(`${ch}${MARK}@${D}`)).toBe(`${REDACTED}@${D}`);
    expect(expectStable(`Kontakt: ${MARK}${ch}${MARK}@${D}.`)).toBe(`Kontakt: ${REDACTED}@${D}.`);
    expect(maskEmails(`${MARK}${ch}@${D}`)).toBe(`${REDACTED}@${D}`);
  });

  it('masks representative inputs', () => {
    for (const s of [`${MARK}😀@${D}`, `${MARK}™@${D}`, `${MARK}·x@${D}`]) {
      expect(redactText(s), s).toBe(`${REDACTED}@${D}`);
    }
  });

  it('masks it in a path segment, but a "/" is still the border', () => {
    expect(expectStableUrl(`https://${D}/kontakt/${MARK}😀@${D}`)).toBe(
      `https://${D}/kontakt/${REDACTED}@${D}`,
    );
    expect(expectStableUrl(`https://${D}/kontakt/${MARK}%E2%84%A2@${D}`)).toBe(
      `https://${D}/kontakt/${REDACTED}@${D}`,
    );
  });

  describe('counterexamples: what is not part of an address stays', () => {
    it.each([
      ['no-break space', ' '],
      ['narrow no-break space', ' '],
      ['thin space', ' '],
      ['ideographic space', '　'],
      ['line separator', ' '],
    ])('a %s in front of the address is a border', (_name, space) => {
      expect(expectStable(`Kontakt:${space}${MARK}@${D}`)).toBe(`Kontakt:${space}${REDACTED}@${D}`);
      expect(expectStable(`${MARK}${space}${MARK}@${D}`)).toBe(`${MARK}${space}${REDACTED}@${D}`);
    });

    it.each([
      ['„', '“'],
      ['»', '«'],
      ['‹', '›'],
      ['‘', '’'],
      ['“', '”'],
      ['（', '）'],
      ['「', '」'],
    ])('quotes and brackets %s…%s around the address are kept', (open, close) => {
      expect(expectStable(`${open}${MARK}@${D}${close}`)).toBe(`${open}${REDACTED}@${D}${close}`);
    });

    it('text without an address is not touched', () => {
      for (const s of [
        'Preis: 5 € inkl. MwSt. ™ © 2026 😀',
        'Straße – Köln · Berlin',
        'a@2x.png',
        'logo™@2x.png',
      ]) {
        expect(redactText(s), s).toBe(s);
      }
    });
  });
});

describe('the closing bracket of the mask is not sentence punctuation', () => {
  // A stray "]" earlier in the token made the "]" of "[redacted]" look like an unbalanced closing bracket on the second
  // pass: it was cut off, the value was read as "[redacted", and the result changed. No leak, but not idempotent.
  it.each([
    [
      `https://x.test/p/]https://x.test/p?sid=${MARK}>`,
      `https://x.test/p/]https://x.test/p?sid=${REDACTED}>`,
    ],
    [`https://x.test/]token=${MARK}`, `https://x.test/]token=${REDACTED}`],
    [`[https://x.test/p?sid=${MARK}]`, `[https://x.test/p?sid=${REDACTED}]`],
    [`(siehe https://x.test/p?sid=${MARK})`, `(siehe https://x.test/p?sid=${REDACTED})`],
    [`https://x.test/a]b/p?hl=de,${MARK}@${D}\``, `https://x.test/a]b/p?hl=${REDACTED}\``],
  ])('%j', (input, expected) => {
    expect(expectStable(input)).toBe(expected);
  });

  it('brackets that belong to the URL stay', () => {
    for (const s of [
      'https://x.test/a[1]',
      'https://x.test/a[b]/c',
      'Siehe [https://x.test/a] und (https://x.test/b).',
    ]) {
      expect(expectStable(s)).toBe(s);
    }
  });
});

describe('long inputs: the scan stays linear (about 100 000 to 400 000 characters)', () => {
  // The code is synchronous: a quadratic tail cannot be interrupted by the timeout of the scan .
  const budgetMs = 2_000;
  const n = 100_000;

  const inputs: Array<[string, string]> = [
    ['special characters of a local part without "@"', '!#$&*+/=?^_`{|}~'.repeat(n / 16)],
    ['special characters and one "@" at the end', `${'a!'.repeat(n)}@${D}`],
    ['a run of local-part characters before "@"', `${'a'.repeat(4 * n)}@x.test`],
    ['many "@" with special characters', '!x@'.repeat(n)],
    ['a chain of addresses', 'a@b.test'.repeat(n / 8)],
    ['a chain of "@" with short domains', 'a@b.'.repeat(n / 4)],
    ['a long domain label after "@"', `a@${'b'.repeat(n)}`],
    ['a long quoted local part', `"${'a'.repeat(n)}"@${D}`],
    ['opening quotes of a quoted local part', '"a'.repeat(n / 2)],
    ['opening quotes and a late "@"', `${'"a'.repeat(n / 2)}"@${D}`],
    ['backslashes in a quoted local part', `"${'\\a'.repeat(n / 2)}`],
    ['apostrophes after a URL', `https://${D}/${"'".repeat(n)}`],
    ['apostrophes inside a query', `https://${D}/p?token=${"a'".repeat(n / 2)}`],
    ['many URLs with an apostrophe', `https://${D}/a'b `.repeat(n / 16)],
    ['backticks and quotes around brackets', `'https://${D}/${')`'.repeat(n / 2)}`],
    ['mailto: with encoded text and invalid escapes', `mailto: ${'%ZZ%40'.repeat(n / 6)}`],
    ['mailto: with a long run of whitespace', `mailto:${' '.repeat(n)}`],
    ['mailto: repeated', 'mailto: %61'.repeat(n / 11)],
    ['a path segment of invalid escapes around %40', `https://${D}/${MARK}${'%ZZ'.repeat(n / 3)}%40${D}`],
    ['a path segment of valid escapes', `https://${D}/${'%C3%BC'.repeat(n / 6)}%40${D}`],
    ['a path segment of broken multi-byte escapes', `https://${D}/${'%E2%82'.repeat(n / 6)}%40${D}`],
    ['a path with many "@" and "%"', `https://${D}/${'%@'.repeat(n / 2)}`],
    ['percent signs only', `https://${D}/${'%'.repeat(n)}`],
    ['non-ASCII characters before "@"', `${'😀™·'.repeat(n / 2)}@${D}`],
    ['non-ASCII characters and many "@"', '😀x@'.repeat(n)],
    ['quoted addresses glued to a URL', `https://${D}/p?id=${'"a"@b.test'.repeat(n / 10)}`],
    ['many URLs followed by a quote', `https://${D}/p"a`.repeat(n / 16)],
    ['many quoted addresses after "mailto:"', 'mailto: "a"@b.test'.repeat(n / 18)],
    ['mailto: with an opening quote repeated', 'mailto: "a'.repeat(n / 10)],
    ['mailto: followed by a long URL', `mailto: https://${D}/p?${'a=b&'.repeat(n / 4)}`],
    ['a query of allowlisted values with "@"', `https://${D}/p?${'hl=a@b.test&'.repeat(n / 11)}`],
    ['a query of keys with "@"', `https://${D}/p?${'a@b.test=1&'.repeat(n / 10)}`],
    ['a long value that is encoded twice', `https://${D}/p?hl=${'%2540'.repeat(n / 5)}`],
  ];

  it.each(inputs)('redactText: %s', (_name, input) => {
    const started = performance.now();
    const once = redactText(input);
    redactText(once);
    maskEmails(input);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(once.length).toBeGreaterThan(0);
  });

  it.each(inputs)('sanitizeUrl: %s', (_name, input) => {
    if (!input.startsWith('http')) return;
    const started = performance.now();
    sanitizeUrl(input);
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });

  it('a document part of 400 000 characters with addresses, URLs and apostrophes', () => {
    const part = `Kontakt: first!last@${D}, "alice.smith"@${D}. Siehe 'https://${D}/p?token=alice's-id' und mailto: %61lice%40${D}. `;
    const text = part.repeat(Math.ceil(400_000 / part.length));
    const started = performance.now();
    const out = redactText(text);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(out).not.toMatch(/first|alice|%61|token=alice/);
    expect(redactText(out)).toBe(out);
  });
});

describe('idempotency over mixed pieces (URLs, addresses, quotes, escapes, "mailto:")', () => {
  const pieces = [
    'a',
    'bob',
    '@',
    'example.test',
    'x.test',
    '!',
    "'",
    '"',
    '`',
    '/',
    '?',
    '=',
    '&',
    '#',
    ';',
    ':',
    '%40',
    '%ZZ',
    '%E9',
    '%3D',
    '%3B',
    '%2F',
    '%3F',
    '%26',
    'https://x.test/',
    'https://x.test/p?',
    'mailto:',
    'mailto: ',
    ' ',
    ' ',
    '.',
    ',',
    ')',
    '(',
    '-',
    '~',
    '{',
    '}',
    '|',
    '[redacted]',
    '%25',
    '%',
    '\\',
    'token=',
    'id=G-ABC',
    '"zq"@x.test',
    '"a b"@x.test',
    'mailto: "q"@x.test',
    'family=Roboto',
    'hl=de',
    '😀',
    '™',
    '\u00a0',
    '«',
    '»',
    'mailto:\n',
  ];

  it('redactText and sanitizeUrl: the second pass changes nothing', () => {
    const rnd = random(20261033);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    for (let i = 0; i < 40_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(rnd() * 10) }, pick).join('');
      expectStable(text);
      expectStableUrl(`https://x.test/${text.replace(/\s/g, '')}`);
    }
  });
});
