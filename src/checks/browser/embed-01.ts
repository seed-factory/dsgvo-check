/** EMBED-01: fonts from external font services loaded before consent or after the reject; self-hosted fonts are first party. */
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { MAX_EVIDENCE, requestEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields, serviceName } from './services.ts';
import { consentSignals, signalOutcome } from './signals.ts';
import { hasPhaseA, noPhaseAReason, requestIndex, throttleAware } from './snapshot.ts';

const ID = 'EMBED-01';
/** Request kinds that fetch a file; a tracking `hit` is not a font load. */
const LOAD_KINDS = new Set(['stylesheet', 'font', 'library', 'resource']);

interface Group {
  serviceId: string;
  loaded: ClassifiedRequest[];
  attempted: ClassifiedRequest[];
  hints: Array<{ href: string; rel: string; pageUrl: string; phase: Phase }>;
}

function groupOf(groups: Map<string, Group>, serviceId: string): Group {
  let g = groups.get(serviceId);
  if (!g) {
    g = { serviceId, loaded: [], attempted: [], hints: [] };
    groups.set(serviceId, g);
  }
  return g;
}

/** Third-party font requests before the accept, and the preconnect hints to the same services, per service. */
function groupFontUse(derived: DerivedSection): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const c of derived.requests) {
    if (c.category !== 'fonts' || !c.serviceId || !c.thirdParty) continue;
    if (c.phase === 'C' || c.timing === 'after-accept') continue;
    if (!LOAD_KINDS.has(c.kind ?? 'resource')) continue;

    if (c.delivered) groupOf(groups, c.serviceId).loaded.push(c);
    else groupOf(groups, c.serviceId).attempted.push(c);
  }

  for (const h of derived.hints ?? []) {
    if (h.category !== 'fonts' || !h.serviceId || !h.thirdParty || h.phase === 'C') continue;
    if (h.rel !== 'preconnect' && h.rel !== 'dns-prefetch') continue;
    groupOf(groups, h.serviceId).hints.push({ href: h.href, rel: h.rel, pageUrl: h.pageUrl, phase: h.phase });
  }
  return groups;
}

/** `fonts-loaded` when a font arrived; otherwise the attempts and hints alone make a `preconnect-only` finding. */
function fontObservation(
  g: Group,
  records: Map<string, RequestRecord>,
  derived: DerivedSection,
): Observation {
  const loaded = g.loaded.length > 0;
  const reqs = loaded ? g.loaded : g.attempted;
  const evidence: EvidenceInput[] = reqs.slice(0, MAX_EVIDENCE).flatMap((c) => {
    const r = records.get(c.requestId);
    return r ? [requestEvidence(r, c)] : [];
  });
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
    subject: subjects.service(g.serviceId),
    category: 'fonts',
    phases: sortedUniq([
      ...reqs.map((c) => c.phase),
      ...(loaded ? [] : g.hints.map((h) => h.phase)),
    ]) as Phase[],
    pages,
    evidence,
    params: {
      service: serviceName(derived, g.serviceId),
      pageCount: pages.length,
      afterReject: reqs.some((c) => c.timing === 'after-reject'),
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
  run({ browser, cmp, derived }) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const observations = [...groupFontUse(derived).values()]
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
      .map((g) => fontObservation(g, records, derived));

    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        // The collector names the gap `preconnect-without-request`: match the prefix, not one spelling.
        limitations: browser.knownGaps.some((g) => g.startsWith('preconnect'))
          ? ['preconnect-not-observable']
          : [],
      },
      ['A', 'B'],
    );
  },
});
