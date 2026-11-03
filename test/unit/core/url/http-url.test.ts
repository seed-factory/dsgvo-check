import { describe, expect, it } from 'vitest';
import { defaultHttpPort, isHttpUrl, parseUrl } from '../../../../src/core/url/url.ts';

describe('isHttpUrl', () => {
  it.each([
    ['http://example.test/', true],
    ['https://example.test/', true],
    ['ftp://example.test/', false],
    ['mailto:a@example.test', false],
    ['data:text/plain,x', false],
    ['javascript:void(0)', false],
    ['ws://example.test/', false],
  ])('%s → %s', (raw, http) => {
    expect(isHttpUrl(new URL(raw))).toBe(http);
  });

  it('is what `parseUrl(…, httpOnly)` keeps', () => {
    expect(parseUrl('https://example.test/', undefined, true)?.href).toBe('https://example.test/');
    expect(parseUrl('ftp://example.test/', undefined, true)).toBeNull();
    expect(parseUrl('ftp://example.test/')?.protocol).toBe('ftp:');
  });
});

describe('defaultHttpPort', () => {
  it.each([
    ['https:', 443],
    ['http:', 80],
  ])('%s → %i', (protocol, port) => {
    expect(defaultHttpPort(protocol)).toBe(port);
  });
});
