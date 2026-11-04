import { describe, expect, it } from 'vitest';
import { tls02 } from '../../../../src/checks/http/tls-02.ts';
import { parseConfigInput } from '../../../../src/core/config/load.ts';
import { checkThresholds } from '../../../../src/core/config/thresholds.ts';
import type { HttpSection } from '../../../../src/core/snapshot/http.ts';
import type { TlsEndpoint } from '../../../../src/core/snapshot/tls.ts';
import {
  FIXED_NOW,
  makeCert,
  makeChain,
  makeDocumentResponse,
  makeHop,
  makeHttp,
  makeSnapshot,
  makeTarget,
  makeTls,
  makeTlsEndpoint,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';

const DAY = 86_400_000;
const at = (days: number) => new Date(FIXED_NOW.getTime() + days * DAY).toISOString();

/** Endpoint whose leaf was issued `age` days ago and expires in `left` days. */
function ep(p: Partial<TlsEndpoint> = {}, left = 200, age = 165): TlsEndpoint {
  return makeTlsEndpoint({
    chain: [makeCert({ notBefore: at(-age), notAfter: at(left) })],
    ...p,
  });
}

const snap = (...endpoints: TlsEndpoint[]) => makeSnapshot({ tls: makeTls({ endpoints }), http: makeHttp() });
const run = (...endpoints: TlsEndpoint[]) => runCheck(tls02, snap(...endpoints));

describe('TLS-02 certificate', () => {
  it('does not report an incomplete chain when the trust store authorized it', () => {
    expect(variantsOf(run(ep({ authorized: true, chainComplete: false, authorizationError: null })))).toEqual(
      [],
    );
  });

  it('clean: valid, trusted, long enough', () => {
    const r = run(ep());
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('violation (critical): expired → certificate-invalid', () => {
    const r = run(ep({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }, -10, 380));
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    const o = observationsOf(r)[0];
    expect(o).toMatchObject({
      subject: 'certificate:final',
      phases: ['tls'],
      pages: [],
      params: {
        host: 'www.example.de',
        notAfter: at(-10).slice(0, 10),
        daysLeft: -10,
        reason: 'expired',
        reasons: 'expired',
        expired: 'yes',
        notYetValid: 'no',
        nameMismatch: 'no',
        selfSigned: 'no',
        untrustedRoot: 'no',
        otherError: 'no',
        trustStore: 'node-bundled',
      },
    });
    expect(o?.evidence[0]).toMatchObject({
      type: 'tls',
      phase: 'tls',
      host: 'www.example.de',
      ip: '203.0.113.10',
      family: 4,
      protocol: 'TLSv1.3',
      issuer: 'CN=dsgvo-check Test CA',
      authorizationError: 'CERT_HAS_EXPIRED',
      trustStore: 'node-bundled',
      chainComplete: true,
      port: 443,
      cipher: 'TLS_AES_128_GCM_SHA256',
      hostnameMatches: true,
      lifetimeDays: 370,
    });
  });

  it('expiry is also derived from the dates when Node reports another error first (one finding)', () => {
    const r = run(ep({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, -3, 30));
    expect(observationsOf(r)).toHaveLength(1);
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'certificate-invalid',
      params: { reason: 'expired', reasons: 'expired,self-signed', expired: 'yes', selfSigned: 'yes' },
    });
  });

  it('not yet valid (notBefore in the future) → certificate-invalid (not-yet-valid)', () => {
    const r = run(ep({ authorized: false, authorizationError: 'CERT_NOT_YET_VALID' }, 200, -5));
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'not-yet-valid', notYetValid: 'yes' });
    // Derived from the dates as well, when Node reports another error first.
    const other = run(ep({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 200, -5));
    expect(observationsOf(other)[0]?.params).toMatchObject({ notYetValid: 'yes', selfSigned: 'yes' });
  });

  it('violation (critical): hoster certificate with another name', () => {
    const r = run(
      ep({
        authorized: false,
        authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
        hostnameMatches: false,
        chain: [
          makeCert({
            subjectAltNames: ['DNS:*.alfahosting-server.de'],
            notBefore: at(-10),
            notAfter: at(300),
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reason: 'name-mismatch',
      nameMismatch: 'yes',
      names: '*.alfahosting-server.de',
    });
  });

  it('self-signed and wrong name: Node does not check the name, our own checkHost does', () => {
    const r = run(
      ep({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', hostnameMatches: false }),
    );
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reasons: 'name-mismatch,self-signed',
      nameMismatch: 'yes',
      selfSigned: 'yes',
    });
  });

  it('violation (critical): unknown root', () => {
    const r = run(ep({ authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' }));
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'untrusted-root', untrustedRoot: 'yes' });
  });

  it('violation (warning): incomplete chain (browsers complete it via AIA) → chain-incomplete', () => {
    const r = run(
      ep({ authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', chainComplete: false }),
    );
    expect(variantsOf(r)).toEqual(['chain-incomplete']);
  });

  describe('the issuer of the leaf was sent, the root is unknown to the store', () => {
    const dates = { notBefore: at(-165), notAfter: at(200) };
    const leaf = (issuer = 'CN=Some Intermediate') => makeCert({ ...dates, issuer });
    const intermediate = (subject = 'CN=Some Intermediate') =>
      makeCert({ ...dates, subject, issuer: 'CN=Some Root', subjectAltNames: [], isCa: true });
    const unknownIssuer = (chain: TlsEndpoint['chain']) =>
      ep({
        authorized: false,
        authorizationError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        chainComplete: false,
        chain,
      });

    it('leaf + its intermediate, root not in the store → certificate-invalid (untrusted-root), not chain-incomplete', () => {
      const r = run(unknownIssuer([leaf(), intermediate()]));
      expect(variantsOf(r)).toEqual(['certificate-invalid']);
      expect(observationsOf(r)[0]?.params).toMatchObject({
        reason: 'untrusted-root',
        untrustedRoot: 'yes',
        error: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        issuer: 'CN=Some Intermediate',
      });
    });

    it('the intermediate may come later in the chain: the issuer is searched in every sent certificate', () => {
      const other = makeCert({ ...dates, subject: 'CN=Other CA', issuer: 'CN=Some Root', isCa: true });
      const r = run(unknownIssuer([leaf(), other, intermediate()]));
      expect(variantsOf(r)).toEqual(['certificate-invalid']);
    });

    it('counterexample: the leaf alone with the same error → chain-incomplete stays (the issuer was not sent)', () => {
      const r = run(unknownIssuer([leaf()]));
      expect(variantsOf(r)).toEqual(['chain-incomplete']);
      expect(observationsOf(r)[0]?.params).toMatchObject({ issuer: 'CN=Some Intermediate' });
    });

    it('counterexample: a sent certificate that is not the issuer of the leaf → chain-incomplete stays', () => {
      const r = run(unknownIssuer([leaf(), intermediate('CN=Unrelated CA')]));
      expect(variantsOf(r)).toEqual(['chain-incomplete']);
    });

    it('counterexample: authorized by the store → neither chain-incomplete nor certificate-invalid', () => {
      const r = run(
        ep({
          authorized: true,
          authorizationError: null,
          chainComplete: false,
          chain: [leaf(), intermediate()],
        }),
      );
      expect(variantsOf(r)).toEqual([]);
    });
  });

  it('unknown Node verification error → certificate-invalid (other error)', () => {
    const r = run(ep({ authorized: false, authorizationError: 'CERT_SIGNATURE_FAILURE' }));
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reason: 'invalid',
      otherError: 'yes',
      error: 'CERT_SIGNATURE_FAILURE',
    });
  });

  it.each([
    // [days left, lifetime days, expected]
    [10, 90, ['certificate-expiring']],
    [13, 90, ['certificate-expiring']],
    [20, 90, ['certificate-expiry-approaching']],
    [29, 90, ['certificate-expiry-approaching']],
    [40, 90, []],
    [4, 20, ['certificate-expiring']], // < min(14 d, 25 % of 20 d = 5 d)
    [6, 20, ['certificate-expiry-approaching']], // < min(30 d, 10 d)
    [12, 20, []],
    [2, 6, []], // short-lived certificate (≤ 10 d): no expiry finding
    [1, 10, []],
  ] as const)('expiry: %i days left of %i → %j', (left, lifetime, expected) => {
    const r = run(ep({}, left, lifetime - left));
    expect(variantsOf(r)).toEqual(expected);
    if (expected.length > 0) {
      expect(observationsOf(r)[0]).toMatchObject({
        subject: 'certificate:final',
        params: { daysLeft: left, lifetimeDays: lifetime },
      });
    }
  });

  describe('expiry windows from the settings', () => {
    const runWith = (tls: Record<string, number>, left: number, lifetime: number) =>
      runCheck(tls02, snap(ep({}, left, lifetime - left)), {
        thresholds: checkThresholds(parseConfigInput({ tls })),
      });

    it.each([
      // [settings, days left, lifetime days, expected]; the first case of each pair is the built-in verdict
      [{}, 20, 90, ['certificate-expiry-approaching']],
      [{ expiringDays: 21 }, 20, 90, ['certificate-expiring']],
      [{}, 40, 90, []],
      [{ approachingDays: 45, approachingLifetimeShare: 1 }, 40, 90, ['certificate-expiry-approaching']],
      [{}, 6, 20, ['certificate-expiry-approaching']],
      [{ expiringLifetimeShare: 0.5 }, 6, 20, ['certificate-expiring']],
      [{}, 2, 6, []],
      [{ shortLivedDays: 0 }, 2, 6, ['certificate-expiry-approaching']],
      [{ shortLivedDays: 30 }, 4, 20, []],
      [{ expiringDays: 0, approachingDays: 0 }, 10, 90, []],
    ] as const)('%j, %i days left of %i → %j', (tls, left, lifetime, expected) => {
      expect(variantsOf(runWith(tls, left, lifetime))).toEqual(expected);
    });
  });

  it('expiry together with an incomplete chain is still reported', () => {
    const r = run(
      ep(
        { authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', chainComplete: false },
        5,
        85,
      ),
    );
    expect(variantsOf(r)).toEqual(['certificate-expiring', 'chain-incomplete']);
  });

  it('www / apex endpoints are evaluated with their own subject', () => {
    const r = run(
      ep(),
      ep(
        { hostVariant: 'www', host: 'example.de', authorized: false, authorizationError: 'CERT_HAS_EXPIRED' },
        -1,
      ),
    );
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['certificate:pair']);
  });

  it('counterexample: closed 443 or missing DNS on www/apex is not a certificate problem', () => {
    const r = run(
      ep(),
      ep({ hostVariant: 'www', outcome: 'connection-refused', chain: [], protocol: null, authorized: false }),
      ep({ hostVariant: 'apex', outcome: 'dns-error', chain: [], protocol: null, authorized: false }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('not applicable: the target has no https at all', () => {
    const r = run(ep({ outcome: 'connection-refused', chain: [], protocol: null, authorized: false }));
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'no-https' });
  });

  it('inconclusive: handshake timed out', () => {
    const r = run(ep({ outcome: 'timeout', chain: [], protocol: null, authorized: false }));

    expect(r).toMatchObject({ status: 'inconclusive', reason: 'handshake-inconclusive' });
    expect(r.outcome?.limitations).toEqual(['undecided:target', 'handshake-timeout']);
  });

  it('inconclusive: handshake failed without an established cause', () => {
    const r = run(
      ep({
        outcome: 'error',
        chain: [],
        protocol: null,
        authorized: false,
        error: { code: 'ECONNRESET', message: 'socket hang up' },
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'handshake-inconclusive' });
    expect(r.outcome?.limitations).toEqual(['undecided:target', 'handshake-failed']);
  });

  it('partial: www timed out, target evaluated', () => {
    const r = run(ep(), ep({ hostVariant: 'www', outcome: 'timeout', chain: [], authorized: false }));

    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['undecided:www']);
  });

  it('error: no target endpoint in the section', () => {
    expect(run(ep({ hostVariant: 'www' }))).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('tls collector failed without a section → error', () => {
    const s = makeSnapshot({ collection: { tls: { status: 'error', durationMs: 0 } } });

    expect(runCheck(tls02, s)).toMatchObject({ status: 'error', reason: 'collector-error:tls' });
  });

  describe('the final host of a redirect to another domain', () => {
    /** Start chain https://www.example.de/ → 301 → https://www.moved.de/ (200). */
    const movedHttp = (finalTls?: TlsEndpoint[]): HttpSection => {
      const chain = makeChain({
        id: 'chain-target-https',
        scheme: 'https',
        startUrl: 'https://www.example.de/',
        hops: [
          makeHop({ url: 'https://www.example.de/', status: 301, location: 'https://www.moved.de/' }),
          makeHop({ url: 'https://www.moved.de/', status: 200 }),
        ],
      });
      chain.final = chain.hops.at(-1) ?? null;

      return makeHttp({
        chains: [chain],
        documents: [
          makeDocumentResponse({
            role: 'start',
            url: 'https://www.example.de/',
            finalUrl: 'https://www.moved.de/',
            chainId: 'chain-target-https',
          }),
        ],
        ...(finalTls ? { finalTls } : {}),
      });
    };

    const finalEp = (p: Partial<TlsEndpoint> = {}, left = 200, age = 165) =>
      ep({ id: 'tls-final-target', role: 'final', host: 'www.moved.de', ...p }, left, age);
    const runMoved = (http: HttpSection, ...endpoints: TlsEndpoint[]) =>
      runCheck(
        tls02,
        makeSnapshot({
          target: makeTarget('https://www.example.de/', 'https://www.moved.de/'),
          tls: makeTls({ endpoints }),
          http,
        }),
      );

    it('an expired certificate of the final host → certificate-invalid with the role in the subject', () => {
      const r = runMoved(
        movedHttp([finalEp({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }, -2, 90)]),
        ep(),
      );

      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['certificate-invalid']);
      expect(observationsOf(r)[0]).toMatchObject({
        subject: 'certificate:final',
        params: { host: 'www.moved.de', expired: 'yes' },
      });
    });

    it('the www/apex of the final domain are evaluated as well; a valid final host gives no finding', () => {
      const r = runMoved(
        movedHttp([
          finalEp(),
          finalEp({
            id: 'tls-final-apex',
            hostVariant: 'apex',
            host: 'moved.de',
            outcome: 'connection-refused',
            chain: [],
          }),
        ]),
        ep(),
      );

      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual([]);
    });

    it('final host known but not probed (e.g. older snapshot) → partial with limitation', () => {
      const r = runMoved(movedHttp(), ep());

      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['final-host-not-probed']);
    });

    it('final host handshake timed out → partial with limitation', () => {
      const r = runMoved(movedHttp([finalEp({ outcome: 'timeout', chain: [], authorized: false })]), ep());

      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['undecided:final-target']);
    });

    it('a redirect within the variants (www → apex) needs no extra probe', () => {
      const http = movedHttp();
      const start = http.documents[0];
      if (start) start.finalUrl = 'https://example.de/';
      const chain = http.chains[0];
      if (chain?.final) chain.final.url = 'https://example.de/';

      const r = runMoved(http, ep(), ep({ hostVariant: 'apex', host: 'example.de' }));

      expect(r.status).toBe('completed');
    });
  });

  it('the target endpoint on an explicit port is evaluated', () => {
    const r = runCheck(
      tls02,
      makeSnapshot({
        target: makeTarget('https://www.example.de:8443/'),
        tls: makeTls({
          endpoints: [ep({ port: 8443, authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }, -1)],
        }),
        http: makeHttp(),
      }),
    );

    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.evidence[0]).toMatchObject({ port: 8443 });
  });
});

describe('TLS-02 subject by host role, independent of how the target was typed (5.4)', () => {
  const expired = { authorized: false, authorizationError: 'CERT_HAS_EXPIRED' } as const;

  it('typed example.de (redirect to www) and typed www.example.de: same subject for the www certificate', () => {
    const viaApex = runCheck(
      tls02,
      makeSnapshot({
        target: makeTarget('https://example.de/', 'https://www.example.de/'),
        tls: makeTls({
          endpoints: [
            ep({ hostVariant: 'target', host: 'example.de' }),
            ep({ id: 'tls-www', hostVariant: 'www', host: 'www.example.de', ...expired }, -1),
          ],
        }),
        http: makeHttp(),
      }),
    );
    const direct = runCheck(
      tls02,
      makeSnapshot({
        target: makeTarget('https://www.example.de/'),
        tls: makeTls({
          endpoints: [
            ep({ host: 'www.example.de', ...expired }, -1),
            ep({ id: 'tls-apex', hostVariant: 'apex', host: 'example.de' }),
          ],
        }),
        http: makeHttp(),
      }),
    );
    expect(observationsOf(viaApex).map((o) => o.subject)).toEqual(['certificate:final']);
    expect(observationsOf(direct).map((o) => o.subject)).toEqual(['certificate:final']);
  });

  it('the other host of the www/apex pair is `pair`', () => {
    const r = runCheck(
      tls02,
      makeSnapshot({
        target: makeTarget('https://www.example.de/'),
        tls: makeTls({
          endpoints: [ep(), ep({ id: 'tls-apex', hostVariant: 'apex', host: 'example.de', ...expired }, -1)],
        }),
        http: makeHttp(),
      }),
    );
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['certificate:pair']);
  });
});
