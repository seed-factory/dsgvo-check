import { describe, expect, it } from 'vitest';
import { matchLevel, normalizeText, priv01 } from '../../../../src/checks/browser/priv-01.ts';
import type { DocumentPart } from '../../../../src/collectors/browser/types.ts';
import { loadServiceCatalog } from '../../../../src/derive/catalog.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { defaultDocuments, PRIVACY, phase, privacyDoc, req, site } from './helpers.ts';
import { SCENARIOS } from './scenarios.ts';

const scenario = (file: string) => SCENARIOS['PRIV-01']!.find((s) => s.file === file)!.build();
const part = (text: string, origin: DocumentPart['origin'] = 'visible'): DocumentPart => ({
  id: `p-${text.length}-${origin}`,
  text,
  origin,
  sourceUrl: PRIVACY,
});
const trustindex = () =>
  phase('A', { requests: [req('a', 'https://cdn.trustindex.io/loader.js?wp-widget')] });
const withPolicy = (parts: DocumentPart[], p = {}) =>
  site({
    phases: [trustindex()],
    documents: { documents: [defaultDocuments().documents[0]!, privacyDoc(parts, p)], attempts: [] },
  });

describe('PRIV-01 service not found in the privacy policy', () => {
  it('violation: Trustindex not named → not-named, medium confidence (negations not parsed)', () => {
    const r = runCheck(priv01, scenario('violation-trustindex-not-named.json'));
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'not-named',
      confidence: 'medium',
      subject: 'trustindex',
      params: { service: 'Trustindex', policyUrl: PRIVACY, category: 'reviews' },
      provider: { name: 'Trustindex Kft.', country: 'HU' },
    });
    expect(o?.evidence[0]).toMatchObject({ type: 'document', kind: 'privacy', complete: true });
  });

  it('clean: operator named in an expandable frame part (company level)', () => {
    expect(variantsOf(runCheck(priv01, scenario('clean-operator-in-frame.json')))).toEqual([]);
  });

  it('inconclusive: PDF only', () => {
    expect(runCheck(priv01, scenario('inconclusive-pdf.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'pdf-not-evaluated',
    });
  });

  it('inconclusive: a linked PDF policy that was not fetched (status null) is still a PDF, not "not found"', () => {
    const r = runCheck(
      priv01,
      site({
        phases: [trustindex()],
        documents: {
          documents: [
            privacyDoc([], {
              url: 'https://www.example.de/datenschutz.pdf',
              status: null,
              format: 'pdf',
              complete: false,
              errors: ['pdf-not-evaluated'],
            }),
          ],
          attempts: [],
        },
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'pdf-not-evaluated' });
  });

  it('counterexample: only a category description → category-only (info) with a quote ≤ 200 chars', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Wir zeigen Kundenbewertungen über ein externes Bewertungs-Widget an.')]),
    );
    const [o] = observationsOf(r);
    expect(o?.variant).toBe('category-only');
    const match = o?.evidence.find((e) => e.type === 'text-match');
    expect(match).toMatchObject({ matchLevel: 'category', negation: 'none' });
    expect((match as { quote: string }).quote.length).toBeLessThanOrEqual(200);
  });

  it('counterexample: brand only in a hidden-irrelevant template part is not "named" → hidden-only (info)', () => {
    const r = runCheck(
      priv01,
      withPolicy([
        part('Datenschutzerklärung der Beispiel GmbH.'),
        part('Trustindex Widget Vorlage', 'hidden-irrelevant'),
      ]),
    );
    expect(variantsOf(r)).toEqual(['ambiguous-match']);
  });

  it('named and domain levels count as found', () => {
    expect(variantsOf(runCheck(priv01, withPolicy([part('Wir nutzen Trust­index (Bewertungen).')])))).toEqual(
      [],
    );
    expect(
      variantsOf(runCheck(priv01, withPolicy([part('Daten werden an trustindex.io übertragen.')]))),
    ).toEqual([]);
  });

  it('expandable parts not opened (banner open) → partial with limitation', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Trustindex')], {
        manifest: {
          expandablesFound: 3,
          expandablesOpened: 0,
          framesIncluded: 0,
          linkedPages: 0,
          textLength: 10,
        },
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['banner-open']);
  });

  it('no privacy policy → inconclusive (LEGAL-01 reports it); incomplete or foreign language → inconclusive', () => {
    const none = runCheck(
      priv01,
      site({ phases: [trustindex()], documents: { documents: [], attempts: [] } }),
    );
    expect(none).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(runCheck(priv01, withPolicy([part('x')], { complete: false }))).toMatchObject({
      reason: 'document-incomplete',
    });
    expect(runCheck(priv01, withPolicy([part('x')], { lang: 'fr' }))).toMatchObject({
      reason: 'language-unsupported',
    });
  });

  it('S-24: a "Datenschutz" link target judged not a policy (keyword missing) is not searched → no not-named', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Willkommen in unserem Shop.')], { errors: ['keyword-missing'] }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('services that were not loaded or are not policy-relevant are not evaluated', () => {
    const r = runCheck(
      priv01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://cdn.trustindex.io/loader.js', { state: 'failed' }),
              req('b', 'https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js'),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('normalisation: NFKC, case, umlauts, soft hyphen, punctuation', () => {
    expect(normalizeText('Goo­gle-Analytics, „Übersicht“')).toBe(' google analytics uebersicht ');
    const info = loadServiceCatalog().info('google-analytics')!;
    expect(matchLevel(info, normalizeText('Wir nutzen GOOGLE ANALYTICS.')).level).toBe('named');
    expect(matchLevel(info, normalizeText('Anbieter ist die Google Ireland Limited.')).level).toBe('company');
    expect(matchLevel(info, normalizeText('Reichweitenmessung mit einem Analysetool')).level).toBe(
      'category',
    );
    expect(matchLevel(info, normalizeText('Nichts davon.')).level).toBe('none');
  });
});
