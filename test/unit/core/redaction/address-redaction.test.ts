/**
 * Address redaction in free text removes the complete local part across quoting, Unicode and malformed escapes, masks
 * every `mailto:` recipient and is idempotent. Addresses in URL paths: url/redaction.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { maskEmails, maskMailto, redactText } from '../../../../src/core/redaction/redact.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import {
  D,
  expectStableText as expectStable,
  expectStable as expectStableUrl,
  MARK,
  random,
} from '../url/redaction-helpers.ts';

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

  it.each([
    [`first!last@${D}`, `${REDACTED}@${D}`],
    [`"alice.smith"@${D}`, `${REDACTED}@${D}`],
    [`"john smith"@${D}`, `${REDACTED}@${D}`],
    [`"a\\"b"@${D}`, `${REDACTED}@${D}`],
    [`"a@b"@${D}`, `${REDACTED}@${D}`],
    [`"a,b;c"@${D}`, `${REDACTED}@${D}`],
    [`Schreiben Sie an "alice.smith"@${D}, danke.`, `Schreiben Sie an ${REDACTED}@${D}, danke.`],
    [`mailto:"alice.smith"@${D}`, `mailto:${REDACTED}@${D}`],
  ])('masks the special or quoted local part: %j', (input, expected) => {
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

  // The separator in front of an address is no part of it; punctuation around the address stays; the domain is
  // kept (lower-cased, also when it is internationalized).
  it.each([
    ['Kontakt: info@example.test.', `Kontakt: ${REDACTED}@example.test.`],
    [
      'E-Mail (Datenschutz.Team@Example.TEST), Tel. +49 30 1234567',
      `E-Mail (${REDACTED}@example.test), Tel. +49 30 1234567`,
    ],
    ['a@one.test; b@two.test', `${REDACTED}@one.test; ${REDACTED}@two.test`],
    [
      `Mail: a@x.test, b!c@y.test; "d"@z.test (e*f@w.test)`,
      `Mail: ${REDACTED}@x.test, ${REDACTED}@y.test; ${REDACTED}@z.test (${REDACTED}@w.test)`,
    ],
    [`<${MARK}!x@${D}>`, `<${REDACTED}@${D}>`],
    [
      `https://www.example.test/impressum/ und Kontakt@${D}`,
      `https://www.example.test/impressum/ und ${REDACTED}@${D}`,
    ],
    ['info@bäckerei.test', `${REDACTED}@bäckerei.test`],
    [
      `mailto:${MARK}.name@example.test oder ${MARK}2@example.test`,
      `mailto:${REDACTED}@example.test oder ${REDACTED}@example.test`,
    ],
  ])('a bare address in a sentence: %j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
  });

  it.each([
    '@media screen',
    'Folgen Sie @beispiel auf Social Media',
    `${REDACTED}@example.test`,
    `mailto:${REDACTED}@example.test`,
    `${REDACTED}@${D}`,
    `mailto:${REDACTED}@${D}`,
    // versions and image names with "@" are not addresses
    'Version 2@2x',
    'Version 2@2x und logo@2x.png',
    'react@18.3.1 und lodash@4.17.21',
    'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
    'https://www.example.test/img/logo@2x.png',
    // a URL with allowlisted parameters and an "@" that is no address (font axes) is not cut by the mask
    'https://fonts.googleapis.example/css2?family=Roboto&display=swap und Version 3@2x',
    'Er sagte "Hallo" und ging, "Tschüss" folgte.',
    '"Hallo" @example.test',
    'Preis: 5 $ & 6 # 7 = 8 ? 9 / 10',
    'a ! b @ c',
    'Frage: wer@ ist da?',
    'Preis: 5 € inkl. MwSt. ™ © 2026 😀',
    'Straße – Köln · Berlin',
    'a@2x.png',
    'logo™@2x.png',
  ])('counterexample: not an address, stays as written: %j', (s) => {
    expect(redactText(s)).toBe(s);
    expect(maskEmails(s)).toBe(s);
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

  it('randomized: no fragment of a generated local part survives and the result is stable', () => {
    const rnd = random(20261031);
    /** The marker followed by 1 to 24 random characters of `alphabet`. */
    const randomLocal = (alphabet: string[]) => {
      const pick = () => alphabet[Math.floor(rnd() * alphabet.length)];
      return `${MARK}${Array.from({ length: 1 + Math.floor(rnd() * 24) }, pick).join('')}`;
    };
    const alphabet = "abcXYZ019!#$%&'*+-/=?^_`{|}~.".split('');
    // in a path segment: the characters that are the structure of a URL are left out
    const pathAlphabet = "abcXYZ019!$&'*+-^_`{|}~.".split('');

    for (let i = 0; i < 3000; i++) {
      const local = randomLocal(alphabet);
      const out = expectStable(`Kontakt: ${local}@${D}.`);

      expect(out, local).toBe(`Kontakt: ${REDACTED}@${D}.`);
    }

    for (let i = 0; i < 3000; i++) {
      const local = randomLocal(pathAlphabet);
      const out = expectStableUrl(`https://${D}/kontakt/${local}@${D}`);

      expect(out, local).toBe(`https://${D}/kontakt/${REDACTED}@${D}`);
    }
  });
});

describe('mailto: recipients', () => {
  it.each([
    ['mailto: info@example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:Info@Example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:info@example.test?subject=Hallo&body=Text', `mailto:${REDACTED}@example.test`],
    ['mailto:a@x.test,b@y.test', `mailto:${REDACTED}@x.test,${REDACTED}@y.test`],
    ['Schreiben Sie an mailto:info@example.test.', `Schreiben Sie an mailto:${REDACTED}@example.test.`],
    ['mailto: alice@example.invalid', `mailto:${REDACTED}@example.invalid`],
    // an apostrophe in the local part keeps the recipient in one piece
    ["mailto:o'brien@example.test", `mailto:${REDACTED}@example.test`],
    ["Mail an mailto:o'brien@example.test.", `Mail an mailto:${REDACTED}@example.test.`],
    ["'mailto:info@example.test'", `'mailto:${REDACTED}@example.test'`],
    // percent-encoded, after any whitespace
    ['mailto:%69nfo%40example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:%61lice%40example.invalid', `mailto:${REDACTED}@example.invalid`],
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
    expect(out).not.toMatch(/alice|bob|brien|%40|%61|%69/i);
  });

  it('a space and an encoded "@" together are masked as maskMailto masks them', () => {
    expect(redactText('mailto: %61lice%40example.invalid')).toBe(
      maskMailto('mailto: %61lice%40example.invalid'),
    );
  });

  it('gives one prefix to the first recipient also when it carries its own', () => {
    expect(expectStable('mailto:mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStable('mailto:,mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStable('mailto: %40-')).toBe(`mailto:${REDACTED}`);
  });

  it.each([
    'mailto: Kontakt aufnehmen',
    'mailto: Kontakt%20aufnehmen',
    'Hinweis (mailto: siehe unten) bitte lesen',
    '(mailto: siehe unten)',
    'mailto: 100% Datenschutz',
    'mailto: %C3%9Cber uns',
    'mailto: %ZZ nicht erreichbar',
    'mailto: ',
    'mailto: https://shop.example.test/impressum',
    'mailto: siehe https://shop.example.test/p',
  ])('counterexample: prose after "mailto:" stays: %j', (s) => {
    expect(expectStable(s)).toBe(s);
  });
});

describe('an address glued to a URL does not survive in a kept query value or key', () => {
  const FONTS = 'https://fonts.googleapis.example/css';

  it.each([
    // an apostrophe and a backtick do not end the token: the address lands inside the allowlisted value
    [`['${FONTS}?family=Roboto','${MARK}@${D}']`, `['${FONTS}?family=${REDACTED}']`],
    [`https://x.test/p?hl=de\`${MARK}@${D}\``, `https://x.test/p?hl=${REDACTED}\``],
    [`'https://x.test/p?hl=de','mailto:${MARK}@${D}'`, `'https://x.test/p?hl=${REDACTED}'`],
    // the same without a quote
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
  });
});

describe('addresses written with (at) or [at]', () => {
  it.each([
    [`Kontakt: ${MARK}(at)${D}`, `Kontakt: ${REDACTED}@${D}`],
    [`E-Mail: ${MARK} (at) Example-Mail.Invalid.`, `E-Mail: ${REDACTED}@example-mail.invalid.`],
    [`${MARK}[at]${D}, ${MARK}2 [ at ] ${D}`, `${REDACTED}@${D}, ${REDACTED}@${D}`],
    [`${MARK}(AT)${D}`, `${REDACTED}@${D}`],
    [`${MARK}\u00a0(at)\u00a0${D}`, `${REDACTED}@${D}`],
  ])('%j → %j: the domain stays, nothing of the local part', (input, want) => {
    const once = expectStable(input);
    expect(once).toBe(want);
    expect(once).not.toContain(MARK);
  });

  it.each([
    [`https://${D}/${MARK}(at)mail.example`, `https://${D}/${REDACTED}@mail.example`],
    [`https://${D}/c/${MARK}%28at%29mail.example`, `https://${D}/c/${REDACTED}@mail.example`],
    [`https://${D}/${MARK}[at]mail.example?x=1`, `https://${D}/${REDACTED}@mail.example?x=${REDACTED}`],
    [`https://${D}/${MARK}%C2%A0(at)%C2%A0mail.example`, `https://${D}/${REDACTED}@mail.example`],
  ])('in a URL path, also percent-encoded: %j → %j', (input, want) => {
    expect(expectStableUrl(input)).toBe(want);
    expect(redactText(`Link: ${input}`)).toBe(`Link: ${want}`);
  });

  it.each([
    [`E-Mail: mailto: ${MARK} (at) ${D}`, `E-Mail: mailto:${REDACTED}@${D}`],
    [`mailto:${MARK} (at) ${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto: ${MARK} [at] ${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto: ${MARK}(at)${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:\n${MARK} (at) ${D}`, `mailto:${REDACTED}@${D}`],
    [`mailto:${MARK} (at) ${D}?subject=${MARK}`, `mailto:${REDACTED}@${D}`],
  ])('a mailto: value in the (at) form: %j → %j', (input, want) => {
    const once = expectStable(input);
    expect(once).toBe(want);
    expect(once).not.toContain(MARK);
  });

  it.each([
    'Wir treffen uns at noon at the office.',
    'Preis (at) Kasse',
    'meet [at] noon',
    'Angaben (at) www',
    'Sitz: 1010 Wien (AT) www.example.at',
  ])('prose without a domain after the marker stays: %j', (input) => {
    expect(redactText(input)).toBe(input);
  });
});

describe('long inputs: the scan stays linear (about 100 000 to 400 000 characters)', () => {
  // The code is synchronous: a quadratic tail cannot be interrupted by the timeout of the scan.
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
    ['many "(at)" markers', 'a(at)'.repeat(n / 5)],
    ['a run of local-part characters before "(at)"', `${'a'.repeat(4 * n)}(at)x.test`],
    ['"[at]" markers with blanks and short domains', 'a [at] b.'.repeat(n / 9)],
    ['"(at)" markers between Unicode blanks', 'a\u00a0(at)\u2003'.repeat(n / 8)],
    ['mailto: values in the (at) form', 'mailto: a (at) b.test'.repeat(n / 21)],
    ['mailto: with a run of local-part characters before "(at)"', `mailto:${'a'.repeat(4 * n)} (at) x.test`],
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
