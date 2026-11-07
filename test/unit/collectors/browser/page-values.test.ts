/**
 * Values the page chooses are kept only as tokens of standard markup and protocols or in a fixed form: the values real
 * sites use stay as they are, anything else is dropped, replaced by a fixed word or `[redacted]`. Markers start with
 * `zq8`.
 */
import { describe, expect, it } from 'vitest';
import {
  anchorRel,
  fetchDestination,
  formMethod,
  hintRel,
  isConsentSignal,
  isCookieName,
  isEventName,
  isHostname,
  requestMethod,
  scriptType,
  storedCookiePath,
} from '../../../../src/collectors/browser/page-values.ts';

describe('link types of an anchor', () => {
  it.each([
    ['noopener noreferrer', 'noopener noreferrer'],
    ['NoFollow', 'nofollow'],
    ['bookmark', 'bookmark'],
    ['nofollow sid=zq8SECRET alice@example.com', 'nofollow'],
    ['zq8 https://example.test/?sid=zq8', undefined],
    ['', undefined],
  ])('%j → %j', (rel, kept) => {
    expect(anchorRel(rel)).toBe(kept);
  });
});

describe('hint types of <link rel> and of a Link header', () => {
  it.each([
    ['preconnect', 'preconnect'],
    ['preconnect stylesheet', 'preconnect stylesheet'],
    ['alternate stylesheet', 'stylesheet'],
    ['stylesheet alice@example.com ?sid=zq8SECRET', 'stylesheet'],
    // Whole tokens only: a word that contains a hint type is none.
    ['zq8stylesheet', undefined],
    ['icon', undefined],
  ])('%j → %j', (rel, kept) => {
    expect(hintRel(rel)).toBe(kept);
  });

  it.each([
    ['style', 'style'],
    ['Font', 'font'],
    ['script', 'script'],
    ['style 4f3a9c1d-consent', undefined],
    ['style?x=alice@example.com', undefined],
  ])('as=%j → %j', (as, kept) => {
    expect(fetchDestination(as)).toBe(kept);
  });
});

describe('form methods and request methods', () => {
  it.each([
    ['get', 'get'],
    ['POST', 'post'],
    ['dialog', 'dialog'],
    ['post?token=zq8SECRET&mail=alice@example.com', 'get'],
  ])('<form method=%j> → %j', (method, kept) => {
    expect(formMethod(method)).toBe(kept);
  });

  it.each([
    ['GET', 'GET'],
    ['POST', 'POST'],
    ['OPTIONS', 'OPTIONS'],
    ['X-4f3a9c1d2e7b8a9f', 'OTHER'],
    ['SID_ZQ8SECRET', 'OTHER'],
  ])('fetch(…, { method: %j }) → %j', (method, kept) => {
    expect(requestMethod(method)).toBe(kept);
  });
});

describe('script types', () => {
  it.each([
    ['text/javascript', 'text/javascript'],
    ['text/plain', 'text/plain'],
    ['module', 'module'],
    ['application/ld+json', 'application/ld+json'],
    ['TEXT/PLAIN', 'text/plain'],
    ['text/javascript; charset=utf-8', 'text/javascript'],
    ['text/plain; sid=zq8SECRET alice@example.com', 'text/plain'],
    ['text/x-4f3a9c1d2e', 'other'],
    ['text/qx7k2m9q4w8e1r5t3', 'other'],
    ['text/javascript1.5', 'text/javascript1.5'],
    ['text/x-magento-init', 'text/x-magento-init'],
    ['text/template', 'text/template'],
    ['application/vnd.api+json', 'application/vnd.api+json'],
    ['zq8 alice@example.com', 'other'],
    // A host and a path, an address with `+` for `@`, a suffix that is no structured syntax: no MIME type.
    ['evil.test/zq8alice', 'other'],
    ['text/max.mustermann+example.de', 'other'],
    ['text/mustermann+example', 'other'],
    ['text/www.example.de', 'other'],
    ['', undefined],
  ])('%j → %j', (type, kept) => {
    expect(scriptType(type)).toBe(kept);
  });
});

describe('event names and Consent Mode signals of requests', () => {
  it.each([
    ['page_view', true],
    ['PageView', true],
    ['purchase', true],
    ['alice@example.com', false],
    ['4f3a9c1d2e7b8a9f', false],
    ['ev1730291234', false],
    ['qx7k2m9q4w8e1r5t3', false],
    ['evt_Ab3kQ9xLmP2wZr7Y', false],
    ['InitiateCheckout', true],
    ['user_engagement', true],
    ['zq8 secret', false],
  ])('event %j → %s', (name, kept) => {
    expect(isEventName(name)).toBe(kept);
  });

  it.each([
    ['gcs', 'G100', true],
    ['gcs', 'G111', true],
    ['gcs', 'G1--', true],
    ['gcd', '13l3l3l3l1', true],
    ['gcd', '11t1t1t1t5', true],
    ['gcd', '13r3r3r2r5l1', true],
    ['npa', '1', true],
    ['dma', '0', true],
    ['gcs', '4f3a9c1d2e7b-consent', false],
    ['gcs', 'G100zq8', false],
    ['gcd', '1', false],
    ['npa', 'zq8SECRET', false],
    ['unknown', '1', false],
  ])('%s=%j → %s', (key, value, kept) => {
    expect(isConsentSignal(key, value)).toBe(kept);
  });
});

describe('cookie paths, names and the hosts of the cookie-write log', () => {
  it.each([
    ['/', '/'],
    ['/shop', '/shop'],
    ['/wp-admin/', '/wp-admin/'],
    ['/?sid=zq8SECRET&mail=alice@example.com', '[redacted]'],
    ['/x?uid=zq8SECRET', '[redacted]'],
    ['/x%3Fsid%3Dzq8SECRET', '[redacted]'],
    ['/user/1234567', '[redacted]'],
    ['/s/qx7k2m9q4w8e1r5t3', '[redacted]'],
    ['/s/Rq1oKz8m7qXy9kL3fJ2Wb5A', '[redacted]'],
    // Segments are judged one by one: a year in a plain path is no id.
    ['/shop/category/product2023/v2/', '/shop/category/product2023/v2/'],
    ['/wp-content/uploads/2023/10/', '/wp-content/uploads/2023/10/'],
    [`/${'a'.repeat(250)}`, '[redacted]'],
  ])('path %j → %j', (path, stored) => {
    expect(storedCookiePath(path)).toBe(stored);
  });

  it.each([
    ['_ga', true],
    ['CookieConsent', true],
    ['borlabs-cookie', true],
    ['cid=4f3a9c1d', false],
    ['a;b', false],
    ['a b', false],
    ['', false],
  ])('cookie name %j → %s', (name, ok) => {
    expect(isCookieName(name)).toBe(ok);
  });

  it.each([
    ['example.test', true],
    ['www.example.test', true],
    ['xn--bcher-kva.example', true],
    ['127.0.0.1', true],
    ['?sid=zq8secret alice@example.com', false],
    ['alice@example.com?x=1', false],
    ['example.test/path', false],
  ])('host %j → %s', (host, ok) => {
    expect(isHostname(host)).toBe(ok);
  });
});
