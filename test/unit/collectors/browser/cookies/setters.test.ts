/**
 * Attribution of cookies to their setters (no browser): a cookie belongs to a `Set-Cookie` response only when name,
 * domain, path and partition match, ambiguity gives `unknown`; values never appear in the result.
 */
import { describe, expect, it } from 'vitest';
import { parseSetCookies } from '../../../../../src/collectors/browser/recording/features.ts';
import { JarTracker } from '../../../../../src/collectors/browser/recording/jar.ts';
import { fakeContext, fakePage, jarCookie, moment, recorded, START, target } from './fakes.ts';

describe('parseSetCookies: attributes without values', () => {
  it('name, Domain, Path and Partitioned; the value never appears in the result', () => {
    const out = parseSetCookies([
      'uid=SECRET_UID; Domain=.Tracker-A.Test; Path=/p; Secure; SameSite=None; Partitioned',
      ' plain = SECRET_PLAIN ; HttpOnly',
      '=bad',
      'novalue',
    ]);
    expect(out).toEqual([
      { name: 'uid', domain: 'tracker-a.test', path: '/p', partitioned: true },
      { name: 'plain', partitioned: false },
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('several cookies in one joined header value (separated by a line break)', () => {
    expect(
      parseSetCookies(['a=1; Path=/x\nb=2; Domain=example.de']).map((c) => [c.name, c.path, c.domain]),
    ).toEqual([
      ['a', '/x', undefined],
      ['b', undefined, 'example.de'],
    ]);
  });
});

describe('NetworkRecorder: Set-Cookie origins are keyed by name, domain, path and partition', () => {
  it('host-only cookie: domain = response host, path = default path of the request URL', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/pixel.gif?x=1', ['uid=S1; Path=/; Secure']],
      ['https://tracker-b.test/a/b/pixel.gif', ['uid=S2; Secure']],
      ['https://cdn.tracker-c.test/p.gif', ['uid=S3; Domain=.tracker-c.test; Partitioned']],
    ]);
    const origins = [...rec.setCookieOrigins.values()];
    expect(origins.map((o) => [o.name, o.host, o.domain, o.path, o.partitioned])).toEqual([
      ['uid', 'tracker-a.test', undefined, '/', false],
      ['uid', 'tracker-b.test', undefined, '/a/b', false],
      ['uid', 'cdn.tracker-c.test', 'tracker-c.test', '/', true],
    ]);
    expect(origins.every((o) => typeof o.at === 'number')).toBe(true);
    expect(JSON.stringify(origins)).not.toMatch(/S1|S2|S3/);
  });

  it('three trackers set the same cookie name: three origins, not one', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/p.gif', ['uid=1']],
      ['https://tracker-b.test/p.gif', ['uid=2']],
      ['https://tracker-a.test/other.gif', ['uid=3']],
    ]);
    // The second response of the same host, name, domain, path and partition keeps the first writer.
    expect(rec.setCookieOrigins.size).toBe(2);
    expect(rec.records.map((r) => r.setCookieNames)).toEqual([['uid'], ['uid'], ['uid']]);
  });
});

describe('JarTracker: the setter of a cookie must be able to set it', () => {
  const writeFrom = (name: string, script: string, o: Record<string, unknown> = {}) => ({
    name,
    t: Date.now(),
    script,
    deletion: false,
    ...o,
  });

  it('same cookie name from three origins: every record keeps its own setter', async () => {
    const rec = await recorded([
      ['https://gum.tracker-a.test/sync.gif', ['uid=A; Domain=tracker-a.test; Path=/']],
      ['https://tracker-b.test/sync.gif', ['uid=B; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const page = fakePage([{ url: START, cookieWrites: [writeFrom('uid', 'https://cdn.script.test/t.js')] }]);
    await jar.snapshot(
      fakeContext([
        jarCookie('uid', '.tracker-a.test'),
        jarCookie('uid', 'www.example.de'),
        jarCookie('uid', 'tracker-b.test'),
      ]),
      page,
      moment,
    );
    const by = (domain: string) => jar.cookies.find((c) => c.name === 'uid' && c.domain === domain);
    expect(by('tracker-a.test')).toMatchObject({ setter: 'http-response', setterHost: 'gum.tracker-a.test' });
    expect(by('tracker-b.test')).toMatchObject({ setter: 'http-response', setterHost: 'tracker-b.test' });
    expect(by('www.example.de')).toMatchObject({
      firstParty: true,
      setter: 'script',
      setterHost: 'cdn.script.test',
    });
  });

  it('a first-party cookie is not attributed to a tracker response of the same name', async () => {
    const rec = await recorded([['https://tracker-a.test/sync.gif', ['cto_bundle=A; Path=/']]]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(
      fakeContext([jarCookie('cto_bundle', 'www.example.de')]),
      fakePage([{ url: START }]),
      moment,
    );
    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
    expect(jar.cookies[0]?.setterHost).toBeUndefined();
  });

  it('path and partition must match too; otherwise the setter is unknown', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/sync.gif', ['a=1; Path=/app']],
      ['https://tracker-a.test/sync.gif', ['b=1; Path=/; Partitioned']],
      ['https://tracker-a.test/sync.gif', ['c=1; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(
      fakeContext([
        jarCookie('a', 'tracker-a.test', { path: '/other' }),
        jarCookie('b', 'tracker-a.test'),
        jarCookie('c', 'tracker-a.test', { partitionKey: 'https://example.de' }),
      ]),
      fakePage([{ url: START }]),
      moment,
    );
    expect(jar.cookies.map((c) => [c.name, c.setter])).toEqual([
      ['a', 'unknown'],
      ['b', 'unknown'],
      ['c', 'unknown'],
    ]);
  });

  it('a script on a tracker document cannot be the setter of a first-party cookie', async () => {
    const jar = new JarTracker(target, new Map());
    const page = fakePage([
      {
        url: 'https://widget.tracker-a.test/frame.html',
        cookieWrites: [writeFrom('sid', 'https://widget.tracker-a.test/w.js')],
      },
    ]);
    await jar.snapshot(fakeContext([jarCookie('sid', 'www.example.de')]), page, moment);
    expect(jar.cookies[0]).toMatchObject({ firstParty: true, setter: 'unknown' });
  });

  it('counterexample: a same-named rejected cookie of another domain does not change the attribution', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/sync.gif', ['uid=A; Path=/']],
      ['https://tracker-c.test/sync.gif', ['uid=C; Path=/']],
    ]);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    await jar.snapshot(fakeContext([jarCookie('uid', 'tracker-a.test')]), fakePage([{ url: START }]), moment);
    jar.finalize(moment);
    const uid = jar.cookies.filter((c) => c.name === 'uid');
    expect(uid.map((c) => [c.state, c.domain, c.setterHost])).toEqual([
      ['accepted', 'tracker-a.test', 'tracker-a.test'],
      ['attempted', 'tracker-c.test', 'tracker-c.test'],
    ]);
  });
});
