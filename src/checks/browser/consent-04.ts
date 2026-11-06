/**
 * CONSENT-04 (P0): first layer of the consent dialog and whether the reject works. The verdict comes only from the
 * pure `classifyFirstLayer` for a CMP recognised with `high`; otherwise `banner-not-recognized` or `cmp-not-supported`.
 */
import { adaptersSection, essentialCategorySection } from '../../cmp/adapters-data.ts';
import { type ClassifyOptions, classifyFirstLayer } from '../../cmp/classify.ts';
import { lexiconFromData } from '../../cmp/lexicon.ts';
import type {
  CmpFacts,
  CmpLexicon,
  CmpPhaseFacts,
  CmpSection,
  ConsentStateFact,
  FirstLayerClassification,
} from '../../cmp/types.ts';
import {
  type CheckContext,
  type CheckOutcome,
  defineCheck,
  type EvidenceInput,
  type Observation,
  type Phase,
  type ScanPlan,
  subjects,
} from '../../core/api.ts';
import type { BrowserPlan, BrowserSection } from '../../core/snapshot/browser.ts';
import { pageEvidence } from './evidence.ts';
import {
  allCmpFacts,
  bannerFound,
  bannerUndetermined,
  consentSignals,
  dialogNotOpenedOutcome,
  signalOutcome,
  type UnrecognizedBanner,
  unrecognizedBanner,
} from './signals.ts';
import { phaseRecord, startPageUrl } from './snapshot.ts';

const ID = 'CONSENT-04';

export const CONSENT04_VARIANTS = [
  'blocking-no-reject',
  'close-means-accept',
  'reject-not-actionable',
  'reject-ineffective',
  'consent-without-action',
  'reject-as-link',
  'nonblocking-no-reject',
  'no-choice-at-first-layer',
  'pur-abo',
  'banner-not-recognized',
  'cmp-not-supported',
] as const;
type Variant = (typeof CONSENT04_VARIANTS)[number];

const EMPTY_LEXICON: CmpLexicon = {
  version: 'none',
  accept: [],
  reject: [],
  settings: [],
  save: [],
  close: [],
  later: [],
  hide: [],
};

/** Lexicon from test/data/cmp: `lexicon:` block or the top level; null when the shape is invalid. */
export function lexiconFrom(data: unknown): CmpLexicon | null {
  try {
    return lexiconFromData(data);
  } catch {
    return null;
  }
}

export type FirstLayerClassifier = (
  facts: CmpFacts,
  lexicon: CmpLexicon,
  options: ClassifyOptions,
) => FirstLayerClassification;

/**
 * Only an own adapter with `high` recognition ranks above the heuristic: below `high` it is as much a hint as the
 * heuristic, and its fact may be empty on a page where the banner is hidden.
 */
function rankOf(d: CmpFacts['detection']): number {
  if (d.method === 'none') return 0;
  return d.method === 'adapter' && d.recognitionConfidence === 'high' ? 2 : 1;
}

/** The facts the verdict is based on: best detection, first screen of B, then A, then C. */
function primaryFacts(cmp: CmpSection, start: string | null): CmpFacts | null {
  const pref = (p: CmpPhaseFacts['phase'], f: CmpFacts) => {
    if (p === 'B' && f.moment === 'first-screen') return 0;
    if (p === 'A') return 1;
    if (p === 'C' && f.moment === 'first-screen') return 2;
    return 3;
  };
  // Among sources of the same weak rank a visible banner (buttons, screenshot) beats a fact without one.
  const shown = (f: CmpFacts) => (rankOf(f.detection) === 1 ? Number(f.firstLayer.bannerVisible) : 0);
  const candidates = cmp.phases.flatMap((p) => p.facts.map((f) => ({ f, pref: pref(p.phase, f) })));
  candidates.sort(
    (a, b) =>
      rankOf(b.f.detection) - rankOf(a.f.detection) ||
      shown(b.f) - shown(a.f) ||
      a.pref - b.pref ||
      Number(b.f.pageUrl === start) - Number(a.f.pageUrl === start),
  );
  return candidates[0]?.f ?? null;
}

/** Consent categories treated as essential when deciding "granted without action" (test/data/cmp/categories.yaml). */
function grantedWithoutAction(
  cmp: CmpSection,
  essential: RegExp,
): Array<{ facts: CmpFacts; state: ConsentStateFact }> {
  const out: Array<{ facts: CmpFacts; state: ConsentStateFact }> = [];
  for (const p of cmp.phases) {
    for (const f of p.facts) {
      if (p.phase !== 'A' && f.moment !== 'first-screen') continue;
      for (const s of f.state) {
        if (s.ready !== 'ready' || (s.origin !== 'default' && s.origin !== 'stored')) continue;
        if (Object.entries(s.categories).some(([k, v]) => v === 'granted' && !essential.test(k)))
          out.push({ facts: f, state: s });
      }
    }
  }
  return out;
}

function cmpEvidence(f: CmpFacts, plan: BrowserPlan | null): EvidenceInput {
  const click = plan?.click.B;
  return {
    type: 'cmp',
    cmpId: f.detection.cmpId,
    version: f.detection.version,
    recognitionConfidence: f.detection.recognitionConfidence,
    phase: f.phase,
    page: f.pageUrl,
    buttons: f.firstLayer.buttons.map((b) => ({
      role: b.role,
      name: b.name,
      kind: b.kind,
      kindConfidence: b.kindConfidence,
      vendorRole: b.vendorRole ?? null,
      box: b.box,
      visibleAtFirstScreen: b.visibleAtFirstScreen,
      actionableAtFirstScreen: b.actionableAtFirstScreen,
      contrast: b.contrast,
    })),
    blocking: {
      overlay: f.blocking.overlay,
      scrollLock: f.blocking.scrollLock,
      inert: f.blocking.inert,
      coveredRatio: f.blocking.coveredRatio,
      method: f.blocking.method,
    },
    viewport: f.viewport,
    click: click?.target ? { kind: click.action, name: click.target.name } : null,
  };
}

function stateEvidence(s: ConsentStateFact, f: Pick<CmpFacts, 'phase' | 'pageUrl'>): EvidenceInput {
  return {
    type: 'consent-state',
    source: s.source,
    ready: s.ready,
    categories: s.categories,
    origin: s.origin,
    phase: f.phase,
    page: f.pageUrl,
    ...(s.scope ? { scope: s.scope } : {}),
  };
}

/** The banner screenshot of phase B is taken on the first screen, before the reject is clicked. */
function screenshotEvidence(browser: BrowserSection, f: CmpFacts): EvidenceInput[] {
  const shot = f.screenshotId ? browser.screenshots.find((s) => s.id === f.screenshotId) : undefined;
  if (!shot) return [];
  const beforeClick = shot.phase !== 'A' ? { beforeClick: true } : {};
  return [
    {
      type: 'screenshot',
      path: shot.path,
      sha256: shot.sha256,
      kind: shot.kind,
      phase: shot.phase,
      ...beforeClick,
    },
  ];
}

/** Classifier reasons that say the measurement was incomplete: reported as limitations of the check. */
const MEASUREMENT_LIMITATIONS: readonly string[] = ['buttons-truncated', 'geometry-unsettled'];

/** A consent-without-action observation shows at most this many state facts. */
const MAX_STATE_EVIDENCE = 5;

const NO_REJECT_VARIANTS: ReadonlySet<string> = new Set([
  'blocking-no-reject',
  'nonblocking-no-reject',
  'no-choice-at-first-layer',
]);

/** Observation builder for the primary facts: the UI subject, the CMP in the params and how it was recognised. */
function makeBase(primary: CmpFacts) {
  const det = primary.detection;
  return (variant: Variant, confidence: Observation['confidence'], evidence: EvidenceInput[], params = {}) =>
    ({
      checkId: ID,
      variant,
      confidence,
      subject: subjects.consentUi(),
      phases: [primary.phase] as Phase[],
      pages: [primary.pageUrl],
      evidence,
      params: { cmp: det.cmpId, ...params },
      classification: {
        source: det.method === 'adapter' ? `adapter:${det.cmpId}` : det.method,
        datasetVersion: null,
      },
    }) satisfies Observation;
}

type Base = ReturnType<typeof makeBase>;

/** What the check has concluded so far. */
interface Verdict {
  observations: Observation[];
  limitations: string[];
  inconclusiveReason: string | null;
}

/** Only own adapters with `high` recognition and a supported version give a verdict; otherwise why not. */
function withoutVerdict(det: CmpFacts['detection'], ctx: CheckContext): Variant | null {
  if (det.method === 'adapter' && det.recognitionConfidence === 'high' && det.versionSupported !== false) {
    return null;
  }

  const notSupported =
    (det.method === 'adapter' && det.versionSupported === false) ||
    (det.method === 'heuristic' &&
      det.cmpId !== null &&
      !Object.hasOwn(adaptersSection.parse(ctx.data.cmp), det.cmpId));
  return notSupported ? 'cmp-not-supported' : 'banner-not-recognized';
}

/** The classifier's verdict on the first layer; a flag `pur-abo` adds its own observation. */
function judgeFirstLayer(
  primary: CmpFacts,
  plan: ScanPlan,
  ctx: CheckContext,
  classify: FirstLayerClassifier,
  base: Base,
  factsEvidence: EvidenceInput[],
  verdict: Verdict,
): void {
  const { observations, limitations } = verdict;
  const lexicon = lexiconFrom(ctx.data.cmp);
  if (!lexicon) limitations.push('lexicon-unavailable');
  if (!primary.firstLayer.bannerVisible) {
    limitations.push('first-layer-not-visible');
    return;
  }

  const cls = classify(primary, lexicon ?? EMPTY_LEXICON, {
    blockingCoveredRatio: ctx.thresholds.cmp.blockingCoveredRatio,
  });
  const v = cls.variant as string;
  if (v === 'banner-not-recognized' || v === 'cmp-not-supported') {
    verdict.inconclusiveReason = v;
    // The adapter recognised the banner; only its first layer could not be read without ambiguity.
    const recognized = v === 'banner-not-recognized' ? { bannerRecognized: true } : {};
    observations.push(
      base(v, 'high', factsEvidence, { reasons: cls.reasons.join(',') || null, ...recognized }),
    );
    for (const r of cls.reasons) if (MEASUREMENT_LIMITATIONS.includes(r)) limitations.push(r);
  } else if (v !== 'ok') {
    if ((CONSENT04_VARIANTS as readonly string[]).includes(v)) {
      observations.push(base(v as Variant, cls.confidence, factsEvidence));
    } else {
      limitations.push(`unknown-classification:${v}`);
      verdict.inconclusiveReason = 'unknown-classification';
    }
  }
  if (cls.flags.includes('pur-abo') && v !== 'pur-abo') {
    observations.push(base('pur-abo', cls.confidence, factsEvidence));
  }

  // A saved snapshot judged with a newer lexicon may disagree with what the click found at scan time.
  if (ctx.options.fromSnapshot && plan.browser?.click.B) {
    const hadReject = plan.browser.click.B.target !== null;
    if ((hadReject && NO_REJECT_VARIANTS.has(v)) || (!hadReject && v === 'ok')) {
      limitations.push('lexicon-changed-since-scan');
    }
  }
}

/**
 * A state that shows the reject failed: no answer recorded, or a category granted. A state with an answer and nothing
 * granted shows no failure, also when the reject is unconfirmed for another reason (an answer stored before the click,
 * which the click left unchanged).
 */
const showsRejectOutcome = (s: ConsentStateFact): boolean =>
  s.ready === 'ready' &&
  (s.decision?.responded === false || Object.values(s.categories).some((v) => v === 'granted'));

/** Our reject click ran: when the CMP state still shows a decision (or none was verified), the reject did nothing. */
function judgeRejectClick(
  cmp: CmpSection,
  primary: CmpFacts,
  base: Base,
  factsEvidence: EvidenceInput[],
  verdict: Verdict,
): void {
  const b = cmp.phases.find((p) => p.phase === 'B');
  if (b?.click?.action !== 'reject' || !b.click.clicked || !b.verify) return;
  // A save in the settings layer is no first-layer reject: CONSENT-05 says whether the CMP state confirms it.
  if (b.click.path === 'settings') return;
  if (b.verify.verified) return;

  if (b.verify.stateAfter.some(showsRejectOutcome)) {
    const states = b.verify.stateAfter.map((s) => stateEvidence(s, { phase: 'B', pageUrl: primary.pageUrl }));
    verdict.observations.push(base('reject-ineffective', 'high', [...factsEvidence, ...states]));
  } else {
    verdict.limitations.push('reject-unverified');
  }
}

/** Pages a "Banner nicht erkannt" observation for a banner candidate cites as evidence. */
const MAX_CANDIDATE_PAGE_EVIDENCE = 4;

/**
 * The banner-like box the heuristic did not take, as evidence: its features, without buttons and blocking, which were
 * not read from a box that is no banner.
 */
function candidateEvidence(f: CmpFacts): EvidenceInput {
  const c = f.firstLayer.bannerCandidate;
  return {
    type: 'cmp',
    cmpId: null,
    recognitionConfidence: f.detection.recognitionConfidence,
    phase: f.phase,
    page: f.pageUrl,
    ...(c ? { candidate: { ...c, controls: [...c.controls] } } : {}),
  };
}

/**
 * A banner observed but not recognised, on which CONSENT-03 stays inconclusive too: info "Banner nicht erkannt", as for a
 * banner the heuristic found. The candidate the heuristic kept is a fair sign, a banner link alone a weak one.
 */
function unrecognizedOutcome(u: UnrecognizedBanner, cmp: CmpSection, browser: BrowserSection): CheckOutcome {
  const start = startPageUrl(browser);
  const primary =
    u.facts.find((f) => f.pageUrl === start) ?? u.facts[0] ?? (primaryFacts(cmp, start) as CmpFacts);
  const pages = (phaseRecord(browser, 'A')?.pages ?? []).filter((p) => u.pages.includes(p.finalUrl || p.url));
  const evidence = [
    candidateEvidence(primary),
    ...pages.slice(0, MAX_CANDIDATE_PAGE_EVIDENCE).map(pageEvidence),
  ];
  const observation: Observation = {
    ...makeBase(primary)('banner-not-recognized', 'medium', evidence, { reasons: 'banner-candidate' }),
    phases: [...new Set(u.facts.map((f) => f.phase))].sort() as Phase[],
    pages: u.pages,
    classification: { source: 'heuristic', datasetVersion: null },
  };
  return { status: 'inconclusive', reason: 'banner-not-recognized', observations: [observation] };
}

/** Consent granted without any action by the visitor: a default or stored state that grants non-essential categories. */
function grantedObservation(
  cmp: CmpSection,
  primary: CmpFacts,
  plan: ScanPlan,
  ctx: CheckContext,
  base: Base,
): Observation | null {
  const granted = grantedWithoutAction(cmp, essentialCategorySection.parse(ctx.data.cmp));
  if (granted.length === 0) return null;

  return {
    ...base('consent-without-action', 'high', [
      cmpEvidence(primary, plan.browser),
      ...granted.slice(0, MAX_STATE_EVIDENCE).map((g) => stateEvidence(g.state, g.facts)),
    ]),
    phases: [...new Set(granted.map((g) => g.facts.phase))].sort() as Phase[],
    pages: [...new Set(granted.map((g) => g.facts.pageUrl))].sort(),
  };
}

export function createConsent04(classify: FirstLayerClassifier = classifyFirstLayer) {
  return defineCheck({
    id: ID,
    module: 'browser',
    requires: ['browser', 'cmp', 'plan'],
    data: ['cmp'],
    variants: CONSENT04_VARIANTS.map((variant) => ({ variant })),
    run({ browser, cmp, plan }, ctx): CheckOutcome {
      const facts = allCmpFacts(cmp);
      if (facts.length === 0) return { status: 'inconclusive', reason: 'cmp-not-observed', observations: [] };
      const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
      if (signal) return signal;
      // Not "not shown visibly": the first layer was never offered to the scanner, so it is neither judged nor reported.
      const notOpened = dialogNotOpenedOutcome(cmp);
      if (notOpened) return notOpened;
      if (!bannerFound(cmp, browser, ctx.thresholds.cmp.minCandidatePages)) {
        const unrecognized = unrecognizedBanner(cmp, browser, ctx.thresholds.cmp.minCandidatePages);
        if (unrecognized) return unrecognizedOutcome(unrecognized, cmp, browser);
        if (bannerUndetermined(cmp, browser, ctx.thresholds.cmp.minCandidatePages)) {
          return { status: 'inconclusive', reason: 'banner-undetermined', observations: [] };
        }
        return { status: 'not_applicable', reason: 'no-banner', observations: [] };
      }

      const primary = primaryFacts(cmp, startPageUrl(browser)) as CmpFacts;
      const base = makeBase(primary);
      const factsEvidence = [cmpEvidence(primary, plan.browser), ...screenshotEvidence(browser, primary)];

      const unverdictable = withoutVerdict(primary.detection, ctx);
      if (unverdictable) {
        return {
          status: 'inconclusive',
          reason: unverdictable,
          observations: [base(unverdictable, 'high', factsEvidence)],
        };
      }

      const verdict: Verdict = { observations: [], limitations: [], inconclusiveReason: null };
      judgeFirstLayer(primary, plan, ctx, classify, base, factsEvidence, verdict);
      judgeRejectClick(cmp, primary, base, factsEvidence, verdict);
      const granted = grantedObservation(cmp, primary, plan, ctx, base);
      if (granted) verdict.observations.push(granted);

      const { observations, limitations, inconclusiveReason } = verdict;
      if (inconclusiveReason) {
        return { status: 'inconclusive', reason: inconclusiveReason, observations, limitations };
      }
      if (!primary.firstLayer.bannerVisible && observations.length === 0) {
        return { status: 'inconclusive', reason: 'first-layer-not-visible', observations, limitations };
      }
      return { status: 'completed', observations, limitations };
    },
  });
}

export const consent04 = createConsent04();
