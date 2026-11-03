/** HTTP collector output: passive class T probes with redacted header and redirect evidence. */
import type { CollectorError, HeaderRecord, IsoTimestamp, SanitizedUrl } from './common.ts';
import type { TlsEndpoint } from './tls.ts';

export type HostVariant = 'target' | 'www' | 'apex';

export interface HttpHop {
  url: SanitizedUrl;
  status: number | null;
  /** Sanitized `Location` header (absolute). */
  location?: SanitizedUrl;
  /** Response headers; `set-cookie` values removed (names in `setCookieNames`). */
  headers: HeaderRecord[];
  setCookieNames: string[];
  connectedIp?: string | null;
  /** TLS protocol of the connection for https hops. */
  tlsProtocol?: string | null;
  /** https hops: Node's verdict for the connection (the collector connects with `rejectUnauthorized: false`); null when unknown (e.g. behind `--proxy`). */
  tlsAuthorized?: boolean | null;
  /** Node `authorizationError` of the connection (e.g. CERT_HAS_EXPIRED). */
  tlsAuthorizationError?: string | null;
  /** Bytes of body read (limited); body itself is not stored. */
  bodyBytes?: number;
  /** True when the body exceeded the read limit (`bodyBytes` is then a lower bound). */
  bodyTruncated?: boolean;
  bodyKind?: 'html' | 'other' | 'empty';
  /** Meta refresh / JS redirect target detected in a small HTML body. */
  clientRedirect?: { kind: 'meta' | 'js'; url: SanitizedUrl | null };
  /** HTML body has a form. */
  hasForm?: boolean;
  durationMs: number;
  requestedAt: IsoTimestamp;
}

/** One manual redirect chain (≤ 5 hops, no HSTS cache). */
export interface RedirectChain {
  id: string;
  hostVariant: HostVariant;
  host: string;
  scheme: 'http' | 'https';
  /** Explicit non-default port of the target URL: the chain loads the start document from that exact origin. Absent for the 80/443 probes. */
  port?: number;
  startUrl: SanitizedUrl;
  hops: HttpHop[];
  /** Last hop when the chain ended normally. */
  final: HttpHop | null;
  outcome:
    | 'ok'
    | 'redirect-limit'
    | 'connection-refused'
    | 'timeout'
    | 'tls-error'
    | 'dns-error'
    | 'throttled'
    | 'error';
  error?: CollectorError;
}

/** Main documents fetched for headers (start, Impressum, DSE). */
export interface DocumentResponse {
  role: 'start' | 'impressum' | 'privacy' | 'other';
  url: SanitizedUrl;
  finalUrl: SanitizedUrl;
  status: number | null;
  headers: HeaderRecord[];
  setCookieNames: string[];
  /** `<meta http-equiv>` values found in the HTML head (CSP meta is not counted for frame-ancestors). */
  metaHttpEquiv: HeaderRecord[];
  error?: CollectorError;
  /** `<meta name="referrer">` content; browsers honour it (unlike meta `frame-ancestors`). */
  metaReferrer?: string | null;
  /** TLS verdict of the final response when it was https (see `HttpHop.tlsAuthorized`). */
  tlsAuthorized?: boolean | null;
  tlsAuthorizationError?: string | null;
  /** Redirect chain that produced this document (start document: the target chain). */
  chainId?: string;
  /** How the URL was found: the scan target, or a link in the start page (Impressum / Datenschutz). */
  foundVia?: 'target' | 'link';
}

/** A probe the collector issued (written to `snapshot.plan.probes` too). */
export interface ProbeRecord {
  kind: 'http' | 'tls' | 'dns';
  /** Probe class: O = browser navigation, T = default passive probe. */
  class: 'O' | 'T';
  target: string;
  purpose: string;
}

export interface HttpSection {
  userAgent: string;
  chains: RedirectChain[];
  documents: DocumentResponse[];
  requestsIssued: number;
  /** A host answered 429/503 three times in a row and again after the Retry-After pause and one retry: probing of it stopped. */
  throttled: boolean;
  /** Hosts whose probing stopped (state is kept per host). */
  throttledHosts?: string[];
  /** TLS endpoints of the start page's final host after a redirect outside target/www/apex, and of its www/apex; the TLS collector runs before that host is known. */
  finalTls?: TlsEndpoint[];
  errors: CollectorError[];
}
