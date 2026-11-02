/**
 * import graph : checks are pure. Biome forbids direct I/O imports in src/checks/**; this test also follows
 * runtime imports transitively, so a check cannot reach playwright-core or node I/O through a helper module.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CHECKS_DIR = path.join(ROOT, 'src/checks');

const FORBIDDEN = [
  'playwright-core',
  'undici',
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:tls',
  'node:dns',
  'node:dns/promises',
  'node:http',
  'node:https',
  'node:child_process',
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

/** Runtime import specifiers of a module (type-only imports and re-exports are erased by tsc). */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gms;
  for (const m of source.matchAll(re)) {
    if (m[4]) {
      out.push(m[4]);
      continue;
    }
    const clause = (m[2] ?? '').trim();
    if (/^type\b/.test(clause)) continue;
    const braces = clause.match(/\{([^}]*)\}/s);
    const outside = clause
      .replace(/\{[^}]*\}/s, '')
      .replace(/,/g, '')
      .trim();
    const named = (braces?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (outside === '' && named.length > 0 && named.every((n) => n.startsWith('type '))) continue;
    out.push(m[3] as string);
  }
  return out;
}

function closure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const specs = runtimeImports(readFileSync(file, 'utf8'));
    seen.set(file, specs);
    for (const s of specs) {
      if (s.startsWith('.')) stack.push(path.resolve(path.dirname(file), s));
    }
  }
  return seen;
}

describe('import graph of checks', () => {
  it('parses runtime vs type-only imports', () => {
    expect(
      runtimeImports(
        [
          "import type { A } from './a.ts';",
          "import { type B, c } from './c.ts';",
          "import { type D } from './d.ts';",
          "export type * from './e.ts';",
          "export { f } from './f.ts';",
          "import g from 'g';",
        ].join('\n'),
      ),
    ).toEqual(['./c.ts', './f.ts', 'g']);
  });

  it('positive control: the CMP entry point (adapters, data loader) does reach node:fs', () => {
    const specs = [...closure(path.join(ROOT, 'src/cmp/index.ts')).values()].flat();
    expect(specs).toContain('node:fs');
  });

  const files = walk(CHECKS_DIR);
  it.each(files.map((f) => [path.relative(ROOT, f), f]))(
    '%s reaches no browser, network or fs module',
    (_, f) => {
      const graph = closure(f);
      const offending: string[] = [];
      for (const [file, specs] of graph) {
        for (const s of specs)
          if (FORBIDDEN.includes(s)) offending.push(`${path.relative(ROOT, file)} → ${s}`);
      }
      expect(offending).toEqual([]);
    },
  );
});
