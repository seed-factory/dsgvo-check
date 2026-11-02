/**
 * CONSENT-03 (P0): no consent dialog candidate (adapter or heuristic) on the start page and ≥ 1 further page,
 * while services that need consent were observed before interaction: analytics/ads/session-recording, or an
 * embed provider writing cookies/storage. Fonts or CDNs alone are not enough (that is EMBED-01 / CONSENT-01).
 * `critical` variant only with strong tracking (identifier or tracking storage), no bot/geo signal and an EEA
 * region asserted by the user ("Region laut Nutzerangabe"). A heuristic banner candidate → CONSENT-04.
 */
import { defineCheck, type EvidenceInput, type Phase, subjects } from '../../core/api.ts';
import type { ServiceCategory } from '../../derive/types.ts';
import {
  allCmpFacts,
  classifiedCookies,
  classifiedStorage,
  consentSignals,
  cookieEvidence,
  pageEvidence,
  persistentIdentifier,
  phaseRecord,
  requestEvidence,
  requestIndex,
  serviceName,
  signalOutcome,
  sortedUniq,
  storageEvidence,
  TRACKING_CATEGORIES,
} from './shared.ts';

const ID = 'CONSENT-03';
const EMBED_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'maps',
  'video',
  'widget',
  'social',
  'reviews',
  'chat',
  'captcha',
]);

export const consent03 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived', 'environment'],
  variants: [
    { variant: 'no-banner-consent-services', variantGroup: 'no-banner' },
    { variant: 'no-banner-strong-tracking', variantGroup: 'no-banner' },
  ],
  run({ browser, cmp, derived, environment }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B', 'C']));
    if (signal) return signal;

    const pagesA = (phaseRecord(browser, 'A')?.pages ?? []).filter((p) => p.evaluable);
    const coverage = { observed: phaseRecord(browser, 'A')?.pages.length ?? 0, evaluated: pagesA.length };
    if (pagesA.length < 2)
      return { status: 'inconclusive', reason: 'insufficient-pages', observations: [], coverage };

    const facts = allCmpFacts(cmp);
    if (facts.length === 0)
      return { status: 'inconclusive', reason: 'cmp-not-observed', observations: [], coverage };
    // A resolved candidate (adapter or heuristic) means a banner exists. An iframe that merely looks like a consent
    // dialog but could not be read is no candidate: it limits the conclusion instead (§3.5 "недоступные фреймы").
    const resolved = facts.filter((f) => !f.firstLayer.consentFrameUnresolved);
    if (resolved.some((f) => f.detection.method !== 'none' || f.firstLayer.bannerPresent)) {
      return { status: 'completed', observations: [], coverage };
    }
    const frameUnresolved = facts.some((f) => f.firstLayer.consentFrameUnresolved === true);

    const records = requestIndex(browser);
    const before = (phase: string, timing: string | undefined) =>
      (phase === 'A' || phase === 'B') && timing === 'before-interaction';
    const tracking = derived.requests.filter(
      (c) =>
        before(c.phase, c.timing) &&
        TRACKING_CATEGORIES.has(c.category) &&
        c.delivered &&
        (c.thirdParty || c.firstPartyProxy || c.selfHosted),
    );
    const cookies = classifiedCookies(browser, derived).filter(
      ({ record, cls }) =>
        before(record.phase, cls.timing) &&
        !cls.allowlisted &&
        (record.state === 'accepted' || record.state === 'sent'),
    );
    const storage = classifiedStorage(browser, derived).filter(
      ({ record, cls }) => before(record.phase, cls.timing) && !cls.allowlisted,
    );
    const trackingStorage = [...cookies, ...storage].filter(({ cls }) => cls.tracking);
    const embedStorage = [...cookies, ...storage].filter(({ cls }) => EMBED_CATEGORIES.has(cls.category));
    if (tracking.length === 0 && trackingStorage.length === 0 && embedStorage.length === 0) {
      return { status: 'completed', observations: [], coverage };
    }
    if (frameUnresolved) {
      return {
        status: 'inconclusive',
        reason: 'consent-frame-unresolved',
        limitations: ['consent-frame-unresolved'],
        observations: [],
        coverage,
      };
    }

    // Strong tracking: a persistent identifier (as in CONSENT-01) or tracking storage.
    const strong = tracking.some(persistentIdentifier) || trackingStorage.length > 0;
    const regionAsserted = environment.egress.region === 'asserted' || ctx.options.assumeRegion !== null;
    const serviceIds = sortedUniq(
      [
        ...tracking.map((c) => c.serviceId),
        ...[...trackingStorage, ...embedStorage].map(({ cls }) => cls.serviceId),
      ].filter((x): x is string => x !== null),
    );
    const evidence: EvidenceInput[] = [
      ...pagesA.slice(0, 6).map(pageEvidence),
      ...tracking.slice(0, 6).flatMap((c) => {
        const r = records.get(c.requestId);
        return r ? [requestEvidence(r, c)] : [];
      }),
      ...[...trackingStorage, ...embedStorage]
        .slice(0, 6)
        .map(({ record }) => ('name' in record ? cookieEvidence(record) : storageEvidence(record))),
    ];
    return {
      status: 'completed',
      coverage,
      observations: [
        {
          checkId: ID,
          variant: strong && regionAsserted ? 'no-banner-strong-tracking' : 'no-banner-consent-services',
          confidence: 'high',
          subject: subjects.consentUi(),
          phases: ['A'] as Phase[],
          pages: sortedUniq(pagesA.map((p) => p.finalUrl || p.url)),
          evidence,
          params: {
            services: serviceIds.map((id) => serviceName(derived, id)).join(', ') || null,
            pageCount: pagesA.length,
            regionAsserted,
            strongTracking: strong,
          },
          classification: { source: 'catalog', datasetVersion: derived.catalogVersion },
        },
      ],
    };
  },
});
