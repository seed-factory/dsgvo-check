/** Cookies written by blank and srcdoc frames retain the inherited document origin. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { type CollectRun, collect, persisted } from './helpers.ts';

const html = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Beispiel</title></head><body>${body}</body></html>`,
});

// A script of a third-party host writes through the document of a hidden `about:blank` frame it creates.
const BLANK_SCRIPT = [
  "const f = document.createElement('iframe');",
  "f.style.display = 'none';",
  'document.body.appendChild(f);',
  "f.contentWindow.document.cookie = 'ab_blank=SECRET_BLANK_VALUE; path=/; max-age=3600';",
].join('\n');

// An inline script of a `srcdoc` frame (the srcdoc frame is the third-party script's own writer: it loads the script).
const SRCDOC_FRAME = '<script src="https://cdn.vendor.test/srcdoc.js"></script>';
const SRCDOC_SCRIPT = "document.cookie = 'ab_srcdoc=SECRET_SRCDOC_VALUE; path=/; max-age=3600';";

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('cookie written from an about:blank or srcdoc frame', () => {
  let server: FixtureServer;
  let run: CollectRun;

  beforeAll(async () => {
    server = await startFixtureServer({
      routes: [
        {
          host: 'www.example.test',
          path: '/',
          ...html(
            [
              '<main><h1>Blank</h1></main>',
              '<script src="https://cdn.vendor.test/blank.js"></script>',
              `<iframe srcdoc="${attr(SRCDOC_FRAME)}" title="srcdoc"></iframe>`,
            ].join(''),
          ),
        },
        {
          host: 'cdn.vendor.test',
          path: '/blank.js',
          status: 200,
          headers: { 'content-type': 'text/javascript' },
          body: BLANK_SCRIPT,
        },
        {
          host: 'cdn.vendor.test',
          path: '/srcdoc.js',
          status: 200,
          headers: { 'content-type': 'text/javascript' },
          body: SRCDOC_SCRIPT,
        },
      ],
    });
    run = await collect(server, { url: 'https://www.example.test/', maxPages: 1 });
  });

  afterAll(async () => {
    await server?.close();
  });

  const records = (name: string) =>
    (run.result.sections.browser?.phases[0]?.cookies ?? [])
      .filter((c) => c.name === name)
      .map((c) => ({
        state: c.state,
        domain: c.domain,
        firstParty: c.firstParty,
        setter: c.setter,
        setterHost: c.setterHost,
      }));

  const ACCEPTED = {
    state: 'accepted',
    domain: 'www.example.test',
    firstParty: true,
    setter: 'script',
    setterHost: 'cdn.vendor.test',
  };

  it('about:blank frame: exactly one accepted record, attributed to the script, no attempted record', () => {
    expect(records('ab_blank')).toEqual([ACCEPTED]);
  });

  it('srcdoc frame: exactly one accepted record, attributed to the script, no attempted record', () => {
    expect(records('ab_srcdoc')).toEqual([ACCEPTED]);
  });

  it('no cookie value reaches the result', () => {
    expect(persisted(run)).not.toMatch(/SECRET_/);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
