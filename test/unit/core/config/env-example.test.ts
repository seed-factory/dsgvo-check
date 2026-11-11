import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderEnvExample } from '../../../../src/core/config/env-example.ts';
import { configFields, envValue } from '../../../../src/core/config/fields.ts';
import { resolveConfig } from '../../../../src/core/config/load.ts';
import { DEFAULT_CONFIG } from '../../../../src/core/config/schema.ts';
import { TEST_ENV_EXAMPLE } from '../../../utils/run/test-workers.ts';
import { REPO_ROOT } from '../../../utils/snapshot-builder.ts';

const committed = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

describe('.env.example', () => {
  it('is what the schema generates, followed by the test block (run `corepack pnpm env:example` after a change)', () => {
    expect(committed).toBe(renderEnvExample() + TEST_ENV_EXAMPLE);
  });

  it('lists every setting once, commented out, with its default and a description', () => {
    const lines = committed.split('\n');
    for (const f of configFields()) {
      const at = lines.flatMap((l, i) => (l.startsWith(`# ${f.env}=`) ? [i] : []));
      expect(at, f.env).toHaveLength(1);
      expect(lines[at[0] as number]).toBe(`# ${f.env}=${envValue(f.default)}`);
      // the comment block above the variable starts with the description
      expect(lines[(at[0] as number) - 1], f.env).toMatch(/^# \S/);
    }
    expect(lines.filter((l) => /^[A-Z]/.test(l))).toEqual([]);
  });

  it('mentions the precedence and that nothing is required', () => {
    expect(committed).toMatch(/command-line flag > environment variable > this file/);
    expect(committed).toMatch(/Every line is optional/);
  });

  it('uncommenting every line changes nothing: the file is the defaults', () => {
    const values: Record<string, string> = {};
    for (const line of committed.split('\n')) {
      const m = /^# (DSGVO_CHECK_[A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) values[m[1] as string] = m[2] as string;
    }
    expect(Object.keys(values)).toHaveLength(configFields().length);
    expect(resolveConfig({ env: values }).config).toEqual(DEFAULT_CONFIG);
  });
});
