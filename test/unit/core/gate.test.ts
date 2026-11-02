import { describe, expect, it } from 'vitest';
import {
  type GateCheck,
  type GateInput,
  gate,
  isCounted,
  isRelevant,
  meetsThreshold,
} from '../../../src/core/gate.ts';

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

const withStatus = (
  input: GateInput,
  id: string,
  status: GateCheck['status'],
  reason?: string,
): GateInput => ({
  ...input,
  checks: input.checks.map((c) => (c.id === id ? { ...c, status, reason: reason ?? null } : c)),
});

interface Row {
  row: string;
  input: GateInput;
  exitCode: 0 | 1 | 2;
  reasons: string[];
}

const critical = { checkId: 'CONSENT-01', severity: 'critical' as const };

// One entry per row of specification 5.2 (plus the variants each row names).
const rows: Row[] = [
  {
    row: '1: no counted findings, relevant checks completed/inconclusive/not_applicable → 0',
    input: withStatus(withStatus(base(), 'CONSENT-04', 'inconclusive'), 'MAIL-01', 'not_applicable'),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '2: counted finding → 1',
    input: base({ findings: [critical] }),
    exitCode: 1,
    reasons: ['threshold'],
  },
  {
    row: '2: counted finding wins over failed checks; reasons keep check-error',
    input: withStatus(base({ findings: [critical] }), 'TLS-02', 'error'),
    exitCode: 1,
    reasons: ['threshold', 'check-error:TLS-02'],
  },
  {
    row: '3: unrecognized banner (CONSENT-04 info + inconclusive, CONSENT-05 inconclusive) → 0',
    input: withStatus(
      withStatus(
        base({ findings: [{ checkId: 'CONSENT-04', severity: 'info' }] }),
        'CONSENT-04',
        'inconclusive',
      ),
      'CONSENT-05',
      'inconclusive',
    ),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '3: unrecognized banner with --strict and no 1 → 2',
    input: withStatus(
      withStatus(base({ strict: true, egressRegion: 'asserted' }), 'CONSENT-04', 'inconclusive'),
      'CONSENT-05',
      'inconclusive',
    ),
    exitCode: 2,
    reasons: ['strict:inconclusive:CONSENT-04', 'strict:inconclusive:CONSENT-05'],
  },
  {
    row: '3: unrecognized banner with --strict but a counted finding → 1',
    input: withStatus(
      base({ strict: true, egressRegion: 'asserted', findings: [critical] }),
      'CONSENT-04',
      'inconclusive',
    ),
    exitCode: 1,
    reasons: ['threshold', 'strict:inconclusive:CONSENT-04'],
  },
  {
    row: '4: bot/geo signal → affected inconclusive, no effect',
    input: withStatus(base(), 'CONSENT-01', 'inconclusive', 'bot-mode'),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '4: bot/geo signal with --strict → 2',
    input: withStatus(base({ strict: true, egressRegion: 'asserted' }), 'CONSENT-01', 'inconclusive', 'geo'),
    exitCode: 2,
    reasons: ['strict:inconclusive:CONSENT-01'],
  },
  {
    row: '5: error of a relevant check, no 1 → 2',
    input: withStatus(base(), 'TLS-02', 'error', 'exception'),
    exitCode: 2,
    reasons: ['check-error:TLS-02'],
  },
  {
    row: '6: error of a non-relevant check (max info) → no effect',
    input: {
      ...base(),
      checks: [...base().checks, check('MAIL-03', 'error', { maxSeverity: 'info' })],
    },
    exitCode: 0,
    reasons: [],
  },
  {
    row: '6: error of a warning-only check under --fail-on critical → no effect',
    input: withStatus(base(), 'MAIL-01', 'error'),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '6: error of a warning-only check under --fail-on warning → 2',
    input: withStatus(base({ failOn: 'warning' }), 'MAIL-01', 'error'),
    exitCode: 2,
    reasons: ['check-error:MAIL-01'],
  },
  {
    row: '7: target unreachable → 2',
    input: base({ fatal: ['unreachable'] }),
    exitCode: 2,
    reasons: ['unreachable'],
  },
  {
    row: '8: WAF/challenge/403 on start page → 2',
    input: base({ fatal: ['blocked'] }),
    exitCode: 2,
    reasons: ['blocked'],
  },
  {
    row: '8: fatal beats counted findings collected before the failure',
    input: base({ fatal: ['blocked'], findings: [critical] }),
    exitCode: 2,
    reasons: ['blocked', 'threshold'],
  },
  {
    row: '9: challenge on a subpage → by other rules',
    input: base(),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '10: invalid certificate → TLS-02 critical, browser checks skipped (tls-blocked) → 1',
    input: withStatus(
      withStatus(
        base({ findings: [{ checkId: 'TLS-02', severity: 'critical' }] }),
        'CONSENT-01',
        'skipped',
        'tls-blocked',
      ),
      'CONSENT-04',
      'skipped',
      'tls-blocked',
    ),
    exitCode: 1,
    reasons: ['threshold'],
  },
  {
    row: '10: invalid certificate with --fail-on none → 0',
    input: withStatus(
      base({ failOn: 'none', findings: [{ checkId: 'TLS-02', severity: 'critical' }] }),
      'CONSENT-01',
      'skipped',
      'tls-blocked',
    ),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '11: 429/503 on probes → affected partial, by other rules',
    input: withStatus(base(), 'TLS-02', 'partial', 'throttled'),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '12a: global timeout before phase A finished on the start page → fatal 2 (timeout)',
    input: base({ fatal: ['timeout'], findings: [critical] }),
    exitCode: 2,
    reasons: ['timeout', 'threshold'],
  },
  {
    row: '12a: fatal timeout with unfinished relevant checks lists timeout once',
    input: withStatus(base({ fatal: ['timeout'], timedOut: true }), 'CONSENT-04', 'error', 'timeout'),
    exitCode: 2,
    reasons: ['timeout', 'check-error:CONSENT-04'],
  },
  {
    row: '12: global timeout with a counted finding → 1',
    input: withStatus(base({ timedOut: true, findings: [critical] }), 'CONSENT-04', 'error', 'timeout'),
    exitCode: 1,
    reasons: ['threshold', 'check-error:CONSENT-04', 'timeout'],
  },
  {
    row: '12: global timeout, unfinished relevant checks → 2',
    input: withStatus(base({ timedOut: true }), 'CONSENT-04', 'error', 'timeout'),
    exitCode: 2,
    reasons: ['check-error:CONSENT-04', 'timeout'],
  },
  {
    row: '12: global timeout, only non-relevant checks unfinished → 0',
    input: {
      ...base({ timedOut: true }),
      checks: [...base().checks, check('MAIL-03', 'error', { maxSeverity: 'info', reason: 'timeout' })],
    },
    exitCode: 0,
    reasons: [],
  },
  {
    row: '13: --sandbox require and sandbox did not start → 2',
    input: base({ fatal: ['sandbox-unavailable'] }),
    exitCode: 2,
    reasons: ['sandbox-unavailable'],
  },
  { row: '14: --sandbox off → no effect', input: base({ sandboxOff: true }), exitCode: 0, reasons: [] },
  {
    row: '14: --sandbox off with --strict → 2',
    input: base({ sandboxOff: true, strict: true, egressRegion: 'asserted' }),
    exitCode: 2,
    reasons: ['strict:sandbox-off'],
  },
  {
    row: '15: --strict and egress unknown with CONSENT checks → 2',
    input: base({ strict: true }),
    exitCode: 2,
    reasons: ['strict:egress-unverified'],
  },
  {
    row: '15: --strict and egress unknown, but a counted finding → 1',
    input: base({ strict: true, findings: [critical] }),
    exitCode: 1,
    reasons: ['threshold', 'strict:egress-unverified'],
  },
  {
    row: '15: --strict and egress unknown without CONSENT checks → 0',
    input: base({ strict: true, checks: [check('TLS-02', 'completed')] }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '15: --strict and egress unknown with CONSENT checks deselected → 0',
    input: base({
      strict: true,
      checks: [check('TLS-02', 'completed'), check('CONSENT-01', 'skipped', { enabled: false })],
    }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '16: invalid input → 2',
    input: base({ fatal: ['invalid-input'] }),
    exitCode: 2,
    reasons: ['invalid-input'],
  },
  {
    row: '16: browser not installed / did not start → 2 (invalid-input row)',
    input: base({ fatal: ['browser-unavailable'] }),
    exitCode: 2,
    reasons: ['invalid-input'],
  },
  {
    row: '17: internal error → 2',
    input: base({ fatal: ['internal-error'] }),
    exitCode: 2,
    reasons: ['internal-error'],
  },
  {
    row: '18: JSON/HTML not written → 2',
    input: base({ fatal: ['report-write-failed'], findings: [critical] }),
    exitCode: 2,
    reasons: ['report-write-failed', 'threshold'],
  },
  {
    row: '19: --fail-on none → 0 even with findings and check errors',
    input: withStatus(
      base({ failOn: 'none', egressRegion: 'asserted', findings: [critical] }),
      'TLS-02',
      'error',
    ),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '19: --fail-on none + --strict without strict conditions → 0',
    input: withStatus(
      base({ failOn: 'none', strict: true, egressRegion: 'asserted', findings: [critical] }),
      'TLS-02',
      'error',
    ),
    exitCode: 0,
    reasons: [],
  },
  {
    row: '19: --fail-on none, --strict acts independently: sandbox off → 2',
    input: withStatus(
      base({
        failOn: 'none',
        strict: true,
        sandboxOff: true,
        egressRegion: 'asserted',
        findings: [critical],
      }),
      'TLS-02',
      'error',
    ),
    exitCode: 2,
    reasons: ['strict:sandbox-off'],
  },
  {
    row: '19: --fail-on none, --strict acts independently: egress unknown with CONSENT checks → 2',
    input: base({ failOn: 'none', strict: true, sandboxOff: true }),
    exitCode: 2,
    reasons: ['strict:sandbox-off', 'strict:egress-unverified'],
  },
  {
    row: '19: --fail-on none, --strict acts independently: gating inconclusive (≥ warning) → 2',
    input: withStatus(
      withStatus(
        base({ failOn: 'none', strict: true, egressRegion: 'asserted' }),
        'CONSENT-04',
        'inconclusive',
      ),
      'MAIL-01',
      'inconclusive',
    ),
    exitCode: 2,
    reasons: ['strict:inconclusive:CONSENT-04', 'strict:inconclusive:MAIL-01'],
  },
  {
    row: '19: --fail-on none + --strict: inconclusive of non-gating, info-only or deselected checks → 0',
    input: {
      ...base({ failOn: 'none', strict: true, egressRegion: 'asserted' }),
      checks: [
        check('TLS-02', 'completed'),
        check('MAIL-03', 'inconclusive', { maxSeverity: 'info' }),
        check('LEGAL-02', 'inconclusive', { gating: false }),
        check('EMBED-01', 'inconclusive', { enabled: false }),
      ],
    },
    exitCode: 0,
    reasons: [],
  },
  {
    row: '19: --fail-on none → 2 on fatal',
    input: base({ failOn: 'none', fatal: ['unreachable'] }),
    exitCode: 2,
    reasons: ['unreachable'],
  },
  {
    row: '20: expired suppression → finding counts again',
    input: base({ findings: [{ ...critical, suppressed: false }] }),
    exitCode: 1,
    reasons: ['threshold'],
  },
  {
    row: 'counted: active suppression → not counted',
    input: base({ findings: [{ ...critical, suppressed: true }] }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: 'counted: baseline unchanged → not counted; severity-increased → counted',
    input: base({ findings: [{ ...critical, baselineStatus: 'unchanged' }] }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: 'counted: baseline severity-increased → 1',
    input: base({ findings: [{ ...critical, baselineStatus: 'severity-increased' }] }),
    exitCode: 1,
    reasons: ['threshold'],
  },
  {
    row: 'threshold: --fail-on warning includes critical and warning',
    input: base({ failOn: 'warning', findings: [{ checkId: 'MAIL-01', severity: 'warning' }] }),
    exitCode: 1,
    reasons: ['threshold'],
  },
  {
    row: 'threshold: warning finding under --fail-on critical → 0',
    input: base({ findings: [{ checkId: 'MAIL-01', severity: 'warning' }] }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: 'threshold: info never gates',
    input: base({ failOn: 'warning', findings: [{ checkId: 'CONSENT-04', severity: 'info' }] }),
    exitCode: 0,
    reasons: [],
  },
  {
    row: 'threshold: findings of non-gating checks are not counted',
    input: base({ findings: [{ ...critical, gating: false }] }),
    exitCode: 0,
    reasons: [],
  },
];

describe('gate — table 5.2', () => {
  it.each(rows)('$row', ({ input, exitCode, reasons }) => {
    const result = gate(input);
    expect(result.exitCode).toBe(exitCode);
    expect(result.exitReasons).toEqual(reasons);
  });

  it('is pure: same input, same output, input not mutated', () => {
    const input = withStatus(base({ findings: [critical], strict: true }), 'TLS-02', 'error');
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
