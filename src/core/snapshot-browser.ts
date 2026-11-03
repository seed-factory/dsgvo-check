/**
 * Browser collector output.
 * Raw redacted facts and plan, with a fresh persistent profile for each phase A/B/C.
 * Page selection keeps its reasons; document and evidence records never store cookie or storage values.
 */
import type {
  Box,
  BrowserPhase,
  CollectorError,
  HeaderRecord,
  IsoTimestamp,
  RelativeMs,
  SanitizedUrl,
  Viewport,
} from './snapshot-common.ts';

export type PageRole =
  | 'start'
  | 'impressum'
  | 'privacy'
  | 'contact'
  | 'nav'
  | 'legal-hop'
  | 'fallback'
  | 'config'
  | 'other';

export interface PlannedPage {
  url: SanitizedUrl;
  role: PageRole;
  /** Deterministic order of visiting in phase A (0 = start page). */
  order: number;
  /** Why the page was selected, e.g. `footer-link:impressum`, `keyword:kontakt`, `iframe-signal`, `sitemap`. */
  reasons: string[];
  source: 'start' | 'link' | 'sitemap' | 'fallback' | 'config' | 'hop';
  /** robots.txt verdict for additional pages (start and legal pages are always visited). */
  robotsAllowed?: boolean;
}

/** Decision about which first-layer button to press (`plan.click`). */
export interface ClickPlan {
  phase: 'B' | 'C';
  action: 'reject' | 'accept';
  /** null when no unambiguous element was found (then nothing is clicked). */
  target: {
    cmpId: string | null;
    name: string;
    role?: string;
    /** Internal locator used by the collector; never shown to users. */
    selector?: string;
    kindConfidence: 'high' | 'medium' | 'low';
  } | null;
  reason?: string;
}

export interface BrowserPlan {
  /** Phase A selection (≤ maxPages). */
  pages: PlannedPage[];
  /** B/C control selection: start + up to 2 pages chosen from A signals. */
  controlPages: PlannedPage[];
  click: { B?: ClickPlan; C?: ClickPlan };
}

export type DomRegion = 'header' | 'nav' | 'main' | 'footer' | 'banner' | 'aside' | 'other';

export interface LinkFact {
  /** Absolute, sanitized href; null for `#`, `javascript:` and empty hrefs (see `hrefKind`). */
  href: SanitizedUrl | null;
  hrefKind: 'http' | 'https' | 'fragment' | 'javascript' | 'mailto' | 'tel' | 'empty' | 'other';
  /** Visible text (trimmed, whitespace-collapsed, ≤ 200 chars). */
  text: string;
  /** Accessible name if it differs from text (aria-label, title, img alt). */
  accessibleName?: string;
  region: DomRegion;
  visible: boolean;
  inShadowDom: boolean;
  /** URL of the frame containing the link when not the main frame. */
  frameUrl?: SanitizedUrl;
  /** Same registrable domain as the target. */
  sameSite?: boolean;
  rel?: string;
}

export interface FormFact {
  action: SanitizedUrl | null;
  actionScheme: 'http' | 'https' | 'none' | 'other';
  method: string;
  visible: boolean;
  fieldCount: number;
  hasPasswordField: boolean;
  hasEmailField: boolean;
  frameUrl?: SanitizedUrl;
}

export interface IframeFact {
  src: SanitizedUrl | null;
  srcdoc: boolean;
  title?: string;
  visible: boolean;
  box?: Box | null;
  loading?: 'lazy' | 'eager';
  /** Frame depth (1 = direct child of the main frame). */
  depth: number;
}

/** `<link rel=…>` and HTTP `Link:` header entries (preconnect, dns-prefetch, preload, stylesheet…). */
export interface LinkRelFact {
  rel: string;
  href: SanitizedUrl;
  as?: string;
  source: 'dom' | 'header';
}

export interface ScriptFact {
  src: SanitizedUrl | null;
  inline: boolean;
  type?: string;
  async?: boolean;
  defer?: boolean;
}

export interface DomFacts {
  title?: string;
  lang?: string;
  links: LinkFact[];
  forms: FormFact[];
  iframes: IframeFact[];
  linkRels: LinkRelFact[];
  scripts: ScriptFact[];
  metaRefresh?: { url: SanitizedUrl | null; delaySec: number };
  /** Text length of the visible body (for soft-404 / empty page heuristics). */
  visibleTextLength?: number;
  /** Two-click / content-blocker placeholders (control page signal; EMBED-* "no load" cases). */
  embedPlaceholders?: Array<{ kind: 'maps' | 'video' | 'other'; text: string }>;
  /** Text of the first `<h1>` (≤ 200 chars). */
  h1?: string;
  /**
   * Set (only then) when the page has more links than were collected (cap `maxLinks`): the list is not the whole
   * page, so a missing legal link on it proves nothing (LEGAL-01: limitation, not "missing").
   */
  linksTruncated?: boolean;
}

export interface ChallengeFacts {
  detected: boolean;
  kind?: 'cloudflare' | 'akamai' | 'captcha' | 'waf-block' | 'http-403' | 'other';
  /** Signals found, e.g. `title:Just a moment`, `cf-mitigated`, `status:403`. */
  signals: string[];
}

export interface NavigationFacts {
  /** HTTP status of the main document; null when navigation failed before a response. */
  status: number | null;
  ok: boolean;
  /** Net error, e.g. `net::ERR_NAME_NOT_RESOLVED`, `timeout`. */
  error?: string;
  redirectChain: SanitizedUrl[];
  startedAt: IsoTimestamp;
  domContentLoadedMs?: RelativeMs;
  loadMs?: RelativeMs;
  /** Quiet window reached before HARD_CAP (§1.4 of browser research). */
  quietReached: boolean;
  dwellMs: RelativeMs;
  pageLoadIncomplete?: boolean;
  /** IP that served the main document (Playwright `serverAddr`). */
  serverIp?: string | null;
}

export interface PageVisit {
  /** Requested URL (sanitized). */
  url: SanitizedUrl;
  finalUrl: SanitizedUrl;
  role: PageRole;
  order: number;
  phase: BrowserPhase;
  /** 5.3 `navigationId` of this visit; requests, cookies and storage of the visit carry the same id. */
  navigationId?: string;
  /** Only the start page in phase A is a "first visit"; others are "Folgeseite in derselben Sitzung". */
  firstVisit: boolean;
  navigation: NavigationFacts;
  /** Headers of the main document response (set-cookie values removed). */
  responseHeaders: HeaderRecord[];
  /** Names of cookies set by the main document response. */
  setCookieNames: string[];
  challenge: ChallengeFacts;
  /** false → page is in coverage as "nicht auswertbar". */
  evaluable: boolean;
  /** The visit is the reload of the start page after the B click (5.x CONSENT-05). */
  reload?: boolean;
  notEvaluableReason?: string;
  dom: DomFacts | null;
}

export type RequestState =
  | 'attempted'
  | 'blocked-by-browser'
  | 'completed'
  | 'failed'
  | 'from-sw'
  | 'from-cache';

export interface RequestRecord {
  /** Unique within the snapshot, e.g. `A-0042`. */
  id: string;
  phase: BrowserPhase;
  /** Page (top-level URL) during which the request started. */
  pageUrl: SanitizedUrl;
  frameUrl?: SanitizedUrl;
  isNavigation: boolean;
  isMainFrame: boolean;
  url: SanitizedUrl;
  /** Lower-case host of `url`. */
  host: string;
  method: string;
  /** Playwright resourceType: document, script, stylesheet, font, image, xhr, fetch, ping, media, … */
  resourceType: string;
  /** Start time of the request relative to `tRef` (legacy; 5.3 derives it from `atMs` and the ids). */
  tStartMs: RelativeMs;
  tRef: 'navigation' | 'click';
  /**
   * 5.3 `tMs`: start of the request in ms since the scan start, one monotonic scale for all phases and collectors.
   * Absent in older snapshots.
   */
  atMs?: number;
  /** 5.3 `navigationId`: the top-level navigation (or reload) during which the request started. */
  navigationId?: string;
  /** 5.3 `actionId?`: the B/C click after which the request started. */
  actionId?: string;
  /** 5.3 `frameId`: the frame that issued the request (absent for service-worker requests). */
  frameId?: string;
  /** 5.3 `parentRequestId?`: the request this one was redirected from. */
  parentRequestId?: string;
  /** 5.3 `features.parserVersion`: version of the collector's feature parser (`request-features/<n>`). */
  parserVersion?: string;
  /** 5.3 `features.observationSource`. */
  observationSource?: 'playwright' | 'cdp' | 'proxy-log';
  /** Started after the B/C click. */
  afterClick: boolean;
  state: RequestState;
  status?: number;
  failureText?: string;
  /** A user/device identifier parameter or cookie was present (value not stored). Extracted before redaction. */
  identifierPresent: boolean;
  /** Names of identifier params/cookies that triggered `identifierPresent`, e.g. `cid`, `_fbp`. */
  identifierNames?: string[];
  /** Safe semantic features extracted before redaction, e.g. GA4 `en=page_view`. */
  eventType?: string;
  consentSignals?: { gcs?: string; gcd?: string; npa?: string; dma?: string };
  initiator?: { type?: string; url?: SanitizedUrl };
  /**
   * The request was issued BY a service worker (its initiator). It says nothing about who answered it: delivery is
   * decided by `provenance` and `state`.
   */
  fromServiceWorker?: boolean;
  setCookieNames?: string[];
  connectedIp?: { value: string; origin: 'resolvedLocally' | 'upstream' | 'unknown' };
  /** Blocked by the SSRF guard (private/loopback/link-local/metadata address). */
  blockedByGuard?: boolean;
  /** 5.3 `delivery`: did the request leave the browser? */
  delivery?: 'attempted' | 'blocked-by-browser' | 'sent';
  /**
   * 5.3 `result`. A body error after the response keeps `response`; `aborted` = cancelled
   * (`ERR_ABORTED`) before any response.
   */
  result?:
    | { kind: 'response'; status: number }
    | { kind: 'failed'; errorText: string }
    | { kind: 'aborted' }
    | { kind: 'none' };
  /**
   * 5.3 `provenance`: who answered. The prototype records `network` and `service-worker`; `http-cache` and
   * `memory-cache` are in the schema and are treated as "not delivered" by derive (not distinguishable yet; unknown
   * → absent).
   */
  provenance?: 'network' | 'service-worker' | 'http-cache' | 'memory-cache';
  /**
   * An identifier value of this request equals or is contained in a cookie / Web Storage value of the same phase
   * (5.3 `identifier.kind: stored-match`). Compared in memory only; values are never stored.
   */
  matchesStoredIdentifier?: boolean;
  /** Names of identifier cookies sent with the request (third-party requests only; values not read). */
  sentCookieNames?: string[];
}

export interface CookieRecord {
  name: string;
  /** Cookie domain without leading dot. */
  domain: string;
  /** Registrable domain equals the target's. Fingerprints use `first-party` instead of the domain then. */
  firstParty: boolean;
  path: string;
  partitionKey: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | 'unknown';
  lifetime: { kind: 'session' | 'persistent'; days?: number };
  /** Value length only. */
  length: number;
  setter: 'http-response' | 'script' | 'unknown';
  setterHost?: string;
  setterUrl?: SanitizedUrl;
  state: 'attempted' | 'accepted' | 'rejected' | 'sent';
  phase: BrowserPhase;
  pageUrl: SanitizedUrl;
  /** First time seen, relative to `tRef` (legacy; 5.3 `tMs` is `atMs`). */
  tMs?: RelativeMs;
  tRef?: 'navigation' | 'click';
  afterClick: boolean;
  /** 5.3 `tMs`: first seen, ms since the scan start (one monotonic scale). */
  atMs?: number;
  /** 5.3 `navigationId` / `actionId?` of the moment the record was taken. */
  navigationId?: string;
  actionId?: string;
  /** Browser reason for `rejected` (CDP blockedReasons). */
  blockedReasons?: string[];
}

export interface StorageRecord {
  storageType: 'localStorage' | 'sessionStorage' | 'indexedDB';
  origin: string;
  /** Key (localStorage/sessionStorage) or database name (IndexedDB). */
  key: string;
  firstParty: boolean;
  /** Value length only. */
  length?: number;
  phase: BrowserPhase;
  pageUrl: SanitizedUrl;
  /** First seen, relative to the navigation or click (legacy; 5.3 `tMs` is `atMs`). */
  tMs?: RelativeMs;
  afterClick: boolean;
  /** 5.3 `tMs`, `navigationId`, `actionId?` (see CookieRecord). */
  atMs?: number;
  navigationId?: string;
  actionId?: string;
}

export interface ClickRecord {
  action: 'reject' | 'accept';
  cmpId: string | null;
  name: string;
  /** Epoch ms of the click (reference point for `tRef: click`). */
  clickedAt: number;
  /**
   * Where `clickedAt` comes from: the trusted press observed in the page, or (no press observed) the moment the
   * adapter was called.
   */
  clickedAtSource?: 'input-event' | 'adapter-call';
  /** 5.3 `actionId` of the click; requests, cookies and storage after it carry the same id. */
  actionId?: string;
  pageUrl: SanitizedUrl;
  success: boolean;
  error?: string;
}

export interface PhaseRecord {
  phase: BrowserPhase;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  /** e.g. `cmp-not-recognized`, `no-reject-button`, `timeout`, `tls-blocked`. */
  reason?: string;
  startedAt: IsoTimestamp;
  durationMs: number;
  profile: 'persistent-tmp';
  pages: PageVisit[];
  requests: RequestRecord[];
  /**
   * Cookie observations of this phase (deduplicated by name+domain+path+partitionKey+state; a key seen before the
   * click gets one more `afterClick` record when it is written again after the click).
   */
  cookies: CookieRecord[];
  storage: StorageRecord[];
  click?: ClickRecord;
  /** Reload after the click (B: verification of the reject). */
  reloaded?: boolean;
  errors: CollectorError[];
}

export interface ScreenshotRecord {
  id: string;
  phase: BrowserPhase;
  kind: 'banner';
  /** Path relative to the report output directory. */
  path: string;
  sha256: string;
  width: number;
  height: number;
  viewport: 'desktop' | 'mobile';
  pageUrl: SanitizedUrl;
}

export interface BrowserEngineInfo {
  name: 'chromium';
  /** `chromium` = Chrome for Testing new headless; `chromium-headless-shell` = shell. */
  channel: string;
  version: string;
  headless: 'new' | 'shell';
  userAgent: string;
  sandbox: boolean;
  disabledFeatures: string[];
}

export interface BrowserSection {
  engine: BrowserEngineInfo;
  viewport: Viewport;
  locale: string;
  timezoneId: string;
  phases: PhaseRecord[];
  /** Shared browser request counter (cap 2 000). */
  requestCap: { limit: number; issued: number; truncated: boolean };
  /** Documents blocked by the SSRF guard (prototype: top-level documents, frames and popups). */
  guard?: { enabled: boolean; blocked: number };
  screenshots: ScreenshotRecord[];
  /** Observation gaps of this run, e.g. `pagehide-beacons`, `preconnect`. */
  knownGaps: string[];
  errors: CollectorError[];
}

export type DocumentKind = 'impressum' | 'privacy';
export type DocumentPartOrigin = 'visible' | 'expandable' | 'frame' | 'linked' | 'hidden-irrelevant';

export interface DocumentPart {
  id: string;
  /** Heading path, e.g. `5 > Google Analytics`. */
  section?: string;
  /** Normalized text (NFC, whitespace-collapsed). Not normalized for matching — derive/checks do that. */
  text: string;
  origin: DocumentPartOrigin;
  sourceUrl: SanitizedUrl;
  frameUrl?: SanitizedUrl;
}

export interface DocumentRecord {
  id: string;
  kind: DocumentKind;
  url: SanitizedUrl;
  finalUrl: SanitizedUrl;
  status: number | null;
  /** How the document was found (LEGAL-01). */
  foundVia: 'link' | 'hop' | 'fallback' | 'config';
  /** Links that pointed to this document (page → link text). */
  linkedFrom: Array<{ pageUrl: SanitizedUrl; text: string }>;
  phase: BrowserPhase;
  format: 'html' | 'pdf' | 'other';
  lang: string | null;
  parts: DocumentPart[];
  /** Completeness manifest. */
  manifest: {
    expandablesFound: number;
    expandablesOpened: number;
    framesIncluded: number;
    /** Child frames of the page (readable, unreadable, foreign-origin and `about:blank`); absent in old snapshots. */
    framesFound?: number;
    linkedPages: number;
    textLength: number;
  };
  complete: boolean;
  /** e.g. `pdf-not-evaluated`, `soft-404`, `expand-failed`. */
  errors: string[];
  sha256: string | null;
}

export interface DocumentsSection {
  documents: DocumentRecord[];
  /** Attempts that did not yield a document, for LEGAL-01 (`hop:kontakt → 404`, `fallback:/impressum → 404`). */
  attempts: Array<{
    kind: DocumentKind;
    via: 'link' | 'hop' | 'fallback';
    url: SanitizedUrl;
    status: number | null;
    /** `unconfirmed`: a substantive page whose type could not be confirmed (neither found nor soft-404). */
    outcome: 'found' | 'not-found' | 'soft-404' | 'unconfirmed' | 'error' | 'unresolved';
  }>;
}
