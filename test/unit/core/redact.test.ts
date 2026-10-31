/**
 * L1 (D20, AGENTS rule 2): `redactText` masks e-mail addresses, `mailto:` values and URL query/path values in free
 * text that a collector copies into the snapshot (link text, accessible names, document parts). Domains and service
 * names stay, so the matching of PRIV-01 does not change. The function is idempotent.
 */
import { describe, expect, it } from 'vitest';
import * as api from '../../../src/core/api.ts';
import { maskEmails, maskMailto, redactText } from '../../../src/core/redact.ts';
import { REDACTED } from '../../../src/core/url.ts';

const MARK = 'zq7marker';

describe('redactText: DNS TXT records (G02)', () => {
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
    // a space after "mailto:", a list with a bare second recipient, the size suffix is dropped with the address
    [
      'v=DMARC1; p=none; rua=mailto: a@x.test,b@y.test;',
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@x.test,${REDACTED}@y.test;`,
    ],
    ['rua=mailto:a@x.test,mailto:b@y.test!10m', `rua=mailto:${REDACTED}@x.test,mailto:${REDACTED}@y.test`],
    ['v=spf1 include:_spf.example.test ~all', 'v=spf1 include:_spf.example.test ~all'],
  ])('%j → %j', (input, expected) => {
    expect(redactText(input)).toBe(expected);
    expect(redactText(expected)).toBe(expected);
  });
});

describe('redactText: e-mail addresses and mailto:', () => {
  it.each([
    ['mailto: info@example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:Info@Example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:info@example.test?subject=Hallo&body=Text', `mailto:${REDACTED}@example.test`],
    ['mailto:a@x.test,b@y.test', `mailto:${REDACTED}@x.test,${REDACTED}@y.test`],
    ['mailto:%69nfo%40example.test', `mailto:${REDACTED}@example.test`],
    ['Schreiben Sie an mailto:info@example.test.', `Schreiben Sie an mailto:${REDACTED}@example.test.`],
    // a bare word after "mailto:" and whitespace is prose, not an address
    ['mailto: Kontakt aufnehmen', 'mailto: Kontakt aufnehmen'],
  ])('%j → %j', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('masks a bare address inside a sentence and keeps the punctuation around it', () => {
    expect(redactText('Kontakt: info@example.test.')).toBe(`Kontakt: ${REDACTED}@example.test.`);
    expect(redactText('E-Mail (Datenschutz.Team@Example.TEST), Tel. +49 30 1234567')).toBe(
      `E-Mail (${REDACTED}@example.test), Tel. +49 30 1234567`,
    );
    expect(redactText('a@one.test; b@two.test')).toBe(`${REDACTED}@one.test; ${REDACTED}@two.test`);
  });

  it('keeps the domain of an internationalized address', () => {
    expect(redactText('info@bäckerei.test')).toBe(`${REDACTED}@bäckerei.test`);
  });

  it('leaves no local part behind', () => {
    const out = redactText(`mailto:${MARK}.name@example.test oder ${MARK}2@example.test`);
    expect(out).not.toContain(MARK);
    expect(out).toContain('@example.test');
  });

  it('keeps one mailto: prefix per recipient (DMARC rua/ruf style lists)', () => {
    expect(redactText('v=DMARC1; p=none; rua=mailto:dmarc@example.test,mailto:agg@other.test; fo=1')).toBe(
      `v=DMARC1; p=none; rua=mailto:${REDACTED}@example.test,mailto:${REDACTED}@other.test; fo=1`,
    );
  });

  it('does not take handles, decorators or already masked values for addresses', () => {
    for (const s of [
      '@media screen',
      'Folgen Sie @beispiel auf Social Media',
      `${REDACTED}@example.test`,
      `mailto:${REDACTED}@example.test`,
      'Version 2@2x',
      // versions and image names with "@" are not addresses
      'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
      'https://www.example.test/img/logo@2x.png',
      'react@18.3.1 und lodash@4.17.21',
    ]) {
      expect(redactText(s)).toBe(s);
    }
  });
});

describe('redactText: URLs inside text', () => {
  it('redacts query values that are not allowlisted and keeps allowlisted ones', () => {
    expect(redactText(`Siehe https://shop.example.test/p?token=${MARK}&id=G-ABC123 und weiter.`)).toBe(
      `Siehe https://shop.example.test/p?token=${REDACTED}&id=G-ABC123 und weiter.`,
    );
  });

  it('handles punctuation around the URL', () => {
    expect(redactText(`(https://shop.example.test/?sid=${MARK}).`)).toBe(
      `(https://shop.example.test/?sid=${REDACTED}).`,
    );
    expect(redactText(`„https://shop.example.test/?sid=${MARK}“`)).toBe(
      `„https://shop.example.test/?sid=${REDACTED}“`,
    );
    expect(redactText(`<https://shop.example.test/?sid=${MARK}>, danach`)).toBe(
      `<https://shop.example.test/?sid=${REDACTED}>, danach`,
    );
  });

  it('redacts matrix parameters and prefix parameters of the path and drops credentials and the fragment', () => {
    expect(redactText(`https://ad.example.test/activity;src=1;dc_pre=${MARK};ord=${MARK}`)).toBe(
      `https://ad.example.test/activity;src=${REDACTED};dc_pre=${REDACTED};ord=${REDACTED}`,
    );
    expect(redactText(`https://u:${MARK}@sync.example.test/ibs:dpid=1&dpuuid=${MARK}#frag`)).toBe(
      `https://sync.example.test/ibs:dpid=${REDACTED}&dpuuid=${REDACTED}`,
    );
  });

  it('masks an address nested in the path of an archive URL', () => {
    expect(redactText('https://web.archive.example/web/20240329064148/mailto:info@example.test')).toBe(
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    );
  });

  it('keeps URLs without anything sensitive as written (no normalisation of the visible text)', () => {
    for (const s of [
      'https://www.example.test',
      'https://www.example.test/impressum/',
      'Mehr unter https://www.example.test/datenschutz.',
      'https://fonts.googleapis.example/css2?family=Roboto&display=swap',
    ]) {
      expect(redactText(s)).toBe(s);
    }
    expect(redactText('https://www.example.test/a#abschnitt')).toBe('https://www.example.test/a');
  });

  it('uses the allowlist it is given', () => {
    const url = `https://shop.example.test/p?stage=beta&sid=${MARK}`;
    expect(redactText(url)).toBe(`https://shop.example.test/p?stage=${REDACTED}&sid=${REDACTED}`);
    expect(redactText(url, new Set(['stage']))).toBe(
      `https://shop.example.test/p?stage=beta&sid=${REDACTED}`,
    );
  });
});

describe('redactText: general properties', () => {
  const samples = [
    'mailto: info@example.test',
    'Kontakt: info@example.test.',
    `Siehe https://shop.example.test/p?token=${MARK}&id=G-ABC123 und weiter.`,
    `(https://shop.example.test/?sid=${MARK}).`,
    `https://ad.example.test/activity;src=1;dc_pre=${MARK}`,
    'https://web.archive.example/web/2024/mailto:info@example.test',
    'rua=mailto:dmarc@example.test,mailto:agg@other.test;',
    'Keine Besonderheiten in diesem Text.',
    '',
  ];

  it.each(samples)('is idempotent for %j', (s) => {
    const once = redactText(s);
    expect(redactText(once)).toBe(once);
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

describe('api.ts exports the masks for checks and collectors (D05/D23 import boundary)', () => {
  it('exports redactText and maskMailto', () => {
    expect(api.redactText('info@example.test')).toBe(`${REDACTED}@example.test`);
    expect(api.maskMailto('mailto:info@example.test')).toBe(`mailto:${REDACTED}@example.test`);
  });
});
