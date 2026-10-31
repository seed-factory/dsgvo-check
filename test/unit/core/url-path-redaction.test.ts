/**
 * L0 (D20, 5.3): `sanitizeUrl` also redacts identifiers in the PATH. Ad syncs and Floodlight tags carry them in matrix
 * parameters (`/activity;dc_pre=…;ord=…`) and in `prefix:k=v&k=v` segments; a few sites put e-mail addresses (or a
 * whole `mailto:` link of a web archive) into path segments. Path segments without `=` and `@` stay as they are.
 */
import { describe, expect, it } from 'vitest';
import { QUERY_ALLOWLIST, REDACTED, sanitizeUrl } from '../../../src/core/url.ts';

const MARK = 'zq7marker';

describe('sanitizeUrl: matrix parameters of the path (G03)', () => {
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

describe('sanitizeUrl: e-mail addresses in the path (G01)', () => {
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
