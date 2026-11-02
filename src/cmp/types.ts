/**
 * CMP facts and adapter contract.
 * Recognition needs ≥ 2 independent signals for `high`; unrecognized banners remain informational.
 * The pure first-layer table chooses click targets from recorded facts.
 */
import type { Page } from 'playwright-core';
import type {
  Box,
  BrowserPhase,
  IsoTimestamp,
  RelativeMs,
  SanitizedUrl,
  Viewport,
} from '../core/snapshot-common.ts';

export type Confidence = 'high' | 'medium' | 'low';

/** The 7 supported CMPs in catalog order, plus open strings for heuristically named ones. */
export type KnownCmpId =
  | 'borlabs'
  | 'cookiebot'
  | 'complianz'
  | 'usercentrics'
  | 'ccm19'
  | 'real-cookie-banner'
  | 'cookiehub';

export interface CmpDetection {
  /** Adapter id when recognized by an adapter; a heuristic name or null otherwise. */
  cmpId: KnownCmpId | (string & {}) | null;
  /** `adapter:<id>` or `heuristic`. */
  method: 'adapter' | 'heuristic' | 'none';
  version: string | null;
  /** Version inside the adapter's tested range. false → `cmp-not-supported`. */
  versionSupported: boolean | null;
  /** high requires ≥ 2 independent signals. */
  recognitionConfidence: Confidence;
  /** Independent signals, e.g. `global:Cookiebot`, `dom:#CybotCookiebotDialog`, `script:consent.cookiebot.com`. */
  signals: string[];
  /** Frame where the banner lives when not the main frame. */
  frameUrl?: SanitizedUrl;
}

export type ButtonKind =
  | 'accept'
  | 'reject'
  | 'settings'
  | 'save'
  | 'close'
  | 'later'
  | 'hide'
  | 'link'
  | 'other';

export interface CmpButton {
  /** ARIA role (button, link, checkbox…). */
  role: string;
  /** Accessible name. */
  name: string;
  tag: string;
  kind: ButtonKind;
  kindConfidence: Confidence;
  /** First layer = visible without opening settings. */
  layer: 1 | 2;
  box: Box | null;
  visibleAtFirstScreen: boolean;
  /** Visible, enabled, not covered (hit-test), inside the viewport — measured before any action. */
  actionableAtFirstScreen: boolean;
  /** WCAG contrast ratio of text vs background, evidence only. */
  contrast: number | null;
  fontSizePx?: number | null;
  /** Internal locator for clicking; never shown to users. */
  selector?: string;
  /** Role by the CMP's own markup/config (e.g. Cookiebot decline id), independent of the label (5.3 `vendorRole`). */
  vendorRole?: ButtonKind | null;
  /** Element lives in an open shadow root. */
  inShadowDom?: boolean;
  /** Not `disabled` / `aria-disabled`. */
  enabled?: boolean;
  /** Center of the element is inside the viewport (part of actionability). */
  inViewport?: boolean;
  /** Hit-test at the center reached the element (not covered). */
  hitTestOk?: boolean;
}

export interface BlockingFacts {
  overlay: boolean;
  /** Scroll lock on html/body (not on an inner container). */
  scrollLock: boolean;
  inert: boolean;
  /** Share of the viewport covered by the banner/overlay, 0..1. */
  coveredRatio: number | null;
  /** How blocking was measured, e.g. `elementFromPoint-grid`, `overflow-hidden`, `inert-attr`. */
  method: string[];
  ariaModal?: boolean;
}

export type CategoryState = 'denied' | 'granted' | 'partial' | 'unknown';

/** 5.3 `consent-state`. Read from the CMP JS API / consent cookie / TCF — values of cookies are never stored. */
export interface ConsentStateFact {
  source: 'api' | 'cookie' | 'tcf';
  ready: 'stub' | 'loading' | 'ready';
  categories: Record<string, CategoryState>;
  origin: 'default' | 'stored' | 'action' | 'special-branch';
  scope?: string;
  tMs?: RelativeMs;
  /** 5.3 `decision`: did the user answer according to the CMP (Cookiebot `hasResponse`, UC `type: EXPLICIT`…). */
  decision?: { responded: boolean | 'unknown'; method: 'explicit' | 'implied' | 'unknown' };
}

export interface GeoSignal {
  cmpId: string;
  /** e.g. `cookiebot:isOutOfRegion`, `usercentrics:isConsentRequired=false`, `tcf:gdprApplies=false`. */
  signal: string;
  detail?: string;
}

export interface BotSignal {
  cmpId: string;
  /** e.g. `cookiebot:isSpider`, `rcb:accept-all-for-bots`. */
  signal: string;
  detail?: string;
}

export interface CmpFirstLayer {
  bannerPresent: boolean;
  bannerVisible: boolean;
  buttons: CmpButton[];
  /** Pay-or-OK model detected (flag, does not disable other variants). */
  purAbo: boolean;
  /** "×" means accept according to the CMP config read from the page; null = unknown. */
  closeMeansAccept: boolean | null;
  /** The banner (or its backdrop) covers a legal link of the page at the first screen: `coveredFooterLinks` is not empty. */
  coversFooter?: boolean;
  /** Legal links inside the banner. */
  legalLinks?: Array<{ text: string; href: SanitizedUrl | null }>;
  /** Text length of the first layer (no text content stored here). */
  textLength?: number;
  /** Banner container geometry (viewport coordinates) for the screenshot crop. */
  containerBox?: Box | null;
  /** Exactly one container matched (screenshot only for an unambiguous container). */
  containerUnambiguous?: boolean;
  /** Banner container is position fixed/sticky (or inside such an element). */
  containerFixed?: boolean;
  /**
   * The probe kept only `maxButtons` controls and dropped some that could belong to the first layer (a rendered
   * control or one with a CMP markup role). "No (usable) reject" must not be concluded from an incomplete set.
   */
  buttonsTruncated?: boolean;
  /** A finite animation/transition was running in the container (or an ancestor) when it was measured. */
  containerAnimating?: boolean;
  /**
   * The container geometry was still changing when the first screen was measured (appearance animation that did not
   * finish within the settle limit). A geometry-dependent verdict (reject outside the viewport) is not drawn then.
   */
  geometryUnsettled?: boolean;
  /**
   * A visible iframe covering ≥ 50 % of the viewport looks like a consent dialog (title/aria-label/name or inner
   * wording) but its content could not be resolved. Never clicked; "no banner" must not be concluded (CONSENT-03).
   */
  consentFrameUnresolved?: boolean;
  /**
   * Legal links of the document (outside the banner) that sit under the banner or its overlay at the first screen,
   * measured by a hit test at the link centre. Basis of `coversFooter`.
   */
  coveredFooterLinks?: Array<{ label: string; box: Box; coveredBy: 'banner' | 'overlay' }>;
}

/** Everything the adapter extracted at one moment (first screen before click, after reload…). */
export interface CmpFacts {
  phase: BrowserPhase;
  pageUrl: SanitizedUrl;
  /** When the facts were taken. */
  moment: 'first-screen' | 'after-click' | 'after-reload' | 'control-page' | 'phase-end';
  takenAt: IsoTimestamp;
  viewport: Viewport;
  detection: CmpDetection;
  firstLayer: CmpFirstLayer;
  blocking: BlockingFacts;
  state: ConsentStateFact[];
  geoSignals: GeoSignal[];
  botSignals: BotSignal[];
  /** Safe CMP config values read from the page (no personal data), e.g. `{ "hideDialogOnPages": true }`. */
  config: Record<string, string | number | boolean | null>;
  /** Id of a ScreenshotRecord (browser section) of the banner area. */
  screenshotId?: string;
}

export interface ClickOutcome {
  action: 'reject' | 'accept';
  clicked: boolean;
  button: Pick<CmpButton, 'name' | 'role' | 'kind' | 'kindConfidence'> | null;
  error?: string;
}

/** Verification of the reject/accept by state, independent from network and UI (CONSENT-05). */
export interface VerifyResult {
  action: 'reject' | 'accept';
  verified: boolean;
  /** e.g. `api:all-denied`, `cookie:denied`, `persisted-after-reload`. */
  method: string[];
  stateAfter: ConsentStateFact[];
  persistedAfterReload: boolean | null;
  reason?: string;
}

export interface CmpPhaseFacts {
  phase: BrowserPhase;
  facts: CmpFacts[];
  click?: ClickOutcome;
  verify?: VerifyResult;
}

/** Snapshot section `cmp`. */
export interface CmpSection {
  phases: CmpPhaseFacts[];
}

/** Result of the pure first-layer table. */
export type FirstLayerVariant =
  | 'blocking-no-reject'
  | 'close-means-accept'
  | 'reject-not-actionable'
  | 'reject-as-link'
  | 'nonblocking-no-reject'
  | 'pur-abo'
  | 'ok'
  | 'banner-not-recognized'
  | 'cmp-not-supported'
  /** Blocking first layer with neither accept nor reject (settings only) → `info`, manual review. */
  | 'no-choice-at-first-layer';

export interface FirstLayerClassification {
  /** Primary variant; `pur-abo` may additionally be flagged in `flags`. */
  variant: FirstLayerVariant;
  flags: Array<'pur-abo'>;
  confidence: Confidence;
  reasons: string[];
  /** 5.3 derived `acceptAvailableAtFirstLayer`: an actionable accept control on the first layer. */
  acceptAvailableAtFirstLayer?: boolean;
  /** Blocking as measured (overlay, scroll lock, inert, coveredRatio ≥ 0.85). */
  blocking?: boolean;
  /** First-screen buttons re-classified with the given lexicon (`kind`, `kindConfidence`). */
  buttons?: CmpButton[];
  /** Unambiguous click targets chosen by the table (only core decides where to click). */
  targets?: { reject: CmpButton | null; accept: CmpButton | null };
  lexiconVersion?: string;
}

/** Button lexicon from data/cmp/*.yaml. */
export interface CmpLexicon {
  version: string;
  accept: string[];
  reject: string[];
  settings: string[];
  save: string[];
  close: string[];
  later: string[];
  hide: string[];
  /** Regex sources (case-insensitive) for the pay-or-OK model in the banner text. */
  purAbo?: string[];
  /** Regex sources (case-insensitive) for consent wording; used by the generic heuristic. */
  bannerKeywords?: string[];
}

export interface ExtractOptions {
  /** Phase the facts belong to (default `B`). */
  phase?: BrowserPhase;
  lexicon?: CmpLexicon;
  now?: () => Date;
}

/**
 * The element core chose to click (`act(page, target)`): `classifyFirstLayer(...).targets[action]` or the
 * `plan.click` target. The adapter only locates it by `selector` (exactly one match) and clicks it.
 */
export type ClickTarget = Pick<CmpButton, 'name' | 'role' | 'selector' | 'kindConfidence'> & {
  kind?: ButtonKind;
};

export interface ActOptions {
  /**
   * The click decision of core. When present (also `null` = "nothing to click") the adapter executes exactly it
   * and decides nothing; `facts`/`lexicon` are then ignored.
   */
  target?: ClickTarget | null;
  /**
   * Transitional, without `target`: the first-screen facts core decided on; the adapter applies the same pure
   * `classifyFirstLayer(facts, lexicon)` to them. Without `target` and `facts` nothing is clicked (`no-target`): the
   * adapter never measures and picks a button on its own.
   */
  facts?: CmpFacts;
  /** Lexicon of that decision (default: data/cmp). */
  lexicon?: CmpLexicon;
  timeoutMs?: number;
}

export interface VerifyOptions {
  /** Reload the page and read the state again (default true). */
  reload?: boolean;
  /** Max wait for the CMP after reload (default 8000 ms). */
  timeoutMs?: number;
}

/**
 * Per-CMP adapter. Runs in the collector with a live page; reads CMP JS APIs, clicks with
 * `locator.click()` (no `force`). Classification of the first layer is NOT done here (pure `classifyFirstLayer`).
 */
export interface CmpAdapter {
  id: KnownCmpId;
  name: string;
  /** Tested version range (semver range string) or null if unknown. */
  supportedVersions: string | null;
  /** Detection with independent signals; null when this CMP is not present. */
  detect(page: Page): Promise<CmpDetection | null>;
  /** Full facts at the current moment. */
  extract(page: Page, moment: CmpFacts['moment'], opts?: ExtractOptions): Promise<CmpFacts>;
  state(page: Page): Promise<ConsentStateFact[]>;
  geoSignals(page: Page): Promise<GeoSignal[]>;
  botSignals(page: Page): Promise<BotSignal[]>;
  firstLayer(page: Page): Promise<CmpFirstLayer>;
  /**
   * `act(page, target)`: click exactly the target core chose (`null` → nothing is clicked). No classification,
   * no lexicon. Optional in the type only so that collector test stubs stay valid; every own adapter implements it.
   */
  act?(
    page: Page,
    action: 'reject' | 'accept',
    target: ClickTarget | null,
    opts?: Pick<ActOptions, 'timeoutMs'>,
  ): Promise<ClickOutcome>;
  /** Click the reject target given in `opts.target` (or decided by `classifyFirstLayer` over `opts.facts`). */
  reject(page: Page, opts?: ActOptions): Promise<ClickOutcome>;
  accept(page: Page, opts?: ActOptions): Promise<ClickOutcome>;
  /**
   * Read the state right after the action, then (default) reload and read it again (`persistedAfterReload`). In the
   * document of our click only a state the click produced (`origin: action`, answer recorded) verifies.
   */
  verify(page: Page, action: 'reject' | 'accept', opts?: VerifyOptions): Promise<VerifyResult>;
  /** CMP initialized (API ready or banner rendered). */
  ready?(page: Page): Promise<boolean>;
}
