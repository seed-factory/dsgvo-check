/**
 * Fingerprint: "sha256:" + hex(sha256(JCS({v: 1, checkId, variantGroup, subject}))). Target host, pages, phase, time,
 * query, values, message text and severity are not part of it.
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

/** Subject builders; use them so subjects stay stable across modules. */
export const subjects = {
  /** CONSENT-01/05/06, TRACK-01, EMBED-*, PRIV-01: serviceId, unknown hosts → `unknown:<eTLD+1 of third party>`. */
  service(serviceId: string | null, thirdPartyEtld1?: string | null): string {
    if (serviceId) return serviceId;
    return `unknown:${(thirdPartyEtld1 ?? 'unknown').toLowerCase()}`;
  },
  /**
   * EMBED-01 fonts of an embed's frame: the font service scoped by the embed (`google-fonts@google-maps`), so they
   * never share a fingerprint with the fonts the site itself loads from that service.
   */
  embedResource(serviceId: string, embedServiceId: string): string {
    return `${serviceId}@${embedServiceId}`;
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
  /** HDR-02 version headers: header name and `product/version` (lower-case); another version is another subject. */
  versionHeader(name: string, product: string, version: string): string {
    return `${name}|${product}/${version}`.toLowerCase();
  },
  /**
   * MAIL-*, DNS-01: record kind, e.g. `dmarc`, `spf`. A further mail domain adds its scope (`final`,
   * `contact:<domain>`), so its finding is not merged with the scanned domain's; the scanned domain keeps the bare kind.
   */
  record(kind: string, scope?: string): string {
    return scope ? `${kind.toLowerCase()}@${scope.toLowerCase()}` : kind.toLowerCase();
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
   * TLS-01 links to http: the linked host as its labels below the registrable domain (`www`, `work`, `@` for the
   * registrable domain itself), so the fingerprint does not name the site.
   */
  httpLink(label: string): string {
    return `http-link:${label.toLowerCase()}`;
  },
  /** TLS-01 (`http-entry:<role>`) and TLS-02 (`certificate:<role>`), role relative to the final host. */
  tlsEndpoint(kind: 'http-entry' | 'certificate', role: TlsHostRole): string {
    return `${kind}:${role}`;
  },
} as const;

/** Host role for TLS subjects: `final` = final host of the start page, `pair` = the other host of its www/apex pair; other hosts are named by kind (`www`, `apex`). */
export type TlsHostRole = 'final' | 'pair' | 'www' | 'apex';

export function tlsHostRole(host: string, finalHost: string): TlsHostRole {
  const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');
  const h = norm(host);
  const f = norm(finalHost);
  if (h === f) return 'final';
  if (h === `www.${f}` || f === `www.${h}`) return 'pair';
  return h.startsWith('www.') ? 'www' : 'apex';
}
