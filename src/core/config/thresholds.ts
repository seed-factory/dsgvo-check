/** The settings that decide what a check reports; checks get them through `CheckContext`, never by importing the config. */
import type { CheckThresholds } from '../evaluation/check.ts';
import type { Config } from './schema.ts';

export function checkThresholds(config: Config): CheckThresholds {
  const { cmp, dns, legal, tls } = config;
  return {
    cmp: { blockingCoveredRatio: cmp.blockingCoveredRatio, minCandidatePages: cmp.minCandidatePages },
    dns: { dkimMinRsaBits: dns.dkimMinRsaBits },
    legal: {
      impressumMinGroups: legal.impressumMinGroups,
      policyClaimMinContexts: legal.policyClaimMinContexts,
    },
    tls: {
      shortLivedDays: tls.shortLivedDays,
      expiringDays: tls.expiringDays,
      expiringLifetimeShare: tls.expiringLifetimeShare,
      approachingDays: tls.approachingDays,
      approachingLifetimeShare: tls.approachingLifetimeShare,
    },
  };
}
