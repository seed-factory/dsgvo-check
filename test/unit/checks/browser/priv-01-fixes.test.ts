/**
 * PRIV-01 L1 tests for the canary-2 triage: G20 (unconfirmed type, language by markers), G23 (expandable parts
 * that were not opened → partial with banner-open, not inconclusive), G28 (manifest in the evidence of a negative
 * search and in the message parameters).
 */
import { describe, expect, it } from 'vitest';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../../../src/collectors/browser/types.ts';
import { EvidenceSchema } from '../../../../src/core/report-schema.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { defaultDocuments, PRIVACY, phase, privacyDoc, req, site } from './helpers.ts';

const part = (text: string, section?: string, origin: DocumentPart['origin'] = 'visible'): DocumentPart => ({
  id: `p-${text.length}-${origin}-${section ?? ''}`,
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

describe('G20: a page whose type is not confirmed is no policy', () => {
  it('a document tagged unconfirmed is not searched: privacy-policy-not-found, no not-named', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Willkommen in unserem Shop.')], { errors: ['unconfirmed'], complete: false }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('a link attempt recorded as unconfirmed makes the stored page no policy either', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Willkommen in unserem Shop.')], {}, [
        {
          kind: 'privacy',
          via: 'link',
          url: PRIVACY,
          status: 200,
          outcome: 'unconfirmed' as unknown as 'found',
        },
      ]),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
  });

  it('a policy recorded in a foreign language (by markers, not by the lang attribute) → language-unsupported', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Utilizamos o Trustindex.', 'Aviso de Privacidade')], { lang: 'pt' }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'language-unsupported' });
  });

  it('counterexample: lang="en" with German markers is evaluated', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Wir nutzen einen Dienst.', 'Datenschutzerklärung')], { lang: 'en' }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['not-named']);
  });
});

describe('G23: unopened expandable parts are a limitation, not a reason to stop', () => {
  const unopened = {
    expandablesFound: 1,
    expandablesOpened: 0,
    framesIncluded: 0,
    linkedPages: 0,
    textLength: 40,
  };

  it('expand-failed alone → partial with banner-open and the search is carried out', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.')], {
        errors: ['expand-failed'],
        complete: false,
        manifest: unopened,
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['banner-open']);
    expect(variantsOf(r)).toEqual(['not-named']);
  });

  it('counterexample: expand-failed together with another error still stops (document-incomplete)', () => {
    const r = runCheck(
      priv01,
      withPolicy([part('Datenschutzerklärung.')], {
        errors: ['expand-failed', 'truncated'],
        complete: false,
        manifest: unopened,
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'document-incomplete' });
  });

  it('counterexample: truncation alone is still document-incomplete', () => {
    const r = runCheck(priv01, withPolicy([part('x')], { errors: ['truncated'], complete: false }));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'document-incomplete' });
  });
});

describe('G55: a failed navigation to the policy yields no document to search', () => {
  it('attempt error and no stored document → privacy-policy-not-found, no finding', () => {
    const r = runCheck(
      priv01,
      site({
        phases: [trustindex()],
        documents: {
          documents: [defaultDocuments().documents[0]!],
          attempts: [{ kind: 'privacy', via: 'link', url: PRIVACY, status: null, outcome: 'error' }],
        },
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('G28: the evidence of a negative search carries the manifest', () => {
  const manifest = {
    expandablesFound: 3,
    expandablesOpened: 3,
    framesIncluded: 2,
    linkedPages: 0,
    textLength: 1234,
  };
  const parts = [
    part('Datenschutzerklärung der Beispiel GmbH.', '1 > Verantwortlicher'),
    part('Wir setzen Dienste ein.', '2 > Dienste'),
    part('Weitere Hinweise.', '2 > Dienste', 'expandable'),
    part('Rahmen.', undefined, 'frame'),
  ];

  it('not-named: the document evidence has the counters of the snapshot manifest', () => {
    const r = runCheck(priv01, withPolicy(parts, { manifest }));
    const [o] = observationsOf(r);
    expect(o?.variant).toBe('not-named');
    const ev = o?.evidence[0];
    expect(ev).toMatchObject({
      type: 'document',
      manifest: {
        partCount: 4,
        textLength: 1234,
        expandablesFound: 3,
        expandablesOpened: 3,
        framesIncluded: 2,
        linkedPages: 0,
        truncated: false,
      },
    });
  });

  it('the manifest survives the report schema and serialisation', () => {
    const r = runCheck(priv01, withPolicy(parts, { manifest }));
    const ev = observationsOf(r)[0]?.evidence[0];
    const parsed = EvidenceSchema.parse({ id: 'ev-1', ...ev });
    const round = JSON.parse(JSON.stringify(parsed));
    expect(round.manifest).toEqual({
      partCount: 4,
      textLength: 1234,
      expandablesFound: 3,
      expandablesOpened: 3,
      framesIncluded: 2,
      linkedPages: 0,
      truncated: false,
    });
  });

  it('not-named: the message parameters carry the part count and the completeness', () => {
    const r = runCheck(priv01, withPolicy(parts, { manifest }));
    expect(observationsOf(r)[0]?.params).toMatchObject({ partCount: 4, complete: true });
  });
});
