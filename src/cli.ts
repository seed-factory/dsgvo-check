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
import { loadTexts, type Texts } from './core/data/load.ts';
import { uiText } from './core/data/messages.ts';
import { buildFailedReport } from './core/report/build.ts';
import {
  REPORT_FILES,
  REPORT_FORMATS,
  REPORT_PROFILES,
  type ReportFormat,
  type ReportProfile,
} from './core/report/reporter.ts';
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
import { errorMessage, InvalidInputError } from './core/runtime/errors.ts';
import { createLogger } from './core/runtime/logger.ts';
import { TOOL_VERSION } from './core/runtime/version.ts';
import { redactTarget } from './core/url/url.ts';
import { renderJson } from './reporters/json.ts';
import { type WriteResult, writeReports } from './reporters/write.ts';
import { type ScanResult, scan } from './scan.ts';
import type { ScanOptions } from './scan-options.ts';
import { parseList, parseTargetList, planTargets, reportVariants, type SiteTarget } from './targets.ts';

interface RawOptions {
  failOn: string;
  format: string;
  out: string;
  maxPages: string;
  timeout: string;
  proxy?: string;
  assumeRegion?: string;
  lang: string;
  profile: string;
  targets?: string;
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
  const list = parseList(raw);
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

  const opts: ScanOptions & { invalid?: InvalidOption } = {
    failOn: raw.failOn as FailOn,
    formats,
    outDir: raw.out,
    maxPages: /^\d+$/.test(raw.maxPages) ? Number(raw.maxPages) : Number.NaN,
    timeoutMs: parseTimeoutOrNaN(raw.timeout),
    // Without the flag the proxy of the settings applies.
    ...(raw.proxy === undefined ? {} : { proxy: raw.proxy }),
    assumeRegion: (raw.assumeRegion ?? null) as ScanOptions['assumeRegion'],
    lang: parseList(raw.lang)[0] as Lang,
    strict: Boolean(raw.strict),
    sandbox: raw.sandbox as SandboxMode,
    insideContainer: insideContainer(),
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

/** NaN marks an unparsable duration so that scan() reports it as invalid input. */
function parseTimeoutOrNaN(raw: string): number {
  try {
    return parseDuration(raw);
  } catch {
    return Number.NaN;
  }
}

/** The first option whose value is outside its allowed set, checked in the order of the options below. */
function firstInvalidOption(raw: RawOptions, badFormat: string | undefined): InvalidOption | undefined {
  if (badFormat) return { option: '--format', value: badFormat };
  const lists: ReadonlyArray<{ option: string; value: string; allowed: readonly string[] }> = [
    { option: '--lang', value: raw.lang, allowed: LangSchema.options },
    { option: '--profile', value: raw.profile, allowed: REPORT_PROFILES },
  ];
  const choices: ReadonlyArray<{ option: string; value: string | undefined; allowed: readonly string[] }> = [
    { option: '--sandbox', value: raw.sandbox, allowed: SandboxModeSchema.options },
    // Optional: absent (or empty) is allowed.
    { option: '--assume-region', value: raw.assumeRegion || undefined, allowed: AssumeRegionSchema.options },
  ];
  for (const { option, value, allowed } of lists) {
    const entries = parseList(value);
    if (entries.length === 0) return { option, value };
    const bad = entries.find((e) => !allowed.includes(e));
    if (bad !== undefined) return { option, value: bad };
  }
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

/** `--sandbox container` is only valid inside the dsgvo-check image, which sets this variable. */
function insideContainer(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.DSGVO_CHECK_CONTAINER === '1';
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

async function runScan(urls: string[], raw: RawOptions, settings: CliSettings): Promise<never> {
  const opts = toScanOptions(urls[0], raw, settings.config);
  const lang = opts.lang === 'en' ? 'en' : 'de';
  const outDir = path.resolve(raw.out);
  const multiSite = urls.length > 1 || raw.targets !== undefined;
  // The target in the minimal failed reports written here is redacted like in scan().
  const firstTarget = multiSite ? '' : urls[0] ? redactTarget(urls[0]) : (raw.fromSnapshot ?? '');
  const writeFailed: FailedReportWriter = (code, params, reason) =>
    writeFailedSync(outDir, firstTarget, code, params, reason, lang);

  if (opts.invalid) return failBeforeScan(writeFailed, 'invalid-cli-option', { ...opts.invalid });
  if (settings.error) {
    const problems = describeProblems(settings.error, lang);
    return failBeforeScan(writeFailed, 'invalid-config', { problems });
  }
  // scan() rejects this too, but the PDF step below would still launch Chromium without its sandbox.
  if (opts.sandbox === 'container' && !opts.insideContainer) {
    return failBeforeScan(writeFailed, 'sandbox-container-outside-image', {});
  }

  let fileUrls: string[] | null = null;
  if (raw.targets !== undefined) {
    try {
      fileUrls = parseTargetList(readFileSync(raw.targets, 'utf8'));
    } catch (err) {
      return failBeforeScan(writeFailed, 'targets-unreadable', {
        file: raw.targets,
        message: errorMessage(err),
      });
    }
  }
  let targets: SiteTarget[];
  try {
    targets = planTargets({
      urls,
      fileUrls,
      outDir: raw.out,
      maxTargets: settings.config.scan.maxTargets,
      snapshot: Boolean(raw.saveSnapshot || raw.fromSnapshot),
    });
  } catch (err) {
    if (err instanceof InvalidInputError) return failBeforeScan(writeFailed, err.code, err.params);
    throw err;
  }

  const texts = loadTexts(lang);
  for (const n of settings.notes) await write(process.stderr, `${uiText(texts, n.key, n.params)}\n`);

  const current = { writeFailed };
  installAbortHandlers(() => current.writeFailed);

  const exitCodes: number[] = [];
  for (const [index, target] of targets.entries()) {
    if (multiSite) {
      if (index > 0) await sleep(settings.config.browser.navigationPauseMs);
      const url = redactTarget(target.url);
      await write(
        process.stderr,
        `${uiText(texts, 'console.siteStart', { index: index + 1, total: targets.length, url })}\n`,
      );
    }
    exitCodes.push(await scanSite(target, raw, settings, texts, current));
  }

  if (multiSite) {
    for (const [index, target] of targets.entries()) {
      const url = redactTarget(target.url);
      await write(
        process.stderr,
        `${uiText(texts, 'console.siteExit', { url, code: exitCodes[index] as number })}\n`,
      );
    }
  }
  return exit(Math.max(...exitCodes));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Scans one site and writes its reports; the run goes on after a failure and the site gets exit code 2. */
async function scanSite(
  target: SiteTarget,
  raw: RawOptions,
  settings: CliSettings,
  texts: Texts,
  current: { writeFailed: FailedReportWriter },
): Promise<number> {
  const opts = toScanOptions(target.url, { ...raw, out: target.outDir }, settings.config);
  const lang = opts.lang === 'en' ? 'en' : 'de';
  const siteDir = path.resolve(target.outDir);
  const name = target.url ? redactTarget(target.url) : (raw.fromSnapshot ?? '');
  current.writeFailed = (code, params, reason) => writeFailedSync(siteDir, name, code, params, reason, lang);

  const langs = parseList(raw.lang) as Lang[];
  const profiles = parseList(raw.profile) as ReportProfile[];
  const variants = reportVariants(siteDir, langs, profiles);
  const formats = opts.formats ?? settings.config.report.formats;
  const watchdog = startWatchdog(
    opts,
    settings.config,
    current.writeFailed,
    formats.includes('pdf') ? variants.length : 0,
  );

  try {
    const result = await scan(opts);
    const written = await writeReports(result, {
      outDir: siteDir,
      formats,
      lang,
      variants,
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
      pdf: { sandbox: opts.sandbox },
      config: settings.config,
      watchdogDeadline: watchdog.deadline,
      outputConsole: (text) => write(process.stdout, text),
    });
    await printScanOutcome(result, written, opts.sandbox, texts);
    return written.exitCode;
  } catch (err) {
    const message = current.writeFailed('internal-error', { message: errorMessage(err) }, 'internal-error');
    process.stderr.write(`dsgvo-check: ${message}\n`);
    return 2;
  } finally {
    watchdog.stop();
  }
}

/** Writes the minimal failed report for a code and returns the user-facing message. */
type FailedReportWriter = (code: string, params: MessageParams, reason: string) => string;

/** Invalid CLI values and settings end the run before any collector starts: exit code 2 with `invalid-input`. */
function failBeforeScan(
  writeFailed: FailedReportWriter,
  code: string,
  params: MessageParams,
): Promise<never> {
  const message = writeFailed(code, params, 'invalid-input');
  process.stderr.write(`dsgvo-check: ${message}\n`);
  return exit(2);
}

/** A signal or a crash still leaves a failed report of the site in progress behind before the process ends. */
function installAbortHandlers(writeFailed: () => FailedReportWriter): void {
  const onSignal = (sig: string) => {
    process.stderr.write(`dsgvo-check: ${sig} received, aborting\n`);
    writeFailed()('interrupted', { signal: sig }, 'internal-error');
    process.exit(2);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const crash = (err: unknown) => {
    process.stderr.write(`dsgvo-check: internal error: ${errorMessage(err)}\n`);
    writeFailed()('internal-error', { message: errorMessage(err) }, 'internal-error');
    process.exit(2);
  };
  process.on('unhandledRejection', crash);
  process.on('uncaughtException', crash);
}

/**
 * Last-resort timer of one site: --timeout plus the reserve for writing reports plus one more PDF print per extra
 * variant. scan() itself stops collectors at the deadline. `deadline` lets the report writers hold to it.
 */
function startWatchdog(
  opts: ScanOptions,
  config: Config,
  writeFailed: FailedReportWriter,
  pdfPrints: number,
): { deadline: number; stop: () => void } {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : config.scan.timeoutMs;
  const watchdogMs =
    timeoutMs + config.scan.reportWriteReserveMs + Math.max(0, pdfPrints - 1) * config.pdf.timeoutMs;
  const deadline = Date.now() + watchdogMs;

  const timer = setTimeout(() => {
    process.stderr.write('dsgvo-check: watchdog timeout, aborting\n');
    writeFailed('watchdog-timeout', {}, 'internal-error');
    process.exit(2);
  }, watchdogMs);
  timer.unref();
  return { deadline, stop: () => clearTimeout(timer) };
}

/** Only an explicit `off` weakens the measurement; `container` relies on the hardened image instead. */
export function sandboxIsOff(sandbox: ScanOptions['sandbox']): boolean {
  return sandbox === 'off';
}

/** stderr after the reports are written: scan failure, sandbox notice, written files, write errors, warnings. */
async function printScanOutcome(
  result: ScanResult,
  written: WriteResult,
  sandbox: ScanOptions['sandbox'],
  texts: Texts,
): Promise<void> {
  if (result.report.scan.status === 'failed') {
    await write(process.stderr, `dsgvo-check: ${result.report.scan.failure.message}\n`);
  }
  if (sandboxIsOff(sandbox)) await write(process.stderr, `${uiText(texts, 'console.sandboxOff')}\n`);
  for (const f of written.written)
    await write(process.stderr, `${uiText(texts, 'console.reportWritten', { path: f })}\n`);
  for (const e of written.errors) {
    await write(
      process.stderr,
      `${uiText(texts, 'console.reportWriteFailed', { path: e.path, message: e.message })}\n`,
    );
  }
  for (const warning of written.warnings) await write(process.stderr, `${warning}\n`);
}

interface ReportOptions {
  format: string;
  lang: string;
  profile: string;
  out?: string;
}

async function runReport(file: string, raw: ReportOptions, settings: CliSettings): Promise<never> {
  const langs = parseList(raw.lang);
  const profiles = parseList(raw.profile);
  const lang = langs[0] === 'en' ? 'en' : 'de';
  const texts = loadTexts(lang);
  if (settings.error) {
    const problems = describeProblems(settings.error, lang);
    await write(process.stderr, `dsgvo-check: ${uiText(texts, 'failure.invalid-config', { problems })}\n`);
    return exit(2);
  }

  if (settings.config.browser.sandbox === 'container' && !insideContainer()) {
    await write(process.stderr, `dsgvo-check: ${uiText(texts, 'failure.sandbox-container-outside-image')}\n`);
    return exit(2);
  }

  const { formats, bad } = parseFormats(raw.format);
  try {
    if (
      langs.length === 0 ||
      !langs.every((l) => LangSchema.safeParse(l).success) ||
      profiles.length === 0 ||
      !profiles.every((p) => (REPORT_PROFILES as readonly string[]).includes(p)) ||
      formats.length === 0 ||
      bad !== undefined
    ) {
      throw new Error('invalid options');
    }
    const report = readReportFile(file);
    const inputDir = path.dirname(path.resolve(file));
    const outDir = raw.out ?? inputDir;

    const written = await writeReports(
      { report, snapshot: null, exitCode: 0 },
      {
        outDir,
        formats,
        lang,
        variants: reportVariants(outDir, langs as Lang[], profiles as ReportProfile[]),
        artifactsDir: inputDir,
        pdf: { sandbox: settings.config.browser.sandbox },
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

/** Reads a report.json of the current schema version; throws when it is not one. */
function readReportFile(file: string): Report {
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = ReportSchema.safeParse(input);
  if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION) throw new Error('invalid report');
  // Validate without discarding future optional fields from the open report schema.
  return input as Report;
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
  const program = new Command();
  const texts = loadTexts('de');
  program.enablePositionalOptions();
  program.exitOverride();

  addScanCommand(program, texts, settings);
  addReportCommand(program, texts, settings);
  addInstallCommand(program, texts);
  return program;
}

/** The root command: `dsgvo-check <url>` scans, `--from-snapshot` re-evaluates a saved snapshot. */
function addScanCommand(program: Command, texts: Texts, settings: CliSettings): void {
  const { config } = settings;
  program
    .name('dsgvo-check')
    .description(uiText(texts, 'cli.description'))
    .version(TOOL_VERSION, '-V, --version')
    .argument('[url...]', uiText(texts, 'cli.url'))
    .option('--targets <file>', uiText(texts, 'cli.targets'))
    .option('--fail-on <level>', uiText(texts, 'cli.failOn'), config.scan.failOn)
    .option('--format <list>', uiText(texts, 'report.cli.formats'), config.report.formats.join(','))
    .option('--out <dir>', uiText(texts, 'cli.out'), config.report.outDir)
    .option('--max-pages <n>', uiText(texts, 'cli.maxPages'), String(config.scan.maxPages))
    .option('--timeout <duration>', uiText(texts, 'cli.timeout'), formatDuration(config.scan.timeoutMs))
    // No default shown: the proxy of the settings may hold credentials.
    .option('--proxy <url>', uiText(texts, 'cli.proxy'))
    .option('--assume-region <region>', uiText(texts, 'cli.assumeRegion'))
    .option('--lang <list>', uiText(texts, 'report.cli.language'), config.report.lang)
    .option('--profile <list>', uiText(texts, 'report.cli.profile'), config.report.profiles.join(','))
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
    .action(async (urls: string[], raw: RawOptions) => {
      if (urls.length === 0 && raw.targets === undefined && !raw.fromSnapshot) {
        program.outputHelp({ error: true });
        process.stderr.write(`\ndsgvo-check: ${uiText(texts, 'cli.urlMissing')}\n`);
        return exit(2);
      }
      return runScan(urls, raw, settings);
    });
}

function addReportCommand(program: Command, texts: Texts, settings: CliSettings): void {
  const { config } = settings;
  // The built-in format list is for scans (console, json); a re-rendered report is read, so it defaults to html
  // unless the operator named formats in the settings.
  const reportFormats = settings.explicit.has(envName('report', 'formats'))
    ? config.report.formats
    : ['html'];

  program
    .command('report <report.json>')
    .description(uiText(texts, 'report.cli.description'))
    .option('--format <list>', uiText(texts, 'report.cli.formats'), reportFormats.join(','))
    .option('--lang <list>', uiText(texts, 'report.cli.language'), config.report.lang)
    .option('--profile <list>', uiText(texts, 'report.cli.profile'), config.report.profiles.join(','))
    .option('--out <dir>', uiText(texts, 'report.cli.output'))
    .action((file: string, raw: ReportOptions) => runReport(file, raw, settings));
}

function addInstallCommand(program: Command, texts: Texts): void {
  program
    .command('install')
    .description(uiText(texts, 'cli.install'))
    .option('--with-deps', uiText(texts, 'cli.installWithDeps'))
    .action(async (o: { withDeps?: boolean }) =>
      exit((await installBrowser(Boolean(o.withDeps))) === 0 ? 0 : 2),
    );
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
