/** EMBED-02 (P0): external map services loaded before consent or after the reject. */
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { MAX_EVIDENCE, type RequestItem, requestEvidence, requestEvidenceByMoment } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { loadMoment, type RejectFacts, rejectFacts, rejectProof } from './reject-moment.ts';
import { serviceFields, serviceName } from './services.ts';
import { type BannerState, bannerState, consentSignals, signalOutcome } from './signals.ts';
import { hasPhaseA, noPhaseAReason, phaseRecord, requestIndex, throttleAware } from './snapshot.ts';

const ID = 'EMBED-02';
/** Strongest integration first: an embedded frame says more than a static image. */
const INTEGRATION_ORDER = ['iframe', 'js-api', 'static', 'tiles'];

/** Third-party map requests that were delivered before the accept, per service. */
function groupMapRequests(derived: DerivedSection): Map<string, ClassifiedRequest[]> {
  const byService = new Map<string, ClassifiedRequest[]>();
  for (const c of derived.requests) {
    if (c.category !== 'maps' || !c.serviceId || !c.thirdParty || !c.delivered) continue;
    if (c.phase === 'C' || c.timing === 'after-accept') continue;
    byService.set(c.serviceId, [...(byService.get(c.serviceId) ?? []), c]);
  }
  return byService;
}

/** Fonts and helper hosts the map's frame loaded: derive attributes them to the map, not to the site. */
const frameResource = (c: ClassifiedRequest): boolean => c.source === 'embed-frame';

/**
 * A font the map's frame loaded. It stays a request of the map, one finding for one cause: the site loads the map
 * after consent, it cannot serve the map's own fonts itself.
 */
const frameFont = (c: ClassifiedRequest): boolean => frameResource(c) && c.resourceCategory === 'fonts';

/** Name of the catalog service of a frame resource; derive lists every catalog service a policy may name. */
function resourceName(derived: DerivedSection, c: ClassifiedRequest): string {
  const id = c.resourceServiceId ?? null;
  const named = derived.serviceNames?.find((s) => s.serviceId === id)?.name;
  return named ?? serviceName(derived, id, c.etld1);
}

/** What the map's frame loaded besides the map: font requests with their services, and helper hosts. */
function frameParams(reqs: readonly ClassifiedRequest[], derived: DerivedSection) {
  const fonts = reqs.filter(frameFont);
  return {
    frameResourceCount: reqs.filter(frameResource).length,
    frameFontServices: sortedUniq(fonts.map((c) => resourceName(derived, c))).join(', ') || null,
    frameFontRequestCount: fonts.length,
    frameHelperCount: reqs.filter((c) => frameResource(c) && !frameFont(c)).length,
  };
}

/**
 * The map's requests by moment and the reject proof. A font request of the frame keeps one place, so the evidence shows
 * the fonts the text names even behind many tiles.
 */
function mapEvidence(items: RequestItem[], proof: EvidenceInput[]): EvidenceInput[] {
  const max = MAX_EVIDENCE - proof.length;
  const evidence = requestEvidenceByMoment(items, { max });
  const fonts = items.filter(({ c }) => c && frameFont(c));
  const fontUrls = new Set(fonts.map(({ r }) => r.url));
  const font = fonts[0];
  if (!font || evidence.some((e) => e.type === 'request' && fontUrls.has(e.url)))
    return [...evidence, ...proof];
  return [...requestEvidenceByMoment(items, { max: max - 1 }), requestEvidence(font.r, font.c), ...proof];
}

function mapsObservation(
  serviceId: string,
  reqs: ClassifiedRequest[],
  records: Map<string, RequestRecord>,
  derived: DerivedSection,
  banner: BannerState,
  reject: RejectFacts,
): Observation {
  const integrations = new Set(reqs.map((c) => c.integration ?? 'other'));
  const integrationType = INTEGRATION_ORDER.find((i) => integrations.has(i)) ?? 'other';
  const pages = sortedUniq(reqs.flatMap((c) => records.get(c.requestId)?.pageUrl ?? []));
  // The map's own requests lead the evidence; the resources of its frame follow.
  reqs.sort(
    (a, b) =>
      Number(frameResource(a)) - Number(frameResource(b)) ||
      INTEGRATION_ORDER.indexOf(a.integration ?? 'other') -
        INTEGRATION_ORDER.indexOf(b.integration ?? 'other'),
  );
  const moment = loadMoment(reqs, records, reject);
  const items = reqs.flatMap((c) => {
    const r = records.get(c.requestId);
    return r ? [{ r, c }] : [];
  });

  return {
    checkId: ID,
    variant: 'maps-loaded',
    confidence: 'high',
    subject: subjects.service(serviceId),
    category: 'maps',
    phases: sortedUniq(reqs.map((c) => c.phase)) as Phase[],
    pages,
    evidence: mapEvidence(items, rejectProof(moment, reject)),
    params: {
      service: serviceName(derived, serviceId),
      integrationType,
      integrations: [...integrations].sort().join(', '),
      ...moment,
      pageCount: pages.length,
      ...frameParams(reqs, derived),
      bannerFound: banner,
    },
    ...serviceFields(derived, serviceId),
  };
}

export const embed02 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: [{ variant: 'maps-loaded' }],
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
    const observations = [...groupMapRequests(derived).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([serviceId, reqs]) => mapsObservation(serviceId, reqs, records, derived, banner, reject));

    const contact = phaseRecord(browser, 'A')?.pages.filter((p) => p.role === 'contact') ?? [];
    const contactBlocked = contact.length > 0 && contact.every((p) => !p.evaluable);
    if (observations.length === 0 && contactBlocked) {
      return { status: 'inconclusive', reason: 'contact-page-not-evaluable', observations };
    }
    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        limitations: contactBlocked ? ['contact-page-not-evaluable'] : [],
      },
      ['A', 'B'],
    );
  },
});
