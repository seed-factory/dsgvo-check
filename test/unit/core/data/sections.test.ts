/**
 * Every YAML file of the data directories that hold lists and vocabularies (cmp, browser, http, dns, legal) belongs to a
 * schema, and a bad file stops with a message that names the directory and the key.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { cmpSections } from '../../../../src/cmp/adapters-data.ts';
import { browserSections } from '../../../../src/collectors/browser/rules.ts';
import { dnsSections } from '../../../../src/collectors/dns/rules.ts';
import { httpSections } from '../../../../src/collectors/http/rules.ts';
import { DataError, DEFAULT_DATA_DIR, loadDataDir, loadSection } from '../../../../src/core/data/load.ts';
import type { DataSection } from '../../../../src/core/data/parse.ts';

/** Directories with a section schema per top-level key; `own` lists keys read by a loader of their own (lexicons). */
const DIRS: Array<{ dir: string; sections: readonly DataSection<unknown>[]; own: readonly string[] }> = [
  { dir: 'cmp', sections: cmpSections, own: ['lexicon'] },
  { dir: 'browser', sections: browserSections, own: [] },
  { dir: 'http', sections: httpSections, own: [] },
  { dir: 'dns', sections: dnsSections, own: [] },
  { dir: 'legal', sections: [], own: ['legal'] },
];

/** Directories whose files have dedicated loaders and tests (ruleset, texts, services, routing, report template). */
const OTHER = ['ruleset', 'texts', 'services', 'report'];

const yamlFiles = (dir: string) =>
  readdirSync(path.join(DEFAULT_DATA_DIR, dir)).filter((f) => f.endsWith('.yaml'));

const topKeys = (dir: string, file: string): string[] =>
  Object.keys((parseYaml(readFileSync(path.join(DEFAULT_DATA_DIR, dir, file), 'utf8')) ?? {}) as object);

function dataDirCopy(dir: string, file: string, edit: (text: string) => string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sections-'));
  cpSync(path.join(DEFAULT_DATA_DIR, dir), path.join(root, dir), { recursive: true });
  const target = path.join(root, dir, file);
  writeFileSync(target, edit(readFileSync(target, 'utf8')));
  return root;
}

describe('data directories', () => {
  it('every directory under test/data has a schema owner', () => {
    const dirs = readdirSync(DEFAULT_DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.sort()).toEqual([...DIRS.map((d) => d.dir), ...OTHER].sort());
  });

  describe.each(DIRS)('test/data/$dir', ({ dir, sections, own }) => {
    it('every file key is owned by a schema and every schema key has exactly one file', () => {
      const owned = [...sections.map((s) => s.key), ...own];
      const found = yamlFiles(dir).flatMap((file) => topKeys(dir, file).map((key) => `${file}:${key}`));
      expect(found.filter((f) => !owned.includes(f.split(':')[1] as string))).toEqual([]);
      for (const key of owned) {
        expect(
          found.filter((f) => f.endsWith(`:${key}`)),
          key,
        ).toHaveLength(1);
      }
    });

    it('loads and validates', () => {
      const merged = loadDataDir(dir);
      for (const section of sections) expect(() => section.parse(merged), section.key).not.toThrow();
    });
  });
});

describe('a broken data file is reported with its directory and key', () => {
  const byKey = (dir: string, key: string) =>
    (DIRS.find((d) => d.dir === dir)?.sections.find((s) => s.key === key) ?? null) as DataSection<unknown>;

  it('a regular expression that does not compile', () => {
    const root = dataDirCopy('browser', 'challenges.yaml', (t) => t.replace('"^just a moment"', '"^(just"'));
    expect(() => loadSection(byKey('browser', 'challenges'), root)).toThrow(
      /test\/data\/browser: challenges\.titles\.0\.pattern: invalid regular expression/,
    );
  });

  it('an unknown field, a typo is not silently ignored', () => {
    const root = dataDirCopy('browser', 'pages.yaml', (t) => t.replace('extraKeywords:', 'extraKeyword:'));
    expect(() => loadSection(byKey('browser', 'pages'), root)).toThrow(DataError);
    expect(() => loadSection(byKey('browser', 'pages'), root)).toThrow(/pages\./);
  });

  it('a name that must be lower case', () => {
    const root = dataDirCopy('browser', 'identifiers.yaml', (t) =>
      t.replace('    - gclid\n', '    - GCLID\n'),
    );
    expect(() => loadSection(byKey('browser', 'identifiers'), root)).toThrow(
      /identifiers\.params\.\d+: must be lower case/,
    );
  });

  it('a free-mail entry that is no domain name (a URL or an address) is refused', () => {
    const root = dataDirCopy('dns', 'mail-domains.yaml', (t) =>
      t.replace('    - gmx.de\n', '    - mail@gmx.de\n'),
    );
    expect(() => loadSection(byKey('dns', 'mailDomains'), root)).toThrow(
      /test\/data\/dns: mailDomains\.freeMail\.\d+: must be a domain name/,
    );
  });

  it('a missing section names the key it expected', () => {
    const root = dataDirCopy('http', 'html.yaml', (t) => t.replace(/^html:/m, 'htmx:'));
    expect(() => loadSection(byKey('http', 'html'), root)).toThrow(
      /test\/data\/http: section "html:" is missing/,
    );
  });

  it('an invalid YAML file names the file', () => {
    const root = dataDirCopy('http', 'html.yaml', () => 'html: [unclosed');
    expect(() => loadDataDir('http', root)).toThrow(/html\.yaml: invalid YAML/);
  });
});
