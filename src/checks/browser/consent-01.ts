/**
 * CONSENT-01 (P0): third-party and first-party-proxy requests started before any interaction with the banner
 * (phase A and phase B before the click). Owns analytics, ads, session-recording, tag-manager and the remainder
 * of categories by data/routing.yaml; one observation per service, unknown hosts per registrable domain.
 * Bot or geo signal → inconclusive (5.2).
 */
import type { RequestRecord } from '../../collectors/browser/types.ts';
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';
import {
  consentSignals,
  hasPhaseA,
  MAX_EVIDENCE,
  noPhaseAReason,
  persistentIdentifier,
  phaseRecord,
  requestEvidence,
  requestIndex,
  serviceFields,
  serviceName,
  signalOutcome,
  sortedUniq,
  startPageUrl,
  TRACKING_CATEGORIES,
  throttleAware,
} from './shared.ts';

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
    // 03-checks §3.3: critical only for a persistent identifier; a cookieless ping, per-load or none → warning.
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

    const records = requestIndex(browser);
    const groups = new Map<string, Group>();
    for (const c of derived.requests) {
      if (c.timing !== 'before-interaction' || c.phase === 'C') continue;
      if (!c.thirdParty && !c.firstPartyProxy) continue;
      const r = records.get(c.requestId);
      if (!r || (r.isNavigation && r.isMainFrame)) continue;
      const owner = ctx.routing[c.category] ?? ctx.routing.unknown;
      if (owner && owner !== ID) continue;
      const subject = subjects.service(c.serviceId, c.etld1);
      let g = groups.get(subject);
      if (!g) {
        g = { subject, serviceId: c.serviceId, etld1: c.etld1, category: c.category, items: [] };
        groups.set(subject, g);
      }
      g.items.push({ c, r, v: variantOf(c) });
    }

    const start = startPageUrl(browser);
    const phaseB = phaseRecord(browser, 'B');
    const bObserved = !!phaseB && phaseB.status !== 'skipped' && phaseB.pages.length > 0;
    const observations: Observation[] = [];
    for (const g of [...groups.values()].sort((a, b) => a.subject.localeCompare(b.subject))) {
      g.items.sort((a, b) => RANK.indexOf(a.v) - RANK.indexOf(b.v) || a.r.tStartMs - b.r.tStartMs);
      const best = g.items[0];
      if (!best) continue;
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
      const onStartInA = g.items.some((i) => i.c.phase === 'A' && i.r.pageUrl === start);
      if (onStartInA && bObserved) obs.replicated = g.items.some((i) => i.c.phase === 'B');
      observations.push(obs);
    }

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
