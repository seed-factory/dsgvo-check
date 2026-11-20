import { describe, expect, it } from 'vitest';
import { defaultHttpPort, parseUrl } from '../../../../src/core/url/url.ts';

describe('parseUrl with HTTP-only filtering', () => {
  it.each([
    ['http://example.test/', true],
    ['https://example.test/', true],
    ['ftp://example.test/', false],
    ['mailto:a@example.test', false],
    ['data:text/plain,x', false],
    ['javascript:void(0)', false],
    ['ws://example.test/', false],
  ])('%s → %s', (raw, http) => {
    expect(parseUrl(raw, undefined, true)?.href ?? null).toBe(http ? raw : null);
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
