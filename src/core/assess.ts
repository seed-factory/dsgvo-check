/**
 * Assess (5.1): observations → findings. Severity comes from the ruleset by (checkId, variant),
 * user overrides apply, then the confidence cap (medium → ≤ warning, low → ≤ info). Routing drops observations
 * whose service category belongs to another owner check; observations with the same fingerprint are merged.
 */
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { AnyCheck, CheckOutcome, EvidenceInput, Observation } from './check.ts';
import type { Routing, Ruleset, Texts } from './data.ts';
import { fingerprint } from './fingerprint.ts';
import { severityRank } from './gate.ts';
import { renderMessage } from './messages.ts';
import type {
  CheckResult,
  CheckStatus,
  Confidence,
  Diagnostic,
  Evidence,
  Finding,
  Severity,
} from './report-schema.ts';
import type { DiagnosticInput } from './snapshot.ts';

export const MAX_EVIDENCE_PER_FINDING = 20;

export interface SeverityOverride {
  /** `CHECK-ID` or `CHECK-ID.variant`. */
  rule: string;
  severity: Severity;
}

/** What the orchestrator knows about one executed (or not executed) check. */
export interface ExecutedCheck {
  status: CheckStatus;
  reason: string | null;
  outcome: CheckOutcome | null;
  durationMs: number;
  error?: { code: string; message: string };
  limitations?: string[];
}

export interface AssessInput {
  checks: readonly AnyCheck[];
  executed: ReadonlyMap<string, ExecutedCheck>;
  ruleset: Ruleset;
  routing: Routing;
  overrides?: readonly SeverityOverride[];
  /** When given, findings carry a rendered `text`. */
  texts?: Texts;
}

export interface AssessOutput {
  findings: Finding[];
  evidence: Evidence[];
  checks: CheckResult[];
}

const CAP: Record<Confidence, Severity> = { high: 'critical', medium: 'warning', low: 'info' };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

export function minSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

export function capByConfidence(severity: Severity, confidence: Confidence): Severity {
  return minSeverity(severity, CAP[confidence]);
}

/** Ruleset severity for (checkId, variant) with overrides applied; undefined when the ruleset has no entry. */
export function resolveSeverity(
  ruleset: Ruleset,
  checkId: string,
  variant: string,
  overrides: readonly SeverityOverride[] = [],
): Severity | undefined {
  const entry = ruleset.checks[checkId]?.variants[variant];
  const base = entry?.severity;
  if (base === undefined) return undefined;
  if (entry?.locked) return base;
  const variantRule = overrides.find((o) => o.rule === `${checkId}.${variant}`);
  if (variantRule) return variantRule.severity;
  const checkRule = overrides.find((o) => o.rule === checkId);
  // A whole-check override does not raise its info variants (5.4 "Конфиг").
  if (checkRule && base !== 'info') return checkRule.severity;
  return base;
}

/** Override rules that name a `locked` variant (5.4: such a rule is a configuration error). */
export function lockedOverrides(ruleset: Ruleset, overrides: readonly SeverityOverride[]): string[] {
  return overrides
    .map((o) => o.rule)
    .filter((rule) => {
      const dot = rule.indexOf('.');
      if (dot < 0) return false;
      return ruleset.checks[rule.slice(0, dot)]?.variants[rule.slice(dot + 1)]?.locked === true;
    });
}

/**
 * Max severity of a check for gate relevance (5.2): the static maximum of its variants after ruleset and overrides.
 * The confidence cap is not applied: a failed check has no confidence; the cap applies to concrete findings only.
 */
export function maxSeverityOf(
  check: AnyCheck,
  ruleset: Ruleset,
  overrides: readonly SeverityOverride[] = [],
): Severity | null {
  let max: Severity | null = null;
  for (const v of check.variants) {
    const sev = resolveSeverity(ruleset, check.id, v.variant, overrides);
    if (sev === undefined) continue;
    if (max === null || severityRank(sev) > severityRank(max)) max = sev;
  }
  return max;
}

export function isGating(ruleset: Ruleset, checkId: string, variant?: string): boolean {
  const entry = ruleset.checks[checkId];
  if (!entry) return false;
  if (variant !== undefined) {
    const v = entry.variants[variant];
    if (v?.gating !== undefined) return v.gating;
  }
  return entry.gating;
}

/** Deduplicating evidence store with deterministic ids (`ev-<12 hex>` of the canonical content). */
export class EvidenceStore {
  readonly #byId = new Map<string, Evidence>();

  add(input: EvidenceInput): string {
    const json = canonicalize(input);
    if (json === undefined) throw new Error('evidence is not serializable');
    const id = `ev-${createHash('sha256').update(json).digest('hex').slice(0, 12)}`;
    if (!this.#byId.has(id)) this.#byId.set(id, { id, ...input } as Evidence);
    return id;
  }

  all(): Evidence[] {
    return [...this.#byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

interface Draft {
  obs: Observation;
  severity: Severity;
  variantGroup: string;
  fp: string;
  phases: Set<string>;
  pages: Set<string>;
  evidence: EvidenceInput[];
}

export function assess(input: AssessInput): AssessOutput {
  const overrides = input.overrides ?? [];
  const store = new EvidenceStore();
  const routingOwners = new Set(Object.values(input.routing));
  const findings: Finding[] = [];
  const results: CheckResult[] = [];
  const bySubject = new Map<string, Finding[]>(); // `${checkId}|${subject}` → findings

  for (const check of input.checks) {
    const exec = input.executed.get(check.id);
    const maxSeverity = maxSeverityOf(check, input.ruleset, overrides);
    const gating = isGating(input.ruleset, check.id);
    const base = {
      id: check.id,
      module: check.module,
      maxSeverity: maxSeverity ?? undefined,
      gating,
    };
    if (!exec) {
      results.push({
        ...base,
        status: 'skipped',
        reason: 'not-run',
        limitations: [],
        coverage: null,
        durationMs: 0,
      });
      continue;
    }
    if (exec.status === 'error' || !exec.outcome) {
      results.push({
        ...base,
        status: exec.status,
        reason: exec.reason,
        limitations: exec.limitations ?? [],
        coverage: null,
        durationMs: exec.durationMs,
        ...(exec.error ? { error: exec.error } : {}),
      });
      continue;
    }

    const outcome = exec.outcome;
    const limitations = [...(exec.limitations ?? []), ...(outcome.limitations ?? [])];
    const drafts = new Map<string, Draft>();
    let invalid: string | null = null;

    for (const obs of outcome.observations) {
      const variant = check.variants.find((v) => v.variant === obs.variant);
      if (obs.checkId !== check.id || !variant) {
        invalid = `invalid observation ${obs.checkId}.${obs.variant}`;
        break;
      }
      if (obs.category && routingOwners.has(check.id)) {
        const owner = input.routing[obs.category];
        if (owner && owner !== check.id) continue;
      }
      const ruleSeverity = resolveSeverity(input.ruleset, check.id, obs.variant, overrides);
      if (ruleSeverity === undefined) {
        invalid = `ruleset entry missing for ${check.id}.${obs.variant}`;
        break;
      }
      const severity = capByConfidence(ruleSeverity, obs.confidence);
      const variantGroup = variant.variantGroup ?? variant.variant;
      const fp = fingerprint({ checkId: check.id, variantGroup, subject: obs.subject });
      const existing = drafts.get(fp);
      if (!existing) {
        drafts.set(fp, {
          obs,
          severity,
          variantGroup,
          fp,
          phases: new Set(obs.phases),
          pages: new Set(obs.pages),
          evidence: [...obs.evidence],
        });
        continue;
      }
      for (const p of obs.phases) existing.phases.add(p);
      for (const p of obs.pages) existing.pages.add(p);
      existing.evidence.push(...obs.evidence);
      const stronger =
        severityRank(severity) > severityRank(existing.severity) ||
        (severity === existing.severity &&
          CONFIDENCE_RANK[obs.confidence] > CONFIDENCE_RANK[existing.obs.confidence]);
      if (stronger) {
        existing.obs = obs;
        existing.severity = severity;
      }
    }

    if (invalid) {
      results.push({
        ...base,
        status: 'error',
        reason: 'invalid-observation',
        limitations,
        coverage: null,
        durationMs: exec.durationMs,
        error: { code: 'invalid-observation', message: invalid },
      });
      continue;
    }

    for (const d of drafts.values()) {
      const ids: string[] = [];
      for (const ev of d.evidence) {
        const id = store.add(ev);
        if (!ids.includes(id)) ids.push(id);
      }
      const messageId = `${check.id}.${d.obs.variant}`;
      const finding: Finding = {
        checkId: check.id,
        variant: d.obs.variant,
        variantGroup: d.variantGroup,
        severity: d.severity,
        confidence: d.obs.confidence,
        crmCode: input.ruleset.checks[check.id]?.variants[d.obs.variant]?.crm ?? null,
        fingerprint: d.fp,
        subject: d.obs.subject,
        phases: [...d.phases],
        pages: [...d.pages].sort(),
        evidenceIds: ids.slice(0, MAX_EVIDENCE_PER_FINDING),
        messageId,
        params: d.obs.params,
        legalNoteId: check.id,
        related: [],
        classification: d.obs.classification ?? { source: 'check', datasetVersion: null },
      };
      if (ids.length > MAX_EVIDENCE_PER_FINDING) finding.evidenceTruncated = true;
      if (d.obs.serviceId) finding.serviceId = d.obs.serviceId;
      if (d.obs.trigger) finding.trigger = d.obs.trigger;
      if (d.obs.replicated !== undefined) finding.replicated = d.obs.replicated;
      if (d.obs.provider) finding.provider = d.obs.provider;
      if (d.obs.parent) finding.parent = d.obs.parent;
      if (d.obs.dpfEntity) finding.dpfEntity = d.obs.dpfEntity;
      if (input.texts) {
        const msg = renderMessage(input.texts, messageId, d.obs.params);
        finding.text = { lang: input.texts.lang, title: msg.title, body: msg.body, draft: msg.draft };
      }
      findings.push(finding);
      const key = `${check.id}|${finding.subject}`;
      bySubject.set(key, [...(bySubject.get(key) ?? []), finding]);
    }

    results.push({
      ...base,
      status: outcome.status,
      reason: outcome.reason ?? exec.reason ?? null,
      limitations: [...new Set(limitations)],
      coverage: outcome.coverage ?? null,
      durationMs: exec.durationMs,
    });
  }

  linkRelated(findings, bySubject, input.checks, input.executed);
  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.checkId.localeCompare(b.checkId) ||
      a.subject.localeCompare(b.subject) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return { findings, evidence: store.all(), checks: results };
}

function linkRelated(
  findings: Finding[],
  bySubject: Map<string, Finding[]>,
  checks: readonly AnyCheck[],
  executed: ReadonlyMap<string, ExecutedCheck>,
): void {
  const byService = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.serviceId) byService.set(f.serviceId, [...(byService.get(f.serviceId) ?? []), f]);
  }
  const relatedRefs = new Map<string, Observation['related']>();
  for (const c of checks) {
    for (const o of executed.get(c.id)?.outcome?.observations ?? []) {
      if (o.related?.length) relatedRefs.set(`${o.checkId}|${o.subject}`, o.related);
    }
  }
  for (const f of findings) {
    const out = new Map<string, Finding['related'][number]>();
    for (const other of byService.get(f.serviceId ?? '') ?? []) {
      if (other.checkId !== f.checkId) {
        out.set(other.fingerprint, {
          checkId: other.checkId,
          fingerprint: other.fingerprint,
          relation: 'same-service',
        });
      }
    }
    for (const ref of relatedRefs.get(`${f.checkId}|${f.subject}`) ?? []) {
      for (const target of bySubject.get(`${ref.checkId}|${ref.subject}`) ?? []) {
        if (target.fingerprint === f.fingerprint) continue;
        out.set(target.fingerprint, {
          checkId: target.checkId,
          fingerprint: target.fingerprint,
          relation: ref.relation ?? 'related',
        });
      }
    }
    f.related = [...out.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  }
}

/** Merge diagnostics by code (union of affected checks), stable order. */
export function mergeDiagnostics(inputs: readonly DiagnosticInput[]): Diagnostic[] {
  const byCode = new Map<string, Diagnostic>();
  for (const d of inputs) {
    const existing = byCode.get(d.code);
    if (existing) {
      existing.affects = [...new Set([...existing.affects, ...d.affects])].sort();
      if (d.params) existing.params = { ...(existing.params ?? {}), ...d.params };
    } else {
      byCode.set(d.code, {
        code: d.code,
        affects: [...new Set(d.affects)].sort(),
        evidenceIds: [],
        messageId: `diagnostic.${d.code}`,
        ...(d.params ? { params: d.params } : {}),
      });
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}
