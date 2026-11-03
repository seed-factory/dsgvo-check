/** SUMMARY.md: the canary summary as markdown tables. */
import {
  type CanarySummary,
  CHECK_STATUSES,
  type CheckAggregate,
  type DurationStats,
  GROUP_LABEL,
  GROUPS,
  type GroupAggregate,
  SCAN_STATUSES,
  SEVERITIES,
} from './canary-aggregate.ts';
import { DETECTED_CMPS } from './canary-load.ts';
import { EXPECTED_CMPS, KNOWN_CMPS } from './canary-sites.ts';

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
