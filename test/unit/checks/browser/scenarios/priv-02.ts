/**
 * PRIV-02 fixtures: a policy part under "Plugins und Tools > Google Fonts" that states the fonts are installed locally,
 * held against what the browser loaded. Each variant has a violation, a clean, an inconclusive case and a
 * counterexample that looks like the violation but must stay silent or change variant.
 */
import type { CmpSection } from '../../../../../src/cmp/types.ts';
import type {
  DocumentPart,
  DocumentsSection,
  PhaseRecord,
  RequestRecord,
} from '../../../../../src/core/snapshot/browser.ts';
import { makeDocument, makeDom } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  cmpFacts,
  cmpWith,
  defaultDocuments,
  defaultPages,
  footerLinks,
  PRIVACY,
  page,
  phase,
  privacyDoc,
  rejectCmp,
  req,
  START,
  site,
} from '../helpers.ts';
import { ORIGIN_IMG, type Scenario } from './shared.ts';

export const FONTS_SECTION = 'Datenschutzerklärung > 5. Plugins und Tools > Google Fonts';
export const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Roboto';
const MAP_FRAME = 'https://www.google.com/maps/embed?pb=[redacted]';

/** The statement as policy generators phrase it: fonts installed locally, no connection to the provider's servers. */
export const LOCAL_CLAIM =
  'Wir nutzen Google Fonts für die Darstellung von Schriften. Die Google Fonts sind auf dieser Website lokal ' +
  'installiert. Eine Verbindung zu Servern von Google findet beim Seitenaufruf nicht statt.';

export const fontsPart = (
  text: string,
  p: Partial<DocumentPart> = {},
): DocumentPart & { section: string } => ({
  id: 'p-fonts',
  section: FONTS_SECTION,
  text,
  origin: 'visible',
  sourceUrl: PRIVACY,
  ...p,
});

/** The default policy (controller section) plus `parts`. */
export const policyWith = (...parts: DocumentPart[]) => ({
  documents: [
    defaultDocuments().documents[0]!,
    privacyDoc([
      {
        id: 'p1',
        section: '1 > Verantwortlicher',
        text: 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.',
        origin: 'visible' as const,
        sourceUrl: PRIVACY,
      },
      ...parts,
    ]),
  ],
  attempts: [],
});

export const fontsCss = (id: string, p: Partial<RequestRecord> = {}) =>
  req(id, FONTS_CSS, { resourceType: 'stylesheet', ...p });

/**
 * The fonts CSS loads from Google on the start and the contact page in phase A, held against `documents`; `cmp` are
 * the CMP facts of the scan, by default facts without a banner.
 */
export const fontsOnTwoPages = (documents: DocumentsSection, cmp?: CmpSection) =>
  site({
    phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] })],
    documents,
    cmp,
  });

/** Phase B after a reject: the start page reloaded, `requests` made after the click. */
export const afterReject = (requests: RequestRecord[]): PhaseRecord =>
  phase('B', { click: click('reject'), reloaded: true, requests });
export const bAfterClick = (id: string, url = FONTS_CSS, p: Partial<RequestRecord> = {}) =>
  req(id, url, { phase: 'B', afterClick: true, tRef: 'click', resourceType: 'stylesheet', ...p });
export const cAfterClick = (id: string, url: string, p: Partial<RequestRecord> = {}) =>
  req(id, url, { phase: 'C', afterClick: true, tRef: 'click', ...p });

/** A request of the Google Maps frame on the contact page after the accept. */
const mapFrameRequest = (id: string, url: string, resourceType: string) =>
  cAfterClick(id, url, {
    pageUrl: CONTACT,
    isMainFrame: false,
    frameId: 'frame-map',
    frameUrl: MAP_FRAME,
    resourceType,
    ...(resourceType === 'document' ? { isNavigation: true } : {}),
  });

const acceptPhase = (requests: RequestRecord[]) =>
  phase('C', {
    click: click('accept'),
    pages: [page(START, 'start', 'C'), page(CONTACT, 'contact', 'C')],
    requests,
  });

/** Fonts served by the site itself: the statement is true. */
const selfHostedFonts = () =>
  phase('A', {
    requests: [
      req('A-1', `${START}wp-content/fonts/roboto.css`, { resourceType: 'stylesheet' }),
      req('A-2', `${START}wp-content/fonts/body.woff2`, { resourceType: 'font' }),
    ],
  });

const botCmp = (): CmpSection =>
  cmpWith({
    phase: 'A',
    facts: [cmpFacts({ phase: 'A', botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] })],
  });

export const scenarios: Scenario[] = [
  {
    file: 'violation-local-fonts-claim-replicated.json',
    description:
      'The policy states the Google Fonts are installed locally without a connection to Google; the CSS loads from fonts.googleapis.com on the start and contact pages and again after a confirmed reject',
    expect: { status: 'completed', variants: ['contradiction-replicated'] },
    build: () =>
      site({
        phases: [
          phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] }),
          afterReject([bAfterClick('B-1')]),
        ],
        cmp: rejectCmp({ confirmed: true }),
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },
  {
    file: 'clean-local-fonts-true.json',
    description: 'Same statement; the fonts come from the site itself, nothing from a Google host',
    expect: { status: 'completed', variants: [] },
    build: () => site({ phases: [selfHostedFonts()], documents: policyWith(fontsPart(LOCAL_CLAIM)) }),
  },
  {
    file: 'inconclusive-claim-hedged.json',
    description:
      'The statement is hedged ("Soweit möglich") while the fonts load from Google: not evaluated (claim-ambiguous)',
    expect: { status: 'inconclusive', variants: [], reason: 'claim-ambiguous' },
    build: () =>
      fontsOnTwoPages(policyWith(fontsPart('Soweit möglich, sind die Google Fonts lokal installiert.'))),
  },
];

export const variantScenarios: Scenario[] = [
  // contradiction-replicated
  {
    file: 'violation-english-claim.json',
    description:
      'An English policy states the fonts are hosted locally with no connection to Google servers; the CSS loads on two pages',
    expect: { status: 'completed', variants: ['contradiction-replicated'] },
    build: () =>
      fontsOnTwoPages({
        documents: [
          defaultDocuments().documents[0]!,
          privacyDoc(
            [
              fontsPart('The fonts are hosted locally. No connection to Google servers is established.', {
                section: 'Privacy Policy > Google Fonts',
              }),
            ],
            { lang: 'en' },
          ),
        ],
        attempts: [],
      }),
  },
  {
    file: 'clean-fonts-in-maps-frame.json',
    description:
      'Counterexample: same statement; Google Fonts load only inside the Google Maps frame on the contact page after the accept, which belongs to the map',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          selfHostedFonts(),
          acceptPhase([
            mapFrameRequest('C-1', MAP_FRAME, 'document'),
            mapFrameRequest('C-2', 'https://fonts.googleapis.com/css?family=Roboto:300,400', 'stylesheet'),
            mapFrameRequest('C-3', 'https://fonts.gstatic.com/s/roboto/v30/frame.woff2', 'font'),
          ]),
        ],
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },
  {
    file: 'inconclusive-claim-only-hidden.json',
    description:
      'The statement stands only in a part the page hides while the fonts load from Google: not evaluated (claim-ambiguous)',
    expect: { status: 'inconclusive', variants: [], reason: 'claim-ambiguous' },
    build: () => fontsOnTwoPages(policyWith(fontsPart(LOCAL_CLAIM, { origin: 'hidden-irrelevant' }))),
  },
  {
    file: 'clean-claim-negated.json',
    description:
      'Counterexample: the policy says the Google Fonts are not installed locally; they load from Google',
    expect: { status: 'completed', variants: [] },
    build: () => fontsOnTwoPages(policyWith(fontsPart('Die Google Fonts sind nicht lokal installiert.'))),
  },

  // contradiction-single
  {
    file: 'violation-local-fonts-claim-single.json',
    description: 'Same statement; one CSS request on the start page in phase A, no phase B',
    expect: { status: 'completed', variants: ['contradiction-single'] },
    build: () =>
      site({
        phases: [phase('A', { requests: [fontsCss('A-1')] })],
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },
  {
    file: 'violation-maps-consent-gated.json',
    description:
      'The policy states Google Maps loads only once the visitor agrees; the map frame loads on the contact page before any interaction',
    expect: { status: 'completed', variants: ['contradiction-single'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', MAP_FRAME, {
                pageUrl: CONTACT,
                resourceType: 'document',
                isNavigation: true,
                isMainFrame: false,
                frameId: 'frame-map',
                frameUrl: MAP_FRAME,
              }),
            ],
          }),
        ],
        documents: policyWith(
          fontsPart('Google Maps wird erst geladen, wenn Sie zustimmen.', {
            section: 'Datenschutzerklärung > 5. Plugins und Tools > Google Maps',
          }),
        ),
      }),
  },
  {
    file: 'clean-consent-gated-after-accept-only.json',
    description: 'Same consent statement; the map loads only after the accept',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A'),
          acceptPhase([cAfterClick('C-1', MAP_FRAME, { pageUrl: CONTACT, resourceType: 'document' })]),
        ],
        documents: policyWith(
          fontsPart('Google Maps wird erst geladen, wenn Sie zustimmen.', {
            section: 'Datenschutzerklärung > 5. Plugins und Tools > Google Maps',
          }),
        ),
      }),
  },
  {
    file: 'clean-maps-js-fonts-after-accept.json',
    description:
      'Counterexample: same fonts statement; after the accept the contact page loads the Google Maps JavaScript API and its Roboto CSS in the main frame, which is not counted (partial)',
    expect: { status: 'partial', variants: [] },
    build: () =>
      site({
        phases: [
          selfHostedFonts(),
          acceptPhase([
            cAfterClick('C-1', 'https://maps.googleapis.com/maps/api/js?key=[redacted]', {
              pageUrl: CONTACT,
              navigationId: 'nav-c-contact',
            }),
            cAfterClick('C-2', 'https://fonts.googleapis.com/css?family=Roboto:300,400,500', {
              pageUrl: CONTACT,
              navigationId: 'nav-c-contact',
              resourceType: 'stylesheet',
            }),
          ]),
        ],
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },
  {
    file: 'inconclusive-bot-signal.json',
    description:
      'Same statement and one CSS request, but the consent banner reports a bot: not representative',
    expect: { status: 'inconclusive', variants: [], reason: 'bot-mode' },
    build: () =>
      site({
        phases: [phase('A', { requests: [fontsCss('A-1')] })],
        cmp: botCmp(),
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },

  // wording-to-review
  {
    file: 'violation-claim-and-disclosure.json',
    description:
      'The policy states the fonts are local and also describes the browser connecting to Google servers; the fonts load from Google',
    expect: { status: 'completed', variants: ['wording-to-review'] },
    build: () =>
      fontsOnTwoPages(
        policyWith(
          fontsPart(
            `${LOCAL_CLAIM} Dazu muss Ihr Browser eine Verbindung zu den Servern von Google aufbauen.`,
          ),
        ),
      ),
  },
  {
    file: 'violation-claim-attempt-only.json',
    description:
      'Same statement; the font requests to Google failed (net::ERR_FAILED) and the start page preconnects to fonts.gstatic.com',
    expect: { status: 'completed', variants: ['wording-to-review'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {
                dom: makeDom({
                  links: footerLinks(),
                  linkRels: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'dom' }],
                }),
              }),
              ...defaultPages('A').slice(1),
            ],
            requests: [
              fontsCss('A-1', { state: 'failed', status: undefined, failureText: 'net::ERR_FAILED' }),
              fontsCss('A-2', {
                pageUrl: CONTACT,
                state: 'failed',
                status: undefined,
                failureText: 'net::ERR_FAILED',
              }),
            ],
          }),
        ],
        documents: policyWith(fontsPart(LOCAL_CLAIM)),
      }),
  },
  {
    file: 'clean-claim-other-service.json',
    description:
      'Counterexample: under the Google Fonts heading the policy states Font Awesome is local; Google Fonts load, Font Awesome does not',
    expect: { status: 'completed', variants: [] },
    build: () =>
      fontsOnTwoPages(
        policyWith(
          fontsPart(
            'Font Awesome ist bei uns lokal installiert. Zu Servern von Fonticons, Inc. wird dabei keine Verbindung aufgebaut.',
          ),
        ),
      ),
  },
  {
    file: 'clean-optout-addon-sentence.json',
    description:
      'Counterexample: the opt-out add-on "tells Google Analytics that no data may be sent"; Google Analytics loads',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A', { requests: [req('A-1', 'https://www.googletagmanager.com/gtag/js?id=G-TEST1')] }),
        ],
        documents: policyWith(
          fontsPart(
            'Das Browser-Add-on zur Deaktivierung meldet Google Analytics, dass keine Daten übermittelt werden dürfen.',
            { section: 'Datenschutzerklärung > 4. Analyse-Tools > Google Analytics' },
          ),
        ),
      }),
  },
  {
    file: 'clean-maps-claim-fonts-loaded.json',
    description: 'Counterexample: a consent statement about Google Maps while only Google Fonts load',
    expect: { status: 'completed', variants: [] },
    build: () =>
      fontsOnTwoPages(
        policyWith(
          fontsPart('Google Maps wird erst geladen, wenn Sie zustimmen.', {
            section: 'Datenschutzerklärung > 5. Plugins und Tools > Google Maps',
          }),
        ),
      ),
  },
  {
    file: 'inconclusive-pdf.json',
    description: 'The privacy policy is only available as PDF: not evaluated in 1.0',
    expect: { status: 'inconclusive', variants: [], reason: 'pdf-not-evaluated' },
    build: () =>
      site({
        phases: [phase('A', { requests: [fontsCss('A-1')] })],
        documents: {
          documents: [
            makeDocument({
              kind: 'privacy',
              id: 'doc-privacy',
              url: `${ORIGIN_IMG}/datenschutz.pdf`,
              format: 'pdf',
              parts: [],
            }),
          ],
          attempts: [],
        },
      }),
  },
  {
    file: 'violation-claim-and-conditional-disclosure.json',
    description:
      'Counterexample to wording-to-review: the connection is described only under a condition ("Wenn Sie …"), so the statement is contradicted',
    expect: { status: 'completed', variants: ['contradiction-replicated'] },
    build: () =>
      fontsOnTwoPages(
        policyWith(
          fontsPart(
            `${LOCAL_CLAIM} Wenn Sie externe Inhalte zulassen, baut Ihr Browser eine Verbindung zu den Servern von Google auf.`,
          ),
        ),
      ),
  },
];
