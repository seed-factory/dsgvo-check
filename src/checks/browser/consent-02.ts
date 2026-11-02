/**
 * CONSENT-02 (P0): cookies and Web Storage written before any interaction (phase A, phase B before the click).
 * Known tracking identifiers from the catalog; persistent entries that are not known identifiers by party;
 * the allowlist (consent, session, load balancer, CSRF, language, bot protection) is "nicht bewertet", not
 * "notwendig". One observation per cookie key (name, party, path, partitioned) or storage key.
 * Values are never read, so `cmp-cookie-with-uid` (registry §2.1) is declared but not emitted: the collector
 * has no safe "consent cookie carries a UID" feature yet. Bot or geo signal → inconclusive.
 */
import type { CookieRecord, StorageRecord } from '../../collectors/browser/types.ts';
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { ClassifiedCookie, ClassifiedStorage } from '../../derive/types.ts';
import {
  classifiedCookies,
  classifiedStorage,
  consentSignals,
  cookieEvidence,
  hasPhaseA,
  MAX_EVIDENCE,
  noPhaseAReason,
  serviceFields,
  serviceInfo,
  signalOutcome,
  sortedUniq,
  storageEvidence,
  throttleAware,
} from './shared.ts';

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
    let allowlisted = 0;
    const add = (
      subject: string,
      cls: ClassifiedCookie | ClassifiedStorage,
      variant: Variant,
      meta: {
        name: string;
        kind: Entry['kind'];
        party: string;
        phase: string;
        page: string;
        ev: EvidenceInput;
      },
    ) => {
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
    };

    for (const { record, cls } of classifiedCookies(browser, derived)) {
      if (!beforeInteraction(record)) continue;
      if (cls.allowlisted) {
        allowlisted++;
        continue;
      }
      const v = variantFor(cls, record.state === 'accepted' || record.state === 'sent');
      if (!v) continue;
      const subject = subjects.cookie({
        name: record.name,
        firstParty: record.firstParty,
        etld1: cls.etld1 ?? null,
        path: record.path,
        partitioned: record.partitionKey !== null,
      });
      add(subject, cls, v, {
        name: record.name,
        kind: 'cookie',
        party: record.firstParty ? 'first-party' : (cls.etld1 ?? record.domain),
        phase: record.phase,
        page: record.pageUrl,
        ev: cookieEvidence(record),
      });
    }
    for (const { record, cls } of classifiedStorage(browser, derived)) {
      if (!beforeInteraction(record)) continue;
      if (cls.allowlisted) {
        allowlisted++;
        continue;
      }
      const v = variantFor(cls, true);
      if (!v) continue;
      const subject = subjects.storage({
        storageType: record.storageType,
        key: record.key,
        firstParty: record.firstParty,
        etld1: cls.etld1 ?? null,
      });
      add(subject, cls, v, {
        name: record.key,
        kind: record.storageType,
        party: record.firstParty ? 'first-party' : (cls.etld1 ?? record.origin),
        phase: record.phase,
        page: record.pageUrl,
        ev: storageEvidence(record),
      });
    }

    const dataset = `${derived.datasets[0]?.name ?? 'catalog'} ${derived.catalogVersion ?? ''}`.trim();
    const observations: Observation[] = [...entries.values()]
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .map((e) => ({
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
      }));
    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        coverage: { note: `allowlist-v${derived.allowlistVersion ?? '?'}:not-evaluated=${allowlisted}` },
        limitations: sortedUniq(
          browser.knownGaps.filter((g) => g.startsWith('cookie') || g.startsWith('storage')),
        ),
      },
      ['A', 'B'],
    );
  },
});

/** Written before any click: phase A or phase B before the click (A, A′, B before the click). */
function beforeInteraction(r: CookieRecord | StorageRecord): boolean {
  return (r.phase === 'A' || r.phase === 'B') && !r.afterClick;
}
