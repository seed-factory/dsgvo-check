import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../../src/checks/browser/legal-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import {
  makeDocument,
  makeLink,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  cmpFacts,
  cmpWith,
  defaultDocuments,
  footerLinks,
  IMPRESSUM,
  PRIVACY,
  page,
  phase,
  START,
  site,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['LEGAL-01']!.find((s) => s.file === file)!.build();
const variantsByKind = (r: ReturnType<typeof runCheck>) =>
  observationsOf(r).map((o) => [o.subject, o.variant]);

describe('LEGAL-01 Impressum and Datenschutzerklärung', () => {
  it('violation: neither link nor hop nor fallback → document-not-found for both kinds', () => {
    const r = runCheck(legal01, scenario('violation-no-documents.json'));
    expect(variantsByKind(r)).toEqual([
      ['impressum', 'document-not-found'],
      ['privacy', 'document-not-found'],
    ]);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      documentKind: 'impressum',
      pageTotal: 2,
      missingCount: 2,
    });
    expect(r.outcome?.coverage).toEqual({ observed: 2, evaluated: 2 });
  });

  it('clean: working links on every evaluated page', () => {
    expect(variantsOf(runCheck(legal01, scenario('clean-footer-links.json')))).toEqual([]);
  });

  it('inconclusive: legal targets blocked, absence not established', () => {
    expect(runCheck(legal01, scenario('inconclusive-targets-blocked.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'legal-targets-not-evaluable',
    });
  });

  it('counterexample: Impressum reachable via Kontakt → found-via-hop-only (warning, medium), not critical', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, [footerLinks()[1]!]),
              page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!]),
            ],
          }),
        ],
        documents: {
          documents: [
            makeDocument({ kind: 'impressum', url: IMPRESSUM, foundVia: 'hop' }),
            defaultDocuments().documents[1]!,
          ],
          attempts: [],
        },
      }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      subject: 'impressum',
      variant: 'reachable-via-intermediate',
      confidence: 'medium',
      params: { foundVia: 'hop', reachableViaHop: true },
    });
    expect(observationsOf(r)).toHaveLength(1);
  });

  it('counterexample: a "#" link without resolved content → link-unresolved (info), not broken', () => {
    const hashLinks = [makeLink({ text: 'Impressum', href: null, hrefKind: 'fragment' }), footerLinks()[1]!];
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, hashLinks), page(CONTACT, 'contact', 'A', {}, hashLinks)],
          }),
        ],
        documents: { documents: [defaultDocuments().documents[1]!], attempts: [] },
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'unresolved']]);
  });

  it('a PDF privacy policy counts as found for LEGAL-01', () => {
    const r = runCheck(
      legal01,
      site({
        documents: {
          documents: [
            defaultDocuments().documents[0]!,
            makeDocument({ kind: 'privacy', url: PRIVACY, format: 'pdf', parts: [], foundVia: 'link' }),
          ],
          attempts: [],
        },
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('a linked PDF that was not fetched (status null, as the collector records it) is found, not missing', () => {
    const pdf = `${START}impressum.pdf`;
    const links = [makeLink({ text: 'Impressum', href: pdf, hrefKind: 'https' }), footerLinks()[1]!];
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        documents: {
          documents: [
            makeDocument({
              kind: 'impressum',
              url: pdf,
              status: null,
              format: 'pdf',
              complete: false,
              errors: ['pdf-not-evaluated'],
              foundVia: 'link',
            }),
            defaultDocuments().documents[1]!,
          ],
          attempts: [],
        },
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: the document page itself does not need a link to itself', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start'),
              page(PRIVACY, 'privacy', 'A', {}, [footerLinks()[0]!]),
              page(IMPRESSUM, 'impressum', 'A', {}, [footerLinks()[1]!]),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('links on some pages missing → link-missing-on-pages with counts', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start'), page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!])],
          }),
        ],
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'link-missing-on-some-pages']]);
    expect(observationsOf(r)[0]).toMatchObject({
      pages: [CONTACT],
      params: { missingCount: 1, pageTotal: 2 },
    });
  });

  it('all links lead to 404 and only a fallback works → links-broken (critical variant)', () => {
    const r = runCheck(
      legal01,
      site({
        documents: {
          documents: [
            makeDocument({ kind: 'impressum', url: `${START}impressum-neu`, foundVia: 'fallback' }),
            defaultDocuments().documents[1]!,
          ],
          attempts: [{ kind: 'impressum', via: 'link', url: IMPRESSUM, status: 404, outcome: 'not-found' }],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'links-broken']]);
  });

  it('the "Impressum" link leads to an ordinary page (HTTP 200, keyword missing) → links-broken, not found', () => {
    // As the collector records it: the document is kept with `keyword-missing`, the link attempt is a soft-404.
    const landing = makeDocument({
      kind: 'impressum',
      id: 'doc-impressum',
      url: IMPRESSUM,
      status: 200,
      foundVia: 'link',
      linkedFrom: [{ pageUrl: START, text: 'Impressum' }],
      errors: ['keyword-missing'],
    });
    const r = runCheck(
      legal01,
      site({
        documents: {
          documents: [landing, defaultDocuments().documents[1]!],
          attempts: [
            { kind: 'impressum', via: 'link', url: IMPRESSUM, status: 200, outcome: 'soft-404' },
            { kind: 'impressum', via: 'hop', url: CONTACT, status: 200, outcome: 'not-found' },
            {
              kind: 'impressum',
              via: 'fallback',
              url: `${START}impressum-x`,
              status: 404,
              outcome: 'not-found',
            },
          ],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'links-broken']]);
  });

  it('a document whose link attempt the collector judged soft-404 is not usable even without the error tag', () => {
    const r = runCheck(
      legal01,
      site({
        documents: {
          documents: [defaultDocuments().documents[0]!, defaultDocuments().documents[1]!],
          attempts: [{ kind: 'impressum', via: 'link', url: IMPRESSUM, status: 200, outcome: 'soft-404' }],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'links-broken']]);
  });

  it('cookie settings link labelled "Datenschutz-Einstellungen" is not a privacy policy link', () => {
    const links = [
      footerLinks()[0]!,
      makeLink({ text: 'Datenschutz-Einstellungen', href: null, hrefKind: 'javascript' }),
    ];
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        // The collector always tries the usual path last; critical rests on that step.
        documents: {
          documents: [defaultDocuments().documents[0]!],
          attempts: [{ kind: 'privacy', via: 'fallback', url: PRIVACY, status: 404, outcome: 'not-found' }],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([['privacy', 'document-not-found']]);
  });

  it('footer covered by the banner without legal links in it → covered-by-banner', () => {
    const facts = cmpFacts({
      firstLayer: {
        bannerPresent: true,
        bannerVisible: true,
        buttons: [],
        purAbo: false,
        closeMeansAccept: null,
        coversFooter: true,
        legalLinks: [{ text: 'Datenschutzerklärung', href: PRIVACY }],
      },
    });
    const r = runCheck(legal01, site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) }));
    expect(variantsByKind(r)).toEqual([['impressum', 'footer-covered-by-banner']]);
  });

  it('links and fallbacks lead to 404 and the legal pages were visited with HTTP 404 → links-broken, not inconclusive', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start'),
              page(IMPRESSUM, 'impressum', 'A', { evaluable: false, notEvaluableReason: 'http-404' }),
              page(PRIVACY, 'privacy', 'A', { evaluable: false, notEvaluableReason: 'http-404' }),
            ],
          }),
        ],
        documents: {
          documents: [],
          attempts: [
            { kind: 'impressum', via: 'link', url: IMPRESSUM, status: 404, outcome: 'not-found' },
            { kind: 'privacy', via: 'link', url: PRIVACY, status: 404, outcome: 'not-found' },
            {
              kind: 'impressum',
              via: 'fallback',
              url: `${START}impressum-x`,
              status: 404,
              outcome: 'not-found',
            },
          ],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([
      ['impressum', 'links-broken'],
      ['privacy', 'links-broken'],
    ]);
  });

  it('legal target behind a challenge (403) → that kind is not evaluable, no critical claim', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start'),
              page(CONTACT, 'contact'),
              page(IMPRESSUM, 'impressum', 'A', {
                evaluable: false,
                notEvaluableReason: 'challenge',
                challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
              }),
            ],
          }),
        ],
        documents: {
          documents: [defaultDocuments().documents[1]!],
          attempts: [{ kind: 'impressum', via: 'link', url: IMPRESSUM, status: 403, outcome: 'not-found' }],
        },
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.limitations).toEqual(['impressum-target-not-evaluable']);
  });

  it('offsite or unverified legal link without a document → link-unresolved (info), not document-not-found', () => {
    const offsite = 'https://www.konzern-beispiel.de/impressum';
    const links = [
      makeLink({ text: 'Impressum', href: offsite, hrefKind: 'https', sameSite: false }),
      footerLinks()[1]!,
    ];
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        documents: {
          documents: [defaultDocuments().documents[1]!],
          attempts: [{ kind: 'impressum', via: 'link', url: offsite, status: null, outcome: 'unresolved' }],
        },
      }),
    );
    expect(variantsByKind(r)).toEqual([['impressum', 'unresolved']]);
  });

  it('no evaluable page → inconclusive', () => {
    const r = runCheck(
      legal01,
      site({ phases: [phase('A', { pages: [page(START, 'start', 'A', { evaluable: false })] })] }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'no-evaluable-pages' });
  });
});

describe('LEGAL-01: an Impressum kept as a section of the privacy policy', () => {
  const texts = (lang: 'de' | 'en', o: { variant: string; params: Record<string, unknown> }) => {
    const t = loadTexts(lang);
    const id = `LEGAL-01.${o.variant}`;
    return {
      body: renderMessage(t, id, o.params as never).body,
      action: formatMessage(t.actions[id]!, o.params as never, lang),
    };
  };

  type Part = { section?: string; text: string };

  /** Only a privacy link on every page; the Impressum is searched for by hop and usual path and not found. */
  function privacyOnly(privacyParts: Part[], contentHeadings?: string[]) {
    const links = [footerLinks()[1]!];
    return runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        documents: {
          documents: [
            makeDocument({
              kind: 'privacy',
              id: 'doc-privacy',
              url: PRIVACY,
              phase: 'A',
              linkedFrom: [{ pageUrl: START, text: 'Datenschutz' }],
              parts: privacyParts.map((p, i) => ({
                id: `p${i}`,
                origin: 'visible',
                sourceUrl: PRIVACY,
                ...p,
              })),
              ...(contentHeadings ? { contentHeadings } : {}),
            }),
          ],
          attempts: [
            { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 404, outcome: 'not-found' },
          ],
        },
      }),
    );
  }

  const policyWith = (heading: string): Part[] => [
    { section: 'Datenschutzerklärung', text: 'Wir verarbeiten Daten.' },
    { section: `Datenschutzerklärung > ${heading}`, text: 'Beispiel GmbH, Musterstraße 1.' },
  ];

  it('names the section and the page; the finding stays document-not-found', () => {
    const r = privacyOnly(policyWith('Impressum'), ['Datenschutzerklärung', 'Impressum']);
    const [o] = observationsOf(r);

    expect(variantsByKind(r)).toEqual([['impressum', 'document-not-found']]);
    expect(o?.params).toMatchObject({
      inOtherDocument: true,
      otherDocument: PRIVACY,
      otherHeading: 'Impressum',
    });
    expect(texts('de', o!).body).toContain(
      `Die gefundene Datenschutzerklärung (${PRIVACY}) enthält einen Abschnitt mit der Überschrift „Impressum“; ein Link, der ihn als Impressum benennt, wurde nicht gefunden.`,
    );
    // The owner report shows the action without the body: it names the page itself.
    expect(texts('de', o!).action).toBe(
      `Verlinken Sie das Impressum gut sichtbar im Seitenfuß jeder Seite, als eigene Seite oder direkt auf den Abschnitt „Impressum“ der Datenschutzerklärung (${PRIVACY}).`,
    );
    expect(texts('en', o!).body).toContain(
      `The privacy policy that was found (${PRIVACY}) contains a section headed “Impressum”; no link naming it as the legal notice was found.`,
    );
    expect(texts('en', o!).action).toContain(
      `directly to the section “Impressum” of the privacy policy (${PRIVACY}).`,
    );
  });

  it('reads the part headings of a snapshot that recorded no content headings', () => {
    const [o] = observationsOf(privacyOnly(policyWith('Anbieterkennzeichnung')));

    expect(o?.params).toMatchObject({ inOtherDocument: true, otherHeading: 'Anbieterkennzeichnung' });
  });

  it.each([
    ['a heading that only starts with an Impressum key', policyWith('Impressumspflicht'), undefined],
    [
      'the word Impressum in the text of a section',
      policyWith('Verantwortliche Stelle').concat({
        section: 'Datenschutzerklärung > Kontakt',
        text: 'Siehe Impressum.',
      }),
      undefined,
    ],
    ['a heading of a footer column only', policyWith('Impressum'), ['Datenschutzerklärung']],
    ['no such section', [{ section: 'Datenschutzerklärung > Cookies', text: 'Cookies.' }], undefined],
  ] as Array<[string, Part[], string[] | undefined]>)(
    'counterexample: %s adds nothing to the finding',
    (_name, parts, content) => {
      const [o] = observationsOf(privacyOnly(parts, content));

      expect(o?.variant).toBe('document-not-found');
      expect(o?.params).toMatchObject({ inOtherDocument: false, otherDocument: null, otherHeading: null });
      expect(texts('de', o!).body).not.toContain('Abschnitt');
      expect(texts('de', o!).action).toBe(
        'Verlinken Sie das Impressum gut sichtbar im Seitenfuß jeder Seite.',
      );
    },
  );

  it('counterexample: a privacy section of the Impressum page is not taken for the privacy policy', () => {
    const links = [footerLinks()[0]!];
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        documents: {
          documents: [
            makeDocument({
              kind: 'impressum',
              id: 'doc-impressum',
              url: IMPRESSUM,
              phase: 'A',
              linkedFrom: [{ pageUrl: START, text: 'Impressum' }],
              parts: [
                {
                  id: 'i1',
                  section: 'Impressum',
                  text: 'Beispiel GmbH.',
                  origin: 'visible',
                  sourceUrl: IMPRESSUM,
                },
                {
                  id: 'i2',
                  section: 'Impressum > Datenschutz',
                  text: 'Die Nutzung dieser Website ist ohne Angabe personenbezogener Daten möglich.',
                  origin: 'visible',
                  sourceUrl: IMPRESSUM,
                },
              ],
            }),
          ],
          attempts: [{ kind: 'privacy', via: 'fallback', url: PRIVACY, status: 404, outcome: 'not-found' }],
        },
      }),
    );
    const [o] = observationsOf(r);

    expect(variantsByKind(r)).toEqual([['privacy', 'document-not-found']]);
    expect(o?.params).toMatchObject({ inOtherDocument: false });
  });
});
