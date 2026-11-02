import { describe, expect, it } from 'vitest';
import { matchLevel, normalizeText, priv01 } from '../../../../src/checks/browser/priv-01.ts';
import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../../../src/collectors/browser/types.ts';
import { EvidenceSchema } from '../../../../src/core/report-schema.ts';
import { loadServiceCatalog } from '../../../../src/derive/catalog.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { defaultDocuments, PRIVACY, phase, privacyDoc, req, site } from './helpers.ts';
import { SCENARIOS } from './scenarios.ts';

const scenario = (file: string) => SCENARIOS['PRIV-01']!.find((s) => s.file === file)!.build();
const part = (text: string, origin: DocumentPart['origin'] = 'visible', section?: string): DocumentPart => ({
  id: `p-${text.length}-${origin}`,
  ...(section ? { section } : {}),
  text,
  origin,
  sourceUrl: PRIVACY,
});
const trustindex = () =>
  phase('A', { requests: [req('a', 'https://cdn.trustindex.io/loader.js?wp-widget')] });
const withPolicy = (
  parts: DocumentPart[],
  p: Partial<DocumentRecord> = {},
  attempts: DocumentsSection['attempts'] = [],
) =>
  site({
    phases: [trustindex()],
    documents: { documents: [defaultDocuments().documents[0]!, privacyDoc(parts, p)], attempts },
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

  it('a "Datenschutz" link target judged not a policy (keyword missing) is not searched → no not-named', () => {
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

describe('PRIV-01 policy availability and completeness', () => {
  const unopened = {
    expandablesFound: 1,
    expandablesOpened: 0,
    framesIncluded: 0,
    linkedPages: 0,
    textLength: 40,
  };
  interface PolicyCase {
    name: string;
    parts: DocumentPart[];
    document: Partial<DocumentRecord>;
    attempts?: DocumentsSection['attempts'];
    status: 'completed' | 'partial' | 'inconclusive';
    reason?: string;
    variants?: string[];
    limitations?: string[];
  }
  it.each<PolicyCase>([
    {
      name: 'a stored document tagged unconfirmed is not searched',
      parts: [part('Willkommen in unserem Shop.')],
      document: { errors: ['unconfirmed'], complete: false },
      status: 'inconclusive',
      reason: 'privacy-policy-not-found',
      variants: [],
    },
    {
      name: 'an unconfirmed link attempt invalidates the stored policy',
      parts: [part('Willkommen in unserem Shop.')],
      document: {},
      attempts: [{ kind: 'privacy', via: 'link', url: PRIVACY, status: 200, outcome: 'unconfirmed' }],
      status: 'inconclusive',
      reason: 'privacy-policy-not-found',
    },
    {
      name: 'Portuguese policy markers are unsupported',
      parts: [part('Utilizamos o Trustindex.', 'visible', 'Aviso de Privacidade')],
      document: { lang: 'pt' },
      status: 'inconclusive',
      reason: 'language-unsupported',
    },
    {
      name: 'German policy markers are evaluated despite an English lang attribute',
      parts: [part('Wir nutzen einen Dienst.', 'visible', 'Datenschutzerklärung')],
      document: { lang: 'en' },
      status: 'completed',
      variants: ['not-named'],
    },
    {
      name: 'an unopened expandable policy remains searchable with a limitation',
      parts: [part('Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.')],
      document: { errors: ['expand-failed'], complete: false, manifest: unopened },
      status: 'partial',
      limitations: ['banner-open'],
      variants: ['not-named'],
    },
    {
      name: 'expand-failed with truncation prevents policy evaluation',
      parts: [part('Datenschutzerklärung.')],
      document: { errors: ['expand-failed', 'truncated'], complete: false, manifest: unopened },
      status: 'inconclusive',
      reason: 'document-incomplete',
    },
    {
      name: 'truncation alone prevents policy evaluation',
      parts: [part('x')],
      document: { errors: ['truncated'], complete: false },
      status: 'inconclusive',
      reason: 'document-incomplete',
    },
  ])('$name', ({ parts, document, attempts, status, reason, variants, limitations }) => {
    const result = runCheck(priv01, withPolicy(parts, document, attempts));
    expect(result.status).toBe(status);
    if (reason) expect(result.reason).toBe(reason);
    if (variants) expect(variantsOf(result)).toEqual(variants);
    if (limitations) expect(result.outcome?.limitations).toEqual(limitations);
  });

  it('a failed policy navigation yields no document and no finding', () => {
    const result = runCheck(
      priv01,
      site({
        phases: [trustindex()],
        documents: {
          documents: [defaultDocuments().documents[0]!],
          attempts: [{ kind: 'privacy', via: 'link', url: PRIVACY, status: null, outcome: 'error' }],
        },
      }),
    );
    expect(result).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(result)).toEqual([]);
  });
});

describe('PRIV-01 negative search evidence', () => {
  const manifest = {
    expandablesFound: 3,
    expandablesOpened: 3,
    framesIncluded: 2,
    linkedPages: 0,
    textLength: 1234,
  };
  const parts = [
    part('Datenschutzerklärung der Beispiel GmbH.', 'visible', '1 > Verantwortlicher'),
    part('Wir setzen Dienste ein.', 'visible', '2 > Dienste'),
    part('Weitere Hinweise.', 'expandable', '2 > Dienste'),
    part('Rahmen.', 'frame'),
  ];
  const expectedManifest = { partCount: 4, ...manifest, truncated: false };
  it.each(['document evidence', 'schema roundtrip', 'message parameters'] as const)(
    'preserves completeness in %s',
    (projection) => {
      const result = runCheck(priv01, withPolicy(parts, { manifest }));
      const observation = observationsOf(result)[0];
      if (projection === 'document evidence') {
        expect(observation?.variant).toBe('not-named');
        expect(observation?.evidence[0]).toMatchObject({ type: 'document', manifest: expectedManifest });
      } else if (projection === 'schema roundtrip') {
        const parsed = EvidenceSchema.parse({ id: 'ev-1', ...observation?.evidence[0] });
        expect(JSON.parse(JSON.stringify(parsed)).manifest).toEqual(expectedManifest);
      } else {
        expect(observation?.params).toMatchObject({ partCount: 4, complete: true });
      }
    },
  );
});
