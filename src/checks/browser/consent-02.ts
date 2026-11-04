/**
 * CONSENT-02 (P0): cookies and Web Storage written before any interaction. The allowlist is "nicht bewertet", not
 * "notwendig". Values are never read, so `cmp-cookie-with-uid` is declared but not emitted.
 */

import {
  defineCheck,
  type EvidenceInput,
  isCookieHeld,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, CookieRecord, StorageRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedCookie, ClassifiedStorage, DerivedSection } from '../../derive/types.ts';
import { cookieEvidence, MAX_EVIDENCE, storageEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields, serviceInfo } from './services.ts';
import { consentSignals, signalOutcome } from './signals.ts';
import {
  classifiedCookies,
  classifiedStorage,
  hasPhaseA,
  noPhaseAReason,
  throttleAware,
} from './snapshot.ts';

const ID = 'CONSENT-02';

const RANK = [
  'tracking-identifier-stored',
  'unknown-third-party-persistent',
  'unknown-first-party-persistent',
  'cmp-cookie-with-uid',
  'storage-rejected-or-attempted',
] as const;
type Variant = (typeof RANK)[number];

interface Entry {
  subject: string;
  variant: Variant;
  cls: ClassifiedCookie | ClassifiedStorage;
  name: string;
  kind: 'cookie' | ClassifiedStorage['storageType'];
  party: string;
  phases: Set<string>;
  pages: Set<string>;
  evidence: EvidenceInput[];
}

function variantFor(cls: ClassifiedCookie | ClassifiedStorage, accepted: boolean): Variant | null {
  if (cls.tracking) return accepted ? 'tracking-identifier-stored' : 'storage-rejected-or-attempted';
  if (!accepted || !cls.persistent) return null;
  return cls.thirdParty ? 'unknown-third-party-persistent' : 'unknown-first-party-persistent';
}

/** Written in phase A or in phase B before the click. */
function beforeInteraction(r: CookieRecord | StorageRecord): boolean {
  return (r.phase === 'A' || r.phase === 'B') && !r.afterClick;
}

interface EntryMeta {
  name: string;
  kind: Entry['kind'];
  party: string;
  phase: string;
  page: string;
  ev: EvidenceInput;
}

/** One entry per cookie or storage key; a repeat widens phases, pages and evidence, the strongest variant wins. */
function addEntry(
  entries: Map<string, Entry>,
  subject: string,
  cls: ClassifiedCookie | ClassifiedStorage,
  variant: Variant,
  meta: EntryMeta,
): void {
  const e = entries.get(subject);
  if (!e) {
    entries.set(subject, {
      subject,
      variant,
      cls,
      name: meta.name,
      kind: meta.kind,
      party: meta.party,
      phases: new Set([meta.phase]),
      pages: new Set([meta.page]),
      evidence: [meta.ev],
    });
    return;
  }

  e.phases.add(meta.phase);
  e.pages.add(meta.page);
  if (e.evidence.length < MAX_EVIDENCE) e.evidence.push(meta.ev);
  if (RANK.indexOf(variant) < RANK.indexOf(e.variant)) {
    e.variant = variant;
    e.cls = cls;
  }
}

/** Returns how many allowlisted cookies were skipped. */
function addCookieEntries(
  entries: Map<string, Entry>,
  browser: BrowserSection,
  derived: DerivedSection,
): number {
  let allowlisted = 0;
  for (const { record, cls } of classifiedCookies(browser, derived)) {
    if (!beforeInteraction(record)) continue;
    if (cls.allowlisted) {
      allowlisted++;
      continue;
    }

    const variant = variantFor(cls, isCookieHeld(record.state));
    if (!variant) continue;
    const subject = subjects.cookie({
      name: record.name,
      firstParty: record.firstParty,
      etld1: cls.etld1 ?? null,
      path: record.path,
      partitioned: record.partitionKey !== null,
    });
    addEntry(entries, subject, cls, variant, {
      name: record.name,
      kind: 'cookie',
      party: record.firstParty ? 'first-party' : (cls.etld1 ?? record.domain),
      phase: record.phase,
      page: record.pageUrl,
      ev: cookieEvidence(record),
    });
  }
  return allowlisted;
}

/** Returns how many allowlisted storage entries were skipped. */
function addStorageEntries(
  entries: Map<string, Entry>,
  browser: BrowserSection,
  derived: DerivedSection,
): number {
  let allowlisted = 0;
  for (const { record, cls } of classifiedStorage(browser, derived)) {
    if (!beforeInteraction(record)) continue;
    if (cls.allowlisted) {
      allowlisted++;
      continue;
    }

    const variant = variantFor(cls, true);
    if (!variant) continue;
    const subject = subjects.storage({
      storageType: record.storageType,
      key: record.key,
      firstParty: record.firstParty,
      etld1: cls.etld1 ?? null,
    });
    addEntry(entries, subject, cls, variant, {
      name: record.key,
      kind: record.storageType,
      party: record.firstParty ? 'first-party' : (cls.etld1 ?? record.origin),
      phase: record.phase,
      page: record.pageUrl,
      ev: storageEvidence(record),
    });
  }
  return allowlisted;
}

/** Variants that report every entry of a scan in one finding: unclassified entries only differ by name. */
const LISTED_VARIANTS: ReadonlySet<Variant> = new Set([
  'unknown-third-party-persistent',
  'unknown-first-party-persistent',
]);

/** Evidence items per listed finding; each entry contributes its first item so every name stays backed. */
const MAX_LISTED_EVIDENCE = 40;

/**
 * `name (kind)` for own entries, `name (kind, domain)` for third-party ones; never a value. The message of the
 * first-party variant already says "own domain", so the label adds no untranslated word to it.
 */
const entryLabel = (e: Entry): string =>
  e.party === 'first-party' ? `${e.name} (${e.kind})` : `${e.name} (${e.kind}, ${e.party})`;

function observationFor(e: Entry, derived: DerivedSection, dataset: string): Observation {
  return {
    checkId: ID,
    variant: e.variant,
    confidence: 'high',
    subject: e.subject,
    category: e.cls.category,
    phases: [...e.phases].sort() as Phase[],
    pages: [...e.pages].sort(),
    evidence: e.evidence,
    params: {
      name: e.name,
      storageKind: e.kind,
      party: e.party,
      service: serviceInfo(derived, e.cls.serviceId)?.name ?? null,
      dataset,
    },
    ...serviceFields(derived, e.cls.serviceId),
  };
}

/** One finding per variant: the subject is the variant, so the fingerprint does not change when an entry appears. */
function listedObservation(
  variant: Variant,
  group: Entry[],
  derived: DerivedSection,
  dataset: string,
): Observation {
  const serviceIds = new Set(group.map((e) => e.cls.serviceId ?? null));
  const sharedService = serviceIds.size === 1 ? group[0]!.cls.serviceId : null;
  const categories = new Set(group.map((e) => e.cls.category));
  return {
    checkId: ID,
    variant,
    confidence: 'high',
    subject: `${variant}-list`,
    ...(categories.size === 1 ? { category: group[0]!.cls.category } : {}),
    phases: sortedUniq(group.flatMap((e) => [...e.phases])) as Phase[],
    pages: sortedUniq(group.flatMap((e) => [...e.pages])),
    evidence: group.flatMap((e) => e.evidence.slice(0, 1)).slice(0, MAX_LISTED_EVIDENCE),
    params: {
      count: group.length,
      names: group.map(entryLabel).join(', '),
      dataset,
    },
    ...serviceFields(derived, sharedService),
  };
}

function entryObservations(entries: Map<string, Entry>, derived: DerivedSection): Observation[] {
  const dataset = `${derived.datasets[0]?.name ?? 'catalog'} ${derived.catalogVersion ?? ''}`.trim();
  const sorted = [...entries.values()].sort((a, b) => a.subject.localeCompare(b.subject));
  const single = sorted
    .filter((e) => !LISTED_VARIANTS.has(e.variant))
    .map((e) => observationFor(e, derived, dataset));
  const listed = RANK.filter((v) => LISTED_VARIANTS.has(v)).flatMap((variant) => {
    const group = sorted
      .filter((e) => e.variant === variant)
      .sort((a, b) => a.name.localeCompare(b.name) || a.subject.localeCompare(b.subject));
    return group.length > 0 ? [listedObservation(variant, group, derived, dataset)] : [];
  });
  return [...single, ...listed];
}

export const consent02 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: RANK.map((variant) => ({ variant, variantGroup: 'storage' })),
  run({ browser, cmp, derived }) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-pre-consent-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const entries = new Map<string, Entry>();
    const allowlisted =
      addCookieEntries(entries, browser, derived) + addStorageEntries(entries, browser, derived);

    return throttleAware(
      browser,
      {
        status: 'completed',
        observations: entryObservations(entries, derived),
        coverage: { note: `allowlist-v${derived.allowlistVersion ?? '?'}:not-evaluated=${allowlisted}` },
        limitations: sortedUniq(
          browser.knownGaps.filter((g) => g.startsWith('cookie') || g.startsWith('storage')),
        ),
      },
      ['A', 'B'],
    );
  },
});
