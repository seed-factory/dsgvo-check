#!/usr/bin/env node
/** CLI (BRIEF "CLI"). Exit codes strictly per table 5.2; stdout = console report, stderr = messages. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loadTexts } from './core/data.ts';
import { parseDuration } from './core/duration.ts';
import { errorMessage } from './core/errors.ts';
import { createLogger } from './core/logger.ts';
import { uiText } from './core/messages.ts';
import { buildFailedReport } from './core/report.ts';
import { type FailOn, type Report, ReportSchema, SCHEMA_VERSION } from './core/report-schema.ts';
import { REPORT_FILES, REPORT_FORMATS, type ReportFormat } from './core/reporter.ts';
import { redactTarget } from './core/url.ts';
import { TOOL_VERSION } from './core/version.ts';
import { renderJson } from './reporters/json.ts';
import { DEFAULTS, REPORT_WRITE_RESERVE_MS, type ScanOptions, scan, writeReports } from './scan.ts';

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

/** Map raw CLI strings to ScanOptions. Invalid values are passed through so scan() reports them as invalid-input. */
export function toScanOptions(url: string | undefined, raw: RawOptions): ScanOptions & { invalid?: string } {
  const formats = raw.format
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const badFormat = formats.find((f) => !FORMATS.has(f as ReportFormat));
  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(raw.timeout);
  } catch {
    timeoutMs = Number.NaN;
  }
  const opts: ScanOptions & { invalid?: string } = {
    failOn: raw.failOn as FailOn,
    formats: [...new Set(formats)] as ReportFormat[],
    outDir: raw.out,
    maxPages: /^\d+$/.test(raw.maxPages) ? Number(raw.maxPages) : Number.NaN,
    timeoutMs,
    proxy: raw.proxy ?? null,
    assumeRegion: (raw.assumeRegion ?? null) as ScanOptions['assumeRegion'],
    lang: raw.lang as 'de' | 'en',
    strict: Boolean(raw.strict),
    sandbox: raw.sandbox as 'require' | 'off',
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
  if (url) opts.url = url;
  if (badFormat) opts.invalid = `Ungültiges Format in --format: ${badFormat}`;
  else if (!['de', 'en'].includes(raw.lang)) opts.invalid = `Ungültiger Wert für --lang: ${raw.lang}`;
  else if (!['require', 'off'].includes(raw.sandbox))
    opts.invalid = `Ungültiger Wert für --sandbox: ${raw.sandbox}`;
  else if (raw.assumeRegion && !['eea', 'de'].includes(raw.assumeRegion))
    opts.invalid = `Ungültiger Wert für --assume-region: ${raw.assumeRegion}`;
  return opts;
}

/** Minimal failed report written synchronously (signals, crashes, invalid CLI values). */
function writeFailedSync(
  outDir: string,
  target: string,
  code: string,
  message: string,
  reason: string,
  lang: 'de' | 'en',
) {
  let texts = null;
  try {
    texts = loadTexts(lang);
  } catch {
    texts = null;
  }
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
    const ctx = texts ? { texts, lang, outDir, color: false } : (null as never);
    writeFileSync(path.join(outDir, REPORT_FILES.json), renderJson(report, ctx));
  } catch (err) {
    process.stderr.write(`dsgvo-check: ${errorMessage(err)}\n`);
  }
}

async function runScan(url: string | undefined, raw: RawOptions): Promise<never> {
  const opts = toScanOptions(url, raw);
  const lang = opts.lang === 'en' ? 'en' : 'de';
  const outDir = path.resolve(raw.out);
  // The target in the minimal failed reports written here is redacted like in scan().
  const target = url ? redactTarget(url) : (raw.fromSnapshot ?? '');

  if (opts.invalid) {
    process.stderr.write(`dsgvo-check: ${opts.invalid}\n`);
    writeFailedSync(outDir, target, 'invalid-cli-option', opts.invalid, 'invalid-input', lang);
    return exit(2);
  }

  const onSignal = (sig: string) => {
    process.stderr.write(`dsgvo-check: ${sig} received, aborting\n`);
    writeFailedSync(outDir, target, 'interrupted', `Abbruch durch ${sig}`, 'internal-error', lang);
    process.exit(2);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const crash = (err: unknown) => {
    process.stderr.write(`dsgvo-check: internal error: ${errorMessage(err)}\n`);
    writeFailedSync(outDir, target, 'internal-error', errorMessage(err), 'internal-error', lang);
    process.exit(2);
  };
  process.on('unhandledRejection', crash);
  process.on('uncaughtException', crash);

  // Watchdog: --timeout plus the reserve for writing reports. scan() itself stops collectors at the deadline.
  const watchdogMs =
    (Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : DEFAULTS.timeoutMs) +
    REPORT_WRITE_RESERVE_MS;
  const watchdogDeadline = Date.now() + watchdogMs;
  setTimeout(() => {
    process.stderr.write('dsgvo-check: watchdog timeout, aborting\n');
    writeFailedSync(
      outDir,
      target,
      'watchdog-timeout',
      'Zeitlimit inklusive Reserve überschritten',
      'internal-error',
      lang,
    );
    process.exit(2);
  }, watchdogMs).unref();

  const result = await scan(opts);
  const formats = opts.formats ?? DEFAULTS.formats;
  const written = await writeReports(result, {
    outDir,
    formats,
    lang,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    pdf: { sandbox: opts.sandbox },
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

async function runReport(file: string, raw: ReportOptions): Promise<never> {
  const lang = raw.lang === 'en' ? 'en' : 'de';
  const texts = loadTexts(lang);
  const formats = raw.format
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  try {
    if (
      !['de', 'en'].includes(raw.lang) ||
      formats.length === 0 ||
      formats.some((f) => !FORMATS.has(f as ReportFormat))
    ) {
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
        formats: [...new Set(formats)] as ReportFormat[],
        lang,
        artifactsDir: path.dirname(path.resolve(file)),
        outputConsole: (text) => write(process.stdout, text),
      },
    );
    for (const warning of written.warnings) await write(process.stderr, `${warning}\n`);
    for (const error of written.errors) {
      await write(process.stderr, `${uiText(texts, 'console.reportWriteFailed', error)}\n`);
    }
    return exit(written.exitCode);
  } catch {
    await write(process.stderr, `${uiText(texts, 'report.cli.invalid')}\n`);
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

/** Nutzungshinweise for `--help` (wording guide §6); the text lives in data/texts. */
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

export function buildProgram(): Command {
  const program = new Command();
  const texts = loadTexts('de');
  program.enablePositionalOptions();
  program.exitOverride();
  program
    .name('dsgvo-check')
    .description(
      'Passiver Scan einer Website auf DSGVO/TDDDG/DDG-Indizien und grundlegende Sicherheitsprobleme.',
    )
    .version(TOOL_VERSION, '-V, --version')
    .argument('[url]', 'Ziel-URL (http/https)')
    .option('--fail-on <level>', 'Schwelle für Exit-Code 1: critical|warning|none', 'critical')
    .option('--format <list>', uiText(texts, 'report.cli.formats'), 'console,json')
    .option('--out <dir>', 'Ausgabeverzeichnis', DEFAULTS.outDir)
    .option('--max-pages <n>', 'maximale Seitenzahl in Phase A', String(DEFAULTS.maxPages))
    .option('--timeout <duration>', 'globales Zeitlimit, z. B. 8m, 90s', '8m')
    .option('--proxy <url>', 'HTTP-Proxy (http://, CONNECT) für Browser, HTTP und TLS')
    .option('--assume-region <region>', 'Standort laut Nutzerangabe: eea|de')
    .option('--lang <lang>', 'Sprache des Berichts: de|en', 'de')
    .option(
      '--strict',
      'nicht eindeutige Ergebnisse, Sandbox off und ungeprüfte Region führen zu Exit-Code 2',
    )
    .option('--sandbox <mode>', 'Chromium-Sandbox: require|off', 'require')
    .option('--no-screenshots', 'keine Screenshots des Banners')
    .option('--save-snapshot <file>', 'Rohdaten-Snapshot speichern')
    .option('--from-snapshot <file>', 'Snapshot neu auswerten, ohne die Website aufzurufen')
    .option('--checks <ids>', 'nur diese Prüfungen, z. B. EMBED-01,HDR-01')
    .option('--verbose', 'ausführliche Logs auf stderr')
    .addHelpText('after', usageNotes)
    .showHelpAfterError()
    .action(async (url: string | undefined, raw: RawOptions) => {
      if (!url && !raw.fromSnapshot) {
        program.outputHelp({ error: true });
        process.stderr.write('\ndsgvo-check: Ziel-URL fehlt.\n');
        return exit(2);
      }
      return runScan(url, raw);
    });

  program
    .command('report <report.json>')
    .description(uiText(texts, 'report.cli.description'))
    .option('--format <list>', uiText(texts, 'report.cli.formats'), 'html')
    .option('--lang <lang>', uiText(texts, 'report.cli.language'), 'de')
    .option('--out <dir>', uiText(texts, 'report.cli.output'))
    .action(runReport);

  program
    .command('install')
    .description('Chromium (Chrome for Testing) für playwright-core herunterladen')
    .option('--with-deps', 'Systemabhängigkeiten installieren (Linux, benötigt Root)')
    .action(async (o: { withDeps?: boolean }) =>
      exit((await installBrowser(Boolean(o.withDeps))) === 0 ? 0 : 2),
    );

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
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
