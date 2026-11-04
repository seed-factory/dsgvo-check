/** EMBED-02 (P0): external map services loaded before consent or after the reject. */
import { defineCheck, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { distinctRequestEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
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

function mapsObservation(
  serviceId: string,
  reqs: ClassifiedRequest[],
  records: Map<string, RequestRecord>,
  derived: DerivedSection,
  banner: BannerState,
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

  return {
    checkId: ID,
    variant: 'maps-loaded',
    confidence: 'high',
    subject: subjects.service(serviceId),
    category: 'maps',
    phases: sortedUniq(reqs.map((c) => c.phase)) as Phase[],
    pages,
    evidence: distinctRequestEvidence(
      reqs.flatMap((c) => {
        const r = records.get(c.requestId);
        return r ? [{ r, c }] : [];
      }),
    ),
    params: {
      service: serviceName(derived, serviceId),
      integrationType,
      integrations: [...integrations].sort().join(', '),
      afterReject: reqs.some((c) => c.timing === 'after-reject'),
      pageCount: pages.length,
      frameResourceCount: reqs.filter(frameResource).length,
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
  run({ browser, cmp, derived }) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const banner = bannerState(cmp);
    const observations = [...groupMapRequests(derived).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([serviceId, reqs]) => mapsObservation(serviceId, reqs, records, derived, banner));

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
