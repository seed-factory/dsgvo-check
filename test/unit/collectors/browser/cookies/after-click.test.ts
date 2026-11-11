/**
 * Pure tests (no browser): a `Set-Cookie` after the click marks only the cookie it can be (same name, domain, path
 * and partition) as an `afterClick` write; the first writer stays the setter.
 */
import { describe, expect, it } from 'vitest';
import { JarTracker, type Moment } from '../../../../../src/collectors/browser/recording/jar.ts';
import { fakeContext, fakePage, fakeRecorder, jarCookie, moment, START, target } from '../fakes.ts';

describe('JarTracker: a Set-Cookie after the click marks only the cookie it can be', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const post: Moment = { ...moment, phase: 'B', tRef: 'click', afterClick: true, tMs: 500 };

  /** A phase-B recorder that answers one request at a time, like the collector feeds it. */
  const liveRecorder = () => fakeRecorder({ phase: 'B', start: START });

  /** Three same-named cookies (first party, tracker A, tracker B), all set by responses before the click. */
  async function threeUids() {
    const { rec, send } = liveRecorder();
    await send('https://www.example.de/a.gif', ['uid=1; Path=/']);
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await send('https://tracker-b.test/p.gif', ['uid=3; Path=/']);

    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([
      jarCookie('uid', 'www.example.de'),
      jarCookie('uid', 'tracker-a.test'),
      jarCookie('uid', 'tracker-b.test'),
    ]);
    const page = fakePage([{ url: START }]);
    await jar.snapshot(context, page, { ...moment, phase: 'B' });
    await sleep(5);

    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    return { rec, send, jar, context, page };
  }

  const flags = (jar: JarTracker, domain: string) =>
    jar.cookies.filter((c) => c.name === 'uid' && c.domain === domain).map((c) => c.afterClick);

  it.each([
    ['tracker-b', 'https://tracker-b.test/p.gif?x=1', 'uid=4; Path=/', 'tracker-b.test'],
    ['first-party', 'https://www.example.de/b.gif', 'uid=9; Path=/', 'www.example.de'],
    ['another path', 'https://tracker-b.test/p.gif?x=1', 'uid=4; Path=/other', null],
    ['another partition', 'https://tracker-b.test/p.gif?x=1', 'uid=4; Path=/; Partitioned', null],
  ] as const)(
    'a response after reject marks only the matching cookie: %s',
    async (_name, url, header, match) => {
      const { send, jar, context, page } = await threeUids();
      await send(url, [header]);
      await jar.snapshot(context, page, post);

      for (const domain of ['www.example.de', 'tracker-a.test', 'tracker-b.test']) {
        expect(flags(jar, domain), domain).toEqual(domain === match ? [false, true] : [false]);
      }
      expect(JSON.stringify(jar.cookies)).not.toMatch(/SECRET/);
    },
  );

  it('counterexample: a Set-Cookie sent before the click does not make a later snapshot an afterClick write', async () => {
    const { rec, send } = liveRecorder();
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([jarCookie('uid', 'tracker-a.test')]);
    const page = fakePage([{ url: START }]);
    await jar.snapshot(context, page, { ...moment, phase: 'B' });
    await sleep(5);

    rec.markClickAt(performance.now());
    jar.markClick(Date.now());
    await jar.snapshot(context, page, post);

    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
  });

  it('the recorder marks the origin of a key re-sent after the click; the first writer stays the setter', async () => {
    const { rec, send } = liveRecorder();
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await sleep(5);

    rec.markClickAt(performance.now());
    await send('https://tracker-a.test/q.gif', ['uid=3; Path=/']);

    const [origin, ...rest] = [...rec.setCookieOrigins.values()];
    expect(rest).toEqual([]);
    expect(origin).toMatchObject({
      name: 'uid',
      host: 'tracker-a.test',
      url: 'https://tracker-a.test/p.gif',
    });
    expect(origin?.afterClick).toBe(true);
  });
});
