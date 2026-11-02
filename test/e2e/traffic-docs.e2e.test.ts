/**
 * static check: the traffic that canary/README.md promises (rule 1, "Passive only") matches the class T probes the
 * collectors actually send. A site owner who asks "what did you send us?" gets this list, so it must not name a
 * probe that does not exist (e.g. `security.txt` while SEC-01 is not part of the prototype) nor miss one.
 * No network, no build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DNS_QUERY_BUDGET } from '../../src/collectors/dns/collect.ts';
import { REPO_ROOT } from '../utils/snapshot-builder.ts';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.relative(REPO_ROOT, path.join(e.parentPath, e.name)));
}

/** `purpose` of every HTTP/TLS probe record built in src/collectors (literal or via the http collector's `probe`). */
function probePurposes(): Set<string> {
  const out = new Set<string>();
  for (const rel of sources('src/collectors')) {
    if (rel.includes(`${path.sep}dns${path.sep}`)) continue; // DNS queries are not probe records
    const text = read(rel);
    for (const m of text.matchAll(/class: 'T',/g)) {
      const purpose = text.slice(m.index, m.index + 200).match(/purpose: '([^']+)'/);
      if (purpose) out.add(purpose[1] as string);
    }
    for (const m of text.matchAll(/\bprobe\([^,()]+,\s*['`]([^'`$]+)/g)) out.add(m[1] as string);
  }
  return out;
}

/** How rule 1 of the canary README must describe each probe purpose. */
const DESCRIBED: Record<string, RegExp> = {
  'robots.txt': /`robots\.txt`/,
  sitemap: /at most 2 sitemap requests/,
  // an explicit port of the target URL adds the chain of that port.
  'redirect-chain':
    /`http:\/\/` and `https:\/\/` redirect chains of the target host and of its `www\.` and apex variants, plus the chain on an explicit port of the target URL/,
  'security-headers:': /Impressum and Datenschutz pages linked from the start page/,
  // after a redirect to another domain the HTTP collector reads the final host's certificates as well.
  certificate:
    /one TLS handshake per host variant \(at most 3\).*after a redirect to another domain, at most 3 more for the final host and its `www\.` and apex variants/,
};

describe('canary/README.md rule 1 describes the probes the scanner sends', () => {
  const readme = read('canary/README.md');
  const rule1 = readme.slice(readme.indexOf('1. **Passive only.**'), readme.indexOf('\n2. **'));

  it('finds the rule and the probes', () => {
    expect(rule1.length).toBeGreaterThan(100);
    expect([...probePurposes()].sort()).toEqual(
      expect.arrayContaining(['certificate', 'redirect-chain', 'robots.txt', 'sitemap']),
    );
  });

  it('every probe purpose in the collectors is described', () => {
    for (const purpose of probePurposes()) {
      expect(Object.keys(DESCRIBED), `undocumented probe "${purpose}"`).toContain(purpose);
      expect(rule1.replace(/\s+/g, ' ')).toMatch(DESCRIBED[purpose] as RegExp);
    }
  });

  it('names DNS lookups with the real query budget', () => {
    expect(rule1.replace(/\s+/g, ' ')).toContain(`at most ${DNS_QUERY_BUDGET} queries`);
    expect(rule1).toMatch(/MX, SPF and DMARC/);
  });

  it('promises no probe that the code does not send', () => {
    expect(rule1).not.toMatch(/security\.txt|\.well-known/);
    expect(sources('src').some((rel) => read(rel).includes('security.txt'))).toBe(false);
  });
});
