import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../../src/checks/browser/legal-01.ts';
import type { DocumentsSection, LinkFact, PageVisit } from '../../../../../src/core/snapshot/browser.ts';
import {
  makeDocument,
  makeDom,
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
  ORIGIN,
  PRIVACY,
  page,
  phase,
  type SiteSpec,
  START,
  site,
} from '../helpers.ts';

type Attempt = DocumentsSection['attempts'][number];
const att = (
  kind: Attempt['kind'],
  via: Attempt['via'],
  url: string,
  status: number | null,
  outcome: Attempt['outcome'],
): Attempt => ({ kind, via, url, status, outcome });
const doc = (kind: 'impressum' | 'privacy') => defaultDocuments().documents.find((d) => d.kind === kind)!;
const link = (text: string, href: string, extra: Partial<LinkFact> = {}) =>
  makeLink({ text, href, hrefKind: 'https', sameSite: true, ...extra });
const impressum = (href = IMPRESSUM) => link('Impressum', href);
const privacy = (href = PRIVACY) => link('Datenschutz', href);
const twoPages = (links: LinkFact[]) => [
  page(START, 'start', 'A', {}, links),
  page(CONTACT, 'contact', 'A', {}, links),
];
const documents = (stored: DocumentsSection['documents'], attempts: Attempt[] = []): DocumentsSection => ({
  documents: stored,
  attempts,
});
const linked = (
  links: LinkFact[],
  stored: DocumentsSection['documents'],
  attempts: Attempt[] = [],
): SiteSpec => ({ phases: [phase('A', { pages: twoPages(links) })], documents: documents(stored, attempts) });
const fallback = (kind: Attempt['kind'] = 'impressum') =>
  att(kind, 'fallback', kind === 'privacy' ? PRIVACY : IMPRESSUM, 404, 'not-found');
const missing = (kind = 'impressum', variant = 'document-not-found') => [[kind, variant]];
const unconfirmed = att('privacy', 'link', PRIVACY, 200, 'unconfirmed');

interface Expected {
  kinds?: string[][];
  status?: string;
  limitations?: string[];
  first?: Record<string, unknown>;
  firstSubject?: string;
  emptySubject?: string;
  pages?: string[];
  coverage?: Record<string, unknown>;
}
interface Scenario {
  name: string;
  input: SiteSpec;
  expected: Expected;
}
function verify(input: SiteSpec, expected: Expected) {
  const result = runCheck(legal01, site(input));
  const observations = observationsOf(result);
  if (expected.kinds) expect(observations.map((o) => [o.subject, o.variant])).toEqual(expected.kinds);
  if (expected.status) expect(result.status).toBe(expected.status);
  if (expected.limitations) expect(result.outcome?.limitations ?? []).toEqual(expected.limitations);
  const first = expected.firstSubject
    ? observations.find((o) => o.subject === expected.firstSubject)
    : observations[0];
  if (expected.first) expect(first).toMatchObject(expected.first);
  if (expected.pages) expect(first?.pages).toEqual(expected.pages);
  if (expected.emptySubject)
    expect(observations.filter((o) => o.subject === expected.emptySubject)).toEqual([]);
  if (expected.coverage) expect(result.outcome?.coverage).toMatchObject(expected.coverage);
}

describe('LEGAL-01 document search evidence', () => {
  const second = `${ORIGIN}/impressum-neu`;
  const unchecked = `${ORIGIN}/impressum-extra`;
  const viaFallback = makeDocument({ kind: 'impressum', url: second, foundVia: 'fallback' });
  it.each<Scenario>([
    {
      name: 'an unconfirmed linked document is a limitation',
      input: linked([impressum(), privacy()], [doc('impressum')], [unconfirmed]),
      expected: { status: 'partial', limitations: ['privacy-type-unconfirmed'], kinds: [] },
    },
    {
      name: 'a stored document tagged unconfirmed is not reachable',
      input: linked(
        [impressum(), privacy()],
        [
          doc('impressum'),
          makeDocument({ kind: 'privacy', url: PRIVACY, errors: ['unconfirmed'], complete: false }),
        ],
        [unconfirmed],
      ),
      expected: { status: 'partial', limitations: ['privacy-type-unconfirmed'], kinds: [] },
    },
    {
      name: 'an unrelated fallback response is negative evidence for that path',
      input: linked(
        [privacy()],
        [doc('privacy')],
        [att('impressum', 'fallback', IMPRESSUM, 200, 'unconfirmed')],
      ),
      expected: { kinds: missing() },
    },
    {
      name: 'a second working link prevents a broken-link finding',
      input: linked(
        [impressum(), impressum(second), privacy()],
        [viaFallback, doc('privacy')],
        [att('impressum', 'link', IMPRESSUM, 200, 'soft-404')],
      ),
      expected: { kinds: [] },
    },
    {
      name: 'all broken links remain broken when only a different fallback works',
      input: linked(
        [impressum(), impressum(`${ORIGIN}/impressum-2`), privacy()],
        [viaFallback, doc('privacy')],
        [
          att('impressum', 'link', IMPRESSUM, 404, 'not-found'),
          att('impressum', 'link', `${ORIGIN}/impressum-2`, 404, 'not-found'),
        ],
      ),
      expected: { kinds: missing('impressum', 'links-broken') },
    },
    {
      name: 'an unchecked alternative link leaves the result unresolved',
      input: linked(
        [impressum(), impressum(unchecked), privacy()],
        [doc('privacy')],
        [att('impressum', 'link', IMPRESSUM, 404, 'not-found')],
      ),
      expected: { kinds: missing('impressum', 'unresolved') },
    },
    {
      name: 'an unchecked alternative and a working fallback are reachable indirectly',
      input: linked(
        [impressum(), impressum(unchecked), privacy()],
        [viaFallback, doc('privacy')],
        [att('impressum', 'link', IMPRESSUM, 404, 'not-found')],
      ),
      expected: { kinds: missing('impressum', 'reachable-via-intermediate') },
    },
  ])('$name', ({ input, expected }) => verify(input, expected));

  const noImpressum = (
    pages: PageVisit[],
    attempts: Attempt[] = [],
    status: 'partial' | 'completed' = 'completed',
    reason?: string,
  ): SiteSpec => ({
    phases: [phase('A', { pages, status, ...(reason ? { reason } : {}) })],
    documents: documents([doc('privacy')], attempts),
  });
  const start = page(START, 'start', 'A', {}, [privacy()]);
  const team = page(`${ORIGIN}/team`, 'nav', 'A', {}, [privacy()]);
  const contact = link('Kontakt', CONTACT, { region: 'nav' });
  const startWithHop = page(START, 'start', 'A', {}, [privacy(), contact]);
  it.each<Scenario>([
    ...['time-budget', 'throttled', 'request-cap'].map((reason) => ({
      name: `an interrupted search preserves the ${reason} reason`,
      input: noImpressum([start, page(PRIVACY, 'privacy', 'A', {}, [])], [], 'partial', reason),
      expected: { status: 'partial', limitations: [`impressum-search-incomplete:${reason}`], kinds: [] },
    })),
    {
      name: 'an unvisited hop keeps the search incomplete after the fallback',
      input: noImpressum([startWithHop], [fallback()], 'partial', 'request-cap'),
      expected: { limitations: ['impressum-search-incomplete:request-cap'], kinds: [] },
    },
    {
      name: 'a checked hop and fallback establish absence despite the phase limit',
      input: noImpressum(
        [startWithHop, page(CONTACT, 'contact', 'A', {}, [privacy()])],
        [att('impressum', 'hop', CONTACT, 200, 'not-found'), fallback()],
        'partial',
        'request-cap',
      ),
      expected: { kinds: missing(), first: { params: { hopChecked: true, fallbackChecked: true } } },
    },
    {
      name: 'a completed search without hop candidates records only the fallback',
      input: noImpressum([start, team], [fallback()]),
      expected: { kinds: missing(), first: { params: { hopChecked: false, fallbackChecked: true } } },
    },
    {
      name: 'a completed phase without a fallback cannot establish absence',
      input: noImpressum([start, team]),
      expected: {
        status: 'partial',
        limitations: ['impressum-search-incomplete:fallback-skipped'],
        kinds: [],
      },
    },
    {
      name: 'a completed phase with a fallback establishes absence',
      input: noImpressum([start, team], [fallback()]),
      expected: { kinds: missing(), first: { params: { fallbackChecked: true } } },
    },
    {
      name: 'an interrupted single-page search keeps its phase reason',
      input: noImpressum([start], [], 'partial', 'time-budget'),
      expected: { limitations: ['impressum-search-incomplete:time-budget'] },
    },
  ])('$name', ({ input, expected }) => verify(input, expected));
});

describe('LEGAL-01 legal link identity', () => {
  const frImpressum = `${ORIGIN}/fr/mentions`;
  const frPrivacy = `${ORIGIN}/fr/confidentialite`;
  const vendor = link('Privacy Policy', 'https://consent-vendor.invalid/privacy-policy', {
    region: 'banner',
    visible: false,
    sameSite: false,
  });
  const own = privacy(`${ORIGIN}/datenschutz-banner`);
  const badge = (text: string) => link(text, `${ORIGIN}/leistungen/webdesign`);
  const policy = `${ORIGIN}/privacy`;
  const footerPolicy = link('Privacy Policy', policy);
  const bannerPolicy = (accessibleName: string) =>
    link('View our Privacy Policy', policy, { accessibleName, region: 'banner' });
  const policyOnly = (links: LinkFact[]) =>
    linked(links, [makeDocument({ kind: 'privacy', url: policy, foundVia: 'link' })], [fallback()]);
  it.each<Scenario>([
    {
      name: 'French footer labels identify both documents',
      input: linked(
        [link('Mentions légales', frImpressum), link('Politique de confidentialité', frPrivacy)],
        [
          makeDocument({ kind: 'impressum', url: frImpressum, lang: 'fr' }),
          makeDocument({ kind: 'privacy', url: frPrivacy, lang: 'fr' }),
        ],
      ),
      expected: { kinds: [] },
    },
    {
      name: 'cookie settings are not a privacy policy link',
      input: linked(
        [impressum(), makeLink({ text: 'Cookie-Einstellungen', href: null, hrefKind: 'javascript' })],
        [doc('impressum')],
        [fallback('privacy')],
      ),
      expected: { kinds: missing('privacy') },
    },
    {
      name: 'a hidden vendor banner link is not a site policy link',
      input: linked([impressum(), vendor], [doc('impressum')], [fallback('privacy')]),
      expected: { kinds: missing('privacy') },
    },
    {
      name: 'a hidden same-site banner link remains a candidate',
      input: linked([impressum(), { ...own, region: 'banner', visible: false }], [doc('impressum')]),
      expected: { kinds: missing('privacy', 'unresolved') },
    },
    ...[
      ['Webdesign DSGVO konform', 'document-not-found'],
      ['DSGVO', 'unresolved'],
    ].map(([text, variant]) => ({
      name: `the policy marker in "${text}" yields ${variant}`,
      input: linked([impressum(), badge(text!)], [doc('impressum')], [fallback('privacy')]),
      expected: { kinds: missing('privacy', variant!) },
    })),
    ...['Legal Information, opens in a new tab', 'Legal Information'].map((name) => ({
      name: `the accessible name "${name}" does not change the exact policy link kind`,
      input: policyOnly([bannerPolicy(name), footerPolicy]),
      expected: { kinds: missing() },
    })),
    {
      name: 'an exact policy label on a banner link alone remains a policy',
      input: policyOnly([{ ...bannerPolicy('Legal Information'), text: 'Privacy Policy' }]),
      expected: { kinds: missing() },
    },
    {
      name: 'a distinct Legal Information link identifies the Impressum',
      input: linked(
        [footerPolicy, link('Legal Information', `${ORIGIN}/legal-info`)],
        [
          makeDocument({ kind: 'privacy', url: policy, foundVia: 'link' }),
          makeDocument({ kind: 'impressum', url: `${ORIGIN}/legal-info`, foundVia: 'link' }),
        ],
      ),
      expected: { kinds: [] },
    },
  ])('$name', ({ input, expected }) => verify(input, expected));
});

describe('LEGAL-01 checked page coverage', () => {
  const probe = (extra: Partial<PageVisit> = {}) => page(IMPRESSUM, 'fallback', 'A', extra, []);
  const probed = (visit: PageVisit, attempt: Attempt): SiteSpec => ({
    phases: [phase('A', { pages: [page(START, 'start', 'A', {}, [privacy()]), visit] })],
    documents: documents([doc('privacy')], [attempt]),
  });
  const truncated = page(
    CONTACT,
    'contact',
    'A',
    { dom: { ...makeDom({ links: [] }), linksTruncated: true } },
    [],
  );
  const policyPage = `${ORIGIN}/privacy-policy`;
  const crossKind = (outcome: Attempt['outcome'], errors: string[]): SiteSpec => ({
    phases: [
      phase('A', {
        pages: [
          page(START, 'start', 'A', {}, [impressum(), privacy(policyPage)]),
          page(IMPRESSUM, 'impressum', 'A', {}, []),
          page(policyPage, 'privacy', 'A', {}, []),
        ],
      }),
    ],
    documents: documents(
      [doc('impressum'), makeDocument({ kind: 'privacy', url: policyPage, foundVia: 'link', errors })],
      [att('impressum', 'link', IMPRESSUM, 200, 'found'), att('privacy', 'link', policyPage, 200, outcome)],
    ),
  });
  it.each<Scenario>([
    {
      name: 'a soft-404 fallback remains observed but is not a checked page',
      input: probed(probe(), att('impressum', 'fallback', IMPRESSUM, 200, 'soft-404')),
      expected: {
        first: { variant: 'document-not-found', params: { pageTotal: 1, missingCount: 1 } },
        pages: [START],
        coverage: { observed: 2, evaluated: 1 },
      },
    },
    {
      name: 'an unconfirmed fallback is excluded by its final URL',
      input: probed(
        probe({ finalUrl: `${ORIGIN}/home` }),
        att('impressum', 'fallback', `${ORIGIN}/home`, 200, 'unconfirmed'),
      ),
      expected: { first: { params: { pageTotal: 1 } } },
    },
    {
      name: 'a challenge page remains observed without being evaluated',
      input: probed(
        probe({
          evaluable: false,
          notEvaluableReason: 'challenge',
          challenge: { detected: true, kind: 'cloudflare', signals: ['status:403'] },
        }),
        att('impressum', 'fallback', IMPRESSUM, 403, 'not-found'),
      ),
      expected: { coverage: { observed: 2, evaluated: 1 } },
    },
    {
      name: 'an ordinary navigation without a legal link is a checked page',
      input: probed(page(`${ORIGIN}/team`, 'nav', 'A', {}, []), fallback()),
      expected: { first: { params: { pageTotal: 2, missingCount: 2 } } },
    },
    {
      name: 'a truncated link list cannot establish missing links',
      input: { phases: [phase('A', { pages: [page(START, 'start', 'A', {}, footerLinks()), truncated] })] },
      expected: {
        kinds: [],
        status: 'partial',
        limitations: ['impressum-links-truncated', 'privacy-links-truncated'],
      },
    },
    {
      name: 'fallback documents with only a truncated page are not indirect reachability findings',
      input: {
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', { dom: { ...makeDom({ links: [] }), linksTruncated: true } }, []),
            ],
          }),
        ],
        documents: documents([
          makeDocument({ kind: 'impressum', url: IMPRESSUM, foundVia: 'fallback' }),
          makeDocument({ kind: 'privacy', url: PRIVACY, foundVia: 'fallback' }),
        ]),
      },
      expected: { kinds: [], limitations: ['impressum-links-truncated', 'privacy-links-truncated'] },
    },
    {
      name: 'a complete page without links still counts beside a truncated page',
      input: {
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, footerLinks()),
              truncated,
              page(`${ORIGIN}/team`, 'nav', 'A', {}, []),
            ],
          }),
        ],
      },
      expected: {
        kinds: [
          ['impressum', 'link-missing-on-some-pages'],
          ['privacy', 'link-missing-on-some-pages'],
        ],
        first: { params: { missingCount: 1, pageTotal: 2 } },
      },
    },
    {
      name: 'a soft-404 privacy target does not inflate Impressum coverage',
      input: crossKind('soft-404', ['soft-404']),
      expected: {
        emptySubject: 'impressum',
        coverage: { observed: 3, evaluated: 2, note: 'error-page-probes:1' },
      },
    },
    {
      name: 'a substantive but unconfirmed policy stays in the Impressum denominator',
      input: crossKind('unconfirmed', ['unconfirmed']),
      expected: {
        firstSubject: 'impressum',
        first: { variant: 'link-missing-on-some-pages', params: { pageTotal: 2, missingCount: 1 } },
        pages: [policyPage],
      },
    },
  ])('$name', ({ input, expected }) => verify(input, expected));
});

describe('LEGAL-01 unavailable and unconfirmed targets', () => {
  const legal = `${ORIGIN}/rechtliches`;
  const viaFallback = makeDocument({ kind: 'privacy', url: PRIVACY, foundVia: 'fallback' });
  it.each<Scenario>([
    ...[
      {
        name: 'a challenge and an unchecked alternative',
        status: 403,
        outcome: 'not-found' as const,
        extra: {
          notEvaluableReason: 'challenge',
          challenge: { detected: true, kind: 'cloudflare' as const, signals: ['status:403'] },
        },
        links: [link('Datenschutzhinweise', `${ORIGIN}/datenschutz/cookies/`)],
      },
      {
        name: 'a failed navigation',
        status: null,
        outcome: 'error' as const,
        extra: { notEvaluableReason: 'navigation-failed:net::ERR_TOO_MANY_REDIRECTS' },
        links: [],
      },
    ].map(({ name, status, outcome, extra, links }) => ({
      name: `${name} is a limitation rather than a broken link`,
      input: {
        phases: [
          phase('A', {
            pages: [
              ...twoPages([impressum(), privacy(), ...links]),
              page(PRIVACY, 'privacy', 'A', { evaluable: false, ...extra }),
            ],
          }),
        ],
        documents: documents([doc('impressum')], [att('privacy', 'link', PRIVACY, status, outcome)]),
      },
      expected: { status: 'partial', limitations: ['privacy-target-not-evaluable'], kinds: [] },
    })),
    {
      name: 'an unconfirmed direct target remains a limitation when a fallback works',
      input: linked(
        [impressum(), privacy(legal)],
        [doc('impressum'), viaFallback],
        [att('privacy', 'link', legal, 200, 'unconfirmed')],
      ),
      expected: { status: 'partial', limitations: ['privacy-type-unconfirmed'], kinds: [] },
    },
    {
      name: 'a stored unconfirmed direct target remains a limitation when a fallback works',
      input: linked(
        [impressum(), privacy(legal)],
        [
          doc('impressum'),
          makeDocument({ kind: 'privacy', url: legal, foundVia: 'link', errors: ['unconfirmed'] }),
          viaFallback,
        ],
      ),
      expected: { limitations: ['privacy-type-unconfirmed'], kinds: [] },
    },
    {
      name: 'an unfetched direct target leaves indirect reachability available',
      input: linked([impressum(), privacy(legal)], [doc('impressum'), viaFallback]),
      expected: { kinds: missing('privacy', 'reachable-via-intermediate'), limitations: [] },
    },
  ])('$name', ({ input, expected }) => verify(input, expected));
});

describe('LEGAL-01 confidence of footer coverage', () => {
  it.each([
    { name: 'heuristic banner geometry', heuristic: true, measured: false, confidence: 'medium' },
    {
      name: 'measured link overlap with a heuristic banner',
      heuristic: true,
      measured: true,
      confidence: 'high',
    },
    { name: 'an adapter with high recognition', heuristic: false, measured: false, confidence: 'high' },
  ])('$name yields $confidence confidence', ({ heuristic, measured, confidence }) => {
    const facts = cmpFacts(
      heuristic
        ? {
            detection: {
              cmpId: null,
              method: 'heuristic',
              version: null,
              versionSupported: null,
              recognitionConfidence: 'medium',
              signals: ['dom:fixed-bottom'],
            },
          }
        : {},
    );
    facts.firstLayer = {
      ...facts.firstLayer,
      bannerPresent: true,
      bannerVisible: true,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
      coversFooter: true,
      legalLinks: [],
      ...(measured
        ? {
            coveredFooterLinks: [
              {
                label: 'Impressum',
                box: { x: 0, y: 700, width: 80, height: 20 },
                coveredBy: 'banner' as const,
              },
            ],
          }
        : {}),
    };
    const result = runCheck(legal01, site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) }));
    const covers = observationsOf(result).filter((o) => o.variant === 'footer-covered-by-banner');
    expect(covers.length).toBeGreaterThan(0);
    expect(covers.every((o) => o.confidence === confidence)).toBe(true);
    expect(variantsOf(result)).toContain('footer-covered-by-banner');
  });
});
