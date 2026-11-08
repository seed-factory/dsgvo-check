/**
 * The page chooses cookie paths, can edit the in-page logs of cookie and storage writes and can make its storage read
 * name another origin. The jar keeps plain paths, ignores log entries that are not what the hook writes and records
 * the origin of the frame as Node sees it. Markers start with `zq8`.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { JarTracker, mapCookie } from '../../../../../src/collectors/browser/recording/jar.ts';
import { storedCookieName } from '../../../../../src/core/redaction/headers.ts';
import { storedKey } from '../../../../../src/core/redaction/page-names.ts';
import { loadServiceCatalog } from '../../../../../src/derive/catalog.ts';
import { fakeContext, jarCookie, jarOf, moment, recorded, START, target } from '../fakes.ts';

/** Random base62 ids of 13 to 19 characters with two digits and both cases: longer than a site id, shorter than the ids the name rule masks. */
function baseIds(count: number, seed = 20261108): string[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = seed;
  const next = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % n;
  };
  const ids: string[] = [];
  while (ids.length < count) {
    const id = Array.from({ length: 13 + next(7) }, () => alphabet[next(alphabet.length)]!).join('');
    if ((id.match(/\d/g) ?? []).length >= 2 && /[a-z]/.test(id) && /[A-Z]/.test(id)) ids.push(id);
  }
  return ids;
}

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

  it('a storage key that carries an address or a query is stored without them', async () => {
    const key = 'alice@example.test?sid=4f3a9c1d2e7b4a9f';
    const storage = await read(
      storagePage(START, {
        origin: 'https://www.example.de',
        local: [{ key, length: 1 }],
        session: [{ key, length: 1 }],
        idb: [key],
      }),
    );
    expect(storage.map((s) => s.key)).toEqual(Array(3).fill('[redacted]@example.test?[redacted]'));
  });

  // An id inside a key is masked, but the literal parts stay, so the service catalog still matches `rc::*` and
  // `amplitude_unsent_*`.
  it.each([
    ['_gcl_ls', 'www.example.de', '_gcl_ls'],
    ['_uetsid', 'www.example.de', '_uetsid'],
    ['id5id', 'www.example.de', 'id5id'],
    ['_cb', 'www.example.de', '_cb'],
    ['YtIdbMeta', 'www.youtube.com', 'YtIdbMeta'],
    ['yt-remote-device-id', 'www.youtube.com', 'yt-remote-device-id'],
    ['ytidb::LAST_RESULT_ENTRY_KEY', 'www.youtube.com', 'ytidb::LAST_RESULT_ENTRY_KEY'],
    ['rc::a', 'www.google.com', 'rc::a'],
    ['rc::4f3a9c1d2e7b4a9f4f3a9c1d', 'www.google.com', 'rc::[redacted]'],
    ['amplitude_unsent_4f3a9c1d2e7b4a9f', 'www.example.de', 'amplitude_unsent_[redacted]'],
    ['firebase:host:proj.firebaseio.com', 'www.example.de', 'firebase:host:proj.firebaseio.com'],
    ['_hjid', 'www.example.de', '_hjid'],
    ['ajs_user_id', 'www.example.de', 'ajs_user_id'],
  ])('the key %s of %s is stored as %s and still matches its service', async (key, host, stored) => {
    const catalog = loadServiceCatalog();
    const before = catalog.matchStorage(key, host)?.service.id ?? null;
    const storage = await read(
      storagePage(`https://${host}/`, {
        origin: `https://${host}`,
        local: [{ key, length: 1 }],
        session: [],
        idb: [],
      }),
    );
    expect(storage.map((s) => s.key)).toEqual([stored]);
    expect(catalog.matchStorage(storage[0]!.key, host)?.service.id ?? null).toBe(before);
  });

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

    expect(values).toEqual({ cookies: ['zq8c'], storage: ['zq8stored'] });
    expect(jar.cookies).toEqual([]);
    expect(jar.storage).toEqual([]);
  });
});

describe('names of cookies and storage keys: one rule, the raw name stays the key in memory', () => {
  it.each([
    ['an address and a query', 'cart_alice@example.test?sid=4f3a9c1d2e7b4a9f', '[redacted]'],
    ['a local part without a domain', 'alice@intranet', '[redacted]'],
    ['an obfuscated local part', 'alice(at)intranet', '[redacted]'],
    ['an encoded address', 'alice%40example.test', '[redacted]'],
    ['a name with a blank', 'a b', '[redacted]'],
    ['a UUID', 'session_123e4567_e89b_12d3_a456_426614174000', 'session_[redacted]'],
    ['an id of ten digits', 'user_1234567890', 'user_[redacted]'],
    ['an id in hex groups', 'uid_4f3a-9c1d-2e7b-4a9f', 'uid_[redacted]'],
    [
      'an id after a word',
      'optimizely_data$$oeu1612345678901r0$$session_state',
      'optimizely_data$$oeu[redacted]$$session_state',
    ],
    ['counterexample: a site id of seven digits', '_hjSessionUser_1234567', '_hjSessionUser_1234567'],
    ['counterexample: a property id', '_ga_ABCD1234EF', '_ga_ABCD1234EF'],
    ['a name with an @ before digits', 'pkg@3.7.1', '[redacted]'],
    [
      'counterexample: an encoded @ before a name',
      'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
      'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
    ],
  ])('a cookie name: %s', (_case, raw, expected) => {
    expect(storedCookieName(raw)).toBe(expected);
  });

  it('a jar cookie and an attempted cookie are stored through it, the jar matches by the raw name', async () => {
    const raw = 'cart_alice@example.test?sid=4f3a9c1d2e7b4a9f';
    const rec = mapCookie(jarCookie(raw, 'www.example.de'), moment, target, 0, { setter: 'unknown' });
    expect(rec.name).toBe('[redacted]');

    const jar = await jarOf(
      [{ url: START }],
      [
        jarCookie('uid_oeu1612345678901', 'www.example.de'),
        jarCookie('uid_oeu1612345678902', 'www.example.de'),
      ],
    );
    expect(jar.cookies.map((c) => c.name)).toEqual(['uid_oeu[redacted]', 'uid_oeu[redacted]']);
  });

  it('a name the hook logged up to the limit of its read is seen whole: an address at 190 characters goes', async () => {
    const name = `${'x'.repeat(190)}alice@example.test`;
    const jar = await jarOf([
      {
        url: START,
        cookieWrites: [
          { name, t: Date.now(), script: null, deletion: false, host: 'www.example.de', domain: null },
        ],
      },
    ]);
    jar.finalize(moment);
    expect(attempted(jar).map((c) => c.name)).toEqual(['[redacted]']);

    const cut = await jarOf([
      {
        url: START,
        cookieWrites: [
          {
            name: name.slice(0, 200),
            t: Date.now(),
            script: null,
            deletion: false,
            host: 'www.example.de',
            domain: null,
          },
        ],
      },
    ]);
    cut.finalize(moment);
    expect(JSON.stringify(cut.cookies)).not.toContain('alice');
  });

  it('a short random id behind a vendor prefix keeps the class of the name', () => {
    const catalog = loadServiceCatalog();
    const lost: string[] = [];
    for (const id of baseIds(2000)) {
      for (const prefix of ['ucData_', '_hjSession_', '_ga_', 'id_', 'cs_']) {
        const raw = `${prefix}${id}`;
        for (const store of [storedKey, storedCookieName]) {
          const kept = store(raw);
          const class_ = (n: string) =>
            [
              catalog.matchCookie(n, null)?.service.id,
              catalog.matchStorage(n, null)?.service.id,
              catalog.allowlistedCookie(n),
              catalog.allowlistedStorage(n),
            ].join('|');
          if (class_(raw) !== class_(kept)) lost.push(`${raw} -> ${kept}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it('name patterns retain recognition after storage', () => {
    const catalog = loadServiceCatalog();
    const fills = [
      '1234567',
      '4f3a9c1d',
      'abc',
      '4f3a9c1d2e7b4a9f4f3a9c1d',
      'ABCD1234EF',
      '123_456789',
      'x47472',
    ];
    const separated = baseIds(40, 7);
    const pools = [
      'Typo3Live443',
      'App01Prod443',
      'Exchange2016OWA443',
      'WWW2Pool443',
      'IIS10Web443',
      'Shop1Pool443',
    ];
    const real = [
      '_hjSessionUser_1234567',
      '__cmpconsentx47472',
      'TS01dc4fc6',
      'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
      '_ga_ABCD1234EF',
      'incap_ses_123_456789',
    ];
    // A prefix that ends in a digit (`TS01*`) joins the digits of the id, so a long hex id there is one run with it.
    const samples = (pattern: string): string[] => {
      const [name = ''] = pattern.split('@');
      const joined = /\d$/.test(name.slice(0, Math.max(name.indexOf('*'), 0)));
      const directlySeparated = /^(?:ucData_|_hjSession_|_ga_)\*$/.test(name);
      const own = [
        ...fills,
        ...(name.startsWith('BIGipServer') ? pools : []),
        ...(directlySeparated ? separated : []),
      ];
      return own.filter((f) => !joined || f.length <= 12).map((f) => name.replaceAll('*', f));
    };
    const lost: string[] = [];
    const check = (
      what: string,
      names: readonly string[],
      store: (n: string) => string,
      read: (n: string) => string | null,
    ) => {
      for (const raw of names) {
        const kept = store(raw);
        if (read(raw) !== read(kept)) lost.push(`${what}: ${raw} -> ${kept}`);
      }
    };
    for (const s of catalog.data.services) {
      for (const pattern of [...s.cookies, ...s.otherCookies]) {
        const domain = pattern.split('@')[1] ?? null;
        check(
          'cookie',
          samples(pattern),
          storedCookieName,
          (n) => catalog.matchCookie(n, domain)?.service.id ?? null,
        );
      }
      for (const pattern of [...s.storageKeys, ...s.otherStorageKeys]) {
        const domain = pattern.split('@')[1] ?? null;
        check(
          'storage',
          samples(pattern),
          storedKey,
          (n) => catalog.matchStorage(n, domain)?.service.id ?? null,
        );
      }
    }
    for (const list of Object.values(catalog.data.allowlist.cookies))
      for (const pattern of list)
        check('allowlist cookie', samples(pattern), storedCookieName, (n) => catalog.allowlistedCookie(n));
    for (const list of Object.values(catalog.data.allowlist.storage))
      for (const pattern of list)
        check('allowlist storage', samples(pattern), storedKey, (n) => catalog.allowlistedStorage(n));
    check(
      'real cookie',
      real,
      storedCookieName,
      (n) => catalog.matchCookie(n, null)?.service.id ?? catalog.allowlistedCookie(n),
    );
    check(
      'real key',
      real,
      storedKey,
      (n) => catalog.matchStorage(n, null)?.service.id ?? catalog.allowlistedStorage(n),
    );
    expect(lost).toEqual([]);
    expect(storedCookieName('_hjSessionUser_1234567')).toBe('_hjSessionUser_1234567');
  });
});
