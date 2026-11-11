import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderPdf = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => vi.fn());
vi.mock('../../../src/reporters/pdf.ts', () => ({ renderPdf }));
vi.mock('../../../src/scan.ts', () => ({ scan }));

import { main } from '../../../src/cli.ts';

class Exit extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

describe('scan with the container sandbox outside the image', () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), 'dsgvo-check-sandbox-'));
    renderPdf.mockReset();
    scan.mockReset();
    vi.stubEnv('DSGVO_CHECK_CONTAINER', '');
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['the option', ['--sandbox', 'container'], {}],
    ['the setting', [], { DSGVO_CHECK_BROWSER_SANDBOX: 'container' }],
  ])('%s ends with exit 2 before any scan or PDF Chromium', async (_name, args, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    await expect(
      main(['node', 'dsgvo-check', 'https://example.test/', '--format', 'json,pdf', '--out', out, ...args]),
    ).rejects.toMatchObject({ code: 2 });
    expect(scan).not.toHaveBeenCalled();
    expect(renderPdf).not.toHaveBeenCalled();
    expect(readdirSync(out).some((f) => f.endsWith('.json'))).toBe(true);
  });
});
