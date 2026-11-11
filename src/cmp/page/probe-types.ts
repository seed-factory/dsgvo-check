/** Arguments and raw result of `cmpPageProbe`, shared by the probe and its Node side (measure.ts). */
import type { IdLikePatterns, PagePattern } from '../../core/redaction/id-like.ts';
import type { Box, Viewport } from '../../core/snapshot/common.ts';
import type { BannerCandidateFact, SettingsGroupFact } from '../types.ts';

/** Lexicon classes whose phrases make a control a banner control (token sequences or `*suffix`). */
export interface KindPhrases {
  accept: string[];
  reject: string[];
  settings: string[];
  save: string[];
}

/**
 * The rules for the page values the probe puts into a selector or a button fact, as data (src/core/redaction/page-names.ts):
 * the probe applies them so that it picks a selector the Node side keeps, and the Node side applies them again.
 */
export interface ProbeNameRules {
  maxLength: number;
  /** A name, as written and in NFKC, consists of these characters. */
  chars: PagePattern;
  /** A value one of these matches, as written or in NFKC, is no name. */
  notName: readonly PagePattern[];
  /** Runs that make a value no name, applied in the steps of `hasIdLikeRun`. */
  idLike: IdLikePatterns;
  tag: PagePattern & { maxLength: number };
  /** The roles a `role` token may name; the first listed token counts, else the implicit role of the element. */
  roles: readonly string[];
}

export interface ProbeArgs {
  mode: 'banner' | 'heuristic';
  /** Container selectors in priority order, searched in the document and open shadow roots. */
  containers: string[];
  overlays: string[];
  vendorRoles: Array<{ selector: string; role: string }>;
  purAbo: string[];
  keywords: string[];
  /** Heuristic in a child frame: the frame body itself may be the banner. */
  frameMode: boolean;
  maxButtons: number;
  /** Attribute names a button selector may be built from, in order (test/data/cmp/probe.yaml). */
  selectorAttributes: string[];
  names: ProbeNameRules;
  /**
   * Phrases per lexicon class. A non-modal candidate needs a control with one of them; inside a header/footer landmark
   * or with a single consent keyword, an accept or reject one.
   */
  kindPhrases?: KindPhrases;
  /** Subscription and payment wording: a control with it offers no accept or reject (newsletter, pay-or-OK). */
  paidPhrases?: string[];
  /** Accept phrases that only acknowledge a notice: next to one generic keyword no choice, and no accept of a candidate. */
  acknowledgePhrases?: string[];
  /** Keywords (regex sources) that name cookies themselves; one of them with any accept makes a one-keyword banner. */
  cookieKeywords?: string[];
  /** Negations as token sequences: a cookie keyword right after one names no cookies in use ("keine Cookies"). */
  negations?: string[];
  /** id/class names of a banner container (regex sources, case-insensitive): with one, a single keyword is enough. */
  bannerContainerNames?: string[];
  /** Explicit container (an iframe element handle when the banner lives in a child frame). */
  containerEl?: unknown;
  /**
   * The group switches of a settings layer: when given, they are read inside the same container whose controls the probe
   * measures, so the switches and the save control always come from one layer.
   */
  switches?: string;
  /**
   * When given, the probe also returns the whole text of the container it found (`fullText`), hidden and collapsed parts
   * included, cut at this many characters.
   */
  fullTextMaxChars?: number;
}

export interface RawButton {
  role: string;
  name: string;
  tag: string;
  vendorRole: string | null;
  box: Box | null;
  rendered: boolean;
  visibleInViewport: boolean;
  inViewport: boolean;
  enabled: boolean;
  hitTestOk: boolean;
  actionable: boolean;
  contrast: number | null;
  fontSizePx: number | null;
  selector: string | null;
  inShadowDom: boolean;
  href: string | null;
}

/** How the probe found the page blocked (`BlockingFacts.method`). */
export const BLOCKING_METHODS = [
  'overlay-selector',
  'dialog-modal',
  'grid-hit-test',
  'overlay-grid',
  'overflow-hidden',
  'overflow-hidden-short-page',
  'body-position-fixed',
  'inert-attr',
] as const;
export type BlockingMethod = (typeof BLOCKING_METHODS)[number];

export interface RawBlocking {
  overlay: boolean;
  scrollLock: boolean;
  inert: boolean;
  coveredRatio: number | null;
  method: BlockingMethod[];
  ariaModal: boolean;
}

export interface ProbeResult {
  found: boolean;
  containerCount: number;
  visible: boolean;
  containerBox: Box | null;
  containerFixed: boolean;
  containerSelector: string | null;
  textLength: number;
  purAbo: boolean;
  keywordHits: string[];
  buttons: RawButton[];
  /** Controls dropped by `maxButtons` that could belong to the first layer. */
  buttonsTruncated: boolean;
  /** A finite animation/transition runs in the container, its subtree or an ancestor. */
  animating: boolean;
  blocking: RawBlocking;
  viewport: Viewport;
  /** Links under the banner or its overlay at the first screen (hit test); which are legal is decided on the Node side. */
  coveredLinks: Array<{ label: string; box: Box; coveredBy: 'banner' | 'overlay' }>;
  heuristic: { score: number; signals: string[] } | null;
  /**
   * Heuristic mode: the best banner-shaped element it dismissed when it took none (features only), with its rank among
   * the dismissed candidates (higher is more like a banner), so the Node side compares the candidates of several frames,
   * and its box in this frame's viewport, so the Node side checks that the main page shows it.
   */
  rejectedCandidate: { fact: BannerCandidateFact; rank: number; box: Box } | null;
  /** The switches `switches` names inside the container, in DOM order; absent without that argument. */
  switches?: SettingsGroupFact[];
  /** Whitespace-collapsed text of the container; absent without `fullTextMaxChars`. */
  fullText?: { text: string; truncated: boolean };
}
