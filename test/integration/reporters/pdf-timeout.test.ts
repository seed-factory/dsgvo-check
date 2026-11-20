/**
 * The CLI with a real browser that never finishes printing the PDF: the report written before printing must survive,
 * the process must end within the print budget, and no partial PDF may remain.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import { uiText } from '../../../src/core/data/messages.ts';
import type { Snapshot } from '../../../src/core/snapshot/index.ts';
import { PDF_TIMEOUT_MS } from '../../../src/reporters/pdf.ts';
import { OFFLINE_HOOK, offlineHookEnv } from '../../utils/preload/offline-network-hook.ts';
import {
  makeDocumentResponse,
  makeHttp,
  makeSnapshot,
  makeTarget,
  REPO_ROOT,
} from '../../utils/snapshot-builder.ts';
import { TEST_SANDBOX } from '../browser/helpers.ts';

/** Preload that launches the real browser but leaves its PDF operation pending until the CLI's deadline. */
const hook = fileURLToPath(new URL('../../utils/preload/stalled-pdf-hook.ts', import.meta.url));
/** Slack on top of the print budget for starting the CLI and writing the reports. */
const SPAWN_SLACK_MS = 20_000;
const TARGET = 'https://www.example.test/';

/** One HDR-01 warning only: all required headers are present except a `referrer-policy` of `unsafe-url`. */
function snapshotWithOneHeaderWarning(): Snapshot {
  return makeSnapshot({
    target: makeTarget(TARGET),
    http: makeHttp({
      documents: [
        makeDocumentResponse({
          url: TARGET,
          headers: [
            { name: 'strict-transport-security', value: 'max-age=31536000' },
            { name: 'content-security-policy', value: "default-src 'self'; frame-ancestors 'none'" },
            { name: 'x-content-type-options', value: 'nosniff' },
            { name: 'referrer-policy', value: 'unsafe-url' },
            { name: 'permissions-policy', value: 'camera=()' },
          ],
        }),
      ],
    }),
  });
}

interface StalledScan {
  run: SpawnSyncReturns<string>;
  /** The files the CLI and the hook wrote. */
  files: { json: string; pdf: string; before: string; events: string };
}

/** Runs the CLI on `snapshot` with `json,pdf` output while the hook stalls PDF printing. */
function scanWithStalledPrinting(directory: string, snapshot: Snapshot): StalledScan {
  const input = path.join(directory, 'snapshot.json');
  const out = path.join(directory, 'report');
  const files = {
    json: path.join(out, 'report.json'),
    pdf: path.join(out, 'report.pdf'),
    before: path.join(directory, 'before-print.json'),
    events: path.join(directory, 'events.jsonl'),
  };
  writeFileSync(input, JSON.stringify(snapshot));

  const run = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(OFFLINE_HOOK).href,
      '--import',
      pathToFileURL(hook).href,
      path.join(REPO_ROOT, 'src/cli.ts'),
      '--from-snapshot',
      input,
      '--checks',
      'HDR-01',
      '--fail-on',
      'warning',
      '--format',
      'json,pdf',
      '--lang',
      'en',
      '--sandbox',
      TEST_SANDBOX,
      '--out',
      out,
    ],
    {
      encoding: 'utf8',
      timeout: PDF_TIMEOUT_MS + SPAWN_SLACK_MS,
      env: {
        ...process.env,
        ...offlineHookEnv(),
        NO_COLOR: '1',
        DSGVO_TEST_STALLED_PDF: '1',
        DSGVO_TEST_PDF_EVENTS: files.events,
        DSGVO_TEST_PDF_REPORT: files.json,
        DSGVO_TEST_PDF_BEFORE: files.before,
      },
    },
  );
  return { run, files };
}

describe('a real browser stalled at PDF printing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pdf-timeout-'));
  let scan: StalledScan;

  beforeAll(() => {
    scan = scanWithStalledPrinting(directory, snapshotWithOneHeaderWarning());
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('exits within the print budget with the threshold exit code, neither crashed nor killed', () => {
    const { run } = scan;

    expect(run.error, run.stderr).toBeUndefined();
    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(1);
  });

  it('launched the browser and began printing before the budget ran out', () => {
    const events = readFileSync(scan.files.events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; at: number });

    expect(
      events.map((event) => event.type),
      scan.run.stderr,
    ).toEqual(['launch', 'ready', 'print']);
  });

  it('preserves the scan result: report.json is the one written before printing', () => {
    expect(readFileSync(scan.files.json, 'utf8')).toBe(readFileSync(scan.files.before, 'utf8'));
    const report = JSON.parse(readFileSync(scan.files.json, 'utf8'));
    expect(report.summary.exitCode).toBe(1);
    expect(report.summary.exitReasons).toEqual(['threshold']);
    expect(report.findings.map((finding: { severity: string }) => finding.severity)).toContain('warning');
  });

  it('leaves neither a PDF nor a temporary PDF behind', () => {
    expect(existsSync(scan.files.pdf)).toBe(false);
    expect(existsSync(`${scan.files.pdf}.tmp`)).toBe(false);
  });

  it('tells on stderr that the report was written and the PDF skipped', () => {
    const texts = loadTexts('en');

    expect(scan.run.stderr.split(/\r?\n/)).toEqual([
      ...(TEST_SANDBOX === 'off' ? [uiText(texts, 'console.sandboxOff')] : []),
      uiText(texts, 'console.reportWritten', { path: scan.files.json }),
      uiText(texts, 'report.pdf.skipped'),
      '',
    ]);
  });
});
