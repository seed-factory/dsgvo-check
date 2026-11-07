/**
 * The page chooses cookie paths, can edit the in-page logs of cookie and storage writes and can make its storage read
 * name another origin. The jar keeps plain paths, ignores log entries that are not what the hook writes and records
 * the origin of the frame as Node sees it. Markers start with `zq8`.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker, mapCookie } from '../../../../../src/collectors/browser/recording/jar.ts';
import { fakeContext, jarCookie, jarOf, moment, recorded, START, target } from '../fakes.ts';

const attempted = (jar: JarTracker) => jar.cookies.filter((c) => c.state === 'attempted');

describe('cookie paths', () => {
  it.each([
    ['/', '/'],
    ['/shop', '/shop'],
    ['/?sid=zq8SECRET&mail=alice@example.com', '[redacted]'],
  ])('a jar cookie with path %j is stored with path %j', (path, stored) => {
    const rec = mapCookie(jarCookie('consent', 'www.example.de', { path }), moment, target, 0, {
      setter: 'unknown',
    });
    expect(rec.path).toBe(stored);
  });

  it('two paths that are both redacted stay two cookies', async () => {
    const jar = await jarOf(
      [{ url: START }],
      [
        jarCookie('consent', 'www.example.de', { path: '/?sid=zq8one' }),
        jarCookie('consent', 'www.example.de', { path: '/?sid=zq8two' }),
      ],
    );
    expect(jar.cookies.map((c) => c.path)).toEqual(['[redacted]', '[redacted]']);
  });

  it('a Set-Cookie the browser refused keeps no query of its path; the setter still matches by the raw path', async () => {
    const rec = await recorded([
      ['https://t.tracker-a.test/p.gif', ['t=1; Domain=other.test; Path=/x?uid=zq8SECRET']],
      ['https://www.example.de/a', ['s=1; Path=/x?uid=zq8OTHER']],
    ]);
    const jar = await jarOf(
      [{ url: START }],
      [jarCookie('s', 'www.example.de', { path: '/x?uid=zq8OTHER' })],
      rec.setCookieOrigins,
    );
    jar.finalize(moment);

    expect(attempted(jar).map((c) => [c.name, c.path])).toEqual([['t', '[redacted]']]);
    expect(jar.cookies.find((c) => c.name === 's')).toMatchObject({
      setter: 'http-response',
      path: '[redacted]',
    });
    expect(JSON.stringify(jar.cookies)).not.toContain('zq8');
  });
});

describe('entries of the in-page cookie-write log', () => {
  const write = (o: Record<string, unknown> = {}) => ({
    name: '_probe',
    t: Date.now(),
    script: 'https://cdn.tracker-a.test/t.js',
    deletion: false,
    host: 'www.example.de',
    domain: null,
    ...o,
  });

  it.each([
    ['a domain with a query and an address', { domain: ' ?sid=zq8secret alice@example.com' }],
    ['a host with an address', { host: 'alice@example.com?x=zq8', domain: null }],
    ['a name that carries a value', { name: 'cid=zq84f3a9c1d' }],
    ['a time that is no number', { t: '0x4F3A9C1D2E7B8A9F0C1D' }],
    ['a deletion flag that is no boolean', { deletion: 'zq8' }],
    ['a host that is no string', { host: { zq8: true } }],
  ])('an entry with %s is ignored', async (_what, over) => {
    const jar = await jarOf([{ url: START, cookieWrites: [write(over)] }]);
    jar.finalize(moment);
    expect(attempted(jar)).toEqual([]);
  });

  it('a script that is no http(s) URL is not taken as the setter', async () => {
    const jar = await jarOf([{ url: START, cookieWrites: [write({ script: 'zq8 alice@example.com' })] }]);
    jar.finalize(moment);
    expect(attempted(jar)).toEqual([expect.objectContaining({ name: '_probe', setter: 'script' })]);
    expect(JSON.stringify(jar.cookies)).not.toContain('zq8');
  });

  it('a Domain= the document may not set is not stored: the refused write is attempted on the document host', async () => {
    const jar = await jarOf([
      {
        url: START,
        cookieWrites: [write({ name: 'dd', domain: 'zq8-4f3a9c1d-7a2b-1730291234.example.test' })],
      },
    ]);
    jar.finalize(moment);
    expect(attempted(jar)).toEqual([expect.objectContaining({ name: 'dd', domain: 'www.example.de' })]);
    expect(JSON.stringify(jar.cookies)).not.toMatch(/zq8|4f3a9c1d|1730291234/);
  });

  it('a refused write is no setter, and no attempt when the jar has the name on the document host', async () => {
    const jar = await jarOf(
      [{ url: START, cookieWrites: [write({ name: 'dd', domain: 'tracker-z.test' })] }],
      [jarCookie('dd', 'www.example.de')],
    );
    jar.finalize(moment);
    expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.setter])).toEqual([
      ['dd', 'accepted', 'www.example.de', 'unknown'],
    ]);
  });

  it.each([
    [
      'a host other than the frame',
      'https://www.example.de/',
      { host: 'zq8-4f3a9c1d.example.de', domain: 'zq8-4f3a9c1d.example.de' },
    ],
    [
      'a Domain= in a frame without a host',
      'data:text/html,zq8',
      { host: null, domain: 'zq8-4f3a9c1d.example.de' },
    ],
  ])('an entry with %s gives no record', async (_what, url, over) => {
    const jar = await jarOf([{ url, cookieWrites: [write(over)] }]);
    jar.finalize(moment);
    expect(attempted(jar)).toEqual([]);
  });

  it('counterexample: an entry as the hook writes it gives the attempted cookie of its Domain=', async () => {
    const jar = await jarOf([{ url: START, cookieWrites: [write({ domain: '.example.de' })] }]);
    jar.finalize(moment);
    expect(attempted(jar)).toEqual([
      expect.objectContaining({ name: '_probe', domain: 'example.de', setterHost: 'cdn.tracker-a.test' }),
    ]);
  });
});

describe('Web Storage of a frame', () => {
  /** One frame at `url` whose storage read answers `storage` and whose write log is `writes`. */
  function storagePage(url: string, storage: unknown, writes: unknown = []): Page {
    const frame = {
      url: () => url,
      parentFrame: () => null,
      evaluate: async (fn: { name: string }) =>
        fn.name === 'storageInPage' ? storage : fn.name === 'storageWritesInPage' ? writes : [],
    };
    return { frames: () => [frame], mainFrame: () => frame } as unknown as Page;
  }
  const read = async (page: Page) => {
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(fakeContext([]) as BrowserContext, page, moment);
    return jar.storage;
  };

  it('an answer that names another origin is skipped', async () => {
    const storage = await read(
      storagePage(START, {
        origin: 'https://www.example.de/?sid=zq8SECRET&m=alice@example.com',
        local: [{ key: 'k', length: 1 }],
        session: [],
        idb: [],
      }),
    );
    expect(storage).toEqual([]);
  });

  it('the origin is the frame origin; keys and names only as strings, a length only as a count', async () => {
    const storage = await read(
      storagePage(
        START,
        {
          origin: 'https://www.example.de',
          local: [
            { key: 'consent', length: 12 },
            { key: 'theme', length: 'zq8' },
            { key: { zq8: true }, length: 1 },
          ],
          session: 'zq8',
          idb: ['keyval-store', 42],
        },
        [{ type: 'zq8', key: 'consent', t: 'zq8' }],
      ),
    );
    expect(storage.map((s) => [s.storageType, s.origin, s.key, s.length])).toEqual([
      ['localStorage', 'https://www.example.de', 'consent', 12],
      ['localStorage', 'https://www.example.de', 'theme', undefined],
      ['indexedDB', 'https://www.example.de', 'keyval-store', undefined],
    ]);
    expect(JSON.stringify(storage)).not.toContain('zq8');
  });
});

describe('values for taking them out of page text', () => {
  it('cookie values of the context and storage values of each origin, in memory only', async () => {
    const frame = {
      url: () => START,
      evaluate: async (fn: { name: string }) => (fn.name === 'storageValuesInPage' ? ['zq8stored', 7] : null),
    };
    const page = { frames: () => [frame, frame] } as unknown as Page;
    const jar = new JarTracker(target, new Map());

    const values = await jar.secretValues(
      fakeContext([jarCookie('cid', 'example.de', { value: 'zq8c' })]),
      page,
    );

    expect(values).toEqual(['zq8c', 'zq8stored']);
    expect(jar.cookies).toEqual([]);
    expect(jar.storage).toEqual([]);
  });
});
