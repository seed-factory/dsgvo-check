/** Arguments and raw result of `cmpPageProbe`, shared by the probe and its Node side (measure.ts). */
import type { Box, Viewport } from '../../core/snapshot-common.ts';

export interface ProbeArgs {
  mode: 'banner' | 'heuristic';
  /** Banner mode: container selectors in priority order (searched in the document and open shadow roots). */
  containers: string[];
  /** Overlay/backdrop selectors of the CMP. */
  overlays: string[];
  /** CMP markup roles, e.g. `{ selector: '#CybotCookiebotDialogBodyButtonDecline', role: 'reject' }`. */
  vendorRoles: Array<{ selector: string; role: string }>;
  /** Regex sources (pay-or-OK wording). */
  purAbo: string[];
  /** Regex sources (consent wording). */
  keywords: string[];
  /** Heuristic in a child frame: the frame body itself may be the banner. */
  frameMode: boolean;
  maxButtons: number;
  /**
   * Normalized phrases (token sequences, or `*suffix`) of the accept/reject/settings/save lexicon classes. A
   * non-modal fixed/sticky or static heuristic candidate needs at least one control whose name contains one of them
   * (navigation links do not count). Empty → not required.
   */
  controlPhrases?: string[];
  /**
   * Normalized phrases (same form) of the accept and reject classes only. A candidate inside a `header`/`footer`
   * (or role banner/contentinfo) landmark counts as a banner only when it has a control with one of them:
   * a footer strip with a "Cookie-Einstellungen" link offers no choice. Empty → such a candidate is page chrome.
   */
  choicePhrases?: string[];
  /** Explicit container (an iframe element handle when the banner lives in a child frame). */
  containerEl?: unknown;
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

export interface RawBlocking {
  overlay: boolean;
  scrollLock: boolean;
  inert: boolean;
  coveredRatio: number | null;
  method: string[];
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
  /** Controls dropped by `maxButtons` that could belong to the first layer (rendered, or with a CMP markup role). */
  buttonsTruncated: boolean;
  /** A finite animation/transition runs in the container, its subtree or an ancestor. */
  animating: boolean;
  blocking: RawBlocking;
  viewport: Viewport;
  /**
   * Links outside the banner whose centre lies in the first screen under the banner (or its overlay), by hit test,
   * whatever they are called. The probe holds no legal wording: which of them are Impressum or privacy links, and
   * which links of the banner are, is decided on the Node side with the lexicon of test/data/legal.
   */
  coveredLinks: Array<{ label: string; box: Box; coveredBy: 'banner' | 'overlay' }>;
  heuristic: { score: number; signals: string[] } | null;
}
