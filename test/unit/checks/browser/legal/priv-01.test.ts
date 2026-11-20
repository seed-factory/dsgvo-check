import { describe, expect, it } from 'vitest';
import { priv01 } from '../../../../../src/checks/browser/priv-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../../../../src/core/snapshot/browser.ts';
import { makeDom, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  click,
  cookie,
  defaultDocuments,
  ORIGIN,
  PRIVACY,
  page,
  phase,
  privacyDoc,
  req,
  runSiteCheck,
  START as START_URL,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { ga } from '../scenarios/shared.ts';
import { noticeAttempt } from './legal-01-verify.ts';

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
const runWithPolicy = (
  parts: DocumentPart[],
  p: Partial<DocumentRecord> = {},
  attempts: DocumentsSection['attempts'] = [],
) =>
  runSiteCheck(priv01, {
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

  it('inconclusive: a linked PDF policy that was not fetched (status null) is still a PDF, not "not found"', () => {
    const r = runSiteCheck(priv01, {
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
    });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'pdf-not-evaluated' });
  });

  it('counterexample: only a category description → category-only (info) with a quote ≤ 200 chars', () => {
    const r = runWithPolicy([part('Wir zeigen Kundenbewertungen über ein externes Bewertungs-Widget an.')]);
    const [o] = observationsOf(r);
    expect(o?.variant).toBe('category-only');
    const match = o?.evidence.find((e) => e.type === 'text-match');
    expect(match).toMatchObject({ matchLevel: 'category', negation: 'none' });
    expect((match as { quote: string }).quote.length).toBeLessThanOrEqual(200);
  });

  it('named and domain levels count as found', () => {
    expect(variantsOf(runWithPolicy([part('Wir nutzen Trust­index (Bewertungen).')]))).toEqual([]);
    expect(variantsOf(runWithPolicy([part('Daten werden an trustindex.io übertragen.')]))).toEqual([]);
  });

  it('expandable parts not opened (banner open) → partial with limitation', () => {
    const r = runWithPolicy([part('Trustindex')], {
      manifest: {
        expandablesFound: 3,
        expandablesOpened: 0,
        framesIncluded: 0,
        linkedPages: 0,
        textLength: 10,
      },
    });
    expect(r).toMatchObject({ status: 'partial' });
    expect(r.outcome?.limitations).toEqual(['banner-open']);
  });

  it('no privacy policy → inconclusive (LEGAL-01 reports it); incomplete or foreign language → inconclusive', () => {
    const none = runSiteCheck(priv01, { phases: [trustindex()], documents: { documents: [], attempts: [] } });
    expect(none).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(runWithPolicy([part('x')], { complete: false })).toMatchObject({
      reason: 'document-incomplete',
    });
    expect(runWithPolicy([part('x')], { lang: 'fr' })).toMatchObject({
      reason: 'language-unsupported',
    });
  });

  it('a "Datenschutz" link target judged not a policy (keyword missing) is not searched → no not-named', () => {
    const r = runWithPolicy([part('Willkommen in unserem Shop.')], { errors: ['keyword-missing'] });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('services that were not loaded or are not policy-relevant are not evaluated', () => {
    const r = runSiteCheck(priv01, {
      phases: [
        phase('A', {
          requests: [
            req('a', 'https://cdn.trustindex.io/loader.js', { state: 'failed' }),
            req('b', 'https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js'),
          ],
        }),
      ],
    });
    expect(variantsOf(r)).toEqual([]);
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
    const result = runWithPolicy(parts, document, attempts);

    expect(result.status).toBe(status);
    if (reason) expect(result.reason).toBe(reason);
    if (variants) expect(variantsOf(result)).toEqual(variants);
    if (limitations) expect(result.outcome?.limitations).toEqual(limitations);
  });

  it('a failed policy navigation yields no document and no finding', () => {
    const result = runSiteCheck(priv01, {
      phases: [trustindex()],
      documents: {
        documents: [defaultDocuments().documents[0]!],
        attempts: [{ kind: 'privacy', via: 'link', url: PRIVACY, status: null, outcome: 'error' }],
      },
    });

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

  it('reports the document manifest and searched part count', () => {
    const [observation] = observationsOf(runWithPolicy(parts, { manifest }));
    expect(observation).toMatchObject({
      variant: 'not-named',
      params: { partCount: 4, complete: true },
    });
    expect(observation?.evidence[0]).toMatchObject({ type: 'document', manifest: expectedManifest });
  });
});

describe('PRIV-01 says what it searched for', () => {
  it('a policy naming the same company for another service: not-named lists the company names searched', () => {
    const r = runSiteCheck(priv01, {
      phases: [phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC')] })],
      documents: {
        documents: [
          defaultDocuments().documents[0]!,
          privacyDoc([
            part('Wir nutzen Google Analytics. Anbieter ist Google Inc.', 'visible', '3 > Analyse'),
          ]),
        ],
        attempts: [],
      },
    });
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'not-named',
      subject: 'google-tag-manager',
      params: { companies: 'Google Ireland Limited, Google LLC' },
    });
    const de = renderMessage(loadTexts('de'), 'PRIV-01.not-named', o!.params).body;
    expect(de).toContain('die Firmennamen laut Dienstekatalog (Google Ireland Limited, Google LLC)');
    expect(de).toContain(
      'Die Nennung eines anderen Dienstes desselben Unternehmens gilt nicht als Nennung von Google Tag Manager.',
    );
    expect(de).not.toMatch(/keine Nennung von Google Tag Manager, des Anbieters/);
    expect(renderMessage(loadTexts('en'), 'PRIV-01.not-named', o!.params).body).toContain(
      'the company names per service catalogue (Google Ireland Limited, Google LLC)',
    );
  });
});

describe('PRIV-01 where the service was seen', () => {
  const policy = () => ({
    documents: [defaultDocuments().documents[0]!, privacyDoc([part('Wir verwenden keine Werbedienste.')])],
    attempts: [],
  });
  const ads = (id: string, p = {}) =>
    req(id, 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?gcd=1', {
      resourceType: 'script',
      ...p,
    });

  it('pages and phases come from its requests and stored identifiers, as in the inventory; a test cookie is none', () => {
    const r = runSiteCheck(priv01, {
      phases: [
        phase('A', { requests: [ads('a')] }),
        phase('B', {
          click: click('reject'),
          // The catalog names test_cookie as no identifier: it does not make B a phase in which the service was seen.
          cookies: [
            cookie('test_cookie', {
              domain: '.doubleclick.net',
              firstParty: false,
              phase: 'B',
              afterClick: true,
              setter: 'http-response',
              setterHost: 'googleads.g.doubleclick.net',
            }),
          ],
        }),
        phase('C', {
          click: click('accept'),
          cookies: [
            cookie('IDE', {
              domain: '.doubleclick.net',
              firstParty: false,
              phase: 'C',
              afterClick: true,
              setter: 'http-response',
              setterHost: 'googleads.g.doubleclick.net',
            }),
          ],
        }),
      ],
      documents: policy(),
    });
    const services = observationsOf(r).map((o) => o.subject);
    // IDE and test_cookie were set by the Google Ads host: no separate Marketing Platform finding.
    expect(services).toEqual(['google-ads']);
    const [o] = observationsOf(r);
    expect(o!.phases).toEqual(['A', 'C']);
    expect(o!.params).toMatchObject({ requestCount: 1, pageCount: 1 });
    expect(o!.evidence.map((e) => e.type)).toEqual(['document', 'request', 'cookie']);
    expect(o!.evidence.at(-1)).toMatchObject({ name: 'IDE', setterHost: 'googleads.g.doubleclick.net' });
  });
});

describe('PRIV-01 further privacy notices of the site', () => {
  const SUPPLEMENT = `${ORIGIN}/datenschutzhinweise-kurse/`;
  const inSupplement = (
    text: string,
    origin: DocumentPart['origin'] = 'visible',
    section = '3 > Kommunikation',
  ) => ({
    id: `s-${text.length}-${origin}`,
    section,
    text,
    origin,
    sourceUrl: SUPPLEMENT,
  });
  const supplement = (parts: DocumentPart[], p: Partial<DocumentRecord> = {}) =>
    privacyDoc(parts, { id: 'doc-privacy-3', url: SUPPLEMENT, role: 'supplement', ...p });
  // A generator template without any chat or translation service.
  const MAIN = [
    part('Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.', 'visible', '1 > Verantwortlicher'),
    part(
      'Die Schriftarten sind lokal installiert. Eine Verbindung zu fremden Servern findet dabei nicht statt.',
      'visible',
      '5 > Plugins und Tools > Schriftarten',
    ),
  ];
  const chatAndTranslation = (p: Parameters<typeof phase>[1] = {}) =>
    phase('A', {
      requests: [req('t', 'https://code.tidio.co/abc.js'), req('w', 'https://cdn.weglot.com/weglot.min.js')],
      ...p,
    });
  const runWithNotices = (
    notices: DocumentRecord[],
    attempts: DocumentsSection['attempts'] = [],
    o: { main?: DocumentRecord | null; phases?: ReturnType<typeof phase>[] } = {},
  ) =>
    runSiteCheck(priv01, {
      phases: o.phases ?? [chatAndTranslation()],
      documents: {
        documents: [
          defaultDocuments().documents[0]!,
          ...(o.main === null ? [] : [o.main ?? privacyDoc(MAIN)]),
          ...notices,
        ],
        attempts,
      },
    });
  const found = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r)
      .map((o) => [o.subject, o.variant])
      .sort();
  const NAMED = inSupplement('Für Rückfragen nutzen wir den Live-Chat Tidio (Tidio LLC).');
  const BOTH_UNNAMED = [
    ['tidio', 'not-named'],
    ['weglot', 'not-named'],
  ];

  it('a service named only in the further notice counts as named; a service named nowhere stays not-named', () => {
    const r = runWithNotices([supplement([NAMED])]);
    expect(r.status).toBe('completed');
    expect(found(r)).toEqual([['weglot', 'not-named']]);
    const [o] = observationsOf(r);
    expect(o!.params).toMatchObject({
      policyUrl: PRIVACY,
      policyUrls: `${PRIVACY}, ${SUPPLEMENT}`,
      documentCount: 2,
      partCount: 3,
    });
    // Each searched document has its own document evidence, the policy first, each with its own manifest.
    const docs = o!.evidence.filter((e) => e.type === 'document');
    expect(docs.map((e) => (e as { url: string }).url)).toEqual([PRIVACY, SUPPLEMENT]);
    expect(docs.map((e) => (e as { manifest: { partCount: number } }).manifest.partCount)).toEqual([2, 1]);
  });

  it('counterexample: without the further notice both services are not-named', () => {
    expect(found(runWithNotices([]))).toEqual(BOTH_UNNAMED);
  });

  it.each(['Tidio', 'Tidio Chat', 'Tidio-Chat', 'Tidio LLC', 'tidio.com', 'Live-Chat von Tidio'])(
    'the spelling "%s" in the further notice counts as named',
    (spelling) => {
      const r = runWithNotices([supplement([inSupplement(`Wir nutzen ${spelling} für Anfragen.`)])]);
      expect(found(r).filter(([s]) => s === 'tidio')).toEqual([]);
    },
  );

  it('only a category word in the further notice gives category-only, quoted from that notice', () => {
    const r = runWithNotices([
      supplement([inSupplement('Für Anfragen nutzen wir ein Chat-Widget auf der Website.')]),
    ]);
    const tidio = observationsOf(r).find((o) => o.subject === 'tidio');
    expect(tidio?.variant).toBe('category-only');
    expect(tidio?.evidence.find((e) => e.type === 'text-match')).toMatchObject({
      documentId: 'doc-privacy-3',
    });
  });

  it('the name only in a hidden part of the further notice gives ambiguous-match', () => {
    const r = runWithNotices([
      supplement([inSupplement('Kursanmeldung.'), inSupplement('Tidio Vorlage', 'hidden-irrelevant')]),
    ]);
    expect(observationsOf(r).find((o) => o.subject === 'tidio')?.variant).toBe('ambiguous-match');
  });

  it('a frame title on the page is no policy text: the service stays not-named', () => {
    const frame = {
      src: 'https://code.tidio.co/widget',
      srcdoc: false,
      title: 'Tidio Chat code',
      visible: false,
      box: { x: 0, y: 0, width: 0, height: 0 },
      depth: 1,
    };
    const start = page(START_URL, 'start', 'A', { dom: makeDom({ iframes: [frame] }) });
    const r = runWithNotices([], [], { phases: [chatAndTranslation({ pages: [start] })] });
    expect(found(r)).toContainEqual(['tidio', 'not-named']);
  });

  interface UnreadCase {
    name: string;
    notices: DocumentRecord[];
    attempts?: DocumentsSection['attempts'];
  }
  it.each<UnreadCase>([
    {
      name: 'a truncated notice',
      notices: [supplement([NAMED], { complete: false, errors: ['truncated'] })],
    },
    {
      name: 'a PDF notice',
      notices: [
        supplement([], {
          url: `${ORIGIN}/kurse.pdf`,
          format: 'pdf',
          status: null,
          complete: false,
          errors: ['pdf-not-evaluated'],
        }),
      ],
    },
    { name: 'a notice in another language', notices: [supplement([NAMED], { lang: 'fr' })] },
    {
      name: 'another language version of the policy',
      notices: [],
      attempts: [noticeAttempt(`${ORIGIN}/en/datenschutz/`, null, 'other-language')],
    },
    {
      name: 'a notice whose page failed to load',
      notices: [],
      attempts: [noticeAttempt(SUPPLEMENT, null, 'error')],
    },
  ])(
    '$name: partial with supplement-not-evaluated, the policy is still evaluated',
    ({ notices, attempts }) => {
      const r = runWithNotices(notices, attempts);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['supplement-not-evaluated']);
      // The unread notice is not searched: Tidio stays not-named beside Weglot.
      expect(found(r)).toEqual(BOTH_UNNAMED);
      expect(observationsOf(r)[0]!.params).toMatchObject({ documentCount: 1, policyUrls: PRIVACY });
    },
  );

  it.each<UnreadCase>([
    { name: 'a page not confirmed as a notice', notices: [supplement([NAMED], { errors: ['unconfirmed'] })] },
    { name: 'an error page', notices: [supplement([NAMED], { errors: ['soft-404'] })] },
    {
      name: 'a link that answered 404',
      notices: [],
      attempts: [noticeAttempt(SUPPLEMENT, 404, 'not-found')],
    },
  ])('$name is no notice: completed without a limitation', ({ notices, attempts }) => {
    const r = runWithNotices(notices, attempts);
    expect(r.status).toBe('completed');
    expect(r.outcome?.limitations ?? []).toEqual([]);
    expect(found(r)).toEqual(BOTH_UNNAMED);
  });

  it('a notice whose redacted URL equals that of the policy does not take the policy with it', () => {
    // Both pages differ only in a query value, which the snapshot keeps as `[redacted]`.
    const shared = `${ORIGIN}/index.php?page=[redacted]`;
    const r = runWithNotices(
      [supplement([NAMED], { url: shared, finalUrl: shared, errors: ['unconfirmed'] })],
      [
        { kind: 'privacy', via: 'link', url: shared, status: 200, outcome: 'found' },
        noticeAttempt(shared, 200, 'unconfirmed'),
      ],
      { main: privacyDoc(MAIN, { url: shared, finalUrl: shared }) },
    );
    expect(r).toMatchObject({ status: 'completed', reason: null });
    expect(found(r)).toEqual(BOTH_UNNAMED);
  });

  it.each([
    ['an unconfirmed notice', supplement([NAMED], { errors: ['unconfirmed'] })],
    ['a readable notice', supplement([NAMED])],
  ])('%s without a policy is no policy: inconclusive privacy-policy-not-found', (_, notice) => {
    const r = runWithNotices([notice], [], { main: null });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('a truncated policy still makes the check inconclusive, whatever the notices', () => {
    const r = runWithNotices([supplement([NAMED])], [], {
      main: privacyDoc(MAIN, { complete: false, errors: ['truncated'] }),
    });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'document-incomplete' });
  });

  it('a snapshot of an earlier version without roles: every privacy document is a policy, as before', () => {
    const second = privacyDoc([NAMED], { id: 'doc-privacy-3', url: SUPPLEMENT });
    expect(found(runWithNotices([second]))).toEqual([['weglot', 'not-named']]);
    const truncated = privacyDoc([NAMED], {
      id: 'doc-privacy-3',
      url: SUPPLEMENT,
      complete: false,
      errors: ['truncated'],
    });
    expect(runWithNotices([truncated])).toMatchObject({
      status: 'inconclusive',
      reason: 'document-incomplete',
    });
  });

  it.each(['de', 'en'] as const)('the %s texts name the policy and the further notice', (lang) => {
    const [o] = observationsOf(runWithNotices([supplement([NAMED])]));
    const body = renderMessage(loadTexts(lang), 'PRIV-01.not-named', o!.params).body;
    expect(body).toContain(PRIVACY);
    expect(body).toContain(SUPPLEMENT);
    const single = observationsOf(runWithNotices([]))[0]!;
    expect(renderMessage(loadTexts(lang), 'PRIV-01.not-named', single.params).body).not.toContain(SUPPLEMENT);
  });
});

describe('PRIV-01 a policy that covers Google Analytics only', () => {
  const tags = () =>
    phase('A', {
      requests: [
        req('gtm', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC'),
        req('ads', 'https://www.googleadservices.com/pagead/conversion/123/', { resourceType: 'image' }),
        ga.hit('ga'),
      ],
    });
  // The shape of an older generator template: one service section for Google Analytics, its operator as "Google Inc.".
  const GA_ONLY = [
    part(
      'Datenschutzerklärung der Beispiel GmbH.',
      'visible',
      'Datenschutzerklärung > 1. Begriffsbestimmungen',
    ),
    part('Diese Website verwendet Cookies.', 'visible', 'Datenschutzerklärung > 4. Cookies'),
    part(
      'Betreiber der Google-Analytics-Komponente ist die Google Inc., Mountain View, USA. Die IP-Adresse wird gekürzt.',
      'visible',
      'Datenschutzerklärung > 7. Einsatz von Google Analytics (mit Anonymisierung)',
    ),
  ];
  const run = (extra: DocumentPart[] = [], p: Partial<DocumentRecord> = {}) =>
    runSiteCheck(priv01, {
      phases: [tags()],
      documents: {
        documents: [defaultDocuments().documents[0]!, privacyDoc([...GA_ONLY, ...extra], p)],
        attempts: [],
      },
    });
  const verdicts = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r)
      .map((o) => [o.subject, o.variant])
      .sort();

  it('violation: Tag Manager and Ads loaded beside Analytics → not-named for both, nothing for Analytics', () => {
    expect(verdicts(run())).toEqual([
      ['google-ads', 'not-named'],
      ['google-tag-manager', 'not-named'],
    ]);
  });

  it.each([
    ['google-tag-manager', 'Google Tag Manager'],
    ['google-tag-manager', 'Google-Tag-Manager'],
    ['google-tag-manager', 'Google Tagmanager'],
    ['google-ads', 'Google Ads'],
    ['google-ads', 'Google AdWords'],
    ['google-ads', 'AdWords'],
    ['google-ads', 'Google Ads Conversion-Tracking'],
    ['google-ads', 'Google Remarketing'],
    ['google-ads', 'Google-Ads-Remarketing'],
  ])('clean: %s is named by "%s" in its own section', (service, spelling) => {
    const r = run([part(`Wir setzen ${spelling} ein.`, 'visible', `Datenschutzerklärung > 8. ${spelling}`)]);
    expect(verdicts(r).map(([s]) => s)).not.toContain(service);
  });

  it.each([
    ['google-tag-manager', 'Wir verwenden einen Tag Manager.'],
    ['google-tag-manager', 'Wir verwenden einen Tagmanager.'],
    ['google-ads', 'Wir nutzen Conversion-Tracking.'],
    ['google-ads', 'Wir nutzen Remarketing.'],
  ])('counterexample: a generic term is no product name → %s category-only (%s)', (service, text) => {
    const r = run([part(text, 'visible', 'Datenschutzerklärung > 8. Werbung')]);
    expect(observationsOf(r).find((o) => o.subject === service)?.variant).toBe('category-only');
  });

  it('counterexample: the Tag Manager named only in a hidden part → ambiguous-match', () => {
    const r = run([part('Google Tag Manager Vorlage', 'hidden-irrelevant')]);
    expect(observationsOf(r).find((o) => o.subject === 'google-tag-manager')?.variant).toBe(
      'ambiguous-match',
    );
  });

  it('inconclusive: the same policy cut off at the reading limit → document-incomplete, no not-named', () => {
    const r = run([], { complete: false, errors: ['truncated'] });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'document-incomplete' });
    expect(variantsOf(r)).toEqual([]);
  });

  // Today a company name in the Analytics section counts for every service of that company ("company" level).
  it.todo(
    '"Anbieter ist Google Ireland Limited" only in the Analytics section leaves Tag Manager and Ads not-named',
  );
});
