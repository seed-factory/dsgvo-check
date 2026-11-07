/**
 * PRIV-01 and the text of the consent dialog: a service no privacy document names, but that the dialog of a CMP its own
 * adapter recognised names by name or alias (its collapsed service details), is `named-in-cmp-only` (info) instead of
 * `not-named` or `category-only`. Company, domain and category in the dialog do not count; without dialog text the
 * check works as before.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { priv01 } from '../../../../../src/checks/browser/priv-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import { variantGroupOf } from '../../../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../../../src/core/evaluation/registry.ts';
import { EvidenceSchema } from '../../../../../src/core/report/schema.ts';
import { silentLogger } from '../../../../../src/core/runtime/logger.ts';
import type { DocumentPart } from '../../../../../src/core/snapshot/browser.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { toSavedSnapshot } from '../../../../../src/core/snapshot/index.ts';
import { scan } from '../../../../../src/scan.ts';
import { FIXED_NOW, observationsOf, runCheck } from '../../../../utils/snapshot-builder.ts';
import { defaultDocuments, PRIVACY, phase, privacyDoc, req, START, site } from '../helpers.ts';
import { BORLABS_DIALOG_TEXT, borlabsDialog } from '../scenarios/priv-01.ts';

const gtm = req('gtm', 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST1');
const ads = req('ads', 'https://www.googleadservices.com/pagead/conversion/123/', { resourceType: 'image' });
const ga = req('ga', 'https://www.googletagmanager.com/gtag/js?id=G-TEST1');

const policyPart = (text: string, origin: DocumentPart['origin'] = 'visible'): DocumentPart => ({
  id: `p-${text.length}-${origin}`,
  text,
  origin,
  sourceUrl: PRIVACY,
});
const withPolicy = (parts: DocumentPart[]) => ({
  documents: [
    defaultDocuments().documents[0]!,
    privacyDoc([policyPart('Datenschutzerklärung der Beispiel GmbH.'), ...parts]),
  ],
  attempts: [],
});

function run(o: { dialog?: string | null; parts?: DocumentPart[]; truncated?: boolean } = {}) {
  const dialog = o.dialog === undefined ? BORLABS_DIALOG_TEXT : o.dialog;
  return runCheck(
    priv01,
    site({
      phases: [phase('A', { requests: [gtm, ads, ga] })],
      documents: withPolicy(o.parts ?? []),
      ...(dialog !== null ? { cmp: borlabsDialog(dialog, { truncated: o.truncated ?? false }) } : {}),
    }),
  );
}

const verdicts = (r: ReturnType<typeof runCheck>) =>
  observationsOf(r)
    .map((o) => [o.subject, o.variant])
    .sort();
const of = (r: ReturnType<typeof runCheck>, subject: string) =>
  observationsOf(r).find((o) => o.subject === subject);

describe('PRIV-01 services the consent dialog names', () => {
  it('Tag Manager and AdWords in the Cookie-Details, Analytics in no text → named-in-cmp-only twice, not-named once', () => {
    expect(verdicts(run())).toEqual([
      ['google-ads', 'named-in-cmp-only'],
      ['google-analytics', 'not-named'],
      ['google-tag-manager', 'named-in-cmp-only'],
    ]);
  });

  it('the finding names the CMP and quotes the passage of the dialog; medium like not-named, same fingerprint group', () => {
    const o = of(run(), 'google-tag-manager');
    expect(o).toMatchObject({
      confidence: 'medium',
      params: {
        service: 'Google Tag Manager',
        cmp: 'Borlabs Cookie',
        categoryOnly: false,
        policyUrl: PRIVACY,
      },
    });
    const quote = o?.params.cmpQuote as string;
    expect(quote).toContain('Name Google Tag Manager Anbieter Google Ireland Limited');
    expect(quote.length).toBeLessThanOrEqual(122);
    expect(quote).toMatch(/^….*…$/);
    expect(variantGroupOf(priv01, 'named-in-cmp-only')).toBe(variantGroupOf(priv01, 'not-named'));

    const cmp = o?.evidence.find((e) => e.type === 'cmp');
    const match = o?.evidence.find((e) => e.type === 'text-match');
    expect(cmp).toMatchObject({
      cmpId: 'borlabs',
      version: '3.2.1',
      recognitionConfidence: 'high',
      page: START,
    });
    expect(match).toMatchObject({ documentId: 'cmp-dialog', matchLevel: 'named', negation: 'none', quote });
    for (const ev of o?.evidence ?? [])
      expect(() => EvidenceSchema.parse({ id: 'ev-1', ...ev })).not.toThrow();
  });

  it('a name the dialog writes with hyphens is quoted where it stands', () => {
    const text = `${'Wir nutzen Cookies. '.repeat(10)}Name Google-Tag-Manager Anbieter Google Ireland Limited`;
    const quote = of(run({ dialog: text }), 'google-tag-manager')?.params.cmpQuote as string;
    expect(quote).toContain('Google-Tag-Manager');
    expect(quote.startsWith('…')).toBe(true);
  });

  it.each([
    ['its provider', 'Cookie-Details Name Statistik Anbieter Google Ireland Limited'],
    ['its domain', 'Cookie-Details Skript von www.googletagmanager.com'],
    ['its category', 'Cookie-Details Tag-Manager Tag Management'],
  ])('counterexample: a dialog that names only %s leaves the Tag Manager not-named', (_, text) => {
    expect(of(run({ dialog: text }), 'google-tag-manager')?.variant).toBe('not-named');
  });

  it('a policy that describes only the category: named-in-cmp-only, the category passage stays in the evidence', () => {
    const o = of(run({ parts: [policyPart('Wir verwenden einen Tag Manager.')] }), 'google-tag-manager');
    expect(o).toMatchObject({ variant: 'named-in-cmp-only', params: { categoryOnly: true } });
    expect(o?.evidence.filter((e) => e.type === 'text-match').map((e) => e.matchLevel)).toEqual([
      'named',
      'category',
    ]);
    expect(renderMessage(loadTexts('de'), 'PRIV-01.named-in-cmp-only', o!.params).body).toContain(
      'nicht gefunden, nur eine Beschreibung der Kategorie.',
    );
  });

  it('the policy names the service: nothing, whatever the dialog says', () => {
    const r = run({ parts: [policyPart('Wir setzen den Google Tag Manager und Google Ads ein.')] });
    expect(verdicts(r)).toEqual([['google-analytics', 'not-named']]);
  });

  it('a name only in a hidden part of the policy stays ambiguous-match: the policy may name it', () => {
    const r = run({ parts: [policyPart('Google Tag Manager Vorlage', 'hidden-irrelevant')] });
    expect(of(r, 'google-tag-manager')?.variant).toBe('ambiguous-match');
  });

  it('without dialog text the verdicts are those of the policy alone', () => {
    expect(verdicts(run({ dialog: null }))).toEqual([
      ['google-ads', 'not-named'],
      ['google-analytics', 'not-named'],
      ['google-tag-manager', 'not-named'],
    ]);
    const snap = site({ phases: [phase('A', { requests: [gtm] })] });
    const { cmp: _, ...withoutCmp } = snap;
    expect(verdicts(runCheck(priv01, withoutCmp as Snapshot))).toEqual([['google-tag-manager', 'not-named']]);
  });

  it('a dialog cut at its limit: partial with cmp-dialog-truncated while a service stays unnamed', () => {
    const cut = run({ truncated: true });
    expect(cut).toMatchObject({ status: 'partial' });
    expect(cut.outcome?.limitations).toEqual(['cmp-dialog-truncated']);

    const allNamed = run({ truncated: true, parts: [policyPart('Wir nutzen Google Analytics.')] });
    expect(allNamed.status).toBe('completed');
    expect(allNamed.outcome?.limitations ?? []).toEqual([]);
  });

  it.each(['de', 'en'] as const)('%s: title and body name the service, the CMP and the quote', (lang) => {
    const o = of(run(), 'google-tag-manager')!;
    const m = renderMessage(loadTexts(lang), 'PRIV-01.named-in-cmp-only', o.params);
    expect(m.title).toContain('Google Tag Manager');
    expect(m.title).toContain('(Borlabs Cookie)');
    expect(m.body).toContain(o.params.cmpQuote as string);
    expect(m.body).toContain(PRIVACY);
    expect(`${m.title} ${m.body}`).not.toMatch(/[{}]/);
  });
});

describe('PRIV-01 dialog text of a saved snapshot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'priv01-dialog-'));
  const replay = async (dialogText: unknown) => {
    const snap = site({ phases: [phase('A', { requests: [gtm] })], cmp: borlabsDialog(BORLABS_DIALOG_TEXT) });
    const saved = { ...toSavedSnapshot(snap), cmp: { ...snap.cmp, dialogText } };
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(saved));
    const { report, snapshot } = await scan({
      fromSnapshot: file,
      registry: new CheckRegistry([priv01]),
      now: () => FIXED_NOW,
      log: silentLogger,
    });
    return { findings: report.findings ?? [], dialogText: snapshot?.cmp?.dialogText };
  };

  it('a consent ID that an edited file holds next to the name is redacted on reading; the finding stays', async () => {
    const edited = {
      ...borlabsDialog(BORLABS_DIALOG_TEXT).dialogText,
      text: 'Cookie-Details Name Google Tag Manager Ihre Einwilligungs-ID: zq7Kp2Xr9Lm4Qa8Zt1Wn6Yb3 Anbieter Google',
    };
    const { findings, dialogText } = await replay(edited);
    expect(findings.map((f) => f.variant)).toEqual(['named-in-cmp-only']);
    expect(findings[0]?.params.cmpQuote).toContain('Einwilligungs-ID: [redacted]');
    expect(JSON.stringify(findings)).not.toContain('zq7');
    expect(dialogText?.text).not.toContain('zq7');
  });

  it('dialog text that does not fit the schema is dropped: the verdict is that of the policy alone', async () => {
    const wrong = { ...borlabsDialog(BORLABS_DIALOG_TEXT).dialogText, cmpId: 'unknown-cmp' };
    const { findings, dialogText } = await replay(wrong);
    expect(findings.map((f) => f.variant)).toEqual(['not-named']);
    expect(dialogText).toBeUndefined();
  });
});
