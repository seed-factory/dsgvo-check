/**
 * Legal documents as the collector extracts them and as LEGAL-01 / LEGAL-02 / PRIV-01 read them: fallback redirects to
 * the home page, policies in another language, headings of navigation or footer, empty panels, masked e-mail
 * addresses, Impressum details on the contact and start pages, and a designation of a former legal situation.
 */
import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { legal02 } from '../../../../src/checks/browser/legal-02.ts';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import { useFixtureServer } from '../../../fixture-server/use-fixture-server.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { type CollectRun, collect, snapshotOf } from '../helpers.ts';
import { FOOTER, html, LOREM, redirect, send, site } from '../site-dir.ts';

const LOREM_PT =
  'Tratamos os dados pessoais apenas no âmbito das disposições legais. Esta declaração descreve que dados são recolhidos durante a visita a este sítio e durante quanto tempo são conservados. ';

const IMPRESSUM = html(
  'Impressum',
  `<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung. Kontakt: max.mustermann@example.test, <a href="mailto:privat.person@example.test">E-Mail</a>.</p></main>`,
);
const POLICY = (extra = '') =>
  html(
    'Datenschutzerklärung',
    `<header><nav>${extra}</nav></header><main><h1>Datenschutzerklärung</h1><h2>Verantwortlicher</h2><p>${LOREM.repeat(60)}</p></main>`,
  );
const FOOTER_PT =
  '<footer><a href="/aviso-legal/">Aviso legal</a> <a href="/privacidade/">Aviso de Privacidade</a></footer>';
const START = (title = 'Start') =>
  html(title, `<main><h1>Start</h1><p>${LOREM.repeat(3)}</p></main>${FOOTER}`);

/** Generic provider details of three kinds (register entry, management, VAT ID) and an address to be masked. */
const DETAILS =
  'Beispiel GmbH, Musterstraße 1, 10115 Berlin. Geschäftsführung: Erika Mustermann. Registergericht: Amtsgericht Musterstadt, HRB 12345. USt-IdNr.: DE123456789. E-Mail: info.person@example.test';
/** A theme header whose contact link is labelled "E-mail" and leads to /kontakt/. */
const WIDGET_NAV =
  '<header class="site-header"><nav><a href="/">Startseite</a> <a href="/kontakt/">E-mail</a> <a href="/datenschutz/">Datenschutz</a></nav></header>';
/** A theme footer with widget columns in an aside: "Anfahrt" and "Impressum" with the details. */
const WIDGET_FOOTER =
  '<footer class="site-footer"><aside class="widget-area" role="complementary">' +
  '<section class="widget"><h2 class="widget-title">Anfahrt</h2><p>Musterstraße 1, 10115 Berlin</p></section>' +
  `<section class="widget"><h2 class="widget-title">Impressum</h2><p>${DETAILS}</p></section>` +
  '</aside><div class="site-info"><a href="/datenschutz/">Datenschutz</a></div></footer>';
const widgetPage = (title: string, main: string, footer = WIDGET_FOOTER) =>
  html(title, `${WIDGET_NAV}<main><h1>${title}</h1>${main}</main>${footer}`);
const BROKEN_FOOTER = '<footer><a href="/impressum/">Impressum</a></footer>';
/** The participant list of the former framework, linked with an id in the query as policies did. */
const SHIELD_LIST = 'https://www.privacyshield.gov/participant?id=a2zt0000000TESTAAI';
const SHIELD_POLICY = html(
  'Datenschutzerklärung',
  `<main><h1>Datenschutzerklärung</h1><h2>Verantwortlicher</h2><p>${LOREM.repeat(60)}</p><h2>Analyse</h2><p>Durch die Zertifizierung nach dem <strong>EU-US Privacy</strong> Shield garantiert der Anbieter ein angemessenes Datenschutzniveau: <a href="${SHIELD_LIST}">${SHIELD_LIST}</a></p></main>${FOOTER}`,
);
const CONTACT_FORM =
  '<p>Musterstraße 1, 10115 Berlin, Telefon 030 123456.</p><form><label>Nachricht <textarea name="m"></textarea></label></form>';

const server = useFixtureServer(() => {
  return {
    handlers: [
      // (a) an empty navigation panel (collapsed, no content) outside the text of the policy
      site('navpanel.example.test', {
        '/': send(START()),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(
          POLICY(
            '<button aria-expanded="false" aria-controls="menu">Menü</button><div id="menu" hidden></div>',
          ),
        ),
      }),

      // (b) a section of the policy itself whose content is not in the DOM until it is opened
      site('accordion.example.test', {
        '/': send(START()),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(
          html(
            'Datenschutzerklärung',
            `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(60)}</p><h2>Cookies</h2><button aria-expanded="false" aria-controls="sec-cookies">Cookies anzeigen</button><div id="sec-cookies" hidden></div></main>`,
          ),
        ),
      }),

      // /impressum redirects to the home page; the footer link to the Impressum leads to another site
      site('homeredirect.example.test', {
        '/': send(
          html(
            'Muster GmbH',
            `<main><h1>Willkommen</h1><h2>Leistungen</h2><p>${LOREM.repeat(40)}</p></main><footer><a href="https://konzern.example/impressum">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`,
          ),
        ),
        '/impressum': redirect('/'),
        '/impressum/': redirect('/'),
        '/datenschutz/': send(POLICY()),
      }),

      // /impressum redirects to the home page whose footer has a column titled "Impressum"
      site('footerheading.example.test', {
        '/': send(
          html(
            'Muster GmbH',
            `<main><h1>Willkommen</h1><h2>Leistungen</h2><p>${LOREM.repeat(40)}</p></main><footer><div><h3>Impressum</h3><a href="https://konzern.example/impressum">Impressum</a></div><div><h3>Service</h3><a href="/datenschutz/">Datenschutzerklärung</a></div></footer>`,
          ),
        ),
        '/impressum': redirect('/'),
        '/impressum/': redirect('/'),
        '/datenschutz/': send(POLICY()),
      }),

      // the policy link redirects to the home page whose language switcher is a navigation heading in French and
      // whose footer (a div named like a footer) has a column "Datenschutz & Sicherheit"
      site('navheading.example.test', {
        '/': send(
          html(
            'Muster GmbH',
            `<header><nav><h2>Politique de confidentialité</h2><a href="/fr/">Français</a></nav></header><main><h1>Willkommen</h1><p>${LOREM.repeat(40)}</p></main><div class="site-footer"><h3>Datenschutz &amp; Sicherheit</h3></div>${FOOTER}`,
          ),
        ),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz': redirect('/'),
        '/datenschutz/': redirect('/'),
      }),

      // /impressum (fallback) is an ordinary page whose only "Impressum" is the h1 of the navigation
      site('navh1.example.test', {
        '/': send(
          html(
            'Muster GmbH',
            `<main><h1>Willkommen</h1><p>${LOREM.repeat(3)}</p></main><footer><a href="/datenschutz/">Datenschutzerklärung</a></footer>`,
          ),
        ),
        '/impressum': send(
          html(
            'Muster GmbH',
            `<nav><h1>Impressum</h1><a href="/">Start</a></nav><main><h2>Leistungen</h2><p>${LOREM.repeat(40)}</p></main>`,
          ),
        ),
        '/datenschutz/': send(POLICY()),
      }),

      // counterexample: the type is confirmed by headings inside the content, also next to a footer heading of
      // the same text; the page title and the h1 say only "Rechtliches"
      site('contentheading.example.test', {
        '/': send(START()),
        '/impressum/': send(
          html(
            'Rechtliches',
            `<header><nav><a href="/">Start</a></nav></header><main><h1>Rechtliches</h1><h2>Impressum</h2><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung. ${LOREM}</p></main><footer><h3>Impressum</h3><a href="/impressum/">Impressum</a></footer>`,
          ),
        ),
        '/datenschutz/': send(
          html(
            'Rechtliches',
            `<header><nav><a href="/">Start</a></nav></header><main><h1>Rechtliches</h1><h2>Datenschutzerklärung</h2><p>${LOREM.repeat(60)}</p></main><footer><h3>Service</h3></footer>`,
          ),
        ),
      }),

      // the Impressum details sit only in a footer widget on every page; no Impressum link, /impressum answers 404
      site('footerwidget.example.test', {
        '/': send(widgetPage('Willkommen', `<p>${LOREM.repeat(3)}</p>`)),
        '/kontakt/': send(widgetPage('E-Mail', CONTACT_FORM)),
        '/datenschutz/': send(widgetPage('Datenschutzerklärung', `<p>${LOREM.repeat(60)}</p>`)),
      }),

      // the Kontakt page holds the Impressum in its content, under a heading of its own
      site('contactimpressum.example.test', {
        '/': send(widgetPage('Willkommen', `<p>${LOREM.repeat(3)}</p>`, '')),
        '/kontakt/': send(widgetPage('Kontakt', `${CONTACT_FORM}<h2>Impressum</h2><p>${DETAILS}</p>`, '')),
        '/datenschutz/': send(widgetPage('Datenschutzerklärung', `<p>${LOREM.repeat(60)}</p>`, '')),
      }),

      // the footer link "Impressum" answers 404; the Kontakt page, without that link, holds an Impressum under a
      // heading of its own
      site('brokenlink.example.test', {
        '/': send(widgetPage('Willkommen', `<p>${LOREM.repeat(3)}</p>`, BROKEN_FOOTER)),
        '/kontakt/': send(widgetPage('Kontakt', `${CONTACT_FORM}<h2>Impressum</h2><p>${DETAILS}</p>`, '')),
        '/datenschutz/': send(
          widgetPage('Datenschutzerklärung', `<p>${LOREM.repeat(60)}</p>`, BROKEN_FOOTER),
        ),
      }),

      // counterexample: the Kontakt page holds an address, a phone number and a form only
      site('contactonly.example.test', {
        '/': send(widgetPage('Willkommen', `<p>${LOREM.repeat(3)}</p>`, '')),
        '/kontakt/': send(widgetPage('Kontakt', CONTACT_FORM, '')),
        '/datenschutz/': send(widgetPage('Datenschutzerklärung', `<p>${LOREM.repeat(60)}</p>`, '')),
      }),

      // the policy names the former EU-US framework in a sentence split by inline markup, with a link to its list
      site('shield.example.test', {
        '/': send(START()),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(SHIELD_POLICY),
      }),

      // Portuguese policy and legal notice; the lang attribute is wrong ("en") on purpose
      site('pt.example.test', {
        '/': send(
          html('Empresa Exemplo', `<main><h1>Início</h1><p>${LOREM_PT.repeat(3)}</p></main>${FOOTER_PT}`, {
            lang: 'pt',
          }),
        ),
        '/aviso-legal/': send(
          html(
            'Empresa Exemplo',
            `<main><h1>Aviso legal</h1><p>${LOREM_PT.repeat(2)}</p></main>${FOOTER_PT}`,
            {
              lang: 'pt',
            },
          ),
        ),
        '/privacidade/': send(
          html(
            'Empresa Exemplo',
            `<main><h1>Aviso de Privacidade</h1><p>${LOREM_PT.repeat(40)}</p></main>${FOOTER_PT}`,
            { lang: 'en' },
          ),
        ),
      }),
    ],
  };
});

const privacyDoc = (run: CollectRun) =>
  run.result.sections.documents?.documents.find((d) => d.kind === 'privacy');

const documentsOf = (run: CollectRun) => run.result.sections.documents?.documents ?? [];

/** Documents of `kind` that were taken as plain documents, without an error tag such as `unconfirmed`. */
const plainDocuments = (run: CollectRun, kind: 'impressum' | 'privacy') =>
  documentsOf(run).filter((d) => d.kind === kind && d.errors.length === 0);

/** How the fallback probe of the Impressum ended. */
const impressumFallbackOutcome = (run: CollectRun) =>
  (run.result.sections.documents?.attempts ?? []).find((a) => a.kind === 'impressum' && a.via === 'fallback')
    ?.outcome;

/** What LEGAL-01 observed about the Impressum. */
const impressumObservations = (run: CollectRun) =>
  observationsOf(runCheck(legal01, snapshotOf(run))).filter((o) => o.subject === 'impressum');

describe('expandable elements outside and inside the text of the policy', () => {
  it('(a) an empty navigation panel: the policy is complete and PRIV-01 is not inconclusive', async () => {
    const run = await collect(server(), { url: 'https://navpanel.example.test/' });

    const r = runCheck(priv01, snapshotOf(run));

    expect(['completed', 'partial']).toContain(r.status);
    expect(r.reason).toBeNull();
  });

  it('(a) the navigation panel is not counted as a part of the policy (manifest, no expand-failed)', async () => {
    const run = await collect(server(), { url: 'https://navpanel.example.test/' });

    const doc = privacyDoc(run);

    expect(doc?.manifest.expandablesFound).toBe(0);
    expect(doc?.errors).not.toContain('expand-failed');
    expect(doc?.complete).toBe(true);
  });

  it('(b) an unopened section of the policy stays in the manifest; PRIV-01 is partial with banner-open', async () => {
    const run = await collect(server(), { url: 'https://accordion.example.test/' });

    const doc = privacyDoc(run);
    expect(doc?.manifest).toMatchObject({ expandablesFound: 1, expandablesOpened: 0 });
    expect(doc?.errors).toContain('expand-failed');
    const r = runCheck(priv01, snapshotOf(run));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['banner-open']);
  });
});

describe('the type of a fetched page is confirmed by its headings', () => {
  it('impressum redirecting to the home page is no Impressum: no reachable-via-intermediate', async () => {
    const run = await collect(server(), { url: 'https://homeredirect.example.test/' });

    // The home page may be kept as a tagged candidate, never as a plain document.
    expect(plainDocuments(run, 'impressum')).toEqual([]);
    const variants = impressumObservations(run).map((o) => o.variant);
    expect(variants).not.toContain('reachable-via-intermediate');
    expect(variants).toEqual(['unresolved']);
  });

  it('a footer column titled "Impressum" does not make the home page an Impressum (fallback → home page)', async () => {
    const run = await collect(server(), { url: 'https://footerheading.example.test/' });

    expect(plainDocuments(run, 'impressum')).toEqual([]);
    expect(impressumFallbackOutcome(run)).not.toBe('found');
    expect(impressumObservations(run).map((o) => o.variant)).toEqual(['unresolved']);
  });

  it('a navigation heading in another language does not set the language of the home page as a policy', async () => {
    const run = await collect(server(), { url: 'https://navheading.example.test/' });

    expect(plainDocuments(run, 'privacy')).toEqual([]);
    expect(runCheck(priv01, snapshotOf(run)).reason).not.toBe('language-unsupported');
  });

  it('the h1 of the navigation does not make an ordinary page the Impressum (fallback)', async () => {
    const run = await collect(server(), { url: 'https://navh1.example.test/' });

    expect(plainDocuments(run, 'impressum')).toEqual([]);
    expect(impressumFallbackOutcome(run)).not.toBe('found');
    // A navigation h1 cannot confirm a document when neither a start-page link nor the fallback supplies one.
    expect(impressumObservations(run).map((o) => o.variant)).toEqual(['document-not-found']);
  });

  it('counterexample: headings inside the content confirm the type, also next to a footer heading of the same text', async () => {
    const run = await collect(server(), { url: 'https://contentheading.example.test/' });

    const impressum = documentsOf(run).find((d) => d.kind === 'impressum');
    const privacy = documentsOf(run).find((d) => d.kind === 'privacy');
    expect(impressum?.errors).toEqual([]);
    expect(privacy?.errors).toEqual([]);
    expect(privacy?.lang).toBe('de');
  });

  it('a Portuguese policy behind the label "Aviso de Privacidade": a document, language pt, not an error', async () => {
    const run = await collect(server(), { url: 'https://pt.example.test/' });

    const doc = privacyDoc(run);
    expect(doc).toBeDefined();
    expect(doc?.errors).toEqual([]);
    expect(doc?.foundVia).toBe('link');
    // The markers decide; the lang attribute of the page says "en".
    expect(doc?.lang).toBe('pt');

    const snap = snapshotOf(run);
    const legal = runCheck(legal01, snap);
    expect(observationsOf(legal)).toEqual([]);
    expect(runCheck(priv01, snap)).toMatchObject({ status: 'inconclusive', reason: 'language-unsupported' });
  });

  it('the Portuguese footer is found by its labels ("Aviso legal", "Aviso de Privacidade")', async () => {
    const run = await collect(server(), { url: 'https://pt.example.test/' });

    const roles = run.result.sections.plan?.pages.map((p) => [p.role, p.source]);
    expect(roles).toEqual(
      expect.arrayContaining([
        ['impressum', 'link'],
        ['privacy', 'link'],
      ]),
    );
    expect(run.result.sections.documents?.documents.map((d) => d.kind).sort()).toEqual([
      'impressum',
      'privacy',
    ]);
  });
});

describe('Impressum details on pages that were open anyway', () => {
  const candidatesOf = (run: CollectRun) => run.result.sections.documents?.candidates ?? [];
  const visitedPaths = (run: CollectRun) =>
    (run.result.sections.browser?.phases ?? []).flatMap((p) => p.pages).map((p) => new URL(p.url).pathname);

  it('a footer widget "Impressum" without a link: the contact and start pages are kept as candidates with chrome parts', async () => {
    const run = await collect(server(), { url: 'https://footerwidget.example.test/' });

    expect(plainDocuments(run, 'impressum')).toEqual([]);
    const candidates = candidatesOf(run);
    expect(candidates.map((d) => new URL(d.url).pathname).sort()).toEqual(['/', '/kontakt/']);
    for (const d of candidates) {
      const widget = d.parts.find((p) => (p.section ?? '').endsWith('Impressum'));
      expect(widget?.place).toBe('chrome');
      expect(d.parts.some((p) => p.place === 'content')).toBe(true);
    }
    // The pages were read where they were open: each one was navigated to once, nothing more was requested.
    expect(visitedPaths(run).sort()).toEqual(['/', '/datenschutz/', '/impressum', '/kontakt/']);
    // Candidates are no documents and no attempts.
    expect(documentsOf(run).map((d) => d.kind)).toEqual(['privacy']);
    expect(run.result.sections.documents?.attempts.filter((a) => a.outcome === 'found')).toEqual([
      expect.objectContaining({ kind: 'privacy', via: 'link' }),
    ]);
  });

  it('a footer widget "Impressum" without a link: LEGAL-01 reports the details, not the missing document', async () => {
    const run = await collect(server(), { url: 'https://footerwidget.example.test/' });

    const [o] = impressumObservations(run);
    expect(o?.variant).toBe('provider-details-without-link');
    expect(o?.params).toMatchObject({
      detailsPlace: 'footer',
      hasHeading: true,
      detailsHeading: 'Impressum',
    });
    expect(o?.params.groupCount).toBeGreaterThanOrEqual(3);
  });

  it('the text of a candidate is masked like a document: no local part of an e-mail address', async () => {
    const run = await collect(server(), { url: 'https://footerwidget.example.test/' });

    const stored = JSON.stringify(run.result.sections.documents);
    expect(candidatesOf(run).length).toBeGreaterThan(0);
    expect(stored).not.toContain('info.person');
    expect(stored).toContain('[redacted]@example.test');
  });

  it('a Kontakt page with an Impressum under a heading of its content is the Impressum, found via that page', async () => {
    const run = await collect(server(), { url: 'https://contactimpressum.example.test/' });

    const impressum = documentsOf(run).find((d) => d.kind === 'impressum');
    expect(impressum).toMatchObject({ foundVia: 'hop', errors: [] });
    expect(new URL(impressum!.url).pathname).toBe('/kontakt/');
    expect(run.result.sections.documents?.attempts).toContainEqual(
      expect.objectContaining({ kind: 'impressum', via: 'hop', outcome: 'found' }),
    );
    // The start page was read as a candidate while no Impressum was known; once found, candidates are dropped.
    expect(candidatesOf(run)).toEqual([]);
    expect(impressumObservations(run).map((o) => o.variant)).toEqual(['reachable-via-intermediate']);
  });

  it('a broken Impressum link keeps links-broken: the Kontakt page with an Impressum stays a candidate', async () => {
    const run = await collect(server(), { url: 'https://brokenlink.example.test/' });

    expect(documentsOf(run).filter((d) => d.kind === 'impressum')).toEqual([]);
    expect(candidatesOf(run).map((d) => new URL(d.url).pathname)).toEqual(['/kontakt/']);
    expect(impressumObservations(run).map((o) => o.variant)).toEqual(['links-broken']);
  });

  it('counterexample: a Kontakt page with an address, a phone number and a form keeps document-not-found', async () => {
    const run = await collect(server(), { url: 'https://contactonly.example.test/' });

    expect(candidatesOf(run).map((d) => new URL(d.url).pathname)).toContain('/kontakt/');
    expect(impressumObservations(run).map((o) => o.variant)).toEqual(['document-not-found']);
  });
});

describe('free text of the documents is masked before it is stored', () => {
  it('no local part of an e-mail address in the stored documents; the domain stays', async () => {
    const run = await collect(server(), { url: 'https://navpanel.example.test/' });

    const stored = JSON.stringify(run.result.sections.documents);

    expect(stored).not.toContain('max.mustermann');
    expect(stored).not.toContain('privat.person');
    expect(stored).toContain('[redacted]@example.test');
  });
});

describe('a designation of a former legal situation in the policy (LEGAL-02)', () => {
  it('a sentence split by inline markup is stored whole, the query of its link redacted, and LEGAL-02 reports it', async () => {
    const run = await collect(server(), { url: 'https://shield.example.test/' });

    const part = privacyDoc(run)?.parts.find((p) => p.text.includes('Shield'));
    expect(part?.section).toBe('Datenschutzerklärung > Analyse');
    expect(part?.text).toContain('nach dem EU-US Privacy Shield garantiert der Anbieter');
    expect(part?.text).toContain('https://www.privacyshield.gov/participant?id=[redacted]');
    expect(JSON.stringify(run.result.sections.documents)).not.toContain('a2zt0000000TESTAAI');

    const os = observationsOf(runCheck(legal02, snapshotOf(run)));
    expect(os.map((o) => [o.subject, o.params.mentionCount, o.params.section])).toEqual([
      ['privacy:privacy-shield', 1, 'Datenschutzerklärung > Analyse'],
    ]);
    const quote = os[0]?.evidence.find((e) => e.type === 'text-match');
    expect(quote).toMatchObject({ matchLevel: 'term' });
    expect(JSON.stringify(quote)).not.toContain('a2zt0000000TESTAAI');
  });

  it('the link to the former participant list is text of the policy: no request goes there, no page is added', async () => {
    const run = await collect(server(), { url: 'https://shield.example.test/' });

    expect(run.requests.filter((r) => r.url.includes('privacyshield'))).toEqual([]);
    const hosts = (run.result.sections.browser?.phases ?? [])
      .flatMap((p) => p.pages)
      .map((p) => new URL(p.url).host);
    expect(new Set(hosts)).toEqual(new Set(['shield.example.test']));
  });
});
