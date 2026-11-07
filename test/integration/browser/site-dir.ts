/**
 * Helpers for tests that need a few synthetic pages: files in a temp dir served by the fixture server, or the routes of
 * a dynamic handler.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll } from 'vitest';
import {
  type DynamicHandler,
  type FixtureServer,
  type RouteSpec,
  startFixtureServer,
} from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { type CollectRun, collect } from './helpers.ts';

export interface SiteDir {
  root: string;
  cleanup(): void;
}

/** `files` maps a relative path (`index.html`, `impressum/index.html`) to its content. */
export function writeSite(files: Record<string, string>): SiteDir {
  const root = mkdtempSync(path.join(tmpdir(), 'dsgvo-check-site-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type CollectOptions = NonNullable<Parameters<typeof collect>[1]>;

type RunOf<C> = C extends undefined ? unknown : { run: CollectRun };
type BrowserOf<B> = B extends true ? { browser: TestBrowser; tab: Page } : unknown;

/**
 * What `useSite` holds once the `beforeAll` of its suite has run. `run` exists only with `collect`, `browser` and
 * `tab` only with `browser: true`, so a suite that forgot the option fails to compile instead of reading `undefined`.
 */
export type SiteUnderTest<C, B> = { server: FixtureServer } & RunOf<C> & BrowserOf<B>;

/**
 * For the tests of the enclosing suite: serves `files` as `host` (www.example.test unless given; `routes` answer
 * first), then collects phase A once from its start page and launches a test browser if asked to; closes and removes
 * all of it afterwards.
 */
export function useSite<C extends true | CollectOptions | undefined = undefined, B extends boolean = false>(
  files: Record<string, string>,
  opts: {
    host?: string;
    routes?: RouteSpec[];
    /** Phase A from the start page: `true` with the defaults of `collect`, or its options. */
    collect?: C;
    browser?: B;
  } = {},
): SiteUnderTest<C, B> {
  const site: { server?: FixtureServer; run?: CollectRun; browser?: TestBrowser; tab?: Page } = {};
  let dir: SiteDir | undefined;
  beforeAll(async () => {
    dir = writeSite(files);
    const host = opts.host ?? 'www.example.test';
    site.server = await startFixtureServer({ hosts: { [host]: dir.root }, routes: opts.routes });
    const start = { url: `https://${host}/` };
    if (opts.collect)
      site.run = await collect(site.server, opts.collect === true ? start : { ...start, ...opts.collect });
    if (opts.browser) {
      site.browser = await launchTestBrowser(site.server);
      site.tab = await site.browser.context.newPage();
    }
  });
  afterAll(async () => {
    await site.browser?.close();
    await site.server?.close();
    dir?.cleanup();
  });
  return site as SiteUnderTest<C, B>;
}

export function page(body: string, head = ''): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Beispiel GmbH</title>${head}</head><body>${body}</body></html>`;
}

/** Text of policy length for synthetic legal pages. */
export const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';

/** The footer of most synthetic pages: links to both legal documents. */
export const FOOTER =
  '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>';

/** A whole page with `title`, in German unless `lang` says otherwise; `head` goes after the title. */
export function html(title: string, body: string, { lang = 'de', head = '' } = {}): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

export type Res = Parameters<DynamicHandler['handle']>[1];
/** The answer of a synthetic host for one path. */
export type Route = (res: Res) => void;

export const send =
  (body: string | Buffer, status = 200, type = 'text/html; charset=utf-8'): Route =>
  (res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

export const redirect =
  (to: string): Route =>
  (res) => {
    res.writeHead(302, { location: to });
    res.end();
  };

/** Routes of one synthetic host by path; every other path answers 404 (so a fallback probe finds nothing). */
export function site(host: string, routes: Record<string, Route>): DynamicHandler {
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
