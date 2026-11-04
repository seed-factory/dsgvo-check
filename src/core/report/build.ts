/** Report assembly: full report for complete/partial scans, minimal report for failed ones. */

import { disclaimerText } from '../data/disclaimer.ts';
import type { Ruleset, Texts } from '../data/load.ts';
import { uiText } from '../data/messages.ts';
import { TOOL_NAME, TOOL_VERSION } from '../runtime/version.ts';
import type { Snapshot } from '../snapshot/index.ts';
import {
  type CheckResult,
  type Counts,
  type Diagnostic,
  type Disclaimer,
  type Evidence,
  type FailedReport,
  type Finding,
  type FullReport,
  type LegalContext,
  type ReportScanOptions,
  type RulesetInfo,
  SCHEMA_VERSION,
  type ScanCoverage,
  type ScanEnvironment,
} from './schema.ts';

export function disclaimerOf(texts: Texts): Disclaimer {
  const entry = texts.ui.disclaimer;
  return {
    messageId: 'disclaimer',
    lang: texts.lang,
    text: entry ? uiText(texts, 'disclaimer') : 'Technical observations only; not legal advice.',
    draft: entry?.draft ?? true,
  };
}

export function rulesetInfo(ruleset: Ruleset): RulesetInfo {
  return {
    version: ruleset.profile.version,
    rechtsstand: ruleset.profile.rechtsstand,
    profile: ruleset.profile.id,
    draft: ruleset.profile.draft,
  };
}

export function countFindings(findings: readonly Finding[], checks: readonly CheckResult[]): Counts {
  const active = findings.filter((f) => !(f.suppression && !f.suppression.expired));
  return {
    critical: active.filter((f) => f.severity === 'critical').length,
    warning: active.filter((f) => f.severity === 'warning').length,
    info: active.filter((f) => f.severity === 'info').length,
    suppressed: findings.length - active.length,
    checkErrors: checks.filter((c) => c.status === 'error').length,
    inconclusive: checks.filter((c) => c.status === 'inconclusive').length,
  };
}

export function legalContextOf(ruleset: Ruleset, texts: Texts, findings: readonly Finding[]): LegalContext {
  const ids = [...new Set(findings.map((f) => f.legalNoteId).filter((x): x is string => x !== null))].sort();
  return {
    rechtsstand: ruleset.profile.rechtsstand,
    notes: ids
      .filter((id) => texts.legalNotes[id])
      .map((id) => {
        const n = texts.legalNotes[id]!;
        return { id, status: n.status, reviewedAt: n.reviewedAt, reviewBy: n.reviewBy, draft: n.draft };
      }),
  };
}

const PROTOTYPE_GAPS = [
  'phase-a-prime-not-implemented',
  'phase-m-not-implemented',
  'egress-proxy-not-implemented',
];

export function environmentOf(snapshot: Snapshot): ScanEnvironment {
  const b = snapshot.browser;
  return {
    userAgent: snapshot.environment.userAgent,
    browser: b
      ? {
          engine: b.engine.name,
          version: b.engine.version,
          channel: b.engine.channel,
          headless: b.engine.headless,
        }
      : null,
    sandbox: snapshot.environment.sandbox,
    profile: b ? 'persistent-tmp' : null,
    viewport: b?.viewport ?? null,
    locale: snapshot.environment.locale,
    timezone: snapshot.environment.timezone,
    egress: snapshot.environment.egress,
    disabledChromiumFeatures: b?.engine.disabledFeatures ?? [],
    quic: 'disabled',
    knownGaps: [...new Set([...(b?.knownGaps ?? []), ...PROTOTYPE_GAPS])],
    requestsIssued: {
      navigations: (b?.phases ?? []).reduce((n, p) => n + p.pages.length, 0),
      probes: snapshot.http?.requestsIssued ?? 0,
      dns: snapshot.dns?.queries.length ?? 0,
      tls: snapshot.tls?.endpoints.length ?? 0,
    },
    node: snapshot.environment.node,
    platform: snapshot.environment.platform,
  };
}

export function coverageOf(snapshot: Snapshot): ScanCoverage {
  return {
    pages: pageCoverage(snapshot),
    collectors: collectorCoverage(snapshot),
    ...(snapshot.browser ? { browserRequests: snapshot.browser.requestCap } : {}),
  };
}

/** One row per page that was planned or visited, with what happened to it. */
function pageCoverage(snapshot: Snapshot): ScanCoverage['pages'] {
  const planned = snapshot.plan.browser?.pages ?? [];
  const control = snapshot.plan.browser?.controlPages ?? [];
  const visits = (snapshot.browser?.phases ?? []).flatMap((p) => p.pages);
  const plans = [...planned, ...control];

  // A visit is the page as shown (`finalUrl`); a plan entry matches it by the requested or the final URL, so a
  // redirected start page (requested URL in A, final URL in plan and B/C) is one row.
  const planOf = (v: (typeof visits)[number]) => plans.find((p) => p.url === v.url || p.url === v.finalUrl);
  const keyOf = (v: (typeof visits)[number]) => planOf(v)?.url ?? (v.finalUrl || v.url);
  const urls = [...new Set([...plans.map((p) => p.url), ...visits.map(keyOf)])];

  return urls.map((url) => {
    const plan = plans.find((p) => p.url === url);
    const seen = visits.filter((v) => keyOf(v) === url);
    const evaluable = seen.some((v) => v.evaluable);
    const reason = seen.find((v) => !v.evaluable)?.notEvaluableReason;
    return {
      url,
      role: plan?.role ?? seen[0]?.role ?? 'other',
      planned: Boolean(plan),
      observed: seen.length > 0,
      evaluated: evaluable,
      phases: [...new Set(seen.map((v) => v.phase))],
      ...(reason ? { reason } : {}),
    };
  });
}

function collectorCoverage(snapshot: Snapshot): ScanCoverage['collectors'] {
  const collectors: ScanCoverage['collectors'] = {};
  for (const [name, st] of Object.entries(snapshot.collection)) {
    if (!st) continue;
    collectors[name] = {
      status: st.status,
      durationMs: st.durationMs,
      ...(st.reason ? { reason: st.reason } : {}),
    };
  }
  return collectors;
}

export interface FullReportInput {
  snapshot: Snapshot;
  status: 'complete' | 'partial';
  startedAt: string;
  durationMs: number;
  /** Only for a re-evaluated snapshot: when the evaluation ran. */
  evaluatedAt?: string;
  options: ReportScanOptions;
  ruleset: Ruleset;
  texts: Texts;
  checks: CheckResult[];
  findings: Finding[];
  diagnostics: Diagnostic[];
  evidence: Evidence[];
  exitCode: 0 | 1 | 2;
  exitReasons: string[];
}

export function buildFullReport(i: FullReportInput): FullReport {
  const report: FullReport = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    ruleset: rulesetInfo(i.ruleset),
    datasets: (i.snapshot.derived?.datasets ?? []).map((d) => ({ ...d })),
    scan: {
      status: i.status,
      target: i.snapshot.target.url,
      finalUrl: i.snapshot.target.finalUrl,
      startedAt: i.startedAt,
      durationMs: i.durationMs,
      ...(i.evaluatedAt ? { evaluatedAt: i.evaluatedAt } : {}),
      environment: environmentOf(i.snapshot),
      coverage: coverageOf(i.snapshot),
      options: i.options,
    },
    checks: i.checks,
    findings: i.findings,
    diagnostics: i.diagnostics,
    evidence: i.evidence,
    legalContext: legalContextOf(i.ruleset, i.texts, i.findings),
    summary: {
      counts: countFindings(i.findings, i.checks),
      exitCode: i.exitCode,
      exitReasons: i.exitReasons,
    },
    disclaimer: disclaimerOf(i.texts),
  };
  // The conditional paragraphs belong to the report itself, not only to the written files.
  report.disclaimer.text = disclaimerText(report, i.texts);
  return report;
}

export interface FailedReportInput {
  target: string;
  startedAt: string;
  durationMs?: number;
  evaluatedAt?: string;
  failure: { code: string; message: string };
  exitReasons: string[];
  texts: Texts | null;
  ruleset?: Ruleset | null;
  snapshot?: Snapshot | null;
  options?: ReportScanOptions;
  /** Results gathered before the failure are kept. */
  checks?: CheckResult[];
  findings?: Finding[];
  diagnostics?: Diagnostic[];
  evidence?: Evidence[];
}

const FALLBACK_DISCLAIMER: Disclaimer = {
  messageId: 'disclaimer',
  lang: 'de',
  text: 'Technische Beobachtungen eines automatisierten Scans; keine Rechtsberatung. Textentwurf.',
  draft: true,
};

export function buildFailedReport(i: FailedReportInput): FailedReport {
  const report: FailedReport = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    scan: {
      status: 'failed',
      target: i.target,
      startedAt: i.startedAt,
      failure: i.failure,
      ...(i.durationMs !== undefined ? { durationMs: i.durationMs } : {}),
      ...(i.evaluatedAt ? { evaluatedAt: i.evaluatedAt } : {}),
      ...(i.options ? { options: i.options } : {}),
    },
    summary: {
      exitCode: 2,
      exitReasons: i.exitReasons.length > 0 ? i.exitReasons : ['internal-error'],
    },
    disclaimer: i.texts ? disclaimerOf(i.texts) : FALLBACK_DISCLAIMER,
  };

  if (i.ruleset) report.ruleset = rulesetInfo(i.ruleset);
  if (i.snapshot) {
    report.scan.finalUrl = i.snapshot.target.finalUrl;
    report.scan.environment = environmentOf(i.snapshot);
    report.scan.coverage = coverageOf(i.snapshot);
  }

  if (i.checks) {
    report.checks = i.checks;
    report.findings = i.findings ?? [];
    report.diagnostics = i.diagnostics ?? [];
    report.evidence = i.evidence ?? [];
    report.summary.counts = countFindings(report.findings, i.checks);
  } else if (i.diagnostics?.length) {
    report.diagnostics = i.diagnostics;
  }

  if (i.texts) report.disclaimer.text = disclaimerText(report, i.texts);
  return report;
}
