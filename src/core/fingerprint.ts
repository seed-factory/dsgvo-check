/**
 * Fingerprint (5.4): "sha256:" + hex(sha256(JCS({v: 1, checkId, variantGroup, subject}))).
 * Not included: target host, pages, phase, time, query, values, message text, severity.
 */
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export const FINGERPRINT_VERSION = 1;

export interface FingerprintInput {
  checkId: string;
  variantGroup: string;
  subject: string;
}

export function fingerprint(input: FingerprintInput): string {
  const json = canonicalize({
    v: FINGERPRINT_VERSION,
    checkId: input.checkId,
    variantGroup: input.variantGroup,
    subject: input.subject,
  });
  if (json === undefined) throw new Error('fingerprint: canonicalization failed');
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

/** Subject builders for the table in 5.4. Use them so subjects stay stable across modules. */
export const subjects = {
  /** CONSENT-01/05/06, TRACK-01, EMBED-*, PRIV-01: serviceId, unknown hosts → `unknown:<eTLD+1 of third party>`. */
  service(serviceId: string | null, thirdPartyEtld1?: string | null): string {
    if (serviceId) return serviceId;
    return `unknown:${(thirdPartyEtld1 ?? 'unknown').toLowerCase()}`;
  },
  /** CONSENT-02, HDR-02: name + (`first-party` | third-party eTLD+1) + path + partitioned. */
  cookie(c: {
    name: string;
    firstParty: boolean;
    etld1: string | null;
    path: string;
    partitioned: boolean;
  }): string {
    const owner = c.firstParty ? 'first-party' : (c.etld1 ?? 'unknown').toLowerCase();
    return `${c.name}|${owner}|${c.path || '/'}|${c.partitioned ? 'partitioned' : 'unpartitioned'}`;
  },
  /** CONSENT-02 storage entries: storage type + key + party. */
  storage(s: { storageType: string; key: string; firstParty: boolean; etld1: string | null }): string {
    const owner = s.firstParty ? 'first-party' : (s.etld1 ?? 'unknown').toLowerCase();
    return `${s.storageType}|${s.key}|${owner}`;
  },
  /** HDR-01: header name (lower-case). */
  header(name: string): string {
    return name.toLowerCase();
  },
  /** MAIL-*, DNS-01: record kind, e.g. `dmarc`, `spf`. */
  record(kind: string): string {
    return kind.toLowerCase();
  },
  /** LEGAL-01: document type. */
  document(kind: 'impressum' | 'privacy'): string {
    return kind;
  },
  /** CONSENT-03, CONSENT-04. */
  consentUi(): string {
    return 'consent-ui';
  },
  /**
   * @deprecated Depends on how the target was typed (`example.de` vs `www.example.de`), so the same endpoint gets
   * different fingerprints. Use `tlsEndpoint(kind, tlsHostRole(host, finalHost))` (5.4).
   */
  tls(kind: string, hostVariant: 'target' | 'www' | 'apex'): string {
    return `${kind}|${hostVariant}`;
  },
  /** TLS-01 (`http-entry:<role>`) and TLS-02 (`certificate:<role>`), role relative to the final host (5.4). */
  tlsEndpoint(kind: 'http-entry' | 'certificate', role: TlsHostRole): string {
    return `${kind}:${role}`;
  },
} as const;

/**
 * Host role for TLS subjects (5.4): `final` = the final host of the start page, `pair` = the other host of its
 * www/apex pair. Hosts outside that pair (the target was another subdomain) are named by their kind, `www` or `apex`.
 */
export type TlsHostRole = 'final' | 'pair' | 'www' | 'apex';

export function tlsHostRole(host: string, finalHost: string): TlsHostRole {
  const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');
  const h = norm(host);
  const f = norm(finalHost);
  if (h === f) return 'final';
  if (h === `www.${f}` || f === `www.${h}`) return 'pair';
  return h.startsWith('www.') ? 'www' : 'apex';
}
