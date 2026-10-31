/**
 * HDR-01 (consensus §4, D19): security headers of the main documents (start page, Impressum, Datenschutz) after
 * redirects. One observation per mechanism; pages where it is missing are united. Variant names: registry
 * docs/03-checks.md §2.1.
 * warning: no (effective) HSTS (https only), no anti-framing (X-Frame-Options or `frame-ancestors` in a CSP
 * *header*), Referrer-Policy `unsafe-url` / `no-referrer-when-downgrade`. info (`header-missing`, one per header):
 * no CSP, no nosniff, no Permissions-Policy, no Referrer-Policy.
 */

import type { DocumentResponse } from '../../collectors/http/types.ts';
import {
  cspFrameAncestors,
  defineCheck,
  type EvidenceInput,
  type HeaderRecord,
  MAX_HEADER_VALUE,
  type Observation,
  subjects,
} from '../../core/api.ts';
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
  /** Mechanism key = fingerprint subject. */
  mechanism: string;
  evidence: { name: string; value: string | null }[];
  params?: Record<string, string>;
}

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

/**
 * A CSP header (several policies may be comma-joined) restricts framing when one policy has frame-ancestors
 * without a wildcard source (`frame-ancestors * https://a.example` still allows everybody).
 */
function cspRestrictsFraming(values: readonly string[]): boolean {
  return values.some((v) => cspFrameAncestors(v).restricts);
}

/**
 * What the enforced CSP headers say about framing. The collector stores the fact next to a value of the limit length
 * or longer (G42, R12); such a value without it (snapshot of an older version) proves nothing about the directive:
 * `unknown`.
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

function problemsOf(doc: DocumentResponse): { problems: Problem[]; limitations: string[] } {
  const out: Problem[] = [];
  const limitations: string[] = [];
  const h = doc.headers;
  const https = doc.finalUrl.startsWith('https:');

  if (https) {
    const hsts = headerValues(h, 'strict-transport-security')[0];
    if (hsts === undefined) {
      out.push({
        variant: 'hsts-missing',
        mechanism: 'strict-transport-security',
        evidence: [{ name: 'strict-transport-security', value: null }],
        params: { problem: 'absent' },
      });
    } else {
      // A header without effect (no max-age, max-age=0) leaves the response without HSTS.
      const parsed = parseHsts(hsts.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] ?? '');
      if (!parsed.ok) {
        out.push({
          variant: 'hsts-missing',
          mechanism: 'strict-transport-security',
          evidence: [{ name: 'strict-transport-security', value: hsts }],
          params: { problem: parsed.problem },
        });
      }
    }
  }

  const xfo = headerValues(h, 'x-frame-options').join(',');
  const xfoValues = new Set(xfo.split(',').map((value) => value.trim().toLowerCase()));
  const xfoOk =
    [...xfoValues].some((value) => value === 'deny' || value === 'sameorigin') ||
    (xfoValues.size > 1 && xfoValues.has('allowall'));
  const csp = headerValues(h, 'content-security-policy');
  const framing = xfoOk
    ? 'open'
    : cspFraming(h.filter((r) => r.name.toLowerCase() === 'content-security-policy'));
  // A cut CSP without the derived fact may still hold the directive: no finding on a guess (G42).
  if (!xfoOk && framing === 'unknown') limitations.push('csp-truncated');
  if (!xfoOk && framing === 'open') {
    const metaCsp = doc.metaHttpEquiv
      .filter((m) => m.name.toLowerCase() === 'content-security-policy')
      .map((m) => m.value);
    out.push({
      variant: 'anti-framing-missing',
      mechanism: 'anti-framing',
      evidence: [
        { name: 'x-frame-options', value: xfo || null },
        ...(csp.length > 0 ? [{ name: 'content-security-policy', value: csp.join(', ') }] : []),
      ],
      params: { hint: cspRestrictsFraming(metaCsp) ? 'meta-csp' : 'none' },
    });
  }

  const referrer = doc.metaReferrer
    ? (effectiveReferrerPolicy([doc.metaReferrer]) ??
      effectiveReferrerPolicy(headerValues(h, 'referrer-policy')))
    : effectiveReferrerPolicy(headerValues(h, 'referrer-policy'));
  if (referrer === null) {
    out.push(headerMissing('referrer-policy', headerValues(h, 'referrer-policy').join(', ') || null));
  } else if (UNSAFE_REFERRER.has(referrer)) {
    out.push({
      variant: 'referrer-policy-permissive',
      mechanism: 'referrer-policy',
      evidence: [{ name: 'referrer-policy', value: referrer }],
      params: { policy: referrer },
    });
  }

  const anyCsp =
    csp.some((v) => v.trim() !== '') ||
    headerValues(h, 'content-security-policy-report-only').some((v) => v.trim() !== '') ||
    doc.metaHttpEquiv.some(
      (m) => m.name.toLowerCase() === 'content-security-policy' && m.value.trim() !== '',
    );
  if (!anyCsp) out.push(headerMissing('content-security-policy', null));

  const nosniff = headerValues(h, 'x-content-type-options')[0];
  if (nosniff?.trim().toLowerCase() !== 'nosniff')
    out.push(headerMissing('x-content-type-options', nosniff ?? null));

  if (!headerValues(h, 'permissions-policy').some((v) => v.trim() !== '')) {
    out.push(headerMissing('permissions-policy', null));
  }
  return { problems: out, limitations };
}

/** `header-missing` (info): one finding per header, the subject is the header (mechanism). */
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

    const evaluated = docs.filter(evaluable);
    const limitations = docs.filter((d) => !evaluable(d)).map((d) => `document-unavailable:${d.role}`);
    if (slice.http.throttled) limitations.push('throttled');

    // One observation per (variant, mechanism): `header-missing` covers several headers.
    const byMechanism = new Map<string, Observation>();
    for (const doc of evaluated) {
      const page = doc.finalUrl;
      const { problems, limitations: docLimitations } = problemsOf(doc);
      limitations.push(...docLimitations);
      for (const p of problems) {
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
          continue;
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
    }

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations: [...new Set(limitations)] } : {}),
      observations: [...byMechanism.values()],
      coverage: { planned: docs.length, evaluated: evaluated.length },
    };
  },
});
