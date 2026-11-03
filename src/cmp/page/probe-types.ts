/** Arguments and raw result of `cmpPageProbe`, shared by the probe and its Node side (measure.ts). */
import type { Box, Viewport } from '../../core/snapshot/common.ts';

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
  /** Accept/reject/settings/save phrases (token sequences or `*suffix`); a non-modal candidate needs a control with one. */
  controlPhrases?: string[];
  /** Accept/reject phrases only: a candidate inside a header/footer landmark needs a control with one, else it is chrome. */
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
  /** Controls dropped by `maxButtons` that could belong to the first layer. */
  buttonsTruncated: boolean;
  /** A finite animation/transition runs in the container, its subtree or an ancestor. */
  animating: boolean;
  blocking: RawBlocking;
  viewport: Viewport;
  /** Links under the banner or its overlay at the first screen (hit test); which are legal is decided on the Node side. */
  coveredLinks: Array<{ label: string; box: Box; coveredBy: 'banner' | 'overlay' }>;
  heuristic: { score: number; signals: string[] } | null;
}
