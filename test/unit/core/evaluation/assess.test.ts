import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../../src/checks/browser/consent-02.ts';
import { embed03 } from '../../../../src/checks/browser/embed-03.ts';
import {
  type LegalNote,
  loadRouting,
  loadRuleset,
  loadTexts,
  type Ruleset,
  type Texts,
} from '../../../../src/core/data/load.ts';
import {
  type AssessInput,
  assess,
  capByConfidence,
  type ExecutedCheck,
  legalNoteIdFor,
  lockedOverrides,
  maxSeverityOf,
  mergeDiagnostics,
  resolveSeverity,
} from '../../../../src/core/evaluation/assess.ts';
import { type AnyCheck, defineCheck, type Observation } from '../../../../src/core/evaluation/check.ts';
import { fingerprint } from '../../../../src/core/evaluation/fingerprint.ts';
import { runCheck } from '../../../utils/snapshot-builder.ts';
import {
  defaultPages,
  ORIGIN,
  page,
  phase,
  req,
  START,
  site,
  storage,
} from '../../checks/browser/helpers.ts';

const ruleset: Ruleset = {
  profile: { id: 'de-2026', version: 'test', rechtsstand: '2026-10-30', draft: true },
  checks: {
    'TEST-01': {
      gating: true,
      variants: {
        hit: { severity: 'critical', crm: 'T1_TRACKER_BEFORE_CONSENT' },
        soft: { severity: 'warning', crm: null },
        inventory: { severity: 'info', crm: null },
      },
    },
    'CONSENT-01': { gating: true, variants: { 'tracker-hit': { severity: 'critical', crm: null } } },
    'EMBED-01': { gating: true, variants: { 'fonts-loaded': { severity: 'warning', crm: null } } },
    'CONSENT-02': { gating: true, variants: { 'tracking-cookie': { severity: 'critical', crm: null } } },
    'CONSENT-04': {
      gating: true,
      variants: {
        'blocking-no-reject': { severity: 'critical', crm: null },
        'banner-not-recognized': { severity: 'info', crm: null, gating: false, locked: true },
      },
    },
  },
};

const obs = (p: Partial<Observation> = {}): Observation => ({
  checkId: 'TEST-01',
  variant: 'hit',
  confidence: 'high',
  subject: 'svc-a',
  phases: ['A'],
  pages: ['https://www.example.de/'],
  evidence: [],
  params: {},
  ...p,
});

const check = (id: string, variants: string[], extra: Partial<AnyCheck> = {}): AnyCheck =>
  defineCheck({
    id,
    module: 'browser',
    requires: ['browser'],
    variants: variants.map((variant) => ({ variant })),
    run: () => [],
    ...extra,
  });

const exec = (observations: Observation[]): ExecutedCheck => ({
  status: 'completed',
  reason: null,
  outcome: { status: 'completed', observations },
  durationMs: 1,
});

function run(
  checks: AnyCheck[],
  executed: Record<string, ExecutedCheck>,
  overrides = [],
  extra: Partial<AssessInput> = {},
) {
  return assess({
    checks,
    executed: new Map(Object.entries(executed)),
    ruleset,
    routing: { analytics: 'CONSENT-01', fonts: 'EMBED-01' },
    overrides,
    ...extra,
  });
}

describe('confidence cap', () => {
  it.each([
    ['critical', 'high', 'critical'],
    ['critical', 'medium', 'warning'],
    ['critical', 'low', 'info'],
    ['warning', 'medium', 'warning'],
    ['warning', 'low', 'info'],
    ['info', 'high', 'info'],
  ] as const)('%s with %s confidence → %s', (sev, conf, expected) => {
    expect(capByConfidence(sev, conf)).toBe(expected);
  });

  it('applies the cap to findings', () => {
    const c = check('TEST-01', ['hit', 'soft', 'inventory']);
    const out = run([c], {
      'TEST-01': exec([
        obs({ subject: 'a', confidence: 'medium' }),
        obs({ subject: 'b', confidence: 'low' }),
        obs({ subject: 'c', confidence: 'high' }),
      ]),
    });
    const bySubject = Object.fromEntries(out.findings.map((f) => [f.subject, f.severity]));
    expect(bySubject).toEqual({ a: 'warning', b: 'info', c: 'critical' });
  });
});

describe('ruleset resolution and overrides', () => {
  it('variant override wins; check override does not raise info variants', () => {
    expect(resolveSeverity(ruleset, 'TEST-01', 'soft', [{ rule: 'TEST-01.soft', severity: 'info' }])).toBe(
      'info',
    );
    expect(resolveSeverity(ruleset, 'TEST-01', 'soft', [{ rule: 'TEST-01', severity: 'critical' }])).toBe(
      'critical',
    );
    expect(
      resolveSeverity(ruleset, 'TEST-01', 'inventory', [{ rule: 'TEST-01', severity: 'critical' }]),
    ).toBe('info');
    expect(resolveSeverity(ruleset, 'TEST-01', 'missing')).toBeUndefined();
  });

  it('locked variants ignore every override (5.4, 5.5)', () => {
    expect(
      resolveSeverity(ruleset, 'CONSENT-04', 'banner-not-recognized', [
        { rule: 'CONSENT-04.banner-not-recognized', severity: 'critical' },
      ]),
    ).toBe('info');
    expect(
      resolveSeverity(ruleset, 'CONSENT-04', 'banner-not-recognized', [
        { rule: 'CONSENT-04', severity: 'critical' },
      ]),
    ).toBe('info');
    expect(
      lockedOverrides(ruleset, [{ rule: 'CONSENT-04.banner-not-recognized', severity: 'warning' }]),
    ).toEqual(['CONSENT-04.banner-not-recognized']);
    expect(lockedOverrides(ruleset, [{ rule: 'CONSENT-04', severity: 'warning' }])).toEqual([]);
    expect(
      lockedOverrides(ruleset, [{ rule: 'CONSENT-04.blocking-no-reject', severity: 'warning' }]),
    ).toEqual([]);
  });

  it('maxSeverity uses static variants, ruleset and overrides, without the confidence cap', () => {
    expect(maxSeverityOf(check('TEST-01', ['soft', 'inventory']), ruleset)).toBe('warning');
    const multiVariantCheck = defineCheck({
      id: 'TEST-01',
      module: 'browser',
      requires: [],
      variants: [
        { variant: 'soft', maxConfidence: 'medium' },
        { variant: 'inventory', maxConfidence: 'low' },
      ],
      run: () => [],
    });
    // A failed check has no confidence: the cap applies to concrete findings only.
    expect(maxSeverityOf(multiVariantCheck, ruleset)).toBe('warning');
    expect(maxSeverityOf(multiVariantCheck, ruleset, [{ rule: 'TEST-01.soft', severity: 'critical' }])).toBe(
      'critical',
    );
    const criticalVariantCheck = defineCheck({
      ...multiVariantCheck,
      variants: [{ variant: 'hit', maxConfidence: 'medium' }],
    });
    expect(maxSeverityOf(criticalVariantCheck, ruleset)).toBe('critical');
    expect(maxSeverityOf(check('NONE-01', ['x']), ruleset)).toBeNull();
  });

  it('a check whose variant is overridden above its confidence cap stays relevant when it fails', () => {
    const c = defineCheck({
      id: 'TEST-01',
      module: 'browser',
      requires: [],
      variants: [{ variant: 'soft' }],
      run: () => [],
    });
    const out = assess({
      checks: [c],
      executed: new Map([
        ['TEST-01', { status: 'error', reason: 'exception', outcome: null, durationMs: 1 }],
      ]),
      ruleset,
      routing: {},
      overrides: [{ rule: 'TEST-01.soft', severity: 'critical' }],
    });
    expect(out.checks[0]?.maxSeverity).toBe('critical');
    // The finding itself is still capped by its confidence.
    const ok = assess({
      checks: [c],
      executed: new Map([
        [
          'TEST-01',
          {
            status: 'completed',
            reason: null,
            outcome: { status: 'completed', observations: [obs({ variant: 'soft', confidence: 'medium' })] },
            durationMs: 1,
          },
        ],
      ]),
      ruleset,
      routing: {},
      overrides: [{ rule: 'TEST-01.soft', severity: 'critical' }],
    });
    expect(ok.findings[0]?.severity).toBe('warning');
  });
});

describe('assess', () => {
  it('builds findings with fingerprint, crmCode, messageId and evidence ids', () => {
    const c = check('TEST-01', ['hit', 'inventory']);
    const evidence = [
      {
        type: 'request' as const,
        url: 'https://ga.example/collect',
        method: 'GET',
        resourceType: 'ping',
        delivery: 'sent' as const,
        result: { kind: 'response' as const, status: 204 },
        features: {
          identifier: { kind: 'none' as const },
          matchesStoredIdentifier: false,
          parserVersion: 'request-features/2',
          observationSource: 'playwright' as const,
        },
      },
    ];

    const out = run([c], {
      'TEST-01': exec([
        obs({ evidence, serviceId: 'google-analytics-4' }),
        obs({ variant: 'inventory', subject: 'inv' }),
      ]),
    });

    const hit = out.findings.find((f) => f.variant === 'hit')!;
    expect(hit.fingerprint).toBe(fingerprint({ checkId: 'TEST-01', variantGroup: 'hit', subject: 'svc-a' }));
    expect(hit.crmCode).toBe('T1_TRACKER_BEFORE_CONSENT');
    expect(hit.messageId).toBe('TEST-01.hit');
    expect(hit.evidenceIds).toHaveLength(1);
    expect(out.evidence[0]?.id).toBe(hit.evidenceIds[0]);
    expect(out.findings.find((f) => f.variant === 'inventory')?.crmCode).toBeNull();

    expect(out.checks[0]).toMatchObject({
      id: 'TEST-01',
      status: 'completed',
      maxSeverity: 'critical',
      gating: true,
    });
  });

  it('merges observations with the same fingerprint, keeping the strongest and the union of pages/phases', () => {
    const c = check('TEST-01', ['hit', 'soft'], {
      variants: [
        { variant: 'hit', variantGroup: 'svc' },
        { variant: 'soft', variantGroup: 'svc' },
      ],
    });
    const out = run([c], {
      'TEST-01': exec([
        obs({ variant: 'soft', pages: ['https://www.example.de/a'], phases: ['A'] }),
        obs({ variant: 'hit', pages: ['https://www.example.de/b'], phases: ['B'] }),
      ]),
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ variant: 'hit', severity: 'critical', phases: ['A', 'B'] });
    expect(out.findings[0]?.pages).toEqual(['https://www.example.de/a', 'https://www.example.de/b']);
  });

  it('deduplicates identical evidence and truncates to 20 ids', () => {
    const c = check('TEST-01', ['hit']);
    const ev = (i: number) => ({ type: 'header' as const, url: 'https://x/', name: `h${i}`, present: false });
    const out = run([c], {
      'TEST-01': exec([
        obs({ evidence: [ev(1), ev(1), ...Array.from({ length: 25 }, (_, i) => ev(i + 2))] }),
      ]),
    });
    expect(out.findings[0]?.evidenceIds).toHaveLength(20);
    expect(out.findings[0]?.evidenceTruncated).toBe(true);
    expect(out.evidence).toHaveLength(26);
  });

  it('keeps as many evidence ids as the settings allow', () => {
    const c = check('TEST-01', ['hit']);
    const ev = (i: number) => ({ type: 'header' as const, url: 'https://x/', name: `h${i}`, present: false });
    const executed = { 'TEST-01': exec([obs({ evidence: Array.from({ length: 8 }, (_, i) => ev(i)) })]) };
    const few = run([c], executed, [], { maxEvidencePerFinding: 3 });
    expect(few.findings[0]?.evidenceIds).toHaveLength(3);
    expect(few.findings[0]?.evidenceTruncated).toBe(true);
    const many = run([c], executed, [], { maxEvidencePerFinding: 8 });
    expect(many.findings[0]?.evidenceIds).toHaveLength(8);
    expect(many.findings[0]).not.toHaveProperty('evidenceTruncated');
  });

  it('routing: an owner check drops observations of a category owned by another check', () => {
    const consent = check('CONSENT-01', ['tracker-hit']);
    const embed = check('EMBED-01', ['fonts-loaded']);
    const cookies = check('CONSENT-02', ['tracking-cookie']);
    const out = run([consent, embed, cookies], {
      'CONSENT-01': exec([
        obs({ checkId: 'CONSENT-01', variant: 'tracker-hit', subject: 'google-fonts', category: 'fonts' }),
        obs({
          checkId: 'CONSENT-01',
          variant: 'tracker-hit',
          subject: 'ga4',
          category: 'analytics',
          serviceId: 'ga4',
        }),
      ]),
      'EMBED-01': exec([
        obs({ checkId: 'EMBED-01', variant: 'fonts-loaded', subject: 'google-fonts', category: 'fonts' }),
      ]),
      // CONSENT-02 is not a routing owner: an independent axis, never dropped.
      'CONSENT-02': exec([
        obs({
          checkId: 'CONSENT-02',
          variant: 'tracking-cookie',
          subject: '_ga',
          category: 'analytics',
          serviceId: 'ga4',
        }),
      ]),
    });
    expect(out.findings.map((f) => `${f.checkId}:${f.subject}`).sort()).toEqual([
      'CONSENT-01:ga4',
      'CONSENT-02:_ga',
      'EMBED-01:google-fonts',
    ]);
    const ga = out.findings.find((f) => f.checkId === 'CONSENT-01')!;
    expect(ga.related).toEqual([
      {
        checkId: 'CONSENT-02',
        fingerprint: out.findings.find((f) => f.checkId === 'CONSENT-02')!.fingerprint,
        relation: 'same-service',
      },
    ]);
  });

  it('an unknown variant or missing ruleset entry turns the check into an error', () => {
    const c = check('TEST-01', ['hit', 'unlisted']);
    const out = run([c], { 'TEST-01': exec([obs({ variant: 'nope' })]) });
    expect(out.checks[0]).toMatchObject({ status: 'error', reason: 'invalid-observation' });
    const out2 = run([c], { 'TEST-01': exec([obs({ variant: 'unlisted' })]) });
    expect(out2.checks[0]).toMatchObject({ status: 'error', reason: 'invalid-observation' });
    expect(out2.findings).toHaveLength(0);
  });

  it('keeps an info finding for an inconclusive check (banner not recognized)', () => {
    const c = check('TEST-01', ['inventory']);
    const out = run([c], {
      'TEST-01': {
        status: 'inconclusive',
        reason: 'banner-not-recognized',
        durationMs: 1,
        outcome: {
          status: 'inconclusive',
          reason: 'banner-not-recognized',
          observations: [obs({ variant: 'inventory' })],
        },
      },
    });
    expect(out.checks[0]).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    expect(out.findings[0]?.severity).toBe('info');
  });

  it('checks without execution are reported as skipped', () => {
    const out = run([check('TEST-01', ['hit'])], {});
    expect(out.checks[0]).toMatchObject({ status: 'skipped', reason: 'not-run' });
  });
});

describe('mergeDiagnostics', () => {
  it('merges by code and unions affected checks', () => {
    expect(
      mergeDiagnostics([
        { code: 'SCAN-BOTMODE', affects: ['CONSENT-01'] },
        { code: 'SCAN-GEO', affects: [] },
        { code: 'SCAN-BOTMODE', affects: ['CONSENT-04', 'CONSENT-01'] },
      ]),
    ).toEqual([
      {
        code: 'SCAN-BOTMODE',
        affects: ['CONSENT-01', 'CONSENT-04'],
        evidenceIds: [],
        messageId: 'diagnostic.SCAN-BOTMODE',
      },
      { code: 'SCAN-GEO', affects: [], evidenceIds: [], messageId: 'diagnostic.SCAN-GEO' },
    ]);
  });
});

describe('legal note of a finding', () => {
  const note = (status: LegalNote['status']): LegalNote => ({
    text: 'Norm.',
    status,
    reviewedAt: null,
    reviewBy: null,
    draft: true,
  });
  const texts = (keys: string[]): Texts => ({
    lang: 'de',
    messages: {},
    legalNotes: Object.fromEntries(keys.map((k) => [k, note('contested')])),
    ui: {},
    actions: {},
  });

  it('the note of the variant wins over the one of its group and of the check', () => {
    const t = texts(['TEST-01', 'TEST-01.group', 'TEST-01.hit']);
    expect(legalNoteIdFor('TEST-01', 'hit', 'group', t)).toBe('TEST-01.hit');
    expect(legalNoteIdFor('TEST-01', 'soft', 'group', t)).toBe('TEST-01.group');
    expect(legalNoteIdFor('TEST-01', 'soft', 'other', t)).toBe('TEST-01');
  });

  it('without texts or a variant note the check note is used', () => {
    expect(legalNoteIdFor('TEST-01', 'hit', 'hit', undefined)).toBe('TEST-01');
    expect(legalNoteIdFor('TEST-01', 'hit', 'hit', texts(['TEST-01']))).toBe('TEST-01');
  });

  it('findings carry the resolved id', () => {
    const c = defineCheck({
      id: 'TEST-01',
      module: 'browser',
      requires: ['browser'],
      variants: [
        { variant: 'hit', variantGroup: 'g' },
        { variant: 'soft', variantGroup: 'g' },
      ],
      run: () => [],
    });
    const out = run(
      [c],
      { 'TEST-01': exec([obs({ subject: 'a' }), obs({ variant: 'soft', subject: 'b' })]) },
      [],
      { texts: texts(['TEST-01', 'TEST-01.hit']) },
    );
    expect(out.findings.map((f) => [f.variant, f.legalNoteId])).toEqual([
      ['hit', 'TEST-01.hit'],
      ['soft', 'TEST-01'],
    ]);
  });
});

describe('a youtube-nocookie player and its stored entries over the real checks, ruleset and routing', () => {
  const VIDEOS = `${ORIGIN}/videos`;
  const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/abc123';
  const frame = (frameId: string) =>
    ({ isMainFrame: false, frameId, frameUrl: NOCOOKIE, pageUrl: VIDEOS }) as const;
  /** Two player frames on the video page; one beacon of the first is recorded with the next page. */
  const playerRequests = [
    req('A-1', NOCOOKIE, { ...frame('A-f2'), resourceType: 'document', isNavigation: true }),
    req('A-2', NOCOOKIE, { ...frame('A-f3'), resourceType: 'document', isNavigation: true }),
    req('A-3', 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', { ...frame('A-f2'), resourceType: 'image' }),
    req('A-4', 'https://www.youtube-nocookie.com/youtubei/v1/log_event?alt=json', {
      ...frame('A-f2'),
      pageUrl: START,
      resourceType: 'ping',
    }),
  ];
  const playerStorage = [
    storage('YtIdbMeta', {
      storageType: 'indexedDB',
      origin: 'https://www.youtube-nocookie.com',
      firstParty: false,
      pageUrl: VIDEOS,
    }),
    storage('ytidb::LAST_RESULT_ENTRY_KEY', {
      storageType: 'localStorage',
      origin: 'https://www.youtube-nocookie.com',
      firstParty: false,
      pageUrl: VIDEOS,
    }),
  ];
  const videoSite = (p: Partial<Parameters<typeof phase>[1]>) =>
    site({ phases: [phase('A', { pages: [...defaultPages('A'), page(VIDEOS, 'nav')], ...p })] });

  function assessed(snapshot: ReturnType<typeof site>, checks: AnyCheck[] = [consent01, consent02, embed03]) {
    return assess({
      checks,
      executed: new Map(checks.map((c) => [c.id, runCheck(c, snapshot)])),
      ruleset: loadRuleset(),
      routing: loadRouting(),
      texts: loadTexts('de'),
    });
  }
  const summary = (out: ReturnType<typeof assessed>) =>
    out.findings.map((f) => [f.checkId, f.variant, f.serviceId]).sort();

  it('one CONSENT-02 with its text unchanged and one EMBED-03 on one page, related same-service; CONSENT-01 drops the video', () => {
    const snapshot = videoSite({ requests: playerRequests, storage: playerStorage });
    const out = assessed(snapshot);
    expect(summary(out)).toEqual([
      ['CONSENT-02', 'unknown-third-party-persistent', 'youtube-nocookie'],
      ['EMBED-03', 'video-loaded', 'youtube-nocookie'],
    ]);

    const embed = out.findings.find((f) => f.checkId === 'EMBED-03')!;
    const stored = out.findings.find((f) => f.checkId === 'CONSENT-02')!;
    expect(embed).toMatchObject({ severity: 'warning', crmCode: 'T1_MAPS_BEFORE_CONSENT', pages: [VIDEOS] });
    expect(embed.params).toMatchObject({ pageCount: 1, integrationType: 'iframe', requestCount: 4 });
    expect(embed.related).toEqual([
      { checkId: 'CONSENT-02', fingerprint: stored.fingerprint, relation: 'same-service' },
    ]);
    expect(stored.related).toEqual([
      { checkId: 'EMBED-03', fingerprint: embed.fingerprint, relation: 'same-service' },
    ]);
    // The stored entries are reported as before: same finding text with or without the new check.
    const without = assessed(snapshot, [consent01, consent02]).findings.find(
      (f) => f.checkId === 'CONSENT-02',
    );
    expect(stored.text).toEqual(without?.text);
    expect(stored.params).toEqual(without?.params);
  });

  it('counterexample: the stored entries without a load give CONSENT-02 only', () => {
    expect(summary(assessed(videoSite({ storage: playerStorage })))).toEqual([
      ['CONSENT-02', 'unknown-third-party-persistent', 'youtube-nocookie'],
    ]);
  });

  it('counterexample: a load without stored entries gives EMBED-03 only', () => {
    expect(summary(assessed(videoSite({ requests: playerRequests })))).toEqual([
      ['EMBED-03', 'video-loaded', 'youtube-nocookie'],
    ]);
  });
});
