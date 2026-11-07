/**
 * Fonts from third-party servers: which requests of a font service load a font, and the font files of other hosts.
 * EMBED-01 reports them, so CONSENT-01 leaves those files out.
 */
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, RequestKind, ServiceCategory } from '../../derive/types.ts';

/** Request kinds of a font service that fetch a file; a usage `hit` (p.typekit.net) is no font load. */
const FONT_LOAD_KINDS: ReadonlySet<RequestKind> = new Set(['stylesheet', 'font', 'library', 'resource']);

/**
 * A request of a font service that loads a font, by its kind for that service: `kind` of the site's own request,
 * `resourceKind` of a request in an embed's frame. Both paths of EMBED-01 and the frame fonts of EMBED-02 and
 * EMBED-03 count the same requests.
 */
export const fontLoadKind = (kind: RequestKind | undefined): boolean =>
  FONT_LOAD_KINDS.has(kind ?? 'resource');

/**
 * Categories whose font files EMBED-01 reports besides the font services: hosts outside the catalog and widgets that
 * the page itself loads (a booking or chat widget fetching its fonts from the vendor's server). A CDN or consent tool
 * stays a resource of CONSENT-01. A font fetched inside an embed's frame is a request of that embed; EMBED-01 reports
 * it as a font of the embed's frame when a font service of the catalog served it to a map or video player.
 */
const FONT_FILE_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'unknown',
  'widget',
  'chat',
  'social',
  'reviews',
]);

/** A font file from a third-party server that no font service of the catalog covers. */
export function otherFontFile(c: ClassifiedRequest, r: RequestRecord | undefined): boolean {
  if (r?.resourceType !== 'font') return false;
  if (!c.thirdParty || c.firstPartyProxy || c.source === 'embed-frame') return false;
  return FONT_FILE_CATEGORIES.has(c.category);
}
