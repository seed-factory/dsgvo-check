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
  /** Plain-http success pages: the body has a form that takes input other than a site search. */
  hasForm?: boolean;
  /** Those forms in document order (at most 5); field names and values are never kept. Absent in older snapshots. */
  forms?: HttpFormFact[];
  /** How much of the body `hasForm` covers; absent where forms are not looked for (https, redirects, other statuses). */
  formInspection?: FormInspection;
  durationMs: number;
  requestedAt: IsoTimestamp;
}

/**
 * `complete`: the whole body was read; `truncated`: the body was cut at the read limit or by a failing stream, so a form
 * further on was not seen; `unavailable`: a `Content-Encoding` the collector does not decode, so no form was seen.
 */
export type FormInspection = 'complete' | 'truncated' | 'unavailable';

/** A form of a plain-http page as the HTTP collector read it from the markup. */
export interface HttpFormFact {
  /** Where the form sends its input, sanitized: its `action`, the page itself without one; null when not http(s). */
  action: SanitizedUrl | null;
  actionScheme: 'http' | 'https' | 'other';
  /** As a browser reads the attribute: a missing or unknown value is `get`. */
  method: 'get' | 'post' | 'dialog';
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
  /** A linked document whose final response came over plain http: the form facts of that response (`HttpHop`). */
  hasForm?: boolean;
  forms?: HttpFormFact[];
  formInspection?: FormInspection;
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
  /** The plain-http addresses of pages with a form, requested after the browser; absent when that step did not run. */
  twins?: HttpTwin[];
  formTwinStage?: FormTwinStage;
  errors: CollectorError[];
}

/**
 * The plain-http address of a page on which phase A saw a form, requested once with GET after the browser: no redirect
 * is followed and nothing is submitted. Only for a host whose http:// root served content without a redirect.
 */
export interface HttpTwin {
  /** The page as phase A visited it. */
  page: SanitizedUrl;
  /** Its http:// address as requested. */
  url: SanitizedUrl;
  /** The answer, with form facts when it is a plain-http success page; null when the request failed. */
  hop: HttpHop | null;
  outcome: 'ok' | 'connection-refused' | 'timeout' | 'tls-error' | 'dns-error' | 'throttled' | 'error';
  error?: CollectorError;
  /** A bot or WAF challenge answered instead of the page (test/data/browser/challenges.yaml): its body is not the site's. */
  challenge?: string;
}

/** The step that requested the twins. */
export interface FormTwinStage {
  /** `http.formTwinPages` of the run; 0 requests none. */
  budget: number;
  /** Pages whose http:// address was eligible (more than `budget` are not all requested); null when unknown. */
  candidates: number | null;
  durationMs: number;
  /** The step failed; the forms of further pages over http are then unknown. */
  error?: CollectorError;
}
