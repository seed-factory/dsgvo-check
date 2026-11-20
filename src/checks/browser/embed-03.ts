/**
 * EMBED-03: players and thumbnails of external video services loaded before consent or after the reject, one finding
 * per embed. What a player's frame loads belongs to the player's service, so the YouTube hosts a youtube-nocookie
 * player contacts make no second YouTube finding; a thumbnail on the page itself stays with its own service.
 */
import { defineCheck, type Observation, type Phase, type ScanPlan, subjects } from '../../core/api.ts';
import type { BrowserSection, PlannedPage, RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection, ServiceCategory } from '../../derive/types.ts';
import { embedEvidence, frameParams, frameResource } from './embed-frame.ts';
import { sortedUniq } from './lists.ts';
import { loadMoment, type RejectFacts, rejectFacts, rejectProof } from './reject-moment.ts';
import { serviceFields, serviceName } from './services.ts';
import { type BannerState, bannerState, consentSignals, signalOutcome } from './signals.ts';
import {
  hasPhaseA,
  noPhaseAReason,
  pageIndex,
  phaseRecord,
  requestIndex,
  revealCapped,
  throttleAware,
} from './snapshot.ts';

const ID = 'EMBED-03';
/** Strongest integration first: a player says more than its API, the API more than a thumbnail without a player. */
const INTEGRATION_ORDER = ['iframe', 'js-api', 'thumbnail', 'other'];
/** Keyword group of the pages the planner chooses for a video link (`extraGroups` in `browser/pages.yaml`). */
const VIDEO_GROUP = 'video';
/** Older snapshots keep only the word that chose the page; there `video`, the first word of the group, names it. */
const STORED_VIDEO_REASON = 'keyword:video';

/** A page the planner chose for a video link, by whichever word of the group: the group id decides when recorded. */
function isVideoPage(p: PlannedPage): boolean {
  return p.keywordGroup !== undefined
    ? p.keywordGroup === VIDEO_GROUP
    : p.reasons.includes(STORED_VIDEO_REASON);
}

/** Category of a catalog service: derive lists the observed ones and every one a policy may name. */
function categoryOf(derived: DerivedSection, id: string): ServiceCategory | null {
  return (
    derived.catalog[id]?.category ?? derived.serviceNames?.find((s) => s.serviceId === id)?.category ?? null
  );
}

/**
 * The video embed a request belongs to: the video service whose frame made it, else its own video service; null for
 * a request of no video service. Requests of other services in a player's frame (ads, analytics) stay with the checks
 * that own their category, which link them to this finding.
 */
function ownerOf(c: ClassifiedRequest, derived: DerivedSection): string | null {
  if (c.category !== 'video' || !c.serviceId) return null;
  const frame = c.frameServiceId;
  return frame && categoryOf(derived, frame) === 'video' ? frame : c.serviceId;
}

/** Third-party video requests that were delivered before the accept, per embed. */
function groupVideoRequests(derived: DerivedSection): Map<string, ClassifiedRequest[]> {
  const byOwner = new Map<string, ClassifiedRequest[]>();
  for (const c of derived.requests) {
    if (!c.thirdParty || !c.delivered || c.phase === 'C' || c.timing === 'after-accept') continue;
    const owner = ownerOf(c, derived);
    if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), c]);
  }
  return byOwner;
}

/** Order of the evidence: the player's document or the thumbnail first, then what the player loaded. */
function evidenceRank(c: ClassifiedRequest): number {
  if (frameResource(c)) return INTEGRATION_ORDER.length;
  const i = INTEGRATION_ORDER.indexOf(c.integration ?? 'other');
  return i < 0 ? INTEGRATION_ORDER.length - 1 : i;
}

interface Context {
  records: Map<string, RequestRecord>;
  pageOf: (r: RequestRecord) => string;
  derived: DerivedSection;
  banner: BannerState;
  reject: RejectFacts;
}

function videoObservation(owner: string, reqs: ClassifiedRequest[], x: Context): Observation {
  const integrations = new Set(reqs.map((c) => c.integration ?? 'other'));
  const integrationType = INTEGRATION_ORDER.find((i) => integrations.has(i)) ?? 'other';
  reqs.sort((a, b) => evidenceRank(a) - evidenceRank(b));

  const items = reqs.flatMap((c) => {
    const r = x.records.get(c.requestId);
    return r ? [{ r, c }] : [];
  });
  // The moment and the pages count the page of the player's frame; the evidence shows each record as recorded.
  const onPage = new Map(items.map(({ r, c }) => [c.requestId, { ...r, pageUrl: x.pageOf(r) }]));
  const pages = sortedUniq([...onPage.values()].map((r) => r.pageUrl));
  const moment = loadMoment(reqs, onPage, x.reject);

  return {
    checkId: ID,
    variant: 'video-loaded',
    confidence: 'high',
    subject: subjects.service(owner),
    category: 'video',
    phases: sortedUniq(reqs.map((c) => c.phase)) as Phase[],
    pages,
    evidence: embedEvidence(items, rejectProof(moment, x.reject)),
    params: {
      service: serviceName(x.derived, owner),
      integrationType,
      integrations: [...integrations].sort().join(', '),
      ...moment,
      pageCount: pages.length,
      requestCount: reqs.length,
      ...frameParams(reqs, x.derived),
      bannerFound: x.banner,
    },
    ...serviceFields(x.derived, owner),
  };
}

/** A page the planner chose for its video link could not be evaluated in phase A. */
function videoPageBlocked(browser: BrowserSection, plan: ScanPlan): boolean {
  const visits = phaseRecord(browser, 'A')?.pages ?? [];
  return (plan.browser?.pages ?? []).filter(isVideoPage).some((p) => {
    const seen = visits.filter((v) => v.url === p.url || v.finalUrl === p.url);
    return seen.length > 0 && seen.every((v) => !v.evaluable);
  });
}

/**
 * A video frame in the DOM of an evaluable page with no request of its service on that page: a frame that never
 * loaded (lazy below the first screen, or kept from loading), so the missing finding is no observation of a block.
 */
function unloadedVideoFrame(browser: BrowserSection, x: Context): boolean {
  const requested = new Set<string>();
  for (const c of x.derived.requests) {
    const r = x.records.get(c.requestId);
    const owner = ownerOf(c, x.derived);
    if (!r || !owner) continue;
    for (const id of new Set([owner, c.serviceId])) requested.add(`${c.phase}\n${x.pageOf(r)}\n${id}`);
  }
  const evaluable = new Set(
    browser.phases.flatMap((p) =>
      p.pages.filter((v) => v.evaluable).map((v) => `${p.phase}\n${v.finalUrl || v.url}`),
    ),
  );
  return (x.derived.frames ?? []).some(
    (f) =>
      f.category === 'video' &&
      f.thirdParty &&
      f.serviceId !== null &&
      f.phase !== 'C' &&
      evaluable.has(`${f.phase}\n${f.pageUrl}`) &&
      !requested.has(`${f.phase}\n${f.pageUrl}\n${f.serviceId}`),
  );
}

export const embed03 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived', 'plan'],
  variants: [{ variant: 'video-loaded' }],
  run({ browser, cmp, derived, plan }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const x: Context = {
      records: requestIndex(browser),
      pageOf: pageIndex(browser),
      derived,
      banner: bannerState(cmp, browser, ctx.thresholds.cmp.minCandidatePages),
      reject: rejectFacts(browser, cmp),
    };
    const observations = [...groupVideoRequests(derived).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, reqs]) => videoObservation(owner, reqs, x));

    const blocked = videoPageBlocked(browser, plan);
    // A video below the part of a tall page the reveal showed never loaded: a limitation, as in EMBED-01 and EMBED-02.
    const unloaded = [
      ...(unloadedVideoFrame(browser, x) ? ['video-embed-not-loaded'] : []),
      ...(revealCapped(browser, ['A', 'B']) ? ['reveal-height-capped'] : []),
    ];
    if (observations.length === 0 && blocked) {
      return {
        status: 'inconclusive',
        reason: 'video-page-not-evaluable',
        observations,
        limitations: unloaded,
      };
    }
    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        limitations: [...(blocked ? ['video-page-not-evaluable'] : []), ...unloaded],
      },
      ['A', 'B'],
    );
  },
});
