/**
 * What the frame of an embedded map or video player loaded besides the embed: fonts and helper hosts that derive
 * attributes to the embed, not to the site. The embed's finding names them, so one cause gives one finding.
 */
import type { EvidenceInput } from '../../core/api.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { MAX_EVIDENCE, type RequestItem, requestEvidence, requestEvidenceByMoment } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceName } from './services.ts';

/** Fonts and helper hosts the embed's frame loaded: derive attributes them to the embed, not to the site. */
export const frameResource = (c: ClassifiedRequest): boolean => c.source === 'embed-frame';

/**
 * A font the embed's frame loaded. It stays a request of the embed, one finding for one cause: the site loads the
 * embed after consent, it cannot serve the embed's own fonts itself.
 */
export const frameFont = (c: ClassifiedRequest): boolean =>
  frameResource(c) && c.resourceCategory === 'fonts';

/** Name of the catalog service of a frame resource; derive lists every catalog service a policy may name. */
function resourceName(derived: DerivedSection, c: ClassifiedRequest): string {
  const id = c.resourceServiceId ?? null;
  const named = derived.serviceNames?.find((s) => s.serviceId === id)?.name;
  return named ?? serviceName(derived, id, c.etld1);
}

/** What the embed's frame loaded besides the embed: font requests with their services, and helper hosts. */
export function frameParams(reqs: readonly ClassifiedRequest[], derived: DerivedSection) {
  const fonts = reqs.filter(frameFont);
  return {
    frameResourceCount: reqs.filter(frameResource).length,
    frameFontServices: sortedUniq(fonts.map((c) => resourceName(derived, c))).join(', ') || null,
    frameFontRequestCount: fonts.length,
    frameHelperCount: reqs.filter((c) => frameResource(c) && !frameFont(c)).length,
  };
}

/**
 * The embed's requests by moment and the reject proof. A font request of the frame keeps one place, so the evidence
 * shows the fonts the text names even behind many tiles or video requests.
 */
export function embedEvidence(items: RequestItem[], proof: EvidenceInput[]): EvidenceInput[] {
  const max = MAX_EVIDENCE - proof.length;
  const evidence = requestEvidenceByMoment(items, { max });
  const fonts = items.filter(({ c }) => c && frameFont(c));
  const fontUrls = new Set(fonts.map(({ r }) => r.url));
  const font = fonts[0];
  if (!font || evidence.some((e) => e.type === 'request' && fontUrls.has(e.url)))
    return [...evidence, ...proof];
  return [...requestEvidenceByMoment(items, { max: max - 1 }), requestEvidence(font.r, font.c), ...proof];
}
