/**
 * A combined legal page: "Impressum" and "Datenschutzerklärung" link to ONE URL whose page holds both documents. The
 * collector must keep a document of each kind (`DocumentsSection`) so LEGAL-01 / PRIV-01 read the real result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { collect, snapshotOf } from '../helpers.ts';
import { html, LOREM, send, site } from '../site-dir.ts';

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

describe('a combined page behind two exact labels keeps both documents', () => {
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
