/**
 * (specification 5.3 "Редактирование"): the fixtures of collector output look like real output — no e-mail
 * address with a local part, no `mailto:` recipient, and no matrix parameter, `prefix:k=v` segment or address in the
 * path of an http(s) URL. This covers `text`, `accessibleName`, document `parts` and every other string of a browser
 * snapshot fixture. A fixture that needs an address writes it the way the collector stores it: `[redacted]@domain`.
 */
import { describe, expect, it } from 'vitest';
import { maskEmails } from '../../../src/core/redact.ts';
import { sanitizeUrl } from '../../../src/core/url.ts';
import {
  SCENARIOS,
  scenarioFixture,
  scenariosOf,
  VARIANT_SCENARIOS,
} from '../checks/browser/scenarios/index.ts';

function* strings(value: unknown, at = '$'): Generator<[string, string]> {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${at}[${i}]`);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) yield* strings(v, `${at}.${k}`);
}

const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/** Leaks found in the strings of one parsed fixture (JSON path + what was found). */
function findLeaks(fixture: unknown): string[] {
  const leaks: string[] = [];
  for (const [at, value] of strings(fixture)) {
    if (maskEmails(value) !== value) leaks.push(`${at}: e-mail address with a local part`);
    if (/mailto:\s*(?!\[redacted\])[^\s@]+@/i.test(value)) leaks.push(`${at}: mailto: recipient`);
    if (/^https?:\/\//i.test(value)) {
      const before = pathOf(value);
      const after = pathOf(sanitizeUrl(value));
      if (before !== null && before !== after) leaks.push(`${at}: identifier or address in the URL path`);
    }
  }
  return leaks;
}

describe('findLeaks (the scanner is not vacuous)', () => {
  it('finds addresses in link text, accessible names and document parts', () => {
    const snapshot = {
      dom: { links: [{ text: 'info@example.test', accessibleName: 'mailto:info@example.test' }] },
      documents: [{ parts: [{ section: 'Kontakt', text: 'Schreiben Sie an kontakt@example.test.' }] }],
    };
    expect(findLeaks(snapshot)).toEqual([
      '$.dom.links[0].text: e-mail address with a local part',
      '$.dom.links[0].accessibleName: e-mail address with a local part',
      '$.dom.links[0].accessibleName: mailto: recipient',
      '$.documents[0].parts[0].text: e-mail address with a local part',
    ]);
  });

  it('finds identifiers in the path of a URL', () => {
    expect(findLeaks({ url: 'https://ad.example.test/activity;dc_pre=abc;ord=1' })).toEqual([
      '$.url: identifier or address in the URL path',
    ]);
    expect(findLeaks({ url: 'https://sync.example.test/ibs:dpid=1&dpuuid=abc' })).toHaveLength(1);
  });

  it('accepts the form the collector stores', () => {
    expect(
      findLeaks({
        text: '[redacted]@example.test',
        href: 'mailto:[redacted]@example.test',
        url: 'https://ad.example.test/activity;dc_pre=[redacted]?cid=[redacted]',
        note: 'Impressum',
      }),
    ).toEqual([]);
  });
});

describe('fixtures of browser snapshots', () => {
  const all = Object.keys({ ...SCENARIOS, ...VARIANT_SCENARIOS }).flatMap((id) =>
    scenariosOf(id).map((s) => [`${id}/${s.file}`, s] as const),
  );

  it('exist', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all)('%s has no unredacted address or path identifier', (_name, s) => {
    expect(findLeaks(scenarioFixture(s))).toEqual([]);
  });
});
