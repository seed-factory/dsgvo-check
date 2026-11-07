/** Node side of the in-page probe: runs it in a frame and turns raw facts into `CmpFirstLayer` / `BlockingFacts`. */
import type { ElementHandle, Frame, Page } from 'playwright-core';
import { LEGAL_KINDS, type LegalLexicon, matchLegalLink } from '../../collectors/browser/legal/lexicon.ts';
import { loadLegalLexicon } from '../../collectors/browser/legal/lexicon-file.ts';
import type { Box, Viewport } from '../../core/snapshot/common.ts';
import { parseUrl, sanitizeUrl } from '../../core/url/url.ts';
import { loadProbeData } from '../adapters-file.ts';
import { classifyButton, labelTokens, normalizeLabel } from '../lexicon.ts';
import type {
  BannerCandidateFact,
  BlockingFacts,
  ButtonKind,
  CmpButton,
  CmpDetection,
  CmpFirstLayer,
  CmpLexicon,
} from '../types.ts';
import { cmpPageProbe } from './probe.ts';
import type { KindPhrases, ProbeArgs, ProbeResult, RawButton } from './probe-types.ts';

export interface BannerSpec {
  containers: readonly string[];
  overlays?: readonly string[];
  vendorRoles?: ReadonlyArray<{ selector: string; role: ButtonKind }>;
  /** Group switches of a settings layer, read in the measured container (`ProbeResult.switches`). */
  switches?: string;
}

export interface Measured {
  firstLayer: CmpFirstLayer;
  blocking: BlockingFacts;
  viewport: Viewport;
  /** Absent for a consent-frame candidate that was not probed into. */
  raw?: ProbeResult;
}

/** Controls the probe returns per banner; over this the first layer is kept (see `cmpPageProbe`). */
const MAX_BUTTONS = 40;

const MAX_COVERED_LEGAL_LINKS = 5;

/** Banner keywords the body of a large frame needs when its title, aria-label and name give no hint. */
const MIN_BODY_KEYWORDS = 2;

/** Share of the viewport a frame must cover to count as a consent-dialog candidate. */
const FRAME_CANDIDATE_MIN_SHARE = 0.5;

const FRAME_HINT_ATTRIBUTES = ['title', 'aria-label', 'name'];

/** Phrases as the probe matches them: token sequences joined by a space, `*suffix` normalized. */
function probePhrases(list: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const phrase of list ?? []) {
    if (phrase.startsWith('*')) {
      const suffix = normalizeLabel(phrase.slice(1));
      if (suffix) out.add(`*${suffix}`);
    } else {
      const tokens = labelTokens(phrase);
      if (tokens.length > 0) out.add(tokens.join(' '));
    }
  }
  return [...out];
}

/** The lexicon classes that make a control a banner control, and the paid wording that unmakes a choice. */
const phrasesCache = new WeakMap<
  CmpLexicon,
  { kinds: KindPhrases; paid: string[]; acknowledge: string[]; negations: string[] }
>();

function probeArgs(lexicon: CmpLexicon, p: Partial<ProbeArgs>): ProbeArgs {
  let phrases = phrasesCache.get(lexicon);
  if (!phrases) {
    phrases = {
      kinds: {
        accept: probePhrases(lexicon.accept),
        reject: probePhrases(lexicon.reject),
        settings: probePhrases(lexicon.settings),
        save: probePhrases(lexicon.save),
      },
      paid: probePhrases(lexicon.paid),
      acknowledge: probePhrases(lexicon.acknowledgements),
      negations: probePhrases(lexicon.negations),
    };
    phrasesCache.set(lexicon, phrases);
  }
  const probeData = loadProbeData();

  return {
    mode: 'banner',
    containers: [],
    overlays: [],
    vendorRoles: [],
    purAbo: lexicon.purAbo ?? [],
    keywords: lexicon.bannerKeywords ?? [],
    frameMode: false,
    maxButtons: MAX_BUTTONS,
    selectorAttributes: probeData.selectorAttributes,
    kindPhrases: phrases.kinds,
    paidPhrases: phrases.paid,
    acknowledgePhrases: phrases.acknowledge,
    cookieKeywords: lexicon.cookieKeywords ?? [],
    negations: phrases.negations,
    bannerContainerNames: probeData.bannerContainerNames,
    ...p,
  };
}

export async function runProbe(target: Page | Frame, args: ProbeArgs): Promise<ProbeResult> {
  return target.evaluate(cmpPageProbe, args);
}

function absoluteHref(href: string | null, base: string): string | null {
  if (!href) return null;
  const absolute = parseUrl(href, base);
  return absolute ? sanitizeUrl(absolute.toString()) : null;
}

/**
 * How the main page shows the viewport of a child frame: where the content box of its iframe starts in the main viewport,
 * and the scale of a CSS transform or zoom on the iframe or around it.
 */
export interface FrameMapping {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/** A box in the viewport of a child frame, in main-page coordinates. */
function mapBox(box: Box, map: FrameMapping): Box {
  return {
    x: map.x + box.x * map.scaleX,
    y: map.y + box.y * map.scaleY,
    width: box.width * map.scaleX,
    height: box.height * map.scaleY,
  };
}

function shift(box: Box | null, map: FrameMapping | null): Box | null {
  if (!box || !map) return box;
  const shown = mapBox(box, map);
  return {
    x: Math.round(shown.x),
    y: Math.round(shown.y),
    width: Math.round(shown.width),
    height: Math.round(shown.height),
  };
}

export function toButton(b: RawButton, lexicon: CmpLexicon, frame: FrameMapping | null = null): CmpButton {
  const vendorRole = (b.vendorRole as ButtonKind | null) ?? null;
  const { kind, kindConfidence } = classifyButton({ name: b.name, role: b.role, vendorRole }, lexicon);

  return {
    role: b.role,
    name: b.name,
    tag: b.tag,
    kind,
    kindConfidence,
    layer: b.rendered ? 1 : 2,
    box: shift(b.box, frame),
    visibleAtFirstScreen: b.visibleInViewport,
    actionableAtFirstScreen: b.actionable,
    contrast: b.contrast,
    fontSizePx: b.fontSizePx,
    ...(b.selector ? { selector: b.selector } : {}),
    vendorRole,
    inShadowDom: b.inShadowDom,
    enabled: b.enabled,
    inViewport: b.inViewport,
    hitTestOk: b.hitTestOk,
  };
}

/**
 * Whether the label names the Impressum or privacy policy, matched like `matchLegalLink` (a cookie-settings link does
 * not count). The probe holds no legal wording.
 */
function namesLegalDocument(lex: LegalLexicon, label: string): boolean {
  return LEGAL_KINDS.some((kind) => matchLegalLink(lex, kind, { text: label, path: '' }) !== null);
}

export function toMeasured(
  raw: ProbeResult,
  lexicon: CmpLexicon,
  pageUrl: string,
  opts: {
    /** The frame of a banner inside an iframe: its button boxes are given in main-page coordinates. */
    frame?: FrameMapping | null;
    blockingFrom?: ProbeResult;
    closeMeansAccept?: boolean | null;
    legal?: LegalLexicon;
  } = {},
): Measured {
  // Blocking facts come from the page that holds the banner's container: the main page for a banner inside an iframe.
  const outer = opts.blockingFrom ?? raw;
  const legal = () => opts.legal ?? loadLegalLexicon();

  const legalLinks = raw.buttons
    .filter((b) => b.role === 'link' && b.name !== '' && namesLegalDocument(legal(), b.name))
    .map((b) => ({ text: b.name, href: absoluteHref(b.href, pageUrl) }));
  const coveredFooterLinks = outer.coveredLinks
    .filter((l) => namesLegalDocument(legal(), l.label))
    .slice(0, MAX_COVERED_LEGAL_LINKS);

  const firstLayer: CmpFirstLayer = {
    bannerPresent: raw.found,
    bannerVisible: raw.found && raw.visible && outer.visible,
    buttons: raw.buttons.map((b) => toButton(b, lexicon, opts.frame ?? null)),
    purAbo: raw.purAbo,
    closeMeansAccept: opts.closeMeansAccept ?? null,
    coversFooter: coveredFooterLinks.length > 0,
    legalLinks,
    textLength: raw.textLength,
    containerBox: opts.blockingFrom ? outer.containerBox : raw.containerBox,
    containerUnambiguous: raw.found && raw.containerCount === 1,
    containerFixed: outer.containerFixed,
    buttonsTruncated: raw.buttonsTruncated,
    containerAnimating: outer.animating,
    coveredFooterLinks,
  };

  const b = outer.blocking;
  return {
    firstLayer,
    blocking: {
      overlay: b.overlay,
      scrollLock: b.scrollLock,
      inert: b.inert,
      coveredRatio: b.coveredRatio,
      method: b.method,
      ariaModal: b.ariaModal,
    },
    viewport: outer.viewport,
    raw,
  };
}

export async function measureBanner(
  page: Page,
  spec: BannerSpec,
  lexicon: CmpLexicon,
  closeMeansAccept: boolean | null = null,
): Promise<Measured> {
  const raw = await runProbe(
    page,
    probeArgs(lexicon, {
      mode: 'banner',
      containers: [...spec.containers],
      overlays: [...(spec.overlays ?? [])],
      vendorRoles: [...(spec.vendorRoles ?? [])],
      ...(spec.switches ? { switches: spec.switches } : {}),
    }),
  );

  return toMeasured(raw, lexicon, page.url(), { closeMeansAccept });
}

/**
 * The whole text of the banner container the probe measures by `spec` (the same container, found by the same rules),
 * its hidden and collapsed parts included; null when there is none. Reads only: no click, no scroll.
 */
export async function readBannerText(
  page: Page,
  spec: BannerSpec,
  lexicon: CmpLexicon,
  maxChars: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const raw = await runProbe(
    page,
    probeArgs(lexicon, {
      mode: 'banner',
      containers: [...spec.containers],
      overlays: [...(spec.overlays ?? [])],
      vendorRoles: [...(spec.vendorRoles ?? [])],
      fullTextMaxChars: maxChars,
    }),
  );
  return raw.found && raw.fullText ? raw.fullText : null;
}

interface HeuristicHit {
  frame: Frame;
  raw: ProbeResult;
  /** The iframe element of the main page that holds the frame of the hit, itself or around it; null on the main page. */
  mainFrameEl: ElementHandle | null;
  mapping: FrameMapping | null;
}

interface FrameGeometry {
  frameEl: ElementHandle;
  /** The iframe element of the main page that holds the frame: `frameEl` itself, or the outermost iframe around it. */
  mainFrameEl: ElementHandle;
  /** Box of the iframe element in the main viewport, as shown (transforms and zoom applied). */
  box: Box;
  mapping: FrameMapping;
  /**
   * The boxes of the iframe and of every iframe around it, overlapped, in main-page coordinates: a frame shows nothing
   * outside them. Null when they do not overlap.
   */
  clip: Box | null;
}

/** What `iframeLayout` reads of an iframe element in its document. */
interface IFrameElement {
  offsetWidth: number;
  offsetHeight: number;
  clientLeft: number;
  clientTop: number;
  getClientRects(): { length: number };
  getBoundingClientRect(): Box;
}

interface IFrameStyle {
  paddingLeft: string;
  paddingTop: string;
}

/**
 * An iframe element as the document that holds it shows it: its box in that document's viewport, its layout size, and
 * where its content box starts in its layout box (border and padding).
 */
interface IFrameLayout {
  box: Box;
  width: number;
  height: number;
  left: number;
  top: number;
}

/** The layout of an iframe element in its document; null when it is not rendered or cannot be read. */
async function iframeLayout(frameEl: ElementHandle): Promise<IFrameLayout | null> {
  return frameEl
    .evaluate((el) => {
      // In-page, and the project compiles without lib.dom.
      const w = globalThis as unknown as { getComputedStyle(e: unknown): IFrameStyle };
      const iframe = el as unknown as IFrameElement;
      if (iframe.getClientRects().length === 0) return null;
      const rect = iframe.getBoundingClientRect();
      const style = w.getComputedStyle(el);
      return {
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        width: iframe.offsetWidth,
        height: iframe.offsetHeight,
        left: iframe.clientLeft + (Number.parseFloat(style.paddingLeft) || 0),
        top: iframe.clientTop + (Number.parseFloat(style.paddingTop) || 0),
      };
    })
    .catch(() => null);
}

/**
 * Scale of a shown size against the layout size of the element; 1 within a pixel, since the layout size is whole
 * pixels and the shown size is not.
 */
function scaleOf(shown: number, layout: number): number {
  return layout > 0 && Math.abs(shown - layout) > 1 ? shown / layout : 1;
}

const MAIN_VIEWPORT: FrameMapping = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

/**
 * How the main page shows the viewport of a child frame, from the mapping of the frame around it: the iframe's box
 * against its layout size gives the scale of every transform and zoom on it and around it in that frame, its border
 * and padding the origin of the content box.
 */
function childMapping(outer: FrameMapping, layout: IFrameLayout): FrameMapping {
  const scaleX = scaleOf(layout.box.width, layout.width);
  const scaleY = scaleOf(layout.box.height, layout.height);
  return {
    x: outer.x + (layout.box.x + layout.left * scaleX) * outer.scaleX,
    y: outer.y + (layout.box.y + layout.top * scaleY) * outer.scaleY,
    scaleX: outer.scaleX * scaleX,
    scaleY: outer.scaleY * scaleY,
  };
}

/**
 * The iframe element of a child frame, its box in the main viewport, its mapping and its clip; null when it or an iframe
 * around it is not rendered. Each iframe is measured in the document that holds it and mapped through the frames around
 * it: for a frame of another process Playwright adds only the position of its iframe to a box, not the iframe's border,
 * padding or scale.
 */
async function frameGeometry(frame: Frame): Promise<FrameGeometry | null> {
  const chain: Frame[] = [];
  for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) chain.unshift(f);
  let geometry: FrameGeometry | null = null;
  for (const f of chain) {
    const frameEl = await f.frameElement().catch(() => null);
    const layout = frameEl ? await iframeLayout(frameEl) : null;
    if (!frameEl || !layout) return null;
    const outer: FrameMapping = geometry?.mapping ?? MAIN_VIEWPORT;
    const box = mapBox(layout.box, outer);
    if (box.width < 1 || box.height < 1) return null;
    const clip: Box | null = geometry ? geometry.clip && overlap(geometry.clip, box) : box;
    const mainFrameEl: ElementHandle = geometry?.mainFrameEl ?? frameEl;
    geometry = { frameEl, mainFrameEl, box, mapping: childMapping(outer, layout), clip };
  }
  return geometry;
}

/** A child frame with its heuristic probe (null when it failed) and the geometry of its iframe element. */
interface ChildFrameProbe {
  frame: Frame;
  raw: ProbeResult | null;
  geometry: FrameGeometry | null;
}

/** Runs the heuristic once in every child frame: the hit, the unresolved consent frame and the candidate share it. */
async function probeChildFrames(page: Page, lexicon: CmpLexicon): Promise<ChildFrameProbe[]> {
  const main = page.mainFrame();
  const out: ChildFrameProbe[] = [];
  for (const frame of page.frames()) {
    if (frame === main) continue;
    const raw = await runProbe(frame, probeArgs(lexicon, { mode: 'heuristic', frameMode: true })).catch(
      () => null,
    );
    out.push({ frame, raw, geometry: await frameGeometry(frame) });
  }
  return out;
}

/**
 * The main frame or a child frame with the highest heuristic score; the main frame wins ties. A frame's hit counts only
 * when the main page shows part of the hit at the first screen and its iframe is rendered all the way up to the main
 * page.
 */
async function bestHeuristicHit(
  page: Page,
  lexicon: CmpLexicon,
  mainRaw: ProbeResult | null,
  frames: readonly ChildFrameProbe[],
): Promise<HeuristicHit | null> {
  const main = page.mainFrame();
  let best: HeuristicHit | null = null;
  if (mainRaw?.found && mainRaw.heuristic)
    best = { frame: main, raw: mainRaw, mainFrameEl: null, mapping: null };

  const vp = mainRaw?.viewport ?? page.viewportSize();
  for (const { frame, raw, geometry } of frames) {
    if (!raw?.found || !raw.heuristic || !geometry || !vp) continue;
    if (best && raw.heuristic.score <= (best.raw.heuristic?.score ?? 0)) continue;
    // Without a box of its own (a frame body whose content is all fixed) the hit is as large as the frame's viewport.
    const own = raw.containerBox ?? { x: 0, y: 0, width: raw.viewport.width, height: raw.viewport.height };
    if (!shownInMainViewport(mapBox(own, geometry.mapping), geometry.clip, vp)) continue;
    if (!(await frameRendered(frame, lexicon))) continue;
    best = { frame, raw, mainFrameEl: geometry.mainFrameEl, mapping: geometry.mapping };
  }
  return best;
}

/**
 * The iframe element of the frame, and that of every frame around it, is rendered in its parent document as the probe
 * judges an element there (size, `visibility`, `display`, opacity of the ancestors).
 */
async function frameRendered(frame: Frame, lexicon: CmpLexicon): Promise<boolean> {
  for (let f = frame, parent = f.parentFrame(); parent; f = parent, parent = f.parentFrame()) {
    const frameEl = await f.frameElement().catch(() => null);
    if (!frameEl) return false;
    const outer = await runProbe(parent, probeArgs(lexicon, { mode: 'banner', containerEl: frameEl })).catch(
      () => null,
    );
    if (!outer?.visible) return false;
  }
  return true;
}

/**
 * The dismissed candidate most like a banner, of the main page or of a child frame; the main page wins ties. The frame
 * probe sees only its own viewport, so a frame's candidate counts only when the main page shows part of it at the first
 * screen and its iframe is rendered all the way up to the main page.
 */
async function bestRejectedCandidate(
  lexicon: CmpLexicon,
  mainRaw: ProbeResult,
  frames: readonly ChildFrameProbe[],
): Promise<BannerCandidateFact | null> {
  let best = mainRaw.rejectedCandidate;
  for (const { frame, raw, geometry } of frames) {
    const candidate = raw?.rejectedCandidate;
    if (!candidate || !geometry || (best && candidate.rank <= best.rank)) continue;
    if (!shownInMainViewport(mapBox(candidate.box, geometry.mapping), geometry.clip, mainRaw.viewport))
      continue;
    if (await frameRendered(frame, lexicon)) best = candidate;
  }
  return best?.fact ?? null;
}

function heuristicDetection(
  best: HeuristicHit,
  heuristic: { score: number; signals: string[] },
): CmpDetection {
  return {
    cmpId: null,
    method: 'heuristic',
    version: null,
    versionSupported: null,
    // A heuristic is never `high`: it only feeds `banner-not-recognized`.
    recognitionConfidence: heuristic.score >= 5 ? 'medium' : 'low',
    signals: [...heuristic.signals, ...(best.mainFrameEl ? ['heuristic:frame'] : [])],
    ...(best.mainFrameEl ? { frameUrl: sanitizeUrl(best.frame.url()) } : {}),
  };
}

export interface HeuristicOutcome {
  hit: { measured: Measured; detection: CmpDetection } | null;
  /**
   * Without a hit: the best banner-shaped element the heuristic dismissed on the main page or in a child frame shown at
   * the first screen, null when it saw none. Absent when the probe of the main page failed.
   */
  candidate?: BannerCandidateFact | null;
}

export async function measureHeuristic(
  page: Page,
  lexicon: CmpLexicon,
): Promise<{ measured: Measured; detection: CmpDetection } | null> {
  return (await probeHeuristic(page, lexicon)).hit;
}

/** The generic heuristic over the main page and its frames, with the dismissed candidate when it found nothing. */
export async function probeHeuristic(page: Page, lexicon: CmpLexicon): Promise<HeuristicOutcome> {
  const main = page.mainFrame();
  const mainRaw = await runProbe(main, probeArgs(lexicon, { mode: 'heuristic' })).catch(() => null);
  const frames = await probeChildFrames(page, lexicon);

  const best = await bestHeuristicHit(page, lexicon, mainRaw, frames);
  if (!best?.raw.heuristic) {
    const frame = await unresolvedConsentFrame(page, lexicon, mainRaw, frames);
    if (frame || !mainRaw) return { hit: frame };
    return { hit: null, candidate: await bestRejectedCandidate(lexicon, mainRaw, frames) };
  }

  // Blocking is measured on the main page, with its iframe element that holds the banner as the container.
  let blockingFrom: ProbeResult | undefined;
  if (best.mainFrameEl) {
    blockingFrom = await runProbe(
      main,
      probeArgs(lexicon, { mode: 'banner', containerEl: best.mainFrameEl }),
    ).catch(() => undefined);
  }

  const measured = toMeasured(best.raw, lexicon, best.frame.url(), { frame: best.mapping, blockingFrom });
  return { hit: { measured, detection: heuristicDetection(best, best.raw.heuristic) } };
}

/** The overlap of two boxes; null when they do not overlap. */
function overlap(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * The part of `box` (in main-page coordinates) of the content of a child frame that the main viewport shows: cut to the
 * clip of the frame, its iframe and every iframe around it, and to the viewport. Null when nothing of it is shown.
 */
function shownInMainViewport(box: Box, clip: Box | null, vp: Viewport): Box | null {
  const shown = clip && overlap(box, clip);
  return shown && overlap(shown, { x: 0, y: 0, width: vp.width, height: vp.height });
}

/** Share of the viewport that the box covers; 0 when it lies outside. */
function viewportShare(box: Box, vp: Viewport): number {
  const w = Math.min(vp.width, box.x + box.width) - Math.max(0, box.x);
  const h = Math.min(vp.height, box.y + box.height) - Math.max(0, box.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (vp.width * vp.height);
}

/** Tests a text against the banner keywords of the lexicon; an invalid pattern matches nothing. */
function keywordHint(lexicon: CmpLexicon): (text: string | null) => boolean {
  const patterns: RegExp[] = [];
  for (const k of lexicon.bannerKeywords ?? []) {
    try {
      patterns.push(new RegExp(k, 'iu'));
    } catch {
      // an invalid pattern matches nothing (the lexicon test compiles every source)
    }
  }
  return (text) => text !== null && patterns.some((p) => p.test(text.toLowerCase()));
}

function consentFrameMeasured(
  box: Box,
  vp: Viewport,
  outer: ProbeResult | null,
  raw: ProbeResult | null,
): Measured {
  return {
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
      coversFooter: false,
      legalLinks: [],
      textLength: 0,
      containerBox: outer?.containerBox ?? {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      containerUnambiguous: true,
      containerFixed: outer?.containerFixed ?? false,
      containerAnimating: outer?.animating ?? false,
      consentFrameUnresolved: true,
    },
    blocking: {
      overlay: outer?.blocking.overlay ?? false,
      scrollLock: outer?.blocking.scrollLock ?? false,
      inert: outer?.blocking.inert ?? false,
      coveredRatio: outer?.blocking.coveredRatio ?? null,
      method: outer?.blocking.method ?? [],
      ariaModal: outer?.blocking.ariaModal ?? false,
    },
    viewport: vp,
    ...(raw ? { raw } : {}),
  };
}

function consentFrameDetection(frame: Frame, byAttribute: boolean, hits: number): CmpDetection {
  return {
    cmpId: null,
    method: 'heuristic',
    version: null,
    versionSupported: null,
    recognitionConfidence: 'low',
    signals: [
      'heuristic:frame-candidate',
      'heuristic:frame',
      ...(byAttribute ? ['heuristic:frame-label'] : []),
      ...(hits > 0 ? [`heuristic:keywords:${hits}`] : []),
    ],
    frameUrl: sanitizeUrl(frame.url()),
  };
}

/**
 * A visible iframe covering half the viewport that looks like a consent dialog (title, aria-label, name or two
 * keyword hits in its body) but holds no banner the probe could read: reported as a candidate, never clicked.
 */
async function unresolvedConsentFrame(
  page: Page,
  lexicon: CmpLexicon,
  mainRaw: ProbeResult | null,
  frames: readonly ChildFrameProbe[],
): Promise<{ measured: Measured; detection: CmpDetection } | null> {
  const main = page.mainFrame();
  const vp = mainRaw?.viewport ?? page.viewportSize() ?? { width: 0, height: 0 };
  if (vp.width < 1 || vp.height < 1) return null;

  const hint = keywordHint(lexicon);
  for (const { frame, raw: inner, geometry } of frames) {
    if (!geometry) continue;
    const { frameEl, box } = geometry;
    // A nested iframe shows only what the iframes around it show.
    const shown = shownInMainViewport(box, geometry.clip, vp);
    if (!shown || viewportShare(shown, vp) < FRAME_CANDIDATE_MIN_SHARE) continue;
    if (!(await frameEl.isVisible().catch(() => false))) continue;

    const attrs = await Promise.all(
      FRAME_HINT_ATTRIBUTES.map((a) => frameEl.getAttribute(a).catch(() => null)),
    );
    const byAttribute = attrs.some((a) => hint(a));
    const hits = inner?.keywordHits.length ?? 0;
    // The body wording alone needs two keywords: one "Privacy" link in a large booking frame is no consent dialog.
    if (!byAttribute && hits < MIN_BODY_KEYWORDS) continue;

    const outer = await runProbe(main, probeArgs(lexicon, { mode: 'banner', containerEl: frameEl })).catch(
      () => null,
    );
    return {
      measured: consentFrameMeasured(box, vp, outer, outer ?? inner ?? mainRaw),
      detection: consentFrameDetection(frame, byAttribute, hits),
    };
  }
  return null;
}
