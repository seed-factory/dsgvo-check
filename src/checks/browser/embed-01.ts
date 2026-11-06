/**
 * EMBED-01: fonts from third-party servers loaded before consent or after the reject: font services of the catalog and
 * font files of other third-party hosts. Self-hosted fonts are first party; the fonts of an embed's frame belong to the
 * embed.
 */
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { distinctRequestEvidence, MAX_EVIDENCE } from './evidence.ts';
import { otherFontFile } from './fonts.ts';
import { sortedUniq } from './lists.ts';
import { loadMoment, momentEvidence, type RejectFacts, rejectFacts, rejectProof } from './reject-moment.ts';
import { serviceFields, serviceName } from './services.ts';
import { type BannerState, bannerState, consentSignals, signalOutcome } from './signals.ts';
import { hasPhaseA, noPhaseAReason, requestIndex, revealCapped, throttleAware } from './snapshot.ts';

const ID = 'EMBED-01';
/** Request kinds that fetch a file; a tracking `hit` is not a font load. */
const LOAD_KINDS = new Set(['stylesheet', 'font', 'library', 'resource']);

interface Group {
  subject: string;
  serviceId: string | null;
  etld1: string | null;
  /** A font service of the catalog, not a host that only delivered font files. */
  fontService: boolean;
  loaded: ClassifiedRequest[];
  attempted: ClassifiedRequest[];
  hints: Array<{ href: string; rel: string; pageUrl: string; phase: Phase }>;
}

function groupOf(
  groups: Map<string, Group>,
  serviceId: string | null,
  etld1: string | null,
  fontService: boolean,
): Group {
  const subject = subjects.service(serviceId, etld1);
  let g = groups.get(subject);
  if (!g) {
    g = { subject, serviceId, etld1, fontService, loaded: [], attempted: [], hints: [] };
    groups.set(subject, g);
  }
  return g;
}

/** A request of a catalog font service that fetches a file. */
const fontServiceLoad = (c: ClassifiedRequest): boolean =>
  c.category === 'fonts' && !!c.serviceId && c.thirdParty && LOAD_KINDS.has(c.kind ?? 'resource');

/** Third-party font requests before the accept, and the preconnect hints to the same font services, per service. */
function groupFontUse(derived: DerivedSection, records: Map<string, RequestRecord>): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const c of derived.requests) {
    if (c.phase === 'C' || c.timing === 'after-accept') continue;
    const fontService = fontServiceLoad(c);
    if (!fontService && !otherFontFile(c, records.get(c.requestId))) continue;

    const g = groupOf(groups, c.serviceId, c.etld1, fontService);
    if (c.delivered) g.loaded.push(c);
    else g.attempted.push(c);
  }

  for (const h of derived.hints ?? []) {
    if (h.category !== 'fonts' || !h.serviceId || !h.thirdParty || h.phase === 'C') continue;
    if (h.rel !== 'preconnect' && h.rel !== 'dns-prefetch') continue;
    const g = groupOf(groups, h.serviceId, null, true);
    g.hints.push({ href: h.href, rel: h.rel, pageUrl: h.pageUrl, phase: h.phase });
  }
  return groups;
}

/**
 * What a `preconnect-only` finding rests on. Its title and action speak of a connection hint only when one was seen: a
 * group of failed fetches alone (always so for a host outside the catalog, which gets no hints) has none to remove.
 */
function withoutLoad(g: Group): 'hint' | 'attempt' | 'hint-and-attempt' {
  if (g.hints.length === 0) return 'attempt';
  return g.attempted.length > 0 ? 'hint-and-attempt' : 'hint';
}

/**
 * `fonts-loaded` when a font arrived; otherwise the attempts and hints alone make a `preconnect-only` finding. Only a
 * load states its moment and shows the requests after the reject with its proof. The attempts of a `preconnect-only`
 * finding are listed once each, as a failed attempt fetched nothing after the reject, so places stay for its hints.
 */
function fontObservation(
  g: Group,
  records: Map<string, RequestRecord>,
  derived: DerivedSection,
  banner: BannerState,
  reject: RejectFacts,
): Observation {
  const loaded = g.loaded.length > 0;
  const reqs = loaded ? g.loaded : g.attempted;
  const items = reqs.flatMap((c) => {
    const r = records.get(c.requestId);
    return r ? [{ r, c }] : [];
  });
  const moment = loaded ? loadMoment(reqs, records, reject) : null;
  const evidence: EvidenceInput[] = moment
    ? momentEvidence(items, rejectProof(moment, reject))
    : distinctRequestEvidence(items);
  if (!loaded) {
    for (const h of g.hints.slice(0, MAX_EVIDENCE - evidence.length)) {
      evidence.push({ type: 'link', href: h.href, text: `rel=${h.rel}`, phase: h.phase, page: h.pageUrl });
    }
  }

  const pages = sortedUniq([
    ...reqs.flatMap((c) => records.get(c.requestId)?.pageUrl ?? []),
    ...(loaded ? [] : g.hints.map((h) => h.pageUrl)),
  ]);
  return {
    checkId: ID,
    variant: loaded ? 'fonts-loaded' : 'preconnect-only',
    confidence: 'high',
    subject: g.subject,
    category: 'fonts',
    phases: sortedUniq([
      ...reqs.map((c) => c.phase),
      ...(loaded ? [] : g.hints.map((h) => h.phase)),
    ]) as Phase[],
    pages,
    evidence,
    params: {
      service: serviceName(derived, g.serviceId, g.etld1),
      pageCount: pages.length,
      ...(moment ?? { afterReject: reqs.some((c) => c.timing === 'after-reject') }),
      bannerFound: banner,
      fontService: g.fontService,
      ...(loaded ? {} : { observed: withoutLoad(g) }),
    },
    ...serviceFields(derived, g.serviceId),
  };
}

export const embed01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: [
    { variant: 'fonts-loaded', variantGroup: 'fonts' },
    { variant: 'preconnect-only', variantGroup: 'fonts' },
  ],
  run({ browser, cmp, derived }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const banner = bannerState(cmp, browser, ctx.thresholds.cmp.minCandidatePages);
    const reject = rejectFacts(browser, cmp);
    const observations = [...groupFontUse(derived, records).values()]
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .map((g) => fontObservation(g, records, derived, banner, reject));

    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        limitations: [
          // The collector names the gap `preconnect-without-request`: match the prefix, not one spelling.
          ...(browser.knownGaps.some((g) => g.startsWith('preconnect')) ? ['preconnect-not-observable'] : []),
          ...(revealCapped(browser, ['A', 'B']) ? ['reveal-height-capped'] : []),
        ],
      },
      ['A', 'B'],
    );
  },
});
