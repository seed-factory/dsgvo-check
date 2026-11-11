/**
 * Address redaction in free text removes the complete local part across quoting, Unicode and malformed escapes, masks
 * every `mailto:` recipient and is idempotent. Addresses in URL paths: url/redaction.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { maskEmails, redactText } from '../../../../src/core/redaction/redact.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { D, expectStable, expectStableText, MARK, random } from '../url/redaction-helpers.ts';

const MASKED_ADDRESS = `${REDACTED}@${D}`;
const MASKED_MAILTO = `mailto:${MASKED_ADDRESS}`;

function expectMaskedText(input: string, expected: string): void {
  const out = expectStableText(input);
  expect(out).toBe(expected);
  expect(out).not.toContain(MARK);
}

describe('the whole local part goes, whatever characters it has', () => {
  const specials = Array.from("!#$&'*+-/=?^_`{|}~%");

  it.each(specials)('masks %j inside the local part (free text, bare address, sentence)', (ch) => {
    const address = `${MARK}a${ch}${MARK}b@${D}`;
    expect(expectStableText(address)).toBe(MASKED_ADDRESS);
    expect(maskEmails(address)).toBe(MASKED_ADDRESS);
    expect(redactText(`Kontakt: ${address}.`)).toBe(`Kontakt: ${MASKED_ADDRESS}.`);
    expect(redactText(`Kontakt (${address}), Tel. 030`)).toBe(`Kontakt (${MASKED_ADDRESS}), Tel. 030`);
  });

  it.each([
    [`first!last@${D}`, MASKED_ADDRESS],
    [`"alice.smith"@${D}`, MASKED_ADDRESS],
    [`"john smith"@${D}`, MASKED_ADDRESS],
    [`"a\\"b"@${D}`, MASKED_ADDRESS],
    [`"a@b"@${D}`, MASKED_ADDRESS],
    [`"a,b;c"@${D}`, MASKED_ADDRESS],
    [`Schreiben Sie an "alice.smith"@${D}, danke.`, `Schreiben Sie an ${MASKED_ADDRESS}, danke.`],
    [`mailto:"alice.smith"@${D}`, MASKED_MAILTO],
  ])('masks the special or quoted local part: %j', (input, expected) => {
    const out = expectStableText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('john');
    expect(maskEmails(input)).toBe(expected);
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
    [`<${MARK}!x@${D}>`, `<${MASKED_ADDRESS}>`],
    [
      `https://www.example.test/impressum/ und Kontakt@${D}`,
      `https://www.example.test/impressum/ und ${MASKED_ADDRESS}`,
    ],
    ['info@bäckerei.test', `${REDACTED}@bäckerei.test`],
    [
      `mailto:${MARK}.name@example.test oder ${MARK}2@example.test`,
      `mailto:${REDACTED}@example.test oder ${REDACTED}@example.test`,
    ],
  ])('a bare address in a sentence: %j', expectMaskedText);

  it.each([
    '@media screen',
    'Folgen Sie @beispiel auf Social Media',
    `${REDACTED}@example.test`,
    `mailto:${REDACTED}@example.test`,
    MASKED_ADDRESS,
    MASKED_MAILTO,
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
    expect(expectStableText(`kontakt@x.test${'https://shop.example.test/p?sid='}${MARK}`)).toBe(
      `${REDACTED}@x.testhttps://shop.example.test/p?sid=${REDACTED}`,
    );
    expect(expectStableText(`${MARK}!a@x.testmailto:b@y.test`)).toBe(
      `${REDACTED}@x.testmailto:${REDACTED}@y.test`,
    );
  });

  it('takes a chain "a@b.test@c.test" for one address (the second pass must not find a new one)', () => {
    expect(expectStableText(`a@b.test@c.test`)).toBe(`${REDACTED}@c.test`);
    expect(expectStableText(`${MARK}@x.test@y.test@z.test.`)).toBe(`${REDACTED}@z.test.`);
    expect(expectStable(`https://${D}/a@b.test@c.test`)).toBe(`https://${D}/${REDACTED}@c.test`);

    // an "@" that does not continue into a domain is not part of the chain
    expect(expectStableText('a@b.test @c.test und x@y')).toBe(`${REDACTED}@b.test @c.test und x@y`);
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
      const out = expectStableText(`Kontakt: ${local}@${D}.`);

      expect(out, local).toBe(`Kontakt: ${MASKED_ADDRESS}.`);
    }

    for (let i = 0; i < 3000; i++) {
      const local = randomLocal(pathAlphabet);
      const out = expectStable(`https://${D}/kontakt/${local}@${D}`);

      expect(out, local).toBe(`https://${D}/kontakt/${MASKED_ADDRESS}`);
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
    const out = expectStableText(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|bob|brien|%40|%61|%69/i);
  });

  it('gives one prefix to the first recipient also when it carries its own', () => {
    expect(expectStableText('mailto:mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStableText('mailto:,mailto:a@x.test')).toBe(`mailto:${REDACTED}@x.test`);
    expect(expectStableText('mailto: %40-')).toBe(`mailto:${REDACTED}`);
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
    expect(expectStableText(s)).toBe(s);
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
  ])('the value goes: %s', expectMaskedText);

  it.each([
    [`https://${D}/unsubscribe?${MARK}@${D}`, `https://${D}/unsubscribe?${REDACTED}=${REDACTED}`],
    [`https://x.test/p?${MARK}%40${D}=1`, `https://x.test/p?${REDACTED}=${REDACTED}`],
    [`https://x.test/p?${MARK}%2540${D}=1`, `https://x.test/p?${REDACTED}=${REDACTED}`],
    [
      `https://x.test/p?a=1&${MARK}@${D}&b=2`,
      `https://x.test/p?a=${REDACTED}&${REDACTED}=${REDACTED}&b=${REDACTED}`,
    ],
  ])('the key goes: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    // redactText agrees with sanitizeUrl on a bare URL
    expect(expectStableText(input)).toBe(expected);
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
      expect(expectStableText(input)).toBe(expected);
    });

    it('a masked address stays a fixed point inside a value', () => {
      const url = `https://x.test/p?hl=${REDACTED}&${REDACTED}=${REDACTED}`;
      expect(expectStable(url)).toBe(url);
    });
  });

  it('the marker of an address next to an allowlisted parameter never survives', () => {
    const glue = ["'", '`', ',', '.', ';', ')', '%2C', '%27', '+', '-', '_', '|', '~', '!'];
    const names = ['family', 'hl', 'display', 'subset', 'render', 'output', 'libraries', 'en', 'ver', 'tok'];
    const forms = [`${MARK}@${D}`, `mailto:${MARK}@${D}`, `${MARK}%40${D}`, `"${MARK}"@${D}`];

    for (const name of names) {
      for (const separator of glue) {
        for (const form of forms) {
          const url = `https://x.test/p?${name}=de${separator}${form}`;

          expect(expectStableText(`'${url}'`), url).not.toContain(MARK);
          expectStable(url);
        }
      }
    }
  });
});

describe('a quoted address after "mailto:" or glued to a token is stable', () => {
  it.each([
    [`mailto: "${MARK}"@${D}`, MASKED_MAILTO],
    [`mailto:\t"${MARK}"@${D}`, MASKED_MAILTO],
    [`mailto:\n"${MARK}"@${D}`, MASKED_MAILTO],
    [`mailto:   "${MARK} smith"@${D}`, MASKED_MAILTO],
    [`mailto:"${MARK}"@${D}`, MASKED_MAILTO],
    [`MAILTO: "${MARK}"@${D}`, MASKED_MAILTO],
    ['mailto:"x"@mail.example%2Etest', `mailto:${REDACTED}@mail.example.test`],
    [`mailto: "${MARK}"@${D}.`, `${MASKED_MAILTO}.`],
    [`Mail an mailto: "${MARK}"@${D}, danke`, `Mail an ${MASKED_MAILTO}, danke`],
  ])('mailto: %j', expectMaskedText);

  it.each([
    [`https://x.test/p?id="${MARK}"@${D}`, `https://x.test/p?id=${REDACTED}`],
    [`https://x.test/p/"${MARK}"@${D}`, `https://x.test/p/${MASKED_ADDRESS}`],
    [`https://x.test/p?id="${MARK}"@${D}"b"@e.test`, `https://x.test/p?id=${REDACTED}`],
    [`mailto:a@d.test"${MARK}"@d.test`, `mailto:${REDACTED}@d.test`],
    [`mailto:a@d.test"${MARK}"@d.test"b"@e.test`, `mailto:${REDACTED}@e.test`],
  ])('a quoted address that follows a token without a blank: %j', expectMaskedText);

  describe('counterexamples: a quote that is not a local part stays', () => {
    it.each([
      'mailto: "Kontakt" aufnehmen',
      'mailto: "Kontakt aufnehmen"',
      'mailto: "Kontakt"',
      '<a href="https://shop.example.test/p">"Kontakt"</a>',
      'Er sagte "Kontakt"@ und ging.',
    ])('%j', (s) => {
      expect(expectStableText(s)).toBe(s);
    });

    it('a quote after a URL is still its closing quote', () => {
      expect(expectStableText(`<a href="https://shop.example.test/p?sid=${MARK}">"Kontakt"</a>`)).toBe(
        `<a href="https://shop.example.test/p?sid=${REDACTED}">"Kontakt"</a>`,
      );
      expect(expectStableText(`"https://shop.example.test/p?sid=${MARK}" "${MARK}"@${D}`)).toBe(
        `"https://shop.example.test/p?sid=${REDACTED}" ${MASKED_ADDRESS}`,
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
  ])('%j', expectMaskedText);

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
  ])('a URL next to a recipient, or a token inside prose: %j', expectMaskedText);
});

describe('non-ASCII characters in the local part', () => {
  const odd = ['😀', '™', '·', '–', '€', '©', '½', '♥', '‍', '👨‍👩‍👧', 'é', 'ß', 'ø', '中', 'ж'];

  it.each(odd)('masks the whole local part with %j at the end, in the middle and at the start', (ch) => {
    expect(expectStableText(`${MARK}${ch}@${D}`)).toBe(MASKED_ADDRESS);
    expect(expectStableText(`${MARK}${ch}x@${D}`)).toBe(MASKED_ADDRESS);
    expect(expectStableText(`${ch}${MARK}@${D}`)).toBe(MASKED_ADDRESS);
    expect(expectStableText(`Kontakt: ${MARK}${ch}${MARK}@${D}.`)).toBe(`Kontakt: ${MASKED_ADDRESS}.`);
    expect(maskEmails(`${MARK}${ch}@${D}`)).toBe(MASKED_ADDRESS);
  });

  it('masks it in a path segment, but a "/" is still the border', () => {
    expect(expectStable(`https://${D}/kontakt/${MARK}😀@${D}`)).toBe(
      `https://${D}/kontakt/${MASKED_ADDRESS}`,
    );
    expect(expectStable(`https://${D}/kontakt/${MARK}%E2%84%A2@${D}`)).toBe(
      `https://${D}/kontakt/${MASKED_ADDRESS}`,
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
      expect(expectStableText(`Kontakt:${space}${MARK}@${D}`)).toBe(`Kontakt:${space}${MASKED_ADDRESS}`);
      expect(expectStableText(`${MARK}${space}${MARK}@${D}`)).toBe(`${MARK}${space}${MASKED_ADDRESS}`);
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
      expect(expectStableText(`${open}${MARK}@${D}${close}`)).toBe(`${open}${MASKED_ADDRESS}${close}`);
    });
  });
});

describe('addresses written with (at) or [at]', () => {
  it.each([
    [`Kontakt: ${MARK}(at)${D}`, `Kontakt: ${MASKED_ADDRESS}`],
    [`E-Mail: ${MARK} (at) Example-Mail.Invalid.`, `E-Mail: ${REDACTED}@example-mail.invalid.`],
    [`${MARK}[at]${D}, ${MARK}2 [ at ] ${D}`, `${MASKED_ADDRESS}, ${MASKED_ADDRESS}`],
    [`${MARK}(AT)${D}`, MASKED_ADDRESS],
    [`${MARK}\u00a0(at)\u00a0${D}`, MASKED_ADDRESS],
  ])('%j → %j: the domain stays, nothing of the local part', expectMaskedText);

  it.each([
    [`https://${D}/${MARK}(at)mail.example`, `https://${D}/${REDACTED}@mail.example`],
    [`https://${D}/c/${MARK}%28at%29mail.example`, `https://${D}/c/${REDACTED}@mail.example`],
    [`https://${D}/${MARK}[at]mail.example?x=1`, `https://${D}/${REDACTED}@mail.example?x=${REDACTED}`],
    [`https://${D}/${MARK}%C2%A0(at)%C2%A0mail.example`, `https://${D}/${REDACTED}@mail.example`],
  ])('in a URL path, also percent-encoded: %j → %j', (input, want) => {
    expect(expectStable(input)).toBe(want);
    expect(redactText(`Link: ${input}`)).toBe(`Link: ${want}`);
  });

  it.each([
    [`E-Mail: mailto: ${MARK} (at) ${D}`, `E-Mail: ${MASKED_MAILTO}`],
    [`mailto:${MARK} (at) ${D}`, MASKED_MAILTO],
    [`mailto: ${MARK} [at] ${D}`, MASKED_MAILTO],
    [`mailto: ${MARK}(at)${D}`, MASKED_MAILTO],
    [`mailto:\n${MARK} (at) ${D}`, MASKED_MAILTO],
    [`mailto:${MARK} (at) ${D}?subject=${MARK}`, MASKED_MAILTO],
  ])('a mailto: value in the (at) form: %j → %j', expectMaskedText);

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

  it.each(inputs.filter(([, input]) => input.startsWith('http')))('sanitizeUrl: %s', (_name, input) => {
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
    ...Array.from('!\'"`/?=&#;:'),
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
    ...Array.from('.,)(-~{}|'),
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
    for (let i = 0; i < 6_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(rnd() * 10) }, pick).join('');
      expectStableText(text);
      expectStable(`https://x.test/${text.replace(/\s/g, '')}`);
    }
  });
});
