/**
 * EMBED-01 (P0): fonts loaded from external font services (category `fonts`) before consent (phase A) or after
 * the reject (phase B); a load after accepting (C) is not counted. A completed stylesheet/font/kit request →
 * `fonts-loaded`; only preconnect/dns-prefetch hints or an unconfirmed attempt → `preconnect-only` (info).
 * Self-hosted fonts and local proxies are first party and never match. `p.typekit.net` (purpose ⚠) alone is
 * not a font load. Bot or geo signal → inconclusive.
 */
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';
import {
  consentSignals,
  hasPhaseA,
  MAX_EVIDENCE,
  noPhaseAReason,
  requestEvidence,
  requestIndex,
  serviceFields,
  serviceName,
  signalOutcome,
  sortedUniq,
  throttleAware,
} from './shared.ts';

const ID = 'EMBED-01';
const LOAD_KINDS = new Set(['stylesheet', 'font', 'library', 'resource']);

interface Group {
  serviceId: string;
  loaded: ClassifiedRequest[];
  attempted: ClassifiedRequest[];
  hints: Array<{ href: string; rel: string; pageUrl: string; phase: Phase }>;
}

export const embed01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  variants: [
    { variant: 'fonts-loaded', variantGroup: 'fonts' },
    { variant: 'preconnect-only', variantGroup: 'fonts' },
  ],
  run({ browser, cmp, derived }) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const groups = new Map<string, Group>();
    const group = (serviceId: string) => {
      let g = groups.get(serviceId);
      if (!g) {
        g = { serviceId, loaded: [], attempted: [], hints: [] };
        groups.set(serviceId, g);
      }
      return g;
    };
    for (const c of derived.requests) {
      if (c.category !== 'fonts' || !c.serviceId || !c.thirdParty) continue;
      if (c.phase === 'C' || c.timing === 'after-accept') continue;
      if (!LOAD_KINDS.has(c.kind ?? 'resource')) continue;
      if (c.delivered) group(c.serviceId).loaded.push(c);
      else group(c.serviceId).attempted.push(c);
    }
    for (const h of derived.hints ?? []) {
      if (h.category !== 'fonts' || !h.serviceId || !h.thirdParty || h.phase === 'C') continue;
      if (h.rel !== 'preconnect' && h.rel !== 'dns-prefetch') continue;
      group(h.serviceId).hints.push({ href: h.href, rel: h.rel, pageUrl: h.pageUrl, phase: h.phase });
    }

    const observations: Observation[] = [];
    for (const g of [...groups.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId))) {
      const loaded = g.loaded.length > 0;
      const reqs = loaded ? g.loaded : g.attempted;
      const evidence: EvidenceInput[] = reqs.slice(0, MAX_EVIDENCE).flatMap((c) => {
        const r = records.get(c.requestId);
        return r ? [requestEvidence(r, c)] : [];
      });
      if (!loaded) {
        for (const h of g.hints.slice(0, MAX_EVIDENCE - evidence.length)) {
          evidence.push({
            type: 'link',
            href: h.href,
            text: `rel=${h.rel}`,
            phase: h.phase,
            page: h.pageUrl,
          });
        }
      }
      const pages = sortedUniq([
        ...reqs.flatMap((c) => records.get(c.requestId)?.pageUrl ?? []),
        ...(loaded ? [] : g.hints.map((h) => h.pageUrl)),
      ]);
      observations.push({
        checkId: ID,
        variant: loaded ? 'fonts-loaded' : 'preconnect-only',
        confidence: 'high',
        subject: subjects.service(g.serviceId),
        category: 'fonts',
        phases: sortedUniq([
          ...reqs.map((c) => c.phase),
          ...(loaded ? [] : g.hints.map((h) => h.phase)),
        ]) as Phase[],
        pages,
        evidence,
        params: {
          service: serviceName(derived, g.serviceId),
          pageCount: pages.length,
          afterReject: reqs.some((c) => c.timing === 'after-reject'),
        },
        ...serviceFields(derived, g.serviceId),
      });
    }
    return throttleAware(
      browser,
      {
        status: 'completed',
        observations,
        // The collector names the gap `preconnect-without-request`: match the prefix, not one spelling.
        limitations: browser.knownGaps.some((g) => g.startsWith('preconnect'))
          ? ['preconnect-not-observable']
          : [],
      },
      ['A', 'B'],
    );
  },
});
