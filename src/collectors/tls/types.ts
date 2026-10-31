/**
 * TLS collector output (owner: M4). Initial version by the scaffold; owners may only ADD optional fields.
 * 5.3 `tls` evidence; research http-dns-tls-mail §2.1 (node:tls + X509Certificate.checkHost).
 */
import type { CollectorError, IsoTimestamp } from '../../core/snapshot-common.ts';
import type { HostVariant } from '../http/types.ts';

export interface CertificateInfo {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  notBefore: IsoTimestamp;
  notAfter: IsoTimestamp;
  serialNumber: string;
  fingerprint256: string;
  isCa: boolean;
  selfSigned: boolean;
  keyType?: string;
  keyBits?: number;
}

export interface TlsEndpoint {
  id: string;
  /** Relative to the scanned host; for `role: 'final'` relative to the final host's registrable domain. */
  hostVariant: HostVariant;
  /**
   * `final`: the final host of a redirect to another registrable domain or its www/apex (recorded by the HTTP
   * collector in `HttpSection.finalTls`, S-19). Absent for the scanned host's variants.
   */
  role?: 'final';
  host: string;
  port: number;
  /** SNI sent. */
  servername: string;
  ip: string | null;
  family: 4 | 6 | null;
  outcome: 'handshake' | 'connection-refused' | 'timeout' | 'dns-error' | 'error';
  error?: CollectorError;
  protocol: string | null;
  cipher: string | null;
  authorized: boolean;
  /** Node `authorizationError`, e.g. CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, DEPTH_ZERO_SELF_SIGNED_CERT. */
  authorizationError: string | null;
  /** Result of our own `X509Certificate.checkHost(host)`; null when no certificate. */
  hostnameMatches: boolean | null;
  chainComplete: boolean | null;
  trustStore: 'node-bundled' | 'system' | 'test';
  /** Leaf first. */
  chain: CertificateInfo[];
  observedAt: IsoTimestamp;
}

export interface TlsSection {
  endpoints: TlsEndpoint[];
  errors: CollectorError[];
}
