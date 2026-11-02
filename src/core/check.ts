/**
 * A check is a pure function over its snapshot slice: no I/O, no Playwright,
 * no `node:*` network/file modules (enforced by Biome `noRestrictedImports` in src/checks/**).
 * Severity is NOT decided by the check: it comes from the ruleset by (checkId, variant), capped by confidence.
 */
import type { CheckStatus, Confidence, Evidence, KnownEvidenceType, MessageParams } from './report-schema.ts';
import type { DiagnosticInput, Phase, SnapshotSectionKey, SnapshotSlice } from './snapshot.ts';

export type CheckModule = 'browser' | 'http' | 'dns';

export interface CheckVariant {
  /** Stable id within the check, kebab-case, e.g. `fonts-loaded`. Message key = `<checkId>.<variant>`. */
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
  /** Fingerprint subject (5.4), see `subjects` helpers in core/fingerprint.ts. Never contains the target host. */
  subject: string;
  serviceId?: string;
  /** Service category; enables routing de-duplication. */
  category?: string;
  phases: Phase[];
  /** Sanitized page URLs. */
  pages: string[];
  evidence: EvidenceInput[];
  /** Message parameters for `data/texts/<lang>/*.yaml` key `<checkId>.<variant>`. Only safe values. */
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
  /** Machine code: `banner-not-recognized`, `tls-blocked`, `bot-mode`, `geo`, `no-wordpress`, … */
  reason?: string;
  /** Machine codes, e.g. `pdf-not-evaluated`, `lexicon-changed-since-scan`. */
  limitations?: string[];
  observations: Observation[];
  coverage?: { planned?: number; observed?: number; evaluated?: number; note?: string };
  /** Diagnostics raised by the check (SCAN-BOTMODE, SCAN-GEO…). Merged by code with collector diagnostics. */
  diagnostics?: DiagnosticInput[];
}

export type CheckRunResult = readonly Observation[] | CheckOutcome;

export interface CheckContext {
  /** Injected clock (certificate expiry, suppressions). */
  readonly now: Date;
  readonly lang: 'de' | 'en';
  /** Service category → owning check id (data/routing.yaml). */
  readonly routing: Readonly<Record<string, string>>;
  /** Data directories declared in `Check.data`, loaded and merged from data/<name>/*.yaml. Validate with zod. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly options: {
    readonly strict: boolean;
    readonly assumeRegion: 'eea' | 'de' | null;
    readonly fromSnapshot: boolean;
  };
}

export interface Check<K extends SnapshotSectionKey = SnapshotSectionKey> {
  /** Catalog id, e.g. `EMBED-01`. */
  id: string;
  module: CheckModule;
  /** Snapshot sections the check reads. A missing section → status `error` (collector failed) or `skipped`. */
  requires: readonly K[];
  /** All variants the check can emit (static; completeness test requires ruleset/texts/crm/fixtures for each). */
  variants: readonly CheckVariant[];
  /** Optional data directories under data/ to load into `ctx.data` (e.g. `cmp`, `services`). */
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
