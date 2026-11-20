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

function reachableImports(entries: readonly string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const stack = [...entries];

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
    const specs = [...reachableImports([path.join(ROOT, 'src/cmp/index.ts')]).values()].flat();

    expect(specs).toContain('node:fs');
  });

  // A check reads the settings that matter to it from `ctx.thresholds`; a default taken from the config would make the
  // verdict depend on something other than the snapshot and the context.
  const CONFIG_DIR = path.join(ROOT, 'src/core/config') + path.sep;
  it('checks reach no browser, network, filesystem or settings modules', () => {
    const violations: string[] = [];
    for (const [file, specs] of reachableImports(walk(CHECKS_DIR))) {
      const relative = path.relative(ROOT, file);
      if (file.startsWith(CONFIG_DIR)) violations.push(`settings module reached: ${relative}`);
      for (const spec of specs) {
        if (FORBIDDEN.includes(spec)) violations.push(`${relative} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('import graph of the core', () => {
  const UPPER = ['src/checks', 'src/collectors', 'src/reporters'].map((d) => path.join(ROOT, d) + path.sep);
  it('core modules import no check, collector or reporter', () => {
    const violations: string[] = [];
    for (const file of walk(path.join(ROOT, 'src/core'))) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), spec!);
        if (UPPER.some((dir) => target.startsWith(dir))) {
          violations.push(`${path.relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
