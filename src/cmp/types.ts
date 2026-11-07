/** CMP facts and the adapter contract. */
import type { Page } from 'playwright-core';
import type { CmpDialogMentions } from '../core/snapshot/cmp-dialog.ts';
import type {
  Box,
  BrowserPhase,
  IsoTimestamp,
  RelativeMs,
  SanitizedUrl,
  Viewport,
} from '../core/snapshot/common.ts';

export type Confidence = 'high' | 'medium' | 'low';

/**
 * The CMPs with an own adapter: the seven of the catalog in its order, then the consent banners built into shop and
 * site systems (Shopware, Wix, TYPO3 cookieman). Heuristically named ones are open strings.
 */
export const KNOWN_CMP_IDS = [
  'borlabs',
  'cookiebot',
  'complianz',
  'usercentrics',
  'ccm19',
  'real-cookie-banner',
  'cookiehub',
  'shopware',
  'wix',
  'cookieman',
] as const;
export type KnownCmpId = (typeof KNOWN_CMP_IDS)[number];

export interface CmpDetection {
  /** Adapter id when recognized by an adapter; a heuristic name or null otherwise. */
  cmpId: KnownCmpId | (string & {}) | null;
  method: 'adapter' | 'heuristic' | 'none';
  version: string | null;
  /** Version inside the adapter's tested range. false → `cmp-not-supported`. */
  versionSupported: boolean | null;
  /** high requires ≥ 2 independent signals. */
  recognitionConfidence: Confidence;
  /** Independent signals, e.g. `global:Cookiebot`, `dom:#CybotCookiebotDialog`. */
  signals: string[];
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
  role: string;
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
  contrast: number | null;
  fontSizePx?: number | null;
  /** Internal locator for clicking; never shown to users. */
  selector?: string;
  /** Role from the CMP's own markup or config, independent of the label. */
  vendorRole?: ButtonKind | null;
  inShadowDom?: boolean;
  enabled?: boolean;
  inViewport?: boolean;
  hitTestOk?: boolean;
}

export interface BlockingFacts {
  overlay: boolean;
  /** Scroll lock on html/body (not on an inner container). */
  scrollLock: boolean;
  inert: boolean;
  coveredRatio: number | null;
  method: string[];
  ariaModal?: boolean;
}

export type CategoryState = 'denied' | 'granted' | 'partial' | 'unknown';

/** Consent state read from the CMP API, consent cookie or TCF; cookie values are never stored. */
export interface ConsentStateFact {
  source: 'api' | 'cookie' | 'tcf';
  ready: 'stub' | 'loading' | 'ready';
  categories: Record<string, CategoryState>;
  origin: 'default' | 'stored' | 'action' | 'special-branch';
  scope?: string;
  tMs?: RelativeMs;
  /** Whether the CMP recorded an answer from the user. */
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
  /** e.g. `cookiebot:isSpider`, `rcb:accept-all-for-bots`, or `BOT_USER_AGENT_SIGNAL`. */
  signal: string;
  detail?: string;
}

/**
 * The signal of a dialog the CMP kept closed (`dialogNotOpened`) because its own crawler test matched the page's
 * User-Agent (`dialogBotUserAgent` in test/data/cmp/adapters.yaml); `detail` is the name of that test. The User-Agent
 * itself is not stored here.
 */
export const BOT_USER_AGENT_SIGNAL = 'bot-user-agent';

/** A vendor's own crawler test: the regular expression of its script, with its flags, and the name the report gives it. */
export interface BotUserAgentTest {
  pattern: string;
  flags: string;
  label: string;
}

export interface CmpFirstLayer {
  bannerPresent: boolean;
  bannerVisible: boolean;
  buttons: CmpButton[];
  /** Pay-or-OK model detected; does not disable other variants. */
  purAbo: boolean;
  /** "×" means accept according to the CMP config read from the page; null = unknown. */
  closeMeansAccept: boolean | null;
  /** Banner or backdrop covers a legal link at the first screen. */
  coversFooter?: boolean;
  legalLinks?: Array<{ text: string; href: SanitizedUrl | null }>;
  /** Length only; the text itself is not stored. */
  textLength?: number;
  containerBox?: Box | null;
  /** Exactly one container matched; the screenshot is taken only then. */
  containerUnambiguous?: boolean;
  containerFixed?: boolean;
  /** The probe dropped controls that may belong to the first layer; "no reject" must not be concluded then. */
  buttonsTruncated?: boolean;
  containerAnimating?: boolean;
  /** Geometry was still moving when measured; no verdict on reject reachability is drawn then. */
  geometryUnsettled?: boolean;
  /**
   * A viewport-sized iframe looks like a consent dialog but its content could not be resolved: it is never clicked
   * and "no banner" must not be concluded.
   */
  consentFrameUnresolved?: boolean;
  /** Document legal links under the banner or overlay at the first screen, found by a hit test at the link centre. */
  coveredFooterLinks?: Array<{ label: string; box: Box; coveredBy: 'banner' | 'overlay' }>;
  /**
   * Set when the generic heuristic found no banner: its best dismissed candidate, or null when it saw none. Absent in
   * snapshots written before this field and when the heuristic could not run on the page.
   */
  bannerCandidate?: BannerCandidateFact | null;
  /**
   * The CMP's dialog is in the page but was not opened for this browser: on the first screen of a consent phase, after
   * the wait for the banner, it is still hidden with every control disabled and no answer is stored. Nothing is said
   * about what visitors see. Only adapters that can read their dialog's lifecycle set it (CCM19).
   */
  dialogNotOpened?: boolean;
}

/**
 * Kinds of the controls in a banner candidate: the lexicon classes of a choice, `other` for any further control. An
 * acknowledgement alone ("OK", "Verstanden") is no accept here.
 */
export type CandidateControlKind = 'accept' | 'reject' | 'settings' | 'save' | 'other';

/**
 * A banner-shaped element with consent wording that the generic heuristic did not take as a banner: why, and its
 * features. No page text and no values; never clicked.
 */
export interface BannerCandidateFact {
  /**
   * `page-section`: inside a header or footer without accept or reject; `keywords`: one consent keyword, no banner
   * name, no accept or reject, and no cookie wording (in a box: none with an acknowledgement); `no-control`: no
   * control the lexicon knows.
   */
  reason: 'keywords' | 'no-control' | 'page-section';
  keywordHits: number;
  controls: CandidateControlKind[];
  /**
   * A keyword hit names cookies themselves (`cookieKeywords`), not privacy or tracking in general, at least once without
   * a negation in front ("Wir verwenden keine Cookies" names none).
   */
  cookieWording: boolean;
  fixed: boolean;
  dialog: boolean;
  /** Its id or class is one of the banner container names (test/data/cmp/probe.yaml). */
  named: boolean;
}

/** Everything the adapter extracted at one moment (first screen before click, after reload…). */
export interface CmpFacts {
  phase: BrowserPhase;
  pageUrl: SanitizedUrl;
  moment: 'first-screen' | 'after-click' | 'after-reload' | 'control-page' | 'phase-end';
  takenAt: IsoTimestamp;
  viewport: Viewport;
  detection: CmpDetection;
  firstLayer: CmpFirstLayer;
  blocking: BlockingFacts;
  state: ConsentStateFact[];
  geoSignals: GeoSignal[];
  botSignals: BotSignal[];
  /** Safe CMP config values (no personal data). */
  config: Record<string, string | number | boolean | null>;
  screenshotId?: string;
}

export interface ClickOutcome {
  action: 'reject' | 'accept';
  clicked: boolean;
  button: Pick<CmpButton, 'name' | 'role' | 'kind' | 'kindConfidence'> | null;
  error?: string;
  /** `settings`: the save control of the settings layer, pressed as the reject of phase B; absent: a first-layer control. */
  path?: 'settings';
}

/** A switch of a consent group in the settings layer: on (null when unreadable) and whether the visitor can change it. */
export interface SettingsGroupFact {
  checked: boolean | null;
  disabled: boolean;
}

/**
 * The settings layer that the first layer's settings control opened in phase B. Read only when the first layer offers
 * no reject and the adapter's data describes the layer (`settingsLayer` in adapters.yaml); nothing in it is toggled.
 */
export interface SettingsLayerFacts {
  takenAt: IsoTimestamp;
  /** The layer showed within the wait after the click on the settings control. */
  opened: boolean;
  /** Why the settings control was not clicked, e.g. `target-not-found`. */
  error?: string;
  /** Controls inside the layer, measured like those of the first layer once it showed. */
  buttons: CmpButton[];
  /** Exactly one container of the layer matched. */
  containerUnambiguous: boolean;
  buttonsTruncated: boolean;
  /** The group switches inside the layer, in DOM order. */
  groups: SettingsGroupFact[];
  /**
   * Locked switches that are on and that the vendor shows for its essential processing (adapters.yaml
   * `settingsLayer.essentialGroups`): a locked switch says nothing about its purpose, so a further one counts as a
   * pre-checked optional group.
   */
  essentialGroups: number;
}

/** Why phase B did not press the save control of the settings layer as its reject. */
export type SettingsRejectReason =
  | 'settings-control-not-found'
  | 'settings-not-opened'
  | 'settings-layer-ambiguous'
  | 'settings-groups-unreadable'
  | 'preselected-groups'
  | 'settings-save-not-found';

/** Core's choice of a control for the reject through the settings layer (src/cmp/settings-layer.ts). */
export interface SettingsChoice {
  /** The one control to click; null with `reason` when there is none. */
  target: CmpButton | null;
  reason?: SettingsRejectReason;
}

/** Verification of reject/accept by CMP state, independent of network and UI. */
export interface VerifyResult {
  action: 'reject' | 'accept';
  verified: boolean;
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
  /** Phase B only: the settings layer opened because the first layer offers no reject. */
  settings?: SettingsLayerFacts;
}

export interface CmpSection {
  phases: CmpPhaseFacts[];
  /**
   * The catalog services the consent dialog names, found in its text once in phase A where an own adapter recognised
   * its CMP with confidence `high`; the text itself is not kept. Absent when none did, the read failed, and in older
   * snapshots.
   */
  dialogMentions?: CmpDialogMentions;
  /** The dialog qualified for that read, but its text could not be read or matched; PRIV-01 names it as a limitation. */
  dialogMentionsFailed?: true;
}

/**
 * Text of the adapter's banner container as the page holds it, hidden and collapsed parts included. The collector only
 * searches it in memory; it is never stored. `truncated`: the page side cut it at the limit it was given.
 */
export interface RawDialogText {
  text: string;
  truncated: boolean;
}

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
  /** An actionable accept control on the first layer. */
  acceptAvailableAtFirstLayer?: boolean;
  blocking?: boolean;
  buttons?: CmpButton[];
  /** Unambiguous click targets chosen by the table (only core decides where to click). */
  targets?: { reject: CmpButton | null; accept: CmpButton | null };
  lexiconVersion?: string;
}

/** Button lexicon from test/data/cmp/*.yaml. */
export interface CmpLexicon {
  version: string;
  accept: string[];
  reject: string[];
  settings: string[];
  save: string[];
  close: string[];
  later: string[];
  hide: string[];
  /** Words that negate a reject or accept phrase before it ("Nicht alle akzeptieren"): no decision then. */
  negations?: string[];
  /** Words after which a negation negates a cookie category, not the decision ("Nicht notwendige Cookies ablehnen"). */
  necessity?: string[];
  /** Words that restrict an accept phrase outside it ("Nur Statistik akzeptieren"): no accept then. */
  restrictions?: string[];
  /** Subscription and payment wording: a label with it is never a reject or accept. */
  paid?: string[];
  /** Words for all cookies: with one, a necessity word beside an accept phrase does not make it necessary-only. */
  allWords?: string[];
  /**
   * Words that only recommend a button or call it the default ("empfohlen", "Standard"): beside a necessary-only reject
   * phrase they name no category.
   */
  neutralWords?: string[];
  /** Case-insensitive regex sources for the pay-or-OK model in the banner text. */
  purAbo?: string[];
  /** Accept phrases that only acknowledge a notice ("OK", "Verstanden"): no consent choice next to one generic keyword. */
  acknowledgements?: string[];
  /** Case-insensitive regex sources for consent wording (generic heuristic). */
  bannerKeywords?: string[];
  /** The banner keywords that name cookies themselves: with one, a single keyword makes a cookie notice. */
  cookieKeywords?: string[];
}

export interface ExtractOptions {
  /** Phase the facts belong to (default `B`). */
  phase?: BrowserPhase;
  lexicon?: CmpLexicon;
  now?: () => Date;
}

/** The element core chose to click; the adapter locates it by `selector` (exactly one match) and clicks it. */
export type ClickTarget = Pick<CmpButton, 'name' | 'role' | 'selector' | 'kindConfidence'> & {
  kind?: ButtonKind;
};

export type ActOptions = {
  /** Lexicon of the decision over `facts` (default: test/data/cmp). */
  lexicon?: CmpLexicon;
  timeoutMs?: number;
} & (
  | {
      /** Core's click decision; `null` means nothing to click. When present, `facts` and `lexicon` are ignored. */
      target?: ClickTarget | null;
      facts?: undefined;
      blockingCoveredRatio?: undefined;
    }
  | {
      target?: ClickTarget | null;
      /** Transitional: without `target`, the adapter classifies these facts itself. Without both, nothing is clicked. */
      facts: CmpFacts;
      /** Blocking threshold of that decision (`cmp.blockingCoveredRatio`); the adapter has no default of its own. */
      blockingCoveredRatio: number;
    }
);

export interface VerifyOptions {
  /** Reload the page and read the state again (default true). */
  reload?: boolean;
  /** Max wait for the CMP after reload, and for an answer the CMP records late (default 8000 ms). */
  timeoutMs?: number;
}

/** Per-CMP adapter, run in the collector with a live page. Clicks via `locator.click()` (no `force`); never classifies. */
export interface CmpAdapter {
  id: KnownCmpId;
  name: string;
  supportedVersions: string | null;
  /** Null when this CMP is not present. */
  detect(page: Page): Promise<CmpDetection | null>;
  extract(page: Page, moment: CmpFacts['moment'], opts?: ExtractOptions): Promise<CmpFacts>;
  state(page: Page): Promise<ConsentStateFact[]>;
  geoSignals(page: Page): Promise<GeoSignal[]>;
  botSignals(page: Page): Promise<BotSignal[]>;
  firstLayer(page: Page): Promise<CmpFirstLayer>;
  /** Clicks exactly the target core chose (`null` clicks nothing); optional only so collector test stubs stay valid. */
  act?(
    page: Page,
    action: 'reject' | 'accept',
    target: ClickTarget | null,
    opts?: Pick<ActOptions, 'timeoutMs'>,
  ): Promise<ClickOutcome>;
  /** Clicks `opts.target`, or the reject target classified from `opts.facts`. */
  reject(page: Page, opts?: ActOptions): Promise<ClickOutcome>;
  accept(page: Page, opts?: ActOptions): Promise<ClickOutcome>;
  /** The adapter's data describes a settings layer that phase B may reject through (`settingsLayer`). */
  readonly rejectsViaSettings?: boolean;
  /** The vendor's crawler test for which it keeps its dialog closed (`dialogBotUserAgent`); absent for most adapters. */
  readonly dialogBotUserAgent?: BotUserAgentTest;
  /**
   * Clicks `opener`, the settings control core chose on the first layer, waits up to `timeoutMs` for the settings layer
   * and reads it. Toggles nothing and saves nothing; the save is a separate `act` on core's choice.
   */
  openSettings?(page: Page, opener: ClickTarget, opts?: { timeoutMs?: number }): Promise<SettingsLayerFacts>;
  /**
   * Reads the state after the action, then (default) reloads and reads it again. In the document of our click only
   * a state the click produced verifies.
   */
  verify(page: Page, action: 'reject' | 'accept', opts?: VerifyOptions): Promise<VerifyResult>;
  ready?(page: Page): Promise<boolean>;
  /**
   * Reads the whole text of the banner container (adapters.yaml `banner.containers`), hidden and collapsed parts
   * included, without a click or a scroll; null when the container is not there. At most `maxChars` characters.
   */
  dialogText?(page: Page, opts: { maxChars: number }): Promise<RawDialogText | null>;
}
