/**
 * A check is a pure function over its snapshot slice (no I/O, enforced by Biome `noRestrictedImports` in src/checks/**).
 * Severity is not decided by the check: it comes from the ruleset by (checkId, variant), capped by confidence.
 */
import type { Config } from '../config/schema.ts';
import type {
  AssumeRegion,
  CheckStatus,
  Confidence,
  Evidence,
  KnownEvidenceType,
  Lang,
  MessageParams,
} from '../report/schema.ts';
import type { DiagnosticInput, Phase, SnapshotSectionKey, SnapshotSlice } from '../snapshot/index.ts';

export type CheckModule = 'browser' | 'http' | 'dns';

export interface CheckVariant {
  /** Stable kebab-case id within the check, e.g. `fonts-loaded`; the message key is `<checkId>.<variant>`. */
  variant: string;
  /** Fingerprint group (defaults to `variant`). Variants of one group share a fingerprint for the same subject. */
  variantGroup?: string;
  /** Static confidence ceiling; gating uses the uncapped severity. */
  maxConfidence?: Confidence;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Evidence as produced by checks: the store assigns `id`. Only known evidence types are typed. */
export type EvidenceInput = DistributiveOmit<Extract<Evidence, { type: KnownEvidenceType }>, 'id'>;

/** Link to another check's finding (resolved to a fingerprint by assess when that finding exists). */
export interface RelatedRef {
  checkId: string;
  subject: string;
  /** Optional, e.g. `same-service`, `inventory`. */
  relation?: string;
}

/** One raw observation. Assess turns it into a finding (severity, fingerprint, crmCode, evidence ids). */
export interface Observation {
  /** Must equal the emitting check's id. */
  checkId: string;
  /** Must be one of the check's static `variants`. */
  variant: string;
  confidence: Confidence;
  /** Fingerprint subject; never contains the target host. */
  subject: string;
  serviceId?: string;
  /** Service category; enables routing de-duplication. */
  category?: string;
  phases: Phase[];
  /** Sanitized page URLs. */
  pages: string[];
  evidence: EvidenceInput[];
  /** Message parameters for the text `<checkId>.<variant>`; only safe values. */
  params: MessageParams;
  /** e.g. `interaction-without-consent`. */
  trigger?: string;
  /** false: not reproduced in B-before-click; the level is kept. */
  replicated?: boolean;
  related?: RelatedRef[];
  /** Where the classification came from (catalog, third-party-web, …). */
  classification?: { source: string; datasetVersion: string | null };
  provider?: { name: string; country: string | null };
  parent?: { name: string; country: string | null };
  dpfEntity?: { name: string; listed: boolean | null; checkedAt: string | null; source: string | null };
}

/** Full result of `run`. Returning a bare `Observation[]` means `{ status: 'completed', observations }`. */
export interface CheckOutcome {
  status: Exclude<CheckStatus, 'error'>;
  /** Machine code, e.g. `banner-not-recognized`, `tls-blocked`, `bot-mode`, `geo`. */
  reason?: string;
  /** Machine codes, e.g. `pdf-not-evaluated`, `lexicon-changed-since-scan`. */
  limitations?: string[];
  observations: Observation[];
  coverage?: { planned?: number; observed?: number; evaluated?: number; note?: string };
  /** Diagnostics raised by the check; merged by code with collector diagnostics. */
  diagnostics?: DiagnosticInput[];
}

export type CheckRunResult = readonly Observation[] | CheckOutcome;

/** Operator settings that decide what a check reports (see `src/core/config`). */
export interface CheckThresholds {
  /**
   * CONSENT-04: share of the viewport a banner covers to count as blocking. Browser checks: pages a banner candidate
   * the heuristic did not take must show on.
   */
  cmp: Pick<Config['cmp'], 'blockingCoveredRatio' | 'minCandidatePages'>;
  /**
   * Policy and Impressum checks: kinds of provider details that make a block of text Impressum details, and the
   * observations a statement of the privacy policy must differ from to count as repeated.
   */
  legal: Pick<Config['legal'], 'impressumMinGroups' | 'policyClaimMinContexts'>;
  /** TLS-02: certificate lifetime windows. */
  tls: Pick<
    Config['tls'],
    | 'shortLivedDays'
    | 'expiringDays'
    | 'expiringLifetimeShare'
    | 'approachingDays'
    | 'approachingLifetimeShare'
  >;
}

export interface CheckContext {
  /** Injected clock (certificate expiry, suppressions). */
  readonly now: Date;
  readonly lang: Lang;
  /** Service category → owning check id (test/data/routing.yaml). */
  readonly routing: Readonly<Record<string, string>>;
  /** Data directories declared in `Check.data`, merged from test/data/<name>/*.yaml; validate with zod. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly options: {
    readonly strict: boolean;
    readonly assumeRegion: AssumeRegion | null;
    readonly fromSnapshot: boolean;
  };
  readonly thresholds: CheckThresholds;
}

export interface Check<K extends SnapshotSectionKey = SnapshotSectionKey> {
  /** Catalog id, e.g. `EMBED-01`. */
  id: string;
  module: CheckModule;
  /** Snapshot sections the check reads. A missing section → status `error` (collector failed) or `skipped`. */
  requires: readonly K[];
  /** All variants the check can emit; the completeness test requires ruleset, texts and fixtures for each. */
  variants: readonly CheckVariant[];
  /** Optional data directories under test/data/ to load into `ctx.data` (e.g. `cmp`, `services`). */
  data?: readonly string[];
  /** Pure. Throwing → status `error` with `check-error:<id>` (gate decides the exit code). */
  run(slice: SnapshotSlice<K>, ctx: CheckContext): CheckRunResult;
}

/** Type helper: infers `K` from `requires` so `slice` is typed precisely. */
export function defineCheck<const K extends SnapshotSectionKey>(check: Check<K>): Check<K> {
  return check;
}

/** Erased check type for registries. */
// biome-ignore lint/suspicious/noExplicitAny: registry stores checks with different slice types
export type AnyCheck = Check<any>;

export function normalizeOutcome(result: CheckRunResult): CheckOutcome {
  if (Array.isArray(result))
    return { status: 'completed', observations: [...(result as readonly Observation[])] };
  return result as CheckOutcome;
}

export function variantGroupOf(check: Pick<AnyCheck, 'variants'>, variant: string): string | undefined {
  const v = check.variants.find((x) => x.variant === variant);
  return v ? (v.variantGroup ?? v.variant) : undefined;
}
