/**
 * Exit-code gate (D03, table 5.2). Pure function.
 * Priority: 2 (fatal) > 1 (threshold) > 2 (check-error / timeout / strict) > 0.
 * `exitReasons` lists every reason that applies, not only the winning one.
 * `--fail-on none` switches off the threshold and the relevance of check errors; `--strict` acts independently.
 */
import type { FatalReason } from './errors.ts';
import type { CheckStatus, FailOn, Severity } from './report-schema.ts';

export type ExitCode = 0 | 1 | 2;

const RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

/** Does `severity` reach the `failOn` threshold ("достигнут или превышен")? `none` never matches. */
export function meetsThreshold(severity: Severity, failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  return RANK[severity] >= RANK[failOn];
}

export interface GateFinding {
  checkId: string;
  severity: Severity;
  /** Active (non-expired) suppression. Expired suppressions must be passed as `false`. */
  suppressed?: boolean;
  /** `unchanged` = covered by baseline (not counted); `severity-increased` counts again. */
  baselineStatus?: 'new' | 'unchanged' | 'severity-increased';
  /** Ruleset gating flag of the check/variant (default true). */
  gating?: boolean;
}

export interface GateCheck {
  id: string;
  status: CheckStatus;
  /** e.g. `timeout`, `collector-error`, `banner-not-recognized`. */
  reason?: string | null;
  /** Ruleset `gating`. */
  gating: boolean;
  /** Static max severity of the variants after ruleset and overrides (no confidence cap, 5.2); null = no variants. */
  maxSeverity: Severity | null;
  /** false when deselected (`--checks`). Default true. */
  enabled?: boolean;
}

export interface GateInput {
  failOn: FailOn;
  strict: boolean;
  /** Fatal conditions (scan `failed` or report not written). */
  fatal: readonly FatalReason[];
  findings: readonly GateFinding[];
  checks: readonly GateCheck[];
  /** `--sandbox off` was used (SCAN-SANDBOX-OFF). */
  sandboxOff: boolean;
  egressRegion: 'unknown' | 'asserted';
  /** Global `--timeout` hit (SCAN-TIMEOUT). */
  timedOut: boolean;
}

export interface GateResult {
  exitCode: ExitCode;
  exitReasons: string[];
}

const FATAL_REASON_CODE: Record<FatalReason, string> = {
  unreachable: 'unreachable',
  blocked: 'blocked',
  timeout: 'timeout',
  'sandbox-unavailable': 'sandbox-unavailable',
  // 5.2: "браузер не установлен или не стартовал" is in the invalid-input row.
  'browser-unavailable': 'invalid-input',
  'invalid-input': 'invalid-input',
  'internal-error': 'internal-error',
  'report-write-failed': 'report-write-failed',
};

/** Relevant check (5.2): enabled, gating and able to reach `failOn`. */
export function isRelevant(check: GateCheck, failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  if (check.enabled === false || !check.gating || check.maxSeverity === null) return false;
  return meetsThreshold(check.maxSeverity, failOn);
}

/**
 * Checks whose `inconclusive` counts for `--strict`. With a threshold these are the relevant checks; under
 * `--fail-on none` strict still acts (5.2) on enabled gating checks that can reach at least `warning`, so `none`
 * is never stricter than `--fail-on warning` (info never gates).
 */
export function isStrictScope(check: GateCheck, failOn: FailOn): boolean {
  return isRelevant(check, failOn === 'none' ? 'warning' : failOn);
}

/** Counted finding (5.2): not suppressed, not covered by baseline, severity ≥ failOn. */
export function isCounted(finding: GateFinding, failOn: FailOn): boolean {
  if (finding.suppressed) return false;
  if (finding.baselineStatus === 'unchanged') return false;
  if (finding.gating === false) return false;
  return meetsThreshold(finding.severity, failOn);
}

export function gate(input: GateInput): GateResult {
  const reasons: string[] = [];
  const fatal = [...new Set(input.fatal.map((f) => FATAL_REASON_CODE[f]))];
  reasons.push(...fatal);

  if (input.failOn !== 'none') {
    const threshold = input.findings.some((f) => isCounted(f, input.failOn));
    if (threshold) reasons.push('threshold');

    const relevant = input.checks.filter((c) => isRelevant(c, input.failOn));
    const errored = relevant.filter((c) => c.status === 'error');
    for (const c of sortById(errored)) reasons.push(`check-error:${c.id}`);
    if (input.timedOut && errored.some((c) => c.reason === 'timeout') && !reasons.includes('timeout')) {
      reasons.push('timeout');
    }
  }

  // 5.2: "--strict действует независимо" — also under --fail-on none.
  if (input.strict) {
    const inconclusive = input.checks.filter(
      (c) => c.status === 'inconclusive' && isStrictScope(c, input.failOn),
    );
    for (const c of sortById(inconclusive)) reasons.push(`strict:inconclusive:${c.id}`);
    if (input.sandboxOff) reasons.push('strict:sandbox-off');
    const consentEnabled = input.checks.some((c) => c.enabled !== false && c.id.startsWith('CONSENT-'));
    if (input.egressRegion === 'unknown' && consentEnabled) reasons.push('strict:egress-unverified');
  }

  let exitCode: ExitCode = 0;
  if (fatal.length > 0) exitCode = 2;
  else if (reasons.includes('threshold')) exitCode = 1;
  else if (reasons.length > 0) exitCode = 2;
  return { exitCode, exitReasons: reasons };
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}
