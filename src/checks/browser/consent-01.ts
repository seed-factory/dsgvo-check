/** CONSENT-01 (P0): third-party and first-party-proxy requests before any banner interaction; bot or geo signal → inconclusive. */

import {
  type CheckContext,
  defineCheck,
  type EvidenceInput,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, DerivedSection } from '../../derive/types.ts';
import { MAX_EVIDENCE, requestEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields, serviceName, TRACKING_CATEGORIES } from './services.ts';
import { consentSignals, persistentIdentifier, signalOutcome } from './signals.ts';
import {
  hasPhaseA,
  noPhaseAReason,
  phaseRecord,
  requestIndex,
  startPageUrl,
  throttleAware,
} from './snapshot.ts';

const ID = 'CONSENT-01';

/** Strongest first. */
const RANK = [
  'tracking-completed',
  'cookieless-ping',
  'first-party-proxy',
  'library-loaded',
  'third-party-resource',
  'unknown-host',
  'request-not-completed',
] as const;
type Variant = (typeof RANK)[number];

/** CDN, payment, consent provider and monitoring resources (`third-party-resource`, info). */
const RESOURCE_CATEGORIES = new Set(['cdn', 'payment', 'consent-provider', 'monitoring']);

export function variantOf(c: ClassifiedRequest): Variant {
  if (!c.delivered) return 'request-not-completed';
  if (c.firstPartyProxy) return 'first-party-proxy';
  if (TRACKING_CATEGORIES.has(c.category)) {
    if (c.kind !== 'hit') return 'library-loaded';
    // Critical only for a persistent identifier; a cookieless ping, per-load or none is a warning.
    return persistentIdentifier(c) ? 'tracking-completed' : 'cookieless-ping';
  }
  if (c.category === 'unknown') return 'unknown-host';
  if (RESOURCE_CATEGORIES.has(c.category)) return 'third-party-resource';
  return 'library-loaded';
}

interface Group {
  subject: string;
  serviceId: string | null;
  etld1: string | null;
  category: string;
  items: Array<{ c: ClassifiedRequest; r: RequestRecord; v: Variant }>;
}

/**
 * Third-party and first-party-proxy requests before the first interaction, one group per service. Navigations and
 * requests another check owns by routing are left out.
 */
function groupRequests(
  derived: DerivedSection,
  records: Map<string, RequestRecord>,
  routing: CheckContext['routing'],
): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const c of derived.requests) {
    if (c.timing !== 'before-interaction' || c.phase === 'C') continue;
    if (!c.thirdParty && !c.firstPartyProxy) continue;
    const r = records.get(c.requestId);
    if (!r || (r.isNavigation && r.isMainFrame)) continue;
    const owner = routing[c.category] ?? routing.unknown;
    if (owner && owner !== ID) continue;

    const subject = subjects.service(c.serviceId, c.etld1);
    let g = groups.get(subject);
    if (!g) {
      g = { subject, serviceId: c.serviceId, etld1: c.etld1, category: c.category, items: [] };
      groups.set(subject, g);
    }
    g.items.push({ c, r, v: variantOf(c) });
  }
  return groups;
}

/** The observation of one service, reported with its strongest variant; null for an empty group. */
function groupObservation(
  g: Group,
  derived: DerivedSection,
  start: string | null,
  bObserved: boolean,
): Observation | null {
  g.items.sort((a, b) => RANK.indexOf(a.v) - RANK.indexOf(b.v) || a.r.tStartMs - b.r.tStartMs);
  const best = g.items[0];
  if (!best) return null;

  const pages = sortedUniq(g.items.map((i) => i.r.pageUrl));
  const evidence: EvidenceInput[] = g.items.slice(0, MAX_EVIDENCE).map((i) => requestEvidence(i.r, i.c));
  const obs: Observation = {
    checkId: ID,
    variant: best.v,
    confidence: best.v === 'first-party-proxy' ? 'medium' : 'high',
    subject: g.subject,
    category: g.category,
    phases: sortedUniq(g.items.map((i) => i.c.phase)) as Phase[],
    pages,
    evidence,
    params: {
      service: serviceName(derived, g.serviceId, g.etld1),
      host: best.c.host,
      requestCount: g.items.length,
      pageCount: pages.length,
      identifierKind: best.c.identifierKind ?? 'none',
      consentModeDenied: best.c.cookieless === true,
    },
    ...serviceFields(derived, g.serviceId),
  };

  // Seen on the start page in phase A: phase B says whether the request repeats in a fresh session.
  const onStartInA = g.items.some((i) => i.c.phase === 'A' && i.r.pageUrl === start);
  if (onStartInA && bObserved) obs.replicated = g.items.some((i) => i.c.phase === 'B');
  return obs;
}

function phaseBObserved(browser: BrowserSection): boolean {
  const phaseB = phaseRecord(browser, 'B');
  return !!phaseB && phaseB.status !== 'skipped' && phaseB.pages.length > 0;
}

export const consent01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: [
    ...RANK.map((variant) => ({
      variant,
      variantGroup: 'before-consent',
      ...(variant === 'first-party-proxy' ? { maxConfidence: 'medium' as const } : {}),
    })),
  ],
  run({ browser, cmp, derived }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-pre-consent-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const groups = groupRequests(derived, requestIndex(browser), ctx.routing);
    const start = startPageUrl(browser);
    const bObserved = phaseBObserved(browser);
    const observations = [...groups.values()]
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .flatMap((g) => groupObservation(g, derived, start, bObserved) ?? []);

    const a = phaseRecord(browser, 'A');
    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        limitations: browser.requestCap.truncated ? ['request-cap-truncated'] : [],
        coverage: {
          observed: a?.pages.length ?? 0,
          evaluated: a?.pages.filter((p) => p.evaluable).length ?? 0,
        },
      },
      ['A', 'B'],
    );
  },
});
