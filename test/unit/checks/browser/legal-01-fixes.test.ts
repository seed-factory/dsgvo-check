/**
 * LEGAL-01 L1 tests for the canary-2 triage: G18 (confidence of footer-covered-by-banner), G20 (unconfirmed type),
 * G21 (links-broken only when every link is broken), G22 (no critical from an interrupted search), G24 (localised
 * labels), G25 (hidden vendor links), G26 (soft-404 probes are no checked pages), G27 (blocked before unresolved),
 * G04 (truncated link list), G55 (attempt error → limitation).
 */
import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import type {
  DocumentsSection,
  DomFacts,
  LinkFact,
  PageVisit,
} from '../../../../src/collectors/browser/types.ts';
import {
  makeDocument,
  makeDom,
  makeLink,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  cmpFacts,
  cmpWith,
  defaultDocuments,
  footerLinks,
  IMPRESSUM,
  ORIGIN,
  PRIVACY,
  page,
  phase,
  START,
  site,
} from './helpers.ts';

type Attempt = DocumentsSection['attempts'][number];
/** The collector records outcome `unconfirmed` (robustness zone); the snapshot type may not know it yet. */
const UNCONFIRMED = 'unconfirmed' as unknown as Attempt['outcome'];
const att = (
  kind: Attempt['kind'],
  via: Attempt['via'],
  url: string,
  status: number | null,
  outcome: Attempt['outcome'],
): Attempt => ({ kind, via, url, status, outcome });

const impressumLink = (href = IMPRESSUM) =>
  makeLink({ text: 'Impressum', href, hrefKind: 'https', sameSite: true });
const privacyLink = (href = PRIVACY) =>
  makeLink({ text: 'Datenschutz', href, hrefKind: 'https', sameSite: true });
const doc = (kind: 'impressum' | 'privacy') => defaultDocuments().documents.find((d) => d.kind === kind)!;
const twoPages = (links: LinkFact[]) => [
  page(START, 'start', 'A', {}, links),
  page(CONTACT, 'contact', 'A', {}, links),
];
const withDocs = (documents: DocumentsSection['documents'], attempts: Attempt[] = []): DocumentsSection => ({
  documents,
  attempts,
});
const truncated = (links: LinkFact[]): DomFacts =>
  ({ ...makeDom({ links }), linksTruncated: true }) as unknown as DomFacts;
const kinds = (r: ReturnType<typeof runCheck>) => observationsOf(r).map((o) => [o.subject, o.variant]);

describe('G20: an unconfirmed document type is a limitation, not a finding', () => {
  const privacyUnconfirmed = (extra: Partial<Attempt> = {}) =>
    site({
      phases: [phase('A', { pages: twoPages([impressumLink(), privacyLink()]) })],
      documents: withDocs(
        [doc('impressum')],
        [{ ...att('privacy', 'link', PRIVACY, 200, UNCONFIRMED), ...extra }],
      ),
    });

  it('attempt unconfirmed → partial with privacy-type-unconfirmed; no links-broken, no unresolved', () => {
    const r = runCheck(legal01, privacyUnconfirmed());
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['privacy-type-unconfirmed']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a stored document tagged unconfirmed is not a reachable document either', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), privacyLink()]) })],
        documents: withDocs(
          [
            doc('impressum'),
            makeDocument({ kind: 'privacy', url: PRIVACY, errors: ['unconfirmed'], complete: false }),
          ],
          [att('privacy', 'link', PRIVACY, 200, UNCONFIRMED)],
        ),
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['privacy-type-unconfirmed']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a fallback path that serves an unrelated page is negative evidence for the path, not a limitation', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([privacyLink()]) })],
        documents: withDocs(
          [doc('privacy')],
          [att('impressum', 'fallback', `${ORIGIN}/impressum`, 200, UNCONFIRMED)],
        ),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
  });
});

describe('G21: links-broken needs every link to be broken', () => {
  it('a broken first link and a second link to the document found by fallback → no links-broken', () => {
    const second = `${ORIGIN}/impressum-neu`;
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), impressumLink(second), privacyLink()]) })],
        documents: withDocs(
          [makeDocument({ kind: 'impressum', url: second, foundVia: 'fallback' }), doc('privacy')],
          [att('impressum', 'link', IMPRESSUM, 200, 'soft-404')],
        ),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: every link leads to 404 → links-broken stays', () => {
    const other = `${ORIGIN}/impressum-2`;
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), impressumLink(other), privacyLink()]) })],
        documents: withDocs(
          [
            makeDocument({ kind: 'impressum', url: `${ORIGIN}/impressum-neu`, foundVia: 'fallback' }),
            doc('privacy'),
          ],
          [
            att('impressum', 'link', IMPRESSUM, 404, 'not-found'),
            att('impressum', 'link', other, 404, 'not-found'),
          ],
        ),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'links-broken']]);
  });

  it('a broken link next to an unchecked one is not critical (unresolved, info)', () => {
    const unchecked = `${ORIGIN}/impressum-extra`;
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), impressumLink(unchecked), privacyLink()]) })],
        documents: withDocs([doc('privacy')], [att('impressum', 'link', IMPRESSUM, 404, 'not-found')]),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'unresolved']]);
  });

  it('a broken link, an unchecked link and a document found by fallback → reachable-via-intermediate, not critical', () => {
    const unchecked = `${ORIGIN}/impressum-extra`;
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), impressumLink(unchecked), privacyLink()]) })],
        documents: withDocs(
          [
            makeDocument({ kind: 'impressum', url: `${ORIGIN}/impressum-neu`, foundVia: 'fallback' }),
            doc('privacy'),
          ],
          [att('impressum', 'link', IMPRESSUM, 404, 'not-found')],
        ),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'reachable-via-intermediate']]);
  });
});

describe('G22: no critical document-not-found from an interrupted search', () => {
  const noImpressumPages = (reason = 'time-budget') =>
    phase('A', {
      status: 'partial',
      reason,
      pages: [page(START, 'start', 'A', {}, [privacyLink()]), page(PRIVACY, 'privacy', 'A', {}, [])],
    });

  it('phase A partial (time-budget), no fallback attempt → limitation impressum-search-incomplete', () => {
    const r = runCheck(
      legal01,
      site({ phases: [noImpressumPages()], documents: withDocs([doc('privacy')]) }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['impressum-search-incomplete:time-budget']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('the reason follows the phase (throttled, request-cap)', () => {
    for (const reason of ['throttled', 'request-cap']) {
      const r = runCheck(
        legal01,
        site({ phases: [noImpressumPages(reason)], documents: withDocs([doc('privacy')]) }),
      );
      expect(r.outcome?.limitations).toEqual([`impressum-search-incomplete:${reason}`]);
    }
  });

  it('a hop candidate that was not visited makes the search incomplete even after the fallback', () => {
    const start = page(START, 'start', 'A', {}, [
      privacyLink(),
      makeLink({ text: 'Kontakt', href: CONTACT, hrefKind: 'https', sameSite: true, region: 'nav' }),
    ]);
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { status: 'partial', reason: 'request-cap', pages: [start] })],
        documents: withDocs(
          [doc('privacy')],
          [att('impressum', 'fallback', `${ORIGIN}/impressum`, 404, 'not-found')],
        ),
      }),
    );
    expect(r.outcome?.limitations).toEqual(['impressum-search-incomplete:request-cap']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: hop and fallback were carried out → critical stays, with the checked steps in the params', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            status: 'partial',
            reason: 'request-cap',
            pages: [
              page(START, 'start', 'A', {}, [
                privacyLink(),
                makeLink({
                  text: 'Kontakt',
                  href: CONTACT,
                  hrefKind: 'https',
                  sameSite: true,
                  region: 'nav',
                }),
              ]),
              page(CONTACT, 'contact', 'A', {}, [privacyLink()]),
            ],
          }),
        ],
        documents: withDocs(
          [doc('privacy')],
          [
            att('impressum', 'hop', CONTACT, 200, 'not-found'),
            att('impressum', 'fallback', `${ORIGIN}/impressum`, 404, 'not-found'),
          ],
        ),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
    expect(observationsOf(r)[0]?.params).toMatchObject({ hopChecked: true, fallbackChecked: true });
  });

  it('counterexample: a completed phase without hop candidates and with the fallback → critical', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, [privacyLink()]),
              page(`${ORIGIN}/team`, 'nav', 'A', {}, [privacyLink()]),
            ],
          }),
        ],
        documents: withDocs(
          [doc('privacy')],
          [att('impressum', 'fallback', `${ORIGIN}/impressum`, 404, 'not-found')],
        ),
      }),
    );
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
    expect(observationsOf(r)[0]?.params).toMatchObject({ hopChecked: false, fallbackChecked: true });
  });
});

describe('G24: localised labels count as legal links', () => {
  it('a French footer with "Mentions légales" and "Politique de confidentialité" → no link-missing finding', () => {
    const fr = [
      makeLink({
        text: 'Mentions légales',
        href: `${ORIGIN}/fr/mentions`,
        hrefKind: 'https',
        sameSite: true,
      }),
      makeLink({
        text: 'Politique de confidentialité',
        href: `${ORIGIN}/fr/confidentialite`,
        hrefKind: 'https',
        sameSite: true,
      }),
    ];
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages(fr) })],
        documents: withDocs([
          makeDocument({ kind: 'impressum', url: `${ORIGIN}/fr/mentions`, lang: 'fr' }),
          makeDocument({ kind: 'privacy', url: `${ORIGIN}/fr/confidentialite`, lang: 'fr' }),
        ]),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: the cookie settings link is still no privacy link', () => {
    const links = [
      impressumLink(),
      makeLink({ text: 'Cookie-Einstellungen', href: null, hrefKind: 'javascript' }),
    ];
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages(links) })],
        documents: withDocs([doc('impressum')], [att('privacy', 'fallback', PRIVACY, 404, 'not-found')]),
      }),
    );
    expect(kinds(r)).toEqual([['privacy', 'document-not-found']]);
  });
});

describe('G25: hidden vendor links of the banner are no legal links of the site', () => {
  const vendor = makeLink({
    text: 'Privacy Policy',
    href: 'https://consent-vendor.example/privacy-policy',
    hrefKind: 'https',
    region: 'banner',
    visible: false,
    sameSite: false,
  });

  it('only the hidden vendor link → no unresolved/working link for the site (document-not-found)', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), vendor]) })],
        documents: withDocs([doc('impressum')], [att('privacy', 'fallback', PRIVACY, 404, 'not-found')]),
      }),
    );
    expect(kinds(r)).toEqual([['privacy', 'document-not-found']]);
  });

  it('counterexample: a hidden same-site banner link still counts as a link', () => {
    const own = makeLink({
      text: 'Datenschutz',
      href: `${ORIGIN}/datenschutz-banner`,
      hrefKind: 'https',
      region: 'banner',
      visible: false,
      sameSite: true,
    });
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), own]) })],
        documents: withDocs([doc('impressum')]),
      }),
    );
    expect(kinds(r)).toEqual([['privacy', 'unresolved']]);
  });
});

describe('G26: soft-404 probes are no checked pages', () => {
  const probe = (p: Partial<PageVisit> = {}) => page(`${ORIGIN}/impressum`, 'fallback', 'A', { ...p }, []);
  const base = (probePage: PageVisit, probeAttempt: Attempt) =>
    site({
      phases: [phase('A', { pages: [page(START, 'start', 'A', {}, [privacyLink()]), probePage] })],
      documents: withDocs([doc('privacy')], [probeAttempt]),
    });

  it('a fallback visit judged soft-404 is in neither pageTotal nor pages of the finding, but stays observed', () => {
    const r = runCheck(
      legal01,
      base(probe(), att('impressum', 'fallback', `${ORIGIN}/impressum`, 200, 'soft-404')),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({ variant: 'document-not-found', params: { pageTotal: 1, missingCount: 1 } });
    expect(o?.pages).toEqual([START]);
    expect(r.outcome?.coverage).toMatchObject({ observed: 2, evaluated: 1 });
  });

  it('an unconfirmed fallback visit is excluded too (matched by the final URL)', () => {
    const r = runCheck(
      legal01,
      base(
        probe({ url: `${ORIGIN}/impressum`, finalUrl: `${ORIGIN}/home` }),
        att('impressum', 'fallback', `${ORIGIN}/home`, 200, UNCONFIRMED),
      ),
    );
    expect(observationsOf(r)[0]).toMatchObject({ params: { pageTotal: 1 } });
  });

  it('counterexample: a challenge page stays in the observed coverage as not evaluated', () => {
    const r = runCheck(
      legal01,
      base(
        probe({
          evaluable: false,
          notEvaluableReason: 'challenge',
          challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
        }),
        att('impressum', 'fallback', `${ORIGIN}/impressum`, 403, 'not-found'),
      ),
    );
    expect(r.outcome?.coverage).toMatchObject({ observed: 2, evaluated: 1 });
  });

  it('counterexample: an ordinary visited page without the link still counts', () => {
    const r = runCheck(
      legal01,
      base(
        page(`${ORIGIN}/team`, 'nav', 'A', {}, []),
        att('impressum', 'fallback', `${ORIGIN}/impressum`, 404, 'not-found'),
      ),
    );
    expect(observationsOf(r)[0]).toMatchObject({ params: { pageTotal: 2, missingCount: 2 } });
  });
});

describe('G27: a blocked target is a limitation before unresolved', () => {
  it('privacy target behind a 403 challenge plus an unchecked link → partial, privacy-target-not-evaluable', () => {
    const cookies = makeLink({
      text: 'Datenschutzhinweise',
      href: `${ORIGIN}/datenschutz/cookies/`,
      hrefKind: 'https',
      sameSite: true,
    });
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              ...twoPages([impressumLink(), privacyLink(), cookies]),
              page(PRIVACY, 'privacy', 'A', {
                evaluable: false,
                notEvaluableReason: 'challenge',
                challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
              }),
            ],
          }),
        ],
        documents: withDocs([doc('impressum')], [att('privacy', 'link', PRIVACY, 403, 'not-found')]),
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['privacy-target-not-evaluable']);
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('G04: a truncated link list proves no missing link', () => {
  it('a page with linksTruncated and no legal link is not in missing → no link-missing finding, limitation instead', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, footerLinks()),
              page(CONTACT, 'contact', 'A', { dom: truncated([]) }, []),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['impressum-links-truncated', 'privacy-links-truncated']);
  });

  it('only truncated pages lack the link and the document was found by fallback → no reachable-via-intermediate', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: [page(START, 'start', 'A', { dom: truncated([]) }, [])] })],
        documents: withDocs([
          makeDocument({ kind: 'impressum', url: `${ORIGIN}/impressum`, foundVia: 'fallback' }),
          makeDocument({ kind: 'privacy', url: `${ORIGIN}/datenschutz`, foundVia: 'fallback' }),
        ]),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.limitations).toEqual(['impressum-links-truncated', 'privacy-links-truncated']);
  });

  it('counterexample: a complete page without the link still counts as missing', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, footerLinks()),
              page(CONTACT, 'contact', 'A', { dom: truncated([]) }, []),
              page(`${ORIGIN}/team`, 'nav', 'A', {}, []),
            ],
          }),
        ],
      }),
    );
    expect(kinds(r)).toEqual([
      ['impressum', 'link-missing-on-some-pages'],
      ['privacy', 'link-missing-on-some-pages'],
    ]);
    expect(observationsOf(r)[0]?.params).toMatchObject({ missingCount: 1, pageTotal: 2 });
  });
});

describe('G55: a failed navigation to the target is a limitation, not a broken link', () => {
  it('attempt error and a not evaluable error page → partial, privacy-target-not-evaluable, page not in the finding', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [
              ...twoPages([impressumLink(), privacyLink()]),
              page(PRIVACY, 'privacy', 'A', {
                evaluable: false,
                notEvaluableReason: 'navigation-failed:net::ERR_TOO_MANY_REDIRECTS',
              }),
            ],
          }),
        ],
        documents: withDocs([doc('impressum')], [att('privacy', 'link', PRIVACY, null, 'error')]),
      }),
    );
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['privacy-target-not-evaluable']);
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('G18: confidence of footer-covered-by-banner', () => {
  const covering = (detection: Parameters<typeof cmpFacts>[0]) =>
    cmpWith({
      phase: 'B',
      facts: [
        cmpFacts({
          ...detection,
          firstLayer: {
            bannerPresent: true,
            bannerVisible: true,
            buttons: [],
            purAbo: false,
            closeMeansAccept: null,
            coversFooter: true,
            legalLinks: [],
          },
        }),
      ],
    });

  it('a heuristic banner recognition gives medium confidence (never high)', () => {
    const r = runCheck(
      legal01,
      site({
        cmp: covering({
          detection: {
            cmpId: null,
            method: 'heuristic',
            version: null,
            versionSupported: null,
            recognitionConfidence: 'medium',
            signals: ['dom:fixed-bottom'],
          },
        }),
      }),
    );
    const covers = observationsOf(r).filter((o) => o.variant === 'footer-covered-by-banner');
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.every((o) => o.confidence === 'medium')).toBe(true);
  });

  it('a measured overlap of a concrete footer link gives high confidence even for a heuristic candidate', () => {
    const base = cmpFacts({
      detection: {
        cmpId: null,
        method: 'heuristic',
        version: null,
        versionSupported: null,
        recognitionConfidence: 'medium',
        signals: ['dom:fixed-bottom'],
      },
    });
    const measured = {
      ...base,
      firstLayer: {
        ...base.firstLayer,
        bannerPresent: true,
        bannerVisible: true,
        coversFooter: true,
        legalLinks: [],
        coveredFooterLinks: [
          { label: 'Impressum', box: { x: 0, y: 700, width: 80, height: 20 }, coveredBy: 'banner' as const },
        ],
      },
    };
    const r = runCheck(legal01, site({ cmp: cmpWith({ phase: 'B', facts: [measured] }) }));
    const covers = observationsOf(r).filter((o) => o.variant === 'footer-covered-by-banner');
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.every((o) => o.confidence === 'high')).toBe(true);
  });

  it('counterexample: an own adapter with high recognition keeps high confidence', () => {
    const r = runCheck(legal01, site({ cmp: covering({}) }));
    const covers = observationsOf(r).filter((o) => o.variant === 'footer-covered-by-banner');
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.every((o) => o.confidence === 'high')).toBe(true);
  });
});

describe('R09 (G22): a skipped fallback is no basis for critical, whatever the phase status says', () => {
  const team = `${ORIGIN}/team`;
  const noImpressum = (attempts: Attempt[] = []) =>
    site({
      // Phase A is `completed`: the budget ran out between the last queued page and the fallback step, no abort.
      phases: [
        phase('A', {
          pages: [
            page(START, 'start', 'A', {}, [privacyLink()]),
            page(team, 'nav', 'A', {}, [privacyLink()]),
          ],
        }),
      ],
      documents: withDocs([doc('privacy')], attempts),
    });

  it('completed phase A without any fallback attempt → limitation, no document-not-found', () => {
    const r = runCheck(legal01, noImpressum());
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['impressum-search-incomplete:fallback-skipped']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: with the fallback attempt the critical finding stays', () => {
    const r = runCheck(legal01, noImpressum([att('impressum', 'fallback', IMPRESSUM, 404, 'not-found')]));
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
    expect(observationsOf(r)[0]?.params).toMatchObject({ fallbackChecked: true });
  });

  it('counterexample: an interrupted phase keeps the reason of the phase', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            status: 'partial',
            reason: 'time-budget',
            pages: [page(START, 'start', 'A', {}, [privacyLink()])],
          }),
        ],
        documents: withDocs([doc('privacy')]),
      }),
    );
    expect(r.outcome?.limitations).toEqual(['impressum-search-incomplete:time-budget']);
  });
});

describe('R25 (G20): an unconfirmed target of the direct link is a limitation even when the fallback found a document', () => {
  const rechtliches = `${ORIGIN}/rechtliches`;
  const build = (attempts: Attempt[]) =>
    site({
      phases: [phase('A', { pages: twoPages([impressumLink(), privacyLink(rechtliches)]) })],
      documents: withDocs(
        [doc('impressum'), makeDocument({ kind: 'privacy', url: PRIVACY, foundVia: 'fallback' })],
        attempts,
      ),
    });

  it('link attempt unconfirmed + document found by the fallback → privacy-type-unconfirmed, no reachable-via-intermediate', () => {
    const r = runCheck(legal01, build([att('privacy', 'link', rechtliches, 200, UNCONFIRMED)]));
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['privacy-type-unconfirmed']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a stored document of the link tagged unconfirmed counts the same', () => {
    const r = runCheck(
      legal01,
      site({
        phases: [phase('A', { pages: twoPages([impressumLink(), privacyLink(rechtliches)]) })],
        documents: withDocs([
          doc('impressum'),
          makeDocument({ kind: 'privacy', url: rechtliches, foundVia: 'link', errors: ['unconfirmed'] }),
          makeDocument({ kind: 'privacy', url: PRIVACY, foundVia: 'fallback' }),
        ]),
      }),
    );
    expect(r.outcome?.limitations).toEqual(['privacy-type-unconfirmed']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: a link that was only not fetched (unverified) keeps reachable-via-intermediate', () => {
    const r = runCheck(legal01, build([]));
    expect(kinds(r)).toEqual([['privacy', 'reachable-via-intermediate']]);
    expect(r.outcome?.limitations ?? []).toEqual([]);
  });
});

describe('R26 (G26): the error page behind a legal link is no checked page of another document kind', () => {
  const policyPage = `${ORIGIN}/privacy-policy`;
  const build = (outcome: Attempt['outcome'], errors: string[]) =>
    site({
      phases: [
        phase('A', {
          pages: [
            page(START, 'start', 'A', {}, [impressumLink(), privacyLink(policyPage)]),
            page(IMPRESSUM, 'impressum', 'A', {}, []),
            page(policyPage, 'privacy', 'A', {}, []),
          ],
        }),
      ],
      documents: withDocs(
        [doc('impressum'), makeDocument({ kind: 'privacy', url: policyPage, foundVia: 'link', errors })],
        [att('impressum', 'link', IMPRESSUM, 200, 'found'), att('privacy', 'link', policyPage, 200, outcome)],
      ),
    });
  const impressumObs = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).filter((o) => o.subject === 'impressum');

  it('a privacy link that leads to a soft-404 page: that page is not a page without an Impressum link', () => {
    const r = runCheck(legal01, build('soft-404', ['soft-404']));
    expect(impressumObs(r)).toEqual([]);
    expect(r.outcome?.coverage).toMatchObject({
      observed: 3,
      evaluated: 2,
      note: 'error-page-probes:1',
    });
  });

  it('counterexample: a substantive page whose type is only unconfirmed stays in the denominator', () => {
    const r = runCheck(legal01, build(UNCONFIRMED, ['unconfirmed']));
    const [o] = impressumObs(r);
    expect(o).toMatchObject({
      variant: 'link-missing-on-some-pages',
      params: { pageTotal: 2, missingCount: 1 },
    });
    expect(o?.pages).toEqual([policyPage]);
  });
});

describe('R24 (G19): a badge with a weak key in a long label is no link to the policy', () => {
  const badge = (text: string) =>
    makeLink({ text, href: `${ORIGIN}/leistungen/webdesign`, hrefKind: 'https', sameSite: true });
  const build = (links: LinkFact[]) =>
    site({
      phases: [phase('A', { pages: twoPages([impressumLink(), ...links]) })],
      documents: withDocs([doc('impressum')], [att('privacy', 'fallback', PRIVACY, 404, 'not-found')]),
    });

  it('a footer badge "Webdesign DSGVO konform" next to no policy link → document-not-found, not unresolved', () => {
    const r = runCheck(legal01, build([badge('Webdesign DSGVO konform')]));
    expect(kinds(r)).toEqual([['privacy', 'document-not-found']]);
  });

  it('counterexample: the same link labelled with the whole key "DSGVO" is a policy link candidate (unresolved)', () => {
    const r = runCheck(legal01, build([badge('DSGVO')]));
    expect(kinds(r)).toEqual([['privacy', 'unresolved']]);
  });
});

describe('L3 (G19): LEGAL-01 reads the links of a page like the collector (one URL, one exact kind)', () => {
  const POLICY = `${ORIGIN}/privacy`;
  const footerPolicy = () =>
    makeLink({ text: 'Privacy Policy', href: POLICY, hrefKind: 'https', sameSite: true });
  const bannerPolicy = (accessibleName: string) =>
    makeLink({
      text: 'View our Privacy Policy',
      accessibleName,
      href: POLICY,
      hrefKind: 'https',
      sameSite: true,
      region: 'banner',
    });
  const build = (links: LinkFact[]) =>
    site({
      phases: [phase('A', { pages: twoPages(links) })],
      documents: withDocs(
        [makeDocument({ kind: 'privacy', url: POLICY, foundVia: 'link' })],
        [att('impressum', 'fallback', IMPRESSUM, 404, 'not-found')],
      ),
    });

  it.each([
    ['the new-tab hint', 'Legal Information, opens in a new tab'],
    ['the short name', 'Legal Information'],
  ])('a banner link to the policy with the accessible name "%s" is no link to the Impressum', (_, name) => {
    const r = runCheck(legal01, build([bannerPolicy(name), footerPolicy()]));
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
  });

  it('the same holds for the banner link on its own: its exact text names the policy', () => {
    const r = runCheck(
      legal01,
      build([makeLink({ ...bannerPolicy('Legal Information'), text: 'Privacy Policy' })]),
    );
    expect(kinds(r)).toEqual([['impressum', 'document-not-found']]);
  });

  it('counterexample: a genuine "Legal information" link to another page is still a link to the Impressum', () => {
    const legalInfo = `${ORIGIN}/legal-info`;
    const r = runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: twoPages([
              footerPolicy(),
              makeLink({ text: 'Legal Information', href: legalInfo, hrefKind: 'https', sameSite: true }),
            ]),
          }),
        ],
        documents: withDocs(
          [
            makeDocument({ kind: 'privacy', url: POLICY, foundVia: 'link' }),
            makeDocument({ kind: 'impressum', url: legalInfo, foundVia: 'link' }),
          ],
          [],
        ),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });
});
