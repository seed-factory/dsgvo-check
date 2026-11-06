/**
 * Forms served over plain http on the fixture server: http:// of www serves the site without a redirect, the start page
 * has its comment form after 70 KiB of content, and an article and the contact page carry forms. The HTTP collector
 * reads the whole start page; after the browser the step requests the http:// addresses of the pages with a form once,
 * with GET and paced, and TLS-01 reports the forms with where they send. Field values reach no output.
 */
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { createFormTwinCollector } from '../../../src/collectors/http/form-twins.ts';
import { createHttpCollector } from '../../../src/collectors/http/index.ts';
import { defaultConfig } from '../../../src/core/config/schema.ts';
import { loadTexts } from '../../../src/core/data/load.ts';
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import type { FullReport } from '../../../src/core/report/schema.ts';
import { createLogger } from '../../../src/core/runtime/logger.ts';
import type { BrowserSection, FormFact } from '../../../src/core/snapshot/browser.ts';
import type { HttpSection } from '../../../src/core/snapshot/http.ts';
import type { Snapshot } from '../../../src/core/snapshot/index.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { scan } from '../../../src/scan.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { testDataDir } from '../../utils/scan-harness.ts';
import {
  makeBrowser,
  makeDom,
  makePage,
  makePhase,
  makeSnapshot,
  makeTarget,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../utils/snapshot-builder.ts';
import { closedPort, collectorContext, withRoutes } from './helpers.ts';
import { GOOD_HEADERS } from './sites.ts';

const HOST = 'www.comments.test';
const SITE = `https://${HOST}/`;
const ACTION = `http://${HOST}/wp-comments-post.php`;
/** Field values in the markup: no snapshot, report or log may hold them. */
const SECRETS = ['fixture-author-value', 'fixture-comment-text', 'fixture-mail-value'];
/** Production pacing: at most 2 requests per second to one host. */
const PACER_INTERVAL_MS = 500;
/** Slack for descheduling and GC when request starts are compared with the pacing interval. */
const START_JITTER_MS = 50;
const KIB = 1024;

const filler = (bytes: number): string => {
  const unit = '<p>Ein Absatz Text in einem langen Beitrag mit vielen Wörtern.</p>\n';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
};
const doc = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const SEARCH_FORM = `<form role="search" action="/"><input type="search" name="s"></form>`;
const COMMENT_FORM =
  `<form action="${ACTION}" method="post" id="commentform"><textarea name="comment">fixture-comment-text</textarea>` +
  '<input name="author" value="fixture-author-value"><input type="submit" value="Senden"></form>';
const CONTACT_FORM =
  '<form action="/kontakt/senden" method="post"><input type="email" name="mail" value="fixture-mail-value">' +
  '<textarea name="nachricht"></textarea></form>';

const route = (scheme: 'http' | 'https', path: string, body: string) => ({
  host: HOST,
  scheme,
  path,
  status: 200,
  headers: GOOD_HEADERS,
  body,
});

/** Both schemes serve the same pages: http:// redirects nowhere. */
const ROUTES = (['http', 'https'] as const).flatMap((scheme) => [
  route(scheme, '/', doc('Start', `${SEARCH_FORM}${filler(72 * KIB)}${COMMENT_FORM}`)),
  route(scheme, '/blog/post-1/', doc('Beitrag', `${SEARCH_FORM}${filler(8 * KIB)}${COMMENT_FORM}`)),
  route(scheme, '/kontakt/', doc('Kontakt', `${SEARCH_FORM}${CONTACT_FORM}`)),
  route(scheme, '/suche/', doc('Suche', SEARCH_FORM)),
]);

/** What phase A saw of the pages: the search in the header of each, the forms that take data on three. */
const fact = (p: Partial<FormFact>): FormFact => ({
  action: SITE,
  actionScheme: 'https',
  method: 'get',
  visible: true,
  fieldCount: 1,
  hasPasswordField: false,
  hasEmailField: false,
  takesInput: true,
  ...p,
});
const SEARCH_FACT = fact({ fieldCount: 1, takesInput: false });
const COMMENT_FACT = fact({
  action: ACTION,
  actionScheme: 'http',
  method: 'post',
  fieldCount: 3,
  hasEmailField: false,
});
const CONTACT_FACT = fact({
  action: `${SITE}kontakt/senden`,
  method: 'post',
  fieldCount: 2,
  hasEmailField: true,
});

function phaseA(): BrowserSection {
  const visit = (path: string, role: 'start' | 'contact' | 'other', forms: FormFact[], order: number) =>
    makePage({ url: new URL(path, SITE).href, role, order, dom: makeDom({ forms }) });
  return makeBrowser({
    phases: [
      makePhase('A', {
        pages: [
          visit('/', 'start', [SEARCH_FACT, COMMENT_FACT], 0),
          visit('/blog/post-1/', 'other', [SEARCH_FACT, COMMENT_FACT], 1),
          visit('/kontakt/', 'contact', [SEARCH_FACT, CONTACT_FACT], 2),
          visit('/suche/', 'other', [SEARCH_FACT], 3),
        ],
      }),
    ],
  });
}

const browserCollector = vi.hoisted(() => ({ section: null as unknown }));
vi.mock('../../../src/collectors/browser/index.ts', () => ({
  collectBrowser: async () => ({
    status: 'ok' as const,
    sections: { browser: browserCollector.section, finalUrl: 'https://www.comments.test/' },
  }),
}));

/**
 * edge.test — http:// of www serves the site; one page with a form answers with a gzip header over a body that is not
 * gzip, one with a gzip stream that stops before its end (the response itself complete), three others answer 503.
 */
const EDGE = 'www.edge.test';
const EDGE_ROUTES = [
  ...(['http', 'https'] as const).map((scheme) => ({
    ...route(scheme, '/', doc('Start', `${SEARCH_FORM}${filler(4 * KIB)}`)),
    host: EDGE,
  })),
  {
    host: EDGE,
    scheme: 'http' as const,
    path: '/kaputt/',
    status: 200,
    headers: { ...GOOD_HEADERS, 'content-encoding': 'gzip' },
    body: doc('Kontakt', CONTACT_FORM),
  },
  ...['/voll-1/', '/voll-2/', '/voll-3/'].map((path) => ({
    host: EDGE,
    scheme: 'http' as const,
    path,
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '1' },
    body: doc('Wartung', ''),
  })),
];

let server: FixtureServer;
let closed: number;

/** The contact page as a gzip stream without its second half: the form at the end never comes out. */
const HALF_GZIP = (() => {
  const gz = zlib.gzipSync(Buffer.from(doc('Kontakt', `${filler(8 * KIB)}${CONTACT_FORM}`)));
  return gz.subarray(0, gz.length >> 1);
})();

beforeAll(async () => {
  server = await startFixtureServer({ routes: [...ROUTES, ...EDGE_ROUTES] });
  server.addHandler({
    host: EDGE,
    scheme: 'http',
    path: '/halb/',
    handle: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(HALF_GZIP.length),
      });
      res.end(HALF_GZIP);
    },
  });
  closed = await closedPort();
});

afterAll(async () => {
  await server?.close();
});

/** The apex refuses connections: www is the site. */
const network = () => withRoutes(server.network(), { 'comments.test': closed, 'edge.test': closed });

describe('forms over http: the HTTP collector and the step after the browser', () => {
  const lines: string[] = [];
  const twinStarts: number[] = [];
  let http: HttpSection;
  let extended: HttpSection;
  let twinRequests: typeof server.requests;

  beforeAll(async () => {
    server.reset();
    const log = createLogger('debug', (l) => lines.push(l));
    const first = await createHttpCollector({ minIntervalMs: 20 })(
      collectorContext(SITE, network(), { log }),
    );
    http = first.sections.http as HttpSection;

    const before = server.requests.length;
    const now = () => {
      const d = new Date();
      twinStarts.push(d.getTime());
      return d;
    };
    const snapshot = { http, browser: phaseA() } as Partial<Snapshot> as Snapshot;
    const second = await createFormTwinCollector()(collectorContext(SITE, network(), { log, now, snapshot }));
    extended = second.sections.http as HttpSection;
    twinRequests = server.requests.slice(before);
  });

  it('the start page is read in full: the comment form after 70 KiB, with where it sends', () => {
    const root = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http')?.final;
    expect(root?.bodyBytes).toBeGreaterThan(72 * KIB);
    expect(root).toMatchObject({
      status: 200,
      hasForm: true,
      formInspection: 'complete',
      forms: [{ action: ACTION, actionScheme: 'http', method: 'post' }],
    });
  });

  it('requests the http:// address of each further page with a form once, the contact form first', () => {
    expect(extended.twins?.map((t) => [t.page, t.url, t.outcome])).toEqual([
      [`${SITE}kontakt/`, `http://${HOST}/kontakt/`, 'ok'],
      [`${SITE}blog/post-1/`, `http://${HOST}/blog/post-1/`, 'ok'],
    ]);
    expect(extended.formTwinStage).toMatchObject({ budget: 3, candidates: 2 });
    expect(extended.twins?.map((t) => t.hop?.forms)).toEqual([
      [{ action: `http://${HOST}/kontakt/senden`, actionScheme: 'http', method: 'post' }],
      [{ action: ACTION, actionScheme: 'http', method: 'post' }],
    ]);
    expect(extended.requestsIssued).toBe(http.requestsIssued + 2);
    expect(extended.chains).toEqual(http.chains);
  });

  it('sends only GET, only to those addresses, and never to a form action', () => {
    expect(twinRequests.map((r) => `${r.method} ${r.scheme}://${r.host}${r.path}`)).toEqual([
      `GET http://${HOST}/kontakt/`,
      `GET http://${HOST}/blog/post-1/`,
    ]);
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(
      server.requests.some((r) => r.path.includes('wp-comments-post') || r.path.includes('senden')),
    ).toBe(false);
    expect(server.unexpected).toEqual([]);
  });

  it('starts the requests to the host at least 500 ms apart', () => {
    expect(twinStarts).toHaveLength(2);
    expect((twinStarts[1] as number) - (twinStarts[0] as number)).toBeGreaterThanOrEqual(
      PACER_INTERVAL_MS - START_JITTER_MS,
    );
  });

  it('TLS-01: one critical finding over the three pages, naming where the first form sends', () => {
    const result = runCheck(
      tls01,
      makeSnapshot({ target: makeTarget(SITE), http: extended, browser: phaseA() }),
    );
    expect(result.status).toBe('completed');
    expect(variantsOf(result)).toEqual(['form-on-http-page', 'no-redirect']);
    const form = observationsOf(result).find((o) => o.variant === 'form-on-http-page');
    expect(form?.pages).toEqual([
      `http://${HOST}/`,
      `http://${HOST}/kontakt/`,
      `http://${HOST}/blog/post-1/`,
    ]);
    expect(form?.params).toMatchObject({ url: `http://${HOST}/`, action: ACTION, count: 3 });
  });

  it('keeps no field value in the sections or the logs', () => {
    for (const out of [JSON.stringify(http), JSON.stringify(extended), lines.join('\n')]) {
      for (const secret of SECRETS) expect(out).not.toContain(secret);
    }
  });
});

describe('forms over http: what the step cannot read, and a host that is overloaded', () => {
  let extended: HttpSection;
  let stepRequests: typeof server.requests;

  beforeAll(async () => {
    server.reset();
    const edgeSite = `https://${EDGE}/`;
    const first = await createHttpCollector({ minIntervalMs: 20 })(collectorContext(edgeSite, network()));
    const http = first.sections.http as HttpSection;
    const visit = (path: string, order: number) =>
      makePage({
        url: `${edgeSite}${path.slice(1)}`,
        role: 'other',
        order,
        dom: makeDom({ forms: [CONTACT_FACT] }),
      });
    const browser = makeBrowser({
      phases: [
        makePhase('A', {
          pages: [
            visit('/kaputt/', 1),
            visit('/halb/', 2),
            visit('/voll-1/', 3),
            visit('/voll-2/', 4),
            visit('/voll-3/', 5),
          ],
        }),
      ],
    });
    const before = server.requests.length;
    const snapshot = { http, browser } as Partial<Snapshot> as Snapshot;
    const config = defaultConfig();
    const second = await createFormTwinCollector({ minIntervalMs: 20 })(
      collectorContext(edgeSite, network(), {
        snapshot,
        config: { ...config, http: { ...config.http, formTwinPages: 4 } },
      }),
    );
    extended = second.sections.http as HttpSection;
    stepRequests = server.requests.slice(before);
  });

  it.each([
    ['a gzip header over a body that is not gzip', 0],
    ['a gzip stream that stops before its end', 1],
  ])('%s leaves the forms unread, not absent', (_name, i) => {
    expect(extended.twins?.[i]?.hop).toMatchObject({
      status: 200,
      bodyTruncated: false,
      hasForm: false,
      formInspection: 'unavailable',
    });
  });

  it('after a 503 of the host the step sends it nothing more: no retry, no further page', () => {
    expect(stepRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /kaputt/',
      'GET /halb/',
      'GET /voll-1/',
    ]);
    expect(extended.twins?.map((t) => [t.url, t.outcome, t.hop?.status ?? null])).toEqual([
      [`http://${EDGE}/kaputt/`, 'ok', 200],
      [`http://${EDGE}/halb/`, 'ok', 200],
      [`http://${EDGE}/voll-1/`, 'ok', 503],
      [`http://${EDGE}/voll-2/`, 'throttled', null],
    ]);
    expect(extended.formTwinStage).toMatchObject({ budget: 4, candidates: 5 });
  });

  it('TLS-01 names each page it could not decide and the pages over the budget', () => {
    const result = runCheck(tls01, makeSnapshot({ target: makeTarget(`https://${EDGE}/`), http: extended }));
    expect(result.status).toBe('partial');
    expect(result.outcome?.limitations).toEqual(
      expect.arrayContaining([
        `http-form-not-inspected:http://${EDGE}/kaputt/`,
        `http-form-not-inspected:http://${EDGE}/halb/`,
        `http-form-twin-undecided:https://${EDGE}/voll-1/`,
        `http-form-twin-undecided:https://${EDGE}/voll-2/`,
        'http-form-twins-capped',
      ]),
    );
    expect(variantsOf(result)).toEqual(['no-redirect']);
  });
});

describe('forms over http in a whole scan', () => {
  /** The scan needs the browser for this check, so that the step after it runs. */
  const pageCheck = defineCheck({
    id: 'TEST-01',
    module: 'browser',
    requires: ['browser'],
    variants: [{ variant: 'hit' }],
    run: () => [],
  });
  const dataDir = testDataDir({ ruleset: { 'TEST-01': { hit: 'info' } } });
  const lines: string[] = [];
  let report: FullReport;
  let snapshot: Snapshot | null;

  beforeAll(async () => {
    server.reset();
    browserCollector.section = phaseA();
    const result = await scan({
      url: SITE,
      network: network(),
      dataDir,
      registry: new CheckRegistry([tls01, pageCheck]),
      log: createLogger('debug', (l) => lines.push(l)),
    });
    report = result.report as FullReport;
    snapshot = result.snapshot;
  });

  it('reports the form over http as critical, with the action in the evidence', () => {
    const finding = report.findings.find((f) => f.variant === 'form-on-http-page');
    expect(finding).toMatchObject({ checkId: 'TLS-01', severity: 'critical', crmCode: 'T1_UNENCRYPTED' });
    expect(finding?.pages).toHaveLength(3);
    const evidence = report.evidence.filter((e) => finding?.evidenceIds.includes(e.id) && e.type === 'page');
    expect(evidence.map((e) => (e as { formAction?: string }).formAction)).toContain(ACTION);
    expect(snapshot?.plan.probes.filter((p) => p.purpose === 'form-twin').map((p) => p.target)).toEqual([
      `http://${HOST}/kontakt/`,
      `http://${HOST}/blog/post-1/`,
    ]);
  });

  it('sends only GET and keeps no field value in the snapshot, the reports or the logs', () => {
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
    const ctx = { texts: loadTexts('de'), lang: 'de' as const, outDir: '/nonexistent-out', color: false };
    const outputs = [JSON.stringify(snapshot), renderJson(report), renderHtml(report, ctx), lines.join('\n')];
    for (const out of outputs) {
      for (const secret of SECRETS) expect(out).not.toContain(secret);
    }
    expect(renderHtml(report, ctx)).toContain(ACTION);
  });
});
