/** Pure table over first-screen `CmpFacts` (no page access); it also picks the only elements the collector may click. */
import { classifyButton, isLinkRole, normalizeLabel } from './lexicon.ts';
import type {
  BlockingFacts,
  CmpButton,
  CmpFacts,
  CmpLexicon,
  Confidence,
  FirstLayerClassification,
  FirstLayerVariant,
} from './types.ts';

export const BLOCKING_COVERED_RATIO = 0.85;

/** Blocking as measured: overlay, scroll lock on html/body, inert content or the banner covering ≥ 85 %. */
export function isBlocking(b: BlockingFacts): boolean {
  return b.overlay || b.inert || b.scrollLock || (b.coveredRatio ?? 0) >= BLOCKING_COVERED_RATIO;
}

function pickTarget(candidates: CmpButton[]): { target: CmpButton | null; ambiguous: boolean } {
  const usable = candidates.filter((b) => b.actionableAtFirstScreen && b.selector);
  if (usable.length === 1) return { target: usable[0] ?? null, ambiguous: false };
  const high = usable.filter((b) => b.kindConfidence === 'high');
  if (high.length === 1) return { target: high[0] ?? null, ambiguous: false };
  return { target: null, ambiguous: usable.length > 1 };
}

export function classifyFirstLayer(facts: CmpFacts, lexicon: CmpLexicon): FirstLayerClassification {
  const det = facts.detection;
  const fl = facts.firstLayer;
  const buttons: CmpButton[] = fl.buttons.map((b) => ({ ...b, ...classifyButton(b, lexicon) }));
  const blocking = isBlocking(facts.blocking);
  const first = buttons.filter((b) => b.layer === 1);
  const acceptActionable = first.filter((b) => b.kind === 'accept' && b.actionableAtFirstScreen);
  const common = {
    flags: fl.purAbo ? (['pur-abo'] as Array<'pur-abo'>) : [],
    blocking,
    buttons,
    lexiconVersion: lexicon.version,
    acceptAvailableAtFirstLayer: acceptActionable.length > 0,
  };
  const unrecognized = (variant: FirstLayerVariant, reasons: string[]): FirstLayerClassification => ({
    variant,
    confidence: 'low',
    reasons,
    targets: { reject: null, accept: null },
    ...common,
  });

  if (det.method === 'none') return unrecognized('banner-not-recognized', ['no-banner-detected']);
  if (det.method !== 'adapter' || !det.cmpId)
    return unrecognized('banner-not-recognized', ['heuristic-only']);
  if (det.versionSupported === false) {
    return unrecognized('cmp-not-supported', [`version-out-of-range:${det.version ?? 'unknown'}`]);
  }
  if (det.recognitionConfidence !== 'high') {
    return unrecognized('banner-not-recognized', [`recognition-${det.recognitionConfidence}`]);
  }
  if (!fl.bannerPresent || !fl.bannerVisible)
    return unrecognized('banner-not-recognized', ['banner-not-visible']);

  const rejects = first.filter((b) => b.kind === 'reject');
  const rejectActionable = rejects.filter((b) => b.actionableAtFirstScreen);
  const rejectButtons = rejectActionable.filter((b) => !isLinkRole(b.role));
  const acceptButtons = acceptActionable.filter((b) => !isLinkRole(b.role));
  const closes = first.filter((b) => b.kind === 'close' && b.visibleAtFirstScreen);
  // In a pay-or-OK banner the subscription button is a known control (the paid alternative), not an unknown one.
  const subscription = fl.purAbo ? purAboMatcher(lexicon) : null;
  const unclassified = first.filter((b) => b.kind === 'other' && !subscription?.(b.name));
  const relabelled = first.filter((b) => b.vendorRole === 'reject' && b.kind !== 'reject');
  const closeMeansAccept = fl.closeMeansAccept === true && closes.length > 0;

  const reasons: string[] = [];
  if (unclassified.length > 0) reasons.push(`unclassified-buttons:${unclassified.length}`);
  if (relabelled.length > 0) reasons.push(`vendor-reject-relabelled:${relabelled.length}`);
  const uncertain = unclassified.length > 0 || relabelled.length > 0;
  const anyHigh = (list: CmpButton[]) => list.some((b) => b.kindConfidence === 'high');

  let variant: FirstLayerVariant;
  let confidence: Confidence = 'high';
  if (rejects.length === 0) {
    if (blocking && acceptActionable.length > 0) {
      variant = 'blocking-no-reject';
      if (!anyHigh(acceptActionable)) confidence = 'medium';
    } else if (closeMeansAccept) {
      variant = 'close-means-accept';
      if (!anyHigh(closes)) confidence = 'medium';
    } else if (blocking) {
      variant = 'no-choice-at-first-layer';
    } else {
      variant = 'nonblocking-no-reject';
    }
    if (uncertain) confidence = 'medium';
  } else if (closeMeansAccept) {
    variant = 'close-means-accept';
    if (!anyHigh(closes)) confidence = 'medium';
  } else if (rejectActionable.length === 0) {
    variant = 'reject-not-actionable';
    if (!anyHigh(rejects)) confidence = 'medium';
    reasons.push(...rejects.map((b) => `reject-not-actionable:${notActionableReason(b)}`));
  } else if (rejectButtons.length === 0 && acceptButtons.length > 0) {
    variant = 'reject-as-link';
  } else {
    variant = 'ok';
  }
  if (fl.purAbo && variant === 'ok') variant = 'pur-abo';

  const reject = pickTarget(rejectButtons.length > 0 ? rejectButtons : rejectActionable);
  const accept = pickTarget(acceptButtons.length > 0 ? acceptButtons : acceptActionable);
  if (reject.ambiguous) reasons.push('reject-target-ambiguous');
  if (accept.ambiguous) reasons.push('accept-target-ambiguous');

  // A verdict about a missing or broken reject needs every first-layer button classified (an unknown one might be the
  // reject) and a complete, settled measurement. The accept stays a target; no reject is clicked.
  const noVerdict: string[] = [];
  if (AMBIGUOUS_WITH_UNKNOWN_BUTTON.has(variant)) {
    if (unclassified.length > 0) noVerdict.push(`ambiguous-first-layer:${variant}`);
    if (fl.buttonsTruncated === true) noVerdict.push('buttons-truncated');
  }
  if (
    fl.geometryUnsettled === true &&
    variant === 'reject-not-actionable' &&
    rejects.every((b) => notActionableReason(b) !== 'disabled')
  ) {
    noVerdict.push('geometry-unsettled');
  }
  if (noVerdict.length > 0) {
    return {
      variant: 'banner-not-recognized',
      confidence: 'low',
      reasons: [...reasons, ...noVerdict],
      targets: { reject: null, accept: accept.target },
      ...common,
    };
  }

  return {
    variant,
    confidence,
    reasons,
    targets: { reject: reject.target, accept: accept.target },
    ...common,
  };
}

/** Variants that claim "no (usable) reject button" and therefore depend on knowing every first-layer button. */
const AMBIGUOUS_WITH_UNKNOWN_BUTTON: ReadonlySet<FirstLayerVariant> = new Set([
  'blocking-no-reject',
  'no-choice-at-first-layer',
  'nonblocking-no-reject',
  'reject-not-actionable',
  'reject-as-link',
]);

function purAboMatcher(lexicon: CmpLexicon): (label: string) => boolean {
  const patterns: RegExp[] = [];
  for (const src of lexicon.purAbo ?? []) {
    try {
      patterns.push(new RegExp(src, 'iu'));
    } catch {
      // An invalid pattern matches nothing (the lexicon test compiles every source).
    }
  }
  return (label) => {
    const text = normalizeLabel(label);
    return patterns.some((p) => p.test(text));
  };
}

function notActionableReason(b: CmpButton): string {
  if (b.enabled === false) return 'disabled';
  if (b.inViewport === false || !b.visibleAtFirstScreen) return 'outside-viewport';
  if (b.hitTestOk === false) return 'covered';
  return 'unknown';
}
