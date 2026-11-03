/** Tiny helper for tests that need a few synthetic pages: files in a temp dir, served by the fixture server. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SiteDir {
  root: string;
  cleanup(): void;
}

/** `files` maps a relative path (`index.html`, `impressum/index.html`) to its content. */
export function writeSite(files: Record<string, string>): SiteDir {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-check-site-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function page(body: string, head = ''): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Beispiel GmbH</title>${head}</head><body>${body}</body></html>`;
}
