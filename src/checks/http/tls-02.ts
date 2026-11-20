/**
 * TLS-02: certificate of the target host and its www/apex variant (port 443 or the explicit https port), plus the final
 * host of a redirect to another domain. A handshake without a cause is inconclusive, not a finding.
 */

import {
  type CheckContext,
  type CheckThresholds,
  defineCheck,
  type EvidenceInput,
  type Observation,
  subjects,
  tlsHostRole,
} from '../../core/api.ts';
import type { TlsEndpoint } from '../../core/snapshot/tls.ts';
import { DAY_MS, startFinalHost, type TlsProblem, tlsProblemOf } from './shared.ts';

const ID = 'TLS-02';

/** `names` in the finding lists at most this many certificate names. */
const MAX_SAN_NAMES = 5;
/** Longest DNS name (RFC 1035): a CN is external text and is cut there. */
const MAX_NAME_LENGTH = 253;

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

type NameSource = 'san' | 'cn' | 'none';

/**
 * The names the certificate is issued for. Browsers match the host only against the subject alternative names; a
 * certificate without them (typical for a hoster's self-signed default) is named by its CN so the text is not empty.
 */
function certificateNames(ep: TlsEndpoint): { names: string; nameSource: NameSource } {
  const leaf = ep.chain[0];
  const san = (leaf?.subjectAltNames ?? []).map((n) => n.replace(/^(DNS|IP Address):/i, ''));
  if (san.length > 0) {
    const names =
      san.length > MAX_SAN_NAMES ? `${san.slice(0, MAX_SAN_NAMES).join(', ')}, …` : san.join(', ');
    return { names, nameSource: 'san' };
  }
  const cn = /(?:^|,\s*)CN=([^,]+)/.exec(leaf?.subject ?? '')?.[1]?.trim();
  return cn ? { names: cn.slice(0, MAX_NAME_LENGTH), nameSource: 'cn' } : { names: '–', nameSource: 'none' };
}

interface Problems {
  invalid: InvalidCause[];
  chainIncomplete: boolean;
  expiry: 'certificate-expiring' | 'certificate-expiry-approaching' | null;
}

/** Distinguished names from the same formatter; compared without case and edge whitespace. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Warns of a certificate that is running out, measured against its own lifetime; short-lived ones never warn. */
function expiryOf(
  notBefore: number,
  notAfter: number,
  now: Date,
  t: CheckThresholds['tls'],
): Problems['expiry'] {
  const lifetime = notAfter - notBefore;
  if (!Number.isFinite(lifetime) || lifetime <= t.shortLivedDays * DAY_MS) return null;

  const left = notAfter - now.getTime();
  if (left < Math.min(t.expiringDays * DAY_MS, t.expiringLifetimeShare * lifetime)) {
    return 'certificate-expiring';
  }
  if (left < Math.min(t.approachingDays * DAY_MS, t.approachingLifetimeShare * lifetime)) {
    return 'certificate-expiry-approaching';
  }
  return null;
}

function problemsOf(ep: TlsEndpoint, now: Date, t: CheckThresholds['tls']): Problems {
  const leaf = ep.chain[0];
  const notBefore = leaf ? Date.parse(leaf.notBefore) : Number.NaN;
  const notAfter = leaf ? Date.parse(leaf.notAfter) : Number.NaN;
  const fromNode = tlsProblemOf(ep.authorizationError);

  const causes = new Set<InvalidCause>();
  if (fromNode && fromNode !== 'incomplete-chain') causes.add(fromNode);
  if (notAfter < now.getTime()) causes.add('expired');
  if (notBefore > now.getTime()) causes.add('not-yet-valid');
  if (ep.hostnameMatches === false) causes.add('name-mismatch');
  if (leaf?.selfSigned && ep.chain.length === 1 && fromNode !== null) causes.add('self-signed');

  // The validator did not find an issuer. When the server did send the issuer of the leaf, the intermediate is not
  // missing: the chain ends at a root the store does not know (private CA, root newer than the bundle).
  const issuerNotFound = !ep.authorized && fromNode === 'incomplete-chain';
  const issuerSent = leaf !== undefined && ep.chain.slice(1).some((c) => sameName(c.subject, leaf.issuer));
  if (issuerNotFound && issuerSent) causes.add('untrusted-root');
  const chainIncomplete = issuerNotFound && ep.chainComplete === false && !issuerSent;

  const expiry = causes.size === 0 ? expiryOf(notBefore, notAfter, now, t) : null;
  return { invalid: CAUSES.filter((c) => causes.has(c)), chainIncomplete, expiry };
}

/** Endpoint label for limitations: `www`, or `final-www` for the final host's group. */
function label(ep: TlsEndpoint): string {
  return ep.role ? `${ep.role}-${ep.hostVariant}` : ep.hostVariant;
}

/** `reason` is the first cause, `reasons` all of them; every cause also has a yes/no param for the text. */
function invalidParams(ep: TlsEndpoint, invalid: readonly InvalidCause[]): Observation['params'] {
  const has = (c: InvalidCause) => (invalid.includes(c) ? 'yes' : 'no');
  return {
    reason: invalid[0] as InvalidCause,
    reasons: invalid.join(','),
    expired: has('expired'),
    notYetValid: has('not-yet-valid'),
    nameMismatch: has('name-mismatch'),
    selfSigned: has('self-signed'),
    untrustedRoot: has('untrusted-root'),
    otherError: has('invalid'),
    ...certificateNames(ep),
    error: ep.authorizationError ?? '–',
    trustStore: ep.trustStore,
  };
}

/** The findings about the certificate of one endpoint that completed its handshake. */
function certificateObservations(ep: TlsEndpoint, roleBase: string, ctx: CheckContext): Observation[] {
  const leaf = ep.chain[0];
  const notAfter = leaf ? Date.parse(leaf.notAfter) : Number.NaN;
  const params = {
    host: ep.host,
    notAfter: leaf?.notAfter.slice(0, 10) ?? null,
    daysLeft: Number.isFinite(notAfter) ? Math.floor((notAfter - ctx.now.getTime()) / DAY_MS) : null,
    lifetimeDays: lifetimeDaysOf(ep),
    issuer: leaf?.issuer ?? null,
  };
  // Relative to the final host, so independent of how the target was typed.
  const subject = subjects.tlsEndpoint('certificate', tlsHostRole(ep.host, roleBase));

  const observations: Observation[] = [];
  const emit = (variant: string, extra: Observation['params'] = {}) => {
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
  };

  const p = problemsOf(ep, ctx.now, ctx.thresholds.tls);
  if (p.invalid.length > 0) emit('certificate-invalid', invalidParams(ep, p.invalid));
  if (p.chainIncomplete) emit('chain-incomplete');
  if (p.expiry) emit(p.expiry);
  return observations;
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
    const endpoints = [...own, ...(slice.http.finalTls ?? [])];

    const finalHost = startFinalHost(slice.http);
    // Roles relative to the final host of the HTTP start chain (the hosts whose certificates were probed), else the
    // final host of the scan, else the target.
    const roleBase = finalHost ?? slice.target.finalHost ?? slice.target.host;
    const limitations: string[] = [];
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
      observations.push(...certificateObservations(ep, roleBase, ctx));
    }

    if (targetUndecided) {
      // The reason is `handshake-inconclusive`; how it ended is a limitation.
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
