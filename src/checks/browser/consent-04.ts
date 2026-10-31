/**
 * CONSENT-04 (P0): first layer of the consent dialog and whether the reject works (D13, 5.5).
 * The first-layer verdict comes only from the pure `classifyFirstLayer` (owner M2) on first-screen facts of a
 * supported CMP recognised with `high` confidence (≥ 2 independent signals). Heuristic candidates, `medium`
 * recognition or unsupported versions → `banner-not-recognized` / `cmp-not-supported` (info, inconclusive,
 * crmCode null, locked). Check-level variants: `reject-ineffective` (click done, state not denied) and
 * `consent-without-action` (CMP state granted without click, origin default/stored). Bot/geo → inconclusive.
 */
import { classifyFirstLayer } from '../../cmp/classify.ts';
import { lexiconFromData } from '../../cmp/lexicon.ts';
import type {
  CmpFacts,
  CmpLexicon,
  CmpPhaseFacts,
  CmpSection,
  ConsentStateFact,
  FirstLayerClassification,
  KnownCmpId,
} from '../../cmp/types.ts';
import type { BrowserPlan, BrowserSection } from '../../collectors/browser/types.ts';
import {
  type CheckOutcome,
  defineCheck,
  type EvidenceInput,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import { allCmpFacts, consentSignals, signalOutcome, startPageUrl } from './shared.ts';

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

const KNOWN_CMPS: ReadonlySet<string> = new Set<KnownCmpId>([
  'borlabs',
  'cookiebot',
  'complianz',
  'usercentrics',
  'ccm19',
  'real-cookie-banner',
  'cookiehub',
]);

/** Consent categories treated as essential when deciding "granted without action". */
const ESSENTIAL_CATEGORY =
  /^(necessary|essential|required|technical|strictly[-_ ]?necessary|technically[-_ ]?necessary|functional|functionality(_storage)?|security(_storage)?|notwendig|essenziell|essentiell|erforderlich|technisch[-_ ]?notwendig)$/i;

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

/** Lexicon from data/cmp (owner M2): `lexicon:` block or the top level; null when the shape is invalid. */
export function lexiconFrom(data: unknown): CmpLexicon | null {
  try {
    return lexiconFromData(data);
  } catch {
    return null;
  }
}

export type FirstLayerClassifier = (facts: CmpFacts, lexicon: CmpLexicon) => FirstLayerClassification;

/**
 * Source of a detection: only an own adapter with `high` recognition ranks above the heuristic. An adapter below `high`
 * (one kind of signal) is as much a hint as the heuristic itself, and its fact may be an empty one from a page where the
 * banner is hidden (G13).
 */
const rankOf = (d: CmpFacts['detection']): number =>
  d.method === 'none' ? 0 : d.method === 'adapter' && d.recognitionConfidence === 'high' ? 2 : 1;

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

function grantedWithoutAction(cmp: CmpSection): Array<{ facts: CmpFacts; state: ConsentStateFact }> {
  const out: Array<{ facts: CmpFacts; state: ConsentStateFact }> = [];
  for (const p of cmp.phases) {
    for (const f of p.facts) {
      if (p.phase !== 'A' && f.moment !== 'first-screen') continue;
      for (const s of f.state) {
        if (s.ready !== 'ready' || (s.origin !== 'default' && s.origin !== 'stored')) continue;
        if (Object.entries(s.categories).some(([k, v]) => v === 'granted' && !ESSENTIAL_CATEGORY.test(k)))
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

function screenshotEvidence(browser: BrowserSection, f: CmpFacts): EvidenceInput[] {
  const shot = f.screenshotId ? browser.screenshots.find((s) => s.id === f.screenshotId) : undefined;
  return shot
    ? [{ type: 'screenshot', path: shot.path, sha256: shot.sha256, kind: shot.kind, phase: shot.phase }]
    : [];
}

/** Classifier reasons that say the measurement was incomplete (G06, G07): reported as limitations of the check. */
const MEASUREMENT_LIMITATIONS: readonly string[] = ['buttons-truncated', 'geometry-unsettled'];

const NO_REJECT_VARIANTS: ReadonlySet<string> = new Set([
  'blocking-no-reject',
  'nonblocking-no-reject',
  'no-choice-at-first-layer',
]);

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
      if (!facts.some((f) => f.detection.method !== 'none' || f.firstLayer.bannerPresent)) {
        return { status: 'not_applicable', reason: 'no-banner', observations: [] };
      }
      const primary = primaryFacts(cmp, startPageUrl(browser)) as CmpFacts;
      const det = primary.detection;
      const base = (
        variant: Variant,
        confidence: Observation['confidence'],
        evidence: EvidenceInput[],
        params = {},
      ) =>
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
      const factsEvidence = [cmpEvidence(primary, plan.browser), ...screenshotEvidence(browser, primary)];

      // 5.5: only own adapters with `high` recognition and a supported version give a verdict.
      const notSupported =
        (det.method === 'adapter' && det.versionSupported === false) ||
        (det.method === 'heuristic' && det.cmpId !== null && !KNOWN_CMPS.has(det.cmpId));
      if (
        det.method !== 'adapter' ||
        det.recognitionConfidence !== 'high' ||
        det.versionSupported === false
      ) {
        const variant: Variant = notSupported ? 'cmp-not-supported' : 'banner-not-recognized';
        return {
          status: 'inconclusive',
          reason: variant,
          observations: [base(variant, 'high', factsEvidence)],
        };
      }

      const observations: Observation[] = [];
      const limitations: string[] = [];
      let inconclusiveReason: string | null = null;

      const lexicon = lexiconFrom(ctx.data.cmp);
      if (!lexicon) limitations.push('lexicon-unavailable');
      if (primary.firstLayer.bannerVisible) {
        const cls = classify(primary, lexicon ?? EMPTY_LEXICON);
        const v = cls.variant as string;
        if (v === 'banner-not-recognized' || v === 'cmp-not-supported') {
          inconclusiveReason = v;
          observations.push(base(v, 'high', factsEvidence, { reasons: cls.reasons.join(',') || null }));
          for (const r of cls.reasons) if (MEASUREMENT_LIMITATIONS.includes(r)) limitations.push(r);
        } else if (v !== 'ok') {
          if ((CONSENT04_VARIANTS as readonly string[]).includes(v)) {
            observations.push(base(v as Variant, cls.confidence, factsEvidence));
          } else {
            limitations.push(`unknown-classification:${v}`);
            inconclusiveReason = 'unknown-classification';
          }
        }
        if (cls.flags.includes('pur-abo') && v !== 'pur-abo')
          observations.push(base('pur-abo', cls.confidence, factsEvidence));
        if (ctx.options.fromSnapshot && plan.browser?.click.B) {
          const hadReject = plan.browser.click.B.target !== null;
          if ((hadReject && NO_REJECT_VARIANTS.has(v)) || (!hadReject && v === 'ok'))
            limitations.push('lexicon-changed-since-scan');
        }
      } else {
        limitations.push('first-layer-not-visible');
      }

      const b = cmp.phases.find((p) => p.phase === 'B');
      if (b?.click?.action === 'reject' && b.click.clicked && b.verify) {
        if (!b.verify.verified && b.verify.stateAfter.some((s) => s.ready === 'ready')) {
          observations.push(
            base('reject-ineffective', 'high', [
              ...factsEvidence,
              ...b.verify.stateAfter.map((s) => stateEvidence(s, { phase: 'B', pageUrl: primary.pageUrl })),
            ]),
          );
        } else if (!b.verify.verified) limitations.push('reject-unverified');
      }

      const granted = grantedWithoutAction(cmp);
      if (granted.length > 0) {
        observations.push({
          ...base('consent-without-action', 'high', [
            cmpEvidence(primary, plan.browser),
            ...granted.slice(0, 5).map((g) => stateEvidence(g.state, g.facts)),
          ]),
          phases: [...new Set(granted.map((g) => g.facts.phase))].sort() as Phase[],
          pages: [...new Set(granted.map((g) => g.facts.pageUrl))].sort(),
        });
      }

      if (inconclusiveReason)
        return { status: 'inconclusive', reason: inconclusiveReason, observations, limitations };
      if (!primary.firstLayer.bannerVisible && observations.length === 0) {
        return { status: 'inconclusive', reason: 'first-layer-not-visible', observations, limitations };
      }
      return { status: 'completed', observations, limitations };
    },
  });
}

export const consent04 = createConsent04();
