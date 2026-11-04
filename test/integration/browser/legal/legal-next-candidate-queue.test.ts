/** A legal candidate already queued for another document kind does not consume its next candidate. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { collect } from '../helpers.ts';

type Res = Parameters<DynamicHandler['handle']>[1];

const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';

const html = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const send =
  (body: string, status = 200) =>
  (res: Res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
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

const NEWS = html(
  'Aktuelles',
  `<main><h1>Aktuelles aus unserem Haus</h1><p>${'Neuigkeiten aus dem Unternehmen und der Region, Veranstaltungen und Termine. '.repeat(20)}</p></main>`,
);
const COMBINED = html(
  'Rechtliches',
  `<main><h1>Rechtliches</h1><h2>Impressum</h2><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung. ${LOREM}</p><h2>Datenschutzerklärung</h2><p>${LOREM.repeat(60)}</p></main>`,
);
const START = (footer: string) =>
  html('Start', `<main><h1>Start</h1><p>${LOREM.repeat(3)}</p></main><footer>${footer}</footer>`);

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      site('crossqueue.example.test', {
        '/': send(
          START(
            '<a href="/about/">Impressum</a> <a href="/legal/">Datenschutzerklärung</a> <a href="/legal/">Anbieterkennzeichnung</a>',
          ),
        ),
        '/about/': send(NEWS),
        '/legal/': send(COMBINED),
      }),
      // counterexample: the next candidate is a page that is not queued yet (the path stays as it was)
      site('freshnext.example.test', {
        '/': send(
          START(
            '<a href="/about/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a> <a href="/legal/">Anbieterkennzeichnung</a>',
          ),
        ),
        '/about/': send(NEWS),
        '/datenschutz/': send(
          html(
            'Datenschutzerklärung',
            `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(20)}</p></main>`,
          ),
        ),
        '/legal/': send(COMBINED),
      }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

describe('a retry leaves the queued candidates of the other document kind intact', () => {
  it('the next Impressum candidate is queued as the policy: the page is read for both kinds', async () => {
    const run = await collect(server, { url: 'https://crossqueue.example.test/' });

    const docs = run.result.sections.documents?.documents ?? [];
    const confirmed = docs.filter((d) => !d.errors.includes('unconfirmed'));
    expect(confirmed.map((d) => d.kind).sort()).toEqual(['impressum', 'privacy']);
    for (const d of confirmed) expect(d.url).toMatch(/\/legal\/$/);
    const pages = run.result.sections.plan?.pages ?? [];
    expect(pages.filter((p) => /\/legal\/$/.test(p.url))).toHaveLength(1);
    expect(pages.filter((p) => p.role === 'fallback').map((p) => p.url)).toEqual([]);

    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.filter((a) => a.via === 'fallback')).toEqual([]);
    expect(attempts.filter((a) => a.kind === 'privacy').map((a) => a.outcome)).toEqual(['found']);
    expect(attempts.filter((a) => a.kind === 'impressum').map((a) => a.outcome)).toEqual([
      'unconfirmed',
      'found',
    ]);
  });

  it('counterexample: a next candidate that is not queued is followed as before', async () => {
    const run = await collect(server, { url: 'https://freshnext.example.test/' });

    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.filter((a) => a.kind === 'impressum').map((a) => a.outcome)).toEqual([
      'unconfirmed',
      'found',
    ]);
    expect(attempts.filter((a) => a.kind === 'privacy').map((a) => a.outcome)).toEqual(['found']);
    expect(attempts.filter((a) => a.via === 'fallback')).toEqual([]);
  });
});
