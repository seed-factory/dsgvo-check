/**
 * PRIV-01 and the consent dialog: a service no privacy document names, but that the dialog of a CMP its own adapter
 * recognised names by name or alias (its collapsed service details), is `named-in-cmp-only` (info) instead of
 * `not-named` or `category-only`. The dialog records are made by the collector's own search of the dialog text, so
 * that the check sees what a scan stores: the catalog term that matched, no text. Company, domain and category in the
 * dialog do not count; without dialog mentions the check works as before.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { defaultDocuments, noBannerCmp, PRIVACY, phase, privacyDoc, req, START, site } from '../helpers.ts';
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

function run(
  o: {
    dialog?: string | null;
    parts?: DocumentPart[];
    truncated?: boolean;
    requests?: ReturnType<typeof req>[];
  } = {},
) {
  const dialog = o.dialog === undefined ? BORLABS_DIALOG_TEXT : o.dialog;
  return runCheck(
    priv01,
    site({
      phases: [phase('A', { requests: o.requests ?? [gtm, ads, ga] })],
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

const translate = req('tr', 'https://translate.googleapis.com/translate_a/element.js?cb=init', {
  resourceType: 'script',
});

describe('PRIV-01 services the consent dialog names', () => {
  it('Tag Manager and AdWords in the Cookie-Details, Analytics in no text → named-in-cmp-only twice, not-named once', () => {
    expect(verdicts(run())).toEqual([
      ['google-ads', 'named-in-cmp-only'],
      ['google-analytics', 'not-named'],
      ['google-tag-manager', 'named-in-cmp-only'],
    ]);
  });

  it('the finding names the CMP and the catalog term that matched; medium like not-named, same fingerprint group', () => {
    const o = of(run(), 'google-tag-manager');
    expect(o).toMatchObject({
      confidence: 'medium',
      params: {
        service: 'Google Tag Manager',
        cmp: 'Borlabs Cookie',
        cmpTerm: 'Google Tag Manager',
        categoryOnly: false,
        policyUrl: PRIVACY,
      },
    });
    expect(of(run(), 'google-ads')?.params.cmpTerm).toBe('Google AdWords');
    expect(variantGroupOf(priv01, 'named-in-cmp-only')).toBe(variantGroupOf(priv01, 'not-named'));

    const cmp = o?.evidence.find((e) => e.type === 'cmp');
    const match = o?.evidence.find((e) => e.type === 'text-match');
    expect(cmp).toMatchObject({
      cmpId: 'borlabs',
      version: '3.2.1',
      recognitionConfidence: 'high',
      page: START,
    });
    expect(match).toEqual({
      type: 'text-match',
      documentId: 'cmp-dialog',
      section: null,
      quote: 'Google Tag Manager',
      matchLevel: 'named',
      negation: 'none',
      phase: 'A',
      page: START,
    });
    for (const ev of o?.evidence ?? [])
      expect(() => EvidenceSchema.parse({ id: 'ev-1', ...ev })).not.toThrow();
  });

  it('nothing of the dialog text beyond the catalog terms reaches the observations', () => {
    const json = JSON.stringify(observationsOf(run()));
    for (const text of ['zqx', 'Gordon House', 'Ereignisbehandlung', 'Einwilligungs-ID', 'Cookie Laufzeit'])
      expect(json).not.toContain(text);
  });

  it.each([
    ['with hyphens', 'Name Google-Tag-Manager Anbieter', [gtm], 'google-tag-manager', 'Google Tag Manager'],
    [
      'after Google AdSense',
      'Name Google AdSense Anbieter Google. Name Google Ads Anbieter',
      [ads],
      'google-ads',
      'Google Ads',
    ],
    [
      'with umlauts spelled out',
      'Name Google Uebersetzer Anbieter',
      [translate],
      'google-translate',
      'Google Übersetzer',
    ],
    [
      'with a combining mark',
      'Name Google U\u0308bersetzer Anbieter',
      [translate],
      'google-translate',
      'Google Übersetzer',
    ],
  ])(
    'a name the dialog writes %s is found; the term is the catalog spelling',
    (_, text, requests, subject, term) => {
      const o = of(run({ dialog: `Cookie-Details ${text}`, requests }), subject);
      expect(o).toMatchObject({ variant: 'named-in-cmp-only', params: { cmpTerm: term } });
    },
  );

  it('a name that only begins a longer one is no mention: Google Ads in Google AdSense', () => {
    const text = 'Cookie-Details Name Google AdSense Anbieter Google Ireland Limited';
    expect(of(run({ dialog: text, requests: [ads] }), 'google-ads')?.variant).toBe('not-named');
  });

  it.each([
    ['its provider', 'Cookie-Details Name Statistik Anbieter Google Ireland Limited'],
    ['its domain', 'Cookie-Details Skript von www.googletagmanager.com'],
    ['its category', 'Cookie-Details Tag-Manager Tag Management'],
  ])('counterexample: a dialog that names only %s leaves the Tag Manager not-named', (_, text) => {
    expect(of(run({ dialog: text }), 'google-tag-manager')?.variant).toBe('not-named');
  });

  it('a term that is not one of the service names (an edited record) is no mention', () => {
    const cmp = borlabsDialog(BORLABS_DIALOG_TEXT);
    cmp.dialogMentions!.services = [{ serviceId: 'google-tag-manager', term: 'zqxabcde-fghijklm' }];
    const r = runCheck(
      priv01,
      site({ phases: [phase('A', { requests: [gtm] })], documents: withPolicy([]), cmp }),
    );
    expect(verdicts(r)).toEqual([['google-tag-manager', 'not-named']]);
    expect(JSON.stringify(observationsOf(r))).not.toContain('zqx');
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

  it('without dialog mentions the verdicts are those of the policy alone', () => {
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

  it('a dialog whose text could not be read: partial with cmp-dialog-unread while a service stays unnamed', () => {
    const failed = (parts: DocumentPart[]) =>
      runCheck(
        priv01,
        site({
          phases: [phase('A', { requests: [gtm] })],
          documents: withPolicy(parts),
          cmp: { ...noBannerCmp(), dialogMentionsFailed: true },
        }),
      );
    const unread = failed([]);
    expect(unread).toMatchObject({ status: 'partial' });
    expect(unread.outcome?.limitations).toEqual(['cmp-dialog-unread']);
    expect(verdicts(unread)).toEqual([['google-tag-manager', 'not-named']]);

    const named = failed([policyPart('Wir setzen den Google Tag Manager ein.')]);
    expect(named.status).toBe('completed');
    expect(named.outcome?.limitations ?? []).toEqual([]);
  });

  it.each(['de', 'en'] as const)(
    '%s: title and body name the service, the CMP and the catalog term',
    (lang) => {
      const o = of(run(), 'google-ads')!;
      const m = renderMessage(loadTexts(lang), 'PRIV-01.named-in-cmp-only', o.params);
      expect(m.title).toContain('Google Ads');
      expect(m.title).toContain('(Borlabs Cookie)');
      expect(m.body).toContain('Google AdWords');
      expect(m.body).toContain(PRIVACY);
      expect(`${m.title} ${m.body}`).not.toMatch(/[{}]/);
    },
  );

  it('de: the title states the facts in the agreed wording', () => {
    const o = of(run(), 'google-tag-manager')!;
    expect(renderMessage(loadTexts('de'), 'PRIV-01.named-in-cmp-only', o.params).title).toBe(
      'Nicht gefunden in der Datenschutzerklärung, in den Angaben des Einwilligungsbanners (Borlabs Cookie) genannt: ' +
        'Google Tag Manager',
    );
  });
});

describe('PRIV-01 dialog mentions of a saved snapshot', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'priv01-dialog-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const replay = async (cmp: Record<string, unknown>) => {
    const snap = site({ phases: [phase('A', { requests: [gtm] })] });
    const saved = { ...toSavedSnapshot(snap), cmp: { ...noBannerCmp(), ...cmp } };
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(saved));
    const { report, snapshot } = await scan({
      fromSnapshot: file,
      registry: new CheckRegistry([priv01]),
      now: () => FIXED_NOW,
      log: silentLogger,
    });
    return {
      findings: report.findings ?? [],
      cmp: snapshot?.cmp,
      json: JSON.stringify({ report, snapshot }),
    };
  };
  const mentions = () => borlabsDialog(BORLABS_DIALOG_TEXT).dialogMentions!;

  it('mentions in the shape of the schema are read: the finding is that of the scan', async () => {
    const { findings, cmp } = await replay({ dialogMentions: mentions() });
    expect(findings.map((f) => [f.variant, f.params.cmpTerm])).toEqual([
      ['named-in-cmp-only', 'Google Tag Manager'],
    ]);
    expect(cmp?.dialogMentions).toEqual(mentions());
  });

  it.each([
    ['an unknown CMP', { ...mentions(), cmpId: 'unknown-cmp' }],
    ['a field the collector does not write', { ...mentions(), text: 'Ihre Einwilligungs-ID: zqxkpxrlmqa' }],
    [
      'a mention with a field of its own',
      {
        ...mentions(),
        services: [{ serviceId: 'google-tag-manager', term: 'Google Tag Manager', quote: 'zqx' }],
      },
    ],
  ])('mentions with %s are dropped: the verdict is that of the policy alone', async (_, edited) => {
    const { findings, cmp, json } = await replay({ dialogMentions: edited });
    expect(findings.map((f) => f.variant)).toEqual(['not-named']);
    expect(cmp?.dialogMentions).toBeUndefined();
    expect(json).not.toContain('zqx');
  });

  it('page text that a file holds under another key of the CMP section is not carried on', async () => {
    const { findings, cmp, json } = await replay({
      bannerText: { text: 'Name Google Tag Manager Ihre Einwilligungs-ID: zqxkpxrlmqa' },
      dialogMentionsFailed: true,
    });
    expect(Object.keys(cmp ?? {}).sort()).toEqual(['dialogMentionsFailed', 'phases']);
    expect(findings.map((f) => f.variant)).toEqual(['not-named']);
    expect(json).not.toContain('zqx');
  });
});
