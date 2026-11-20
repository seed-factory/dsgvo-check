import { describe, expect, it } from 'vitest';
import { findFixtureLeaks } from '../../../utils/fixture-redaction.ts';

describe('findFixtureLeaks (the scanner is not vacuous)', () => {
  it('finds addresses in link text, accessible names and document parts', () => {
    const snapshot = {
      dom: { links: [{ text: 'info@example.test', accessibleName: 'mailto:info@example.test' }] },
      documents: [{ parts: [{ section: 'Kontakt', text: 'Schreiben Sie an kontakt@example.test.' }] }],
    };
    expect(findFixtureLeaks(snapshot)).toEqual([
      '$.dom.links[0].text: e-mail address with a local part',
      '$.dom.links[0].accessibleName: e-mail address with a local part',
      '$.dom.links[0].accessibleName: mailto: recipient',
      '$.documents[0].parts[0].text: e-mail address with a local part',
    ]);
  });

  it('finds identifiers in the path of a URL', () => {
    expect(findFixtureLeaks({ url: 'https://ad.example.test/activity;dc_pre=abc;ord=1' })).toEqual([
      '$.url: identifier or address in the URL path',
    ]);
    expect(findFixtureLeaks({ url: 'https://sync.example.test/ibs:dpid=1&dpuuid=abc' })).toHaveLength(1);
  });

  it('accepts the form the collector stores', () => {
    expect(
      findFixtureLeaks({
        text: '[redacted]@example.test',
        href: 'mailto:[redacted]@example.test',
        url: 'https://ad.example.test/activity;dc_pre=[redacted]?cid=[redacted]',
        note: 'Impressum',
      }),
    ).toEqual([]);
  });
});
