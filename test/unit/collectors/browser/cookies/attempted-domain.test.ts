/**
 * The domain of an `attempted` script cookie (no browser): the Domain= attribute or the host of the frame's DOCUMENT,
 * never the script host, inherited by `about:blank`/`srcdoc` frames; `firstParty` is judged against the target.
 */
import { describe, expect, it } from 'vitest';
import type { JarTracker } from '../../../../../src/collectors/browser/recording/jar.ts';
import { jarCookie, jarOf, moment, recorded, START } from '../fakes.ts';

const attempted = (jar: JarTracker) => jar.cookies.filter((c) => c.state === 'attempted');
const WIDGET = 'https://widget.tracker-b.test/frame.html';

async function finalized(...args: Parameters<typeof jarOf>) {
  const jar = await jarOf(...args);
  jar.finalize(moment);
  return jar;
}

describe('JarTracker: domain of an attempted script cookie', () => {
  const write = (o: Record<string, unknown> = {}) => ({
    name: '_probe',
    t: Date.now(),
    script: 'https://cdn.tracker-a.test/t.js?account=SECRET_ACCOUNT',
    deletion: false,
    ...o,
  });

  it.each([
    ['first-party page', START, {}, 'www.example.de', true],
    ['third-party frame', WIDGET, {}, 'widget.tracker-b.test', false],
    ['explicit Domain=', START, { domain: 'example.de', host: 'www.example.de' }, 'example.de', true],
  ] as const)(
    'attributes an attempted script cookie by its document: %s',
    async (_name, url, attrs, domain, firstParty) => {
      const jar = await finalized([{ url, cookieWrites: [write(attrs)] }]);
      expect(attempted(jar)).toMatchObject([
        { name: '_probe', domain, firstParty, setter: 'script', setterHost: 'cdn.tracker-a.test' },
      ]);
      expect(JSON.stringify(jar.cookies)).not.toContain('SECRET_ACCOUNT');
    },
  );

  it('the same name written in two frames gives two records, one per domain', async () => {
    const jar = await finalized([
      { url: START, cookieWrites: [write()] },
      { url: WIDGET, cookieWrites: [write()] },
    ]);
    expect(attempted(jar).map((c) => [c.domain, c.firstParty])).toEqual([
      ['www.example.de', true],
      ['widget.tracker-b.test', false],
    ]);
  });

  it('a jar cookie of another domain with the same name does not hide the attempted record', async () => {
    const jar = await finalized(
      [{ url: START, cookieWrites: [write()] }],
      [jarCookie('_probe', 'tracker-z.test')],
    );
    expect(attempted(jar).map((c) => c.domain)).toEqual(['www.example.de']);
  });

  it('the host of an attempted Set-Cookie response is its domain unless Domain= says otherwise', async () => {
    const rec = await recorded([
      ['https://tracker-a.test/p.gif', ['h=1; Path=/']],
      ['https://gum.tracker-b.test/p.gif', ['d=1; Domain=tracker-b.test; Path=/']],
    ]);
    const jar = await finalized([{ url: START }], [], rec.setCookieOrigins);
    expect(attempted(jar).map((c) => [c.name, c.domain, c.setterHost, c.firstParty])).toEqual([
      ['h', 'tracker-a.test', 'tracker-a.test', false],
      ['d', 'tracker-b.test', 'gum.tracker-b.test', false],
    ]);
  });
});

describe('JarTracker: a script write from an about:blank or srcdoc frame', () => {
  const blankWrite = (o: Record<string, unknown> = {}) => ({
    name: 'ab_test',
    t: Date.now(),
    script: 'https://cdn.vendor.test/t.js?account=SECRET_ACCOUNT',
    deletion: false,
    host: null,
    domain: null,
    ...o,
  });
  const inJar = [jarCookie('ab_test', 'www.example.de')];

  it.each(['about:blank', 'about:srcdoc'])(
    '%s frame of the target: the cookie in the jar is accepted with the script as its setter, no attempted record',
    async (url) => {
      const jar = await finalized([{ url: START }, { url, parent: 0, cookieWrites: [blankWrite()] }], inJar);
      expect(jar.cookies.map((c) => [c.name, c.state, c.domain, c.setter, c.setterHost])).toEqual([
        ['ab_test', 'accepted', 'www.example.de', 'script', 'cdn.vendor.test'],
      ]);
      expect(JSON.stringify(jar.cookies)).not.toContain('SECRET_ACCOUNT');
    },
  );

  it('an about:blank frame inside an about:blank frame inherits through the chain', async () => {
    const frames = [
      { url: START },
      { url: 'about:blank', parent: 0 },
      { url: 'about:blank', parent: 1, cookieWrites: [blankWrite()] },
    ];
    const jar = await finalized(frames, inJar);
    expect(jar.cookies.map((c) => [c.state, c.setter])).toEqual([['accepted', 'script']]);
  });

  it('a write that never reached the jar is attempted for the host of the inherited document', async () => {
    const frames = [{ url: START }, { url: 'about:blank', parent: 0, cookieWrites: [blankWrite()] }];
    const jar = await finalized(frames);
    expect(jar.cookies.map((c) => [c.state, c.domain, c.firstParty, c.setterHost])).toEqual([
      ['attempted', 'www.example.de', true, 'cdn.vendor.test'],
    ]);
  });

  it('counterexample: an about:blank frame inside a third-party frame cannot set a first-party cookie', async () => {
    const frames = [
      { url: START },
      { url: WIDGET, parent: 0 },
      { url: 'about:blank', parent: 1, cookieWrites: [blankWrite()] },
    ];
    const jar = await finalized(frames, inJar);
    expect(jar.cookies.map((c) => [c.state, c.domain, c.setter])).toEqual([
      ['accepted', 'www.example.de', 'unknown'],
      ['attempted', 'widget.tracker-b.test', 'script'],
    ]);
  });

  it('counterexample: a frame without any known document host proves nothing → no attempted record', async () => {
    const jar = await finalized([{ url: 'about:blank', cookieWrites: [blankWrite()] }], inJar);
    expect(jar.cookies.map((c) => [c.state, c.setter])).toEqual([['accepted', 'unknown']]);
  });
});
