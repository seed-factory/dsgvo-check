import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import { uiText } from '../../../src/core/data/messages.ts';
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

const hook = fileURLToPath(new URL('../../utils/preload/stalled-pdf-hook.ts', import.meta.url));

it('a real browser stalled at PDF printing preserves the scan result and exits within the print budget', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pdf-timeout-'));
  try {
    const target = 'https://www.example.test/';
    const snapshot = makeSnapshot({
      target: makeTarget(target),
      http: makeHttp({
        documents: [
          makeDocumentResponse({
            url: target,
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
    const input = path.join(directory, 'snapshot.json');
    const out = path.join(directory, 'report');
    const json = path.join(out, 'report.json');
    const before = path.join(directory, 'before-print.json');
    const eventsFile = path.join(directory, 'events.jsonl');
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
        timeout: PDF_TIMEOUT_MS + 20_000,
        env: {
          ...process.env,
          ...offlineHookEnv(),
          NO_COLOR: '1',
          DSGVO_TEST_STALLED_PDF: '1',
          DSGVO_TEST_PDF_EVENTS: eventsFile,
          DSGVO_TEST_PDF_REPORT: json,
          DSGVO_TEST_PDF_BEFORE: before,
        },
      },
    );
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(1);
    const events = readFileSync(eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; at: number });
    expect(
      events.map((event) => event.type),
      run.stderr,
    ).toEqual(['launch', 'ready', 'print']);
    expect(readFileSync(json, 'utf8')).toBe(readFileSync(before, 'utf8'));
    const report = JSON.parse(readFileSync(json, 'utf8'));
    expect(report.summary.exitCode).toBe(1);
    expect(report.summary.exitReasons).toEqual(['threshold']);
    expect(report.findings.some((finding: { severity: string }) => finding.severity === 'warning')).toBe(
      true,
    );
    expect(existsSync(path.join(out, 'report.pdf'))).toBe(false);
    expect(existsSync(path.join(out, 'report.pdf.tmp'))).toBe(false);
    const texts = loadTexts('en');
    expect(run.stderr.split(/\r?\n/)).toEqual([
      ...(TEST_SANDBOX === 'off' ? [uiText(texts, 'console.sandboxOff')] : []),
      uiText(texts, 'console.reportWritten', { path: json }),
      uiText(texts, 'report.pdf.skipped'),
      '',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
