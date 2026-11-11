/**
 * The traffic that the READMEs list under their traffic sections matches the class T probes the collectors send, so a
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
    /nach dem Browser höchstens \d+ Anfragen \(`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES`\):.*?zuerst an die `http:\/\/`-Adressen von Seiten, auf denen Phase A ein Formular gesehen hat;.*?beides nur, wenn `http:\/\/` ihres Hosts ohne Umleitung auf https ausliefert: je ein GET, ohne einer Weiterleitung zu folgen und ohne etwas abzusenden/,
  // the rest of the same budget: the http:// address of permalinks the visited pages link, same safeguards.
  'permalink-twin':
    /mit dem Rest des Budgets an die `http:\/\/`-Adressen von Beiträgen und Artikeln, die die besuchten Seiten als Permalink \(`rel="bookmark"`\) verlinken und die der Browser nicht besucht hat;.*?beides nur, wenn `http:\/\/` ihres Hosts ohne Umleitung auf https ausliefert: je ein GET, ohne einer Weiterleitung zu folgen und ohne etwas abzusenden/,
  // after a redirect to another domain the HTTP collector reads the final host's certificates as well.
  certificate:
    /ein Handshake je Host-Variante \(höchstens 3\).*Nach einer Umleitung auf eine andere Domain kommen höchstens 3 weitere für den Host am Ende der Umleitung und seine `www\.`- und Apex-Varianten hinzu/,
};

const EN_DESCRIBED: Record<string, RegExp> = {
  'robots.txt': /`robots\.txt`/,
  sitemap: /at most 2 sitemap requests/,
  'redirect-chain':
    /the redirect chains from `http:\/\/` and `https:\/\/` for the target host and its `www\.` and apex variants, plus the chain on a port explicitly specified in the target URL/,
  'security-headers:': /one request each to the legal notice and privacy policy linked from the homepage/,
  'form-twin':
    /after the browser, at most \d+ requests \(`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES`\):.*?first to the `http:\/\/` addresses of pages where phase A saw a form;.*?both only if `http:\/\/` on their host serves content without redirecting to https: one GET each, without following a redirect or submitting anything/,
  'permalink-twin':
    /with the remaining budget to the `http:\/\/` addresses of posts and articles linked by visited pages as permalinks \(`rel="bookmark"`\) that the browser did not visit;.*?both only if `http:\/\/` on their host serves content without redirecting to https: one GET each, without following a redirect or submitting anything/,
  certificate:
    /one handshake per host variant \(at most 3\).*After a redirect to another domain, at most 3 more are added for the final host and its `www\.` and apex variants/,
};

describe.each([
  { file: 'README.de.md', heading: 'Was der Scanner sendet', described: DESCRIBED, lang: 'de' },
  { file: 'README.md', heading: 'What the scanner sends', described: EN_DESCRIBED, lang: 'en' },
])('$file traffic section describes the probes the scanner sends', ({ file, heading, described, lang }) => {
  const readme = read(file);
  const from = readme.indexOf(`\n## ${heading}`);
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
      expect(Object.keys(described), `undocumented probe "${purpose}"`).toContain(purpose);
      expect(flat).toMatch(described[purpose] as RegExp);
    }
  });

  it('names DNS lookups with the real query budgets, also of the further mail domains and the DKIM selectors', () => {
    const { mailDomainQueryBudget, maxMailDomains, dkimMaxSelectors } = DEFAULT_CONFIG.dns;
    if (lang === 'de') {
      expect(flat).toContain(`höchstens ${DNS_QUERY_BUDGET} Abfragen`);
      expect(flat).toMatch(/MX-, SPF-, DMARC- und DKIM-Abfragen/);
      expect(flat).toContain(`je höchstens ${mailDomainQueryBudget} weitere`);
      expect(flat).toContain(`bis zu ${maxMailDomains} E-Mail-Domains aus dem Impressum`);
      expect(flat).toContain(`je E-Mail-Domain höchstens ${dkimMaxSelectors} Selektoren`);
    } else {
      expect(flat).toContain(`At most ${DNS_QUERY_BUDGET} queries`);
      expect(flat).toMatch(/MX, SPF, DMARC and DKIM queries/);
      expect(flat).toContain(`at most ${mailDomainQueryBudget} more each`);
      expect(flat).toContain(`up to ${maxMailDomains} email domains from the legal notice`);
      expect(flat).toContain(`at most ${dkimMaxSelectors} selectors per email domain`);
    }
  });

  it('names the budget of the http:// addresses of pages with a form and of permalinks', () => {
    expect(flat).toContain(
      lang === 'de'
        ? `nach dem Browser höchstens ${DEFAULT_CONFIG.http.formTwinPages} Anfragen (\`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES\`)`
        : `after the browser, at most ${DEFAULT_CONFIG.http.formTwinPages} requests (\`DSGVO_CHECK_HTTP_FORM_TWIN_PAGES\`)`,
    );
  });

  it('promises no probe that the code does not send', () => {
    const mentioningSecurityTxt = sources('src').filter((rel) => read(rel).includes('security.txt'));

    expect(section).not.toMatch(/security\.txt|\.well-known/);
    expect(mentioningSecurityTxt, 'sources that mention security.txt').toEqual([]);
  });
});
