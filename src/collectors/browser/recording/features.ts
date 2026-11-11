// Request features extracted BEFORE redaction: identifier parameter names, event type, Consent Mode signals. Identifier
// values are returned only for in-memory correlation and must never reach snapshot, report or logs.

import { setCookieName, storedCookieName } from '../../../core/redaction/headers.ts';
import { safeDecode } from '../../../core/url/email.ts';
import { QUERY_VALUE_RULES, sanitizeUrl } from '../../../core/url/url.ts';
import { REQUEST_QUERY_ALLOWLIST } from '../config.ts';
import { isConsentSignal, isEventName } from '../page-values.ts';
import { loadIdentifierRules } from '../rules.ts';

export interface RequestFeatures {
  identifierNames: string[];
  /** In-memory only. Never persist. */
  identifierValues: string[];
  eventType?: string;
  consentSignals?: { gcs?: string; gcd?: string; npa?: string; dma?: string };
}

const MAX_PATH_PARAMS = 200;
/** Larger bodies are not parsed for query-like pairs. */
const MAX_BODY = 16 * 1024;
/** Cap of a kept event type or consent signal value. */
const MAX_SIGNAL_CHARS = 64;

export const REQUEST_FEATURES_VERSION = 'request-features/2';

function paramSets(url: string, postData: string | null): URLSearchParams[] {
  const sets: URLSearchParams[] = [];
  try {
    sets.push(new URL(url).searchParams);
  } catch {
    // invalid URL: no query features
  }
  if (postData && postData.length <= MAX_BODY && /^[\x20-\x7e\t\r\n%]*$/.test(postData)) {
    // GA4 batches: one query string per line; also plain form posts.
    for (const line of postData.split(/\r?\n/)) {
      if (line.includes('=')) sets.push(new URLSearchParams(line));
    }
  }
  return sets;
}

/** `name=value` pairs of the raw path: matrix parameters (`/a;k=v`) and the prefixed form `/prefix:k=v&k2=v2`. */
export function pathParameters(pathname: string): Array<[name: string, value: string]> {
  const out: Array<[string, string]> = [];
  for (const segment of pathname.split('/')) {
    if (!segment.includes('=')) continue;
    for (const piece of segment.split(';')) {
      const colon = piece.indexOf(':');
      const eq = piece.indexOf('=');
      const body = colon >= 0 && (eq < 0 || colon < eq) ? piece.slice(colon + 1) : piece;
      for (const pair of body.split('&')) {
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        out.push([safeDecode(pair.slice(0, i)), safeDecode(pair.slice(i + 1))]);
        if (out.length >= MAX_PATH_PARAMS) return out;
      }
    }
  }
  return out;
}

export function extractRequestFeatures(url: string, postData: string | null): RequestFeatures {
  const rules = loadIdentifierRules();
  const names = new Set<string>();
  const values: string[] = [];
  let eventType: string | undefined;
  let hitType: string | undefined;
  const consent: Record<string, string> = {};
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  for (const params of paramSets(url, postData)) {
    for (const [rawKey, value] of params) {
      const key = rawKey.toLowerCase();
      if (rules.params.has(key) && value.trim() !== '') {
        names.add(rawKey);
        values.push(value);
      }
      // Any page can send these parameters to any host: only an event name and the Consent Mode forms are kept.
      if (eventType === undefined && rules.eventParams.includes(key) && isEventName(value)) {
        eventType = value;
      }
      if (hitType === undefined && key === 't' && parsed && QUERY_VALUE_RULES.t?.(value, parsed)) {
        hitType = value.slice(0, MAX_SIGNAL_CHARS);
      }
      if (
        rules.consentModeParams.includes(key) &&
        consent[key] === undefined &&
        isConsentSignal(key, value)
      ) {
        consent[key] = value;
      }
    }
  }

  if (parsed) {
    for (const [rawKey, value] of pathParameters(parsed.pathname)) {
      const key = rawKey.toLowerCase();
      if ((rules.params.has(key) || rules.pathParams.has(key)) && value.trim() !== '') {
        names.add(rawKey);
        values.push(value);
      }
    }
  }

  eventType ??= hitType;
  return {
    identifierNames: [...names].sort(),
    identifierValues: values,
    ...(eventType !== undefined ? { eventType } : {}),
    ...(Object.keys(consent).length > 0 ? { consentSignals: consent } : {}),
  };
}

/** `sanitizeUrl` with the detection allowlist of the browser collector (core allowlist plus `ev`). */
export function sanitizeRequestUrl(raw: string): string {
  return sanitizeUrl(raw, REQUEST_QUERY_ALLOWLIST);
}

export interface SetCookieAttrs {
  name: string;
  domain?: string;
  path?: string;
  partitioned: boolean;
}

// Attributes of the cookies in `Set-Cookie` header values; the value is dropped immediately. One header value may hold
// several cookies separated by a line break.
export function parseSetCookies(headers: readonly string[]): SetCookieAttrs[] {
  const out: SetCookieAttrs[] = [];
  for (const h of headers) {
    for (const line of h.split('\n')) {
      const name = setCookieName(line);
      if (name === null) continue;

      const c: SetCookieAttrs = { name, partitioned: false };
      for (const a of line.split(';').slice(1)) {
        const i = a.indexOf('=');
        const key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const val = i < 0 ? '' : a.slice(i + 1).trim();
        if (key === 'domain' && val) c.domain = val.replace(/^\./, '').toLowerCase();
        else if (key === 'path' && val.startsWith('/')) c.path = val;
        else if (key === 'partitioned') c.partitioned = true;
      }
      out.push(c);
    }
  }
  return out;
}

export function splitSetCookieNames(headers: readonly string[]): string[] {
  const raw: string[] = [];
  for (const c of parseSetCookies(headers)) if (!raw.includes(c.name)) raw.push(c.name);
  return raw.map((name) => storedCookieName(name));
}
