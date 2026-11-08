/**
 * Where the browser may start when the target's certificate was refused: only at the end of the observed plain-http
 * chain of the target, on another DNS host reached over https connections whose certificates were all accepted.
 */
import { describe, expect, it } from 'vitest';
import type { CollectorHandover } from '../../../src/core/snapshot/collector.ts';
import type { HttpHop, RedirectChain } from '../../../src/core/snapshot/http.ts';
import type { Snapshot } from '../../../src/core/snapshot/index.ts';
import type { TlsEndpoint } from '../../../src/core/snapshot/tls.ts';
import { tlsFallbackEntry } from '../../../src/scan-collect.ts';
import {
  makeChain,
  makeHttp,
  makeSnapshot,
  makeTarget,
  makeTls,
  makeTlsEndpoint,
} from '../../utils/snapshot-builder.ts';
import {
  brokenTarget,
  httpHop as http,
  httpsHop as https,
  RAW_FINAL,
  STORED_FINAL,
  TARGET,
  VIA,
} from './fixtures.ts';

const refused = { tlsAuthorized: false, tlsAuthorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' };

/** The standard-port plain-http chain of the target. */
function httpChain(hops: HttpHop[], over: Partial<RedirectChain> = {}): RedirectChain {
  return makeChain({
    id: 'chain-target-http',
    hostVariant: 'target',
    startUrl: VIA,
    hops,
    final: hops.at(-1) ?? null,
    outcome: 'ok',
    ...over,
  });
}

const REDIRECT = [http(VIA, 302, STORED_FINAL), https(STORED_FINAL, 200)];

/** The plain-http chain of the target: 302 to the other host, whose page answers `status`; `over` changes that hop. */
const redirect = (status: number, over: Partial<HttpHop> = {}) =>
  httpChain([http(VIA, 302, STORED_FINAL), https(STORED_FINAL, status, over)]);

const siteEndpoint = (over: Partial<TlsEndpoint> = {}): TlsEndpoint =>
  makeTlsEndpoint({ host: 'site.example.test', role: 'final', ...over });

function snapshotWith(
  o: { target?: string; chains?: RedirectChain[]; endpoints?: TlsEndpoint[]; finalTls?: TlsEndpoint[] } = {},
): Snapshot {
  return makeSnapshot({
    target: makeTarget(o.target ?? TARGET, null),
    http: makeHttp({ chains: o.chains ?? [httpChain(REDIRECT)], finalTls: o.finalTls ?? [siteEndpoint()] }),
    tls: makeTls({ endpoints: o.endpoints ?? [brokenTarget()] }),
  });
}

const handover = (final = RAW_FINAL, start = VIA): CollectorHandover => ({
  chainUrls: { 'chain-target-http': { start, final } },
});

describe('tlsFallbackEntry — the redirect target of the plain-http address', () => {
  it('http 302 to another host whose certificates were all accepted → entry on the raw URL', () => {
    const decision = tlsFallbackEntry(snapshotWith(), handover(), 'http-redirect');

    // The browser navigates the URL as the HTTP collector reached it; the stored record is sanitized.
    expect(decision).toEqual({
      entry: { reason: 'tls-invalid', url: RAW_FINAL, via: VIA },
      record: { reason: 'tls-invalid', url: STORED_FINAL, via: VIA },
    });
  });

  it('keeps a masked redirect path in the browser entry record', () => {
    const raw = 'https://site.example.test/u/alice@intranet?session=fixture-secret';
    const stored = 'https://site.example.test/[redacted]';
    const chains = [httpChain([http(VIA, 302, stored), https(stored, 200)])];

    expect(tlsFallbackEntry(snapshotWith({ chains }), handover(raw), 'http-redirect')).toEqual({
      entry: { reason: 'tls-invalid', url: raw, via: VIA },
      record: { reason: 'tls-invalid', url: stored, via: VIA },
    });
  });

  it.each([
    ['403 (a challenge the browser may pass)', 403],
    ['429 (a challenge the browser may pass)', 429],
    ['204', 204],
  ])('final status %s → entry', (_name, status) => {
    const chains = [redirect(status)];
    expect(tlsFallbackEntry(snapshotWith({ chains }), handover(), 'http-redirect').entry).not.toBeNull();
  });

  it('the final host as a www variant of the target counts as another host (its endpoint from the TLS collector)', () => {
    const final = 'https://www.example.test/';
    const snapshot = snapshotWith({
      target: 'https://example.test/',
      chains: [
        httpChain([http('http://example.test/', 301, final), https(final, 200)], {
          startUrl: 'http://example.test/',
        }),
      ],
      endpoints: [
        brokenTarget('example.test'),
        makeTlsEndpoint({ host: 'www.example.test', hostVariant: 'www' }),
      ],
      finalTls: [],
    });

    expect(
      tlsFallbackEntry(snapshot, handover(final, 'http://example.test/'), 'http-redirect').entry,
    ).toEqual({
      reason: 'tls-invalid',
      url: final,
      via: 'http://example.test/',
    });
  });

  it('an https hop on the target counts like any other when Node accepted that connection', () => {
    // The TLS probe of the target was refused, but the HTTP connection that carried the redirect was confirmed (another
    // node behind the same name): the redirect did not come over a refused connection.
    const chains = [
      httpChain([
        http(VIA, 301, TARGET),
        https(TARGET, 302, { location: STORED_FINAL }),
        https(STORED_FINAL, 200),
      ]),
    ];
    expect(tlsFallbackEntry(snapshotWith({ chains }), handover(), 'http-redirect').entry).toEqual({
      reason: 'tls-invalid',
      url: RAW_FINAL,
      via: VIA,
    });
  });

  it('an endpoint record of the final host is not required: the hops carry the verdict of each connection', () => {
    expect(
      tlsFallbackEntry(snapshotWith({ finalTls: [] }), handover(), 'http-redirect').entry,
    ).not.toBeNull();
  });
});

describe('tlsFallbackEntry — no entry, and why', () => {
  // [behaviour, expected reason, snapshot, handover]
  const rows: Array<[string, string, Snapshot, CollectorHandover | null]> = [
    [
      'the chain ends on https of the target with the refused certificate',
      'same-host',
      snapshotWith({ chains: [httpChain([http(VIA, 301, TARGET), https(TARGET, 200, refused)])] }),
      handover(TARGET),
    ],
    [
      'the way to the other host passes the refused certificate of the target',
      'invalid',
      snapshotWith({
        chains: [
          httpChain([
            http(VIA, 301, TARGET),
            https(TARGET, 302, { ...refused, location: STORED_FINAL }),
            https(STORED_FINAL, 200),
          ]),
        ],
      }),
      handover(),
    ],
    [
      'only the https chain (over the refused certificate) redirects; http serves the page itself',
      'none',
      snapshotWith({
        chains: [
          httpChain([http(VIA, 200)]),
          makeChain({
            id: 'chain-target-https',
            startUrl: TARGET,
            hops: [https(TARGET, 302, { ...refused, location: STORED_FINAL }), https(STORED_FINAL, 200)],
            final: https(STORED_FINAL, 200),
          }),
        ],
      }),
      {
        chainUrls: {
          'chain-target-http': { start: VIA, final: VIA },
          'chain-target-https': { start: TARGET, final: RAW_FINAL },
        },
      },
    ],
    [
      'the verdict of an https hop is unknown (null, e.g. behind a proxy)',
      'invalid',
      snapshotWith({ chains: [redirect(200, { tlsAuthorized: null })] }),
      handover(),
    ],
    [
      'the certificate of the final host was refused on the hop',
      'invalid',
      snapshotWith({
        chains: [redirect(200, { tlsAuthorized: false, tlsAuthorizationError: 'CERT_HAS_EXPIRED' })],
      }),
      handover(),
    ],
    [
      'the handshake record of the final host was refused',
      'invalid',
      snapshotWith({
        finalTls: [siteEndpoint({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' })],
      }),
      handover(),
    ],
    [
      'the handshake with the final host did not complete',
      'invalid',
      snapshotWith({ finalTls: [siteEndpoint({ outcome: 'timeout', authorized: false })] }),
      handover(),
    ],
    [
      'an incomplete chain on the way (Node cannot confirm it)',
      'invalid',
      snapshotWith({
        chains: [
          redirect(200, { tlsAuthorized: false, tlsAuthorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        ],
      }),
      handover(),
    ],
    [
      'the chain ends on plain http of another host',
      'none',
      snapshotWith({
        chains: [
          httpChain([http(VIA, 302, 'http://site.example.test/'), http('http://site.example.test/', 200)]),
        ],
      }),
      handover('http://site.example.test/'),
    ],
    [
      'the chain ends on plain http of the target (no redirect)',
      'none',
      snapshotWith({ chains: [httpChain([http(VIA, 200)])] }),
      handover(VIA),
    ],
    [
      'the redirect limit cut the chain',
      'none',
      snapshotWith({ chains: [httpChain(REDIRECT, { outcome: 'redirect-limit', final: null })] }),
      null,
    ],
    [
      'the chain ended with an error',
      'none',
      snapshotWith({
        chains: [httpChain([http(VIA, 302, STORED_FINAL)], { outcome: 'error', final: null })],
      }),
      null,
    ],
    [
      'the chain ended with a timeout',
      'none',
      snapshotWith({
        chains: [httpChain([http(VIA, 302, STORED_FINAL)], { outcome: 'timeout', final: null })],
      }),
      null,
    ],
    [
      'the chain broke off on its way to https of the target',
      'same-host',
      snapshotWith({ chains: [httpChain([http(VIA, 301, TARGET)], { outcome: 'timeout', final: null })] }),
      null,
    ],
    [
      'the handshake with the other host failed',
      'invalid',
      snapshotWith({
        chains: [httpChain([http(VIA, 302, STORED_FINAL)], { outcome: 'tls-error', final: null })],
      }),
      null,
    ],
    ['the page at the end answers 500', 'none', snapshotWith({ chains: [redirect(500)] }), handover()],
    ['the page at the end answers 404', 'none', snapshotWith({ chains: [redirect(404)] }), handover()],
    [
      'the target names an explicit port',
      'none',
      snapshotWith({ target: 'https://broken.example.test:8443/' }),
      handover(),
    ],
    [
      'the target is an IP literal',
      'none',
      snapshotWith({
        target: 'https://198.51.100.7/',
        chains: [
          httpChain([http('http://198.51.100.7/', 302, STORED_FINAL), https(STORED_FINAL, 200)], {
            startUrl: 'http://198.51.100.7/',
          }),
        ],
        endpoints: [brokenTarget('198.51.100.7')],
      }),
      handover(RAW_FINAL, 'http://198.51.100.7/'),
    ],
    [
      'the final host is an IP literal',
      'none',
      snapshotWith({
        chains: [httpChain([http(VIA, 302, 'https://203.0.113.7/'), https('https://203.0.113.7/', 200)])],
      }),
      handover('https://203.0.113.7/'),
    ],
    [
      'the final URL names an explicit port',
      'none',
      snapshotWith({
        chains: [
          httpChain([
            http(VIA, 302, 'https://site.example.test:8443/'),
            https('https://site.example.test:8443/', 200),
          ]),
        ],
      }),
      handover('https://site.example.test:8443/'),
    ],
    ['the HTTP collector handed over no raw URL', 'none', snapshotWith(), null],
    [
      'the HTTP probes did not run',
      'none',
      makeSnapshot({ target: makeTarget(TARGET, null), tls: makeTls({ endpoints: [brokenTarget()] }) }),
      handover(),
    ],
  ];

  it.each(rows)('%s → %s', (_name, declined, snapshot, given) => {
    expect(tlsFallbackEntry(snapshot, given, 'http-redirect')).toEqual({ entry: null, declined });
  });

  it('switched off by the operator → off, even with a usable redirect', () => {
    expect(tlsFallbackEntry(snapshotWith(), handover(), 'off')).toEqual({ entry: null, declined: 'off' });
  });
});
