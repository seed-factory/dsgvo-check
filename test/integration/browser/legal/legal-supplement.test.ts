/**
 * Further privacy notices of a site: after the policy, phase A reads up to `browser.maxSupplementaryPolicies` further
 * notices that the same page links (a notice for course participants), notes the language versions of the policy
 * without a navigation, and leaves settings dialogs alone. PRIV-01 searches the notices with the policy; LEGAL-01 does
 * not take a failed notice for a broken privacy link.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import { useFixtureServer } from '../../../fixture-server/use-fixture-server.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { type CollectRun, collect, FAST_TIMING, snapshotOf } from '../helpers.ts';
import { html, LOREM, send, site } from '../site-dir.ts';

/** Every page of the site links both legal documents in its footer. */
const LEGAL = '<a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutz</a>';
const sub = (title: string, content: string) =>
  html(title, `<main><h1>${title}</h1>${content}</main><footer>${LEGAL}</footer>`);

const IMPRESSUM = sub(
  'Impressum',
  `<p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. ${LOREM}</p>`,
);
// A generator template without any chat service.
const POLICY = sub(
  'Datenschutzerklärung',
  `<h2>Schriftarten</h2><p>Die Schriftarten sind lokal installiert. ${LOREM.repeat(20)}</p>`,
);
const NOTICE = sub(
  'Datenschutzhinweise zu unseren Kursen',
  `<h2>Kommunikation</h2><p>Für Rückfragen nutzen wir den Live-Chat Tidio (Tidio LLC). ${LOREM.repeat(10)}</p>`,
);
const OTHER = sub('Seite', `<p>${LOREM.repeat(3)}</p>`);

const page = (nav: string, footer: string) =>
  html(
    'Start',
    `<header><nav>${nav}</nav></header><main><h1>Start</h1><p>${LOREM.repeat(3)}</p></main><footer>${footer}</footer>`,
    { head: '<script src="https://code.tidio.co/abc.js"></script>' },
  );

const HOST = 'supplement.example.test';
const THREE = 'three.supplement.example.test';
const BROKEN = 'broken.supplement.example.test';
const SAME = 'same.supplement.example.test';
const EXTRAS = 'extras.supplement.example.test';
const CONTACT = 'contact.supplement.example.test';

const server = useFixtureServer(() => {
  return {
    handlers: [
      {
        host: 'code.tidio.co',
        path: /.*/,
        handle: (_req, res) => send('/* chat */', 200, 'application/javascript')(res),
      },
      site(HOST, {
        '/': send(
          page(
            '<a href="/en/datenschutz/">EN</a>',
            `${LEGAL} <a href="/datenschutzhinweise-kurse/">Datenschutz Kurse</a> <a href="/cookie-settings/">Datenschutz-Einstellungen</a>`,
          ),
        ),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(POLICY),
        '/datenschutzhinweise-kurse/': send(NOTICE),
        '/en/datenschutz/': send(OTHER),
        '/cookie-settings/': send(OTHER),
      }),
      site(THREE, {
        '/': send(
          page(
            '',
            `${LEGAL} <a href="/datenschutz-bewerbung/">Datenschutzhinweise Bewerbung</a> <a href="/datenschutzhinweise-kurse/">Datenschutz Kurse</a> <a href="/datenschutz-mitglieder/">Datenschutz Mitglieder</a>`,
          ),
        ),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(POLICY),
        '/datenschutz-bewerbung/': send(NOTICE),
        '/datenschutzhinweise-kurse/': send(NOTICE),
        '/datenschutz-mitglieder/': send(NOTICE),
      }),
      // The notice of the footer answers 404.
      site(BROKEN, {
        '/': send(page('', `${LEGAL} <a href="/datenschutzhinweise-kurse/">Datenschutz Kurse</a>`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(POLICY),
      }),
      // Two labels, one URL: the policy only.
      site(SAME, {
        '/': send(page('<a href="/datenschutz/">Datenschutzerklärung</a>', LEGAL)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(POLICY),
      }),
      // "Kontakt" and the notice lead to one page, the only one that links the Impressum.
      site(CONTACT, {
        '/': send(
          page(
            '<a href="/kurse/">Kontakt</a>',
            '<a href="/datenschutz/">Datenschutz</a> <a href="/kurse/">Datenschutz Kurse</a>',
          ),
        ),
        '/datenschutz/': send(POLICY),
        '/kurse/': send(
          html(
            'Datenschutzhinweise zu unseren Kursen',
            `<main><h1>Datenschutzhinweise zu unseren Kursen</h1><p>Für Rückfragen nutzen wir den Live-Chat Tidio. ${LOREM.repeat(10)}</p></main><footer><a href="/anbieter/">Impressum</a></footer>`,
          ),
        ),
        '/anbieter/': send(IMPRESSUM),
      }),
      // Navigation pages beside the notice: the extras do not change with the notice.
      site(EXTRAS, {
        '/': send(
          page(
            '<a href="/ueber-uns/">Über uns</a> <a href="/team/">Team</a> <a href="/blog/">Blog</a>',
            `${LEGAL} <a href="/datenschutzhinweise-kurse/">Datenschutz Kurse</a>`,
          ),
        ),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(POLICY),
        '/datenschutzhinweise-kurse/': send(NOTICE),
        '/ueber-uns/': send(OTHER),
        '/team/': send(OTHER),
        '/blog/': send(OTHER),
      }),
    ],
  };
});

beforeEach(() => {
  server().reset();
});

const pathsOf = (host: string) =>
  server()
    .requestsTo(host)
    .map((r) => r.path);
const privacyDocs = (run: CollectRun) =>
  (run.result.sections.documents?.documents ?? []).filter((d) => d.kind === 'privacy');

describe('further privacy notices of the site', () => {
  it('reads the notice beside the policy, notes the language version and leaves the settings dialog alone', async () => {
    const run = await collect(server(), { url: `https://${HOST}/` });

    expect(privacyDocs(run).map((d) => [new URL(d.url).pathname, d.role ?? 'main', d.errors])).toEqual([
      ['/datenschutz/', 'main', []],
      ['/datenschutzhinweise-kurse/', 'supplement', []],
    ]);
    const paths = pathsOf(HOST);
    expect(paths.filter((p) => p === '/datenschutzhinweise-kurse/')).toHaveLength(1);
    expect(paths).not.toContain('/en/datenschutz/');
    expect(paths).not.toContain('/cookie-settings/');

    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(
      attempts.filter((a) => a.supplement).map((a) => [new URL(a.url).pathname, a.outcome, a.status]),
    ).toEqual([
      ['/en/datenschutz/', 'other-language', null],
      ['/datenschutzhinweise-kurse/', 'found', 200],
    ]);
    const planned = run.result.sections.plan?.pages.find((p) =>
      p.url.endsWith('/datenschutzhinweise-kurse/'),
    );
    expect(planned).toMatchObject({ role: 'privacy', source: 'link' });
    expect(planned?.reasons).toContain('supplement');
  });

  it('PRIV-01 finds the chat named in the notice; LEGAL-01 reports nothing about the notice', async () => {
    const run = await collect(server(), { url: `https://${HOST}/` });
    const snap = snapshotOf(run);
    expect(snap.derived?.services.map((s) => s.serviceId)).toContain('tidio');

    const priv = runCheck(priv01, snap);
    expect(observationsOf(priv).map((o) => o.subject)).not.toContain('tidio');
    // The English version was noted, not read.
    expect(priv).toMatchObject({ status: 'partial', reason: null });
    expect(priv.outcome?.limitations).toEqual(['supplement-not-evaluated']);

    const legal = runCheck(legal01, snap);
    expect(observationsOf(legal).map((o) => [o.subject, o.variant])).toEqual([]);
    expect(legal.outcome?.limitations ?? []).toEqual([]);
  });

  it('counterexample with the limit 0: only the policy, no request for the notice, the chat stays not-named', async () => {
    const run = await collect(server(), {
      url: `https://${HOST}/`,
      config: { browser: { maxSupplementaryPolicies: 0 } },
    });
    expect(privacyDocs(run).map((d) => new URL(d.url).pathname)).toEqual(['/datenschutz/']);
    expect(pathsOf(HOST)).not.toContain('/datenschutzhinweise-kurse/');
    expect((run.result.sections.documents?.attempts ?? []).filter((a) => a.supplement)).toEqual([]);

    const priv = runCheck(priv01, snapshotOf(run));
    expect(observationsOf(priv).map((o) => [o.subject, o.variant])).toContainEqual(['tidio', 'not-named']);
  });

  it('three notices and the limit 1: only the best-ranked one is fetched', async () => {
    const run = await collect(server(), { url: `https://${THREE}/` });
    const paths = pathsOf(THREE);
    expect(paths).toContain('/datenschutz-bewerbung/');
    expect(paths).not.toContain('/datenschutzhinweise-kurse/');
    expect(paths).not.toContain('/datenschutz-mitglieder/');
    expect(
      privacyDocs(run)
        .filter((d) => d.role === 'supplement')
        .map((d) => new URL(d.url).pathname),
    ).toEqual(['/datenschutz-bewerbung/']);
  });

  it('a notice that answers 404: the policy is still evaluated and LEGAL-01 reports no broken link', async () => {
    const run = await collect(server(), { url: `https://${BROKEN}/` });
    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.filter((a) => a.supplement)).toMatchObject([
      { kind: 'privacy', outcome: 'not-found', status: 404, supplement: true },
    ]);

    const snap = snapshotOf(run);
    const legal = runCheck(legal01, snap);
    expect(observationsOf(legal).map((o) => [o.subject, o.variant])).toEqual([]);
    expect(legal.outcome?.limitations ?? []).toEqual([]);
    const priv = runCheck(priv01, snap);
    expect(priv).toMatchObject({ status: 'completed', reason: null });
  });

  it('two labels of one URL fetch it once and read no notice', async () => {
    const run = await collect(server(), { url: `https://${SAME}/` });
    expect(pathsOf(SAME).filter((p) => p === '/datenschutz/')).toHaveLength(1);
    expect(privacyDocs(run).map((d) => d.role ?? 'main')).toEqual(['main']);
    expect((run.result.sections.documents?.attempts ?? []).filter((a) => a.supplement)).toEqual([]);
  });

  it('the notice is a legal page: the extra pages are the same with and without it', async () => {
    const extras = (run: CollectRun) =>
      (run.result.sections.plan?.pages ?? []).filter((p) => p.role === 'nav').map((p) => p.url);
    const without = await collect(server(), {
      url: `https://${EXTRAS}/`,
      config: { browser: { maxSupplementaryPolicies: 0 } },
    });
    const withNotice = await collect(server(), { url: `https://${EXTRAS}/` });
    expect(extras(without)).toHaveLength(3);
    expect(extras(withNotice)).toEqual(extras(without));
    expect(privacyDocs(withNotice).map((d) => d.role ?? 'main')).toEqual(['main', 'supplement']);
  });

  it('a contact page that is also the notice is read as both: its Impressum link is still followed', async () => {
    const run = await collect(server(), { url: `https://${CONTACT}/` });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.map((d) => [d.kind, new URL(d.url).pathname, d.role ?? 'main', d.foundVia])).toEqual([
      ['privacy', '/datenschutz/', 'main', 'link'],
      ['privacy', '/kurse/', 'supplement', 'link'],
      ['impressum', '/anbieter/', 'main', 'hop'],
    ]);
    expect(pathsOf(CONTACT).filter((p) => p === '/kurse/')).toHaveLength(1);
    const planned = run.result.sections.plan?.pages.find((p) => p.url.endsWith('/kurse/'));
    expect(planned).toMatchObject({ role: 'contact' });
    expect(planned?.reasons).toContain('supplement');
  });

  it('keeps the navigation pause before the notice with production pacing', async () => {
    const run = await collect(server(), {
      url: `https://${HOST}/`,
      deps: { timing: { ...FAST_TIMING, navigationPauseMs: 1_500 } },
    });
    const pages = run.result.sections.browser?.phases[0]?.pages ?? [];
    const at = pages.findIndex((p) => p.url.endsWith('/datenschutzhinweise-kurse/'));
    expect(at).toBeGreaterThan(0);
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]!;
      const prevEnd = Date.parse(prev.navigation.startedAt) + prev.navigation.dwellMs;
      expect(Date.parse(pages[i]!.navigation.startedAt) - prevEnd).toBeGreaterThanOrEqual(1_450);
    }
  });
});
