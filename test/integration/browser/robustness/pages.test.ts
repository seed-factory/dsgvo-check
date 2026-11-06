/**
 * Navigations that end somewhere other than an HTML page: the browser's own error page and an inline PDF.
 * Synthetic hosts only (`*.example.test`), served by dynamic handlers of the fixture server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { createBrowserCollector } from '../../../../src/collectors/browser/index.ts';
import { CheckRegistry } from '../../../../src/core/evaluation/registry.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import { scan } from '../../../../src/scan.ts';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { fakeCollectors, testDataDir } from '../../../utils/scan-harness.ts';
import { stubCmpApi } from '../consent/stub-cmp.ts';
import { type CollectRun, collect, FAST_TIMING, TEST_SANDBOX } from '../helpers.ts';

const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';

function html(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const FOOTER =
  '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>';

const IMPRESSUM = html(
  'Impressum',
  `<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung. Kontakt: info@example.test.</p></main>`,
);

/** The smallest valid PDF: one empty page. */
function minimalPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function site(host: string, routes: Record<string, (res: Parameters<DynamicHandler['handle']>[1]) => void>) {
  const handler: DynamicHandler = {
    host,
    path: /.*/,
    handle: (req, res, ctx) => {
      const route = routes[ctx.url.pathname];
      if (route) return route(res);
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('404', '<h1>Nicht gefunden</h1>'));
      void req;
    },
  };
  return handler;
}

const send = (body: string | Buffer, type = 'text/html; charset=utf-8', status = 200) =>
  ((res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  }) as (res: Parameters<DynamicHandler['handle']>[1]) => void;

const redirect = (to: string) =>
  ((res) => {
    res.writeHead(302, { location: to });
    res.end();
  }) as (res: Parameters<DynamicHandler['handle']>[1]) => void;

/** The start page is fine in phase A and challenged on every later visit (phase B). */
function laterBlockSite(host: string): DynamicHandler {
  let starts = 0;
  return {
    host,
    path: /.*/,
    handle: (_req, res, ctx) => {
      if (ctx.url.pathname === '/') {
        starts++;
        if (starts > 1) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
          res.end(html('Just a moment...', '<p>Checking your browser</p>'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html('Start', `<main><h1>Start</h1></main>${FOOTER}`));
        return;
      }

      const body =
        ctx.url.pathname === '/impressum/' ? IMPRESSUM : html('Seite', `<main>${LOREM.repeat(3)}</main>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    },
  };
}

/** A LEGAL-01-only scan of `url` with the browser collector's phase A. */
function scanLegal01(url: string) {
  return scan({
    url,
    network: server.network(),
    registry: new CheckRegistry([legal01]),
    dataDir: testDataDir({ ruleset: {} }),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    collectors: fakeCollectors({
      browser: createBrowserCollector({ timing: FAST_TIMING, phases: ['A'] }),
    }),
  });
}

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      // The privacy page answers 200, then the page itself redirects into an endless 302 loop: the browser ends on
      // its own error page (chrome-error) although the first response was a 200.
      site('loop.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1><a href="/kontakt/">Kontakt</a></main>${FOOTER}`)),
        '/kontakt/': send(html('Kontakt', `<main><h1>Kontakt</h1></main>${FOOTER}`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(
          html(
            'Datenschutzerklärung',
            `<main><p>Einen Moment …</p></main><script>location.replace('/loop-a');</script>`,
          ),
        ),
        '/loop-a': redirect('/loop-b'),
        '/loop-b': redirect('/loop-a'),
      }),

      // Control: the endless 302 loop on the navigation itself (Playwright reports the error).
      site('hardloop.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1></main>${FOOTER}`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': redirect('/loop-a'),
        '/loop-a': redirect('/loop-b'),
        '/loop-b': redirect('/loop-a'),
      }),

      // Privacy policy served inline as application/pdf (no Content-Disposition), behind a link without .pdf.
      site('pdf.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1><a href="/kontakt/">Kontakt</a></main>${FOOTER}`)),
        '/kontakt/': send(html('Kontakt', `<main><h1>Kontakt</h1></main>${FOOTER}`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(minimalPdf(), 'application/pdf'),
      }),

      // a 403 on the fallback probe /impressum (the start page has no legal links).
      site('probe403.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1><a href="/kontakt/">Kontakt</a></main>`)),
        '/kontakt/': send(html('Kontakt', `<main><h1>Kontakt</h1></main>`)),
        '/impressum': send(html('Forbidden', '<h1>Forbidden</h1>'), 'text/html; charset=utf-8', 403),
        '/datenschutz': send(
          html('Datenschutzerklärung', `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(4)}</p></main>`),
        ),
      }),

      // a Cloudflare-like challenge on the linked privacy page.
      site('challenge.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1></main>${FOOTER}`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': (res) => {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
          res.end(html('Just a moment...', '<p>Checking if the site connection is secure</p>'));
        },
      }),

      laterBlockSite('laterblock.example.test'),

      // Two links "Datenschutz": the first leads to a substantive page of another kind (a news page),
      // the second is the policy.
      site('candidates.example.test', {
        '/': send(
          html(
            'Start',
            `<nav><a href="/info-b/">Datenschutz</a></nav><main><h1>Start</h1></main>
<footer><a href="/impressum/">Impressum</a> <a href="/info-a/">Datenschutz</a></footer>`,
          ),
        ),
        '/impressum/': send(IMPRESSUM),
        '/info-a/': send(
          html(
            'Aktuelles',
            `<main><h1>Aktuelles aus unserem Haus</h1><p>${'Neuigkeiten aus dem Unternehmen und der Region, Veranstaltungen und Termine. '.repeat(20)}</p></main>`,
          ),
        ),
        '/info-b/': send(
          html('Datenschutzerklärung', `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(5)}</p></main>`),
        ),
      }),

      site('plain.example.test', {
        '/': send(html('Start', `<main><h1>Start</h1></main>${FOOTER}`)),
        '/impressum/': send(IMPRESSUM),
        '/datenschutz/': send(
          html('Datenschutzerklärung', `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(4)}</p></main>`),
        ),
      }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

describe('the browser error page is a failed navigation, not a page and not a document', () => {
  for (const [name, host] of [
    ['an endless redirect loop after a 200 response (final URL chrome-error://)', 'loop.example.test'],
    ['an endless redirect loop on the navigation itself', 'hardloop.example.test'],
  ] as const) {
    it(name, async () => {
      const run = await collect(server, { url: `https://${host}/` });

      const phase = run.result.sections.browser?.phases[0];
      const privacy = phase?.pages.find((p) => p.role === 'privacy');
      expect(privacy).toBeDefined();
      expect(privacy?.finalUrl).not.toMatch(/^chrome-error:/);
      expect(privacy?.evaluable).toBe(false);
      expect(privacy?.notEvaluableReason).toBe('navigation-failed:ERR_TOO_MANY_REDIRECTS');
      expect(privacy?.navigation.ok).toBe(false);
      expect(privacy?.navigation.error).toBe('ERR_TOO_MANY_REDIRECTS');
      expect(privacy?.dom).toBeNull();

      // No document is taken from the error page; the attempt is an error, not a soft-404.
      expect(run.result.sections.documents?.documents.filter((d) => d.kind === 'privacy')).toEqual([]);
      expect(
        run.result.sections.documents?.attempts.filter((a) => a.kind === 'privacy').map((a) => a.outcome),
      ).toEqual(['error']);

      // The impressum is unaffected.
      expect(run.result.sections.documents?.documents.map((d) => d.kind)).toEqual(['impressum']);

      // No page of the plan or the request records carries the error page's URL.
      expect(JSON.stringify(run.result.sections)).not.toContain('chrome-error:');
    });
  }
});

describe('LEGAL-01 over a privacy page that ended on the browser error page', () => {
  it('no links-broken and no finding about the error page; the page is a limitation', async () => {
    const r = await scanLegal01('https://loop.example.test/');

    const legal = (r.report.findings ?? []).filter((f) => f.checkId === 'LEGAL-01');
    expect(legal.filter((f) => f.variant === 'links-broken')).toEqual([]);
    expect(JSON.stringify(r.report)).not.toContain('chrome-error:');
    const check = r.report.checks?.find((c) => c.id === 'LEGAL-01');
    expect(check?.limitations ?? []).toContain('privacy-target-not-evaluable');
  });
});

describe('an inline PDF behind a legal link does not stall phase A', () => {
  it('phase A completes with all pages and phase B runs; no time-budget stop', async () => {
    const t0 = Date.now();

    const run = await collect(server, { url: 'https://pdf.example.test/', deps: { phases: ['A', 'B'] } });

    const phases = run.result.sections.browser?.phases ?? [];
    expect(phases.map((p) => p.phase)).toEqual(['A', 'B']);
    expect(phases[0]?.status).toBe('completed');
    expect(phases[0]?.pages.length).toBeGreaterThanOrEqual(3);
    const pdfPage = phases[0]?.pages.find((p) => p.role === 'privacy');
    expect(pdfPage?.dom).toBeNull();
    expect(pdfPage?.evaluable).toBe(false);
    expect(Date.now() - t0).toBeLessThan(60_000);

    // The viewer page is not read in-page (no read can run out of time there). Response metadata that never arrives
    // is cut off by the page budget and stays visible as a phase error.
    const codes = phases[0]?.errors.map((e) => e.code) ?? [];
    expect(codes).not.toContain('in-page-read-timeout');
    expect(codes.filter((c) => c !== 'recorder-flush-timeout' && !c.endsWith('-timeout'))).toEqual([]);
  });
});

describe('SCAN-BLOCKED names the page and the checks it affects', () => {
  const blocked = (run: CollectRun) => run.result.diagnostics?.filter((d) => d.code === 'SCAN-BLOCKED') ?? [];

  it('a 403 on the fallback probe /impressum: the page, affects the legal checks only (no HDR-01)', async () => {
    const run = await collect(server, { url: 'https://probe403.example.test/' });

    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.affects).toEqual(['LEGAL-01', 'LEGAL-02']);
    expect(d[0]?.params).toMatchObject({
      count: 1,
      page: 'https://probe403.example.test/impressum',
      phase: 'A',
      kind: 'http-403',
    });
    expect(String(d[0]?.params?.signals)).toContain('status:403');

    // The probe itself is not suppressed: the page stays not evaluable.
    expect(run.result.sections.browser?.phases[0]?.pages.find((p) => p.role === 'fallback')?.evaluable).toBe(
      false,
    );
  });

  it('a challenge on the privacy page: affects LEGAL-01, LEGAL-02, PRIV-01 and PRIV-02', async () => {
    const run = await collect(server, { url: 'https://challenge.example.test/' });

    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.affects).toEqual(['LEGAL-01', 'LEGAL-02', 'PRIV-01', 'PRIV-02']);
    expect(d[0]?.params).toMatchObject({
      count: 1,
      page: 'https://challenge.example.test/datenschutz/',
      kind: 'cloudflare',
    });
  });

  it('a challenge only on the start page of phase B: affects CONSENT-04 and CONSENT-05', async () => {
    const run = await collect(server, {
      url: 'https://laterblock.example.test/',
      maxPages: 1,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B'] },
    });

    const d = blocked(run);
    expect(d).toHaveLength(1);
    expect(d[0]?.affects).toEqual(['CONSENT-04', 'CONSENT-05']);
    expect(d[0]?.params).toMatchObject({ count: 1, page: 'https://laterblock.example.test/', phase: 'B' });
    expect(run.result.sections.browser?.phases.find((p) => p.phase === 'B')).toMatchObject({
      status: 'failed',
      reason: 'challenge',
    });
  });

  it('counterexample: a clean site has no SCAN-BLOCKED', async () => {
    const run = await collect(server, { url: 'https://plain.example.test/' });
    expect(blocked(run)).toEqual([]);
  });
});

describe('a page of the wrong type behind the first legal link is followed by the next candidate', () => {
  it('the first "Datenschutz" link leads to a news page: unconfirmed, then the policy is found', async () => {
    const run = await collect(server, { url: 'https://candidates.example.test/' });

    const attempts = run.result.sections.documents?.attempts.filter((a) => a.kind === 'privacy') ?? [];
    expect(attempts.map((a) => a.outcome)).toEqual(['unconfirmed', 'found']);
    expect(attempts.map((a) => a.url)).toEqual([
      'https://candidates.example.test/info-a/',
      'https://candidates.example.test/info-b/',
    ]);

    // No fallback probe was needed.
    expect(
      server.requestsTo('candidates.example.test').filter((r) => r.path.startsWith('/datenschutz')),
    ).toEqual([]);

    const docs = run.result.sections.documents?.documents.filter((d) => d.kind === 'privacy') ?? [];
    const policy = docs.find((d) => d.url.endsWith('/info-b/'));
    expect(policy?.complete).toBe(true);
    // The news page is no confirmed document; it stays visible as a document with its own error.
    expect(docs.find((d) => d.url.endsWith('/info-a/'))?.errors).toContain('unconfirmed');
  });

  it('LEGAL-01 over this collection: no links-broken, no document-not-found for the privacy policy', async () => {
    const r = await scanLegal01('https://candidates.example.test/');

    const variants = (r.report.findings ?? [])
      .filter((f) => f.checkId === 'LEGAL-01')
      .map((f) => `${f.variant}:${f.subject}`);
    expect(variants.filter((v) => v.startsWith('links-broken'))).toEqual([]);
    expect(variants.filter((v) => /document-not-found/.test(v) && /privacy/.test(v))).toEqual([]);
  });

  it('counterexample: a single link to a page of the wrong type stays unconfirmed (no invented document)', async () => {
    const run = await collect(server, { url: 'https://probe403.example.test/' });

    expect(run.result.sections.documents?.attempts.map((a) => a.outcome)).not.toContain('unconfirmed');
  });
});
