/**
 * Canary aggregation: site results → summary.json. No site names by default (ids, hosts and free text are left out,
 * machine codes are scrubbed of hosts); `withSites` adds a per-site table for local analysis only.
 */
import { type CheckStatus, type Severity, SeveritySchema } from '../../src/core/report/schema.ts';
import { type Confidence, DETECTED_CMPS, type DetectedCmpId, type SiteResult } from './load.ts';
import type { SiteMeta, SiteRef } from './results.ts';
import { EXPECTED_CMPS, type ExpectedCmp, KNOWN_CMPS, type KnownCmp, type Region } from './sites.ts';

export const GROUPS = ['all', 'eu-eea', 'de', 'eu', 'non-eu'] as const;
export type GroupKey = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<GroupKey, string> = {
  all: 'all',
  'eu-eea': 'EU/EEA',
  de: 'DE',
  eu: 'EU/EEA w/o DE',
  'non-eu': 'non-EU',
};
const GROUP_MEMBERS: Record<GroupKey, readonly Region[]> = {
  all: ['de', 'eu', 'non-eu'],
  'eu-eea': ['de', 'eu'],
  de: ['de'],
  eu: ['eu'],
  'non-eu': ['non-eu'],
};

export const CHECK_STATUSES: readonly CheckStatus[] = [
  'completed',
  'partial',
  'inconclusive',
  'not_applicable',
  'error',
  'skipped',
];
export const SEVERITIES: readonly Severity[] = SeveritySchema.options;
export const SCAN_STATUSES = ['complete', 'partial', 'failed', 'no-report'] as const;
type ScanStatusKey = (typeof SCAN_STATUSES)[number];

export interface DurationStats {
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface CheckAggregate {
  /** Reports that contain the check. */
  results: number;
  /** results − skipped. */
  evaluated: number;
  inconclusive: number;
  /** inconclusive / evaluated; null when nothing was evaluated. */
  inconclusiveShare: number | null;
  statuses: Record<CheckStatus, number>;
  /** `<status>:<reason>` for every non-completed result. */
  reasons: Record<string, number>;
}

export interface GroupAggregate {
  sites: number;
  finished: number;
  pending: number;
  runnerErrors: number;
  scanStatus: Record<ScanStatusKey, number>;
  exitCodes: Record<string, number>;
  failureCodes: Record<string, number>;
  exitReasons: Record<string, number>;
  /** Sites per SCAN-* code. */
  diagnostics: Record<string, number>;
  findings: {
    total: number;
    bySeverity: Record<Severity, number>;
    sitesWithSeverity: Record<Severity, number>;
  };
  checks: Record<string, CheckAggregate>;
  durations: DurationStats | null;
}

export interface VariantRow {
  checkId: string;
  variant: string;
  severity: string;
  findings: number;
  sites: number;
  sitesByRegion: Record<Region, number>;
}

export interface CmpStats {
  /** Finished sites with this expectedCmp. */
  expected: number;
  /** …of which the browser delivered CMP facts (detected ≠ n/a). */
  evaluated: number;
  matched: number;
  recall: number | null;
  /** Detected as this CMP where expectedCmp says something else (including unknown). */
  unexpected: number;
}

export interface ErrorRow {
  kind: 'runner' | 'scan-failure' | 'check-error' | 'collector';
  code: string;
  count: number;
}

export interface SiteRow {
  id: string;
  url: string;
  region: Region;
  country: string;
  sector: string;
  sizeClass: string;
  expectedCmp: ExpectedCmp;
  detectedCmp: DetectedCmpId;
  detectedCmpConfidence: Confidence | null;
  scanStatus: ScanStatusKey | 'pending';
  exitCode: number | null;
  durationMs: number | null;
  failureCode: string | null;
  runnerError: string | null;
  findings: Record<Severity, number>;
  diagnostics: string[];
}

export interface CanarySummary {
  summaryVersion: 1;
  runId: string;
  generatedAt: string;
  mode: 'scan' | 'reanalyze';
  reanalyzedFrom: string | null;
  withSites: boolean;
  groups: Record<GroupKey, GroupAggregate>;
  variants: VariantRow[];
  cmp: {
    matrix: Record<ExpectedCmp, Record<DetectedCmpId, number>>;
    perCmp: Record<KnownCmp, CmpStats>;
    /** Recognitions per CMP and confidence (finished sites). */
    recognition: Record<KnownCmp, Record<Confidence, number>>;
  };
  collectorDurations: Record<string, DurationStats>;
  topErrors: ErrorRow[];
  sites?: SiteRow[];
}

export interface AggregateOptions {
  runId: string;
  generatedAt: string;
  mode: 'scan' | 'reanalyze';
  reanalyzedFrom?: string | null;
  withSites: boolean;
  topErrors?: number;
}

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function sortedRecord(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Nearest-rank percentiles. */
export function durationStats(values: readonly number[]): DurationStats | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => v[Math.max(0, Math.ceil(p * v.length) - 1)] as number;
  return {
    count: v.length,
    minMs: v[0] as number,
    p50Ms: at(0.5),
    p90Ms: at(0.9),
    maxMs: v[v.length - 1] as number,
    meanMs: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
  };
}

/** Replace site ids, hosts and registrable domains in machine codes; keep codes short and printable. */
function makeScrubber(sites: readonly SiteRef[], enabled: boolean): (code: string) => string {
  const needles = new Set<string>();
  if (enabled) {
    for (const s of sites) {
      needles.add(s.id);
      try {
        const host = new URL(s.url).hostname;
        needles.add(host);
        needles.add(host.replace(/^www\./, ''));
      } catch {
        // invalid URL in an old meta.json: nothing to scrub
      }
    }
  }

  // Longest first, so "shop.example.de" is replaced before "example.de" can leave a fragment.
  const ordered = [...needles].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length);
  return (code: string) => {
    let out = code.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
    for (const n of ordered) out = out.split(n).join('<site>');
    return out;
  };
}

function scanStatusOf(r: SiteResult): ScanStatusKey | 'pending' {
  if (!r.meta) return 'pending';
  const s = r.report?.scan?.status;
  return s === 'complete' || s === 'partial' || s === 'failed' ? s : 'no-report';
}

/** Findings and checks are counted for complete and partial scans only. */
function evaluable(r: SiteResult): boolean {
  const s = scanStatusOf(r);
  return s === 'complete' || s === 'partial';
}

function siteDiagnostics(r: SiteResult): string[] {
  const codes = new Set((r.report?.diagnostics ?? []).map((d) => d.code));
  if (r.report?.scan?.status === 'failed') {
    const reasons = r.report.summary?.exitReasons ?? [];
    if (reasons.includes('unreachable')) codes.add('SCAN-UNREACHABLE');
    if (reasons.includes('blocked')) codes.add('SCAN-BLOCKED');
  }
  return [...codes].sort();
}

function emptyGroup(): GroupAggregate {
  return {
    sites: 0,
    finished: 0,
    pending: 0,
    runnerErrors: 0,
    scanStatus: zeros(SCAN_STATUSES),
    exitCodes: {},
    failureCodes: {},
    exitReasons: {},
    diagnostics: {},
    findings: { total: 0, bySeverity: zeros(SEVERITIES), sitesWithSeverity: zeros(SEVERITIES) },
    checks: {},
    durations: null,
  };
}

/** Counters of one finished site's scan outcome; returns the scan duration for the group statistics. */
function tallyScanOutcome(
  g: GroupAggregate,
  r: SiteResult,
  meta: SiteMeta,
  status: ScanStatusKey,
  scrub: (s: string) => string,
): number {
  g.scanStatus[status]++;
  if (meta.error) g.runnerErrors++;
  inc(g.exitCodes, meta.exitCode === null ? 'none' : String(meta.exitCode));

  if (status === 'failed') inc(g.failureCodes, scrub(r.report?.scan?.failure?.code ?? 'unknown'));
  for (const reason of r.report?.summary?.exitReasons ?? []) inc(g.exitReasons, scrub(reason));
  for (const code of siteDiagnostics(r)) inc(g.diagnostics, scrub(code));

  return meta.scanDurationMs ?? meta.durationMs;
}

function tallyFindings(g: GroupAggregate, r: SiteResult): void {
  const severities = new Set<string>();

  for (const f of r.report?.findings ?? []) {
    if (!(SEVERITIES as readonly string[]).includes(f.severity)) continue;
    g.findings.total++;
    g.findings.bySeverity[f.severity as Severity]++;
    severities.add(f.severity);
  }

  for (const s of severities) g.findings.sitesWithSeverity[s as Severity]++;
}

function emptyCheckAggregate(): CheckAggregate {
  return {
    results: 0,
    evaluated: 0,
    inconclusive: 0,
    inconclusiveShare: null,
    statuses: zeros(CHECK_STATUSES),
    reasons: {},
  };
}

function tallyChecks(g: GroupAggregate, r: SiteResult, scrub: (s: string) => string): void {
  for (const c of r.report?.checks ?? []) {
    g.checks[c.id] ??= emptyCheckAggregate();
    const agg = g.checks[c.id] as CheckAggregate;
    // A status this version does not know counts as an error rather than vanishing from the table.
    const st = (CHECK_STATUSES as readonly string[]).includes(c.status) ? (c.status as CheckStatus) : 'error';

    agg.results++;
    agg.statuses[st]++;
    if (st !== 'skipped') agg.evaluated++;
    if (st === 'inconclusive') agg.inconclusive++;
    if (st !== 'completed') inc(agg.reasons, `${st}:${scrub(c.reason ?? c.error?.code ?? 'none')}`);
  }
}

/** Derived shares and sorted keys, so two summaries of the same data are byte-identical. */
function finalizeGroup(g: GroupAggregate, durations: readonly number[]): void {
  for (const agg of Object.values(g.checks)) {
    agg.inconclusiveShare = agg.evaluated > 0 ? agg.inconclusive / agg.evaluated : null;
    agg.reasons = sortedRecord(agg.reasons);
  }

  g.checks = Object.fromEntries(Object.entries(g.checks).sort(([a], [b]) => a.localeCompare(b)));
  g.exitCodes = sortedRecord(g.exitCodes);
  g.failureCodes = sortedRecord(g.failureCodes);
  g.exitReasons = sortedRecord(g.exitReasons);
  g.diagnostics = sortedRecord(g.diagnostics);
  g.durations = durationStats(durations);
}

function aggregateGroup(results: readonly SiteResult[], scrub: (s: string) => string): GroupAggregate {
  const g = emptyGroup();
  const durations: number[] = [];

  for (const r of results) {
    g.sites++;
    const status = scanStatusOf(r);
    if (status === 'pending' || !r.meta) {
      g.pending++;
      continue;
    }

    g.finished++;
    durations.push(tallyScanOutcome(g, r, r.meta, status, scrub));
    if (!evaluable(r)) continue;

    tallyFindings(g, r);
    tallyChecks(g, r, scrub);
  }

  finalizeGroup(g, durations);
  return g;
}

type VariantTally = VariantRow & { siteIds: Set<string> };

function newVariantTally(f: { checkId: string; variant: string; severity: string }): VariantTally {
  return {
    checkId: f.checkId,
    variant: f.variant,
    severity: f.severity,
    findings: 0,
    sites: 0,
    sitesByRegion: { de: 0, eu: 0, 'non-eu': 0 },
    siteIds: new Set(),
  };
}

function variantRows(results: readonly SiteResult[]): VariantRow[] {
  const rows = new Map<string, VariantTally>();

  for (const r of results) {
    if (!evaluable(r)) continue;

    for (const f of r.report?.findings ?? []) {
      const key = `${f.checkId}\u0000${f.variant}\u0000${f.severity}`;
      let row = rows.get(key);
      if (!row) {
        row = newVariantTally(f);
        rows.set(key, row);
      }

      row.findings++;
      // Each site counts once per variant, however many findings it has.
      if (!row.siteIds.has(r.site.id)) {
        row.siteIds.add(r.site.id);
        row.sites++;
        row.sitesByRegion[r.site.region]++;
      }
    }
  }

  const sevRank = (s: string) => SEVERITIES.indexOf(s as Severity);
  return [...rows.values()]
    .map(({ siteIds: _ids, ...row }) => row)
    .sort(
      (a, b) =>
        a.checkId.localeCompare(b.checkId) ||
        a.variant.localeCompare(b.variant) ||
        sevRank(a.severity) - sevRank(b.severity),
    );
}

function cmpSection(results: readonly SiteResult[]): CanarySummary['cmp'] {
  const matrix = Object.fromEntries(EXPECTED_CMPS.map((e) => [e, zeros(DETECTED_CMPS)])) as Record<
    ExpectedCmp,
    Record<DetectedCmpId, number>
  >;
  const perCmp = Object.fromEntries(
    KNOWN_CMPS.map((c) => [c, { expected: 0, evaluated: 0, matched: 0, recall: null, unexpected: 0 }]),
  ) as Record<KnownCmp, CmpStats>;
  const recognition = Object.fromEntries(
    KNOWN_CMPS.map((c) => [c, { high: 0, medium: 0, low: 0 }]),
  ) as Record<KnownCmp, Record<Confidence, number>>;

  for (const r of results) {
    if (!r.meta) continue;
    const expected = r.site.expectedCmp;
    const detected = r.cmp.id;
    matrix[expected][detected]++;

    if ((KNOWN_CMPS as readonly string[]).includes(expected)) {
      const s = perCmp[expected as KnownCmp];
      s.expected++;
      if (detected !== 'n/a') s.evaluated++;
      if (detected === expected) s.matched++;
    }

    if ((KNOWN_CMPS as readonly string[]).includes(detected)) {
      if (detected !== expected) perCmp[detected as KnownCmp].unexpected++;
      if (r.cmp.confidence) recognition[detected as KnownCmp][r.cmp.confidence]++;
    }
  }

  for (const s of Object.values(perCmp)) s.recall = s.evaluated > 0 ? s.matched / s.evaluated : null;
  return { matrix, perCmp, recognition };
}

function collectorDurations(results: readonly SiteResult[]): Record<string, DurationStats> {
  const byCollector: Record<string, number[]> = {};
  for (const r of results) {
    if (!r.meta) continue;

    for (const [name, c] of Object.entries(r.report?.scan?.coverage?.collectors ?? {})) {
      if (typeof c?.durationMs !== 'number' || c.status === 'not-run') continue;
      byCollector[name] ??= [];
      byCollector[name].push(c.durationMs);
    }
  }

  const out: Record<string, DurationStats> = {};
  for (const name of Object.keys(byCollector).sort()) {
    const s = durationStats(byCollector[name] ?? []);
    if (s) out[name] = s;
  }
  return out;
}

function topErrors(results: readonly SiteResult[], scrub: (s: string) => string, limit: number): ErrorRow[] {
  const counts = new Map<string, ErrorRow>();
  const add = (kind: ErrorRow['kind'], raw: string) => {
    const code = scrub(raw);
    const key = `${kind}\u0000${code}`;
    const row = counts.get(key) ?? { kind, code, count: 0 };
    row.count++;
    counts.set(key, row);
  };

  for (const r of results) {
    if (!r.meta) continue;
    if (r.meta.error) add('runner', r.meta.error.code);
    if (r.report?.scan?.status === 'failed') add('scan-failure', r.report.scan.failure?.code ?? 'unknown');

    for (const c of r.report?.checks ?? []) {
      if (c.status === 'error') add('check-error', `${c.id}:${c.reason ?? c.error?.code ?? 'unknown'}`);
    }

    for (const [name, c] of Object.entries(r.report?.scan?.coverage?.collectors ?? {})) {
      if (c?.status === 'error' || c?.status === 'partial') {
        add('collector', `${name}:${c.status}:${c.reason ?? 'none'}`);
      }
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
    .slice(0, limit);
}

function severityCounts(r: SiteResult): Record<Severity, number> {
  const counts = zeros(SEVERITIES);
  if (!evaluable(r)) return counts;

  for (const f of r.report?.findings ?? []) {
    if ((SEVERITIES as readonly string[]).includes(f.severity)) counts[f.severity as Severity]++;
  }
  return counts;
}

function siteRows(results: readonly SiteResult[]): SiteRow[] {
  return results.map((r) => {
    const status = scanStatusOf(r);

    return {
      id: r.site.id,
      url: r.site.url,
      region: r.site.region,
      country: r.site.country,
      sector: r.site.sector,
      sizeClass: r.site.sizeClass,
      expectedCmp: r.site.expectedCmp,
      detectedCmp: r.cmp.id,
      detectedCmpConfidence: r.cmp.confidence,
      scanStatus: status,
      exitCode: r.meta?.exitCode ?? null,
      durationMs: r.meta ? (r.meta.scanDurationMs ?? r.meta.durationMs) : null,
      failureCode: status === 'failed' ? (r.report?.scan?.failure?.code ?? 'unknown') : null,
      runnerError: r.meta?.error?.code ?? null,
      findings: severityCounts(r),
      diagnostics: siteDiagnostics(r),
    };
  });
}

export function aggregate(results: readonly SiteResult[], o: AggregateOptions): CanarySummary {
  const scrub = makeScrubber(
    results.map((r) => r.site),
    !o.withSites,
  );

  const groups = Object.fromEntries(
    GROUPS.map((g) => [
      g,
      aggregateGroup(
        results.filter((r) => GROUP_MEMBERS[g].includes(r.site.region)),
        scrub,
      ),
    ]),
  ) as Record<GroupKey, GroupAggregate>;

  const summary: CanarySummary = {
    summaryVersion: 1,
    runId: o.runId,
    generatedAt: o.generatedAt,
    mode: o.mode,
    reanalyzedFrom: o.reanalyzedFrom ?? null,
    withSites: o.withSites,
    groups,
    variants: variantRows(results).map((v) => ({
      ...v,
      variant: scrub(v.variant),
      checkId: scrub(v.checkId),
    })),
    cmp: cmpSection(results),
    collectorDurations: collectorDurations(results),
    topErrors: topErrors(results, scrub, o.topErrors ?? 15),
  };

  if (o.withSites) summary.sites = siteRows(results);
  return summary;
}
