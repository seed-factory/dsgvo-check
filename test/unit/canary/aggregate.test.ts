import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate, type CanarySummary } from '../../../scripts/canary/aggregate.ts';
import {
  detectedCmpFromReport,
  detectedCmpFromSnapshot,
  loadRun,
  type SiteResult,
} from '../../../scripts/canary/load.ts';
import { renderMarkdown } from '../../../scripts/canary/markdown.ts';
import type { SiteMeta, SiteRef } from '../../../scripts/canary/results.ts';
import type { CmpFacts, CmpPhaseFacts } from '../../../src/cmp/types.ts';
import type { CheckResult, Finding, FullReport } from '../../../src/core/report/schema.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';
import { makeCmp, makeCmpFacts } from '../../utils/snapshot-builder.ts';

function ref(id: string, over: Partial<SiteRef> = {}): SiteRef {
  const country = id.slice(0, 2).toUpperCase();
  return {
    id,
    url: `https://www.${id}.example/`,
    region: country === 'DE' ? 'de' : ['AT', 'FR'].includes(country) ? 'eu' : 'non-eu',
    country,
    sector: 'media',
    sizeClass: 'medium',
    expectedCmp: 'unknown',
    ...over,
  };
}

function meta(site: SiteRef, over: Partial<SiteMeta> = {}): SiteMeta {
  return {
    metaVersion: 1,
    runId: 'r1',
    mode: 'scan',
    site,
    engine: 'api',
    toolVersion: '0.1.0',
    startedAt: '2026-10-30T12:00:00.000Z',
    finishedAt: '2026-10-30T12:01:00.000Z',
    durationMs: 60_000,
    scanDurationMs: 60_000,
    exitCode: 0,
    scanStatus: 'complete',
    files: { report: true, snapshot: true },
    error: null,
    ...over,
  };
}

const check = (id: string, status: CheckResult['status'], reason: string | null = null): CheckResult => ({
  id,
  status,
  reason,
  limitations: [],
  coverage: null,
  durationMs: 1,
});

const finding = (checkId: string, variant: string, severity: Finding['severity']): Finding => ({
  ...(sampleFullReport().findings[0] as Finding),
  checkId,
  variant,
  variantGroup: variant,
  severity,
  messageId: `${checkId}.${variant}`,
});

function full(over: {
  status?: 'complete' | 'partial';
  checks?: CheckResult[];
  findings?: Finding[];
  diagnostics?: string[];
  collectors?: FullReport['scan']['coverage']['collectors'];
}): FullReport {
  const r = sampleFullReport();
  r.scan.status = over.status ?? 'complete';
  r.checks = over.checks ?? [];
  r.findings = over.findings ?? [];
  r.diagnostics = (over.diagnostics ?? []).map((code) => ({ code, affects: [], evidenceIds: [] }));
  r.scan.coverage.collectors = over.collectors ?? {};
  // Canary scans run with --fail-on none.
  r.summary.exitCode = 0;
  r.summary.exitReasons = [];
  return r;
}

function failed(code: string, exitReasons: string[], diagnostics: string[] = []) {
  const r = sampleFailedReport();
  r.scan.failure = { code, message: `Zielhost www.secret-host.example: ${code}` };
  r.summary.exitReasons = exitReasons;
  if (diagnostics.length > 0)
    r.diagnostics = diagnostics.map((c) => ({ code: c, affects: [], evidenceIds: [] }));
  return r;
}

/** 7 finished sites + 1 pending: DE ×3, AT ×1, FR ×1, US ×2, GB ×1 (pending). */
function results(): SiteResult[] {
  const deA = ref('de-alpha', { expectedCmp: 'cookiebot' });
  const deB = ref('de-beta', { expectedCmp: 'borlabs' });
  const deC = ref('de-gamma', { expectedCmp: 'usercentrics' });
  const atA = ref('at-delta', { expectedCmp: 'unknown' });
  const frA = ref('fr-epsilon', { expectedCmp: 'other' });
  const usA = ref('us-zeta', { expectedCmp: 'none' });
  const usB = ref('us-eta', { expectedCmp: 'cookiebot' });
  const gbA = ref('gb-theta');
  return [
    {
      site: deA,
      meta: meta(deA, { durationMs: 50_000, scanDurationMs: 50_000 }),
      report: full({
        checks: [
          check('CONSENT-01', 'completed'),
          check('CONSENT-04', 'inconclusive', 'banner-not-recognized'),
          check('MAIL-01', 'completed'),
        ],
        findings: [
          finding('CONSENT-01', 'tracker-hit', 'critical'),
          finding('CONSENT-01', 'tracker-hit', 'critical'),
          finding('MAIL-01', 'missing', 'warning'),
        ],
        diagnostics: ['SCAN-BOTMODE'],
        collectors: { browser: { status: 'ok', durationMs: 40_000 }, dns: { status: 'ok', durationMs: 200 } },
      }),
      cmp: { id: 'cookiebot', confidence: 'high', source: 'snapshot' },
    },
    {
      site: deB,
      meta: meta(deB, { durationMs: 70_000, scanDurationMs: 70_000, scanStatus: 'partial' }),
      report: full({
        status: 'partial',
        checks: [
          check('CONSENT-01', 'error', 'collector-error:browser'),
          check('CONSENT-04', 'skipped', 'tls-blocked'),
          check('MAIL-01', 'completed'),
        ],
        findings: [finding('MAIL-01', 'missing', 'warning')],
        collectors: {
          browser: { status: 'error', reason: 'navigation-timeout', durationMs: 90_000 },
          dns: { status: 'ok', durationMs: 300 },
        },
      }),
      cmp: { id: 'none', confidence: null, source: 'snapshot' },
    },
    {
      site: deC,
      meta: meta(deC, { exitCode: 2, scanStatus: 'failed', durationMs: 20_000, scanDurationMs: 20_000 }),
      report: failed('blocked-403', ['blocked']),
      cmp: { id: 'n/a', confidence: null, source: 'none' },
    },
    {
      site: atA,
      meta: meta(atA, { durationMs: 30_000, scanDurationMs: 30_000 }),
      report: full({
        checks: [check('CONSENT-01', 'completed'), check('CONSENT-04', 'inconclusive', 'geo')],
        findings: [finding('CONSENT-04', 'banner-not-recognized', 'info')],
        diagnostics: ['SCAN-GEO'],
      }),
      cmp: { id: 'usercentrics', confidence: 'high', source: 'snapshot' },
    },
    {
      site: frA,
      meta: meta(frA, { exitCode: 2, scanStatus: 'failed', durationMs: 5_000, scanDurationMs: 5_000 }),
      report: failed('target-nxdomain', ['unreachable']),
      cmp: { id: 'n/a', confidence: null, source: 'none' },
    },
    {
      site: usA,
      meta: meta(usA, { durationMs: 40_000, scanDurationMs: 40_000 }),
      report: full({
        checks: [check('CONSENT-01', 'completed'), check('CONSENT-04', 'completed')],
        findings: [finding('CONSENT-01', 'tracker-hit', 'critical')],
      }),
      cmp: { id: 'other', confidence: 'low', source: 'snapshot' },
    },
    {
      site: usB,
      meta: meta(usB, {
        exitCode: null,
        scanStatus: null,
        durationMs: 300_000,
        scanDurationMs: 300_000,
        error: { code: 'watchdog-timeout', message: 'no result for https://www.us-eta.example/' },
        files: { report: false, snapshot: false },
      }),
      report: null,
      cmp: { id: 'n/a', confidence: null, source: 'none' },
    },
    { site: gbA, meta: null, report: null, cmp: { id: 'n/a', confidence: null, source: 'none' } },
  ];
}

const summarize = (withSites = false): CanarySummary =>
  aggregate(results(), { runId: 'r1', generatedAt: '2026-10-30T13:00:00.000Z', mode: 'scan', withSites });

describe('aggregate', () => {
  it('counts scan status, pending sites and runner errors per region group', () => {
    const s = summarize();
    expect(s.groups.all).toMatchObject({
      sites: 8,
      finished: 7,
      pending: 1,
      runnerErrors: 1,
      scanStatus: { complete: 3, partial: 1, failed: 2, 'no-report': 1 },
    });

    expect(s.groups.de.scanStatus).toEqual({ complete: 1, partial: 1, failed: 1, 'no-report': 0 });
    expect(s.groups.eu.scanStatus).toEqual({ complete: 1, partial: 0, failed: 1, 'no-report': 0 });
    expect(s.groups['eu-eea'].sites).toBe(5);
    expect(s.groups['non-eu']).toMatchObject({ sites: 3, pending: 1, runnerErrors: 1 });

    expect(s.groups.all.failureCodes).toEqual({ 'blocked-403': 1, 'target-nxdomain': 1 });
    expect(s.groups.all.exitReasons).toEqual({ blocked: 1, unreachable: 1 });
  });

  it('counts diagnostics per site and derives UNREACHABLE/BLOCKED from failed scans', () => {
    const s = summarize();
    expect(s.groups.all.diagnostics).toEqual({
      'SCAN-BLOCKED': 1,
      'SCAN-BOTMODE': 1,
      'SCAN-GEO': 1,
      'SCAN-UNREACHABLE': 1,
    });
    expect(s.groups['non-eu'].diagnostics).toEqual({});
  });

  it('groups findings by check, variant and severity (complete and partial scans only)', () => {
    const s = summarize();
    expect(s.groups.all.findings).toMatchObject({
      total: 6,
      bySeverity: { critical: 3, warning: 2, info: 1 },
      sitesWithSeverity: { critical: 2, warning: 2, info: 1 },
    });

    expect(s.variants).toEqual([
      {
        checkId: 'CONSENT-01',
        variant: 'tracker-hit',
        severity: 'critical',
        findings: 3,
        sites: 2,
        sitesByRegion: { de: 1, eu: 0, 'non-eu': 1 },
      },
      {
        checkId: 'CONSENT-04',
        variant: 'banner-not-recognized',
        severity: 'info',
        findings: 1,
        sites: 1,
        sitesByRegion: { de: 0, eu: 1, 'non-eu': 0 },
      },
      {
        checkId: 'MAIL-01',
        variant: 'missing',
        severity: 'warning',
        findings: 2,
        sites: 2,
        sitesByRegion: { de: 2, eu: 0, 'non-eu': 0 },
      },
    ]);
  });

  it('computes the inconclusive share per check over non-skipped results', () => {
    const s = summarize();
    const c4 = s.groups.all.checks['CONSENT-04'];
    expect(c4).toMatchObject({
      results: 4,
      evaluated: 3,
      inconclusive: 2,
      statuses: { completed: 1, inconclusive: 2, skipped: 1 },
      reasons: { 'inconclusive:banner-not-recognized': 1, 'inconclusive:geo': 1, 'skipped:tls-blocked': 1 },
    });
    expect(c4?.inconclusiveShare).toBeCloseTo(2 / 3);
    expect(s.groups['non-eu'].checks['CONSENT-04']?.inconclusiveShare).toBe(0);

    expect(s.groups.all.checks['CONSENT-01']).toMatchObject({
      evaluated: 4,
      inconclusive: 0,
      inconclusiveShare: 0,
    });
    expect(s.groups.all.checks['MAIL-01']?.inconclusiveShare).toBe(0);
  });

  it('builds the CMP matrix of expected vs detected', () => {
    const s = summarize();
    expect(s.cmp.matrix.cookiebot).toMatchObject({ cookiebot: 1, 'n/a': 1 });
    expect(s.cmp.matrix.borlabs).toMatchObject({ none: 1 });
    expect(s.cmp.matrix.unknown).toMatchObject({ usercentrics: 1 });
    expect(s.cmp.matrix.none).toMatchObject({ other: 1 });

    expect(s.cmp.perCmp.cookiebot).toEqual({
      expected: 2,
      evaluated: 1,
      matched: 1,
      recall: 1,
      unexpected: 0,
    });
    expect(s.cmp.perCmp.borlabs).toEqual({ expected: 1, evaluated: 1, matched: 0, recall: 0, unexpected: 0 });
    expect(s.cmp.perCmp.usercentrics).toEqual({
      expected: 1,
      evaluated: 0,
      matched: 0,
      recall: null,
      unexpected: 1,
    });
    expect(s.cmp.perCmp.ccm19.recall).toBeNull();
  });

  it('reports durations with nearest-rank percentiles', () => {
    const s = summarize();
    // finished sites: 50, 70, 20, 30, 5, 40, 300 s
    expect(s.groups.all.durations).toEqual({
      count: 7,
      minMs: 5_000,
      p50Ms: 40_000,
      p90Ms: 300_000,
      maxMs: 300_000,
      meanMs: Math.round(515_000 / 7),
    });
    expect(s.collectorDurations.browser).toMatchObject({ count: 2, minMs: 40_000, maxMs: 90_000 });
    expect(s.groups.all.pending).toBe(1);
  });

  it('ranks the top errors by count with codes only', () => {
    const s = summarize();
    expect(s.topErrors).toEqual([
      { kind: 'check-error', code: 'CONSENT-01:collector-error:browser', count: 1 },
      { kind: 'collector', code: 'browser:error:navigation-timeout', count: 1 },
      { kind: 'runner', code: 'watchdog-timeout', count: 1 },
      { kind: 'scan-failure', code: 'blocked-403', count: 1 },
      { kind: 'scan-failure', code: 'target-nxdomain', count: 1 },
    ]);
  });

  it('contains no site names by default, and lists sites only with withSites', () => {
    const plain = summarize(false);
    const md = renderMarkdown(plain);
    const json = JSON.stringify(plain);
    for (const r of results()) {
      for (const needle of [r.site.id, new URL(r.site.url).hostname]) {
        expect(json).not.toContain(needle);
        expect(md).not.toContain(needle);
      }
    }
    expect(json).not.toContain('secret-host');
    expect(plain.sites).toBeUndefined();

    const named = summarize(true);
    expect(named.sites?.map((x) => x.id)).toEqual(results().map((r) => r.site.id));
    expect(named.sites?.[0]).toMatchObject({
      id: 'de-alpha',
      scanStatus: 'complete',
      detectedCmp: 'cookiebot',
      expectedCmp: 'cookiebot',
      findings: { critical: 2, warning: 1, info: 0 },
      diagnostics: ['SCAN-BOTMODE'],
    });
    expect(renderMarkdown(named)).toContain('de-alpha');
  });

  it('scrubs site hosts that leak into machine codes', () => {
    const list = results();
    const first = list[1] as SiteResult;
    (first.report as FullReport).scan.coverage.collectors.browser = {
      status: 'error',
      reason: 'blocked-by:www.de-beta.example',
      durationMs: 1,
    };

    const s = aggregate(list, { runId: 'r1', generatedAt: 'x', mode: 'scan', withSites: false });

    expect(JSON.stringify(s)).not.toContain('de-beta');
    expect(s.topErrors.map((e) => e.code)).toContain('browser:error:blocked-by:<site>');
  });

  it('renders a deterministic Markdown summary with the main sections', () => {
    const md = renderMarkdown(summarize());

    expect(md).toBe(renderMarkdown(summarize()));
    for (const heading of [
      '# Canary run r1',
      '## Scan status',
      '## Diagnostics',
      '## Findings',
      '## Checks: status and inconclusive share',
      '## CMP: expected vs detected',
      '## Durations',
      '## Top errors',
    ]) {
      expect(md).toContain(heading);
    }

    expect(md).toMatch(/\| CONSENT-04 \|.*66\.7 %/);
    expect(md).not.toContain('## Sites');
  });
});

/**
 * A phase whose one fact is a first-screen fact with this detection; the fields not given keep the values of no
 * detection (no version, low confidence, no signals).
 */
function detected(phase: CmpPhaseFacts['phase'], detection: Partial<CmpFacts['detection']>): CmpPhaseFacts {
  const facts = makeCmpFacts({ phase, moment: 'first-screen' });
  return { phase, facts: [{ ...facts, detection: { ...facts.detection, ...detection } }] };
}

describe('CMP detection', () => {
  it('prefers the phase B first-screen detection of an adapter', () => {
    const cmp = makeCmp({
      phases: [
        detected('A', { cmpId: 'cookiehub', method: 'heuristic' }),
        detected('B', {
          cmpId: 'borlabs',
          method: 'adapter',
          version: '3.1',
          versionSupported: true,
          recognitionConfidence: 'high',
          signals: ['global:BorlabsCookie', 'dom:#BorlabsCookieBox'],
        }),
      ],
    });

    expect(detectedCmpFromSnapshot({ collection: { browser: { status: 'ok' } }, cmp })).toEqual({
      id: 'borlabs',
      confidence: 'high',
      source: 'snapshot',
    });
  });

  it('maps heuristic names to other, missing facts to none and a skipped browser to n/a', () => {
    const heuristic = makeCmp({
      phases: [
        detected('B', { cmpId: 'onetrust', method: 'heuristic', signals: ['script:cdn.cookielaw.org'] }),
      ],
    });

    expect(detectedCmpFromSnapshot({ collection: { browser: { status: 'ok' } }, cmp: heuristic })?.id).toBe(
      'other',
    );
    expect(
      detectedCmpFromSnapshot({ collection: { browser: { status: 'ok' } }, cmp: { phases: [] } })?.id,
    ).toBe('none');
    expect(
      detectedCmpFromSnapshot({ collection: { browser: { status: 'skipped', reason: 'tls-blocked' } } })?.id,
    ).toBe('n/a');
    expect(detectedCmpFromSnapshot(null)).toBeNull();
  });

  it('falls back to cmp evidence in the report', () => {
    const r = sampleFullReport();
    r.evidence = [{ id: 'ev-1', type: 'cmp', cmpId: 'complianz', recognitionConfidence: 'medium' }];

    expect(detectedCmpFromReport(r)).toEqual({ id: 'complianz', confidence: 'medium', source: 'report' });
    expect(detectedCmpFromReport(sampleFailedReport())).toBeNull();
  });
});

describe('loadRun', () => {
  it('reads run.json, meta, report and snapshot; tolerates pending and corrupt files', async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), 'canary-sum-'));
    const a = ref('de-alpha', { expectedCmp: 'cookiebot' });
    const b = ref('de-beta');
    const c = ref('us-gamma');
    writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({ runVersion: 1, runId: 'r1', mode: 'scan', sites: [a, b, c] }),
    );

    // alpha is complete, beta has a corrupt report, gamma is pending (no directory)
    mkdirSync(path.join(runDir, 'de-alpha'));
    writeFileSync(path.join(runDir, 'de-alpha', 'meta.json'), JSON.stringify(meta(a)));
    writeFileSync(path.join(runDir, 'de-alpha', 'report.json'), JSON.stringify(full({})));
    writeFileSync(
      path.join(runDir, 'de-alpha', 'snapshot.json'),
      JSON.stringify({
        collection: { browser: { status: 'ok' } },
        cmp: makeCmp({
          phases: [
            detected('B', {
              cmpId: 'cookiebot',
              method: 'adapter',
              versionSupported: true,
              recognitionConfidence: 'high',
            }),
          ],
        }),
      }),
    );

    mkdirSync(path.join(runDir, 'de-beta'));
    writeFileSync(path.join(runDir, 'de-beta', 'meta.json'), JSON.stringify(meta(b)));
    writeFileSync(path.join(runDir, 'de-beta', 'report.json'), '{ not json');

    const { run, results: loaded } = await loadRun(runDir);
    expect(run?.runId).toBe('r1');
    expect(loaded.map((r) => [r.site.id, r.meta !== null, r.report !== null, r.cmp.id])).toEqual([
      ['de-alpha', true, true, 'cookiebot'],
      ['de-beta', true, false, 'n/a'],
      ['us-gamma', false, false, 'n/a'],
    ]);
  });
});
