import { describe, expect, it } from 'vitest';
import {
  type GateCheck,
  type GateInput,
  gate,
  isCounted,
  isRelevant,
  meetsThreshold,
} from '../../../../src/core/evaluation/gate.ts';

const check = (id: string, status: GateCheck['status'], extra: Partial<GateCheck> = {}): GateCheck => ({
  id,
  status,
  gating: true,
  maxSeverity: 'critical',
  ...extra,
});

const base = (over: Partial<GateInput> = {}): GateInput => ({
  failOn: 'critical',
  strict: false,
  fatal: [],
  findings: [],
  checks: [
    check('CONSENT-01', 'completed'),
    check('CONSENT-04', 'completed'),
    check('CONSENT-05', 'completed'),
    check('MAIL-01', 'completed', { maxSeverity: 'warning' }),
    check('TLS-02', 'completed'),
  ],
  sandboxOff: false,
  egressRegion: 'unknown',
  timedOut: false,
  ...over,
});

type StatusChange = [checkId: string, status: GateCheck['status'], reason?: string];

const withStatuses = (input: GateInput, ...changes: StatusChange[]): GateInput => ({
  ...input,
  checks: input.checks.map((c) => {
    const change = changes.findLast(([id]) => id === c.id);
    return change ? { ...c, status: change[1], reason: change[2] ?? null } : c;
  }),
});

type Row = [scenario: string, input: GateInput, exitCode: 0 | 1 | 2, reasons?: string[]];

const critical = { checkId: 'CONSENT-01', severity: 'critical' as const };

// One entry per exit-code row (plus the variants each row names).
const rows: Row[] = [
  [
    '1: no counted findings, relevant checks completed/inconclusive/not_applicable → 0',
    withStatuses(base(), ['CONSENT-04', 'inconclusive'], ['MAIL-01', 'not_applicable']),
    0,
  ],
  ['2: counted finding → 1', base({ findings: [critical] }), 1, ['threshold']],
  [
    '2: counted finding wins over failed checks; reasons keep check-error',
    withStatuses(base({ findings: [critical] }), ['TLS-02', 'error']),
    1,
    ['threshold', 'check-error:TLS-02'],
  ],
  [
    '3: unrecognized banner (CONSENT-04 info + inconclusive, CONSENT-05 inconclusive) → 0',
    withStatuses(
      base({ findings: [{ checkId: 'CONSENT-04', severity: 'info' }] }),
      ['CONSENT-04', 'inconclusive'],
      ['CONSENT-05', 'inconclusive'],
    ),
    0,
  ],
  [
    '3: unrecognized banner with --strict and no 1 → 2',
    withStatuses(
      base({ strict: true, egressRegion: 'asserted' }),
      ['CONSENT-04', 'inconclusive'],
      ['CONSENT-05', 'inconclusive'],
    ),
    2,
    ['strict:inconclusive:CONSENT-04', 'strict:inconclusive:CONSENT-05'],
  ],
  [
    '3: unrecognized banner with --strict but a counted finding → 1',
    withStatuses(base({ strict: true, egressRegion: 'asserted', findings: [critical] }), [
      'CONSENT-04',
      'inconclusive',
    ]),
    1,
    ['threshold', 'strict:inconclusive:CONSENT-04'],
  ],
  [
    '4: bot/geo signal → affected inconclusive, no effect',
    withStatuses(base(), ['CONSENT-01', 'inconclusive', 'bot-mode']),
    0,
  ],
  [
    '4: bot/geo signal with --strict → 2',
    withStatuses(base({ strict: true, egressRegion: 'asserted' }), ['CONSENT-01', 'inconclusive', 'geo']),
    2,
    ['strict:inconclusive:CONSENT-01'],
  ],
  [
    '5: error of a relevant check, no 1 → 2',
    withStatuses(base(), ['TLS-02', 'error', 'exception']),
    2,
    ['check-error:TLS-02'],
  ],
  [
    '6: error of a non-relevant check (max info) → no effect',
    {
      ...base(),
      checks: [...base().checks, check('MAIL-03', 'error', { maxSeverity: 'info' })],
    },
    0,
  ],
  [
    '6: error of a warning-only check under --fail-on critical → no effect',
    withStatuses(base(), ['MAIL-01', 'error']),
    0,
  ],
  [
    '6: error of a warning-only check under --fail-on warning → 2',
    withStatuses(base({ failOn: 'warning' }), ['MAIL-01', 'error']),
    2,
    ['check-error:MAIL-01'],
  ],
  ['7: target unreachable → 2', base({ fatal: ['unreachable'] }), 2, ['unreachable']],
  ['8: WAF/challenge/403 on start page → 2', base({ fatal: ['blocked'] }), 2, ['blocked']],
  [
    '8: fatal beats counted findings collected before the failure',
    base({ fatal: ['blocked'], findings: [critical] }),
    2,
    ['blocked', 'threshold'],
  ],
  ['9: challenge on a subpage → by other rules', base(), 0],
  [
    '10: invalid certificate → TLS-02 critical, browser checks skipped (tls-blocked) → 1',
    withStatuses(
      base({ findings: [{ checkId: 'TLS-02', severity: 'critical' }] }),
      ['CONSENT-01', 'skipped', 'tls-blocked'],
      ['CONSENT-04', 'skipped', 'tls-blocked'],
    ),
    1,
    ['threshold'],
  ],
  [
    '10: invalid certificate with --fail-on none → 0',
    withStatuses(base({ failOn: 'none', findings: [{ checkId: 'TLS-02', severity: 'critical' }] }), [
      'CONSENT-01',
      'skipped',
      'tls-blocked',
    ]),
    0,
  ],
  [
    '11: 429/503 on probes → affected partial, by other rules',
    withStatuses(base(), ['TLS-02', 'partial', 'throttled']),
    0,
  ],
  [
    '12a: global timeout before phase A finished on the start page → fatal 2 (timeout)',
    base({ fatal: ['timeout'], findings: [critical] }),
    2,
    ['timeout', 'threshold'],
  ],
  [
    '12a: fatal timeout with unfinished relevant checks lists timeout once',
    withStatuses(base({ fatal: ['timeout'], timedOut: true }), ['CONSENT-04', 'error', 'timeout']),
    2,
    ['timeout', 'check-error:CONSENT-04'],
  ],
  [
    '12: global timeout with a counted finding → 1',
    withStatuses(base({ timedOut: true, findings: [critical] }), ['CONSENT-04', 'error', 'timeout']),
    1,
    ['threshold', 'check-error:CONSENT-04', 'timeout'],
  ],
  [
    '12: global timeout, unfinished relevant checks → 2',
    withStatuses(base({ timedOut: true }), ['CONSENT-04', 'error', 'timeout']),
    2,
    ['check-error:CONSENT-04', 'timeout'],
  ],
  [
    '12: global timeout, only non-relevant checks unfinished → 0',
    {
      ...base({ timedOut: true }),
      checks: [...base().checks, check('MAIL-03', 'error', { maxSeverity: 'info', reason: 'timeout' })],
    },
    0,
  ],
  [
    '13: --sandbox require and sandbox did not start → 2',
    base({ fatal: ['sandbox-unavailable'] }),
    2,
    ['sandbox-unavailable'],
  ],
  ['14: --sandbox off → no effect', base({ sandboxOff: true }), 0],
  [
    '14: --sandbox off with --strict → 2',
    base({ sandboxOff: true, strict: true, egressRegion: 'asserted' }),
    2,
    ['strict:sandbox-off'],
  ],
  [
    '15: --strict and egress unknown with CONSENT checks → 2',
    base({ strict: true }),
    2,
    ['strict:egress-unverified'],
  ],
  [
    '15: --strict and egress unknown, but a counted finding → 1',
    base({ strict: true, findings: [critical] }),
    1,
    ['threshold', 'strict:egress-unverified'],
  ],
  [
    '15: --strict and egress unknown without CONSENT checks → 0',
    base({ strict: true, checks: [check('TLS-02', 'completed')] }),
    0,
  ],
  [
    '15: --strict and egress unknown with CONSENT checks deselected → 0',
    base({
      strict: true,
      checks: [check('TLS-02', 'completed'), check('CONSENT-01', 'skipped', { enabled: false })],
    }),
    0,
  ],
  ['16: invalid input → 2', base({ fatal: ['invalid-input'] }), 2, ['invalid-input']],
  [
    '16: browser not installed / did not start → 2 (invalid-input row)',
    base({ fatal: ['browser-unavailable'] }),
    2,
    ['invalid-input'],
  ],
  ['17: internal error → 2', base({ fatal: ['internal-error'] }), 2, ['internal-error']],
  [
    '18: JSON/HTML not written → 2',
    base({ fatal: ['report-write-failed'], findings: [critical] }),
    2,
    ['report-write-failed', 'threshold'],
  ],
  [
    '19: --fail-on none → 0 even with findings and check errors',
    withStatuses(base({ failOn: 'none', egressRegion: 'asserted', findings: [critical] }), [
      'TLS-02',
      'error',
    ]),
    0,
  ],
  [
    '19: --fail-on none + --strict without strict conditions → 0',
    withStatuses(base({ failOn: 'none', strict: true, egressRegion: 'asserted', findings: [critical] }), [
      'TLS-02',
      'error',
    ]),
    0,
  ],
  [
    '19: --fail-on none, --strict acts independently: sandbox off → 2',
    withStatuses(
      base({
        failOn: 'none',
        strict: true,
        sandboxOff: true,
        egressRegion: 'asserted',
        findings: [critical],
      }),
      ['TLS-02', 'error'],
    ),
    2,
    ['strict:sandbox-off'],
  ],
  [
    '19: --fail-on none, --strict acts independently: egress unknown with CONSENT checks → 2',
    base({ failOn: 'none', strict: true, sandboxOff: true }),
    2,
    ['strict:sandbox-off', 'strict:egress-unverified'],
  ],
  [
    '19: --fail-on none, --strict acts independently: gating inconclusive (≥ warning) → 2',
    withStatuses(
      base({ failOn: 'none', strict: true, egressRegion: 'asserted' }),
      ['CONSENT-04', 'inconclusive'],
      ['MAIL-01', 'inconclusive'],
    ),
    2,
    ['strict:inconclusive:CONSENT-04', 'strict:inconclusive:MAIL-01'],
  ],
  [
    '19: --fail-on none + --strict: inconclusive of non-gating, info-only or deselected checks → 0',
    {
      ...base({ failOn: 'none', strict: true, egressRegion: 'asserted' }),
      checks: [
        check('TLS-02', 'completed'),
        check('MAIL-03', 'inconclusive', { maxSeverity: 'info' }),
        check('LEGAL-02', 'inconclusive', { gating: false }),
        check('EMBED-01', 'inconclusive', { enabled: false }),
      ],
    },
    0,
  ],
  ['19: --fail-on none → 2 on fatal', base({ failOn: 'none', fatal: ['unreachable'] }), 2, ['unreachable']],
  [
    '20: expired suppression → finding counts again',
    base({ findings: [{ ...critical, suppressed: false }] }),
    1,
    ['threshold'],
  ],
  ['counted: active suppression → not counted', base({ findings: [{ ...critical, suppressed: true }] }), 0],
  [
    'counted: baseline unchanged → not counted; severity-increased → counted',
    base({ findings: [{ ...critical, baselineStatus: 'unchanged' }] }),
    0,
  ],
  [
    'counted: baseline severity-increased → 1',
    base({ findings: [{ ...critical, baselineStatus: 'severity-increased' }] }),
    1,
    ['threshold'],
  ],
  [
    'threshold: --fail-on warning includes critical and warning',
    base({ failOn: 'warning', findings: [{ checkId: 'MAIL-01', severity: 'warning' }] }),
    1,
    ['threshold'],
  ],
  [
    'threshold: warning finding under --fail-on critical → 0',
    base({ findings: [{ checkId: 'MAIL-01', severity: 'warning' }] }),
    0,
  ],
  [
    'threshold: info never gates',
    base({ failOn: 'warning', findings: [{ checkId: 'CONSENT-04', severity: 'info' }] }),
    0,
  ],
  [
    'threshold: findings of non-gating checks are not counted',
    base({ findings: [{ ...critical, gating: false }] }),
    0,
  ],
];

describe('gate — table 5.2', () => {
  const cases = rows.map(([row, input, exitCode, reasons = []]) => ({ row, input, exitCode, reasons }));
  it.each(cases)('$row', ({ input, exitCode, reasons }) => {
    const result = gate(input);
    expect(result.exitCode).toBe(exitCode);
    expect(result.exitReasons).toEqual(reasons);
  });

  it('is pure: same input, same output, input not mutated', () => {
    const input = withStatuses(base({ findings: [critical], strict: true }), ['TLS-02', 'error']);
    const copy = structuredClone(input);
    expect(gate(input)).toEqual(gate(input));
    expect(input).toEqual(copy);
  });
});

describe('gate helpers', () => {
  it('meetsThreshold', () => {
    expect(meetsThreshold('critical', 'critical')).toBe(true);
    expect(meetsThreshold('warning', 'critical')).toBe(false);
    expect(meetsThreshold('critical', 'warning')).toBe(true);
    expect(meetsThreshold('info', 'warning')).toBe(false);
    expect(meetsThreshold('critical', 'none')).toBe(false);
  });

  it('isRelevant needs gating, enabled and maxSeverity ≥ failOn', () => {
    expect(isRelevant(check('A-01', 'completed'), 'critical')).toBe(true);
    expect(isRelevant(check('A-01', 'completed', { gating: false }), 'critical')).toBe(false);
    expect(isRelevant(check('A-01', 'completed', { enabled: false }), 'critical')).toBe(false);
    expect(isRelevant(check('A-01', 'completed', { maxSeverity: null }), 'warning')).toBe(false);
    expect(isRelevant(check('A-01', 'completed', { maxSeverity: 'warning' }), 'critical')).toBe(false);
    expect(isRelevant(check('A-01', 'completed'), 'none')).toBe(false);
  });

  it('isCounted', () => {
    expect(isCounted(critical, 'critical')).toBe(true);
    expect(isCounted({ ...critical, suppressed: true }, 'critical')).toBe(false);
  });
});
