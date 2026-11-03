#!/usr/bin/env node
/** CLI: stdout is the console report, stderr the messages. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { ConfigError, type ConfigProblem, describeProblems, loadConfig } from './core/config/load.ts';
import { envName } from './core/config/names.ts';
import { type Config, defaultConfig } from './core/config/schema.ts';
import { loadTexts } from './core/data/load.ts';
import { uiText } from './core/data/messages.ts';
import { buildFailedReport } from './core/report/build.ts';
import { REPORT_FILES, REPORT_FORMATS, type ReportFormat } from './core/report/reporter.ts';
import {
  AssumeRegionSchema,
  type FailOn,
  type Lang,
  LangSchema,
  type MessageParams,
  type Report,
  ReportSchema,
  type SandboxMode,
  SandboxModeSchema,
  SCHEMA_VERSION,
} from './core/report/schema.ts';
import { formatDuration, parseDuration } from './core/runtime/duration.ts';
import { errorMessage } from './core/runtime/errors.ts';
import { createLogger } from './core/runtime/logger.ts';
import { TOOL_VERSION } from './core/runtime/version.ts';
import { redactTarget } from './core/url/url.ts';
import { renderJson } from './reporters/json.ts';
import { writeReports } from './reporters/write.ts';
import { scan } from './scan.ts';
import type { ScanOptions } from './scan-options.ts';

interface RawOptions {
  failOn: string;
  format: string;
  out: string;
  maxPages: string;
  timeout: string;
  proxy?: string;
  assumeRegion?: string;
  lang: string;
  strict?: boolean;
  sandbox: string;
  screenshots: boolean;
  saveSnapshot?: string;
  fromSnapshot?: string;
  checks?: string;
  verbose?: boolean;
}

const FORMATS = new Set<ReportFormat>(REPORT_FORMATS);

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text) return resolve();
    stream.write(text, () => resolve());
  });
}

async function exit(code: number): Promise<never> {
  await write(process.stdout, '');
  process.exit(code);
}

/** `--format` list: unique formats, and the first unknown one, if any. */
function parseFormats(raw: string): { formats: ReportFormat[]; bad: string | undefined } {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    formats: [...new Set(list)] as ReportFormat[],
    bad: list.find((f) => !FORMATS.has(f as ReportFormat)),
  };
}

/** A CLI value that scan() does not check itself (`failure.invalid-cli-option`). */
interface InvalidOption {
  option: string;
  value: string;
}

/** Map raw CLI strings to ScanOptions. Invalid values are passed through so scan() reports them as invalid-input. */
export function toScanOptions(
  url: string | undefined,
  raw: RawOptions,
  config?: Config,
): ScanOptions & { invalid?: InvalidOption } {
  const { formats, bad: badFormat } = parseFormats(raw.format);
  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(raw.timeout);
  } catch {
    timeoutMs = Number.NaN;
  }
  const opts: ScanOptions & { invalid?: InvalidOption } = {
    failOn: raw.failOn as FailOn,
    formats,
    outDir: raw.out,
    maxPages: /^\d+$/.test(raw.maxPages) ? Number(raw.maxPages) : Number.NaN,
    timeoutMs,
    // Without the flag the proxy of the settings applies.
    ...(raw.proxy === undefined ? {} : { proxy: raw.proxy }),
    assumeRegion: (raw.assumeRegion ?? null) as ScanOptions['assumeRegion'],
    lang: raw.lang as Lang,
    strict: Boolean(raw.strict),
    sandbox: raw.sandbox as SandboxMode,
    screenshots: raw.screenshots,
    saveSnapshot: raw.saveSnapshot ?? null,
    fromSnapshot: raw.fromSnapshot ?? null,
    checks: raw.checks
      ? raw.checks
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : null,
    log: createLogger(raw.verbose ? 'debug' : 'warn'),
  };
  if (config) opts.config = config;
  if (url) opts.url = url;
  const invalid = firstInvalidOption(raw, badFormat);
  if (invalid) opts.invalid = invalid;
  return opts;
}

/** The first option whose value is outside its allowed set; `--format` is checked first. */
function firstInvalidOption(raw: RawOptions, badFormat: string | undefined): InvalidOption | undefined {
  if (badFormat) return { option: '--format', value: badFormat };
  const choices: ReadonlyArray<{ option: string; value: string | undefined; allowed: readonly string[] }> = [
    { option: '--lang', value: raw.lang, allowed: LangSchema.options },
    { option: '--sandbox', value: raw.sandbox, allowed: SandboxModeSchema.options },
    // Optional: absent (or empty) is allowed.
    { option: '--assume-region', value: raw.assumeRegion || undefined, allowed: AssumeRegionSchema.options },
  ];
  for (const { option, value, allowed } of choices) {
    if (value !== undefined && !allowed.includes(value)) return { option, value };
  }
  return undefined;
}

/** Minimal failed report written synchronously (signals, crashes, invalid CLI values). */
function writeFailedSync(
  outDir: string,
  target: string,
  code: string,
  params: MessageParams,
  reason: string,
  lang: Lang,
): string {
  let texts = null;
  try {
    texts = loadTexts(lang);
  } catch {
    texts = null;
  }
  const message = texts ? uiText(texts, `failure.${code}`, params) : code;
  const report = buildFailedReport({
    target,
    startedAt: new Date().toISOString(),
    failure: { code, message },
    exitReasons: [reason],
    texts,
  });
  try {
    mkdirSync(outDir, { recursive: true });
    // With texts, the JSON reporter composes the conditional disclaimer paragraphs.
    const ctx = texts ? { texts, lang, outDir, color: false } : undefined;
    writeFileSync(path.join(outDir, REPORT_FILES.json), renderJson(report, ctx));
  } catch (err) {
    process.stderr.write(`dsgvo-check: ${errorMessage(err)}\n`);
  }
  return message;
}

/** What `main` read from the environment and the `.env` file: the settings, a note per source, or why they are unusable. */
export interface CliSettings {
  config: Config;
  /** `console.*` texts for stderr: where settings came from, names that look like typos. */
  notes: Array<{ key: string; params: MessageParams }>;
  /** Names of the variables that the environment or the `.env` file set; every other setting is at its built-in value. */
  explicit: ReadonlySet<string>;
  /** Set when a variable or the `.env` file is invalid; scans and reports then end with exit code 2. */
  error: readonly ConfigProblem[] | null;
}

export function builtInSettings(): CliSettings {
  return { config: defaultConfig(), notes: [], explicit: new Set(), error: null };
}

export function loadCliSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): CliSettings {
  try {
    const loaded = loadConfig({ env, cwd });
    const notes: CliSettings['notes'] = [];
    if (loaded.file && loaded.fromFile.length > 0) {
      notes.push({ key: 'console.configFile', params: { path: loaded.file, count: loaded.fromFile.length } });
    }
    if (loaded.unknown.length > 0) {
      notes.push({ key: 'console.configUnknown', params: { names: loaded.unknown.join(', ') } });
    }
    return { config: loaded.config, notes, explicit: new Set(loaded.set), error: null };
  } catch (err) {
    if (err instanceof ConfigError) return { ...builtInSettings(), error: err.problems };
    throw err;
  }
}

async function runScan(url: string | undefined, raw: RawOptions, settings: CliSettings): Promise<never> {
  const opts = toScanOptions(url, raw, settings.config);
  const lang = opts.lang === 'en' ? 'en' : 'de';
  const outDir = path.resolve(raw.out);
  // The target in the minimal failed reports written here is redacted like in scan().
  const target = url ? redactTarget(url) : (raw.fromSnapshot ?? '');

  if (opts.invalid) {
    const message = writeFailedSync(
      outDir,
      target,
      'invalid-cli-option',
      { ...opts.invalid },
      'invalid-input',
      lang,
    );
    process.stderr.write(`dsgvo-check: ${message}\n`);
    return exit(2);
  }
  if (settings.error) {
    const problems = describeProblems(settings.error, lang);
    const message = writeFailedSync(outDir, target, 'invalid-config', { problems }, 'invalid-input', lang);
    process.stderr.write(`dsgvo-check: ${message}\n`);
    return exit(2);
  }
  const notes = loadTexts(lang);
  for (const n of settings.notes) await write(process.stderr, `${uiText(notes, n.key, n.params)}\n`);

  const onSignal = (sig: string) => {
    process.stderr.write(`dsgvo-check: ${sig} received, aborting\n`);
    writeFailedSync(outDir, target, 'interrupted', { signal: sig }, 'internal-error', lang);
    process.exit(2);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const crash = (err: unknown) => {
    process.stderr.write(`dsgvo-check: internal error: ${errorMessage(err)}\n`);
    writeFailedSync(outDir, target, 'internal-error', { message: errorMessage(err) }, 'internal-error', lang);
    process.exit(2);
  };
  process.on('unhandledRejection', crash);
  process.on('uncaughtException', crash);

  // Watchdog: --timeout plus the reserve for writing reports. scan() itself stops collectors at the deadline.
  const watchdogMs =
    (Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : settings.config.scan.timeoutMs) +
    settings.config.scan.reportWriteReserveMs;
  const watchdogDeadline = Date.now() + watchdogMs;
  setTimeout(() => {
    process.stderr.write('dsgvo-check: watchdog timeout, aborting\n');
    writeFailedSync(outDir, target, 'watchdog-timeout', {}, 'internal-error', lang);
    process.exit(2);
  }, watchdogMs).unref();

  const result = await scan(opts);
  const formats = opts.formats ?? settings.config.report.formats;
  const written = await writeReports(result, {
    outDir,
    formats,
    lang,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    pdf: { sandbox: opts.sandbox },
    config: settings.config,
    watchdogDeadline,
    outputConsole: (text) => write(process.stdout, text),
  });
  const texts = loadTexts(lang);
  if (result.report.scan.status === 'failed') {
    await write(process.stderr, `dsgvo-check: ${result.report.scan.failure.message}\n`);
  }
  if (opts.sandbox === 'off') await write(process.stderr, `${uiText(texts, 'console.sandboxOff')}\n`);
  for (const f of written.written)
    await write(process.stderr, `${uiText(texts, 'console.reportWritten', { path: f })}\n`);
  for (const e of written.errors) {
    await write(
      process.stderr,
      `${uiText(texts, 'console.reportWriteFailed', { path: e.path, message: e.message })}\n`,
    );
  }
  for (const warning of written.warnings) await write(process.stderr, `${warning}\n`);
  return exit(written.exitCode);
}

interface ReportOptions {
  format: string;
  lang: string;
  out?: string;
}

async function runReport(file: string, raw: ReportOptions, settings: CliSettings): Promise<never> {
  const lang = raw.lang === 'en' ? 'en' : 'de';
  const texts = loadTexts(lang);
  if (settings.error) {
    const problems = describeProblems(settings.error, lang);
    await write(process.stderr, `dsgvo-check: ${uiText(texts, 'failure.invalid-config', { problems })}\n`);
    return exit(2);
  }
  const { formats, bad } = parseFormats(raw.format);
  try {
    if (!LangSchema.safeParse(raw.lang).success || formats.length === 0 || bad !== undefined) {
      throw new Error('invalid options');
    }
    const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const parsed = ReportSchema.safeParse(input);
    if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION) throw new Error('invalid report');
    // Validate without discarding future optional fields from the open report schema.
    const report = input as Report;
    const written = await writeReports(
      { report, snapshot: null, exitCode: 0 },
      {
        outDir: raw.out ?? path.dirname(path.resolve(file)),
        formats,
        lang,
        artifactsDir: path.dirname(path.resolve(file)),
        config: settings.config,
        outputConsole: (text) => write(process.stdout, text),
      },
    );
    for (const warning of written.warnings) await write(process.stderr, `${warning}\n`);
    for (const error of written.errors) {
      await write(process.stderr, `${uiText(texts, 'console.reportWriteFailed', error)}\n`);
    }
    return exit(written.exitCode);
  } catch (err) {
    await write(process.stderr, `${uiText(texts, 'report.cli.invalid')} (${errorMessage(err)})\n`);
    return exit(2);
  }
}

function installBrowser(withDeps: boolean): Promise<number> {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  // Full Chrome for Testing (new headless, `channel: 'chromium'`), without the headless shell.
  const args = [cli, 'install', '--no-shell', ...(withDeps ? ['--with-deps'] : []), 'chromium'];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 2));
    child.on('error', () => resolve(2));
  });
}

/** Nutzungshinweise for `--help`; the text lives in test/data/texts. */
function usageNotes(): string {
  try {
    const texts = loadTexts('de');
    const title = uiText(texts, 'usageNotes.title');
    const body = uiText(texts, 'usageNotes', { version: TOOL_VERSION });
    return `\n${title}:\n${wrap(body, 100)}\n`;
  } catch {
    return '';
  }
}

/** Hint on the environment and `.env` settings for `--help`. */
function configNotes(): string {
  try {
    const texts = loadTexts('de');
    return `\n${uiText(texts, 'cli.configNotes.title')}:\n${wrap(uiText(texts, 'cli.configNotes'), 100)}\n`;
  } catch {
    return '';
  }
}

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => `  ${l}`).join('\n');
}

/** `settings` fill the defaults of the flags that have a setting: flag, then environment, then `.env`, then built-in. */
export function buildProgram(settings: CliSettings = builtInSettings()): Command {
  const { config } = settings;
  const program = new Command();
  const texts = loadTexts('de');
  program.enablePositionalOptions();
  program.exitOverride();
  program
    .name('dsgvo-check')
    .description(uiText(texts, 'cli.description'))
    .version(TOOL_VERSION, '-V, --version')
    .argument('[url]', uiText(texts, 'cli.url'))
    .option('--fail-on <level>', uiText(texts, 'cli.failOn'), config.scan.failOn)
    .option('--format <list>', uiText(texts, 'report.cli.formats'), config.report.formats.join(','))
    .option('--out <dir>', uiText(texts, 'cli.out'), config.report.outDir)
    .option('--max-pages <n>', uiText(texts, 'cli.maxPages'), String(config.scan.maxPages))
    .option('--timeout <duration>', uiText(texts, 'cli.timeout'), formatDuration(config.scan.timeoutMs))
    // No default shown: the proxy of the settings may hold credentials.
    .option('--proxy <url>', uiText(texts, 'cli.proxy'))
    .option('--assume-region <region>', uiText(texts, 'cli.assumeRegion'))
    .option('--lang <lang>', uiText(texts, 'report.cli.language'), config.report.lang)
    .option('--strict', uiText(texts, 'cli.strict'))
    .option('--sandbox <mode>', uiText(texts, 'cli.sandbox'), config.browser.sandbox)
    .option('--no-screenshots', uiText(texts, 'cli.noScreenshots'))
    .option('--save-snapshot <file>', uiText(texts, 'cli.saveSnapshot'))
    .option('--from-snapshot <file>', uiText(texts, 'cli.fromSnapshot'))
    .option('--checks <ids>', uiText(texts, 'cli.checks'))
    .option('--verbose', uiText(texts, 'cli.verbose'))
    .addHelpText('after', configNotes)
    .addHelpText('after', usageNotes)
    .showHelpAfterError()
    .action(async (url: string | undefined, raw: RawOptions) => {
      if (!url && !raw.fromSnapshot) {
        program.outputHelp({ error: true });
        process.stderr.write(`\ndsgvo-check: ${uiText(texts, 'cli.urlMissing')}\n`);
        return exit(2);
      }
      return runScan(url, raw, settings);
    });

  // The built-in format list is for scans (console, json); a re-rendered report is read, so it defaults to html
  // unless the operator named formats in the settings.
  const reportFormats = settings.explicit.has(envName('report', 'formats'))
    ? config.report.formats
    : ['html'];
  program
    .command('report <report.json>')
    .description(uiText(texts, 'report.cli.description'))
    .option('--format <list>', uiText(texts, 'report.cli.formats'), reportFormats.join(','))
    .option('--lang <lang>', uiText(texts, 'report.cli.language'), config.report.lang)
    .option('--out <dir>', uiText(texts, 'report.cli.output'))
    .action((file: string, raw: ReportOptions) => runReport(file, raw, settings));

  program
    .command('install')
    .description(uiText(texts, 'cli.install'))
    .option('--with-deps', uiText(texts, 'cli.installWithDeps'))
    .action(async (o: { withDeps?: boolean }) =>
      exit((await installBrowser(Boolean(o.withDeps))) === 0 ? 0 : 2),
    );

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram(loadCliSettings());
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return exit(0);
      return exit(2);
    }
    process.stderr.write(`dsgvo-check: ${errorMessage(err)}\n`);
    return exit(2);
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main(process.argv);
