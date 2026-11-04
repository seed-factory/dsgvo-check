/** Node side of the in-page probe: runs it in a frame and turns raw facts into `CmpFirstLayer` / `BlockingFacts`. */
import type { ElementHandle, Frame, Page } from 'playwright-core';
import { LEGAL_KINDS, type LegalLexicon, matchLegalLink } from '../../collectors/browser/legal/lexicon.ts';
import { loadLegalLexicon } from '../../collectors/browser/legal/lexicon-file.ts';
import type { Box, Viewport } from '../../core/snapshot/common.ts';
import { parseUrl, sanitizeUrl } from '../../core/url/url.ts';
import { loadProbeData } from '../adapters-file.ts';
import { classifyButton, labelTokens, normalizeLabel } from '../lexicon.ts';
import type {
  BlockingFacts,
  ButtonKind,
  CmpButton,
  CmpDetection,
  CmpFirstLayer,
  CmpLexicon,
} from '../types.ts';
import { cmpPageProbe } from './probe.ts';
import type { ProbeArgs, ProbeResult, RawButton } from './probe-types.ts';

export interface BannerSpec {
  containers: readonly string[];
  overlays?: readonly string[];
  vendorRoles?: ReadonlyArray<{ selector: string; role: ButtonKind }>;
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

function phrasesOf(
  lexicon: CmpLexicon,
  kinds: ReadonlyArray<'accept' | 'reject' | 'settings' | 'save'>,
): string[] {
  const out = new Set<string>();
  for (const kind of kinds) {
    for (const phrase of lexicon[kind]) {
      if (phrase.startsWith('*')) {
        const suffix = normalizeLabel(phrase.slice(1));
        if (suffix) out.add(`*${suffix}`);
      } else {
        const tokens = labelTokens(phrase);
        if (tokens.length > 0) out.add(tokens.join(' '));
      }
    }
  }
  return [...out];
}

/** `control`: classes that offer a choice (accept, reject, settings, save); `choice`: accept and reject only. */
const phrasesCache = new WeakMap<CmpLexicon, { control: string[]; choice: string[] }>();

function probeArgs(lexicon: CmpLexicon, p: Partial<ProbeArgs>): ProbeArgs {
  let phrases = phrasesCache.get(lexicon);
  if (!phrases) {
    phrases = {
      control: phrasesOf(lexicon, ['accept', 'reject', 'settings', 'save']),
      choice: phrasesOf(lexicon, ['accept', 'reject']),
    };
    phrasesCache.set(lexicon, phrases);
  }

  return {
    mode: 'banner',
    containers: [],
    overlays: [],
    vendorRoles: [],
    purAbo: lexicon.purAbo ?? [],
    keywords: lexicon.bannerKeywords ?? [],
    frameMode: false,
    maxButtons: MAX_BUTTONS,
    selectorAttributes: loadProbeData().selectorAttributes,
    controlPhrases: phrases.control,
    choicePhrases: phrases.choice,
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

function shift(box: Box | null, offset: { x: number; y: number } | null): Box | null {
  if (!box || !offset) return box;
  return { ...box, x: Math.round(box.x + offset.x), y: Math.round(box.y + offset.y) };
}

export function toButton(
  b: RawButton,
  lexicon: CmpLexicon,
  offset: { x: number; y: number } | null = null,
): CmpButton {
  const vendorRole = (b.vendorRole as ButtonKind | null) ?? null;
  const { kind, kindConfidence } = classifyButton({ name: b.name, role: b.role, vendorRole }, lexicon);

  return {
    role: b.role,
    name: b.name,
    tag: b.tag,
    kind,
    kindConfidence,
    layer: b.rendered ? 1 : 2,
    box: shift(b.box, offset),
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
    offset?: { x: number; y: number } | null;
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
    buttons: raw.buttons.map((b) => toButton(b, lexicon, opts.offset ?? null)),
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
    }),
  );

  return toMeasured(raw, lexicon, page.url(), { closeMeansAccept });
}

interface HeuristicHit {
  frame: Frame;
  raw: ProbeResult;
  frameEl: ElementHandle | null;
  offset: { x: number; y: number } | null;
}

/** The iframe element of a child frame and its box in the main viewport; null when it is not rendered. */
async function frameGeometry(frame: Frame): Promise<{ frameEl: ElementHandle; box: Box } | null> {
  const frameEl = await frame.frameElement().catch(() => null);
  const box = frameEl ? await frameEl.boundingBox().catch(() => null) : null;
  if (!frameEl || !box || box.width < 1 || box.height < 1) return null;
  return { frameEl, box };
}

/** The main frame or a rendered child frame with the highest heuristic score; the main frame wins ties. */
async function bestHeuristicHit(
  page: Page,
  lexicon: CmpLexicon,
  mainRaw: ProbeResult | null,
): Promise<HeuristicHit | null> {
  const main = page.mainFrame();
  let best: HeuristicHit | null = null;
  if (mainRaw?.found && mainRaw.heuristic) best = { frame: main, raw: mainRaw, frameEl: null, offset: null };

  for (const frame of page.frames()) {
    if (frame === main) continue;

    const raw = await runProbe(frame, probeArgs(lexicon, { mode: 'heuristic', frameMode: true })).catch(
      () => null,
    );
    if (!raw?.found || !raw.heuristic) continue;

    const geometry = await frameGeometry(frame);
    if (!geometry) continue;
    if (!best || raw.heuristic.score > (best.raw.heuristic?.score ?? 0)) {
      best = { frame, raw, frameEl: geometry.frameEl, offset: { x: geometry.box.x, y: geometry.box.y } };
    }
  }
  return best;
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
    signals: [...heuristic.signals, ...(best.frameEl ? ['heuristic:frame'] : [])],
    ...(best.frameEl ? { frameUrl: sanitizeUrl(best.frame.url()) } : {}),
  };
}

export async function measureHeuristic(
  page: Page,
  lexicon: CmpLexicon,
): Promise<{ measured: Measured; detection: CmpDetection } | null> {
  const main = page.mainFrame();
  const mainRaw = await runProbe(main, probeArgs(lexicon, { mode: 'heuristic' })).catch(() => null);

  const best = await bestHeuristicHit(page, lexicon, mainRaw);
  if (!best?.raw.heuristic) return unresolvedConsentFrame(page, lexicon, mainRaw);

  // Blocking is measured on the main page, with the iframe element as the banner container.
  let blockingFrom: ProbeResult | undefined;
  if (best.frameEl) {
    blockingFrom = await runProbe(
      main,
      probeArgs(lexicon, { mode: 'banner', containerEl: best.frameEl }),
    ).catch(() => undefined);
  }

  const measured = toMeasured(best.raw, lexicon, best.frame.url(), { offset: best.offset, blockingFrom });
  return { measured, detection: heuristicDetection(best, best.raw.heuristic) };
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
): Promise<{ measured: Measured; detection: CmpDetection } | null> {
  const main = page.mainFrame();
  const vp = mainRaw?.viewport ?? page.viewportSize() ?? { width: 0, height: 0 };
  if (vp.width < 1 || vp.height < 1) return null;

  const hint = keywordHint(lexicon);
  for (const frame of page.frames()) {
    if (frame === main) continue;

    const geometry = await frameGeometry(frame);
    if (!geometry) continue;
    const { frameEl, box } = geometry;
    if (viewportShare(box, vp) < FRAME_CANDIDATE_MIN_SHARE) continue;
    if (!(await frameEl.isVisible().catch(() => false))) continue;

    const attrs = await Promise.all(
      FRAME_HINT_ATTRIBUTES.map((a) => frameEl.getAttribute(a).catch(() => null)),
    );
    const byAttribute = attrs.some((a) => hint(a));
    const inner = await runProbe(frame, probeArgs(lexicon, { mode: 'heuristic', frameMode: true })).catch(
      () => null,
    );
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
