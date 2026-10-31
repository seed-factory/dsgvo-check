/**
 * L2 (review S-legal-3, L3/G19): a combined legal page. The start page has two exact labels, "Impressum" and
 * "Datenschutzerklärung", and both links lead to ONE URL whose page holds both documents. The collector must keep both
 * kinds of that page: a document of each kind in `DocumentsSection`, and LEGAL-01 / PRIV-01 read the real result.
 * The pure counterpart (selectPages keeps both choices) is in pure/legal-links.test.ts; this test goes through the real
 * collector (Chromium, local fixture server), where a kind that is dropped on the way would be unnoticed there.
 * Synthetic hosts only (`*.example.test`).
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

const html = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const send =
  (body: string, status = 200) =>
  (res: Res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

/** Routes of one synthetic host; every other path answers 404 (so a fallback probe finds nothing). */
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

/** One page, two documents: both headings are in the content. */
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
      // both footer links go to /recht; neither /impressum nor /datenschutz exists
      site('shared.example.test', {
        '/': send(START('<a href="/recht">Impressum</a> <a href="/recht">Datenschutzerklärung</a>')),
        '/recht': send(COMBINED),
      }),
      // the same page behind the links in the other order and with a trailing slash on one of them
      site('sharedorder.example.test', {
        '/': send(START('<a href="/recht/">Datenschutzerklärung</a> <a href="/recht">Impressum</a>')),
        '/recht': send(COMBINED),
        '/recht/': send(COMBINED),
      }),
      // counterexample: two pages, one document each (nothing is shared)
      site('separate.example.test', {
        '/': send(
          START('<a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a>'),
        ),
        '/impressum/': send(
          html(
            'Impressum',
            `<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. ${LOREM}</p></main>`,
          ),
        ),
        '/datenschutz/': send(
          html(
            'Datenschutzerklärung',
            `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(60)}</p></main>`,
          ),
        ),
      }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

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

describe('L3 (S-legal-3): a combined page behind two exact labels keeps both documents', () => {
  it.each([
    ['both links to one URL', 'https://shared.example.test/'],
    ['the links in the other order, one with a trailing slash', 'https://sharedorder.example.test/'],
  ])('%s: a document of each kind in the collected section', async (_, url) => {
    const run = await collect(server, { url });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.map((d) => d.kind).sort()).toEqual(['impressum', 'privacy']);
    // Both are the combined page, confirmed by its headings; neither is an error or an unconfirmed page.
    for (const d of docs) {
      expect(d.errors, d.kind).toEqual([]);
      expect(d.url).toMatch(/\/recht\/?$/);
    }
  });

  it('no extra navigation: the page is fetched once and no fallback probe is made', async () => {
    const run = await collect(server, { url: 'https://shared.example.test/' });
    const pages = run.result.sections.plan?.pages ?? [];
    expect(pages.filter((p) => /\/recht\/?$/.test(p.url))).toHaveLength(1);
    expect(pages.some((p) => p.role === 'fallback')).toBe(false);
    const attempts = run.result.sections.documents?.attempts ?? [];
    expect(attempts.filter((a) => a.via === 'fallback')).toEqual([]);
    expect(attempts.map((a) => [a.kind, a.outcome]).sort()).toEqual([
      ['impressum', 'found'],
      ['privacy', 'found'],
    ]);
  });

  it('LEGAL-01 and PRIV-01 read the collected result: no document-not-found, the policy is evaluated', async () => {
    const run = await collect(server, { url: 'https://shared.example.test/' });
    const snap = snapshotOf(run);
    const legal = runCheck(legal01, snap);
    expect(observationsOf(legal).map((o) => [o.subject, o.variant])).toEqual([]);
    expect(legal.outcome?.limitations ?? []).toEqual([]);
    const priv = runCheck(priv01, snap);
    expect(priv.reason).toBeNull();
    expect(priv.status === 'completed' || priv.status === 'partial').toBe(true);
  });

  it('counterexample: two separate pages stay two documents, each fetched once', async () => {
    const run = await collect(server, { url: 'https://separate.example.test/' });
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.map((d) => [d.kind, d.errors.length]).sort()).toEqual([
      ['impressum', 0],
      ['privacy', 0],
    ]);
    const pages = run.result.sections.plan?.pages ?? [];
    expect(pages.filter((p) => p.role === 'impressum' || p.role === 'privacy')).toHaveLength(2);
  });
});
