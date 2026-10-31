/**
 * Safe request features extracted BEFORE redaction (D05, D20): identifier parameter names, event type and Consent
 * Mode signals. Identifier values are returned only for the in-memory stored-identifier correlation and must never
 * be written to the snapshot, report or logs.
 */
import { QUERY_VALUE_RULES, sanitizeUrl } from '../../core/url.ts';
import { IDENTIFIER_PARAMS, REQUEST_QUERY_ALLOWLIST } from './config.ts';

export interface RequestFeatures {
  /** Sorted, unique names of identifier parameters with a non-empty value. */
  identifierNames: string[];
  /** In-memory only (correlation with stored cookies/storage). Never persist. */
  identifierValues: string[];
  eventType?: string;
  consentSignals?: { gcs?: string; gcd?: string; npa?: string; dma?: string };
}

const CONSENT_KEYS = ['gcs', 'gcd', 'npa', 'dma'] as const;
/**
 * Identifier names that sync and conversion endpoints carry in the URL PATH instead of the query: Floodlight and
 * Google conversion matrix parameters (`;dc_pre=…`, `/_dc_unique_id=…;…`) and the Audience Manager sync
 * (`/ibs:dpid=…&dpuuid=…`). They are read here, before `sanitizeUrl` redacts the path. Only candidates: whether a
 * name is a PERSISTENT identifier is decided by the `identifierParams` of the catalog signature (derive).
 */
const PATH_IDENTIFIER_PARAMS: ReadonlySet<string> = new Set([
  'dpuuid',
  '_dc_unique_id',
  'dc_dbm_token',
  'dc_pre',
  'dc_ext_key',
  'gdid',
]);
const MAX_PATH_PARAMS = 200;
/** Event names (GA4 `en`, Meta Pixel `ev`). `t` counts only as a Universal Analytics hit type (FP-06). */
const EVENT_KEYS = ['en', 'ev'] as const;
const MAX_BODY = 16 * 1024;

/** Version of this parser; written with the features (5.3 `parserVersion`). */
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

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * `name=value` pairs of the PATH: matrix parameters (`/a;k=v;k2=v2`, also a leading `k=v` piece of a segment) and
 * the prefixed form `/prefix:k=v&k2=v2`. Segments without `=` carry none. Raw (not yet redacted) pathname.
 */
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
      if (IDENTIFIER_PARAMS.has(key) && value.trim() !== '') {
        names.add(rawKey);
        values.push(value);
      }
      if (eventType === undefined && (EVENT_KEYS as readonly string[]).includes(key) && value) {
        eventType = value.slice(0, 64);
      }
      if (hitType === undefined && key === 't' && parsed && QUERY_VALUE_RULES.t?.(value, parsed)) {
        hitType = value.slice(0, 64);
      }
      if ((CONSENT_KEYS as readonly string[]).includes(key) && value && consent[key] === undefined) {
        consent[key] = value.slice(0, 64);
      }
    }
  }
  if (parsed) {
    for (const [rawKey, value] of pathParameters(parsed.pathname)) {
      const key = rawKey.toLowerCase();
      if ((IDENTIFIER_PARAMS.has(key) || PATH_IDENTIFIER_PARAMS.has(key)) && value.trim() !== '') {
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

/** One cookie of a `Set-Cookie` header: name and the attributes that decide where the browser stores it. No value. */
export interface SetCookieAttrs {
  name: string;
  /** `Domain=` attribute: lower case, without the leading dot. Absent for a host-only cookie. */
  domain?: string;
  /** `Path=` attribute (only when it starts with `/`). Absent → default path of the request URL. */
  path?: string;
  /** `Partitioned` (CHIPS): the cookie is keyed by the top-level site as well. */
  partitioned: boolean;
}

/**
 * Cookies of `Set-Cookie` header values with their `Domain`, `Path` and `Partitioned` attributes. The value is
 * dropped immediately (D20). One header value may hold several cookies separated by a line break.
 */
export function parseSetCookies(headers: readonly string[]): SetCookieAttrs[] {
  const out: SetCookieAttrs[] = [];
  for (const h of headers) {
    for (const line of h.split('\n')) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (!name) continue;
      const c: SetCookieAttrs = { name, partitioned: false };
      for (const a of attrs) {
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

/** Cookie names from `Set-Cookie` header values; values are dropped immediately. */
export function splitSetCookieNames(headers: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of parseSetCookies(headers)) if (!out.includes(c.name)) out.push(c.name);
  return out;
}
