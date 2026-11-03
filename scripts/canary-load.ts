/**
 * Reading a canary run directory into site results, with the CMP detected from the saved snapshot (or, without
 * one, from the report).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FILES, type RunInfo, readJsonFile, type SiteMeta, type SiteRef } from './canary-results.ts';
import { KNOWN_CMPS, type KnownCmp } from './canary-sites.ts';

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
export type Confidence = 'high' | 'medium' | 'low';

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
