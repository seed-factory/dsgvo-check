/**
 * EMBED-01: fonts from third-party servers loaded before consent or after the reject: font services of the catalog and
 * font files of other third-party hosts the site loads, and the fonts that the frame of an embedded map or video
 * player loads from a font service. Self-hosted fonts are first party. A frame's fonts stay a request of the embed and
 * get their own finding per font service and embed, beside the site's own fonts of the same service.
 */
import {
  type CheckContext,
  defineCheck,
  type EvidenceInput,
  type Observation,
  type Phase,
  type RelatedRef,
  subjects,
} from '../../core/api.ts';
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection, ServiceCategory } from '../../derive/types.ts';
import { FRAME_FONT_EMBEDS, frameFont, resourceName } from './embed-frame.ts';
import { distinctRequestEvidence, MAX_EVIDENCE } from './evidence.ts';
import { otherFontFile } from './fonts.ts';
import { sortedUniq } from './lists.ts';
import { loadMoment, momentEvidence, type RejectFacts, rejectFacts, rejectProof } from './reject-moment.ts';
import { serviceFields, serviceName } from './services.ts';
import { type BannerState, bannerState, consentSignals, signalOutcome } from './signals.ts';
import {
  hasPhaseA,
  noPhaseAReason,
  pageIndex,
  requestIndex,
  revealCapped,
  throttleAware,
} from './snapshot.ts';

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

interface Context {
  records: Map<string, RequestRecord>;
  pageOf: (r: RequestRecord) => string;
  derived: DerivedSection;
  banner: BannerState;
  reject: RejectFacts;
  routing: CheckContext['routing'];
  /** Names of the embeds whose frame loaded fonts of a font service, by the font service. */
  frameEmbeds: Map<string, string[]>;
}

/**
 * The embeds whose frame loaded fonts of the service of a `preconnect-only` finding: its "no completed download"
 * covers the requests outside those frames only, and its text names the frames that did download them.
 */
function embedFonts(g: Group, x: Context) {
  const names = (g.serviceId && x.frameEmbeds.get(g.serviceId)) || [];
  return {
    embedFrameFonts: names.length > 0,
    embedServices: names.join(', ') || null,
    embedCount: names.length,
  };
}

/**
 * `fonts-loaded` when a font arrived; otherwise the attempts and hints alone make a `preconnect-only` finding. Only a
 * load states its moment and shows the requests after the reject with its proof. The attempts of a `preconnect-only`
 * finding are listed once each, as a failed attempt fetched nothing after the reject, so places stay for its hints.
 */
function fontObservation(g: Group, x: Context): Observation {
  const { records, derived, reject } = x;
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
      bannerFound: x.banner,
      fontService: g.fontService,
      ...(loaded ? {} : { observed: withoutLoad(g), ...embedFonts(g, x) }),
    },
    ...serviceFields(derived, g.serviceId),
  };
}

interface FrameFontGroup {
  subject: string;
  fontServiceId: string;
  embedServiceId: string;
  embedCategory: ServiceCategory;
  loaded: ClassifiedRequest[];
}

/** A request of an embed's frame that delivered fonts of a font service before the accept, in a frame of any embed. */
const frameFontLoad = (c: ClassifiedRequest): boolean =>
  frameFont(c) &&
  c.delivered === true &&
  c.phase !== 'C' &&
  c.timing !== 'after-accept' &&
  !!c.resourceServiceId &&
  !!c.frameServiceId;

/** Names of the embeds whose frame loaded fonts of each font service, ordered by name. */
function embedsByFontService(
  loads: readonly ClassifiedRequest[],
  derived: DerivedSection,
): Map<string, string[]> {
  const ids = new Map<string, Set<string>>();
  for (const c of loads) {
    const font = c.resourceServiceId as string;
    ids.set(font, (ids.get(font) ?? new Set()).add(c.frameServiceId as string));
  }
  return new Map(
    [...ids].map(([font, embeds]) => [font, sortedUniq([...embeds].map((id) => serviceName(derived, id)))]),
  );
}

/**
 * The fonts of the frames of maps and video players (`FRAME_FONT_EMBEDS`), per font service and embed. Only delivered
 * requests count, as in the embed's own finding that names the same fonts.
 */
function groupFrameFonts(loads: readonly ClassifiedRequest[]): Map<string, FrameFontGroup> {
  const groups = new Map<string, FrameFontGroup>();
  for (const c of loads) {
    if (!FRAME_FONT_EMBEDS.has(c.category)) continue;
    const fontServiceId = c.resourceServiceId as string;
    const embedServiceId = c.frameServiceId as string;

    const subject = subjects.embedResource(fontServiceId, embedServiceId);
    let g = groups.get(subject);
    if (!g) {
      g = { subject, fontServiceId, embedServiceId, embedCategory: c.category, loaded: [] };
      groups.set(subject, g);
    }
    g.loaded.push(c);
  }
  return groups;
}

/** The finding of the check that owns the embed (EMBED-02 for a map, EMBED-03 for a player). */
function embedLink(g: FrameFontGroup, routing: CheckContext['routing']): RelatedRef[] {
  const owner = routing[g.embedCategory];
  if (!owner || owner === ID) return [];
  return [{ checkId: owner, subject: subjects.service(g.embedServiceId), relation: 'embedded-in' }];
}

/**
 * The fonts of one embed's frame from one font service, with the moment of the loads as `fonts-loaded` states it. The
 * moment and the pages count the page of the frame's document, as EMBED-03 and PRIV-02 do: a late request of the frame
 * recorded with the next page belongs to the page that showed the embed. The evidence shows each request as recorded.
 */
function frameFontObservation(g: FrameFontGroup, x: Context): Observation {
  const items = g.loaded.flatMap((c) => {
    const r = x.records.get(c.requestId);
    return r ? [{ r, c }] : [];
  });
  const onPage = new Map(items.map(({ r, c }) => [c.requestId, { ...r, pageUrl: x.pageOf(r) }]));
  const pages = sortedUniq([...onPage.values()].map((r) => r.pageUrl));
  const moment = loadMoment(g.loaded, onPage, x.reject);
  const related = embedLink(g, x.routing);

  return {
    checkId: ID,
    variant: 'fonts-in-embed-frame',
    confidence: 'high',
    subject: g.subject,
    category: 'fonts',
    phases: sortedUniq(g.loaded.map((c) => c.phase)) as Phase[],
    pages,
    evidence: momentEvidence(items, rejectProof(moment, x.reject)),
    params: {
      service: resourceName(x.derived, g.loaded[0]!),
      embedService: serviceName(x.derived, g.embedServiceId),
      pageCount: pages.length,
      requestCount: g.loaded.length,
      ...moment,
      bannerFound: x.banner,
    },
    ...serviceFields(x.derived, g.fontServiceId),
    ...(related.length > 0 ? { related } : {}),
  };
}

export const embed01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: [
    { variant: 'fonts-loaded', variantGroup: 'fonts' },
    { variant: 'preconnect-only', variantGroup: 'fonts' },
    { variant: 'fonts-in-embed-frame', variantGroup: 'fonts' },
  ],
  run({ browser, cmp, derived }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const frameLoads = derived.requests.filter(frameFontLoad);
    const x: Context = {
      records,
      pageOf: pageIndex(browser),
      derived,
      banner: bannerState(cmp, browser, ctx.thresholds.cmp.minCandidatePages),
      reject: rejectFacts(browser, cmp),
      routing: ctx.routing,
      frameEmbeds: embedsByFontService(frameLoads, derived),
    };
    const observations = [
      ...[...groupFontUse(derived, records).values()]
        .sort((a, b) => a.subject.localeCompare(b.subject))
        .map((g) => fontObservation(g, x)),
      ...[...groupFrameFonts(frameLoads).values()]
        .sort((a, b) => a.subject.localeCompare(b.subject))
        .map((g) => frameFontObservation(g, x)),
    ];

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
