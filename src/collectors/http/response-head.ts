// The head of a response as the snapshot keeps it: headers through the core normalizer shared with the browser, cookie
// names without values, and the few fields the collector reads itself.
import type { Dispatcher } from 'undici';
import { setCookieName, snapshotHeaderRecords } from '../../core/redaction/headers.ts';
import type { HeaderRecord } from '../../core/snapshot/common.ts';

/** Only the cookie names of this header reach the snapshot, never the values. */
const SET_COOKIE = 'set-cookie';

// Header records for the snapshot via the core normalizer shared with the browser: no Set-Cookie values (names only),
// URL headers resolved against `base` (the response URL) and sanitized.
export function snapshotHeaders(
  raw: Record<string, string | string[] | undefined>,
  base = 'https://invalid.invalid/',
): {
  headers: HeaderRecord[];
  setCookieNames: string[];
  blankHeaderNames: string[];
} {
  const flat: Array<{ name: string; value: string }> = [];
  const setCookieNames: string[] = [];
  /** Names with at least one non-empty value; a header sent only empty is blank. */
  const filled = new Set<string>();

  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();

    for (const v of Array.isArray(value) ? value : [value]) {
      if (n === SET_COOKIE) {
        const c = setCookieName(v);
        if (c !== null) setCookieNames.push(c);
        continue;
      }
      flat.push({ name: n, value: v });
      if (v.trim() !== '') filled.add(n);
    }
  }

  return {
    headers: snapshotHeaderRecords(flat, base),
    setCookieNames,
    blankHeaderNames: [...new Set(flat.map((h) => h.name))].filter((name) => !filled.has(name)),
  };
}

export interface ResponseHead {
  headers: HeaderRecord[];
  setCookieNames: string[];
  /**
   * Headers sent with an empty value: a stored record shows `[redacted]` either way, and the challenge signatures count
   * an empty header only where they say so.
   */
  blankHeaderNames: string[];
  /** Absolute and unsanitized; null when absent or not a URL. */
  location: string | null;
  contentType: string | null;
  contentEncoding: string | null;
}

export function readResponseHead(raw: Dispatcher.ResponseData['headers'], url: string): ResponseHead {
  const { headers, setCookieNames, blankHeaderNames } = snapshotHeaders(raw, url);
  const first = (name: string) => {
    const v = raw[name];
    return (Array.isArray(v) ? v[0] : v) ?? null;
  };

  return {
    headers,
    setCookieNames,
    blankHeaderNames,
    location: absoluteLocation(first('location'), url),
    contentType: first('content-type'),
    contentEncoding: first('content-encoding'),
  };
}

function absoluteLocation(rawLocation: string | null, base: string): string | null {
  if (!rawLocation) return null;
  try {
    return new URL(rawLocation, base).href;
  } catch {
    return null;
  }
}
