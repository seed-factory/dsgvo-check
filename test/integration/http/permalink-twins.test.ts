/**
 * A blog post that phase A never visits, with the real browser, HTTP collector and step after the browser: http:// of
 * www serves the site without a redirect, the start page links a post by its date as a WordPress permalink
 * (`<a rel="bookmark"><time datetime>`), and the post's http:// address serves a comment form that sends to http. The
 * browser records the permalink, the step requests the post's http:// address once with GET, and TLS-01 reports the
 * form as critical, saying why the address was requested. Nothing is submitted; field values reach no output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { loadTexts } from '../../../src/core/data/load.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { createLogger } from '../../../src/core/runtime/logger.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { testDataDir } from '../../utils/scan-harness.ts';
import { BROWSER_PROBE_CHECK, FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';
import { page, type SiteDir, writeSite } from '../browser/site-dir.ts';

const HOST = 'www.example.test';
const SITE = `https://${HOST}/`;
const POST_PATH = '/2025/02/ein-beitrag/';
const POST = `https://${HOST}${POST_PATH}`;
const POST_HTTP = `http://${HOST}${POST_PATH}`;
const ACTION = `http://${HOST}/wp-comments-post.php`;
/** Field values in the markup of the post: no snapshot, report or log may hold them. */
const SECRETS = ['fixture-author-value', 'fixture-comment-text', 'fixture-mail-value'];

const text = (n: number) => '<p>Ein Absatz Text in einem Beitrag mit vielen Wörtern.</p>'.repeat(n);
const SEARCH_FORM = '<form role="search" action="/"><input type="search" name="s"></form>';
/** The comment form of a WordPress post, with values in its fields. */
const COMMENT_FORM =
  `<form action="${ACTION}" method="post" id="commentform" class="comment-form">` +
  '<textarea name="comment">fixture-comment-text</textarea><input name="author" value="fixture-author-value">' +
  '<input type="email" name="email" value="fixture-mail-value"><input type="submit" value="Kommentar abschicken">' +
  '</form>';

let server: FixtureServer;
let site: SiteDir;
let r: ScanResult;
let report: FullReport;
const lines: string[] = [];
const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });

beforeAll(async () => {
  const legal = (title: string) =>
    page(`<main><h1>${title}</h1><p>Beispiel GmbH, Musterstraße 1.</p></main>`);
  site = writeSite({
    // A blog start page: the post title links the post, its date links it as the permalink.
    'index.html': page(`
      <header>${SEARCH_FORM}</header>
      <main>
        <article class="post">
          <h2 class="entry-title"><a href="${POST}">Ein Beitrag</a></h2>
          <div class="entry-meta"><a href="${POST}" rel="bookmark"><time class="entry-date published updated"
            datetime="2025-03-14T09:30:00+01:00">14. März 2025</time></a></div>
          ${text(30)}
        </article>
      </main>
      <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`),
    [`${POST_PATH.slice(1)}index.html`]: page(
      `<header>${SEARCH_FORM}</header><main><article><h1>Ein Beitrag</h1>${text(40)}</article>${COMMENT_FORM}</main>`,
    ),
    'impressum/index.html': legal('Impressum'),
    'datenschutz/index.html': legal('Datenschutzerklärung'),
  });
  // http:// and https:// of www serve the same files: http:// redirects nowhere. The apex serves nothing.
  server = await startFixtureServer({
    hosts: { [HOST]: site.root },
    routes: [{ host: 'example.test', path: '/', status: 404, body: page('404') }],
  });

  r = await scan({
    url: SITE,
    network: server.network(),
    registry: new CheckRegistry([tls01, BROWSER_PROBE_CHECK]),
    dataDir,
    log: createLogger('debug', (l) => lines.push(l)),
    sandbox: TEST_SANDBOX,
    // Start page, Impressum and privacy policy fill the page budget: phase A does not reach the post.
    maxPages: 3,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING, phases: ['A'] }) },
  });
  if (r.report.scan.status === 'failed') throw new Error('expected a full report');
  report = r.report as FullReport;
});

afterAll(async () => {
  await server?.close();
  site?.cleanup();
});

describe('a blog post with a comment form over http that phase A does not visit', () => {
  it('the browser records the date link as the permalink, the title link not', () => {
    const pages = r.snapshot?.browser?.phases.find((p) => p.phase === 'A')?.pages ?? [];
    expect(pages.map((p) => p.finalUrl)).not.toContain(POST);
    const links = pages.find((p) => p.role === 'start')?.dom?.links.filter((l) => l.href === POST);
    expect(links?.map((l) => [l.text, l.permalink ?? false])).toEqual([
      ['Ein Beitrag', false],
      ['14. März 2025', true],
    ]);
  });

  it("requests the post's http:// address once with GET, as a permalink, and nothing else of it", () => {
    expect(r.snapshot?.http?.twins).toEqual([
      expect.objectContaining({
        page: POST,
        url: POST_HTTP,
        source: 'permalink',
        linkedFrom: SITE,
        outcome: 'ok',
        hop: expect.objectContaining({
          status: 200,
          forms: [{ action: ACTION, actionScheme: 'http', method: 'post' }],
        }),
      }),
    ]);
    expect(r.snapshot?.http?.formTwinStage).toMatchObject({
      budget: 3,
      candidates: 0,
      permalinkCandidates: 1,
    });
    expect(r.snapshot?.plan.probes.filter((p) => p.target === POST_HTTP)).toEqual([
      { kind: 'http', class: 'T', target: POST_HTTP, purpose: 'permalink-twin' },
    ]);
    const post = server.requests.filter((q) => q.path === POST_PATH);
    expect(post.map((q) => `${q.method} ${q.scheme}`)).toEqual(['GET http']);
  });

  it('submits nothing: no request to the form action and no request other than GET', () => {
    expect(server.requests.some((q) => q.path.includes('wp-comments-post'))).toBe(false);
    expect(server.requests.filter((q) => q.method !== 'GET')).toEqual([]);
    expect(server.unexpected).toEqual([]);
  });

  it('TLS-01: one critical finding on the post, naming where the form sends and why the address was requested', () => {
    expectValidReport(r.report);
    const critical = report.findings.filter((f) => f.checkId === 'TLS-01' && f.severity === 'critical');
    expect(critical.map((f) => [f.variant, f.pages])).toEqual([['form-on-http-page', [POST_HTTP]]]);
    expect(critical[0]?.params).toMatchObject({ url: POST_HTTP, action: ACTION, count: 1, permalinks: 1 });
    const evidence = report.evidence.filter(
      (e) => critical[0]?.evidenceIds.includes(e.id) && e.type === 'page',
    );
    expect(evidence).toEqual([
      expect.objectContaining({ url: POST_HTTP, role: 'http-form-permalink', formAction: ACTION }),
    ]);
    expect(report.checks.find((c) => c.id === 'TLS-01')).toMatchObject({
      status: 'completed',
      limitations: [],
    });

    const out = { texts: loadTexts('de'), lang: 'de' as const, outDir: '/nonexistent-out', color: false };
    expect(renderHtml(report, out)).toContain('als http-Adresse eines Beitrags oder Artikels abgefragt');
    expect(renderHtml(report, { ...out, texts: loadTexts('en'), lang: 'en' })).toContain(
      'was requested as the http address of a post or article',
    );
  });

  it('keeps no field value in the snapshot, the reports or the logs', () => {
    const ctx = { texts: loadTexts('de'), lang: 'de' as const, outDir: '/nonexistent-out', color: false };
    const outputs = [
      JSON.stringify(r.snapshot),
      renderJson(report),
      renderHtml(report, ctx),
      lines.join('\n'),
    ];
    for (const output of outputs) {
      for (const secret of SECRETS) expect(output).not.toContain(secret);
    }
  });
});
