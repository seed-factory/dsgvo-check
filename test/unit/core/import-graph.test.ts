/**
 * Checks are pure: Biome forbids direct I/O imports in src/checks, this test also follows runtime imports transitively.
 * The core imports none of the layers built on it (checks, collectors, reporters), not even for types.
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
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

/** `import type X`, and `import { type A, type B }` without a default or namespace part, leave no runtime import. */
function isTypeOnlyClause(clause: string): boolean {
  if (/^type\b/.test(clause)) return true;

  const braces = clause.match(/\{([^}]*)\}/s);
  const outside = clause
    .replace(/\{[^}]*\}/s, '')
    .replace(/,/g, '')
    .trim();
  const named = (braces?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return outside === '' && named.length > 0 && named.every((n) => n.startsWith('type '));
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
    if (isTypeOnlyClause((m[2] ?? '').trim())) continue;
    out.push(m[3] as string);
  }
  return out;
}

/** Every module reachable through relative imports from `entry`, with its runtime import specifiers. */
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

  // A check reads the settings that matter to it from `ctx.thresholds`; a default taken from the config would make the
  // verdict depend on something other than the snapshot and the context.
  const CONFIG_DIR = path.join(ROOT, 'src/core/config') + path.sep;
  it.each(files.map((f) => [path.relative(ROOT, f), f]))('%s reaches no module of the settings', (_, f) => {
    const reached = [...closure(f).keys()].filter((file) => file.startsWith(CONFIG_DIR));

    expect(reached.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});

describe('import graph of the core', () => {
  const UPPER = ['src/checks', 'src/collectors', 'src/reporters'].map((d) => path.join(ROOT, d) + path.sep);
  it.each(walk(path.join(ROOT, 'src/core')).map((f) => [path.relative(ROOT, f), f]))(
    '%s imports no check, collector or reporter',
    (_, f) => {
      const specs = [...readFileSync(f, 'utf8').matchAll(/from\s*['"](\.[^'"]+)['"]/g)].map(
        (m) => m[1] as string,
      );
      const upper = specs.filter((s) => UPPER.some((d) => path.resolve(path.dirname(f), s).startsWith(d)));

      expect(upper).toEqual([]);
    },
  );
});
