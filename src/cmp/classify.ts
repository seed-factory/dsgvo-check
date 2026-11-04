/** Pure table over first-screen `CmpFacts` (no page access); it also picks the only elements the collector may click. */
import { classifyButton, isLinkRole, normalizeLabel } from './lexicon.ts';
import type {
  BlockingFacts,
  CmpButton,
  CmpDetection,
  CmpFacts,
  CmpFirstLayer,
  CmpLexicon,
  Confidence,
  FirstLayerClassification,
  FirstLayerVariant,
} from './types.ts';

/** Variants that claim "no (usable) reject button" and therefore depend on knowing every first-layer button. */
const AMBIGUOUS_WITH_UNKNOWN_BUTTON: ReadonlySet<FirstLayerVariant> = new Set([
  'blocking-no-reject',
  'no-choice-at-first-layer',
  'nonblocking-no-reject',
  'reject-not-actionable',
  'reject-as-link',
]);

/** What the caller decides: the table itself holds no setting, so a check reads it from `ctx.thresholds`. */
export interface ClassifyOptions {
  /** Share of the viewport that makes a banner blocking (`cmp.blockingCoveredRatio`). */
  blockingCoveredRatio: number;
}

/** Blocking as measured: overlay, scroll lock on html/body, inert content or the banner covering at least `coveredRatio` of the viewport. */
export function isBlocking(b: BlockingFacts, coveredRatio: number): boolean {
  return b.overlay || b.inert || b.scrollLock || (b.coveredRatio ?? 0) >= coveredRatio;
}

function pickTarget(candidates: CmpButton[]): { target: CmpButton | null; ambiguous: boolean } {
  const usable = candidates.filter((b) => b.actionableAtFirstScreen && b.selector);
  if (usable.length === 1) return { target: usable[0] ?? null, ambiguous: false };
  const high = usable.filter((b) => b.kindConfidence === 'high');
  if (high.length === 1) return { target: high[0] ?? null, ambiguous: false };
  return { target: null, ambiguous: usable.length > 1 };
}

/** Why the facts cannot be classified at all (no recognition at `high`, no visible banner); null when they can. */
function unclassifiable(
  det: CmpDetection,
  fl: CmpFirstLayer,
): { variant: FirstLayerVariant; reasons: string[] } | null {
  if (det.method === 'none') return { variant: 'banner-not-recognized', reasons: ['no-banner-detected'] };
  if (det.method !== 'adapter' || !det.cmpId) {
    return { variant: 'banner-not-recognized', reasons: ['heuristic-only'] };
  }
  if (det.versionSupported === false) {
    return { variant: 'cmp-not-supported', reasons: [`version-out-of-range:${det.version ?? 'unknown'}`] };
  }
  if (det.recognitionConfidence !== 'high') {
    return { variant: 'banner-not-recognized', reasons: [`recognition-${det.recognitionConfidence}`] };
  }
  if (!fl.bannerPresent || !fl.bannerVisible) {
    return { variant: 'banner-not-recognized', reasons: ['banner-not-visible'] };
  }
  return null;
}

/** The first-layer buttons by what they could do: reject or accept (actionable, as button or link), close. */
function groupFirstLayer(first: CmpButton[]) {
  const rejects = first.filter((b) => b.kind === 'reject');
  const rejectActionable = rejects.filter((b) => b.actionableAtFirstScreen);
  const acceptActionable = first.filter((b) => b.kind === 'accept' && b.actionableAtFirstScreen);
  return {
    rejects,
    rejectActionable,
    rejectButtons: rejectActionable.filter((b) => !isLinkRole(b.role)),
    acceptActionable,
    acceptButtons: acceptActionable.filter((b) => !isLinkRole(b.role)),
    closes: first.filter((b) => b.kind === 'close' && b.visibleAtFirstScreen),
  };
}

/**
 * The variant for a recognized, visible banner, with the confidence and the reasons it adds. `uncertain`: a first-layer
 * button is unclassified or a vendor reject was relabelled, which lowers the confidence of a missing reject.
 */
function chooseVariant(
  g: ReturnType<typeof groupFirstLayer>,
  state: { blocking: boolean; closeMeansAccept: boolean; uncertain: boolean },
): { variant: FirstLayerVariant; confidence: Confidence; reasons: string[] } {
  const anyHigh = (list: CmpButton[]) => list.some((b) => b.kindConfidence === 'high');
  const reasons: string[] = [];
  let variant: FirstLayerVariant;
  let confidence: Confidence = 'high';

  if (g.rejects.length === 0) {
    if (state.blocking && g.acceptActionable.length > 0) {
      variant = 'blocking-no-reject';
      if (!anyHigh(g.acceptActionable)) confidence = 'medium';
    } else if (state.closeMeansAccept) {
      variant = 'close-means-accept';
      if (!anyHigh(g.closes)) confidence = 'medium';
    } else if (state.blocking) {
      variant = 'no-choice-at-first-layer';
    } else {
      variant = 'nonblocking-no-reject';
    }
    if (state.uncertain) confidence = 'medium';
  } else if (state.closeMeansAccept) {
    variant = 'close-means-accept';
    if (!anyHigh(g.closes)) confidence = 'medium';
  } else if (g.rejectActionable.length === 0) {
    variant = 'reject-not-actionable';
    if (!anyHigh(g.rejects)) confidence = 'medium';
    reasons.push(...g.rejects.map((b) => `reject-not-actionable:${notActionableReason(b)}`));
  } else if (g.rejectButtons.length === 0 && g.acceptButtons.length > 0) {
    variant = 'reject-as-link';
  } else {
    variant = 'ok';
  }

  return { variant, confidence, reasons };
}

/**
 * A verdict about a missing or broken reject needs every first-layer button classified (an unknown one might be the
 * reject) and a complete, settled measurement; these are the reasons it lacks one.
 */
function missingVerdictReasons(
  variant: FirstLayerVariant,
  fl: CmpFirstLayer,
  rejects: CmpButton[],
  unclassified: CmpButton[],
): string[] {
  const reasons: string[] = [];
  if (AMBIGUOUS_WITH_UNKNOWN_BUTTON.has(variant)) {
    if (unclassified.length > 0) reasons.push(`ambiguous-first-layer:${variant}`);
    if (fl.buttonsTruncated === true) reasons.push('buttons-truncated');
  }
  if (
    fl.geometryUnsettled === true &&
    variant === 'reject-not-actionable' &&
    rejects.every((b) => notActionableReason(b) !== 'disabled')
  ) {
    reasons.push('geometry-unsettled');
  }
  return reasons;
}

export function classifyFirstLayer(
  facts: CmpFacts,
  lexicon: CmpLexicon,
  options: ClassifyOptions,
): FirstLayerClassification {
  const fl = facts.firstLayer;
  const buttons: CmpButton[] = fl.buttons.map((b) => ({ ...b, ...classifyButton(b, lexicon) }));
  const blocking = isBlocking(facts.blocking, options.blockingCoveredRatio);
  const first = buttons.filter((b) => b.layer === 1);
  const groups = groupFirstLayer(first);

  const common = {
    flags: fl.purAbo ? (['pur-abo'] as Array<'pur-abo'>) : [],
    blocking,
    buttons,
    lexiconVersion: lexicon.version,
    acceptAvailableAtFirstLayer: groups.acceptActionable.length > 0,
  };
  const unrecognized = (variant: FirstLayerVariant, reasons: string[]): FirstLayerClassification => ({
    variant,
    confidence: 'low',
    reasons,
    targets: { reject: null, accept: null },
    ...common,
  });

  const early = unclassifiable(facts.detection, fl);
  if (early) return unrecognized(early.variant, early.reasons);

  // In a pay-or-OK banner the subscription button is a known control (the paid alternative), not an unknown one.
  const subscription = fl.purAbo ? purAboMatcher(lexicon) : null;
  const unclassified = first.filter((b) => b.kind === 'other' && !subscription?.(b.name));
  const relabelled = first.filter((b) => b.vendorRole === 'reject' && b.kind !== 'reject');

  const reasons: string[] = [];
  if (unclassified.length > 0) reasons.push(`unclassified-buttons:${unclassified.length}`);
  if (relabelled.length > 0) reasons.push(`vendor-reject-relabelled:${relabelled.length}`);

  const chosen = chooseVariant(groups, {
    blocking,
    closeMeansAccept: fl.closeMeansAccept === true && groups.closes.length > 0,
    uncertain: unclassified.length > 0 || relabelled.length > 0,
  });
  reasons.push(...chosen.reasons);
  const variant = fl.purAbo && chosen.variant === 'ok' ? 'pur-abo' : chosen.variant;

  const reject = pickTarget(groups.rejectButtons.length > 0 ? groups.rejectButtons : groups.rejectActionable);
  const accept = pickTarget(groups.acceptButtons.length > 0 ? groups.acceptButtons : groups.acceptActionable);
  if (reject.ambiguous) reasons.push('reject-target-ambiguous');
  if (accept.ambiguous) reasons.push('accept-target-ambiguous');

  // No verdict: the accept stays a target, no reject is clicked.
  const noVerdict = missingVerdictReasons(variant, fl, groups.rejects, unclassified);
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
    confidence: chosen.confidence,
    reasons,
    targets: { reject: reject.target, accept: accept.target },
    ...common,
  };
}

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
