/**
 * (5.3): `sanitizeUrl` also redacts identifiers in the PATH. Ad syncs and Floodlight tags carry them in matrix
 * parameters (`/activity;dc_pre=…;ord=…`) and in `prefix:k=v&k=v` segments; a few sites put e-mail addresses (or a
 * whole `mailto:` link of a web archive) into path segments. Path segments without `=` and `@` stay as they are.
 */
import { describe, expect, it } from 'vitest';
import { QUERY_ALLOWLIST, REDACTED, sanitizeUrl } from '../../../src/core/url.ts';

const MARK = 'zq7marker';

describe('sanitizeUrl: matrix parameters of the path', () => {
  it.each([
    [
      `https://ad.doubleclick.net/activityi;src=1234567;type=${MARK};cat=${MARK};dc_pre=${MARK};ord=${MARK}`,
      `https://ad.doubleclick.net/activityi;src=${REDACTED};type=${REDACTED};cat=${REDACTED};dc_pre=${REDACTED};ord=${REDACTED}`,
    ],
    [
      // the first part of a segment can itself be a parameter
      `https://ad.doubleclick.net/ddm/activity/src=1234567;type=${MARK};ord=${MARK}`,
      `https://ad.doubleclick.net/ddm/activity/src=${REDACTED};type=${REDACTED};ord=${REDACTED}`,
    ],
    [
      `https://ad.doubleclick.net/ddm/trackclk/N1.2/B3;dc_trk_aid=${MARK};dc_dbm_token=${MARK}`,
      `https://ad.doubleclick.net/ddm/trackclk/N1.2/B3;dc_trk_aid=${REDACTED};dc_dbm_token=${REDACTED}`,
    ],
    [
      // session ids in the path
      `https://shop.example.test/warenkorb;jsessionid=${MARK}`,
      `https://shop.example.test/warenkorb;jsessionid=${REDACTED}`,
    ],
    [
      // allowlisted names keep their value only in the expected form (QUERY_VALUE_RULES)
      `https://cdn.example.test/lib;v=2.1.0;cid=${MARK}`,
      `https://cdn.example.test/lib;v=2.1.0;cid=${REDACTED}`,
    ],
    [`https://cdn.example.test/lib;v=${MARK}`, `https://cdn.example.test/lib;v=${REDACTED}`],
    [
      // an empty value is replaced too (nothing to learn from it, and the form stays stable)
      'https://ad.example.test/activity;dc_lat=;ord=1',
      `https://ad.example.test/activity;dc_lat=${REDACTED};ord=${REDACTED}`,
    ],
    [
      // a value that contains "="
      `https://ad.example.test/activity;token=${MARK}==`,
      `https://ad.example.test/activity;token=${REDACTED}`,
    ],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it.each([
    [
      `https://dpm.demdex.net/ibs:dpid=${MARK}&dpuuid=${MARK}`,
      `https://dpm.demdex.net/ibs:dpid=${REDACTED}&dpuuid=${REDACTED}`,
    ],
    [
      `https://dpm.demdex.net/ibs:dpid=1&dpuuid=${MARK}&redir=https%3A%2F%2Fexample.test%2F`,
      `https://dpm.demdex.net/ibs:dpid=${REDACTED}&dpuuid=${REDACTED}&redir=${REDACTED}`,
    ],
    [
      // in a prefix segment every value is replaced, also names that are allowlisted in the query
      `https://sync.example.test/pixel:id=G-ABC123&v=2`,
      `https://sync.example.test/pixel:id=${REDACTED}&v=${REDACTED}`,
    ],
  ])('prefix segment %s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it('works together with query redaction and drops credentials and the fragment', () => {
    expect(sanitizeUrl(`https://u:p@ad.example.test/activity;dc_pre=${MARK}?gcs=G111&cid=${MARK}#frag`)).toBe(
      `https://ad.example.test/activity;dc_pre=${REDACTED}?gcs=G111&cid=${REDACTED}`,
    );
  });

  it.each([
    'https://www.example.test/',
    'https://www.example.test/a/b/c.html',
    'https://de.wikipedia.example/wiki/Kategorie:Datenschutz',
    'https://www.example.test/a;b/c',
    'https://www.example.test/%C3%BCber-uns/',
    'https://medium.example.test/@autor/beitrag-123',
    'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
    'https://www.example.test/img/logo@2x.png',
    'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
  ])('leaves %s unchanged (no "=" and no address in the path)', (url) => {
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('is idempotent', () => {
    for (const url of [
      `https://ad.doubleclick.net/activityi;src=1;dc_pre=${MARK}?x=${MARK}`,
      `https://dpm.demdex.net/ibs:dpid=1&dpuuid=${MARK}`,
      'https://www.lidl.example/c/impressum/shop@example.test',
      'https://web.archive.example/web/20240329064148/mailto:info@example.test',
    ]) {
      const once = sanitizeUrl(url);
      expect(sanitizeUrl(once)).toBe(once);
    }
  });

  it('uses the allowlist it is given for matrix names too', () => {
    const url = `https://ad.example.test/activity;ev=Purchase;ord=${MARK}`;
    expect(sanitizeUrl(url, QUERY_ALLOWLIST)).toBe(
      `https://ad.example.test/activity;ev=Purchase;ord=${REDACTED}`,
    );
    expect(sanitizeUrl(url, new Set())).toBe(
      `https://ad.example.test/activity;ev=${REDACTED};ord=${REDACTED}`,
    );
  });
});

describe('sanitizeUrl: e-mail addresses in the path', () => {
  it.each([
    [
      'https://www.lidl.example/c/impressum/shop@example.test',
      `https://www.lidl.example/c/impressum/${REDACTED}@example.test`,
    ],
    [
      'https://www.example.test/datenschutz/Kundenservice@Example.test',
      `https://www.example.test/datenschutz/${REDACTED}@example.test`,
    ],
    [
      'https://www.example.test/crawl-request@example.test',
      `https://www.example.test/${REDACTED}@example.test`,
    ],
    [
      // percent-encoded "@"
      'https://www.example.test/kontakt/info%40example.test',
      `https://www.example.test/kontakt/${REDACTED}@example.test`,
    ],
    [
      // a whole mailto: link of a web archive
      'https://web.archive.example/web/20240329064148/mailto:info@example.test',
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    ],
    [
      'https://web.archive.example/web/20240329064148/mailto%3Ainfo%40example.test',
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    ],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/\b(?:shop|kundenservice|info|crawl-request)@/i);
  });

  it('masks addresses in a URL that does not parse', () => {
    expect(sanitizeUrl('https://exa mple.test/info@example.test?x=1')).not.toContain('info@');
  });

  it('keeps the existing mailto: behaviour', () => {
    expect(sanitizeUrl('MAILTO:Alice.Smith@Example.de?subject=Hi&cc=bob@other.de')).toBe(
      `mailto:${REDACTED}@example.de`,
    );
    expect(sanitizeUrl('mailto:a@x.de,b@y.de')).toBe(`mailto:${REDACTED}@x.de,${REDACTED}@y.de`);
  });
});

describe('sanitizeUrl: encoded "=" and ";" in a path segment', () => {
  it.each([
    [
      // matrix parameter next to an address, both separators encoded
      `https://x.test/r/max@example.test%3Bord%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // only "=" encoded
      `https://x.test/r/max@example.test;ord%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // an encoded "=" and an encoded "?" after the address
      `https://x.test/r/max@example.test%3Fq%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test%3Fq=${REDACTED}`,
    ],
    [
      // lower-case hex digits
      `https://x.test/r/max@example.test%3bord%3d${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // no address: the parameter rule alone
      `https://ad.example.test/activity%3Bdc_pre%3D${MARK}%3Bord%3D${MARK}`,
      `https://ad.example.test/activity;dc_pre=${REDACTED};ord=${REDACTED}`,
    ],
    [`https://x.test/session%3Bjsessionid%3D${MARK}`, `https://x.test/session;jsessionid=${REDACTED}`],
    [
      // a segment that starts with a parameter
      `https://x.test/k%3D${MARK}`,
      `https://x.test/k=${REDACTED}`,
    ],
    [
      // an allowlisted name keeps a value of the expected form, also when the separators are encoded
      `https://cdn.example.test/lib%3Bv%3D2.1.0%3Bcid%3D${MARK}`,
      `https://cdn.example.test/lib;v=2.1.0;cid=${REDACTED}`,
    ],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('12345');
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('does not leak the value of an encoded matrix parameter next to an address', () => {
    const out = sanitizeUrl('https://x.test/r/max@example.test%3Bord%3D12345');
    expect(out).not.toContain('12345');
    expect(out).not.toContain('max@');
  });
});

describe('sanitizeUrl: encoded separators without a parameter stay as written', () => {
  it.each([
    'https://de.wikipedia.example/wiki/Kategorie%3ADatenschutz',
    'https://x.test/a%3Bb/c%26d',
    'https://x.test/%C3%BCber%2Funs/',
    'https://x.test/a%2Fb/info%40',
  ])('%s', (url) => {
    expect(sanitizeUrl(url)).toBe(url);
  });
});

describe('sanitizeUrl: an address in a segment does not change the structure of the path', () => {
  const segments = (url: string) => new URL(url).pathname.split('/').length;

  it.each([
    ['https://x.test/a%2Fb@example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
    ['https://x.test/a%2fb@example.test', `https://x.test/a%2F${REDACTED}@example.test`],
    ['https://x.test/a%5Cb@example.test/c', `https://x.test/a%5C${REDACTED}@example.test/c`],
    ['https://x.test/a%2Fb%40example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(segments(out)).toBe(segments(input));
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('keeps the other escapes of the segment readable and stable', () => {
    const out = sanitizeUrl('https://x.test/%C3%BCber/m%C3%BCller@example.test/100%25');
    expect(out).toBe(`https://x.test/%C3%BCber/${REDACTED}@example.test/100%25`);
    expect(sanitizeUrl(out)).toBe(out);
  });
});

describe('sanitizeUrl: idempotent on encoded separators', () => {
  const pieces = [
    'a',
    'max',
    '@',
    'example.test',
    'k',
    'v',
    '1',
    '/',
    '=',
    ';',
    '&',
    ':',
    '\\',
    '%3D',
    '%3d',
    '%3B',
    '%3b',
    '%26',
    '%3A',
    '%3F',
    '%2F',
    '%5C',
    '%40',
    '%25',
    '%23',
    '%0A',
    '%C3%BC',
  ];

  // mulberry32: the same sequence on every run, no extra dependency
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('over combinations of the pieces in one path segment and in two', () => {
    const rnd = random(20261030);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)];
    for (let i = 0; i < 20_000; i++) {
      const segment = () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, pick).join('');
      const url = `https://x.test/${segment()}${rnd() < 0.3 ? `/${segment()}` : ''}`;
      const once = sanitizeUrl(url);
      expect(sanitizeUrl(once), `${url} -> ${once}`).toBe(once);
    }
  });
});
