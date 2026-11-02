/**
 * Cookie setters in real Chromium against local hosts.
 * - three origins set a cookie named `uid` (two trackers by `Set-Cookie`, the page by script): each jar record
 * keeps its own setter instead of the first HTTP setter of that name.
 * - a script of a third-party host writes a cookie that never reaches the jar. On the first-party page the record
 * belongs to the target (`firstParty`, domain = target host), inside a third-party frame to the host of that frame;
 * `setterHost` is the script host in both cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { type CollectRun, collect, persisted } from './helpers.ts';

const html = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Beispiel</title></head><body>${body}</body></html>`,
});

const SCRIPT = [
  // Accepted first-party cookie: the page's own jar, written by the third-party script.
  "document.cookie = 'uid=SECRET_FP_VALUE; path=/; max-age=3600';",
  // Written and removed in the same tick: seen only by the write hook.
  "document.cookie = 'tmp_probe=SECRET_TMP_VALUE; path=/';",
  "document.cookie = 'tmp_probe=; path=/; max-age=0';",
].join('\n');

describe('setter attribution of cookies', () => {
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
              '<main><h1>Setter</h1></main>',
              '<script src="https://cdn.tracker-a.test/t.js"></script>',
              '<img src="https://tracker-a.test/pixel.gif" width="1" height="1" alt="">',
              '<img src="https://tracker-b.test/pixel.gif" width="1" height="1" alt="">',
              '<iframe src="https://widget.tracker-c.test/frame.html" title="widget"></iframe>',
            ].join(''),
          ),
        },
        {
          host: 'cdn.tracker-a.test',
          path: '/t.js',
          status: 200,
          headers: { 'content-type': 'text/javascript' },
          body: SCRIPT,
        },
        ...['tracker-a.test', 'tracker-b.test'].map((host) => ({
          host,
          path: '/pixel.gif',
          status: 200,
          headers: {
            'content-type': 'image/gif',
            'set-cookie': ['uid=SECRET_3P_VALUE; Path=/; SameSite=None; Secure; Max-Age=86400'],
          },
          body: '',
        })),
        {
          host: 'widget.tracker-c.test',
          path: '/frame.html',
          ...html('<script src="https://cdn.tracker-a.test/t.js"></script>'),
        },
      ],
    });
    run = await collect(server, { url: 'https://www.example.test/', maxPages: 1 });
  });

  afterAll(async () => {
    await server?.close();
  });

  const cookies = () => run.result.sections.browser?.phases[0]?.cookies ?? [];

  it('every `uid` record keeps its own setter', () => {
    const uid = (domain: string) => cookies().find((c) => c.name === 'uid' && c.domain === domain);
    expect(uid('www.example.test')).toMatchObject({
      state: 'accepted',
      firstParty: true,
      setter: 'script',
      setterHost: 'cdn.tracker-a.test',
    });
    expect(uid('tracker-a.test')).toMatchObject({
      state: 'accepted',
      firstParty: false,
      setter: 'http-response',
      setterHost: 'tracker-a.test',
    });
    expect(uid('tracker-b.test')).toMatchObject({
      state: 'accepted',
      firstParty: false,
      setter: 'http-response',
      setterHost: 'tracker-b.test',
    });
  });

  it('an attempted script cookie belongs to the document of its frame, the script host is only the setter', () => {
    const probes = cookies()
      .filter((c) => c.name === 'tmp_probe')
      .map((c) => ({
        state: c.state,
        domain: c.domain,
        firstParty: c.firstParty,
        setter: c.setter,
        setterHost: c.setterHost,
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
    expect(probes).toEqual([
      {
        state: 'attempted',
        domain: 'widget.tracker-c.test',
        firstParty: false,
        setter: 'script',
        setterHost: 'cdn.tracker-a.test',
      },
      {
        state: 'attempted',
        domain: 'www.example.test',
        firstParty: true,
        setter: 'script',
        setterHost: 'cdn.tracker-a.test',
      },
    ]);
  });

  it('no cookie value reaches the result', () => {
    expect(persisted(run)).not.toMatch(/SECRET_/);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
