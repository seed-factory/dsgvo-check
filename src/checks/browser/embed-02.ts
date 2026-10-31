/**
 * EMBED-02 (P0): external map services (iframe, JS API, static maps, tiles) loaded before consent (phase A)
 * or after the reject (phase B). A plain link, a local image or a two-click placeholder without a request is no
 * finding; a load only after accepting (C) neither. Storage written by the provider is CONSENT-02's axis.
 * If the contact page could not be evaluated and nothing was found → inconclusive. Bot or geo → inconclusive.
 */
import { defineCheck, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';
import {
  consentSignals,
  hasPhaseA,
  MAX_EVIDENCE,
  noPhaseAReason,
  phaseRecord,
  requestEvidence,
  requestIndex,
  serviceFields,
  serviceName,
  signalOutcome,
  sortedUniq,
  throttleAware,
} from './shared.ts';

const ID = 'EMBED-02';
const INTEGRATION_ORDER = ['iframe', 'js-api', 'static', 'tiles'];

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
    const byService = new Map<string, ClassifiedRequest[]>();
    for (const c of derived.requests) {
      if (c.category !== 'maps' || !c.serviceId || !c.thirdParty || !c.delivered) continue;
      if (c.phase === 'C' || c.timing === 'after-accept') continue;
      byService.set(c.serviceId, [...(byService.get(c.serviceId) ?? []), c]);
    }

    const observations: Observation[] = [];
    for (const [serviceId, reqs] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const integrations = new Set(reqs.map((c) => c.integration ?? 'other'));
      const integrationType = INTEGRATION_ORDER.find((i) => integrations.has(i)) ?? 'other';
      const pages = sortedUniq(reqs.flatMap((c) => records.get(c.requestId)?.pageUrl ?? []));
      reqs.sort(
        (a, b) =>
          INTEGRATION_ORDER.indexOf(a.integration ?? 'other') -
          INTEGRATION_ORDER.indexOf(b.integration ?? 'other'),
      );
      observations.push({
        checkId: ID,
        variant: 'maps-loaded',
        confidence: 'high',
        subject: subjects.service(serviceId),
        category: 'maps',
        phases: sortedUniq(reqs.map((c) => c.phase)) as Phase[],
        pages,
        evidence: reqs.slice(0, MAX_EVIDENCE).flatMap((c) => {
          const r = records.get(c.requestId);
          return r ? [requestEvidence(r, c)] : [];
        }),
        params: {
          service: serviceName(derived, serviceId),
          integrationType,
          integrations: [...integrations].sort().join(', '),
          afterReject: reqs.some((c) => c.timing === 'after-reject'),
          pageCount: pages.length,
        },
        ...serviceFields(derived, serviceId),
      });
    }

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
