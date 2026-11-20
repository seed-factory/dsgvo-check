/** Tracking identifiers a service stored: the cookies the browser held and the storage entries, with page and phase. */
import { type EvidenceInput, isCookieHeld, type Phase } from '../../core/api.ts';
import type { BrowserSection } from '../../core/snapshot/browser.ts';
import type { DerivedSection, ServiceCategory } from '../../derive/types.ts';
import { cookieEvidence, storageEvidence } from './evidence.ts';
import { classifiedCookies, classifiedStorage } from './snapshot.ts';

export interface StoredIdentifier {
  phase: Phase;
  page: string;
  category: ServiceCategory;
  ev: EvidenceInput;
}

/**
 * Stored tracking identifiers by service. A service can store one without a request of its own (a cookie set by a
 * response of another host of the same company), so they count as an observation of the service. Entries the catalog
 * names without an identifier (a test cookie) prove nothing about tracking and are left out.
 */
export function storedIdentifiersByService(
  browser: BrowserSection,
  derived: DerivedSection,
): Map<string, StoredIdentifier[]> {
  const byService = new Map<string, StoredIdentifier[]>();
  const add = (serviceId: string | null, entry: StoredIdentifier) => {
    if (serviceId) byService.set(serviceId, [...(byService.get(serviceId) ?? []), entry]);
  };
  for (const { record, cls } of classifiedCookies(browser, derived)) {
    if (!cls.tracking || !isCookieHeld(record.state)) continue;
    add(cls.serviceId, {
      phase: record.phase,
      page: record.pageUrl,
      category: cls.category,
      ev: cookieEvidence(record),
    });
  }
  for (const { record, cls } of classifiedStorage(browser, derived)) {
    if (!cls.tracking) continue;
    add(cls.serviceId, {
      phase: record.phase,
      page: record.pageUrl,
      category: cls.category,
      ev: storageEvidence(record),
    });
  }
  return byService;
}
