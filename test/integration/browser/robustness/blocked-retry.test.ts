/**
 * SCAN-BLOCKED follows the final outcome of a navigation: a legal subpage answering 503 with a bot-protection page and
 * then delivering on the one repeat is an evaluated page. The first blocked attempt stays a fact of the phase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { type CollectRun, collect } from '../helpers.ts';

const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';

const page = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const FOOTER =
  '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>';
const START = page('Start', `<main><h1>Start</h1></main>${FOOTER}`);
const IMPRESSUM = page(
  'Impressum',
  '<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung. Kontakt: info@example.test.</p></main>',
);
const POLICY = page(
  'Datenschutzerklärung',
  `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(4)}</p></main>`,
);
const CHALLENGE = page('Just a moment...', '<p>Checking your browser before accessing the site.</p>');

type Answer = (res: Parameters<DynamicHandler['handle']>[1], n: number) => void;

const html =
  (body: string, status = 200, extra: Record<string, string> = {}): Answer =>
  (res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra });
    res.end(body);
  };

/** Requests the privacy page of each host has got in the running test (cleared before every test). */
const privacyRequests = new Map<string, number>();

/** A site whose privacy page answers by the number of requests it has got so far (1st, 2nd, …). */
function site(host: string, privacy: (n: number) => Answer): DynamicHandler {
  return {
    host,
    path: /.*/,
    handle: (_req, res, ctx) => {
      const p = ctx.url.pathname;
      if (p === '/datenschutz/') {
        const n = (privacyRequests.get(host) ?? 0) + 1;
        privacyRequests.set(host, n);
        return privacy(n)(res, n);
      }
      if (p === '/impressum/') return html(IMPRESSUM)(res, 0);
      if (p === '/') return html(START)(res, 0);
      return html(page('404', '<h1>Nicht gefunden</h1>'), 404)(res, 0);
    },
  };
}

const cloudflare503 = html(CHALLENGE, 503, { 'cf-mitigated': 'challenge' });

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      // 503 with a challenge, then the policy.
      site('recovers.example.test', (n) => (n === 1 ? cloudflare503 : html(POLICY))),
      // Control: 503 with a challenge twice.
      site('stays-blocked.example.test', () => cloudflare503),
      // Control: 503 with a challenge, then the connection is dropped on the repeat.
      site('repeat-fails.example.test', (n) =>
        n === 1
          ? cloudflare503
          : (res) => {
              res.socket?.destroy();
            },
      ),
      // Control: a plain 503 (no bot protection), then the policy.
      site('plain-503.example.test', (n) =>
        n === 1 ? html(page('Wartung', '<p>Dienst vorübergehend nicht verfügbar.</p>'), 503) : html(POLICY),
      ),
      // Control: a 403 challenge is not repeated (no overload status).
      site('no-repeat.example.test', () => html(CHALLENGE, 403, { 'cf-mitigated': 'challenge' })),
    ],
  });
});

beforeEach(() => {
  privacyRequests.clear();
  server.reset();
});

afterAll(async () => {
  await server?.close();
});

const blocked = (run: CollectRun) => run.result.diagnostics?.filter((d) => d.code === 'SCAN-BLOCKED') ?? [];
const privacyHits = (host: string) => server.requestsTo(host).filter((r) => r.path === '/datenschutz/');
const privacyVisit = (run: CollectRun) =>
  run.result.sections.browser?.phases[0]?.pages.filter((p) => p.role === 'privacy') ?? [];

describe('a blocked first attempt that the repeat made good is no SCAN-BLOCKED', () => {
  it('503 + challenge, then 200: the page is evaluated, no SCAN-BLOCKED', async () => {
    const run = await collect(server, { url: 'https://recovers.example.test/' });

    expect(privacyHits('recovers.example.test')).toHaveLength(2); // the repeat of the overload policy happened
    const visits = privacyVisit(run);
    expect(visits).toHaveLength(1); // the repeat replaces the first visit
    expect(visits[0]?.navigation.status).toBe(200);
    expect(visits[0]?.evaluable).toBe(true);
    expect(visits[0]?.challenge.detected).toBe(false);
    expect(blocked(run)).toEqual([]);
  });

  it('the first block stays visible as an entry of the phase, with the code of its status and no new field', async () => {
    const run = await collect(server, { url: 'https://recovers.example.test/' });

    const phase = run.result.sections.browser?.phases[0];
    const entries =
      phase?.errors.filter((e) => e.url?.endsWith('/datenschutz/') && e.code === 'http-503') ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ code: 'http-503', phase: 'A' });
    expect(entries[0]?.message).toMatch(/attempt 1 of 2/);
    expect(entries[0]?.message).toMatch(/cloudflare/);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['code', 'message', 'phase', 'url']);
  });

  it('counterexample: the same challenge on the repeat — SCAN-BLOCKED stays, once, for the page', async () => {
    const run = await collect(server, { url: 'https://stays-blocked.example.test/' });

    expect(privacyHits('stays-blocked.example.test')).toHaveLength(2);
    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.affects).toEqual(['LEGAL-01', 'LEGAL-02', 'PRIV-01', 'PRIV-02']);
    expect(d[0]?.params).toMatchObject({
      count: 1,
      page: 'https://stays-blocked.example.test/datenschutz/',
      phase: 'A',
      kind: 'cloudflare',
    });
  });

  it('counterexample: the repeat gives no page at all — SCAN-BLOCKED stays with what the first attempt showed', async () => {
    const run = await collect(server, { url: 'https://repeat-fails.example.test/' });

    expect(privacyHits('repeat-fails.example.test').length).toBeGreaterThanOrEqual(2);
    const visits = privacyVisit(run);
    expect(visits).toHaveLength(1);
    expect(visits[0]?.evaluable).toBe(false);
    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.affects).toEqual(['LEGAL-01', 'LEGAL-02', 'PRIV-01', 'PRIV-02']);
    expect(d[0]?.params).toMatchObject({
      page: 'https://repeat-fails.example.test/datenschutz/',
      kind: 'cloudflare',
    });
  });

  it('counterexample: a plain 503 that recovers was never a block — no SCAN-BLOCKED, no entry about a block', async () => {
    const run = await collect(server, { url: 'https://plain-503.example.test/' });

    expect(privacyHits('plain-503.example.test')).toHaveLength(2);
    expect(blocked(run)).toEqual([]);
    const codes = run.result.sections.browser?.phases[0]?.errors.map((e) => e.code) ?? [];
    expect(codes).not.toContain('http-503');
  });

  it('counterexample: a 403 challenge is not repeated and stays SCAN-BLOCKED, without a retry entry', async () => {
    const run = await collect(server, { url: 'https://no-repeat.example.test/' });

    expect(privacyHits('no-repeat.example.test')).toHaveLength(1);
    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.params).toMatchObject({
      page: 'https://no-repeat.example.test/datenschutz/',
      kind: 'cloudflare',
    });
    const codes = run.result.sections.browser?.phases[0]?.errors.map((e) => e.code) ?? [];
    expect(codes).not.toContain('http-403');
  });
});
