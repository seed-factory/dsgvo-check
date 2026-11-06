/**
 * CONSENT-03 (P0): no consent dialog candidate on the start page and one further page although services that need
 * consent loaded before interaction. `critical` needs strong tracking, no bot/geo signal and a user-asserted EEA region.
 */
import {
  defineCheck,
  type EvidenceInput,
  isCookieHeld,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, PageVisit, RequestRecord } from '../../core/snapshot/browser.ts';
import type { DerivedSection, ServiceCategory } from '../../derive/types.ts';
import { cookieEvidence, distinctRequestEvidence, pageEvidence, storageEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceName, TRACKING_CATEGORIES } from './services.ts';
import {
  allCmpFacts,
  bannerUndetermined,
  consentSignals,
  persistentIdentifier,
  signalOutcome,
  unrecognizedBanner,
} from './signals.ts';
import { classifiedCookies, classifiedStorage, phaseRecord, requestIndex } from './snapshot.ts';

const ID = 'CONSENT-03';

/** At most this many pages, requests and storage entries go into the evidence. */
const MAX_NO_BANNER_EVIDENCE = 6;
const EMBED_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'maps',
  'video',
  'widget',
  'social',
  'reviews',
  'chat',
  'captcha',
]);

/** Observed before the first interaction (phase A, or phase B before the click). */
const observedBeforeInteraction = (phase: string, timing: string | undefined) =>
  (phase === 'A' || phase === 'B') && timing === 'before-interaction';

/** What loaded before any interaction and needs consent: tracking requests, tracking storage and storage of embeds. */
function consentNeedingUse(browser: BrowserSection, derived: DerivedSection) {
  const tracking = derived.requests.filter(
    (c) =>
      observedBeforeInteraction(c.phase, c.timing) &&
      TRACKING_CATEGORIES.has(c.category) &&
      c.delivered &&
      (c.thirdParty || c.firstPartyProxy || c.selfHosted),
  );
  const cookies = classifiedCookies(browser, derived).filter(
    ({ record, cls }) =>
      observedBeforeInteraction(record.phase, cls.timing) && !cls.allowlisted && isCookieHeld(record.state),
  );
  const storage = classifiedStorage(browser, derived).filter(
    ({ record, cls }) => observedBeforeInteraction(record.phase, cls.timing) && !cls.allowlisted,
  );
  const stored = [...cookies, ...storage];
  return {
    tracking,
    trackingStorage: stored.filter(({ cls }) => cls.tracking),
    embedStorage: stored.filter(({ cls }) => EMBED_CATEGORIES.has(cls.category)),
  };
}

type ConsentUse = ReturnType<typeof consentNeedingUse>;

function noBannerObservation(
  use: ConsentUse,
  pagesA: readonly PageVisit[],
  records: Map<string, RequestRecord>,
  derived: DerivedSection,
  regionAsserted: boolean,
): Observation {
  const { tracking, trackingStorage, embedStorage } = use;
  const stored = [...trackingStorage, ...embedStorage];

  // Strong tracking: a persistent identifier (as in CONSENT-01) or tracking storage.
  const strong = tracking.some(persistentIdentifier) || trackingStorage.length > 0;
  const serviceIds = sortedUniq(
    [...tracking.map((c) => c.serviceId), ...stored.map(({ cls }) => cls.serviceId)].filter(
      (x): x is string => x !== null,
    ),
  );
  const trackingRecords = tracking.flatMap((c) => {
    const r = records.get(c.requestId);
    return r ? [{ r, c }] : [];
  });
  const evidence: EvidenceInput[] = [
    ...pagesA.slice(0, MAX_NO_BANNER_EVIDENCE).map(pageEvidence),
    ...distinctRequestEvidence(trackingRecords, MAX_NO_BANNER_EVIDENCE),
    ...stored
      .slice(0, MAX_NO_BANNER_EVIDENCE)
      .map(({ record }) => ('name' in record ? cookieEvidence(record) : storageEvidence(record))),
  ];
  // What was stored, by name and kind only: the services list alone would suggest every service stored something.
  const storedLabels = sortedUniq(
    stored.map(({ record }) =>
      'name' in record ? `${record.name} (cookie)` : `${record.key} (${record.storageType})`,
    ),
  );

  return {
    checkId: ID,
    variant: strong && regionAsserted ? 'no-banner-strong-tracking' : 'no-banner-consent-services',
    confidence: 'high',
    subject: subjects.consentUi(),
    phases: ['A'] as Phase[],
    pages: sortedUniq(pagesA.map((p) => p.finalUrl || p.url)),
    evidence,
    params: {
      services: serviceIds.map((id) => serviceName(derived, id)).join(', ') || null,
      storedCount: storedLabels.length,
      stored: storedLabels.join(', ') || null,
      pageCount: pagesA.length,
      regionAsserted,
      strongTracking: strong,
    },
    classification: { source: 'catalog', datasetVersion: derived.catalogVersion },
  };
}

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

    // A resolved candidate means a banner exists. An iframe that only looks like a consent dialog but could not be read
    // limits the conclusion instead.
    const resolved = facts.filter((f) => !f.firstLayer.consentFrameUnresolved);
    if (resolved.some((f) => f.detection.method !== 'none' || f.firstLayer.bannerPresent)) {
      return { status: 'completed', observations: [], coverage };
    }
    const frameUnresolved = facts.some((f) => f.firstLayer.consentFrameUnresolved === true);

    const use = consentNeedingUse(browser, derived);
    if (use.tracking.length === 0 && use.trackingStorage.length === 0 && use.embedStorage.length === 0) {
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
    // Something that looks like a banner was observed but not recognised: "no banner" would not be a fact.
    if (unrecognizedBanner(cmp, browser, ctx.thresholds.cmp.minCandidatePages)) {
      return { status: 'inconclusive', reason: 'banner-candidate-unrecognized', observations: [], coverage };
    }
    if (bannerUndetermined(cmp, browser, ctx.thresholds.cmp.minCandidatePages)) {
      return { status: 'inconclusive', reason: 'banner-undetermined', observations: [], coverage };
    }

    const regionAsserted = environment.egress.region === 'asserted' || ctx.options.assumeRegion !== null;
    const observation = noBannerObservation(use, pagesA, requestIndex(browser), derived, regionAsserted);
    return { status: 'completed', coverage, observations: [observation] };
  },
});
