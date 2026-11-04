/** Font files from third-party servers: EMBED-01 reports them, so CONSENT-01 leaves them out. */
import type { RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, ServiceCategory } from '../../derive/types.ts';

/**
 * Categories whose font files EMBED-01 reports besides the font services: hosts outside the catalog and widgets that
 * the page itself loads (a booking or chat widget fetching its fonts from the vendor's server). A CDN or consent tool
 * stays a resource of CONSENT-01, and a font fetched inside an embed's frame belongs to that embed.
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
