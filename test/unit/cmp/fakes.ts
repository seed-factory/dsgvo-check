import type { ProbeResult, RawButton } from '../../../src/cmp/page/probe-types.ts';
import type { CmpButton } from '../../../src/cmp/types.ts';

export const BUTTON_BOX = { x: 10, y: 700, width: 120, height: 20 };

export const rawButton = (over: Partial<RawButton> = {}): RawButton => ({
  role: 'button',
  name: 'Ablehnen',
  tag: 'button',
  vendorRole: null,
  box: BUTTON_BOX,
  rendered: true,
  visibleInViewport: true,
  inViewport: true,
  enabled: true,
  hitTestOk: true,
  actionable: true,
  contrast: 7,
  fontSizePx: 14,
  selector: null,
  inShadowDom: false,
  href: null,
  ...over,
});

export const rawProbe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  found: false,
  containerCount: 0,
  visible: false,
  containerBox: null,
  containerFixed: false,
  containerSelector: null,
  textLength: 0,
  purAbo: false,
  keywordHits: [],
  buttons: [],
  buttonsTruncated: false,
  animating: false,
  blocking: {
    overlay: false,
    scrollLock: false,
    inert: false,
    coveredRatio: null,
    method: [],
    ariaModal: false,
  },
  viewport: { width: 1366, height: 768 },
  coveredLinks: [],
  heuristic: null,
  rejectedCandidate: null,
  ...over,
});

export const layerButton = (name: string, over: Partial<CmpButton> = {}): CmpButton => ({
  role: 'button',
  name,
  tag: 'button',
  kind: 'other',
  kindConfidence: 'low',
  layer: 1,
  box: { x: 100, y: 600, width: 160, height: 40 },
  visibleAtFirstScreen: true,
  actionableAtFirstScreen: true,
  contrast: 7,
  ...over,
});
