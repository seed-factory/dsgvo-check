/**
 * Derived classification. Pure function of the snapshot + catalog data; recomputed on `--from-snapshot`
 * and never persisted.
 */
import type { BrowserPhase, SanitizedUrl } from '../core/snapshot-common.ts';

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
  /** Error/performance monitoring (Sentry …); added by M3, routed to CONSENT-01 as "remainder". */
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

/** TRACK-01 stages. */
export type TrackingStage = 'loaded' | 'initialised' | 'event-sent';

/**
 * 5.3 `identifier.kind`. Persistent (critical-capable): `stored-match` (the value matched a stored cookie/storage
 * value in memory, or a known tracking cookie was sent), `persistent-param` (a parameter the catalog signature names
 * as identifier, non-empty before redaction), `user-supplied` (user or ad-click id such as `user_id`, `gclid`).
 * `per-load`: an identifier name was present but persistence is not evidenced; `none`: no identifier.
 */
export type IdentifierKind = 'stored-match' | 'persistent-param' | 'user-supplied' | 'per-load' | 'none';

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

/** Catalog entry fields needed by checks. */
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

export type ClassificationSource =
  | 'catalog'
  | 'third-party-web'
  | 'open-cookie-database'
  | 'heuristic'
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
  /** TRACK-01 stage this request proves (only for catalog matches). */
  stage?: TrackingStage;
  /** Map/video integration type, e.g. `iframe`, `js-api`, `static`, `tiles`. */
  integration?: string;
  /**
   * A persistent identifier is evidenced (`identifierKind` stored-match / persistent-param / user-supplied).
   * Never inferred from a query key in the redacted URL: only from collector facts extracted before redaction.
   */
  identifier?: boolean;
  /** 5.3 `identifier.kind`; see IdentifierKind. */
  identifierKind?: IdentifierKind;
  /** Name of the parameter or cookie that carried the identifier (never its value). */
  identifierParam?: string;
  consentMode?: ConsentModeSignal | null;
  /** Consent Mode says the storage relevant for this service was denied (cookieless ping). */
  cookieless?: boolean;
  /**
   * 5.3 `delivery: sent` and `result: response` over the network (not SW/cache). Independent of a later body error
   * that ends the record in `state: failed`.
   */
  delivered?: boolean;
  /** The resource reached the page: network response, service worker or cache (TRACK-01 stages). */
  loaded?: boolean;
  timing?: InteractionTiming;
  /** Matched on the site's own host for a self-hostable service (no third party involved). */
  selfHosted?: boolean;
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
  state: 'attempted' | 'accepted' | 'rejected' | 'sent';
  afterClick: boolean;
  serviceId: string | null;
  category: ServiceCategory;
  /** Known tracking identifier (`_ga`, `_fbp`, …). */
  tracking: boolean;
  /** Allowlisted (consent cookie, session, LB, CSRF, language) → "nicht bewertet (Allowlist vX)". */
  allowlisted: boolean;
  persistent: boolean;
  thirdParty: boolean;
  source: ClassificationSource;
  /** Allowlist class: consent, session, load-balancer, csrf, language, security. */
  allowlistClass?: string;
  /** Registrable domain of the cookie domain. */
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
  /** Registrable domain of the storage origin. */
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

/** Aggregate per service across phases (inventory for TRACK-01 / PRIV-01). */
export interface ServiceObservation {
  serviceId: string;
  category: ServiceCategory;
  phases: BrowserPhase[];
  pages: SanitizedUrl[];
  requestIds: string[];
  cookieNames: string[];
  /** TRACK-01 stages. */
  stages: Array<'loaded' | 'initialised' | 'event-sent'>;
  identifierSeen: boolean;
  timings?: InteractionTiming[];
  /** At least one request of the service completed with a response. */
  delivered?: boolean;
  firstPartyProxy?: boolean;
}

/** External/vendored dataset used for classification (report `datasets[]`, 5.6). */
export interface DatasetRef {
  name: string;
  version: string | null;
  date?: string | null;
  sha256?: string | null;
  license: string;
  /** Attribution text (5.8), required for CC BY sources. */
  attribution?: string | null;
}

export interface DerivedSection {
  /** Catalog version used; null if no catalog loaded. */
  catalogVersion: string | null;
  /** Datasets used (service catalog, third-party-web, Open Cookie Database…). */
  datasets: DatasetRef[];
  target: { host: string; etld1: string | null };
  requests: ClassifiedRequest[];
  cookies: ClassifiedCookie[];
  storage: ClassifiedStorage[];
  services: ServiceObservation[];
  /** Catalog entries referenced by `services` (lookup for checks). */
  catalog: Record<string, ServiceInfo>;
  /** Connection/preload hints (EMBED-01 "preconnect only"). */
  hints?: ClassifiedHint[];
  /** Registrable domains treated as first party (final host and input host). */
  firstPartyEtld1s?: string[];
  /** Version of the cookie/storage allowlist ("nicht bewertet (Allowlist vX)"). */
  allowlistVersion?: string | null;
}
