import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../../src/checks/browser/legal-01.ts';
import { parseConfigInput } from '../../../../../src/core/config/load.ts';
import { checkThresholds } from '../../../../../src/core/config/thresholds.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import type { DocumentRecord, DocumentsSection } from '../../../../../src/core/snapshot/browser.ts';
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
import { scenariosOf } from '../scenarios/index.ts';
import { candidate, unlinkedImpressum } from '../scenarios/legal-01.ts';

const scenario = (file: string) =>
  scenariosOf('LEGAL-01')
    .find((s) => s.file === file)!
    .build();
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

describe('LEGAL-01: provider details of an Impressum without a link that names them', () => {
  const texts = (lang: 'de' | 'en', o: { variant: string; params: Record<string, unknown> }) => {
    const t = loadTexts(lang);
    const id = `LEGAL-01.${o.variant}`;
    return {
      ...renderMessage(t, id, o.params as never),
      action: formatMessage(t.actions[id]!, o.params as never, lang),
    };
  };
  const impressum = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).find((o) => o.subject === 'impressum');
  const withMinGroups = (impressumMinGroups: number) => ({
    thresholds: checkThresholds(parseConfigInput({ legal: { impressumMinGroups } })),
  });

  /** Register entry, representative, VAT ID, statement under § 5 DDG and the person responsible, one kind per entry. */
  const KINDS = [
    'Amtsgericht Musterstadt, HRB 12345.',
    'Geschäftsführung: Erika Mustermann.',
    'USt-IdNr.: DE123456789.',
    'Angaben gemäß § 5 DDG.',
    'Verantwortlich für den Inhalt: Max Muster.',
  ];
  const detailsOf = (n: number) =>
    `Beispiel GmbH, Musterstraße 1, 10115 Berlin. ${KINDS.slice(0, n).join(' ')}`;
  const onContact = (text: string, section?: string) =>
    unlinkedImpressum({ candidates: [candidate(CONTACT, [{ ...(section ? { section } : {}), text }])] });

  it('details in the footer of the policy page: warning variant, medium, with the place and the section', () => {
    const r = runCheck(legal01, scenario('violation-impressum-details-in-footer.json'));
    const o = impressum(r);

    expect(variantsByKind(r)).toEqual([['impressum', 'provider-details-without-link']]);
    expect(o).toMatchObject({
      confidence: 'medium',
      pages: [START, CONTACT],
      params: {
        documentKind: 'impressum',
        pageTotal: 2,
        missingCount: 2,
        hopChecked: true,
        fallbackChecked: true,
        detailsUrl: PRIVACY,
        detailsPlace: 'footer',
        hasHeading: true,
        detailsHeading: 'Impressum',
        groupCount: 3,
      },
    });
    expect(o?.evidence[0]).toMatchObject({
      type: 'document',
      url: PRIVACY,
      kind: 'privacy',
      parts: [{ origin: 'visible', section: 'Datenschutzerklärung > Impressum' }],
    });
    expect(texts('de', o!)).toMatchObject({
      title: 'Angaben eines Impressums beobachtet, Link „Impressum“ nicht gefunden',
      body:
        `Im Seitenfuß von ${PRIVACY} im Abschnitt „Impressum“ wurden Angaben aus 3 von 5 Bereichen beobachtet, die ` +
        'ein Impressum enthält (Registereintrag, Umsatzsteuer-ID oder Steuernummer, Vertretungsberechtigte, Angaben ' +
        'nach § 5 DDG, Verantwortliche für den Inhalt). Ein Link, der sie als Impressum benennt, wurde auf den 2 ' +
        'geprüften Seiten nicht gefunden, auch nicht über eine geprüfte Zwischenseite (z. B. Kontakt); unter den ' +
        'üblichen Pfaden wurde ebenfalls keine solche Seite gefunden. Die Vollständigkeit der Angaben wurde nicht ' +
        'bewertet.',
      action:
        'Legen Sie die Angaben aus dem Seitenfuß als Seite „Impressum“ an und verlinken Sie diese im Seitenfuß jeder Seite.',
    });
    expect(texts('en', o!).body).toContain(
      `In the page footer of ${PRIVACY}, in the section “Impressum”, details from 3 of 5 areas`,
    );
  });

  it('details on the Kontakt page without a heading: the contact page is named, its role in the evidence', () => {
    const r = runCheck(legal01, scenario('violation-impressum-details-on-contact.json'));
    const o = impressum(r);

    expect(o?.variant).toBe('provider-details-without-link');
    expect(o?.params).toMatchObject({
      detailsUrl: CONTACT,
      detailsPlace: 'contact-page',
      hasHeading: false,
      detailsHeading: null,
    });
    expect(o?.evidence[0]).toMatchObject({ type: 'document', url: CONTACT, kind: 'contact' });
    expect(texts('de', o!).body).toMatch(
      new RegExp(`^Unter ${CONTACT} wurden Angaben aus 3 von 5 Bereichen`),
    );
    expect(texts('de', o!).action).toBe(
      `Verlinken Sie die Angaben unter ${CONTACT} im Seitenfuß jeder Seite mit der Bezeichnung „Impressum“.`,
    );
  });

  it('details on the start page: named as the start page', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({ candidates: [candidate(START, [{ section: 'Willkommen', text: detailsOf(3) }])] }),
    );

    expect(impressum(r)?.params).toMatchObject({
      detailsUrl: START,
      detailsPlace: 'start-page',
      detailsHeading: 'Willkommen',
    });
    expect(texts('de', impressum(r)!).body).toMatch(
      new RegExp(`^Auf der Startseite \\(${START}\\) im Abschnitt „Willkommen“ wurden`),
    );
  });

  it('a section headed "Impressum" in the content of the policy holds the details: the warning variant', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        privacyParts: [{ section: 'Datenschutzerklärung > Impressum', text: detailsOf(3) }],
        contentHeadings: ['Datenschutzerklärung', 'Impressum'],
      }),
    );

    expect(variantsByKind(r)).toEqual([['impressum', 'provider-details-without-link']]);
    expect(impressum(r)?.params).toMatchObject({
      detailsPlace: 'privacy-section',
      detailsHeading: 'Impressum',
    });
    expect(texts('de', impressum(r)!).body).toMatch(
      new RegExp(`^In der Datenschutzerklärung \\(${PRIVACY}\\) im Abschnitt „Impressum“ wurden`),
    );
  });

  it('a snapshot without content headings, part places and candidates: the Impressum section of the policy counts', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        privacyParts: [
          { section: 'Datenschutzerklärung > Anfahrt', text: 'Musterstraße 1, 10115 Berlin' },
          { section: 'Datenschutzerklärung > Impressum', text: detailsOf(3) },
        ],
      }),
    );

    expect(variantsByKind(r)).toEqual([['impressum', 'provider-details-without-link']]);
    expect(impressum(r)?.params).toMatchObject({ detailsPlace: 'privacy-section', groupCount: 3 });
  });

  it('a section "Impressum" on the contact page counts its subsections together, the page heading does not', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        candidates: [
          candidate(CONTACT, [
            { section: 'Kontakt', text: 'Schreiben Sie uns.' },
            { section: 'Kontakt > Impressum > Registereintrag', text: KINDS[0]! },
            { section: 'Kontakt > Impressum > Vertretung', text: KINDS[1]! },
            { section: 'Kontakt > Impressum > Umsatzsteuer', text: KINDS[2]! },
          ]),
        ],
      }),
    );

    expect(variantsByKind(r)).toEqual([['impressum', 'provider-details-without-link']]);
    expect(impressum(r)?.params).toMatchObject({ detailsHeading: 'Impressum', groupCount: 3 });
  });

  it('a section "Impressum" whose details sit in its subsections counts them together', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        privacyParts: [
          { section: 'Datenschutzerklärung > Impressum > Registereintrag', text: KINDS[0]! },
          { section: 'Datenschutzerklärung > Impressum > Vertretung', text: KINDS[1]! },
          { section: 'Datenschutzerklärung > Impressum > Umsatzsteuer', text: KINDS[2]! },
        ],
      }),
    );

    expect(impressum(r)).toMatchObject({
      variant: 'provider-details-without-link',
      params: { detailsHeading: 'Impressum', groupCount: 3 },
    });
  });

  it.each([
    [
      'a footer column "Impressum" with an address and a phone number only',
      unlinkedImpressum({
        privacyParts: [
          {
            section: 'Datenschutzerklärung > Impressum',
            place: 'chrome',
            text: 'Beispiel GmbH, Musterstraße 1, 10115 Berlin, Telefon 030 123456. Inhaber: Max Muster.',
          },
        ],
        contentHeadings: ['Datenschutzerklärung'],
      }),
    ],
    [
      'the company details of a processor in a section of the policy',
      unlinkedImpressum({
        privacyParts: [
          {
            section: 'Datenschutzerklärung > Hosting',
            text: 'Wir hosten bei der Beispiel Hosting GmbH, Amtsgericht Musterstadt HRB 1, Geschäftsführer Max Muster, USt-IdNr. DE123456789.',
          },
        ],
        contentHeadings: ['Datenschutzerklärung', 'Hosting'],
      }),
    ],
    [
      'one kind of details in each of three unrelated sections',
      unlinkedImpressum({
        candidates: [
          candidate(CONTACT, [
            { section: 'Anfahrt', text: 'Gegenüber dem Amtsgericht.' },
            { section: 'Team', text: 'Inhaber Max Muster begrüßt Sie.' },
            { section: 'Buchhaltung', text: 'Rechnungen mit Steuernummer.' },
          ]),
        ],
      }),
    ],
    [
      'one kind of details in each of three unrelated sections under the heading of the page',
      unlinkedImpressum({
        candidates: [
          candidate(CONTACT, [
            { section: 'Kontakt > Anfahrt', text: 'Gegenüber dem Amtsgericht.' },
            { section: 'Kontakt > Team', text: 'Inhaber Max Muster begrüßt Sie.' },
            { section: 'Kontakt > Buchhaltung', text: 'Rechnungen mit Steuernummer.' },
          ]),
        ],
      }),
    ],
    [
      'a sponsor named "VR-Bank" next to an owner and a tax number',
      unlinkedImpressum({
        candidates: [
          candidate(START, [
            {
              section: 'Startseite',
              text: 'Unser Sponsor: VR-Bank Neckar. Inhaber Max Muster. Wir kümmern uns um Ihre Steuernummer.',
            },
          ]),
        ],
      }),
    ],
    [
      'the details split between the content and the footer of a page',
      unlinkedImpressum({
        candidates: [
          candidate(CONTACT, [
            { section: 'Kontakt', place: 'content', text: `${KINDS[0]} ${KINDS[1]}` },
            { section: 'Kontakt', place: 'chrome', text: KINDS[2]! },
          ]),
        ],
      }),
    ],
    [
      'details only in hidden text',
      unlinkedImpressum({
        candidates: [candidate(CONTACT, [{ origin: 'hidden-irrelevant', text: detailsOf(3) }])],
      }),
    ],
    [
      'details in the footer of a policy page behind a challenge',
      unlinkedImpressum({
        pages: [
          page(START, 'start', 'A', {}, [footerLinks()[1]!]),
          page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!]),
          page(PRIVACY, 'privacy', 'A', {
            evaluable: false,
            notEvaluableReason: 'challenge',
            challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
          }),
        ],
        privacyParts: [{ section: 'Datenschutzerklärung', place: 'chrome', text: detailsOf(3) }],
      }),
    ],
    [
      'details on a page behind a challenge',
      unlinkedImpressum({
        pages: [
          page(START, 'start', 'A', {}, [footerLinks()[1]!]),
          page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!]),
          page(`${START}ueber-uns`, 'legal-hop', 'A', {
            evaluable: false,
            notEvaluableReason: 'challenge',
            challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
          }),
        ],
        candidates: [candidate(`${START}ueber-uns`, [{ text: detailsOf(3) }])],
      }),
    ],
  ])('counterexample: %s stays document-not-found (critical)', (_name, snap) => {
    const r = runCheck(legal01, snap);

    expect(variantsByKind(r)).toEqual([['impressum', 'document-not-found']]);
  });

  it.each([
    [3, 2, 'document-not-found'],
    [3, 3, 'provider-details-without-link'],
    [2, 1, 'document-not-found'],
    [2, 2, 'provider-details-without-link'],
    [5, 4, 'document-not-found'],
    [5, 5, 'provider-details-without-link'],
  ])('with at least %i kinds required, %i kinds on the Kontakt page give %s', (min, n, variant) => {
    const r = runCheck(legal01, onContact(detailsOf(n)), withMinGroups(min));

    expect(impressum(r)?.variant).toBe(variant);
  });

  it('a section "Impressum" without details keeps document-not-found with the hint to the section', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        privacyParts: [
          { section: 'Datenschutzerklärung > Impressum', text: 'Beispiel GmbH, Musterstraße 1.' },
        ],
        contentHeadings: ['Datenschutzerklärung', 'Impressum'],
      }),
    );

    expect(impressum(r)).toMatchObject({
      variant: 'document-not-found',
      params: { inOtherDocument: true, otherHeading: 'Impressum' },
    });
  });

  it('the privacy policy is judged as before: details of an Impressum do not stand in for it', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        policy: false,
        pages: [page(START, 'start', 'A', {}, []), page(CONTACT, 'contact', 'A', {}, [])],
        candidates: [candidate(CONTACT, [{ text: detailsOf(5) }])],
        attempts: [
          { kind: 'impressum', via: 'hop', url: CONTACT, status: 200, outcome: 'not-found' },
          { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 404, outcome: 'not-found' },
          { kind: 'privacy', via: 'fallback', url: PRIVACY, status: 404, outcome: 'not-found' },
        ],
      }),
    );

    expect(variantsByKind(r)).toEqual([
      ['impressum', 'provider-details-without-link'],
      ['privacy', 'document-not-found'],
    ]);
  });

  it('an Impressum link that answers 404 stays links-broken although the details are on the Kontakt page', () => {
    const links = footerLinks();
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
        attempts: [
          { kind: 'impressum', via: 'link', url: IMPRESSUM, status: 404, outcome: 'not-found' },
          {
            kind: 'impressum',
            via: 'fallback',
            url: `${START}impressum-x`,
            status: 404,
            outcome: 'not-found',
          },
        ],
        candidates: [candidate(CONTACT, [{ text: detailsOf(3) }])],
      }),
    );

    expect(variantsByKind(r)).toEqual([['impressum', 'links-broken']]);
  });

  it('phase A ended by the time budget before the usual path: the search stays incomplete, also with details', () => {
    const r = runCheck(
      legal01,
      unlinkedImpressum({
        phaseA: { status: 'partial', reason: 'time' },
        attempts: [{ kind: 'impressum', via: 'hop', url: CONTACT, status: 200, outcome: 'not-found' }],
        candidates: [candidate(CONTACT, [{ text: detailsOf(3) }])],
      }),
    );

    expect(r.status).toBe('partial');
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.limitations).toEqual(['impressum-search-incomplete:time']);
  });

  it('candidates are ignored once the Impressum was found', () => {
    expect(
      variantsOf(runCheck(legal01, scenario('clean-impressum-link-and-details-on-contact.json'))),
    ).toEqual([]);
  });
});

describe('LEGAL-01: further privacy notices beside the policy', () => {
  const SUPPLEMENT = 'https://www.example.de/datenschutzhinweise-kurse/';
  const COURSE = 'https://www.example.de/kurse/';
  const toNotice = makeLink({
    text: 'Datenschutz Kurse',
    href: SUPPLEMENT,
    hrefKind: 'https',
    sameSite: true,
  });
  // A course page links the Impressum and the notice for course participants, not the policy itself.
  const pages = () => [
    page(START, 'start', 'A', {}, [...footerLinks(), toNotice]),
    page(IMPRESSUM, 'impressum'),
    page(PRIVACY, 'privacy'),
    page(COURSE, 'nav', 'A', {}, [footerLinks()[0]!, toNotice]),
  ];
  type Attempt = DocumentsSection['attempts'][number];
  const withNotice = (attempts: Attempt[], notices: DocumentRecord[] = []) =>
    site({
      phases: [phase('A', { pages: pages() })],
      documents: {
        documents: [...defaultDocuments().documents, ...notices],
        attempts: [
          { kind: 'impressum', via: 'link', url: IMPRESSUM, status: 200, outcome: 'found' },
          { kind: 'privacy', via: 'link', url: PRIVACY, status: 200, outcome: 'found' },
          ...attempts,
        ],
      },
    });

  it.each<[string, Attempt[], DocumentRecord[]]>([
    [
      'a notice that answered 404',
      [
        {
          kind: 'privacy',
          via: 'link',
          url: SUPPLEMENT,
          status: 404,
          outcome: 'not-found',
          supplement: true,
        },
      ],
      [],
    ],
    [
      'a notice whose page failed to load',
      [{ kind: 'privacy', via: 'link', url: SUPPLEMENT, status: null, outcome: 'error', supplement: true }],
      [],
    ],
    [
      'a notice not confirmed as one',
      [
        {
          kind: 'privacy',
          via: 'link',
          url: SUPPLEMENT,
          status: 200,
          outcome: 'unconfirmed',
          supplement: true,
        },
      ],
      [
        makeDocument({
          kind: 'privacy',
          id: 'doc-privacy-3',
          role: 'supplement',
          url: SUPPLEMENT,
          errors: ['unconfirmed'],
        }),
      ],
    ],
    [
      'another language version that was only noted',
      [
        {
          kind: 'privacy',
          via: 'link',
          url: 'https://www.example.de/en/datenschutz/',
          status: null,
          outcome: 'other-language',
          supplement: true,
        },
      ],
      [],
    ],
  ])('%s is no broken or missing privacy link: no finding, no limitation', (_, attempts, notices) => {
    const r = runCheck(legal01, withNotice(attempts, notices));
    expect(variantsByKind(r)).toEqual([]);
    expect(r.outcome?.limitations ?? []).toEqual([]);
    expect(r.status).toBe('completed');
  });

  it.each([
    ['a section headed "Impressum"', 'Datenschutzhinweise > Impressum', ['Datenschutzhinweise', 'Impressum']],
    ['the page footer', 'Kontakt', ['Datenschutzhinweise']],
  ])(
    'Impressum details in %s of a further notice do not stand in for the Impressum',
    (_, section, headings) => {
      const snap = unlinkedImpressum();
      snap.documents?.documents.push(
        makeDocument({
          kind: 'privacy',
          id: 'doc-privacy-3',
          role: 'supplement',
          url: SUPPLEMENT,
          phase: 'A',
          contentHeadings: headings,
          parts: [
            {
              id: 's1',
              section,
              text: 'Beispiel GmbH, Musterstraße 1, 10115 Berlin. Amtsgericht Musterstadt, HRB 12345. Geschäftsführung: Erika Mustermann. USt-IdNr.: DE123456789.',
              origin: 'visible',
              place: section === 'Kontakt' ? 'chrome' : 'content',
              sourceUrl: SUPPLEMENT,
            },
          ],
        }),
      );
      const r = runCheck(legal01, snap);
      expect(variantsByKind(r)).toEqual([['impressum', 'document-not-found']]);
      expect(observationsOf(r)[0]?.params).toMatchObject({ inOtherDocument: false });
    },
  );

  it('counterexample: the same 404 recorded as an attempt of the policy makes the course page miss a working link', () => {
    const r = runCheck(
      legal01,
      withNotice([{ kind: 'privacy', via: 'link', url: SUPPLEMENT, status: 404, outcome: 'not-found' }]),
    );
    expect(variantsByKind(r)).toEqual([['privacy', 'link-missing-on-some-pages']]);
  });
});
