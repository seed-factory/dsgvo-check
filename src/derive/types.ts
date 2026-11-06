/** Derived classification: a pure function of the snapshot and catalog data, recomputed on `--from-snapshot`, never persisted. */
import type { CookieState } from '../core/snapshot/browser.ts';
import type { BrowserPhase, SanitizedUrl } from '../core/snapshot/common.ts';

/** Catalog categories and check ownership for finding deduplication. */
export type ServiceCategory =
  | 'analytics'
  | 'ads'
  | 'session-recording'
  | 'tag-manager'
  | 'cdn'
  | 'payment'
  | 'consent-provider'
  | 'fonts'
  | 'maps'
  | 'video'
  | 'captcha'
  | 'widget'
  | 'social'
  | 'reviews'
  | 'chat'
  /** Error/performance monitoring (Sentry …), routed to CONSENT-01 as "remainder". */
  | 'monitoring'
  | 'unknown';

/** Moment of a browser observation relative to the consent interaction (TRACK-01 timing). */
export type InteractionTiming = 'before-interaction' | 'after-reject' | 'after-accept';

/** What a matched request is in the context of its service (catalog signature `kind`). */
export type RequestKind =
  | 'library'
  | 'config'
  | 'hit'
  | 'embed'
  | 'stylesheet'
  | 'font'
  | 'tile'
  | 'image'
  | 'resource';

export type TrackingStage = 'loaded' | 'initialised' | 'event-sent';

/**
 * `stored-match` (a parameter value equals a stored identifier), `sent-cookie` (the request carried a catalog tracking
 * cookie), `persistent-param` and `user-supplied` are persistent (critical-capable); `per-load` is an identifier name
 * without evidenced persistence.
 */
export type IdentifierKind =
  | 'stored-match'
  | 'sent-cookie'
  | 'persistent-param'
  | 'user-supplied'
  | 'per-load'
  | 'none';

/** Consent Mode state decoded from `gcs` / `gcd` (null = not present or not decodable). */
export interface ConsentModeSignal {
  adStorage: 'granted' | 'denied' | null;
  analyticsStorage: 'granted' | 'denied' | null;
  source: 'gcs' | 'gcd';
}

export interface Party {
  name: string;
  country: string | null;
}

export interface ServiceInfo {
  serviceId: string;
  name: string;
  category: ServiceCategory;
  policyRelevance: 'required' | 'optional' | 'none';
  provider?: Party;
  parent?: Party;
  dpfEntity?: { name: string; listed: boolean | null; checkedAt: string | null; source: string | null };
  aliasesDe?: string[];
  aliasesEn?: string[];
  /** Legal names of provider/parent and their spellings (PRIV-01 `company` level). */
  companyAliases?: string[];
  /** Hosts / domain suffixes of the service (PRIV-01 `domain` level). */
  domains?: string[];
  /** Category description terms de/en (PRIV-01 `category` level): category defaults plus service extras. */
  categoryTerms?: string[];
  /** The service may run on the site's own host (e.g. self-hosted Matomo): a first-party match is no proxy. */
  selfHostable?: boolean;
}

/**
 * `catalog`: a host, signature or name of the catalog; for a cookie or storage entry with `tracking: false` a known
 * entry of the service that is no identifier (`otherCookies`, `otherStorageKeys`). `heuristic`: the host that set it.
 * `embed-frame`: a request the frame of an embedded service made (see `ClassifiedRequest.frameServiceId`).
 */
export type ClassificationSource =
  | 'catalog'
  | 'third-party-web'
  | 'open-cookie-database'
  | 'heuristic'
  | 'embed-frame'
  | 'none';

export interface ClassifiedRequest {
  requestId: string;
  phase: BrowserPhase;
  host: string;
  etld1: string | null;
  thirdParty: boolean;
  /** First-party tracker proxy (sGTM, tag gateway) detected by path/params. */
  firstPartyProxy: boolean;
  serviceId: string | null;
  category: ServiceCategory;
  source: ClassificationSource;
  /** Catalog signature that matched (`<serviceId>:<signatureId>`), absent for a domain-only match. */
  signatureId?: string;
  kind?: RequestKind;
  stage?: TrackingStage;
  /** Map/video integration type (`iframe`, `js-api`, `static`, `tiles`). */
  integration?: string;
  /** A persistent identifier is evidenced: from collector facts extracted before redaction, never a query key. */
  identifier?: boolean;
  identifierKind?: IdentifierKind;
  /** Name of the parameter or cookie that carried the identifier (never its value). */
  identifierParam?: string;
  consentMode?: ConsentModeSignal | null;
  /** Consent Mode says the storage relevant for this service was denied (cookieless ping). */
  cookieless?: boolean;
  /** A network response arrived (not from a service worker or cache), even if a later body error ended the record. */
  delivered?: boolean;
  /** The resource reached the page: network response, service worker or cache. */
  loaded?: boolean;
  timing?: InteractionTiming;
  /** Matched on the site's own host for a self-hostable service (no third party involved). */
  selfHosted?: boolean;
  /**
   * The request came from the third-party frame of this embedded service (a video player, a map). With source
   * `embed-frame` the request itself is attributed to the embed: a font or a host of no other service.
   */
  frameServiceId?: string;
  /**
   * With source `embed-frame`: the catalog service the requested resource itself belongs to (Google Fonts for the
   * font of a map frame), so a check can name it while the embed keeps the request. Absent for a host of no service.
   */
  resourceServiceId?: string;
  /** Category of `resourceServiceId`. */
  resourceCategory?: ServiceCategory;
}

/** Key `(name, domain|first-party, path, partitionKey)` used to compare cookies across phases. */
export interface CookieKey {
  name: string;
  domain: string;
  firstParty: boolean;
  path: string;
  partitionKey: string | null;
}

export interface ClassifiedCookie {
  key: CookieKey;
  phase: BrowserPhase;
  state: CookieState;
  afterClick: boolean;
  serviceId: string | null;
  category: ServiceCategory;
  /** Known tracking identifier (`_ga`, `_fbp`, …). */
  tracking: boolean;
  /** Allowlisted (consent, session, LB, CSRF, language) → "nicht bewertet". */
  allowlisted: boolean;
  /** Expires after the browser session and not sooner than `browser.persistentCookieMinDays`. */
  persistent: boolean;
  thirdParty: boolean;
  source: ClassificationSource;
  allowlistClass?: string;
  etld1?: string | null;
  timing?: InteractionTiming;
}

export interface ClassifiedStorage {
  storageType: 'localStorage' | 'sessionStorage' | 'indexedDB';
  origin: string;
  key: string;
  phase: BrowserPhase;
  afterClick: boolean;
  serviceId: string | null;
  category: ServiceCategory;
  tracking: boolean;
  thirdParty: boolean;
  source: ClassificationSource;
  allowlisted?: boolean;
  allowlistClass?: string;
  /** localStorage / IndexedDB persist; sessionStorage does not. */
  persistent?: boolean;
  etld1?: string | null;
  timing?: InteractionTiming;
}

/** `<link rel=preconnect|dns-prefetch|preload|prefetch>` and `Link:` header hints of visited pages. */
export interface ClassifiedHint {
  phase: BrowserPhase;
  pageUrl: SanitizedUrl;
  rel: string;
  href: SanitizedUrl;
  host: string;
  thirdParty: boolean;
  serviceId: string | null;
  category: ServiceCategory;
}

/**
 * The names by which a policy may mention a catalog service: its name, its aliases and its companies. Every service of
 * the catalog whose mention in a policy matters, observed or not, so a check can tell which service a sentence is about
 * without reading the catalog files.
 */
export interface ServiceName {
  serviceId: string;
  name: string;
  category: ServiceCategory;
  /** German and English aliases, each once. */
  aliases: string[];
  /** Legal names of provider and parent and their spellings (as `ServiceInfo.companyAliases`). */
  companyAliases: string[];
  provider?: Party;
  parent?: Party;
}

/** Aggregate per service across phases (inventory for TRACK-01 / PRIV-01). */
export interface ServiceObservation {
  serviceId: string;
  category: ServiceCategory;
  phases: BrowserPhase[];
  pages: SanitizedUrl[];
  requestIds: string[];
  cookieNames: string[];
  stages: Array<'loaded' | 'initialised' | 'event-sent'>;
  identifierSeen: boolean;
  timings?: InteractionTiming[];
  delivered?: boolean;
  firstPartyProxy?: boolean;
}

/** External or vendored dataset used for classification (report `datasets[]`). */
export interface DatasetRef {
  name: string;
  version: string | null;
  date?: string | null;
  sha256?: string | null;
  license: string;
  /** Attribution text, required for CC BY sources. */
  attribution?: string | null;
}

export interface DerivedSection {
  catalogVersion: string | null;
  datasets: DatasetRef[];
  target: { host: string; etld1: string | null };
  requests: ClassifiedRequest[];
  cookies: ClassifiedCookie[];
  storage: ClassifiedStorage[];
  services: ServiceObservation[];
  /** Catalog entries referenced by `services` (lookup for checks). */
  catalog: Record<string, ServiceInfo>;
  /** Names of every catalog service of policy relevance `required` or `optional`, ordered by id. */
  serviceNames?: ServiceName[];
  /** Connection/preload hints (EMBED-01 "preconnect only"). */
  hints?: ClassifiedHint[];
  /** Registrable domains treated as first party (final host and input host). */
  firstPartyEtld1s?: string[];
  /** Version of the cookie/storage allowlist. */
  allowlistVersion?: string | null;
}
