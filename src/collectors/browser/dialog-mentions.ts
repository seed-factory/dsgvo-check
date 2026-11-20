/**
 * The catalog services a consent dialog names, as the snapshot keeps them. The text of the dialog stays in memory: it
 * is folded into the search form of PRIV-01 once, the name and aliases of every catalog service are looked up in it as
 * whole words, and only the catalog's own term that matched is kept per service. Nothing of the page text reaches the
 * record, so a consent ID, UID or TC string the dialog prints next to the services cannot either, whatever its shape.
 */
import type { CmpAdapter, RawDialogText } from '../../cmp/types.ts';
import { loadSection } from '../../core/data/load.ts';
import {
  CMP_DIALOG_TEXT_MAX_CHARS,
  type CmpDialogMentions,
  CmpDialogMentionsSchema,
} from '../../core/snapshot/cmp-dialog.ts';
import type { IsoTimestamp, SanitizedUrl } from '../../core/snapshot/common.ts';
import { firstTermIn, normalizeText, serviceNameTerms } from '../../core/text/search.ts';
import { servicesSection } from '../../derive/catalog.ts';

/** A catalog service and the terms that name it, in the order PRIV-01 tries them. */
export interface ServiceTerms {
  serviceId: string;
  terms: readonly string[];
}

/**
 * The services of the catalog a policy is expected to name, with the terms that name them. One that none is expected
 * to name is not looked up: Google's own cookies go by the bare name `Google`, a word of every Google service's entry.
 */
export function loadServiceTerms(dataDir?: string): ServiceTerms[] {
  return loadSection(servicesSection, dataDir)
    .filter((s) => s.policyRelevance !== 'none')
    .map((s) => ({ serviceId: s.id, terms: serviceNameTerms(s) }));
}

/** Where and from which CMP the dialog text was read. */
export interface DialogSource {
  adapter: Pick<CmpAdapter, 'id' | 'name'>;
  version: string | null;
  pageUrl: SanitizedUrl;
  takenAt: IsoTimestamp;
}

/** Drops the last token of a text that was cut: a name cut in two could match a shorter one (`Google Ads|ense`). */
const withoutCutToken = (s: string): string => s.replace(/\S*$/, '');

/**
 * The services `raw` names, each with the catalog term that matched, checked against the snapshot schema; null when
 * the record does not fit. A text longer than the protective limit is searched up to it and marked truncated.
 */
export function dialogMentionsOf(
  raw: RawDialogText,
  from: DialogSource,
  services: readonly ServiceTerms[] = loadServiceTerms(),
): CmpDialogMentions | null {
  const truncated = raw.truncated || raw.text.length > CMP_DIALOG_TEXT_MAX_CHARS;
  const read = raw.text.slice(0, CMP_DIALOG_TEXT_MAX_CHARS);
  const text = normalizeText(truncated ? withoutCutToken(read) : read);
  const mentions = services
    .flatMap((s) => {
      const term = firstTermIn(text, s.terms);
      return term ? [{ serviceId: s.serviceId, term }] : [];
    })
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const parsed = CmpDialogMentionsSchema.safeParse({
    cmpId: from.adapter.id,
    cmpName: from.adapter.name,
    version: from.version?.slice(0, 40) ?? null,
    phase: 'A',
    pageUrl: from.pageUrl,
    takenAt: from.takenAt,
    services: mentions,
    truncated,
  });
  return parsed.success ? parsed.data : null;
}
