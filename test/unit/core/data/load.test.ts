import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DataError,
  loadDataDir,
  loadRouting,
  loadRuleset,
  loadTexts,
} from '../../../../src/core/data/load.ts';

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'data-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('data loaders', () => {
  it('loads the repository data', () => {
    expect(loadRuleset().profile).toMatchObject({ id: 'de-2026', draft: true });
    expect(loadTexts('de').ui.disclaimer?.text).toContain('keine Rechtsberatung');
    expect(loadTexts('en').ui.disclaimer?.text).toContain('not legal advice');
    expect(loadRouting().fonts).toBe('EMBED-01');
  });

  it('merges module files and rejects duplicates', () => {
    const root = dir({
      'ruleset/de-2026/_profile.yaml': 'profile: {id: de-2026, version: "1", rechtsstand: "2026-10-30"}',
      'ruleset/de-2026/a.yaml': 'checks: {A-01: {variants: {x: {severity: warning, crm: T3_OTHER}}}}',
      'ruleset/de-2026/b.yaml': 'checks: {B-01: {gating: false, variants: {y: {severity: info, crm: null}}}}',
    });
    const rs = loadRuleset(root);
    expect(Object.keys(rs.checks).sort()).toEqual(['A-01', 'B-01']);
    expect(rs.checks['A-01']?.gating).toBe(true);
    expect(rs.checks['B-01']?.gating).toBe(false);
    expect(rs.checks['A-01']?.variants.x?.crm).toBe('T3_OTHER');
    expect(rs.checks['B-01']?.variants.y?.crm).toBeNull();

    writeFileSync(
      path.join(root, 'ruleset/de-2026/c.yaml'),
      'checks: {A-01: {variants: {z: {severity: info, crm: null}}}}',
    );
    expect(() => loadRuleset(root)).toThrow(DataError);
  });

  it('keeps `locked` on ruleset variants (5.4/5.5)', () => {
    expect(loadRuleset().checks['CONSENT-04']?.variants['banner-not-recognized']).toMatchObject({
      severity: 'info',
      gating: false,
      locked: true,
    });
  });

  it('validates shapes with readable errors', () => {
    const root = dir({
      'ruleset/de-2026/_profile.yaml': 'profile: {id: de-2026, version: "1", rechtsstand: "x"}',
      'ruleset/de-2026/a.yaml': 'checks: {A-01: {variants: {x: {severity: high}}}}',
    });
    expect(() => loadRuleset(root)).toThrow(/A-01.variants.x.severity/);
    // A variant without a CRM decision is invalid: the mapping is a string or an explicit null.
    writeFileSync(
      path.join(root, 'ruleset/de-2026/a.yaml'),
      'checks: {A-01: {variants: {x: {severity: info}}}}',
    );
    expect(() => loadRuleset(root)).toThrow(/A-01.variants.x.crm/);
  });

  it('texts inherit the file draft flag', () => {
    const root = dir({
      'texts/de/a.yaml': 'draft: false\nmessages: {A-01.x: {title: T, body: B}}',
      'texts/de/b.yaml': 'messages: {B-01.y: {title: T, body: B, draft: false}}',
    });
    const t = loadTexts('de', root);
    expect(t.messages['A-01.x']?.draft).toBe(false);
    expect(t.messages['B-01.y']?.draft).toBe(false);
  });

  it('texts load actions by messageId and reject duplicates', () => {
    const root = dir({
      'texts/de/a.yaml': 'actions: {A-01.x: {text: Tun Sie das.}}',
      'texts/de/b.yaml': 'actions: {B-01.y: {text: Und das.}}',
    });
    expect(loadTexts('de', root).actions).toEqual({ 'A-01.x': 'Tun Sie das.', 'B-01.y': 'Und das.' });
    writeFileSync(path.join(root, 'texts/de/c.yaml'), 'actions: {A-01.x: {text: Doppelt.}}');
    expect(() => loadTexts('de', root)).toThrow(/duplicate action "A-01.x"/);
  });

  it('loadDataDir deep-merges objects and concatenates arrays', () => {
    const root = dir({
      'services/a.yaml': 'services: [{id: a}]\nmeta: {version: "1"}',
      'services/b.yaml': 'services: [{id: b}]\nmeta: {license: MIT}',
    });
    expect(loadDataDir('services', root)).toEqual({
      services: [{ id: 'a' }, { id: 'b' }],
      meta: { version: '1', license: 'MIT' },
    });
    writeFileSync(path.join(root, 'services/c.yaml'), 'meta: {version: "2"}');
    expect(() => loadDataDir('services', root)).toThrow(DataError);
    expect(() => loadDataDir('missing-dir', root)).toThrow(/missing-dir/);
  });
});
