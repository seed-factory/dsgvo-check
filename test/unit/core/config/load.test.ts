import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnvFile } from '../../../../src/core/config/dotenv.ts';
import {
  ConfigError,
  describeProblems,
  loadConfig,
  parseConfigInput,
  resolveConfig,
} from '../../../../src/core/config/load.ts';
import { configOverrides } from '../../../../src/core/config/overrides.ts';
import { DEFAULT_CONFIG } from '../../../../src/core/config/schema.ts';

const file = (values: Record<string, string>) => ({ path: '/work/.env', values });

describe('resolveConfig: sources and precedence', () => {
  it('without any variable the result is the defaults', () => {
    const loaded = resolveConfig({ env: {} });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.file).toBeNull();
    expect(loaded.fromFile).toEqual([]);
    expect(loaded.set).toEqual([]);
    expect(loaded.unknown).toEqual([]);
  });

  it('environment beats the .env file beats the default', () => {
    const loaded = resolveConfig({
      env: { DSGVO_CHECK_SCAN_MAX_PAGES: '3' },
      file: file({ DSGVO_CHECK_SCAN_MAX_PAGES: '9', DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: '2500' }),
    });
    expect(loaded.config.scan.maxPages).toBe(3);
    expect(loaded.config.browser.quietWindowMs).toBe(2_500);
    expect(loaded.config.browser.loadTimeoutMs).toBe(15_000);
    expect(loaded.file).toBe('/work/.env');
    // only what the file actually decided
    expect(loaded.fromFile).toEqual(['DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS']);
    expect(loaded.set).toEqual(['DSGVO_CHECK_SCAN_MAX_PAGES', 'DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS']);
  });

  it('an empty value counts as unset, in the environment and in the file', () => {
    const loaded = resolveConfig({
      env: { DSGVO_CHECK_SCAN_MAX_PAGES: '  ', DSGVO_CHECK_HTTP_MAX_REDIRECTS: '' },
      file: file({ DSGVO_CHECK_SCAN_MAX_PAGES: '4', DSGVO_CHECK_PROXY: '' }),
    });
    expect(loaded.config.scan.maxPages).toBe(4);
    expect(loaded.config.http.maxRedirects).toBe(5);
    expect(loaded.config.scan.proxy).toBeNull();
  });

  it('ignores variables of other tools in the file and the environment', () => {
    const loaded = resolveConfig({
      env: {
        PATH: '/bin',
        HTTP_PROXY: 'http://proxy',
        DSGVO_CHECK_CONTAINER: '1',
        DSGVO_CHECK_TEST_SANDBOX: 'require',
      },
      file: file({
        DATABASE_URL: 'postgres://x',
        NODE_OPTIONS: '--inspect',
        DSGVO_CHECK_IMAGE: 'x',
        DSGVO_CHECK_OUT: 'o',
      }),
    });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.unknown).toEqual([]);
  });

  it('names variables of a known section that match no setting', () => {
    const loaded = resolveConfig({
      env: { DSGVO_CHECK_BROWSER_NAVIGATION_PAUS_MS: '2000' },
      file: file({ DSGVO_CHECK_HTTP_RETRIES: '1' }),
    });
    expect(loaded.unknown).toEqual(['DSGVO_CHECK_BROWSER_NAVIGATION_PAUS_MS', 'DSGVO_CHECK_HTTP_RETRIES']);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });
});

describe('resolveConfig: values', () => {
  it.each([
    ['DSGVO_CHECK_SCAN_FAIL_ON', 'warning', (c: typeof DEFAULT_CONFIG) => c.scan.failOn, 'warning'],
    ['DSGVO_CHECK_SCAN_TIMEOUT_MS', '90000', (c: typeof DEFAULT_CONFIG) => c.scan.timeoutMs, 90_000],
    [
      'DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE',
      '0.4',
      (c: typeof DEFAULT_CONFIG) => c.browser.screenshotMaxViewportShare,
      0.4,
    ],
    [
      'DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS',
      ' 2000 ',
      (c: typeof DEFAULT_CONFIG) => c.browser.navigationPauseMs,
      2_000,
    ],
    [
      'DSGVO_CHECK_CMP_BLOCKING_COVERED_RATIO',
      '1',
      (c: typeof DEFAULT_CONFIG) => c.cmp.blockingCoveredRatio,
      1,
    ],
    [
      'DSGVO_CHECK_REPORT_FORMATS',
      'console, json ,html,',
      (c: typeof DEFAULT_CONFIG) => c.report.formats,
      ['console', 'json', 'html'],
    ],
    [
      'DSGVO_CHECK_DNS_SERVERS',
      '1.1.1.1, 9.9.9.9:5353',
      (c: typeof DEFAULT_CONFIG) => c.dns.servers,
      ['1.1.1.1', '9.9.9.9:5353'],
    ],
    [
      'DSGVO_CHECK_PROXY',
      'http://user:secret@proxy.example:3128',
      (c: typeof DEFAULT_CONFIG) => c.scan.proxy,
      'http://user:secret@proxy.example:3128',
    ],
  ])('%s=%s', (name, value, pick, expected) => {
    expect(pick(resolveConfig({ env: { [name]: value } }).config)).toEqual(expected);
  });

  const problems = (env: Record<string, string>, f?: Record<string, string>) => {
    try {
      resolveConfig({ env, ...(f ? { file: file(f) } : {}) });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).problems;
    }
    return [];
  };

  it.each([
    ['DSGVO_CHECK_SCAN_MAX_PAGES', 'many', 'integer', {}],
    ['DSGVO_CHECK_SCAN_MAX_PAGES', '2.5', 'integer', {}],
    ['DSGVO_CHECK_SCAN_MAX_PAGES', '51', 'max', { max: 50 }],
    ['DSGVO_CHECK_SCAN_MAX_PAGES', '0', 'min', { min: 1 }],
    ['DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE', 'half', 'number', {}],
    ['DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE', '1.5', 'max', { max: 1 }],
    ['DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE', '0', 'above', { min: 0 }],
    ['DSGVO_CHECK_SCAN_FAIL_ON', 'error', 'option', { options: expect.stringContaining('critical') }],
    ['DSGVO_CHECK_REPORT_FORMATS', 'xml', 'option', { options: expect.stringContaining('console') }],
    ['DSGVO_CHECK_DNS_SERVERS', 'a b', 'dns-server', {}],
    ['DSGVO_CHECK_PROXY', 'https://proxy.example', 'proxy-scheme', {}],
  ])('%s=%s is refused as %s', (name, value, id, params) => {
    const [first, ...rest] = problems({ [name]: value });
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      variable: name,
      value: name === 'DSGVO_CHECK_PROXY' ? null : value,
      source: 'environment',
      reason: { id, params },
    });
  });

  it('reports every problem at once, with the source of each', () => {
    const list = problems(
      { DSGVO_CHECK_SCAN_MAX_PAGES: 'x' },
      { DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS: '1000' },
    );
    expect(list.map((p) => [p.variable, p.source])).toEqual([
      ['DSGVO_CHECK_SCAN_MAX_PAGES', 'environment'],
      ['DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS', { file: '/work/.env' }],
    ]);
  });

  it.each([
    ['DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS', '1000', 1_500],
    ['DSGVO_CHECK_HTTP_MIN_INTERVAL_MS', '100', 500],
    ['DSGVO_CHECK_BROWSER_RETRY_DELAY_MS', '0', 3_000],
    ['DSGVO_CHECK_BROWSER_RETRY_DELAY_MS', '2999', 3_000],
  ])('%s=%s weakens a passive limit: refused with the built-in value as floor', (name, value, min) => {
    const [p, ...rest] = problems({ [name]: value });
    expect(rest).toEqual([]);
    expect(p?.reason).toEqual({ id: 'floor', params: { min } });
  });

  it('accepts the passive limits as they are and any stricter value', () => {
    const config = resolveConfig({
      env: {
        DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS: '1500',
        DSGVO_CHECK_HTTP_MIN_INTERVAL_MS: '500',
        DSGVO_CHECK_BROWSER_RETRY_DELAY_MS: '3000',
      },
    }).config;
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(
      resolveConfig({ env: { DSGVO_CHECK_BROWSER_RETRY_DELAY_MS: '10000' } }).config.browser.retryDelayMs,
    ).toBe(10_000);
  });

  it('blames the setting that is wrong when two settings clash, and shows the default it kept', () => {
    const [p] = problems({ DSGVO_CHECK_BROWSER_PHASE_A_MIN_DWELL_MS: '30000' });
    expect(p).toMatchObject({
      variable: 'DSGVO_CHECK_BROWSER_PHASE_A_HARD_CAP_MS',
      value: '20000',
      source: 'default',
      reason: {
        id: 'dwell-order',
        params: { other: 'DSGVO_CHECK_BROWSER_PHASE_A_MIN_DWELL_MS', value: 30_000 },
      },
    });
  });

  it('never shows the value of a secret setting', () => {
    const [p] = problems({ DSGVO_CHECK_PROXY: 'https://user:secret@proxy.example' });
    expect(p).toMatchObject({ variable: 'DSGVO_CHECK_PROXY', value: null });
    try {
      resolveConfig({ env: { DSGVO_CHECK_PROXY: 'https://user:secret@proxy.example' } });
    } catch (err) {
      expect((err as Error).message).not.toContain('secret');
      expect(describeProblems((err as ConfigError).problems, 'en')).not.toContain('secret');
    }
  });
});

describe('.env files', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'dsgvo-env-'));

  it('reads values without touching process.env', () => {
    const d = dir();
    const f = path.join(d, '.env');
    writeFileSync(f, 'DSGVO_CHECK_TEST_ENV_FILE_PROBE=1\n# comment\nFOO="a b"\n');
    const before = { ...process.env };
    expect(readEnvFile(f)).toEqual({ path: f, values: { DSGVO_CHECK_TEST_ENV_FILE_PROBE: '1', FOO: 'a b' } });
    expect(process.env.DSGVO_CHECK_TEST_ENV_FILE_PROBE).toBeUndefined();
    expect(process.env.FOO).toBe(before.FOO);
  });

  it('a missing file is no error; a directory named .env is', () => {
    const d = dir();
    expect(readEnvFile(path.join(d, '.env'))).toBeNull();
    mkdirSync(path.join(d, '.env'));
    expect(() => readEnvFile(path.join(d, '.env'))).toThrow(/cannot read .*\.env: EISDIR/);
    // loadConfig turns it into a problem with the code of the system error, worded like any other
    try {
      loadConfig({ cwd: d, env: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toEqual([
        {
          variable: '.env',
          value: null,
          source: { file: path.join(d, '.env') },
          reason: { id: 'unreadable', params: { code: 'EISDIR' } },
        },
      ]);
    }
  });

  it('loadConfig reads .env of the given directory and lets the environment win', () => {
    const d = dir();
    writeFileSync(
      path.join(d, '.env'),
      'DSGVO_CHECK_SCAN_MAX_PAGES=2\nDSGVO_CHECK_HTTP_MAX_REDIRECTS=3\nDSGVO_CHECK_DNS_SERVERS=1.1.1.1\n',
    );
    const loaded = loadConfig({ cwd: d, env: { DSGVO_CHECK_HTTP_MAX_REDIRECTS: '7' } });

    expect(loaded.config.scan.maxPages).toBe(2);
    expect(loaded.config.http.maxRedirects).toBe(7);
    expect(loaded.config.dns.servers).toEqual(['1.1.1.1']);

    expect(loaded.file).toBe(path.join(d, '.env'));
    expect(loaded.fromFile).toEqual(['DSGVO_CHECK_SCAN_MAX_PAGES', 'DSGVO_CHECK_DNS_SERVERS']);
    expect(loaded.set).toEqual([
      'DSGVO_CHECK_SCAN_MAX_PAGES',
      'DSGVO_CHECK_HTTP_MAX_REDIRECTS',
      'DSGVO_CHECK_DNS_SERVERS',
    ]);
  });

  it('loadConfig without a file and with an empty environment gives the defaults', () => {
    expect(loadConfig({ cwd: dir(), env: {} }).config).toEqual(DEFAULT_CONFIG);
  });
});

describe('parseConfigInput', () => {
  it('fills the defaults of a partial object', () => {
    const c = parseConfigInput({ http: { maxRedirects: 2 } });
    expect(c.http.maxRedirects).toBe(2);
    expect(c.http.minIntervalMs).toBe(500);
    expect(parseConfigInput(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it('names the path of an invalid value, with the reason as id and parameters', () => {
    try {
      parseConfigInput({ browser: { navigationPauseMs: 10 } });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toEqual([
        {
          variable: 'browser.navigationPauseMs',
          value: null,
          source: 'config',
          reason: { id: 'floor', params: { min: 1_500 } },
        },
      ]);
    }
  });
});

describe('configOverrides', () => {
  it('lists nothing for the defaults', () => {
    expect(configOverrides(parseConfigInput({}))).toEqual({});
  });

  it('lists the changed settings by variable name, as plain values', () => {
    const c = parseConfigInput({
      browser: { quietWindowMs: 3_000, screenshotMaxViewportShare: 0.4 },
      tls: { expiringDays: 21 },
      dns: { servers: ['1.1.1.1', '9.9.9.9'] },
      http: { maxRedirects: 5 },
    });
    expect(configOverrides(c)).toEqual({
      DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: 3_000,
      DSGVO_CHECK_BROWSER_SCREENSHOT_MAX_VIEWPORT_SHARE: 0.4,
      DSGVO_CHECK_TLS_EXPIRING_DAYS: 21,
      DSGVO_CHECK_DNS_SERVERS: '1.1.1.1,9.9.9.9',
    });
  });

  it('leaves out the proxy and the settings the report shows as options or keeps private', () => {
    const c = parseConfigInput({
      scan: { proxy: 'http://user:secret@proxy.example', failOn: 'none', maxPages: 2, timeoutMs: 60_000 },
      browser: { sandbox: 'off' },
      report: { outDir: '/home/runner/out', formats: ['json'], lang: 'en' },
    });
    expect(configOverrides(c)).toEqual({});
  });
});
