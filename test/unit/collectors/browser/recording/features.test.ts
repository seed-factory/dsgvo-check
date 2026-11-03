/** Pure: safe request features are extracted before redaction. */
import { describe, expect, it } from 'vitest';
import {
  extractRequestFeatures,
  sanitizeRequestUrl,
  splitSetCookieNames,
} from '../../../../../src/collectors/browser/recording/features.ts';

describe('extractRequestFeatures', () => {
  it('GA4 hit: cid is an identifier, en is the event, consent signals are kept', () => {
    const f = extractRequestFeatures(
      'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&cid=111.222&en=page_view&gcs=G100&gcd=13l3l3l3l1',
      null,
    );
    expect(f.identifierNames).toEqual(['cid']);
    expect(f.eventType).toBe('page_view');
    expect(f.consentSignals).toEqual({ gcs: 'G100', gcd: '13l3l3l3l1' });
    expect(f.identifierValues).toEqual(['111.222']);
  });

  it('Meta pixel: ev is the event, fbp/_fbp are identifiers', () => {
    const f = extractRequestFeatures(
      'https://www.facebook.com/tr?id=1&ev=PageView&fbp=fb.1.2.3&_fbc=x',
      null,
    );
    expect(f.identifierNames).toEqual(['_fbc', 'fbp']);
    expect(f.eventType).toBe('PageView');
  });

  it('reads identifiers from a GA4 batch body (text/plain lines)', () => {
    const f = extractRequestFeatures(
      'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST',
      'en=scroll&_et=1\nen=click&uid=abc123456',
    );
    expect(f.identifierNames).toEqual(['uid']);
    expect(f.eventType).toBe('scroll');
  });

  it('ignores empty identifier values and non-identifier params', () => {
    const f = extractRequestFeatures('https://example.test/x?cid=&q=hello&page=2', null);
    expect(f.identifierNames).toEqual([]);
    expect(f.eventType).toBeUndefined();
    expect(f.consentSignals).toBeUndefined();
  });

  it('eventType comes from en/ev; `t` only as a UA hit type, never a timestamp or cache buster', () => {
    expect(extractRequestFeatures('https://cdn.example.test/app.js?t=1698765432', null).eventType).toBe(
      undefined,
    );
    expect(extractRequestFeatures('https://example.test/x?t=visitor-secret', null).eventType).toBeUndefined();
    expect(
      extractRequestFeatures('https://www.google-analytics.com/collect?v=1&t=pageview&tid=UA-1-1', null)
        .eventType,
    ).toBe('pageview');
    // A timestamp `t` before the event name does not shadow it.
    expect(
      extractRequestFeatures('https://www.google-analytics.com/g/collect?t=1698765432&en=page_view', null)
        .eventType,
    ).toBe('page_view');
  });

  it('survives invalid URLs and binary bodies', () => {
    expect(extractRequestFeatures('not a url', '\u0000\u0001').identifierNames).toEqual([]);
  });
});

describe('extractRequestFeatures: identifiers in path parameters, read before redaction', () => {
  it('Floodlight matrix parameters: identifier names and in-memory values; counters and campaign ids are not identifiers', () => {
    const f = extractRequestFeatures(
      'https://ad.doubleclick.net/ddm/activity/src=13866753;dc_pre=CKTZg-2j4pcDFULHsQcdmeonxQ;type=invmedia;cat=home;ord=1234567;dc_dbm_token=AOjeLNEAAAA6',
      null,
    );
    expect(f.identifierNames).toEqual(['dc_dbm_token', 'dc_pre']);
    expect(f.identifierValues.sort()).toEqual(['AOjeLNEAAAA6', 'CKTZg-2j4pcDFULHsQcdmeonxQ']);
  });

  it('Audience Manager sync `ibs:dpid=…&dpuuid=…`: the user id is a feature, the partner id is not', () => {
    const f = extractRequestFeatures('https://dpm.demdex.net/ibs:dpid=28645&dpuuid=2Ml8WV9ydkxRNllV', null);
    expect(f.identifierNames).toEqual(['dpuuid']);
    expect(f.identifierValues).toEqual(['2Ml8WV9ydkxRNllV']);
  });

  it('conversion path `/_dc_unique_id=…;_dc_ptd=…` (first segment piece without a leading semicolon)', () => {
    const f = extractRequestFeatures(
      'https://www.google.com/gmp/conversion/_dc_unique_id=18302951007673778307;_dc_ptd=ChAI8ICR1wYQ',
      null,
    );
    expect(f.identifierNames).toEqual(['_dc_unique_id']);
  });

  it('percent-encoded values are decoded for the correlation; names keep their spelling; empty values are ignored', () => {
    const f = extractRequestFeatures(
      'https://ad.doubleclick.net/activity;DC_PRE=a%2Bb%3D;dc_dbm_token=;ord=1',
      null,
    );
    expect(f.identifierNames).toEqual(['DC_PRE']);
    expect(f.identifierValues).toEqual(['a+b=']);
  });

  it('path parameters and query parameters are collected together', () => {
    const f = extractRequestFeatures('https://dpm.demdex.net/ibs:dpuuid=ABCDEF12?cid=111.222', null);
    expect(f.identifierNames).toEqual(['cid', 'dpuuid']);
  });

  it('counterexamples: plain paths, file names and unrelated path parameters give no identifier', () => {
    for (const url of [
      'https://www.example.de/a/b/c.js',
      'https://www.example.de/shop;jsessionid_page=1',
      'https://www.example.de/ibs:dpid=28645',
      'https://www.example.de/a%3Bdc_pre%3DSECRET/b',
      'https://www.example.de/x;dc_pre',
    ]) {
      expect(extractRequestFeatures(url, null).identifierNames, url).toEqual([]);
    }
  });
});

describe('sanitizeRequestUrl', () => {
  it('keeps the detection allowlist (incl. ev) and redacts identifiers', () => {
    const u = sanitizeRequestUrl('https://www.facebook.com/tr?id=1&ev=PageView&fbp=fb.1.2.3#frag');
    expect(u).toBe('https://www.facebook.com/tr?id=1&ev=PageView&fbp=[redacted]');
    expect(sanitizeRequestUrl('https://www.google-analytics.com/g/collect?v=2&tid=G-T&cid=111.222')).toBe(
      'https://www.google-analytics.com/g/collect?v=2&tid=G-T&cid=[redacted]',
    );
  });
});

describe('splitSetCookieNames', () => {
  it('returns cookie names only', () => {
    // "c" has no "=": an empty name with value "c" (RFC 6265bis) → no name to record.
    expect(splitSetCookieNames(['a=1; Path=/', ' b = secret ; HttpOnly', '=bad', 'c'])).toEqual(['a', 'b']);
  });
});
