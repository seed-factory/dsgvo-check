/**
 * L2: legal documents as the collector extracts them and as LEGAL-01 / PRIV-01 read them (canary-2 triage).
 * G20: a fallback path that redirects to the home page is no Impressum; a policy in another language is a document
 *      whose language comes from its headings (the lang attribute says "en"). G24: localised link labels.
 *      R03: a heading of the navigation or footer ("Impressum" as a column title) does not confirm the type.
 * G23: an empty navigation panel is no part of the policy; an unopened section of the policy is a limitation.
 * G01: e-mail addresses in a document are masked before the snapshot is written.
 * Synthetic hosts only (`*.example.test`), served by dynamic handlers of the fixture server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legal01 } from '../../../src/checks/browser/legal-01.ts';
import { priv01 } from '../../../src/checks/browser/priv-01.ts';
import type { Snapshot } from '../../../src/core/snapshot.ts';
import { type DynamicHandler, type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot, observationsOf, runCheck, withDerived } from '../../utils/snapshot-builder.ts';
import { type CollectRun, collect } from './helpers.ts';

type Res = Parameters<DynamicHandler['handle']>[1];

const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';
const LOREM_PT =
  'Tratamos os dados pessoais apenas no âmbito das disposições legais. Esta declaração descreve que dados são recolhidos durante a visita a este sítio e durante quanto tempo são conservados. ';

function html(title: string, body: string, lang = 'de'): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const send =
  (body: string, status = 200) =>
  (res: Res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
const redirect = (to: string) => (res: Res) => {
  res.writeHead(302, { location: to });
  res.end();
};

function site(host: string, routes: Record<string, (res: Res) => void>): DynamicHandler {
  return {
    host,
    path: /.*/,
    handle: (_req, res, ctx) => {
      const route = routes[ctx.url.pathname];
      if (route) return route(res);
      send(html('404', '<h1>Nicht gefunden</h1>'), 404)(res);
    },
  };
}

const FOOTER =
  '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>';
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

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
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
      // R03: /impressum redirects to the home page whose footer has a column titled "Impressum"
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
      // R03: the policy link redirects to the home page whose language switcher is a navigation heading in French and
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
      // S-legal-1: /impressum (fallback) is an ordinary page whose only "Impressum" is the h1 of the navigation
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
      // R03 counterexample: the type is confirmed by headings inside the content, also next to a footer heading of
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
      // Portuguese policy and legal notice; the lang attribute is wrong ("en") on purpose
      site('pt.example.test', {
        '/': send(
          html(
            'Empresa Exemplo',
            `<main><h1>Início</h1><p>${LOREM_PT.repeat(3)}</p></main>${FOOTER_PT}`,
            'pt',
          ),
        ),
        '/aviso-legal/': send(
          html(
            'Empresa Exemplo',
            `<main><h1>Aviso legal</h1><p>${LOREM_PT.repeat(2)}</p></main>${FOOTER_PT}`,
            'pt',
          ),
        ),
        '/privacidade/': send(
          html(
            'Empresa Exemplo',
            `<main><h1>Aviso de Privacidade</h1><p>${LOREM_PT.repeat(40)}</p></main>${FOOTER_PT}`,
            'en',
          ),
        ),
      }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

/** The collected sections as a snapshot with `derived`, to run the checks over a real collection. */
function snapshotOf(run: CollectRun): Snapshot {
  const s = run.result.sections;
  return withDerived(
    makeSnapshot({
      target: run.ctx.target,
      ...(s.browser ? { browser: s.browser } : {}),
      ...(s.documents ? { documents: s.documents } : {}),
      cmp: s.cmp ?? { phases: [] },
      plan: { browser: s.plan ?? null, probes: [] },
    }),
  );
}

const privacyDoc = (run: CollectRun) =>
  run.result.sections.documents?.documents.find((d) => d.kind === 'privacy');

describe('G23: expandable elements outside and inside the text of the policy', () => {
  it('(a) an empty navigation panel: the policy is complete and PRIV-01 is not inconclusive', async () => {
    const run = await collect(server, { url: 'https://navpanel.example.test/' });
    const r = runCheck(priv01, snapshotOf(run));
    expect(r.status === 'completed' || r.status === 'partial').toBe(true);
    expect(r.reason).toBeNull();
  });

  it('(a) the navigation panel is not counted as a part of the policy (manifest, no expand-failed)', async () => {
    const run = await collect(server, { url: 'https://navpanel.example.test/' });
    const doc = privacyDoc(run);
    expect(doc?.manifest.expandablesFound).toBe(0);
    expect(doc?.errors).not.toContain('expand-failed');
    expect(doc?.complete).toBe(true);
  });

  it('(b) an unopened section of the policy stays in the manifest; PRIV-01 is partial with banner-open', async () => {
    const run = await collect(server, { url: 'https://accordion.example.test/' });
    const doc = privacyDoc(run);
    expect(doc?.manifest).toMatchObject({ expandablesFound: 1, expandablesOpened: 0 });
    expect(doc?.errors).toContain('expand-failed');
    const r = runCheck(priv01, snapshotOf(run));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['banner-open']);
  });
});

describe('G20: the type of a fetched page is confirmed by its headings', () => {
  it('/impressum redirecting to the home page is no Impressum: no reachable-via-intermediate', async () => {
    const run = await collect(server, { url: 'https://homeredirect.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    // The home page may be kept as a tagged candidate, never as a plain document.
    expect(docs.filter((d) => d.kind === 'impressum' && d.errors.length === 0)).toEqual([]);
    const r = runCheck(legal01, snapshotOf(run));
    const impressum = observationsOf(r).filter((o) => o.subject === 'impressum');
    expect(impressum.map((o) => o.variant)).not.toContain('reachable-via-intermediate');
    expect(impressum.map((o) => o.variant)).toEqual(['unresolved']);
  });

  it('R03: a footer column titled "Impressum" does not make the home page an Impressum (fallback → home page)', async () => {
    const run = await collect(server, { url: 'https://footerheading.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.filter((d) => d.kind === 'impressum' && d.errors.length === 0)).toEqual([]);
    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.find((a) => a.kind === 'impressum' && a.via === 'fallback')?.outcome).not.toBe('found');
    const r = runCheck(legal01, snapshotOf(run));
    const impressum = observationsOf(r).filter((o) => o.subject === 'impressum');
    expect(impressum.map((o) => o.variant)).toEqual(['unresolved']);
  });

  it('R03: a navigation heading in another language does not set the language of the home page as a policy', async () => {
    const run = await collect(server, { url: 'https://navheading.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.filter((d) => d.kind === 'privacy' && d.errors.length === 0)).toEqual([]);
    expect(runCheck(priv01, snapshotOf(run)).reason).not.toBe('language-unsupported');
  });

  it('S-legal-1: the h1 of the navigation does not make an ordinary page the Impressum (fallback)', async () => {
    const run = await collect(server, { url: 'https://navh1.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.filter((d) => d.kind === 'impressum' && d.errors.length === 0)).toEqual([]);
    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.find((a) => a.kind === 'impressum' && a.via === 'fallback')?.outcome).not.toBe('found');
    const impressum = observationsOf(runCheck(legal01, snapshotOf(run))).filter(
      (o) => o.subject === 'impressum',
    );
    // No link on the start page and the fallback is not the document: not found (it used to be "found" through the nav h1).
    expect(impressum.map((o) => o.variant)).toEqual(['document-not-found']);
  });

  it('R03 counterexample: headings inside the content confirm the type, also next to a footer heading of the same text', async () => {
    const run = await collect(server, { url: 'https://contentheading.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    const impressum = docs.find((d) => d.kind === 'impressum');
    const privacy = docs.find((d) => d.kind === 'privacy');
    expect(impressum?.errors).toEqual([]);
    expect(privacy?.errors).toEqual([]);
    expect(privacy?.lang).toBe('de');
  });

  it('a Portuguese policy behind the label "Aviso de Privacidade": a document, language pt, not an error', async () => {
    const run = await collect(server, { url: 'https://pt.example.test/' });
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

  it('G24: the Portuguese footer is found by its labels ("Aviso legal", "Aviso de Privacidade")', async () => {
    const run = await collect(server, { url: 'https://pt.example.test/' });
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

describe('G01: free text of the documents is masked before it is stored', () => {
  it('no local part of an e-mail address in the stored documents; the domain stays', async () => {
    const run = await collect(server, { url: 'https://navpanel.example.test/' });
    const stored = JSON.stringify(run.result.sections.documents);
    expect(stored).not.toContain('max.mustermann');
    expect(stored).not.toContain('privat.person');
    expect(stored).toContain('[redacted]@example.test');
  });
});
