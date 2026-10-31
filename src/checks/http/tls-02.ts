/**
 * TLS-02 (consensus §4, D19): certificate of the target host and its www/apex variant (port 443, or the explicit
 * port of an https target, S-20), plus the final host of a redirect to another domain and its www/apex (recorded
 * by the HTTP collector, S-19). Variant names: registry docs/03-checks.md §2.1.
 * critical (`certificate-invalid`, one finding per endpoint listing every cause): expired / not yet valid, name
 * mismatch (own `checkHost`, also when Node stops at another error), self-signed, unknown root (also an issuer
 * Node did not find although the server sent the issuer of the leaf), other verification error. warning: incomplete
 * chain (`chain-incomplete`; the server did not send the issuer of the leaf; no AIA in Node, browsers complete it).
 * Expiry relative to lifetime L: < min(14 d, 25 % L) → `certificate-expiring` (warning), < min(30 d, 50 % L) →
 * `certificate-expiry-approaching` (info); no expiry finding when L ≤ 10 d. Closed port / no DNS → no finding;
 * handshake without a cause → inconclusive `handshake-inconclusive` (target) or a limitation (other endpoints).
 */

import type { TlsEndpoint } from '../../collectors/tls/types.ts';
import { defineCheck, type EvidenceInput, type Observation, subjects, tlsHostRole } from '../../core/api.ts';
import { DAY_MS, startFinalHost, type TlsProblem, tlsProblemOf } from './shared.ts';

const ID = 'TLS-02';
const SHORT_LIVED_MS = 10 * DAY_MS;

type InvalidCause = Exclude<TlsProblem, 'incomplete-chain'>;
/** Order of the causes in `reasons`; the first present one is `reason`. */
const CAUSES: readonly InvalidCause[] = [
  'expired',
  'not-yet-valid',
  'name-mismatch',
  'self-signed',
  'untrusted-root',
  'invalid',
];

function lifetimeDaysOf(ep: TlsEndpoint): number | null {
  const leaf = ep.chain[0];
  if (!leaf) return null;
  const ms = Date.parse(leaf.notAfter) - Date.parse(leaf.notBefore);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null;
}

function evidenceOf(ep: TlsEndpoint): EvidenceInput {
  const leaf = ep.chain[0];
  return {
    type: 'tls',
    phase: 'tls',
    host: ep.host,
    port: ep.port,
    ip: ep.ip,
    family: ep.family,
    protocol: ep.protocol,
    cipher: ep.cipher,
    issuer: leaf?.issuer ?? null,
    subject: leaf?.subject ?? null,
    san: leaf?.subjectAltNames ?? [],
    notBefore: leaf?.notBefore ?? null,
    notAfter: leaf?.notAfter ?? null,
    lifetimeDays: lifetimeDaysOf(ep),
    chainComplete: ep.chainComplete,
    hostnameMatches: ep.hostnameMatches,
    authorizationError: ep.authorizationError,
    trustStore: ep.trustStore,
  };
}

function sanNames(ep: TlsEndpoint): string {
  const names = (ep.chain[0]?.subjectAltNames ?? []).map((n) => n.replace(/^(DNS|IP Address):/i, ''));
  return names.length > 5 ? `${names.slice(0, 5).join(', ')}, …` : names.join(', ');
}

interface Problems {
  /** Causes of an invalid certificate, in `CAUSES` order. */
  invalid: InvalidCause[];
  chainIncomplete: boolean;
  expiry: 'certificate-expiring' | 'certificate-expiry-approaching' | null;
}

/** Distinguished names from the same formatter; compared without case and edge whitespace. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Problems of one endpoint after a completed handshake. */
function problemsOf(ep: TlsEndpoint, now: Date): Problems {
  const causes = new Set<InvalidCause>();
  const fromNode = tlsProblemOf(ep.authorizationError);
  const leaf = ep.chain[0];
  const notBefore = leaf ? Date.parse(leaf.notBefore) : Number.NaN;
  const notAfter = leaf ? Date.parse(leaf.notAfter) : Number.NaN;
  if (fromNode && fromNode !== 'incomplete-chain') causes.add(fromNode);
  if (notAfter < now.getTime()) causes.add('expired');
  if (notBefore > now.getTime()) causes.add('not-yet-valid');
  if (ep.hostnameMatches === false) causes.add('name-mismatch');
  if (leaf?.selfSigned && ep.chain.length === 1 && fromNode !== null) causes.add('self-signed');
  // The validator did not find an issuer. When the server did send the issuer of the leaf, the intermediate is not
  // missing: the chain ends at a root the store does not know (private CA, root newer than the bundle) (R20).
  const issuerNotFound = !ep.authorized && fromNode === 'incomplete-chain';
  const issuerSent = leaf !== undefined && ep.chain.slice(1).some((c) => sameName(c.subject, leaf.issuer));
  if (issuerNotFound && issuerSent) causes.add('untrusted-root');
  const chainIncomplete = issuerNotFound && ep.chainComplete === false && !issuerSent;

  let expiry: Problems['expiry'] = null;
  const lifetime = notAfter - notBefore;
  if (causes.size === 0 && Number.isFinite(lifetime) && lifetime > SHORT_LIVED_MS) {
    const left = notAfter - now.getTime();
    if (left < Math.min(14 * DAY_MS, 0.25 * lifetime)) expiry = 'certificate-expiring';
    else if (left < Math.min(30 * DAY_MS, 0.5 * lifetime)) expiry = 'certificate-expiry-approaching';
  }
  return { invalid: CAUSES.filter((c) => causes.has(c)), chainIncomplete, expiry };
}

/** Endpoint label for limitations: `www`, or `final-www` for the final host's group. */
function label(ep: TlsEndpoint): string {
  return ep.role ? `${ep.role}-${ep.hostVariant}` : ep.hostVariant;
}

export const tls02 = defineCheck({
  id: ID,
  module: 'http',
  requires: ['tls', 'http'],
  variants: [
    { variant: 'certificate-invalid' },
    { variant: 'chain-incomplete' },
    { variant: 'certificate-expiring', variantGroup: 'expiry' },
    { variant: 'certificate-expiry-approaching', variantGroup: 'expiry' },
  ],
  run(slice, ctx) {
    const own = slice.tls.endpoints.filter((e) => !e.role);
    const target = own.find((e) => e.hostVariant === 'target');
    if (!target) throw new Error('tls section has no endpoint for the target');
    const final = slice.http.finalTls ?? [];
    const endpoints = [...own, ...final];

    const limitations: string[] = [];
    const finalHost = startFinalHost(slice.http);
    // Roles relative to the final host of the HTTP start chain (the hosts whose certificates were probed), else the
    // final host of the scan, else the target.
    const roleBase = finalHost ?? slice.target.finalHost ?? slice.target.host;
    if (finalHost && !endpoints.some((e) => e.host.toLowerCase() === finalHost)) {
      limitations.push('final-host-not-probed');
    }

    const observations: Observation[] = [];
    let targetUndecided: 'handshake-timeout' | 'handshake-failed' | null = null;
    let handshakes = 0;
    for (const ep of endpoints) {
      if (ep.outcome === 'connection-refused' || ep.outcome === 'dns-error') continue;
      if (ep.outcome === 'timeout' || ep.outcome === 'error' || ep.chain.length === 0) {
        limitations.push(`undecided:${label(ep)}`);
        if (ep === target)
          targetUndecided = ep.outcome === 'timeout' ? 'handshake-timeout' : 'handshake-failed';
        continue;
      }
      handshakes++;
      const leaf = ep.chain[0];
      const notAfter = leaf ? Date.parse(leaf.notAfter) : Number.NaN;
      const params = {
        host: ep.host,
        notAfter: leaf?.notAfter.slice(0, 10) ?? null,
        daysLeft: Number.isFinite(notAfter) ? Math.floor((notAfter - ctx.now.getTime()) / DAY_MS) : null,
        lifetimeDays: lifetimeDaysOf(ep),
        issuer: leaf?.issuer ?? null,
      };
      // `certificate:<role>` relative to the final host (5.4): independent of how the target was typed (S-37).
      const subject = subjects.tlsEndpoint('certificate', tlsHostRole(ep.host, roleBase));
      const emit = (variant: string, extra: Observation['params'] = {}) =>
        observations.push({
          checkId: ID,
          variant,
          confidence: 'high',
          subject,
          phases: ['tls'],
          pages: [],
          evidence: [evidenceOf(ep)],
          params: { ...params, ...extra },
        });

      const p = problemsOf(ep, ctx.now);
      if (p.invalid.length > 0) {
        const has = (c: InvalidCause) => (p.invalid.includes(c) ? 'yes' : 'no');
        emit('certificate-invalid', {
          reason: p.invalid[0] as InvalidCause,
          reasons: p.invalid.join(','),
          expired: has('expired'),
          notYetValid: has('not-yet-valid'),
          nameMismatch: has('name-mismatch'),
          selfSigned: has('self-signed'),
          untrustedRoot: has('untrusted-root'),
          otherError: has('invalid'),
          names: sanNames(ep),
          error: ep.authorizationError ?? '–',
          trustStore: ep.trustStore,
        });
      }
      if (p.chainIncomplete) emit('chain-incomplete');
      if (p.expiry) emit(p.expiry);
    }

    if (targetUndecided) {
      // Registry §2.1: the reason is `handshake-inconclusive`; how it ended is a limitation.
      return {
        status: 'inconclusive',
        reason: 'handshake-inconclusive',
        limitations: [...limitations, targetUndecided],
        observations,
      };
    }
    if (handshakes === 0) {
      return {
        status: 'not_applicable',
        reason: 'no-https',
        ...(limitations.length > 0 ? { limitations } : {}),
        observations,
      };
    }
    if (limitations.length > 0) return { status: 'partial', limitations, observations };
    return observations;
  },
});
