import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../../src/core/errors.ts';
import { classifyAddress } from '../../../src/core/net.ts';
import {
  bareHost,
  parseTarget,
  REDACTED,
  redactTarget,
  registrableDomain,
  sanitizeUrl,
} from '../../../src/core/url.ts';

describe('parseTarget', () => {
  it('normalizes and computes eTLD+1', () => {
    expect(parseTarget('https://WWW.Example.DE/path#frag')).toMatchObject({
      url: 'https://www.example.de/path',
      host: 'www.example.de',
      etld1: 'example.de',
      scheme: 'https',
    });
    expect(parseTarget('example.de').url).toBe('https://example.de/');
    expect(parseTarget('https://pr-1.my-app.vercel.app/').etld1).toBe(
      'pr-1.my-app.vercel.app'.split('.').slice(-3).join('.'),
    );
  });

  it.each(['ftp://example.de', 'https://u:p@example.de', 'javascript:alert(1)', 'http://', ''])(
    'rejects %j',
    (input) => {
      expect(() => parseTarget(input)).toThrow(InvalidInputError);
    },
  );

  it('keeps the IPv6 literal in URL form; bareHost strips the brackets for DNS and sockets', () => {
    const t = parseTarget('https://[2606:4700:4700::1111]/');
    expect(t.url).toBe('https://[2606:4700:4700::1111]/');
    expect(t.etld1).toBeNull();
    expect(bareHost(t.host)).toBe('2606:4700:4700::1111');
    expect(bareHost('www.example.de')).toBe('www.example.de');
    expect(bareHost('93.184.215.14')).toBe('93.184.215.14');
  });

  it('error messages never echo credentials or query values of the input', () => {
    for (const input of [
      'https://user:secret@exa mple.de/?token=abc',
      'ftp://user:secret@example.de/?token=abc',
    ]) {
      let message = '';
      try {
        parseTarget(input);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('secret');
      expect(message).not.toContain('abc');
    }
  });
});

describe('redactTarget for scan targets', () => {
  it.each([
    ['https://example.de/?token=secret', `https://example.de/?token=${REDACTED}`],
    ['https://demo-user:demo-password@example.de/?sid=demo-session', `https://example.de/?sid=${REDACTED}`],
    ['example.de/path?token=secret#frag', `https://example.de/path?token=${REDACTED}`],
    ['https://user:pw@exa mple.de/?token=secret', `https://exa mple.de/?${REDACTED}`],
    ['https://www.example.de/', 'https://www.example.de/'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(redactTarget(input)).toBe(expected);
  });
});

describe('sanitizeUrl', () => {
  it('redacts query values outside the allowlist, drops fragment and credentials', () => {
    expect(
      sanitizeUrl('https://u:p@www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=123.456&en=page_view#x'),
    ).toBe(`https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=${REDACTED}&en=page_view`);
    expect(sanitizeUrl('https://fonts.googleapis.com/css2?family=Roboto&display=swap')).toBe(
      'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
    );
    expect(sanitizeUrl('data:image/png;base64,AAAA')).toBe(`data:${REDACTED}`);
  });

  it('keeps the Meta Pixel event name (`ev`) so core and the browser collector sanitize alike', () => {
    expect(sanitizeUrl('https://www.facebook.com/tr?id=123&ev=PageView&fbp=fb.1.2.3')).toBe(
      `https://www.facebook.com/tr?id=123&ev=PageView&fbp=${REDACTED}`,
    );
  });

  it('masks the local part of mailto: addresses and drops their headers (5.3)', () => {
    expect(sanitizeUrl('mailto:alice@example.de')).toBe(`mailto:${REDACTED}@example.de`);
    expect(sanitizeUrl('MAILTO:Alice.Smith@Example.de?subject=Hi&cc=bob@other.de')).toBe(
      `mailto:${REDACTED}@example.de`,
    );
    expect(sanitizeUrl('mailto:a@x.de,b@y.de')).toBe(`mailto:${REDACTED}@x.de,${REDACTED}@y.de`);
    expect(sanitizeUrl('mailto:%61lice%40example.de')).toBe(`mailto:${REDACTED}@example.de`);
    expect(sanitizeUrl('mailto:?subject=x&body=alice@example.de')).toBe(`mailto:${REDACTED}`);
    expect(sanitizeUrl('mailto:alice@example.de')).not.toContain('alice');
  });

  it.each([
    // generic names keep only site-level values of the expected form
    ['https://shop.example.de/konto/bestellung?id=4711&token=abc', `?id=${REDACTED}&token=${REDACTED}`],
    ['https://shop.example.de/x?id=visitor-secret', `?id=${REDACTED}`],
    ['https://www.googletagmanager.com/gtag/js?id=G-ABC123', '?id=G-ABC123'],
    ['https://www.googletagmanager.com/gtm.js?id=GTM-K7X9', '?id=GTM-K7X9'],
    ['https://www.googletagmanager.com/gtag/js?id=AW-123456789', '?id=AW-123456789'],
    ['https://www.googletagmanager.com/gtag/js?id=DC-9876543', '?id=DC-9876543'],
    ['https://www.googletagmanager.com/gtag/js?id=GT-PZXQ', '?id=GT-PZXQ'],
    ['https://www.google-analytics.com/g/collect?tid=G-T', '?tid=G-T'],
    ['https://www.example.de/x?id=G-', `?id=${REDACTED}`],
    ['https://www.example.de/app.js?t=1730291234567&v=8a1f2c', `?t=${REDACTED}&v=${REDACTED}`],
    ['https://cdn.example.de/a.js?v=1793373555053', `?v=${REDACTED}`],
    ['https://www.google.com/x?v=NhfdZHabcdefghijklmnopqr', `?v=${REDACTED}`],
    ['https://www.example.de/wp.js?ver=6.4.2&v=2.1.0', '?ver=6.4.2&v=2.1.0'],
    [
      'https://www.google-analytics.com/collect?v=1&t=pageview&tid=UA-1234-1',
      '?v=1&t=pageview&tid=UA-1234-1',
    ],
    ['https://metrics.example.de/b/ss?t=30%2F9%2F2026+16%3A21%3A3+5+-60', `?t=${REDACTED}`],
    ['https://www.google-analytics.com/g/collect?tid=customer-4711', `?tid=${REDACTED}`],
  ])('%s', (input, query) => {
    expect(sanitizeUrl(input)).toBe(`${input.split('?')[0]}${query}`);
  });

  it('registrableDomain uses private suffixes', () => {
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('foo.github.io')).toBe('foo.github.io');
    expect(registrableDomain('127.0.0.1')).toBeNull();
  });
});

describe('classifyAddress (SSRF guard)', () => {
  it.each([
    ['93.184.215.14', 'public'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.10.10', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:8.8.8.8', 'public'],
    ['fe80::1', 'link-local'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['2a00:1450:4001:80b::200e', 'public'],
    // embedded IPv4 in transition prefixes
    ['64:ff9b::7f00:1', 'loopback'], // NAT64 of 127.0.0.1
    ['64:ff9b::a9fe:a9fe', 'metadata'], // NAT64 of 169.254.169.254
    ['64:ff9b::10.0.0.5', 'private'],
    ['64:ff9b::808:808', 'public'], // NAT64 of 8.8.8.8
    ['64:ff9b:1::a00:5', 'reserved'], // local-use NAT64 (RFC 8215)
    ['2002:7f00:1::1', 'loopback'], // 6to4 of 127.0.0.1
    ['2002:a9fe:a9fe::1', 'metadata'],
    ['2002:808:808::1', 'public'],
    ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'loopback'], // Teredo, client ~0x80fffffe = 127.0.0.1
    ['2001:0:4136:e378:8000:63bf:f7f7:f7f7', 'public'], // Teredo, client 8.8.8.8
    ['fec0::1', 'private'], // deprecated site-local
    ['FEC0::1', 'private'],
    ['2001:4860:4860::8888', 'public'],
    ['not-an-ip', 'reserved'],
  ])('%s → %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});
