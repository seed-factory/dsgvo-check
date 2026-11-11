import { describe, expect, it } from 'vitest';
import { configFields } from '../../../../src/core/config/fields.ts';
import { resolveConfig } from '../../../../src/core/config/load.ts';
import { envName } from '../../../../src/core/config/names.ts';
import { reasonOf } from '../../../../src/core/config/problems.ts';
import { ConfigSchema, DEFAULT_CONFIG } from '../../../../src/core/config/schema.ts';
import { checkThresholds } from '../../../../src/core/config/thresholds.ts';

describe('built-in defaults', () => {
  // The values the scanner had as constants before the settings existed: a scan without configuration is unchanged.
  const LEGACY: ReadonlyArray<[string, string, unknown]> = [
    ['scan', 'failOn', 'critical'],
    ['scan', 'maxPages', 6],
    ['scan', 'timeoutMs', 480_000],
    ['scan', 'proxy', null],
    ['scan', 'abortGraceMs', 10_000],
    ['scan', 'reportWriteReserveMs', 30_000],
    ['scan', 'maxTargets', 20],
    ['scan', 'tlsFallback', 'http-redirect'],
    ['browser', 'sandbox', 'require'],
    ['browser', 'launchTimeoutMs', 60_000],
    ['browser', 'navigationPauseMs', 1_500],
    ['browser', 'navigationTimeoutMs', 30_000],
    ['browser', 'loadTimeoutMs', 15_000],
    ['browser', 'retryDelayMs', 3_000],
    ['browser', 'deadlineReserveMs', 20_000],
    ['browser', 'cmpCallTimeoutMs', 15_000],
    ['browser', 'quietWindowMs', 2_000],
    ['browser', 'maxInflight', 1],
    ['browser', 'phaseAMinDwellMs', 6_000],
    ['browser', 'phaseAHardCapMs', 20_000],
    ['browser', 'phaseBMinDwellMs', 4_000],
    ['browser', 'phaseBHardCapMs', 12_000],
    ['browser', 'phaseCMinDwellMs', 4_000],
    ['browser', 'phaseCHardCapMs', 12_000],
    ['browser', 'requestLimit', 4_000],
    ['browser', 'screenshotMaxBytes', 200 * 1024],
    ['browser', 'screenshotMaxViewportShare', 0.5],
    ['browser', 'sourceFetchTimeoutMs', 8_000],
    ['browser', 'responseMetaTimeoutMs', 5_000],
    ['browser', 'storageReadTimeoutMs', 1_000],
    // A cookie that expires within a day is short-lived, like a session cookie.
    ['browser', 'persistentCookieMinDays', 1],
    ['browser', 'maxControlPages', 2],
    // One further privacy notice per scan (a notice for course participants beside the policy).
    ['browser', 'maxSupplementaryPolicies', 1],
    // Content below the first screen is shown for up to 3 s per page in a viewport of at most 10 000 px.
    ['browser', 'revealDwellMs', 3_000],
    ['browser', 'revealMaxHeightPx', 10_000],
    ['http', 'minIntervalMs', 500],
    ['http', 'connectTimeoutMs', 5_000],
    ['http', 'headersTimeoutMs', 10_000],
    ['http', 'bodyTimeoutMs', 10_000],
    ['http', 'requestTimeoutMs', 20_000],
    ['http', 'maxRedirects', 5],
    // Forms over http on further pages: the http:// addresses of at most 3 pages with a form, from its first version.
    ['http', 'formTwinPages', 3],
    ['tls', 'timeoutMs', 10_000],
    ['tls', 'shortLivedDays', 10],
    ['tls', 'expiringDays', 14],
    ['tls', 'expiringLifetimeShare', 0.25],
    ['tls', 'approachingDays', 30],
    ['tls', 'approachingLifetimeShare', 0.5],
    ['dns', 'servers', []],
    ['dns', 'timeoutMs', 3_000],
    ['dns', 'retries', 1],
    ['dns', 'queryBudget', 60],
    ['dns', 'concurrency', 4],
    ['dns', 'maxTimeoutResults', 3],
    // Further mail domains (Impressum addresses, the site after a redirect): settings from their first version.
    ['dns', 'maxMailDomains', 2],
    ['dns', 'mailDomainQueryBudget', 30],
    // DKIM (MAIL-03): settings from their first version; 1024 bits is the minimum of RFC 8301.
    ['dns', 'dkimSelectors', []],
    ['dns', 'dkimMaxSelectors', 8],
    ['dns', 'dkimMinRsaBits', 1_024],
    ['cmp', 'blockingCoveredRatio', 0.85],
    ['cmp', 'waitMs', 5_000],
    ['cmp', 'minCandidatePages', 2],
    // Thresholds of the Impressum details and of repeated policy contradictions: settings from their first version.
    ['legal', 'impressumMinGroups', 3],
    ['legal', 'policyClaimMinContexts', 2],
    ['report', 'formats', ['console', 'json']],
    ['report', 'profiles', ['developer']],
    ['report', 'outDir', './dsgvo-check-report'],
    ['report', 'lang', 'de'],
    ['report', 'summaryMaxFindings', 50],
    ['report', 'summaryMaxBytes', 512 * 1024],
    ['report', 'screenshotEmbedMaxBytes', 2 * 1024 * 1024],
    ['report', 'maxEvidencePerFinding', 20],
    ['pdf', 'timeoutMs', 15_000],
  ];

  it('matches the defaults of every setting', () => {
    const expected: Record<string, Record<string, unknown>> = {};
    for (const [section, key, value] of LEGACY) {
      expected[section] ??= {};
      expected[section][key] = value;
    }
    expect(DEFAULT_CONFIG).toEqual(expected);
  });

  it('every setting is covered by the table above', () => {
    const listed = LEGACY.map(([section, key]) => `${section}.${key}`).sort();
    expect(
      configFields()
        .map((f) => `${f.section}.${f.key}`)
        .sort(),
    ).toEqual(listed);
  });

  it('an empty input gives the defaults, section by section', () => {
    expect(ConfigSchema.parse({})).toEqual(DEFAULT_CONFIG);
    expect(ConfigSchema.parse({ browser: {} })).toEqual(DEFAULT_CONFIG);
  });
});

describe('field list', () => {
  const fields = configFields();

  it('gives every setting a unique variable name of the form DSGVO_CHECK_<SECTION>_<NAME>', () => {
    const names = fields.map((f) => f.env);
    expect(new Set(names).size).toBe(names.length);
    for (const f of fields) {
      if (f.env === 'DSGVO_CHECK_PROXY') continue;
      expect(f.env.startsWith(`DSGVO_CHECK_${f.section.toUpperCase()}_`), f.env).toBe(true);
      expect(f.env).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('keeps the documented name of the proxy setting', () => {
    expect(envName('scan', 'proxy')).toBe('DSGVO_CHECK_PROXY');
  });

  it.each([
    ['scan', 'timeoutMs', 'DSGVO_CHECK_SCAN_TIMEOUT_MS'],
    ['browser', 'phaseAMinDwellMs', 'DSGVO_CHECK_BROWSER_PHASE_A_MIN_DWELL_MS'],
    ['browser', 'screenshotMaxViewportShare', 'DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE'],
    ['report', 'outDir', 'DSGVO_CHECK_REPORT_OUT_DIR'],
    ['tls', 'approachingLifetimeShare', 'DSGVO_CHECK_TLS_APPROACHING_LIFETIME_SHARE'],
  ])('%s.%s is %s', (section, key, name) => {
    expect(envName(section, key)).toBe(name);
  });

  // A bare number in a variable must never leave the unit open.
  const COUNTS = new Set([
    'maxPages',
    'maxControlPages',
    'maxSupplementaryPolicies',
    'minCandidatePages',
    'maxInflight',
    'requestLimit',
    'maxRedirects',
    'formTwinPages',
    'retries',
    'queryBudget',
    'concurrency',
    'maxTimeoutResults',
    'maxMailDomains',
    'mailDomainQueryBudget',
    'summaryMaxFindings',
    'maxEvidencePerFinding',
    'impressumMinGroups',
    'policyClaimMinContexts',
    'dkimMaxSelectors',
    'maxTargets',
  ]);
  it('names the unit of every number: _MS, _BYTES, _DAYS, _PX, _BITS, a count or a share', () => {
    for (const f of fields.filter((x) => x.kind === 'int' || x.kind === 'number')) {
      const ok = /(Ms|Bytes|Days|Px|Bits|Share|Ratio)$/.test(f.key) || COUNTS.has(f.key);
      expect(ok, `${f.section}.${f.key}`).toBe(true);
    }
  });
});

describe('validation', () => {
  const bad = (input: unknown) => {
    const r = ConfigSchema.safeParse(input);
    return r.success ? null : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };
  /** What a refused input is reported as: the setting, the id of the text and its parameters. */
  const reasons = (input: unknown) => {
    const r = ConfigSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), ...reasonOf(i) }));
  };

  // The built-in value of a pause or gap is the floor: the scan may be made more polite, never less (AGENTS.md rule 1).
  it.each([
    ['browser', 'navigationPauseMs', 1_500],
    ['browser', 'retryDelayMs', 3_000],
    ['http', 'minIntervalMs', 500],
  ])('%s.%s may only be raised above its built-in value %d', (section, key, floor) => {
    expect(reasons({ [section]: { [key]: floor - 1 } })).toEqual([
      { path: `${section}.${key}`, id: 'floor', params: { min: floor } },
    ]);
    expect(bad({ [section]: { [key]: floor } })).toBeNull();
    expect(bad({ [section]: { [key]: floor * 4 } })).toBeNull();
    expect(bad({ [section]: { [key]: 0 } })).not.toBeNull();
  });

  it('keeps the floors in step with the defaults', () => {
    for (const [section, key] of [
      ['browser', 'navigationPauseMs'],
      ['browser', 'retryDelayMs'],
      ['http', 'minIntervalMs'],
    ] as const) {
      const field = configFields().find((f) => f.section === section && f.key === key);
      expect(field?.bounds?.min, `${section}.${key}`).toBe(field?.default);
    }
  });

  it.each([
    [{ scan: { maxPages: 0 } }],
    [{ scan: { maxPages: 51 } }],
    [{ scan: { timeoutMs: 0 } }],
    [{ scan: { maxTargets: 0 } }],
    [{ scan: { maxTargets: 101 } }],
    [{ report: { profiles: [] } }],
    [{ report: { profiles: ['brief'] } }],
    [{ scan: { failOn: 'error' } }],
    [{ scan: { proxy: 'https://proxy.example:3128' } }],
    [{ scan: { proxy: 'socks5://proxy.example' } }],
    [{ scan: { abortGraceMs: 5_000 } }],
    [{ browser: { sandbox: 'maybe' } }],
    [{ browser: { maxInflight: -1 } }],
    [{ browser: { requestLimit: 99 } }],
    [{ browser: { screenshotMaxBytes: 2_097_153 } }],
    [{ browser: { screenshotMaxViewportShare: 0 } }],
    [{ browser: { screenshotMaxViewportShare: 1.1 } }],
    [{ browser: { navigationTimeoutMs: 1.5 } }],
    [{ browser: { maxSupplementaryPolicies: -1 } }],
    [{ browser: { maxSupplementaryPolicies: 4 } }],
    [{ browser: { maxSupplementaryPolicies: 1.5 } }],
    [{ browser: { revealDwellMs: -1 } }],
    [{ browser: { revealDwellMs: 60_001 } }],
    [{ browser: { revealMaxHeightPx: 999 } }],
    [{ browser: { revealMaxHeightPx: 30_001 } }],
    [{ browser: { revealMaxHeightPx: 1_500.5 } }],
    [{ http: { maxRedirects: 21 } }],
    [{ http: { formTwinPages: -1 } }],
    [{ http: { formTwinPages: 11 } }],
    [{ http: { formTwinPages: 1.5 } }],
    [{ dns: { servers: ['not a host'] } }],
    [{ dns: { queryBudget: 201 } }],
    [{ dns: { concurrency: 17 } }],
    [{ dns: { maxMailDomains: 6 } }],
    [{ dns: { mailDomainQueryBudget: 0 } }],
    [{ cmp: { blockingCoveredRatio: 0 } }],
    [{ legal: { impressumMinGroups: 1 } }],
    [{ legal: { impressumMinGroups: 6 } }],
    [{ legal: { impressumMinGroups: 2.5 } }],
    [{ legal: { policyClaimMinContexts: 1 } }],
    [{ legal: { policyClaimMinContexts: 21 } }],
    [{ legal: { unknown: 1 } }],
    [{ report: { formats: [] } }],
    [{ report: { formats: ['xml'] } }],
    [{ report: { lang: 'fr' } }],
    [{ report: { outDir: '' } }],
    [{ pdf: { timeoutMs: 999 } }],
    [{ unknown: {} }],
    [{ browser: { unknown: 1 } }],
  ])('rejects %j', (input) => {
    expect(bad(input)).not.toBeNull();
  });

  it('reads the target limit and the report profiles from their variables', () => {
    expect(envName('scan', 'maxTargets')).toBe('DSGVO_CHECK_SCAN_MAX_TARGETS');
    expect(envName('report', 'profiles')).toBe('DSGVO_CHECK_REPORT_PROFILES');
    const { config } = resolveConfig({
      env: { DSGVO_CHECK_SCAN_MAX_TARGETS: '100', DSGVO_CHECK_REPORT_PROFILES: 'owner,developer' },
    });
    expect(config.scan.maxTargets).toBe(100);
    expect(config.report.profiles).toEqual(['owner', 'developer']);
    expect(ConfigSchema.parse({ scan: { maxTargets: 1 } }).scan.maxTargets).toBe(1);
  });

  it('accepts the legal thresholds at their bounds and hands them to the checks', () => {
    for (const [impressumMinGroups, policyClaimMinContexts] of [
      [2, 2],
      [5, 20],
    ] as const) {
      const config = ConfigSchema.parse({ legal: { impressumMinGroups, policyClaimMinContexts } });
      expect(checkThresholds(config).legal).toEqual({ impressumMinGroups, policyClaimMinContexts });
    }
    expect(checkThresholds(DEFAULT_CONFIG).legal).toEqual({
      impressumMinGroups: 3,
      policyClaimMinContexts: 2,
    });
  });

  it('reads the legal thresholds from their variables', () => {
    expect(envName('legal', 'impressumMinGroups')).toBe('DSGVO_CHECK_LEGAL_IMPRESSUM_MIN_GROUPS');
    expect(envName('legal', 'policyClaimMinContexts')).toBe('DSGVO_CHECK_LEGAL_POLICY_CLAIM_MIN_CONTEXTS');
    const { config } = resolveConfig({
      env: { DSGVO_CHECK_LEGAL_IMPRESSUM_MIN_GROUPS: '4', DSGVO_CHECK_LEGAL_POLICY_CLAIM_MIN_CONTEXTS: '5' },
    });
    expect(config.legal).toEqual({ impressumMinGroups: 4, policyClaimMinContexts: 5 });
  });

  it('accepts 0 to 3 further privacy notices and reads them from their variable', () => {
    for (const maxSupplementaryPolicies of [0, 3]) {
      expect(
        ConfigSchema.parse({ browser: { maxSupplementaryPolicies } }).browser.maxSupplementaryPolicies,
      ).toBe(maxSupplementaryPolicies);
    }
    expect(envName('browser', 'maxSupplementaryPolicies')).toBe(
      'DSGVO_CHECK_BROWSER_MAX_SUPPLEMENTARY_POLICIES',
    );
    const { config } = resolveConfig({ env: { DSGVO_CHECK_BROWSER_MAX_SUPPLEMENTARY_POLICIES: '0' } });
    expect(config.browser.maxSupplementaryPolicies).toBe(0);
  });

  it('accepts the content below the first screen switched off or at its bounds, read from its variables', () => {
    for (const [revealDwellMs, revealMaxHeightPx] of [
      [0, 1_000],
      [60_000, 30_000],
    ] as const) {
      expect(ConfigSchema.parse({ browser: { revealDwellMs, revealMaxHeightPx } }).browser).toMatchObject({
        revealDwellMs,
        revealMaxHeightPx,
      });
    }
    expect(envName('browser', 'revealDwellMs')).toBe('DSGVO_CHECK_BROWSER_REVEAL_DWELL_MS');
    expect(envName('browser', 'revealMaxHeightPx')).toBe('DSGVO_CHECK_BROWSER_REVEAL_MAX_HEIGHT_PX');
    const { config } = resolveConfig({
      env: { DSGVO_CHECK_BROWSER_REVEAL_DWELL_MS: '0', DSGVO_CHECK_BROWSER_REVEAL_MAX_HEIGHT_PX: '4000' },
    });
    expect(config.browser).toMatchObject({ revealDwellMs: 0, revealMaxHeightPx: 4_000 });
  });

  it('passes the minimum DKIM RSA length to the checks; it can be raised but not lowered below RFC 8301', () => {
    expect(checkThresholds(DEFAULT_CONFIG).dns).toEqual({ dkimMinRsaBits: 1_024 });
    expect(checkThresholds(ConfigSchema.parse({ dns: { dkimMinRsaBits: 2_048 } })).dns).toEqual({
      dkimMinRsaBits: 2_048,
    });
    expect(ConfigSchema.safeParse({ dns: { dkimMinRsaBits: 1_023 } }).success).toBe(false);
    const { config } = resolveConfig({ env: { DSGVO_CHECK_DNS_DKIM_MIN_RSA_BITS: '4096' } });
    expect(config.dns.dkimMinRsaBits).toBe(4_096);
  });

  it('reads DKIM selectors as a list of selector or domain/selector', () => {
    const { config } = resolveConfig({
      env: { DSGVO_CHECK_DNS_DKIM_SELECTORS: 'selector1, example.de/s2024.mail,k_1' },
    });
    expect(config.dns.dkimSelectors).toEqual(['selector1', 'example.de/s2024.mail', 'k_1']);
    for (const bad of [
      'a b',
      'example.de/',
      '/s1',
      '.s1',
      's1._domainkey.example.de/x',
      'example/s1',
      'selector1._domainkey.example.de',
      'example.de/selector1._domainkey',
    ]) {
      expect(ConfigSchema.safeParse({ dns: { dkimSelectors: [bad] } }).success, bad).toBe(false);
    }
  });

  it('accepts DNS servers as host, host:port and bracketed IPv6', () => {
    const c = ConfigSchema.parse({
      dns: { servers: ['1.1.1.1', '9.9.9.9:5353', '[2606:4700::1111]:53', 'ns.example'] },
    });
    expect(c.dns.servers).toHaveLength(4);
  });

  it('keeps the dwell windows consistent', () => {
    expect(reasons({ browser: { phaseAMinDwellMs: 30_000 } })).toEqual([
      {
        path: 'browser.phaseAHardCapMs',
        id: 'dwell-order',
        params: { other: 'DSGVO_CHECK_BROWSER_PHASE_A_MIN_DWELL_MS', value: 30_000 },
      },
    ]);
    expect(bad({ browser: { phaseBMinDwellMs: 5_000, phaseBHardCapMs: 4_000 } })).not.toBeNull();
    expect(bad({ browser: { phaseCHardCapMs: 3_000 } })).not.toBeNull();
    expect(bad({ browser: { phaseAMinDwellMs: 10_000, phaseAHardCapMs: 10_000 } })).toBeNull();
  });

  it('keeps the certificate windows nested', () => {
    expect(reasons({ tls: { expiringDays: 31 } })).toEqual([
      {
        path: 'tls.expiringDays',
        id: 'tls-days-order',
        params: { other: 'DSGVO_CHECK_TLS_APPROACHING_DAYS', value: 30 },
      },
    ]);
    expect(reasons({ tls: { expiringLifetimeShare: 0.6 } })).toEqual([
      {
        path: 'tls.expiringLifetimeShare',
        id: 'tls-share-order',
        params: { other: 'DSGVO_CHECK_TLS_APPROACHING_LIFETIME_SHARE', value: 0.5 },
      },
    ]);
    expect(bad({ tls: { expiringDays: 30, approachingDays: 30 } })).toBeNull();
  });

  // zod stops the checks across fields when a field has the wrong type (settings from the environment are coerced
  // first, so they never do); a value outside its range does not stop them.
  it('runs the checks across fields whenever every field has its type', () => {
    const crossed = {
      browser: { phaseBMinDwellMs: 9_000, phaseBHardCapMs: 5_000 },
      tls: { expiringDays: 40 },
      scan: { reportWriteReserveMs: 1 },
    };
    const ids = (input: unknown) => reasons(input).map((r) => r.id);
    expect(ids(crossed)).toEqual(['dwell-order', 'tls-days-order', 'report-reserve']);
    expect(ids({ ...crossed, scan: { reportWriteReserveMs: 1, maxPages: 0 } })).toEqual([
      'min',
      'dwell-order',
      'tls-days-order',
      'report-reserve',
    ]);
    expect(ids({ ...crossed, scan: { reportWriteReserveMs: 1, maxPages: 'x' } })).toEqual(['type']);
  });

  it('keeps the report reserve above the abort grace plus the PDF time limit', () => {
    expect(reasons({ scan: { reportWriteReserveMs: 24_999 } })).toEqual([
      {
        path: 'scan.reportWriteReserveMs',
        id: 'report-reserve',
        params: {
          first: 'DSGVO_CHECK_SCAN_ABORT_GRACE_MS',
          second: 'DSGVO_CHECK_PDF_TIMEOUT_MS',
          value: 25_000,
        },
      },
    ]);
    expect(bad({ scan: { reportWriteReserveMs: 25_000 } })).toBeNull();
    expect(bad({ pdf: { timeoutMs: 30_000 } })).not.toBeNull();
    expect(bad({ pdf: { timeoutMs: 30_000 }, scan: { reportWriteReserveMs: 40_000 } })).toBeNull();
  });
});
