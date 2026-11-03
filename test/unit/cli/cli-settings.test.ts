import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, builtInSettings, loadCliSettings, toScanOptions } from '../../../src/cli.ts';
import { describeProblems } from '../../../src/core/config/load.ts';
import { DEFAULT_CONFIG } from '../../../src/core/config/schema.ts';
import { resolveOptions } from '../../../src/scan-options.ts';

const URL_ARG = 'https://example.test/';

function parse(settings: ReturnType<typeof loadCliSettings>, ...args: string[]) {
  const program = buildProgram(settings).action(() => undefined);
  program.parse([URL_ARG, ...args], { from: 'user' });
  return program;
}

describe('settings from the environment', () => {
  it('without variables the settings are the built-in ones and nothing is noted', () => {
    const s = loadCliSettings({}, mkdtempSync(path.join(tmpdir(), 'dsgvo-cli-')));
    expect(s).toEqual(builtInSettings());
    expect(s.config).toEqual(DEFAULT_CONFIG);
  });

  it('flag defaults follow the settings; a flag beats them', () => {
    const settings = loadCliSettings(
      {
        DSGVO_CHECK_SCAN_FAIL_ON: 'warning',
        DSGVO_CHECK_SCAN_MAX_PAGES: '3',
        DSGVO_CHECK_SCAN_TIMEOUT_MS: '120000',
        DSGVO_CHECK_REPORT_FORMATS: 'json,html',
        DSGVO_CHECK_REPORT_OUT_DIR: 'reports',
        DSGVO_CHECK_REPORT_LANG: 'en',
        DSGVO_CHECK_BROWSER_SANDBOX: 'off',
      },
      tmpdir(),
    );
    expect(parse(settings).opts()).toMatchObject({
      failOn: 'warning',
      maxPages: '3',
      timeout: '2m',
      format: 'json,html',
      out: 'reports',
      lang: 'en',
      sandbox: 'off',
    });
    expect(parse(settings, '--max-pages', '5', '--timeout', '90s', '--fail-on', 'none').opts()).toMatchObject(
      {
        failOn: 'none',
        maxPages: '5',
        timeout: '90s',
      },
    );
  });

  it('the built-in flag defaults are the ones the CLI always had', () => {
    expect(parse(builtInSettings()).opts()).toMatchObject({
      failOn: 'critical',
      format: 'console,json',
      out: './dsgvo-check-report',
      maxPages: '6',
      timeout: '8m',
      lang: 'de',
      sandbox: 'require',
    });
  });

  it('reads .env of the working directory and notes it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-cli-'));
    writeFileSync(
      path.join(dir, '.env'),
      'DSGVO_CHECK_HTTP_MAX_REDIRECTS=2\nDSGVO_CHECK_HTTP_RETRIES=1\nOTHER_TOOL=1\n',
    );
    const s = loadCliSettings({}, dir);
    expect(s.config.http.maxRedirects).toBe(2);
    expect(s.notes).toEqual([
      { key: 'console.configFile', params: { path: path.join(dir, '.env'), count: 1 } },
      { key: 'console.configUnknown', params: { names: 'DSGVO_CHECK_HTTP_RETRIES' } },
    ]);
  });

  it('an invalid value keeps the built-in settings and carries the problems, worded later in the language of the run', () => {
    const s = loadCliSettings(
      { DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS: '500', DSGVO_CHECK_SCAN_MAX_PAGES: 'x' },
      tmpdir(),
    );
    expect(s.config).toEqual(DEFAULT_CONFIG);
    expect(s.explicit.size).toBe(0);
    expect(s.error).toEqual([
      {
        variable: 'DSGVO_CHECK_SCAN_MAX_PAGES',
        value: 'x',
        source: 'environment',
        reason: { id: 'integer', params: {} },
      },
      {
        variable: 'DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS',
        value: '500',
        source: 'environment',
        reason: { id: 'floor', params: { min: 1_500 } },
      },
    ]);
    expect(describeProblems(s.error ?? [], 'en')).toBe(
      'DSGVO_CHECK_SCAN_MAX_PAGES=x (environment): expected an integer; ' +
        'DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS=500 (environment): must be at least 1500: values may only be ' +
        'made stricter, the scan stays passive',
    );
  });

  it('an unreadable .env is a problem too', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-cli-'));
    mkdirSync(path.join(dir, '.env'));
    expect(loadCliSettings({}, dir).error).toEqual([
      {
        variable: '.env',
        value: null,
        source: { file: path.join(dir, '.env') },
        reason: { id: 'unreadable', params: { code: 'EISDIR' } },
      },
    ]);
  });
});

describe('the report command follows the settings', () => {
  /** Options of the `report` subcommand after parsing `args` (the action itself is replaced). */
  async function reportOpts(settings: ReturnType<typeof loadCliSettings>, ...args: string[]) {
    const program = buildProgram(settings);
    const report = program.commands.find((c) => c.name() === 'report');
    report?.action(() => undefined);
    await program.parseAsync(['report', 'input.json', ...args], { from: 'user' });
    return report?.opts();
  }
  const settingsOf = (env: Record<string, string>) => loadCliSettings(env, tmpdir());

  it('without settings it renders html in German, as it always did', async () => {
    expect(await reportOpts(builtInSettings())).toEqual({ format: 'html', lang: 'de' });
  });

  it('DSGVO_CHECK_REPORT_LANG is the default language; the flag beats it', async () => {
    const s = settingsOf({ DSGVO_CHECK_REPORT_LANG: 'en' });
    expect(await reportOpts(s)).toMatchObject({ lang: 'en' });
    expect(await reportOpts(s, '--lang', 'de')).toMatchObject({ lang: 'de' });
  });

  it('DSGVO_CHECK_REPORT_FORMATS is the default format list; the flag beats it', async () => {
    const s = settingsOf({ DSGVO_CHECK_REPORT_FORMATS: 'json,html' });
    expect(await reportOpts(s)).toMatchObject({ format: 'json,html' });
    expect(await reportOpts(s, '--format', 'pdf')).toMatchObject({ format: 'pdf' });
  });

  it('formats named in the settings win even when they equal the scan default', async () => {
    expect(await reportOpts(settingsOf({ DSGVO_CHECK_REPORT_FORMATS: 'console,json' }))).toMatchObject({
      format: 'console,json',
    });
  });

  it('other report settings leave html as the default: the scan default is console and json', async () => {
    const s = settingsOf({ DSGVO_CHECK_REPORT_LANG: 'en', DSGVO_CHECK_REPORT_OUT_DIR: 'reports' });
    expect(await reportOpts(s)).toEqual({ format: 'html', lang: 'en' });
  });

  it('the environment beats .env for the language and the formats', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-cli-'));
    writeFileSync(
      path.join(dir, '.env'),
      'DSGVO_CHECK_REPORT_LANG=en\nDSGVO_CHECK_REPORT_FORMATS=html,pdf\n',
    );
    expect(await reportOpts(loadCliSettings({}, dir))).toEqual({ format: 'html,pdf', lang: 'en' });
    expect(
      await reportOpts(
        loadCliSettings({ DSGVO_CHECK_REPORT_LANG: 'de', DSGVO_CHECK_REPORT_FORMATS: 'json' }, dir),
      ),
    ).toEqual({ format: 'json', lang: 'de' });
  });
});

describe('the proxy of the settings', () => {
  const settings = () =>
    loadCliSettings({ DSGVO_CHECK_PROXY: 'http://user:secret@proxy.example:3128' }, tmpdir());

  it('is no flag default and so never printed in --help', () => {
    const help = buildProgram(settings()).helpInformation();
    expect(help).not.toContain('secret');
    expect(help).not.toContain('proxy.example');
  });

  it('applies when the flag is absent and loses to the flag', () => {
    const s = settings();
    const program = parse(s);
    const opts = toScanOptions(URL_ARG, program.opts(), s.config);
    expect('proxy' in opts).toBe(false);
    expect(resolveOptions(opts).proxy).toBe('http://user:secret@proxy.example:3128');
    const flagged = toScanOptions(URL_ARG, parse(s, '--proxy', 'http://other.example:8080').opts(), s.config);
    expect(resolveOptions(flagged).proxy).toBe('http://other.example:8080');
  });

  it('without settings and flag there is no proxy, as before', () => {
    const opts = toScanOptions(URL_ARG, parse(builtInSettings()).opts());
    expect(resolveOptions(opts).proxy).toBeNull();
  });
});

describe('resolved options carry the settings', () => {
  it('config rides along, flag values win for the settings they name', () => {
    const s = loadCliSettings(
      { DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: '3000', DSGVO_CHECK_DNS_SERVERS: '1.1.1.1' },
      tmpdir(),
    );
    const resolved = resolveOptions(toScanOptions(URL_ARG, parse(s, '--max-pages', '2').opts(), s.config));
    expect(resolved.maxPages).toBe(2);
    expect(resolved.config.scan.maxPages).toBe(2);
    expect(resolved.config.browser.quietWindowMs).toBe(3_000);
    expect(resolved.network.dnsServers).toEqual(['1.1.1.1']);
  });
});
