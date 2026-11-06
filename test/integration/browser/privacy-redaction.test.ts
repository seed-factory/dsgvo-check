/**
 * The real browser collector writes no e-mail local part, no query value inside link text or accessible names, no
 * identifier from matrix or `prefix:k=v` path segments and no comment of a product header into the snapshot. Markers
 * start with `zq7`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { type CollectRun, collect, persisted } from './helpers.ts';
import { page, type SiteDir, writeSite } from './site-dir.ts';

const INDEX = page(`
  <nav><a id="mail" href="mailto:zq7local@example.test?subject=zq7subject">zq7local@example.test</a></nav>
  <main>
    <h1>Willkommen</h1>
    <a id="aria" href="/kontakt/" aria-label="Schreiben Sie an zq7aria@example.test">Kontakt</a>
    <a id="archive" href="https://web.archive.example/web/20240329064148/mailto:zq7archive@example.test">Archiv</a>
    <a id="urltext" href="https://www.example.test/formular?pid=zq7pid&pn=zq7pn">https://www.example.test/formular?pid=zq7pid&pn=zq7pn</a>
    <a id="pathmail" href="/c/impressum/zq7path@example.test">Impressum (zq7text@example.test)</a>
    <img src="https://ad.doubleclick.net/activityi;src=1234567;type=zq7type;dc_pre=zq7pre;ord=zq7ord" alt="" width="1" height="1">
    <img src="https://dpm.demdex.net/ibs:dpid=1234&dpuuid=zq7uuid" alt="" width="1" height="1">
  </main>
  <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutz</a></footer>`);

let server: FixtureServer;
let site: SiteDir;
let run: CollectRun;

beforeAll(async () => {
  site = writeSite({ 'index.html': INDEX });
  server = await startFixtureServer({
    hosts: { 'www.example.test': site.root },
    routes: [
      {
        host: 'www.example.test',
        path: '/',
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-powered-by': 'PHP/7.2.34',
          server: 'Apache/2.4.41 (Ubuntu; zq7web01.internal.example.test)',
        },
        body: INDEX,
      },
      {
        host: 'ad.doubleclick.net',
        path: '^/activityi',
        pathRegex: true,
        headers: { 'content-type': 'image/gif' },
      },
      { host: 'dpm.demdex.net', path: '^/ibs:', pathRegex: true, headers: { 'content-type': 'image/gif' } },
    ],
  });
  run = await collect(server, { maxPages: 1 });
});

afterAll(async () => {
  await server?.close();
  site?.cleanup();
});

const links = () => run.result.sections.browser?.phases[0]?.pages[0]?.dom?.links ?? [];

describe('free text in the snapshot', () => {
  it('masks the address in the text and the accessible name of a mailto link; the href stays out of the snapshot', () => {
    const mail = links().find((l) => l.hrefKind === 'mailto');
    expect(mail).toMatchObject({ href: null, text: '[redacted]@example.test' });
  });

  it('masks an address in an aria-label', () => {
    const aria = links().find((l) => l.href?.endsWith('/kontakt/'));
    expect(aria?.accessibleName).toBe('Schreiben Sie an [redacted]@example.test');
  });

  it('masks an address in the path of a link, also when it is a whole mailto: of a web archive', () => {
    const hrefs = links().map((l) => l.href);
    expect(hrefs).toContain('https://web.archive.example/web/20240329064148/mailto:[redacted]@example.test');
    expect(hrefs).toContain('https://www.example.test/c/impressum/[redacted]@example.test');
    expect(links().find((l) => l.href?.includes('/c/impressum/'))?.text).toBe(
      'Impressum ([redacted]@example.test)',
    );
  });

  it('redacts query values inside the text of a link', () => {
    const l = links().find((x) => x.href?.includes('/formular'));
    expect(l?.href).toBe('https://www.example.test/formular?pid=[redacted]&pn=[redacted]');
    expect(l?.text).toBe('https://www.example.test/formular?pid=[redacted]&pn=[redacted]');
  });

  it('keeps domains and service hosts, so that the matching of documents and services does not change', () => {
    expect(links().find((l) => l.href === 'https://www.example.test/impressum/')?.text).toBe('Impressum');
    expect(persisted(run)).toContain('@example.test');
  });
});

describe('identifiers in the path of request URLs', () => {
  it('redacts matrix parameters of a Floodlight-style URL', () => {
    const r = run.requests.find((x) => x.host === 'ad.doubleclick.net');
    expect(r?.url).toBe(
      'https://ad.doubleclick.net/activityi;src=[redacted];type=[redacted];dc_pre=[redacted];ord=[redacted]',
    );
  });

  it('redacts the values of a prefix:k=v&k=v segment', () => {
    const r = run.requests.find((x) => x.host === 'dpm.demdex.net');
    expect(r?.url).toBe('https://dpm.demdex.net/ibs:dpid=[redacted]&dpuuid=[redacted]');
  });
});

describe('headers that name the server software', () => {
  it('the main document keeps product and version next to the redacted value, as the HTTP collector does', () => {
    const headers = run.result.sections.browser?.phases[0]?.pages[0]?.responseHeaders ?? [];
    expect(
      headers
        .filter((h) => h.name === 'server' || h.name === 'x-powered-by')
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'server', value: '[redacted]', productVersions: [{ product: 'Apache', version: '2.4.41' }] },
      { name: 'x-powered-by', value: '[redacted]', productVersions: [{ product: 'PHP', version: '7.2.34' }] },
    ]);
    expect(persisted(run)).not.toContain('Ubuntu');
  });
});

describe('nothing from the markers is persisted', () => {
  it('no local part, query value or path identifier anywhere in the collector result', () => {
    expect(persisted(run)).not.toContain('zq7');
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
