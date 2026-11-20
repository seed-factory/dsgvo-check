/**
 * Fixtures of collector output look like real output: no e-mail address with a local part, no `mailto:` recipient, no
 * matrix parameter, `prefix:k=v` segment or address in an http(s) URL path. An address is written `[redacted]@domain`.
 */
import { maskEmails } from '../../src/core/redaction/redact.ts';
import { sanitizeUrl } from '../../src/core/url/url.ts';

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
export function findFixtureLeaks(fixture: unknown): string[] {
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
