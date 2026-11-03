/**
 * (5.3): identifiers in the path are redacted: matrix parameters (`;k=v`) and `prefix:k=v` segments, also when
 * `;` and `=` are percent-encoded or only a deeper round of decoding shows them next to an address.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../../src/core/email.ts';
import { sanitizeUrl } from '../../../src/core/url.ts';
import { D, expectStable, MARK } from './url-redaction-helpers.ts';

describe('matrix parameters and prefix segments of the path', () => {
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
    [
      // the query is redacted next to it
      `https://ad.doubleclick.net/activityi;src=1;dc_pre=${MARK}?x=${MARK}`,
      `https://ad.doubleclick.net/activityi;src=${REDACTED};dc_pre=${REDACTED}?x=${REDACTED}`,
    ],
  ])('%s', (input, expected) => {
    expect(expectStable(input)).toBe(expected);
  });

  it.each([
    [
      `https://dpm.demdex.net/ibs:dpid=${MARK}&dpuuid=${MARK}`,
      `https://dpm.demdex.net/ibs:dpid=${REDACTED}&dpuuid=${REDACTED}`,
    ],
    [
      `https://dpm.demdex.net/ibs:dpid=1&dpuuid=${MARK}`,
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
    expect(expectStable(input)).toBe(expected);
  });

  it('works together with query redaction and drops credentials and the fragment', () => {
    expect(sanitizeUrl(`https://u:p@ad.example.test/activity;dc_pre=${MARK}?gcs=G111&cid=${MARK}#frag`)).toBe(
      `https://ad.example.test/activity;dc_pre=${REDACTED}?gcs=G111&cid=${REDACTED}`,
    );
  });

  it.each([
    [
      // matrix parameter next to an address, both separators encoded
      `https://x.test/r/max@example.test%3Bord%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      'https://x.test/r/max@example.test%3Bord%3D12345',
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
  ])('encoded "=" and ";": %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('12345');
    expect(out).not.toContain('max@');
  });

  // parameter syntax that only a deeper round of decoding shows is read as syntax when an address is near
  it.each([
    [`https://x.test/alice%2540${D}%253Bord%253D123`, `https://x.test/${REDACTED}@${D};ord=${REDACTED}`],
    [`https://x.test/u/user%253Dalice%2540${D}`, `https://x.test/u/user=${REDACTED}`],
    [
      `https://x.test/activity%253Bdc_pre%253Dabc%253Balice%2540${D}`,
      `https://x.test/activity;dc_pre=${REDACTED};${REDACTED}@${D}`,
    ],
    [`https://x.test/a%2526b%253Dc%2540${D}`, `https://x.test/a&b=${REDACTED}`],
    [`https://x.test/p%253Ak%253Dv%2540${D}`, `https://x.test/p:k=${REDACTED}`],
  ])('syntax from a deeper round of decoding: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|ord=123|=abc|=c|=v/);
  });
});
