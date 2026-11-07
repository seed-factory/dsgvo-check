/**
 * Requests of an earlier page that never end must not hold the next page until HARD_CAP. Real Chromium, synthetic
 * hosts (`*.example.test`); the "forever" requests are never answered.
 */
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { collect, FAST_TIMING } from '../helpers.ts';
import { FOOTER, html, LOREM } from '../site-dir.ts';

const HARD_CAP_MS = FAST_TIMING.phases.A.hardCapMs;

const send = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

/** Start page: three requests that are never answered (more than `maxInflight`); the other pages are plain. */
function hangingSite(host: string, startBody: string): DynamicHandler {
  return {
    host,
    path: /.*/,
    handle: (_req, res, ctx) => {
      switch (ctx.url.pathname) {
        case '/':
          return send(res, html('Start', `<main><h1>Start</h1></main>${FOOTER}${startBody}`));
        case '/impressum/':
          return send(
            res,
            html(
              'Impressum',
              '<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Kontakt: info@example.test.</p></main>',
            ),
          );
        case '/datenschutz/':
          return send(
            res,
            html(
              'Datenschutzerklärung',
              `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(4)}</p></main>`,
            ),
          );
        case '/frame-content/':
          return send(res, html('Widget', `<script>${FETCHES}</script>`));
        default:
          if (ctx.url.pathname.startsWith('/forever/')) return; // never answered
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html('404', '<h1>Nicht gefunden</h1>'));
      }
    },
  };
}

const FETCHES = [1, 2, 3].map((n) => `fetch('/forever/${n}').catch(() => {});`).join('');

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      hangingSite('hang.example.test', `<script>${FETCHES}</script>`),
      // The same requests, but in a frame of the start page: the frame's requests end with the page it belongs to.
      hangingSite(
        'frame.example.test',
        '<iframe src="/frame-content/" title="widget" style="width:10px;height:10px"></iframe>',
      ),
      // Control: nothing hangs.
      hangingSite('quiet.example.test', ''),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

describe('requests of an earlier page that never end', () => {
  for (const [name, host] of [
    ['made by the start page itself', 'hang.example.test'],
    ['made inside a frame of the start page', 'frame.example.test'],
  ] as const) {
    it(`do not hold the next pages of the phase until HARD_CAP: ${name}`, async () => {
      const run = await collect(server, { url: `https://${host}/` });

      const pages = run.result.sections.browser?.phases[0]?.pages ?? [];
      expect(pages.map((p) => p.url.replace(/^https:\/\/[^/]+/, ''))).toEqual(
        expect.arrayContaining(['/', '/impressum/', '/datenschutz/']),
      );
      const later = pages.filter((p) => p.role !== 'start');
      expect(later.length).toBeGreaterThanOrEqual(2);
      for (const p of later) {
        expect(p.navigation.quietReached, `${p.url} reached quiet`).toBe(true);
        expect(p.navigation.dwellMs, `${p.url} dwell`).toBeLessThan(HARD_CAP_MS - 1_000);
      }
    });
  }

  it('stay in the snapshot as they were observed: no response, no end', async () => {
    const run = await collect(server, { url: 'https://hang.example.test/' });

    const forever = run.requests.filter((r) => r.url.includes('/forever/'));
    expect(forever).toHaveLength(3);
    for (const r of forever) {
      expect(r).toMatchObject({ delivery: 'attempted', navigationId: 'A-n1' });
      expect(r.status).toBeUndefined();
    }
  });

  it('counterexample: on the page that makes them they still hold the wait up to HARD_CAP', async () => {
    const run = await collect(server, { url: 'https://hang.example.test/' });

    const start = run.result.sections.browser?.phases[0]?.pages.find((p) => p.role === 'start');
    expect(start?.navigation.quietReached).toBe(false);
    expect(start?.navigation.dwellMs).toBeGreaterThanOrEqual(HARD_CAP_MS);
  });

  it('control: a site without hanging requests is quiet on every page', async () => {
    const run = await collect(server, { url: 'https://quiet.example.test/' });

    const pages = run.result.sections.browser?.phases[0]?.pages ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const p of pages) expect(p.navigation.quietReached).toBe(true);
  });
});
