/**
 * HDR-01: security headers of the main documents (start page, Impressum, Datenschutz) after redirects. One observation
 * per mechanism; pages where it is missing are united.
 */

import {
  type CheckOutcome,
  cspFrameAncestors,
  defineCheck,
  type EvidenceInput,
  type HeaderRecord,
  MAX_HEADER_VALUE,
  type Observation,
  subjects,
} from '../../core/api.ts';
import type { DocumentResponse } from '../../core/snapshot/http.ts';
import { browserAcceptsTls, evidenceValue, headerValues, isSuccess } from './shared.ts';

const ID = 'HDR-01';

type Variant = 'hsts-missing' | 'anti-framing-missing' | 'referrer-policy-permissive' | 'header-missing';

/** Display names of the headers reported as `header-missing` (mechanism key → header). */
const HEADER_NAMES: Readonly<Record<string, string>> = {
  'content-security-policy': 'Content-Security-Policy',
  'x-content-type-options': 'X-Content-Type-Options',
  'permissions-policy': 'Permissions-Policy',
  'referrer-policy': 'Referrer-Policy',
};

interface Problem {
  variant: Variant;
  mechanism: string;
  evidence: { name: string; value: string | null }[];
  params?: Record<string, string>;
}

/** The values the Referrer Policy spec knows; any other token is ignored. */
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);
/** Policies that send the full URL to other origins, or to http after a downgrade. */
const UNSAFE_REFERRER = new Set(['unsafe-url', 'no-referrer-when-downgrade']);

/** RFC 6797 §6.1: `max-age` is required; the UA uses only the first header. */
export function parseHsts(value: string): { ok: true; maxAge: number } | { ok: false; problem: string } {
  const directives = value
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  const maxAge = directives.find((d) => /^max-age\s*=/i.test(d));
  const m = maxAge ? /^max-age\s*=\s*"?(\d+)"?$/i.exec(maxAge) : null;
  if (!m) return { ok: false, problem: 'no-max-age' };
  const n = Number(m[1]);
  if (n === 0) return { ok: false, problem: 'max-age-zero' };
  return { ok: true, maxAge: n };
}

/** Effective policy from a comma-separated list: the last recognised token wins (Referrer Policy §8.1). */
export function effectiveReferrerPolicy(values: readonly string[]): string | null {
  let out: string | null = null;
  for (const v of values) {
    for (const token of v.split(',')) {
      const t = token.trim().toLowerCase();
      if (REFERRER_POLICIES.has(t)) out = t;
    }
  }
  return out;
}

/** A CSP restricts framing when one policy has frame-ancestors without a wildcard source. */
function cspRestrictsFraming(values: readonly string[]): boolean {
  return values.some((v) => cspFrameAncestors(v).restricts);
}

/**
 * What the enforced CSP headers say about framing. A value of the limit length or longer without the collector's
 * stored fact (older snapshot) proves nothing: `unknown`.
 */
function cspFraming(records: readonly HeaderRecord[]): 'restricts' | 'open' | 'unknown' {
  let unknown = false;
  for (const r of records) {
    if (r.frameAncestors) {
      if (r.frameAncestors.restricts) return 'restricts';
      continue;
    }
    if (r.truncated === true || r.value.length >= MAX_HEADER_VALUE) unknown = true;
    else if (cspFrameAncestors(r.value).restricts) return 'restricts';
  }
  return unknown ? 'unknown' : 'open';
}

const nonBlank = (v: string): boolean => v.trim() !== '';

/** An HTTPS response without a working `Strict-Transport-Security` header. */
function hstsProblem(doc: DocumentResponse): Problem | null {
  if (!doc.finalUrl.startsWith('https:')) return null;

  const missing = (value: string | null, problem: string): Problem => ({
    variant: 'hsts-missing',
    mechanism: 'strict-transport-security',
    evidence: [{ name: 'strict-transport-security', value }],
    params: { problem },
  });
  const hsts = headerValues(doc.headers, 'strict-transport-security')[0];
  if (hsts === undefined) return missing(null, 'absent');

  // A header without effect (no max-age, max-age=0) leaves the response without HSTS.
  const parsed = parseHsts(hsts.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] ?? '');
  return parsed.ok ? null : missing(hsts, parsed.problem);
}

/** No `X-Frame-Options` and no CSP `frame-ancestors`; a CSP cut at the limit gives a limitation, not a finding. */
function antiFramingProblem(doc: DocumentResponse): { problem: Problem | null; limitation: string | null } {
  const h = doc.headers;
  const xfo = headerValues(h, 'x-frame-options').join(',');
  const xfoValues = new Set(xfo.split(',').map((value) => value.trim().toLowerCase()));
  const xfoOk =
    [...xfoValues].some((value) => value === 'deny' || value === 'sameorigin') ||
    (xfoValues.size > 1 && xfoValues.has('allowall'));
  if (xfoOk) return { problem: null, limitation: null };

  const framing = cspFraming(h.filter((r) => r.name.toLowerCase() === 'content-security-policy'));
  // A cut CSP without the derived fact may still hold the directive: no finding on a guess.
  if (framing === 'unknown') return { problem: null, limitation: 'csp-truncated' };
  if (framing === 'restricts') return { problem: null, limitation: null };

  const csp = headerValues(h, 'content-security-policy');
  const metaCsp = doc.metaHttpEquiv
    .filter((m) => m.name.toLowerCase() === 'content-security-policy')
    .map((m) => m.value);
  const problem: Problem = {
    variant: 'anti-framing-missing',
    mechanism: 'anti-framing',
    evidence: [
      { name: 'x-frame-options', value: xfo || null },
      ...(csp.length > 0 ? [{ name: 'content-security-policy', value: csp.join(', ') }] : []),
    ],
    params: { hint: cspRestrictsFraming(metaCsp) ? 'meta-csp' : 'none' },
  };
  return { problem, limitation: null };
}

/** No Referrer-Policy at all, or one that leaks the full URL. A `<meta name=referrer>` wins over the header. */
function referrerProblem(doc: DocumentResponse): Problem | null {
  const fromHeader = headerValues(doc.headers, 'referrer-policy');
  const referrer = doc.metaReferrer
    ? (effectiveReferrerPolicy([doc.metaReferrer]) ?? effectiveReferrerPolicy(fromHeader))
    : effectiveReferrerPolicy(fromHeader);

  if (referrer === null) return headerMissing('referrer-policy', fromHeader.join(', ') || null);
  if (!UNSAFE_REFERRER.has(referrer)) return null;
  return {
    variant: 'referrer-policy-permissive',
    mechanism: 'referrer-policy',
    evidence: [{ name: 'referrer-policy', value: referrer }],
    params: { policy: referrer },
  };
}

/** CSP (enforcing, report-only or meta), `nosniff` and Permissions-Policy: each missing header is its own finding. */
function missingHeaderProblems(doc: DocumentResponse): Problem[] {
  const h = doc.headers;
  const out: Problem[] = [];

  const anyCsp =
    headerValues(h, 'content-security-policy').some(nonBlank) ||
    headerValues(h, 'content-security-policy-report-only').some(nonBlank) ||
    doc.metaHttpEquiv.some((m) => m.name.toLowerCase() === 'content-security-policy' && nonBlank(m.value));
  if (!anyCsp) out.push(headerMissing('content-security-policy', null));

  const nosniff = headerValues(h, 'x-content-type-options')[0];
  if (nosniff?.trim().toLowerCase() !== 'nosniff') {
    out.push(headerMissing('x-content-type-options', nosniff ?? null));
  }

  if (!headerValues(h, 'permissions-policy').some(nonBlank)) {
    out.push(headerMissing('permissions-policy', null));
  }
  return out;
}

function problemsOf(doc: DocumentResponse): { problems: Problem[]; limitations: string[] } {
  const antiFraming = antiFramingProblem(doc);
  const problems = [
    hstsProblem(doc),
    antiFraming.problem,
    referrerProblem(doc),
    ...missingHeaderProblems(doc),
  ].filter((p): p is Problem => p !== null);
  return { problems, limitations: antiFraming.limitation ? [antiFraming.limitation] : [] };
}

function headerMissing(mechanism: string, value: string | null): Problem {
  return {
    variant: 'header-missing',
    mechanism,
    evidence: [{ name: mechanism, value }],
    params: { header: HEADER_NAMES[mechanism] ?? mechanism, mechanism },
  };
}

function evaluable(doc: DocumentResponse): boolean {
  return (
    !doc.error && isSuccess(doc.status) && browserAcceptsTls(doc.tlsAuthorized, doc.tlsAuthorizationError)
  );
}

/** The start page decides whether the headers can be judged at all; null when they can. */
function startPageOutcome(start: DocumentResponse): CheckOutcome | null {
  if (start.error || start.status === null) {
    return {
      status: 'inconclusive',
      reason: start.error?.code === 'timeout' ? 'timeout' : 'start-page-unavailable',
      observations: [],
    };
  }
  if (!isSuccess(start.status)) {
    return {
      status: 'inconclusive',
      reason: 'start-page-status',
      limitations: [`status:${start.status}`],
      observations: [],
    };
  }
  if (!browserAcceptsTls(start.tlsAuthorized, start.tlsAuthorizationError)) {
    return { status: 'inconclusive', reason: 'tls-invalid', observations: [] };
  }
  return null;
}

/** One observation per (variant, mechanism); a repeat on another page adds the page and its evidence. */
function addProblem(byMechanism: Map<string, Observation>, page: string, p: Problem): void {
  const evidence: EvidenceInput[] = p.evidence.map((e) => ({
    type: 'header',
    phase: 'http',
    page,
    url: page,
    name: e.name,
    present: e.value !== null,
    value: evidenceValue(e.value),
  }));

  const key = `${p.variant}|${p.mechanism}`;
  const existing = byMechanism.get(key);
  if (existing) {
    if (!existing.pages.includes(page)) existing.pages.push(page);
    existing.evidence.push(...evidence);
    existing.params.count = existing.pages.length;
    return;
  }

  byMechanism.set(key, {
    checkId: ID,
    variant: p.variant,
    confidence: 'high',
    subject: subjects.header(p.mechanism),
    phases: ['http'],
    pages: [page],
    evidence,
    params: { url: page, count: 1, ...p.params },
  });
}

export const hdr01 = defineCheck({
  id: ID,
  module: 'http',
  requires: ['http'],
  variants: [
    { variant: 'hsts-missing' },
    { variant: 'anti-framing-missing' },
    { variant: 'referrer-policy-permissive' },
    { variant: 'header-missing' },
  ],
  run(slice) {
    const docs = slice.http.documents;
    const start = docs.find((d) => d.role === 'start');
    if (!start) throw new Error('http section has no start document');
    const unusable = startPageOutcome(start);
    if (unusable) return unusable;

    const evaluated = docs.filter(evaluable);
    const limitations = docs.filter((d) => !evaluable(d)).map((d) => `document-unavailable:${d.role}`);
    if (slice.http.throttled) limitations.push('throttled');

    const byMechanism = new Map<string, Observation>();
    for (const doc of evaluated) {
      const { problems, limitations: docLimitations } = problemsOf(doc);
      limitations.push(...docLimitations);
      for (const p of problems) addProblem(byMechanism, doc.finalUrl, p);
    }

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations: [...new Set(limitations)] } : {}),
      observations: [...byMechanism.values()],
      coverage: { planned: docs.length, evaluated: evaluated.length },
    };
  },
});
