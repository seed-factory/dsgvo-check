/** Helpers for orchestrator tests: temporary data dirs with extra checks, fake collectors, fake lookups. */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import type { CollectorResult, Collectors } from '../../src/core/snapshot/collector.ts';
import type { Lookup } from '../../src/core/url/net.ts';
import { REPO_ROOT } from './snapshot-builder.ts';

export interface ExtraCheckData {
  /** checkId → variant → severity */
  ruleset: Record<string, Record<string, 'critical' | 'warning' | 'info'>>;
  /** `<checkId>.<variant>` → crm code or null (defaults to null for every ruleset variant). */
  crm?: Record<string, string | null>;
}

/** Copy test/data/ to a temp dir and add a `zz-test.yaml` with ruleset (including crm) and texts (de, en). */
export function testDataDir(extra: ExtraCheckData): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-data-'));
  cpSync(path.join(REPO_ROOT, 'test/data'), dir, { recursive: true });
  const checks: Record<string, unknown> = {};
  const messages: Record<string, { title: string; body: string }> = {};
  for (const [id, variants] of Object.entries(extra.ruleset)) {
    checks[id] = {
      gating: true,
      variants: Object.fromEntries(
        Object.entries(variants).map(([v, s]) => [
          v,
          { severity: s, crm: extra.crm?.[`${id}.${v}`] ?? null },
        ]),
      ),
    };
    for (const v of Object.keys(variants)) {
      messages[`${id}.${v}`] = { title: `${id} ${v}`, body: `Beobachtet: {detail}` };
    }
  }
  writeFileSync(path.join(dir, 'ruleset/de-2026/zz-test.yaml'), stringify({ checks }));
  for (const lang of ['de', 'en']) {
    writeFileSync(path.join(dir, `texts/${lang}/zz-test.yaml`), stringify({ draft: true, messages }));
  }
  return dir;
}

/** Lookup that resolves every host to one public test address (no network). */
export const publicLookup: Lookup = async () => [{ address: '93.184.215.14', family: 4 }];

export const nxdomainLookup: Lookup = async (host) => {
  const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
  err.code = 'ENOTFOUND';
  throw err;
};

const ok = <S>(sections: S): CollectorResult<S> => ({ status: 'ok', sections });

/** Collectors that return nothing (status ok, no sections) unless overridden. */
export function fakeCollectors(over: Partial<Collectors> = {}): Collectors {
  return {
    browser: async () => ok({}),
    http: async () => ok({}),
    tls: async () => ok({}),
    dns: async () => ok({}),
    ...over,
  };
}
