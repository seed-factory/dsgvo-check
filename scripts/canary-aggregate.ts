/**
 * Canary aggregation: run directory → summary.json + SUMMARY.md. Pure except `loadRun`.
 * Aggregates carry no site names by default (ids, hosts and free-text messages are left out; machine codes are
 * scrubbed of site hosts). `withSites` adds a per-site table for local analysis only.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CheckStatus, Severity } from '../src/core/report-schema.ts';
import { FILES, type RunInfo, readJsonFile, type SiteMeta, type SiteRef } from './canary-runner.ts';
import { EXPECTED_CMPS, type ExpectedCmp, KNOWN_CMPS, type KnownCmp, type Region } from './canary-sites.ts';

// ---------------------------------------------------------------- inputs

/** The parts of a report the summary reads. Reports are read defensively (older versions, partial files). */
export interface ReportLike {
  scan?: {
    status?: string;
    failure?: { code?: string };
    coverage?: { collectors?: Record<string, { status?: string; reason?: string; durationMs?: number }> };
  };
  checks?: Array<{ id: string; status: string; reason?: string | null; error?: { code?: string } }>;
  findings?: Array<{ checkId: string; variant: string; severity: string }>;
  diagnostics?: Array<{ code: string }>;
  evidence?: Array<{ type: string; cmpId?: string | null; recognitionConfidence?: string }>;
  summary?: { exitCode?: number; exitReasons?: string[] };
}

export type DetectedCmpId = KnownCmp | 'other' | 'none' | 'n/a';
export const DETECTED_CMPS: readonly DetectedCmpId[] = [...KNOWN_CMPS, 'other', 'none', 'n/a'];
type Confidence = 'high' | 'medium' | 'low';

export interface DetectedCmp {
  id: DetectedCmpId;
  confidence: Confidence | null;
  source: 'snapshot' | 'report' | 'none';
}

export interface SiteResult {
  site: SiteRef;
  /** null: planned but not finished yet. */
  meta: SiteMeta | null;
  report: ReportLike | null;
  cmp: DetectedCmp;
}

const NOT_AVAILABLE: DetectedCmp = { id: 'n/a', confidence: null, source: 'none' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toDetectedId(cmpId: unknown, method: unknown): DetectedCmpId {
  if (method === 'none' || cmpId === null || cmpId === undefined || cmpId === '') return 'none';
  if (method === 'adapter' && (KNOWN_CMPS as readonly unknown[]).includes(cmpId)) return cmpId as KnownCmp;
  return 'other';
}

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const METHOD_RANK: Record<string, number> = { adapter: 2, heuristic: 1, none: 0 };

/**
 * Detected CMP of a saved snapshot: the best detection over all CMP facts (adapter > heuristic, then confidence,
 * then phase B first screen). `n/a` when the browser did not deliver CMP facts; null without a snapshot.
 */
export function detectedCmpFromSnapshot(snapshot: unknown): DetectedCmp | null {
  if (!isRecord(snapshot)) return null;
  const browser = isRecord(snapshot.collection) ? snapshot.collection.browser : undefined;
  const status = isRecord(browser) ? browser.status : undefined;
  if ((status !== 'ok' && status !== 'partial') || !isRecord(snapshot.cmp)) return NOT_AVAILABLE;
  const phases = Array.isArray(snapshot.cmp.phases) ? snapshot.cmp.phases : [];
  let best: { rank: number; id: DetectedCmpId; confidence: Confidence } | null = null;
  for (const p of phases) {
    if (!isRecord(p) || !Array.isArray(p.facts)) continue;
    for (const f of p.facts) {
      if (!isRecord(f) || !isRecord(f.detection)) continue;
      const d = f.detection;
      const method = typeof d.method === 'string' ? d.method : 'none';
      const id = toDetectedId(d.cmpId, method);
      if (id === 'none') continue;
      const confidence = (
        CONF_RANK[String(d.recognitionConfidence)] ? d.recognitionConfidence : 'low'
      ) as Confidence;
      const firstScreen = f.phase === 'B' && f.moment === 'first-screen' ? 1 : 0;
      const rank = (METHOD_RANK[method] ?? 0) * 100 + (CONF_RANK[confidence] ?? 0) * 10 + firstScreen;
      if (!best || rank > best.rank) best = { rank, id, confidence };
    }
  }
  return best
    ? { id: best.id, confidence: best.confidence, source: 'snapshot' }
    : { id: 'none', confidence: null, source: 'snapshot' };
}

/** Fallback without a snapshot: the strongest `cmp` evidence of the report. */
export function detectedCmpFromReport(report: ReportLike | null): DetectedCmp | null {
  let best: DetectedCmp | null = null;
  for (const e of report?.evidence ?? []) {
    if (e.type !== 'cmp' || !e.cmpId) continue;
    const id: DetectedCmpId = (KNOWN_CMPS as readonly string[]).includes(e.cmpId)
      ? (e.cmpId as KnownCmp)
      : 'other';
    const confidence = (
      CONF_RANK[String(e.recognitionConfidence)] ? e.recognitionConfidence : 'low'
    ) as Confidence;
    if (!best || (CONF_RANK[confidence] ?? 0) > (CONF_RANK[best.confidence ?? ''] ?? 0)) {
      best = { id, confidence, source: 'report' };
    }
  }
  return best;
}

/** Read a run directory. Sites come from run.json (plan order) plus any site directory with a meta.json. */
export async function loadRun(runDir: string): Promise<{ run: RunInfo | null; results: SiteResult[] }> {
  const run = await readJsonFile<RunInfo>(path.join(runDir, FILES.run));
  let dirs: string[] = [];
  try {
    dirs = (await readdir(runDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    throw new Error(`run directory not found: ${runDir}`);
  }
  const planned = new Map<string, SiteRef>((run?.sites ?? []).map((s) => [s.id, s]));
  const order = [...planned.keys(), ...dirs.filter((d) => !planned.has(d))];
  const results: SiteResult[] = [];
  for (const id of order) {
    const dir = path.join(runDir, id);
    const meta = await readJsonFile<SiteMeta>(path.join(dir, FILES.meta));
    const site = meta?.site ?? planned.get(id);
    if (!site) continue;
    const report = await readJsonFile<ReportLike>(path.join(dir, FILES.report));
    const validReport = isRecord(report) && isRecord(report.scan) ? report : null;
    const snapshot = await readJsonFile<unknown>(path.join(dir, FILES.snapshot));
    const cmp = detectedCmpFromSnapshot(snapshot) ?? detectedCmpFromReport(validReport) ?? NOT_AVAILABLE;
    results.push({ site, meta, report: validReport, cmp });
  }
  return { run, results };
}

// ---------------------------------------------------------------- summary model

export const GROUPS = ['all', 'eu-eea', 'de', 'eu', 'non-eu'] as const;
export type GroupKey = (typeof GROUPS)[number];
const GROUP_LABEL: Record<GroupKey, string> = {
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

const CHECK_STATUSES: readonly CheckStatus[] = [
  'completed',
  'partial',
  'inconclusive',
  'not_applicable',
  'error',
  'skipped',
];
const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];
const SCAN_STATUSES = ['complete', 'partial', 'failed', 'no-report'] as const;
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

// ---------------------------------------------------------------- helpers

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
    g.scanStatus[status]++;
    if (r.meta.error) g.runnerErrors++;
    inc(g.exitCodes, r.meta.exitCode === null ? 'none' : String(r.meta.exitCode));
    durations.push(r.meta.scanDurationMs ?? r.meta.durationMs);
    if (status === 'failed') inc(g.failureCodes, scrub(r.report?.scan?.failure?.code ?? 'unknown'));
    for (const reason of r.report?.summary?.exitReasons ?? []) inc(g.exitReasons, scrub(reason));
    for (const code of siteDiagnostics(r)) inc(g.diagnostics, scrub(code));
    if (!evaluable(r)) continue;

    const severities = new Set<string>();
    for (const f of r.report?.findings ?? []) {
      if (!(SEVERITIES as readonly string[]).includes(f.severity)) continue;
      g.findings.total++;
      g.findings.bySeverity[f.severity as Severity]++;
      severities.add(f.severity);
    }
    for (const s of severities) g.findings.sitesWithSeverity[s as Severity]++;

    for (const c of r.report?.checks ?? []) {
      g.checks[c.id] ??= {
        results: 0,
        evaluated: 0,
        inconclusive: 0,
        inconclusiveShare: null,
        statuses: zeros(CHECK_STATUSES),
        reasons: {},
      };
      const agg = g.checks[c.id] as CheckAggregate;
      const st = (CHECK_STATUSES as readonly string[]).includes(c.status)
        ? (c.status as CheckStatus)
        : 'error';
      agg.results++;
      agg.statuses[st]++;
      if (st !== 'skipped') agg.evaluated++;
      if (st === 'inconclusive') agg.inconclusive++;
      if (st !== 'completed') inc(agg.reasons, `${st}:${scrub(c.reason ?? c.error?.code ?? 'none')}`);
    }
  }
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
  return g;
}

function variantRows(results: readonly SiteResult[]): VariantRow[] {
  const rows = new Map<string, VariantRow & { siteIds: Set<string> }>();
  for (const r of results) {
    if (!evaluable(r)) continue;
    for (const f of r.report?.findings ?? []) {
      const key = `${f.checkId}\u0000${f.variant}\u0000${f.severity}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          checkId: f.checkId,
          variant: f.variant,
          severity: f.severity,
          findings: 0,
          sites: 0,
          sitesByRegion: { de: 0, eu: 0, 'non-eu': 0 },
          siteIds: new Set(),
        };
        rows.set(key, row);
      }
      row.findings++;
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
  const by: Record<string, number[]> = {};
  for (const r of results) {
    if (!r.meta) continue;
    for (const [name, c] of Object.entries(r.report?.scan?.coverage?.collectors ?? {})) {
      if (typeof c?.durationMs !== 'number' || c.status === 'not-run') continue;
      by[name] ??= [];
      by[name].push(c.durationMs);
    }
  }
  const out: Record<string, DurationStats> = {};
  for (const name of Object.keys(by).sort()) {
    const s = durationStats(by[name] ?? []);
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

function siteRows(results: readonly SiteResult[]): SiteRow[] {
  return results.map((r) => {
    const findings = zeros(SEVERITIES);
    if (evaluable(r)) {
      for (const f of r.report?.findings ?? []) {
        if ((SEVERITIES as readonly string[]).includes(f.severity)) findings[f.severity as Severity]++;
      }
    }
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
      findings,
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

// ---------------------------------------------------------------- Markdown

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|');
}

function table(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const line = (cells: ReadonlyArray<string | number | null>) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(head), `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(line)].join('\n');
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(1)} %`);
const sec = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`;

function keyedTable(
  title: string,
  pick: (g: GroupAggregate) => Record<string, number>,
  s: CanarySummary,
): string {
  const keys = [...new Set(GROUPS.flatMap((g) => Object.keys(pick(s.groups[g]))))].sort();
  if (keys.length === 0) return `${title}\n\n_none_`;
  return `${title}\n\n${table(
    ['code', ...GROUPS.map((g) => GROUP_LABEL[g])],
    keys.map((k) => [k, ...GROUPS.map((g) => pick(s.groups[g])[k] ?? 0)]),
  )}`;
}

export function renderMarkdown(s: CanarySummary): string {
  const all = s.groups.all;
  const out: string[] = [];
  const modeLine =
    s.mode === 'reanalyze'
      ? `reanalysis of \`${s.reanalyzedFrom ?? '?'}\` (saved snapshots, no network)`
      : 'live scan';
  out.push(`# Canary run ${s.runId}`);
  out.push(
    [
      `Generated ${s.generatedAt}; ${modeLine}.`,
      `Sites: ${all.sites} planned, ${all.finished} finished, ${all.pending} pending.`,
      s.withSites
        ? '**Contains site names (`--with-sites`): local analysis only, do not share or publish.**'
        : 'Aggregates only, no site names. Findings and check statistics cover complete and partial scans.',
    ].join('\n'),
  );

  out.push('## Scan status');
  out.push(
    table(
      ['', ...GROUPS.map((g) => GROUP_LABEL[g])],
      [
        ['sites', ...GROUPS.map((g) => s.groups[g].sites)],
        ...SCAN_STATUSES.map((st) => [st, ...GROUPS.map((g) => s.groups[g].scanStatus[st])]),
        ['pending', ...GROUPS.map((g) => s.groups[g].pending)],
        ['runner errors', ...GROUPS.map((g) => s.groups[g].runnerErrors)],
      ],
    ),
  );
  out.push(keyedTable('### Failure codes (failed scans)', (g) => g.failureCodes, s));
  out.push(keyedTable('### Exit reasons', (g) => g.exitReasons, s));
  out.push(keyedTable('### Exit codes', (g) => g.exitCodes, s));

  out.push(keyedTable('## Diagnostics (sites per code)', (g) => g.diagnostics, s));

  out.push('## Findings');
  out.push(
    table(
      ['severity', ...GROUPS.map((g) => `${GROUP_LABEL[g]} findings / sites`)],
      SEVERITIES.map((sev) => [
        sev,
        ...GROUPS.map(
          (g) => `${s.groups[g].findings.bySeverity[sev]} / ${s.groups[g].findings.sitesWithSeverity[sev]}`,
        ),
      ]),
    ),
  );
  out.push('### By check, variant and severity');
  out.push(
    s.variants.length === 0
      ? '_none_'
      : table(
          ['check', 'variant', 'severity', 'findings', 'sites', 'DE sites', 'EU sites', 'non-EU sites'],
          s.variants.map((v) => [
            v.checkId,
            v.variant,
            v.severity,
            v.findings,
            v.sites,
            v.sitesByRegion.de,
            v.sitesByRegion.eu,
            v.sitesByRegion['non-eu'],
          ]),
        ),
  );

  out.push('## Checks: status and inconclusive share');
  out.push('Share = inconclusive / (results − skipped).');
  const checkIds = Object.keys(all.checks);
  if (checkIds.length === 0) out.push('_no check results_');
  else {
    out.push(
      table(
        ['check', ...CHECK_STATUSES, 'inconclusive share', 'EU/EEA', 'non-EU'],
        checkIds.map((id) => {
          const c = all.checks[id] as CheckAggregate;
          return [
            id,
            ...CHECK_STATUSES.map((st) => c.statuses[st]),
            pct(c.inconclusiveShare),
            pct(s.groups['eu-eea'].checks[id]?.inconclusiveShare ?? null),
            pct(s.groups['non-eu'].checks[id]?.inconclusiveShare ?? null),
          ];
        }),
      ),
    );
    const reasonRows = checkIds.flatMap((id) =>
      Object.entries((all.checks[id] as CheckAggregate).reasons).map(([k, n]) => [id, k, n] as const),
    );
    out.push('### Reasons (non-completed results)');
    out.push(reasonRows.length === 0 ? '_none_' : table(['check', 'status:reason', 'count'], reasonRows));
  }

  out.push('## CMP: expected vs detected');
  out.push(
    'Rows: `expectedCmp` from sites.yaml. Columns: CMP detected by the scanner (`n/a` = no CMP facts).',
  );
  out.push(
    table(
      ['expected \\ detected', ...DETECTED_CMPS],
      EXPECTED_CMPS.map((e) => [e, ...DETECTED_CMPS.map((d) => s.cmp.matrix[e][d])]),
    ),
  );
  out.push(
    table(
      ['CMP', 'expected', 'evaluated', 'matched', 'recall', 'detected elsewhere', 'high', 'medium', 'low'],
      KNOWN_CMPS.map((c) => {
        const p = s.cmp.perCmp[c];
        const r = s.cmp.recognition[c];
        return [c, p.expected, p.evaluated, p.matched, pct(p.recall), p.unexpected, r.high, r.medium, r.low];
      }),
    ),
  );

  out.push('## Durations');
  const durRow = (label: string, d: DurationStats | null) => [
    label,
    d?.count ?? 0,
    sec(d?.minMs),
    sec(d?.p50Ms),
    sec(d?.p90Ms),
    sec(d?.maxMs),
    sec(d?.meanMs),
  ];
  out.push(
    table(
      ['', 'count', 'min', 'median', 'p90', 'max', 'mean'],
      [
        ...GROUPS.map((g) => durRow(`scan, ${GROUP_LABEL[g]}`, s.groups[g].durations)),
        ...Object.entries(s.collectorDurations).map(([name, d]) => durRow(`collector ${name}`, d)),
      ],
    ),
  );
  if (s.mode === 'reanalyze') out.push('Scan durations are those of the source run.');

  out.push('## Top errors');
  out.push(
    s.topErrors.length === 0
      ? '_none_'
      : table(
          ['kind', 'code', 'count'],
          s.topErrors.map((e) => [e.kind, e.code, e.count]),
        ),
  );

  if (s.sites) {
    out.push('## Sites');
    out.push(
      table(
        [
          'id',
          'region',
          'status',
          'exit',
          'duration',
          'crit/warn/info',
          'CMP expected',
          'CMP detected',
          'diagnostics',
          'failure / runner error',
        ],
        s.sites.map((x) => [
          x.id,
          x.region,
          x.scanStatus,
          x.exitCode,
          sec(x.durationMs),
          `${x.findings.critical}/${x.findings.warning}/${x.findings.info}`,
          x.expectedCmp,
          x.detectedCmpConfidence ? `${x.detectedCmp} (${x.detectedCmpConfidence})` : x.detectedCmp,
          x.diagnostics.join(', ') || '–',
          x.failureCode ?? x.runnerError ?? '–',
        ]),
      ),
    );
  }
  return `${out.join('\n\n')}\n`;
}
