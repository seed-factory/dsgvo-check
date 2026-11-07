/**
 * Pure tests (no browser): a `Set-Cookie` after the click marks only the cookie it can be (same name, domain, path
 * and partition) as an `afterClick` write; the first writer stays the setter.
 */
import { describe, expect, it } from 'vitest';
import { JarTracker, type Moment } from '../../../../../src/collectors/browser/recording/jar.ts';
import {
  fakeContext,
  fakePage,
  fakeRecorder,
  type JarCookie,
  jarCookie,
  moment,
  START,
  target,
} from './fakes.ts';

describe('JarTracker: a Set-Cookie after the click marks only the cookie it can be', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const post: Moment = { ...moment, phase: 'B', tRef: 'click', afterClick: true, tMs: 500 };

  /** A phase-B recorder that answers one request at a time, like the collector feeds it. */
  const liveRecorder = () => fakeRecorder({ phase: 'B', start: START });

  /** Three same-named cookies (first party, tracker A, tracker B), all set by responses before the click. */
  async function threeUids(extra: Partial<JarCookie> = {}) {
    const { rec, send } = liveRecorder();
    await send('https://www.example.de/a.gif', ['uid=1; Path=/']);
    await send('https://tracker-a.test/p.gif', ['uid=2; Path=/']);
    await send('https://tracker-b.test/p.gif', ['uid=3; Path=/']);

    const jar = new JarTracker(target, rec.setCookieOrigins);
    const context = fakeContext([
      jarCookie('uid', 'www.example.de', extra),
      jarCookie('uid', 'tracker-a.test', extra),
      jarCookie('uid', 'tracker-b.test', extra),
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

  it('one tracker re-sets the cookie after "Ablehnen": only its cookie gets the second, afterClick record', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/']);
    await jar.snapshot(context, page, post);

    expect(flags(jar, 'www.example.de')).toEqual([false]);
    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'tracker-b.test')).toEqual([false, true]);
    expect(JSON.stringify(jar.cookies)).not.toMatch(/SECRET/);
  });

  it('a first-party response after the click marks the first-party cookie only', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://www.example.de/b.gif', ['uid=9; Path=/']);
    await jar.snapshot(context, page, post);

    expect(flags(jar, 'www.example.de')).toEqual([false, true]);
    expect(flags(jar, 'tracker-a.test')).toEqual([false]);
    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

  it('counterexample: the same name with another Path= after the click is another cookie', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/other']);
    await jar.snapshot(context, page, post);

    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

  it('counterexample: a partitioned Set-Cookie after the click is not the unpartitioned cookie', async () => {
    const { send, jar, context, page } = await threeUids();
    await send('https://tracker-b.test/p.gif?x=1', ['uid=4; Path=/; Partitioned']);
    await jar.snapshot(context, page, post);

    expect(flags(jar, 'tracker-b.test')).toEqual([false]);
  });

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
