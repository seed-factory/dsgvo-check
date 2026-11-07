import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadSites } from '../../../scripts/canary/sites.ts';

const example = fileURLToPath(new URL('../../../canary/sites.example.yaml', import.meta.url));
const sites = loadSites(example);

describe('canary/sites.example.yaml', () => {
  it('provides three valid examples across the supported regions', () => {
    expect(sites).toHaveLength(3);
    expect(sites.map((site) => site.region).sort()).toEqual(['de', 'eu', 'non-eu']);
  });

  it.each(sites)('$id uses fictional hosts and references', (site) => {
    expect(site.host).toMatch(/\.(?:invalid|test)$/);
    if (site.publicReference) {
      expect(site.publicReference).toBe('https://example.invalid/case');
      expect(site.selectionReason).toContain(site.publicReference);
    } else expect(site.selectionReason).toMatch(/^Fiktives Beispiel:/);
  });

  it('shows every input field, including optional fields', () => {
    const raw = parseYaml(readFileSync(example, 'utf8')) as { sites: Array<Record<string, unknown>> };
    for (const site of raw.sites) {
      expect(Object.keys(site).sort()).toEqual(
        [
          'id',
          'url',
          'region',
          'country',
          'sector',
          'sizeClass',
          'expectedCmp',
          'cmpSignal',
          'selectionReason',
          'publicReference',
        ].sort(),
      );
    }
  });

  it('can enforce a requested sample size', () => {
    expect(() => loadSites(example, { expectedCount: 4 })).toThrow('expected exactly 4 sites, got 3');
  });

  it('explains how to create a missing local corpus', () => {
    const missing = fileURLToPath(new URL('../../../canary/no-such-corpus.invalid', import.meta.url));
    expect(() => loadSites(missing)).toThrow(
      'Copy canary/sites.example.yaml to canary/sites.yaml and fill it in, or pass --sites <file>.',
    );
  });
});
