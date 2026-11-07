/**
 * The traffic that README.md lists under "Was der Scanner sendet" matches the class T probes the collectors send, so a
 * site owner asking "what did you send us?" gets a list without a missing or invented probe. No network, no build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DNS_QUERY_BUDGET } from '../../src/collectors/dns/collect.ts';
import { DEFAULT_CONFIG } from '../../src/core/config/schema.ts';
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

/** How the README section must describe each probe purpose (German wording, whitespace normalised). */
const DESCRIBED: Record<string, RegExp> = {
  'robots.txt': /`robots\.txt`/,
  sitemap: /höchstens 2 Sitemap-Anfragen/,
  // an explicit port of the target URL adds the chain of that port.
  'redirect-chain':
    /die Umleitungsketten von `http:\/\/` und `https:\/\/` für den Zielhost und seine `www\.`- und Apex-Varianten, dazu die Kette auf einem in der Ziel-URL ausdrücklich genannten Port/,
  'security-headers:':
    /je eine Anfrage an die von der Startseite verlinkten Seiten Impressum und Datenschutzerklärung/,
  // after the browser: the http:// address of pages with a form, only where http:// of the host serves content.
  'form-twin':
    /nach dem Browser höchstens \d+ Anfragen \(`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES`\) an die `http:\/\/`-Adressen von Seiten, auf denen Phase A ein Formular gesehen hat, und mit dem Rest dieses Budgets .*?; nur wenn `http:\/\/` ihres Hosts ohne Umleitung auf https ausliefert: je ein GET, ohne einer Weiterleitung zu folgen und ohne etwas abzusenden/,
  // the rest of the same budget: the http:// address of permalinks the visited pages link, same safeguards.
  'permalink-twin':
    /mit dem Rest dieses Budgets an die `http:\/\/`-Adressen von Beiträgen und Artikeln, die die besuchten Seiten als Permalink \(`rel="bookmark"`\) verlinken und die der Browser nicht besucht hat; nur wenn `http:\/\/` ihres Hosts ohne Umleitung auf https ausliefert: je ein GET, ohne einer Weiterleitung zu folgen und ohne etwas abzusenden/,
  // after a redirect to another domain the HTTP collector reads the final host's certificates as well.
  certificate:
    /ein Handshake je Host-Variante \(höchstens 3\).*nach einer Umleitung auf eine andere Domain höchstens 3 weitere für den Zielhost und seine `www\.`- und Apex-Varianten/,
};

describe('README.md section "Was der Scanner sendet" describes the probes the scanner sends', () => {
  const readme = read('README.md');
  const from = readme.indexOf('\n## Was der Scanner sendet');
  const section = readme.slice(from, readme.indexOf('\n## ', from + 1));
  const flat = section.replace(/\s+/g, ' ');

  it('finds the section and the probes', () => {
    expect(from).toBeGreaterThan(0);
    expect(section.length).toBeGreaterThan(100);
    expect([...probePurposes()].sort()).toEqual(
      expect.arrayContaining([
        'certificate',
        'form-twin',
        'permalink-twin',
        'redirect-chain',
        'robots.txt',
        'sitemap',
      ]),
    );
  });

  it('every probe purpose in the collectors is described', () => {
    for (const purpose of probePurposes()) {
      expect(Object.keys(DESCRIBED), `undocumented probe "${purpose}"`).toContain(purpose);
      expect(flat).toMatch(DESCRIBED[purpose] as RegExp);
    }
  });

  it('names DNS lookups with the real query budgets, also of the further mail domains and the DKIM selectors', () => {
    expect(flat).toContain(`höchstens ${DNS_QUERY_BUDGET} Abfragen`);
    expect(flat).toMatch(/MX-, SPF-, DMARC- und DKIM-Abfragen/);
    const { mailDomainQueryBudget, maxMailDomains, dkimMaxSelectors } = DEFAULT_CONFIG.dns;
    expect(flat).toContain(`je höchstens ${mailDomainQueryBudget} weitere`);
    expect(flat).toContain(`bis zu ${maxMailDomains} E-Mail-Domains aus dem Impressum`);
    expect(flat).toContain(`je E-Mail-Domain höchstens ${dkimMaxSelectors} Selektoren`);
  });

  it('names the budget of the http:// addresses of pages with a form and of permalinks', () => {
    expect(flat).toContain(
      `nach dem Browser höchstens ${DEFAULT_CONFIG.http.formTwinPages} Anfragen (\`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES\`)`,
    );
  });

  it('promises no probe that the code does not send', () => {
    const mentioningSecurityTxt = sources('src').filter((rel) => read(rel).includes('security.txt'));

    expect(section).not.toMatch(/security\.txt|\.well-known/);
    expect(mentioningSecurityTxt, 'sources that mention security.txt').toEqual([]);
  });
});
