/**
 * Which checks a page that bot protection blocked affects, by the page's role and phase (a fallback probe by its path),
 * and which checks a throttling target host affects. The expectations come from what the checks declare and read: the
 * browser section among their inputs, and the mail domains the DNS stage takes from the Impressum.
 */
import { describe, expect, it } from 'vitest';
import { allChecks } from '../../../../../src/checks/index.ts';
import { blockedAffects, throttledAffects } from '../../../../../src/collectors/browser/pages/navigate.ts';
import type { VisitSpec } from '../../../../../src/collectors/browser/pages/visit.ts';
import type { AnyCheck } from '../../../../../src/core/evaluation/check.ts';
import type { BrowserPhase } from '../../../../../src/core/snapshot/common.ts';
import type { MailDomainStage } from '../../../../../src/core/snapshot/dns.ts';
import { runCheck } from '../../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneSpec } from '../../../checks/dns/zone.ts';

const spec = (over: Partial<VisitSpec>): VisitSpec => ({
  rawUrl: 'https://www.example.test/',
  role: 'other',
  order: 1,
  phase: 'A',
  firstVisit: true,
  ...over,
});

const ids = (checks: readonly AnyCheck[]) => checks.map((c) => c.id).sort();
const inputsOf = (c: AnyCheck): readonly string[] => [...c.requires, ...(c.optional ?? [])];

/** Checks that declare the browser section: required, or optional like TLS-01, which reads the links of phase A. */
const READS_BROWSER = ids(allChecks.filter((c) => inputsOf(c).includes('browser')));
const REQUIRES_BROWSER = ids(allChecks.filter((c) => c.requires.includes('browser')));

/**
 * Checks that read the mail domains the DNS stage takes from the Impressum the browser read: their outcome changes when
 * the stage says the Impressum was not read. They declare only the dns section.
 */
const SITE: ZoneSpec = {
  'MX example.de': ['10 mx.example.de'],
  'TXT _dmarc.www.example.de': 'NXDOMAIN',
  'TXT _dmarc.example.de': ['v=DMARC1; p=reject'],
  'TXT example.de': ['v=spf1 ip4:192.0.2.0/24 -all'],
};
const outcomeWith = (c: AnyCheck, contacts: MailDomainStage['contacts']) =>
  JSON.stringify(
    runCheck(
      c,
      dnsSnapshot(SITE, { mailDomains: [], mailDomainStage: { contacts, durationMs: 1 }, dkimPlan: [] }),
    ),
  );
const READS_IMPRESSUM_MAIL = ids(
  allChecks.filter((c) => outcomeWith(c, 'impressum') !== outcomeWith(c, 'not-collected')),
);

/** TLS-01 reads the links of phase A only, the mail checks the Impressum that phase A reads. */
const PHASE_A_ONLY = ['TLS-01', ...READS_IMPRESSUM_MAIL];
const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe('the checks the expectations are derived from', () => {
  it('the mail domains of the Impressum are read by the MAIL checks, the links of phase A by TLS-01', () => {
    expect(READS_IMPRESSUM_MAIL).toEqual(['MAIL-01', 'MAIL-02', 'MAIL-03']);
    expect(READS_BROWSER.filter((id) => !REQUIRES_BROWSER.includes(id))).toEqual(['TLS-01']);
  });
});

describe('blockedAffects', () => {
  const MAIL = READS_IMPRESSUM_MAIL;
  it.each<[string, Partial<VisitSpec>, string[]]>([
    ['impressum', { role: 'impressum' }, ['LEGAL-01', ...MAIL, 'TLS-01']],
    ['legal hop', { role: 'legal-hop' }, ['LEGAL-01', 'TLS-01']],
    [
      'legal hop searched for the Impressum',
      { role: 'legal-hop', legalKinds: ['impressum'] },
      ['LEGAL-01', ...MAIL, 'TLS-01'],
    ],
    [
      'legal hop searched for the privacy policy',
      { role: 'legal-hop', legalKinds: ['privacy'] },
      ['LEGAL-01', 'PRIV-01', 'PRIV-02', 'TLS-01'],
    ],
    ['privacy', { role: 'privacy' }, ['LEGAL-01', 'PRIV-01', 'PRIV-02', 'TLS-01']],
    ['contact', { role: 'contact' }, ['EMBED-02', 'TLS-01']],
    [
      'contact searched for the Impressum',
      { role: 'contact', legalKinds: ['impressum'] },
      ['EMBED-02', 'LEGAL-01', ...MAIL, 'TLS-01'],
    ],
    [
      'contact searched for the privacy policy',
      { role: 'contact', legalKinds: ['privacy'] },
      ['EMBED-02', 'LEGAL-01', 'PRIV-01', 'PRIV-02', 'TLS-01'],
    ],
    [
      'privacy page also read as the Impressum',
      { role: 'privacy', legalKinds: ['impressum', 'privacy'] },
      ['LEGAL-01', ...MAIL, 'PRIV-01', 'PRIV-02', 'TLS-01'],
    ],
    [
      'Impressum page also read as the privacy policy',
      { role: 'impressum', legalKinds: ['impressum', 'privacy'] },
      ['LEGAL-01', ...MAIL, 'PRIV-01', 'PRIV-02', 'TLS-01'],
    ],
    ['start page of phase A', { role: 'start', phase: 'A' }, []],
    ['start page of phase B', { role: 'start', phase: 'B' }, ['CONSENT-04', 'CONSENT-05']],
    ['start page of phase C', { role: 'start', phase: 'C' }, ['CONSENT-04', 'CONSENT-05']],
    ['navigation page', { role: 'nav' }, ['TLS-01']],
    ['configured page', { role: 'config' }, ['TLS-01']],
    ['other page', { role: 'other' }, ['TLS-01']],
    [
      'fallback probe of the privacy path',
      { role: 'fallback', rawUrl: 'https://www.example.test/datenschutz' },
      ['LEGAL-01', 'PRIV-01', 'PRIV-02', 'TLS-01'],
    ],
    [
      'fallback probe of the impressum path',
      { role: 'fallback', rawUrl: 'https://www.example.test/impressum' },
      ['LEGAL-01', ...MAIL, 'TLS-01'],
    ],
    [
      'fallback probe of an unparsable URL',
      { role: 'fallback', rawUrl: 'not a url' },
      ['LEGAL-01', ...MAIL, 'TLS-01'],
    ],
    ['impressum in phase B', { role: 'impressum', phase: 'B' }, ['LEGAL-01']],
    ['privacy in phase C', { role: 'privacy', phase: 'C' }, ['LEGAL-01', 'PRIV-01', 'PRIV-02']],
    ['navigation page in phase B', { role: 'nav', phase: 'B' }, []],
    [
      'contact in phase B, even with a search',
      { role: 'contact', phase: 'B', legalKinds: ['impressum'] },
      ['EMBED-02'],
    ],
  ])('%s', (_name, over, affects) => {
    expect(blockedAffects(spec(over))).toEqual(affects);
  });

  it('returns a fresh list, so callers cannot change the table', () => {
    blockedAffects(spec({ role: 'privacy' })).push('X');
    expect(blockedAffects(spec({ role: 'privacy' }))).toEqual(['LEGAL-01', 'PRIV-01', 'PRIV-02', 'TLS-01']);
  });

  it('names registered checks only, and the phase-A-only checks never outside phase A', () => {
    const registered = new Set(allChecks.map((c) => c.id));
    const roles = [
      'impressum',
      'privacy',
      'contact',
      'nav',
      'legal-hop',
      'fallback',
      'config',
      'other',
      'start',
    ];
    for (const phase of ['A', 'B', 'C'] as const) {
      for (const role of roles) {
        const affects = blockedAffects(spec({ role: role as VisitSpec['role'], phase }));
        expect(affects.filter((id) => !registered.has(id))).toEqual([]);
        if (phase !== 'A') expect(affects.filter((id) => PHASE_A_ONLY.includes(id))).toEqual([]);
      }
    }
  });
});

describe('throttledAffects', () => {
  it.each<[BrowserPhase, string, string[]]>([
    [
      'A',
      'every check reading the browser, its links of phase A or the Impressum',
      sorted([...READS_BROWSER, ...READS_IMPRESSUM_MAIL]),
    ],
    ['B', 'the checks requiring the browser', REQUIRES_BROWSER],
    ['C', 'the checks requiring the browser', REQUIRES_BROWSER],
  ])('a throttle in phase %s affects %s', (phase, _what, want) => {
    expect(sorted(throttledAffects(phase))).toEqual(want);
  });

  it('returns a fresh list', () => {
    throttledAffects('A').push('X');
    expect(throttledAffects('A')).not.toContain('X');
  });
});
