import { describe, expect, it } from 'vitest';
import { hdr01 } from '../../../../src/checks/http/hdr-01.ts';
import { hstsOf } from '../../../../src/checks/http/shared.ts';
import { MAX_HEADER_VALUE, storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import {
  makeDocumentResponse,
  makeHttp,
  makeSnapshot,
  observationsOf,
  runCheck,
} from '../../../utils/snapshot-builder.ts';

const BASE = 'https://www.example.test/';

function findingsWithHeader(name: string, value: string) {
  const headers = [
    { name: 'strict-transport-security', value: 'max-age=31536000' },
    { name: 'x-frame-options', value: 'SAMEORIGIN' },
    { name: 'content-security-policy', value: "default-src 'self'" },
    { name: 'x-content-type-options', value: 'nosniff' },
    { name: 'referrer-policy', value: 'strict-origin' },
    { name: 'permissions-policy', value: 'camera=()' },
  ].map((header) => (header.name === name ? { name, value } : header));
  const document = makeDocumentResponse({ url: 'https://www.example.de/', role: 'start', headers });
  const snapshot = makeSnapshot({ http: makeHttp({ documents: [document] }) });
  return observationsOf(runCheck(hdr01, snapshot))
    .map((observation) => `${observation.variant}:${observation.subject}`)
    .sort();
}

describe('a run of unknown entries does not push the entry that decides the verdict out of the stored value', () => {
  const RAW_LIMIT = 65_536;
  /** `head`, then `entry` repeated until the value is `size` characters, then `tail`. */
  const built = (head: string, entry: string, tail: string, size: number) =>
    head + entry.repeat(Math.max(0, Math.floor((size - head.length - tail.length) / entry.length))) + tail;
  const stored = (name: string, value: string) => storedHeaderRecord(name, value, BASE, sanitizeUrl);

  it.each([
    ['the HSTS example', 'strict-transport-security', 'max-age=1;', 'x;', 'max-age=0'],
    ['a referrer list', 'referrer-policy', 'no-referrer,', 'x,', 'unsafe-url'],
    ['an XFO list', 'x-frame-options', 'ALLOWALL,', 'x,', 'DENY'],
  ])(
    '%s: the end of the value is stored at 400 bytes, 2 KiB and 64 KiB',
    (_label, name, head, entry, tail) => {
      for (const size of [400, MAX_HEADER_VALUE, RAW_LIMIT]) {
        const value = built(head, entry, tail, size);
        const record = stored(name, value);
        expect(record.truncated).toBeUndefined();
        expect(record.value.length).toBeLessThan(MAX_HEADER_VALUE);
        expect(record.value.endsWith(tail)).toBe(true);
      }
    },
  );

  it.each([
    ['strict-transport-security', 'max-age=1;', 'x;', 'max-age=0'],
    ['strict-transport-security', 'max-age=31536000;', 'x=1;', 'includeSubDomains'],
    ['referrer-policy', 'no-referrer,', 'x,', 'unsafe-url'],
    ['referrer-policy', 'unsafe-url,', 'x,', 'no-referrer'],
    ['x-frame-options', 'ALLOWALL,', 'x,', 'DENY'],
    ['x-frame-options', 'x,', 'x,', 'ALLOWALL'],
    ['permissions-policy', 'x=(),', 'x=(),', 'camera=()'],
  ])(
    'the verdicts of HDR-01 and the HSTS reading follow the stored %s as they follow the value as sent: %s…',
    (name, head, entry, tail) => {
      for (const size of [400, MAX_HEADER_VALUE, RAW_LIMIT]) {
        const value = built(head, entry, tail, size);
        const record = stored(name, value);
        expect(hstsOf([record])).toEqual(hstsOf([{ name, value }]));
        expect(findingsWithHeader(name, record.value)).toEqual(findingsWithHeader(name, value));
      }
    },
  );

  it('Link parameters and CSP directives that are unknown are one entry each', () => {
    const link = stored('link', built('</a>', ';x', '; rel=preload', RAW_LIMIT));
    expect(link.value).toBe(`<${BASE}a>;[redacted]; rel=preload`);
    const csp = stored('content-security-policy', built('', 'x;', "frame-ancestors 'self'", RAW_LIMIT));
    expect(csp.value).toBe("[redacted];frame-ancestors 'self'");
    expect(csp.truncated).toBeUndefined();
    expect(csp.frameAncestors).toMatchObject({ present: true, restricts: true });
  });

  it('counterexample: entries that are not unknown stay as sent', () => {
    expect(stored('referrer-policy', 'origin, x, same-origin, y, z, no-referrer').value).toBe(
      'origin, [redacted], same-origin, [redacted], no-referrer',
    );
    expect(stored('x-xss-protection', 'x; 1; y').value).toBe('[redacted]; 1; [redacted]');
  });
});
