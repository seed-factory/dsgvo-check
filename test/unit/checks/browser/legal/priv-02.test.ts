/**
 * PRIV-02: statements of the privacy policy about how a service is embedded, read sentence by sentence and held
 * against what the browser loaded. The matcher table covers the dictionary rules, the check cases the levels,
 * the evidence and the moments that count.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../../src/checks/browser/index.ts';
import {
  claimsFromData,
  hasPhrase,
  namedServices,
  QUOTE_MAX_CHARS,
  readPolicyClaims,
  serviceVocabulary,
  splitSentences,
  words,
} from '../../../../../src/checks/browser/policy-claims.ts';
import { priv01 } from '../../../../../src/checks/browser/priv-01.ts';
import { priv02 } from '../../../../../src/checks/browser/priv-02.ts';
import { loadDataDir, loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage } from '../../../../../src/core/data/messages.ts';
import { CheckRegistry } from '../../../../../src/core/evaluation/registry.ts';
import { EvidenceSchema } from '../../../../../src/core/report/schema.ts';
import { silentLogger } from '../../../../../src/core/runtime/logger.ts';
import type { DocumentPart } from '../../../../../src/core/snapshot/browser.ts';
import { toSavedSnapshot } from '../../../../../src/core/snapshot/index.ts';
import type { ServiceCategory } from '../../../../../src/derive/types.ts';
import { scan } from '../../../../../src/scan.ts';
import {
  checkContext,
  FIXED_NOW,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  cmpFacts,
  cmpWith,
  IMPRESSUM,
  PRIVACY,
  phase,
  privacyDoc,
  req,
  START,
  site,
} from '../helpers.ts';
import { scenariosOf } from '../scenarios/index.ts';
import {
  afterReject,
  bAfterClick,
  cAfterClick,
  FONTS_CSS,
  FONTS_SECTION,
  fontsCss,
  fontsPart,
  LOCAL_CLAIM,
  policyWith,
} from '../scenarios/priv-02.ts';
import { confirmedReject } from '../scenarios/shared.ts';

const scenario = (file: string) =>
  scenariosOf('PRIV-02')
    .find((s) => s.file === file)!
    .build();
const claims = claimsFromData(loadDataDir('legal'));
const vocab = serviceVocabulary(site().derived?.serviceNames ?? []);

const part = (text: string, section: string, origin: DocumentPart['origin'] = 'visible') => ({
  id: 'p',
  section,
  text,
  origin,
  sourceUrl: PRIVACY,
  documentId: 'doc-privacy',
});

/** Statements read from one part as `kind service… via [ambiguity]`, disclosures as `disclosure kind service…`. */
function read(
  text: string,
  section = FONTS_SECTION,
  opts: { origin?: DocumentPart['origin']; observed?: Partial<Record<ServiceCategory, string[]>> } = {},
) {
  const observed = new Map(Object.entries(opts.observed ?? {}) as Array<[ServiceCategory, string[]]>);
  const r = readPolicyClaims([part(text, section, opts.origin)], claims, vocab, observed);
  return [
    ...r.claims.map(
      (c) => `${c.kind} ${c.serviceIds.join(',')} ${c.via}${c.ambiguous ? ` [${c.ambiguous}]` : ''}`,
    ),
    ...r.disclosures.map((d) => `disclosure ${d.kind} ${d.serviceIds.join(',')}`),
  ];
}

describe('sentences and phrases', () => {
  it.each<[string, string, string[]]>([
    [
      'abbreviations, initials and ordinals end no sentence',
      'Online-Karten (z. B. Google Maps) gem. Art. 6 Abs. 1 lit. f DSGVO. Siehe 5. Plugins und Tools. Ende.',
      [
        'Online-Karten (z. B. Google Maps) gem. Art. 6 Abs. 1 lit. f DSGVO.',
        'Siehe 5. Plugins und Tools.',
        'Ende.',
      ],
    ],
    [
      'a company form before a lower-case word stays in the sentence',
      'Zu Servern von Fonticons, Inc. wird keine Verbindung aufgebaut. Danach folgt mehr.',
      ['Zu Servern von Fonticons, Inc. wird keine Verbindung aufgebaut.', 'Danach folgt mehr.'],
    ],
    [
      'dots of a URL or a domain end no sentence; a year does',
      'Die Schriften liegen unter https://www.example.test/fonts/roboto.css bereit. Seit 2024. Danach fonts.example.test lädt.',
      [
        'Die Schriften liegen unter https://www.example.test/fonts/roboto.css bereit.',
        'Seit 2024.',
        'Danach fonts.example.test lädt.',
      ],
    ],
    [
      'quotes and question marks close a sentence',
      'Sie lesen „Die Fonts sind lokal.“ Warum? Weil es so ist!',
      ['Sie lesen „Die Fonts sind lokal.“', 'Warum?', 'Weil es so ist!'],
    ],
    [
      'footer text after a sentence is a sentence of its own',
      'Das ist so. Copyright © Beispiel GmbH.',
      ['Das ist so.', 'Copyright © Beispiel GmbH.'],
    ],
  ])('%s', (_, text, expected) => {
    expect(splitSentences(text, claims.abbreviations)).toEqual(expected);
  });

  it('a word ending in * may continue, other words match whole', () => {
    const tokens = words('Eine Verbindung zu den Servern von Google');
    const phrase = (p: string) =>
      p.split(' ').map((w) => ({ w: w.replace(/\*$/, ''), prefix: w.endsWith('*') }));
    expect(hasPhrase(tokens, phrase('server* von'))).toBe(true);
    expect(hasPhrase(tokens, phrase('server von'))).toBe(false);
    expect(hasPhrase(tokens, phrase('verbindung zu'))).toBe(true);
    expect(hasPhrase(tokens, phrase('zu verbindung'))).toBe(false);
  });

  it('a catalog name counts once, inside a longer name it is that longer name; "Google" alone names no service', () => {
    expect(namedServices(words('Wir nutzen die Google Maps Platform.'), vocab)).toEqual(['google-maps']);
    expect(namedServices(words('Die Google Web Fonts.'), vocab)).toEqual(['google-fonts']);
    expect(namedServices(words('Server von Google.'), vocab)).toEqual([]);
    expect(namedServices(words('Google Fonts und Font Awesome.'), vocab)).toEqual([
      'font-awesome-cdn',
      'google-fonts',
    ]);
  });
});

describe('statements of the policy', () => {
  it.each<{
    name: string;
    text: string;
    section?: string;
    origin?: DocumentPart['origin'];
    observed?: Partial<Record<ServiceCategory, string[]>>;
    expected: string[];
  }>([
    {
      name: 'local fonts and no connection: the service from the sentence, the company sentence from the heading',
      text: LOCAL_CLAIM,
      expected: ['self-hosted google-fonts sentence', 'no-connection google-fonts heading'],
    },
    {
      name: 'a reversal ("nicht lokal") drops the statement',
      text: 'Die Google Fonts sind nicht lokal installiert.',
      expected: [],
    },
    {
      name: 'a hedge keeps the statement as ambiguous',
      text: 'Soweit möglich, sind die Google Fonts lokal installiert.',
      expected: ['self-hosted google-fonts sentence [hedge]'],
    },
    {
      name: 'the opt-out add-on sentence is no statement even under a service heading',
      text: 'Das Browser-Add-on zur Deaktivierung meldet Google, dass keine Daten übermittelt werden dürfen.',
      expected: [],
    },
    {
      name: 'a modal verb makes no statement',
      text: 'Eine Verbindung zu Servern von Google sollte nicht stattfinden.',
      expected: [],
    },
    {
      name: 'the subject from the previous sentence when the heading names none',
      text: 'Wir verwenden Google Fonts. Diese sind lokal eingebunden.',
      section: 'Datenschutzerklärung > Schriftarten',
      expected: ['self-hosted google-fonts previous-sentence'],
    },
    {
      name: 'a company sentence binds to the heading service of that company only',
      text: 'Eine Verbindung zu Servern von Adobe findet dabei nicht statt.',
      expected: [],
    },
    {
      name: 'a company alone is no subject without a service in heading or previous sentence',
      text: 'Die Inhalte von Google sind lokal installiert.',
      section: 'Datenschutzerklärung > Externe Dienste',
      observed: { fonts: ['google-fonts'], analytics: ['google-analytics'] },
      expected: [],
    },
    {
      name: 'a category statement with a quantifier covers every observed service of the category',
      text: 'Alle Schriftarten werden lokal eingebunden.',
      section: 'Datenschutzerklärung > Schriftarten',
      observed: { fonts: ['adobe-fonts', 'google-fonts'], maps: ['google-maps'] },
      expected: ['self-hosted adobe-fonts,google-fonts category'],
    },
    {
      name: 'a category statement without a quantifier names nothing',
      text: 'Die Schriftarten werden lokal eingebunden.',
      section: 'Datenschutzerklärung > Schriftarten',
      observed: { fonts: ['google-fonts'] },
      expected: [],
    },
    {
      name: 'a category word does not inherit a service of another category',
      text: 'Die Schriften sind lokal eingebunden.',
      section: 'Datenschutzerklärung > Google Maps',
      expected: [],
    },
    {
      name: 'a named service that was not observed stays the subject, also under another heading',
      text: 'Font Awesome ist lokal installiert.',
      observed: { fonts: ['google-fonts'] },
      expected: ['self-hosted font-awesome-cdn sentence'],
    },
    {
      name: 'a named service outside the categories of the kind is no subject',
      text: 'Google Analytics wird erst geladen, wenn Sie zustimmen.',
      expected: [],
    },
    {
      name: 'text the page hides keeps the statement as ambiguous',
      text: 'Google Fonts sind bei uns lokal installiert.',
      origin: 'hidden-irrelevant',
      expected: ['self-hosted google-fonts sentence [hidden]'],
    },
    {
      name: 'a sentence too long to quote whole keeps the statement as ambiguous',
      text: `Google Fonts sind bei uns lokal installiert, ${'und das gilt für alle Unterseiten dieser Website '.repeat(4)}ohne Ausnahme.`,
      expected: ['self-hosted google-fonts sentence [long-sentence]'],
    },
    { name: 'a question states nothing', text: 'Sind die Google Fonts lokal installiert?', expected: [] },
    {
      name: 'English: the subject from the heading, the company sentence too',
      text: 'The fonts are hosted locally. No connection to Google servers is established.',
      section: 'Privacy Policy > Google Fonts',
      expected: ['self-hosted google-fonts heading', 'no-connection google-fonts heading'],
    },
    {
      name: 'consent-gated: "erst" and "wenn" belong to the statement',
      text: 'Google Maps wird erst geladen, wenn Sie zustimmen.',
      expected: ['consent-gated google-maps sentence'],
    },
    {
      name: 'an unconditional description of the connection is a disclosure of both unconditional kinds',
      text: 'Dazu muss Ihr Browser eine Verbindung zu den Servern von Google aufbauen.',
      expected: ['disclosure self-hosted google-fonts', 'disclosure no-connection google-fonts'],
    },
    {
      name: 'a conditional description of the connection is no disclosure',
      text: 'Wenn Sie zustimmen, baut Ihr Browser eine Verbindung zu den Servern von Google auf.',
      expected: [],
    },
    {
      name: 'a description of the connection that starts with an action of the visitor is no disclosure',
      text: 'Sobald Sie ein Video starten, wird eine Verbindung zu den Servern von YouTube hergestellt.',
      section: 'Datenschutzerklärung > YouTube',
      expected: [],
    },
    {
      name: 'a contrast in the sentence keeps the statement as ambiguous',
      text: 'Das Skript wird lokal eingebunden, die Kartendaten werden jedoch von Google geladen.',
      section: 'Datenschutzerklärung > Google Maps',
      expected: ['self-hosted google-maps heading [hedge]'],
    },
    {
      name: 'a statement sentence is no disclosure: it describes its own way of loading',
      text: 'Ihr Browser lädt die Schriftarten von unserem eigenen Server.',
      expected: ['self-hosted google-fonts heading'],
    },
    {
      name: 'loading from "our server" is a local statement',
      text: 'Die Schriften werden von unserem Server geladen.',
      expected: ['self-hosted google-fonts heading'],
    },
    {
      name: 'a negation before the words of a statement turns it around (en)',
      text: 'Google Fonts are not installed locally.',
      section: 'Privacy Policy > Google Fonts',
      expected: [],
    },
    {
      name: 'a negation before the words of a statement turns it around (de)',
      text: 'Google Maps wird nicht erst nach Ihrer Einwilligung geladen.',
      section: 'Datenschutzerklärung > Google Maps',
      expected: [],
    },
    {
      name: 'a statement that holds a negation itself stays a statement',
      text: 'Zu Servern von Google wird keine Verbindung aufgebaut.',
      expected: ['no-connection google-fonts heading'],
    },
    {
      name: 'a sentence naming two services keeps the statement as ambiguous',
      text: 'Die Google Fonts sind bei uns lokal installiert und Google Maps nutzt externe Server.',
      expected: ['self-hosted google-fonts,google-maps sentence [several-services]'],
    },
    {
      name: 'services that share a name ("YouTube") are one mention, not several',
      text: 'YouTube wird erst geladen, wenn Sie zustimmen.',
      section: 'Datenschutzerklärung > Videos',
      expected: ['consent-gated youtube,youtube-nocookie sentence'],
    },
    {
      name: 'a negation further away from the description of the connection does not undo it',
      text: 'Ihr Browser lädt die Schriftarten von Google, dabei werden keine Cookies gespeichert.',
      expected: ['disclosure self-hosted google-fonts', 'disclosure no-connection google-fonts'],
    },
    {
      name: 'consent-gated with "sobald"',
      text: 'Die Karte wird erst geladen, sobald Sie zustimmen.',
      section: 'Datenschutzerklärung > Google Maps',
      expected: ['consent-gated google-maps heading'],
    },
    {
      name: 'a statement and the outside source in one sentence hold both variants: ambiguous, and a disclosure',
      text: 'Google Fonts sind bei uns lokal installiert oder Ihr Browser lädt die Schriftarten von Google.',
      expected: [
        'self-hosted google-fonts sentence [both-variants]',
        'disclosure self-hosted google-fonts',
        'disclosure no-connection google-fonts',
      ],
    },
    {
      name: 'the company inside the product name is no outside source',
      text: 'Ihr Browser lädt Google Fonts von unserem eigenen Server.',
      expected: ['self-hosted google-fonts sentence'],
    },
    {
      name: 'loading from the own web server is no disclosure',
      text: 'Ihr Browser lädt die Schriftarten von unserem Webserver.',
      expected: [],
    },
    {
      name: '"nicht nur … sondern auch" confirms the connection',
      text: 'Ihr Browser lädt nicht nur die Schriftarten von Google, sondern auch weitere Inhalte.',
      expected: ['disclosure self-hosted google-fonts', 'disclosure no-connection google-fonts'],
    },
    {
      name: '"nicht extern, sondern lokal" states the local variant',
      text: 'Google Fonts werden nicht extern, sondern lokal installiert.',
      expected: ['self-hosted google-fonts sentence'],
    },
    {
      name: '"nicht von unserem Server, sondern von Google" describes the outside source',
      text: 'Ihr Browser lädt die Schriftarten nicht von unserem Server, sondern von Google.',
      expected: ['disclosure self-hosted google-fonts', 'disclosure no-connection google-fonts'],
    },
    {
      name: 'a disclosure naming several services counts for each',
      text: 'Ihr Browser lädt Google Fonts und Google Maps von den Servern von Google.',
      expected: [
        'disclosure self-hosted google-fonts,google-maps',
        'disclosure no-connection google-fonts,google-maps',
      ],
    },
    {
      name: 'a reservation of the whole sentence keeps even a denying statement ambiguous',
      text: 'Wir garantieren nicht, dass Google Fonts keine Verbindung zu Google aufbauen.',
      expected: ['no-connection google-fonts sentence [hedge]'],
    },
    {
      name: 'a negated description of the connection is no disclosure',
      text: 'Ihr Browser lädt die Schriften nicht von Servern von Google.',
      expected: [],
    },
  ])('$name', ({ text, section, origin, observed, expected }) => {
    expect(read(text, section, { origin, observed })).toEqual(expected);
  });

  it('a statement is quoted verbatim from the part as a whole sentence of at most 200 characters', () => {
    const text = `Einleitung. ${LOCAL_CLAIM} Copyright © Beispiel GmbH.`;
    const r = readPolicyClaims([part(text, FONTS_SECTION)], claims, vocab, new Map());
    for (const c of r.claims) {
      expect(text).toContain(c.sentence);
      expect(c.sentence.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS);
      expect(c.sentence).toMatch(/^[A-ZÄÖÜ].*\.$/);
    }
    expect(r.claims.map((c) => c.sentence)).toEqual([
      'Die Google Fonts sind auf dieser Website lokal installiert.',
      'Eine Verbindung zu Servern von Google findet beim Seitenaufruf nicht statt.',
    ]);
  });
});

describe('PRIV-02 levels', () => {
  it('replicated: one finding with a quote per statement, a request per context and the confirmed reject', () => {
    const r = runCheck(priv02, scenario('violation-local-fonts-claim-replicated.json'));
    const [o, ...rest] = observationsOf(r);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({
      variant: 'contradiction-replicated',
      confidence: 'high',
      subject: 'google-fonts',
      serviceId: 'google-fonts',
      category: 'fonts',
      params: {
        service: 'Google Fonts',
        company: 'Google',
        claim: 'self-hosted+no-connection',
        policyUrl: PRIVACY,
        contextCount: 3,
        pageCount: 2,
        requestCount: 3,
        hosts: 'fonts.googleapis.com',
        afterReject: true,
        basis: 'request',
      },
    });
    const quotes = o!.evidence.filter((e) => e.type === 'text-match');
    expect(quotes.map((q) => [q.claim, q.quote, q.matchLevel, q.negation])).toEqual([
      ['self-hosted', 'Die Google Fonts sind auf dieser Website lokal installiert.', 'named', 'none'],
      [
        'no-connection',
        'Eine Verbindung zu Servern von Google findet beim Seitenaufruf nicht statt.',
        'named',
        'none',
      ],
    ]);
    const requests = o!.evidence.filter((e) => e.type === 'request');
    expect(new Set(requests.map((e) => `${e.phase} ${e.page}`)).size).toBeGreaterThanOrEqual(2);
    expect(requests.map((e) => `${e.phase} ${e.page}`)).toContain(`B ${START}`);
    expect(o!.evidence.filter((e) => e.type === 'consent-state').map((e) => e.origin)).toEqual([
      'action',
      'stored',
    ]);
    expect(o!.evidence[0]).toMatchObject({ type: 'document', kind: 'privacy', url: PRIVACY });
    for (const ev of o!.evidence) expect(EvidenceSchema.safeParse({ ...ev, id: 'ev-1' }).success).toBe(true);
  });

  it('replicated needs as many contexts as the setting says', () => {
    const snap = scenario('violation-local-fonts-claim-replicated.json');
    const strict = checkContext({ dataDirs: ['legal'] });
    const ctx = {
      ...strict,
      thresholds: { ...strict.thresholds, legal: { ...strict.thresholds.legal, policyClaimMinContexts: 4 } },
    };
    expect(variantsOf(runCheck(priv02, snap, ctx))).toEqual(['contradiction-single']);
  });

  it.each<[string, string[]]>([
    ['violation-local-fonts-claim-single.json', ['contradiction-single']],
    ['violation-maps-consent-gated.json', ['contradiction-single']],
    ['violation-english-claim.json', ['contradiction-replicated']],
    ['violation-claim-and-disclosure.json', ['wording-to-review']],
    ['violation-claim-attempt-only.json', ['wording-to-review']],
    ['violation-claim-and-conditional-disclosure.json', ['contradiction-replicated']],
  ])('%s → %s', (file, variants) => {
    expect(variantsOf(runCheck(priv02, scenario(file)))).toEqual(variants);
  });

  it('wording-to-review names its basis: the disclosure is quoted next to the statements', () => {
    const [o] = observationsOf(runCheck(priv02, scenario('violation-claim-and-disclosure.json')));
    expect(o?.params).toMatchObject({ basis: 'disclosure', claim: 'self-hosted+no-connection' });
    const quotes = o!.evidence.filter((e) => e.type === 'text-match');
    expect(quotes.map((q) => q.claim ?? 'disclosure')).toEqual([
      'self-hosted',
      'no-connection',
      'disclosure',
    ]);
    expect(quotes.at(-1)?.quote).toBe(
      'Dazu muss Ihr Browser eine Verbindung zu den Servern von Google aufbauen.',
    );
  });

  it('a disclosure in another document of the site leaves the statement of the policy contradicted', () => {
    const main = privacyDoc([fontsPart(LOCAL_CLAIM)]);
    const other = privacyDoc([fontsPart('Ihr Browser lädt die Schriftarten von Google.')], {
      id: 'doc-privacy-courses',
      url: `${PRIVACY}-kurse`,
    });
    const r = runCheck(
      priv02,
      site({
        phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] })],
        documents: { documents: [policyWith().documents[0]!, main, other], attempts: [] },
      }),
    );
    expect(variantsOf(r)).toEqual(['contradiction-replicated']);
  });

  it('a disclosure too long to quote still makes it wording-to-review, and every quote stays within the limit', () => {
    const long = `Dazu muss Ihr Browser eine Verbindung zu den Servern von Google aufbauen, ${'um die Schriftarten der Website zu laden '.repeat(4)}.`;
    const [o] = observationsOf(
      runCheck(
        priv02,
        site({
          phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] })],
          documents: policyWith(fontsPart(`${LOCAL_CLAIM} ${long}`)),
        }),
      ),
    );
    expect(o?.params).toMatchObject({ basis: 'disclosure' });
    for (const ev of o!.evidence) {
      expect(EvidenceSchema.safeParse({ ...ev, id: 'ev-1' }).success, JSON.stringify(ev)).toBe(true);
    }
    expect(o!.evidence.filter((e) => e.type === 'text-match').map((e) => e.claim)).toEqual([
      'self-hosted',
      'no-connection',
    ]);
  });

  it('wording-to-review on failed requests and a connection hint only', () => {
    const [o] = observationsOf(runCheck(priv02, scenario('violation-claim-attempt-only.json')));
    expect(o?.params).toMatchObject({ basis: 'attempt-and-hint', requestCount: 2, contextCount: 2 });
    expect(o?.evidence.some((e) => e.type === 'link' && e.href === 'https://fonts.gstatic.com/')).toBe(true);
  });

  it('the subject from a previous sentence or a category is medium confidence (at most warning)', () => {
    const run = (text: string, section: string) =>
      observationsOf(
        runCheck(
          priv02,
          site({
            phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] })],
            documents: policyWith(fontsPart(text, { section })),
          }),
        ),
      );
    expect(run('Wir verwenden Google Fonts. Diese sind lokal eingebunden.', 'Schriftarten')).toMatchObject([
      { variant: 'contradiction-replicated', confidence: 'medium' },
    ]);
    const [category] = run('Alle Schriftarten werden lokal eingebunden.', 'Schriftarten');
    expect(category).toMatchObject({ variant: 'contradiction-replicated', confidence: 'medium' });
    expect(category?.evidence.find((e) => e.type === 'text-match')).toMatchObject({ matchLevel: 'category' });
  });

  it('a policy whose expandable parts were not opened gives medium confidence and partial with banner-open', () => {
    const snap = site({
      phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: CONTACT })] })],
      documents: {
        documents: [
          policyWith().documents[0]!,
          {
            ...policyWith(fontsPart(LOCAL_CLAIM)).documents[1]!,
            complete: false,
            errors: ['expand-failed'],
            manifest: {
              expandablesFound: 1,
              expandablesOpened: 0,
              framesIncluded: 0,
              linkedPages: 0,
              textLength: 200,
            },
          },
        ],
        attempts: [],
      },
    });
    const r = runCheck(priv02, snap);
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['banner-open'] } });
    expect(observationsOf(r)).toMatchObject([{ variant: 'contradiction-replicated', confidence: 'medium' }]);
  });
});

describe('PRIV-02 moments that contradict a statement', () => {
  const policy = policyWith(fontsPart(LOCAL_CLAIM));
  const maps = (text: string) =>
    policyWith(fontsPart(text, { section: 'Datenschutzerklärung > 5. Plugins und Tools > Google Maps' }));
  const MAPS_JS = 'https://maps.googleapis.com/maps/api/js?key=[redacted]';
  const acceptOn = (...requests: ReturnType<typeof req>[]) =>
    phase('C', { click: click('accept'), requests });

  it('fonts after the accept outside a map or video navigation contradict the local statement', () => {
    const one = runCheck(
      priv02,
      site({ phases: [phase('A'), acceptOn(cAfterClick('C-1', FONTS_CSS))], documents: policy }),
    );
    expect(variantsOf(one)).toEqual(['contradiction-single']);
    const two = runCheck(
      priv02,
      site({
        phases: [
          phase('A'),
          acceptOn(cAfterClick('C-1', FONTS_CSS), cAfterClick('C-2', FONTS_CSS, { pageUrl: CONTACT })),
        ],
        documents: policy,
      }),
    );
    expect(variantsOf(two)).toEqual(['contradiction-replicated']);
  });

  it('fonts after the accept in a navigation with the Maps JavaScript API are left out and named as a limitation', () => {
    const r = runCheck(priv02, scenario('clean-maps-js-fonts-after-accept.json'));
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['embed-navigation-excluded'] } });
    // The same page in phase A, before any interaction, still counts.
    const before = runCheck(
      priv02,
      site({
        phases: [
          phase('A', {
            requests: [req('A-1', MAPS_JS, { pageUrl: CONTACT }), fontsCss('A-2', { pageUrl: CONTACT })],
          }),
        ],
        documents: policy,
      }),
    );
    expect(variantsOf(before)).toEqual(['contradiction-single']);
  });

  it('after an unconfirmed reject an unconditional statement is contradicted, afterReject stays false', () => {
    const r = runCheck(
      priv02,
      site({ phases: [phase('A'), afterReject([bAfterClick('B-1')])], documents: policy }),
    );
    expect(observationsOf(r)).toMatchObject([
      { variant: 'contradiction-single', params: { afterReject: false } },
    ]);
    expect(observationsOf(r)[0]?.evidence.some((e) => e.type === 'consent-state')).toBe(false);
  });

  it('a consent statement is contradicted after a reject only when the reject is confirmed', () => {
    const map = (id: string) =>
      bAfterClick(id, 'https://www.google.com/maps/embed?pb=[redacted]', {
        pageUrl: START,
        resourceType: 'document',
      });
    const text = 'Google Maps wird erst geladen, wenn Sie zustimmen.';
    const unconfirmed = runCheck(
      priv02,
      site({ phases: [phase('A'), afterReject([map('B-1')])], documents: maps(text) }),
    );
    expect(variantsOf(unconfirmed)).toEqual([]);
    const confirmed = runCheck(
      priv02,
      site({
        phases: [phase('A'), afterReject([map('B-1')])],
        cmp: confirmedReject(),
        documents: maps(text),
      }),
    );
    expect(observationsOf(confirmed)).toMatchObject([
      { variant: 'contradiction-single', params: { afterReject: true } },
    ]);
  });

  it('a request of another service inside an embed frame does not count, the frame of the service itself does', () => {
    const youtube = 'https://www.youtube-nocookie.com/embed/abc';
    const inFrame = (id: string, url: string, resourceType: string) =>
      req(id, url, {
        pageUrl: CONTACT,
        isMainFrame: false,
        frameId: 'frame-video',
        frameUrl: youtube,
        resourceType,
      });
    const requests = [
      inFrame('A-1', youtube, 'document'),
      inFrame('A-2', 'https://www.google.com/recaptcha/api.js', 'script'),
    ];
    const gated = (service: string) =>
      policyWith(
        fontsPart(`${service} wird erst geladen, wenn Sie zustimmen.`, {
          section: `Datenschutzerklärung > 5. Plugins und Tools > ${service}`,
        }),
      );
    const recaptcha = runCheck(
      priv02,
      site({ phases: [phase('A', { requests })], documents: gated('Google reCAPTCHA') }),
    );
    expect(variantsOf(recaptcha)).toEqual([]);
    const video = runCheck(priv02, site({ phases: [phase('A', { requests })], documents: gated('YouTube') }));
    expect(observationsOf(video).map((o) => [o.subject, o.variant])).toEqual([
      ['youtube-nocookie', 'contradiction-single'],
    ]);
  });

  it('bot and geo signals of phase A or B make the check inconclusive', () => {
    const geo = cmpWith({
      phase: 'B',
      facts: [cmpFacts({ geoSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:outside-eu' }] })],
    });
    const r = runCheck(
      priv02,
      site({ phases: [phase('A', { requests: [fontsCss('A-1')] })], cmp: geo, documents: policy }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'geo' });
  });

  it('no phase A: no-network-observation; no policy: privacy-policy-not-found', () => {
    expect(
      runCheck(priv02, site({ phases: [phase('A', { status: 'skipped', pages: [] })], documents: policy })),
    ).toMatchObject({
      status: 'inconclusive',
      reason: 'no-network-observation',
    });
    expect(
      runCheck(
        priv02,
        site({
          phases: [phase('A', { requests: [fontsCss('A-1')] })],
          documents: { documents: [], attempts: [] },
        }),
      ),
    ).toMatchObject({ status: 'inconclusive', reason: 'privacy-policy-not-found' });
  });
});

describe('PRIV-02 next to the other checks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'priv02-'));

  it('PRIV-01 stays silent for the named service and EMBED-01 keeps the load; assess links them by service', async () => {
    const snap = scenario('violation-local-fonts-claim-replicated.json');
    expect(variantsOf(runCheck(priv01, snap))).toEqual([]);

    const file = path.join(dir, 'fonts.json');
    writeFileSync(file, JSON.stringify(toSavedSnapshot(snap)));
    const { report } = await scan({
      fromSnapshot: file,
      registry: new CheckRegistry(browserChecks),
      now: () => FIXED_NOW,
      log: silentLogger,
    });
    const findings = report.findings ?? [];
    const priv = findings.find((f) => f.checkId === 'PRIV-02');
    const embed = findings.find((f) => f.checkId === 'EMBED-01');
    expect(priv).toMatchObject({
      variant: 'contradiction-replicated',
      severity: 'critical',
      crmCode: 'T1_MISLEADING_CLAIM',
    });
    expect(embed).toMatchObject({ variant: 'fonts-loaded' });
    expect(priv?.related).toContainEqual({
      checkId: 'EMBED-01',
      fingerprint: embed?.fingerprint,
      relation: 'same-service',
    });
  });

  it('a policy without statements: completed without findings', () => {
    const r = runCheck(
      priv02,
      site({
        phases: [phase('A', { requests: [fontsCss('A-1'), fontsCss('A-2', { pageUrl: IMPRESSUM })] })],
      }),
    );
    expect(r).toMatchObject({ status: 'completed', outcome: { coverage: { evaluated: 0 } } });
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('PRIV-02 words in the report', () => {
  it.each(['de', 'en'] as const)(
    '%s: the reason, the limitation and the statement codes have words',
    (lang) => {
      const ui = loadTexts(lang).ui;
      const reason = formatMessage(ui['report.reason']!.text, { code: 'claim-ambiguous' }, lang);
      const limitation = formatMessage(
        ui['report.checkLimitation']!.text,
        { code: 'embed-navigation-excluded' },
        lang,
      );
      expect(reason).not.toBe('');
      expect(limitation).not.toBe('');
      for (const value of ['self-hosted', 'no-connection', 'consent-gated']) {
        expect(
          formatMessage(ui['report.evidence.value']!.text, { field: 'claim', value }, lang),
          value,
        ).not.toBe('');
      }
    },
  );

  it('every statement kind of the dictionary has words of its own in the finding texts and the evidence', () => {
    const [o] = observationsOf(runCheck(priv02, scenario('violation-local-fonts-claim-replicated.json')));
    for (const lang of ['de', 'en'] as const) {
      const t = loadTexts(lang);
      for (const variant of ['contradiction-replicated', 'contradiction-single', 'wording-to-review']) {
        const body = (claim: string) =>
          formatMessage(t.messages[`PRIV-02.${variant}`]!.body, { ...o!.params, claim }, lang);
        for (const kind of claims.kinds) {
          expect(body(kind.id), `${lang} ${variant} ${kind.id}`).not.toBe(body('unknown-kind'));
          expect(body(kind.id)).not.toMatch(/\{[A-Za-z]\w*\}/);
        }
      }
      for (const kind of claims.kinds) {
        expect(
          formatMessage(t.ui['report.evidence.value']!.text, { field: 'claim', value: kind.id }, lang),
        ).not.toBe('');
      }
    }
  });
});
