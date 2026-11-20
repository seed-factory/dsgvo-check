/**
 * What the TLS collector stores of a certificate: subject and issuer with addresses masked and no URL query or
 * fragment, and of the subject alternative names only the host-shaped `DNS:` and the `IP Address:` entries the name
 * check reads. TLS-02 still pairs the leaf with its issuer by the stored names.
 */
import 'reflect-metadata';
import { webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';
import { tls02 } from '../../../../src/checks/http/tls-02.ts';
import { certificateInfo } from '../../../../src/collectors/tls/probe.ts';
import type { CertificateInfo } from '../../../../src/core/snapshot/tls.ts';
import {
  makeHttp,
  makeSnapshot,
  makeTls,
  makeTlsEndpoint,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';

x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 86_400_000;
const NOW = new Date();
const validity = { notBefore: new Date(NOW.getTime() - DAY), notAfter: new Date(NOW.getTime() + 90 * DAY) };

const keys = async () =>
  (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;

interface ChainNames {
  root: string;
  intermediate: string;
  leaf: string;
  altNames: x509.JsonGeneralName[];
}

/** Root → intermediate → leaf with the given names; the stored infos of leaf and intermediate. */
async function chainOf(names: ChainNames): Promise<[CertificateInfo, CertificateInfo]> {
  const rootKeys = await keys();
  const intKeys = await keys();
  const leafKeys = await keys();
  const ca = [new x509.BasicConstraintsExtension(true, 0, true)];
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: names.root,
    ...validity,
    keys: rootKeys,
    signingAlgorithm: ALG,
    extensions: ca,
  });
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: names.intermediate,
    issuer: root.subject,
    ...validity,
    signingKey: rootKeys.privateKey,
    publicKey: intKeys.publicKey,
    signingAlgorithm: ALG,
    extensions: ca,
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '03',
    subject: names.leaf,
    issuer: intermediate.subject,
    ...validity,
    signingKey: intKeys.privateKey,
    publicKey: leafKeys.publicKey,
    signingAlgorithm: ALG,
    extensions: names.altNames.length > 0 ? [new x509.SubjectAlternativeNameExtension(names.altNames)] : [],
  });
  return [
    certificateInfo(new X509Certificate(leaf.toString('pem'))),
    certificateInfo(new X509Certificate(intermediate.toString('pem'))),
  ];
}

/** The stored info of a self-signed certificate with these names. */
async function selfSigned(name: string, altNames: x509.JsonGeneralName[] = []): Promise<CertificateInfo> {
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name,
    ...validity,
    keys: await keys(),
    signingAlgorithm: ALG,
    extensions: altNames.length > 0 ? [new x509.SubjectAlternativeNameExtension(altNames)] : [],
  });
  return certificateInfo(new X509Certificate(cert.toString('pem')));
}

/** TLS-02 on a target whose root the store does not know, with leaf and intermediate sent. */
const unknownRoot = (chain: CertificateInfo[]) =>
  runCheck(
    tls02,
    makeSnapshot({
      tls: makeTls({
        endpoints: [
          makeTlsEndpoint({
            authorized: false,
            authorizationError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            chainComplete: false,
            chain,
          }),
        ],
      }),
      http: makeHttp(),
    }),
    { now: NOW },
  );

describe('a certificate with personal data in its names', () => {
  let leaf: CertificateInfo;
  let intermediate: CertificateInfo;

  beforeAll(async () => {
    [leaf, intermediate] = await chainOf({
      root: 'CN=Example Root',
      intermediate: 'CN=Example Intermediate, O=Example CA, E=zq7ca@example.test',
      leaf: 'CN=www.example.test, E=zq7admin@example.test',
      altNames: [
        { type: 'dns', value: 'www.example.test' },
        { type: 'email', value: 'zq7admin@example.test' },
        { type: 'url', value: 'https://example.test/cb?session=zq7secret' },
        // Node quotes a value with a comma: the text inside the quotes is no entry of its own
        { type: 'url', value: 'https://example.test/?a=zq7x, DNS:zq7fake.example.test' },
        { type: 'ip', value: '192.0.2.1' },
      ],
    });
  });

  it('subject and issuer keep the domain of an address, not its local part', () => {
    expect(leaf.subject).toBe('CN=www.example.test, emailAddress=[redacted]@example.test');
    expect(leaf.issuer).toBe('CN=Example Intermediate, O=Example CA, emailAddress=[redacted]@example.test');
    expect(intermediate.subject).toBe(leaf.issuer);
  });

  it('of the alternative names only the DNS names and addresses the name check reads are stored', () => {
    expect(leaf.subjectAltNames).toEqual(['DNS:www.example.test', 'IP Address:192.0.2.1']);
  });

  it('nothing personal reaches the stored infos', () => {
    expect(JSON.stringify([leaf, intermediate])).not.toContain('zq7');
  });

  it('TLS-02 still finds the issuer of the leaf among the sent certificates, and its finding holds no personal data', () => {
    const r = unknownRoot([leaf, intermediate]);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reason: 'untrusted-root',
      names: 'www.example.test, 192.0.2.1',
      nameSource: 'san',
    });
    expect(JSON.stringify(r)).not.toContain('zq7');
  });
});

describe('an address that Node writes escaped or that is encoded keeps only its domain', () => {
  it.each([
    [
      'a subaddress, `+` escaped',
      'CN=www.example.test, E=zq7max.mustermann\\+web@example.test',
      'CN=www.example.test, emailAddress=[redacted]@example.test',
    ],
    [
      'a quoted local part',
      'CN=www.example.test, E=\\"zq7 alice\\"@example.test',
      'CN=www.example.test, emailAddress=[redacted]@example.test',
    ],
    [
      'an escaped comma in the local part',
      'CN=www.example.test, E=zq7a\\,b@example.test',
      'CN=www.example.test, emailAddress=[redacted]@example.test',
    ],
    [
      'an address next to a name in the CN',
      'CN=Webmaster \\<zq7max\\+x@example.test\\>',
      'CN=[redacted]@example.test',
    ],
    [
      'an address in a multi-valued RDN',
      'CN=www.example.test+E=zq7max\\+x@example.test',
      'CN=www.example.test + emailAddress=[redacted]@example.test',
    ],
    [
      'a percent-encoded address',
      'CN=www.example.test, E=zq7alice%40example.test',
      'CN=www.example.test, emailAddress=[redacted]',
    ],
    [
      'an address without a dotted domain',
      'CN=www.example.test, E=zq7alice@intranet',
      'CN=www.example.test, emailAddress=[redacted]',
    ],
  ])('%s', async (_label, name, stored) => {
    const info = await selfSigned(name);
    expect([info.subject, info.issuer]).toEqual([stored, stored]);
    expect(JSON.stringify(info)).not.toContain('zq7');
  });

  it.each(['zq7a"b@example.test', 'zq7a,b@example.test'])(
    'a DNS name that Node writes quoted, %j',
    async (dns) => {
      const info = await selfSigned('CN=www.example.test', [{ type: 'dns', value: dns }]);
      expect(info.subjectAltNames).toEqual(['DNS:[redacted]@example.test']);
    },
  );

  it('TLS-02 pairs the leaf with an issuer named so, and names a CN-only leaf by the domain alone', async () => {
    const [leaf, intermediate] = await chainOf({
      root: 'CN=Example Root',
      intermediate: 'CN=Example Intermediate, E=zq7ca\\+x@example.test',
      leaf: 'CN=zq7admin\\+x@example.test',
      altNames: [],
    });
    const r = unknownRoot([leaf, intermediate]);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reason: 'untrusted-root',
      names: '[redacted]@example.test',
      nameSource: 'cn',
    });
    expect(JSON.stringify(r)).not.toContain('zq7');
  });
});

describe('a URL or a mailto: value in a name keeps no query, fragment or local part', () => {
  it.each([
    [
      'a URL with a query',
      'CN=www.example.test, OU=https://r.example.test/cb?session=zq7secret',
      'CN=www.example.test, OU=https://r.example.test/cb?[redacted]',
    ],
    [
      'a query value with a quote, which Node escapes',
      'CN=www.example.test, OU=https://r.example.test/x?u=a"zq7tail',
      'CN=www.example.test, OU=https://r.example.test/x?[redacted]',
    ],
    [
      'a relative URL with a query',
      'CN=www.example.test, OU=/cb?u=zq7secret',
      'CN=www.example.test, OU=/cb?[redacted]',
    ],
    [
      'a URL of another scheme with a query',
      'CN=www.example.test, OU=wss://r.example.test/x?u=zq7secret',
      'CN=www.example.test, OU=wss://r.example.test/x?[redacted]',
    ],
    [
      'a fragment',
      'CN=www.example.test, OU=wss://r.example.test/x#zq7secret',
      'CN=www.example.test, OU=wss://r.example.test/x',
    ],
    [
      'a mailto: value without a domain',
      'CN=www.example.test, OU=mailto:zq7alice',
      'CN=www.example.test, OU=mailto:[redacted]',
    ],
  ])('%s', async (_label, name, stored) => {
    const info = await selfSigned(name);
    expect([info.subject, info.issuer]).toEqual([stored, stored]);
    expect(JSON.stringify(info)).not.toContain('zq7');
  });

  it.each([
    ['a URL', 'https://r.example.test/?u=zq7secret'],
    ['a host with a path and a query', 'r.example.test/?token=zq7secret'],
    ['a host with a blank', 'www.example.test zq7secret'],
  ])('a DNS name that is no host name is not stored: %s', async (_label, dns) => {
    const info = await selfSigned('CN=www.example.test', [
      { type: 'dns', value: 'www.example.test' },
      { type: 'dns', value: dns },
    ]);
    expect(info.subjectAltNames).toEqual(['DNS:www.example.test', 'DNS:[redacted]']);
  });

  it('TLS-02 pairs the leaf with an issuer named so, and its finding holds no query', async () => {
    const [leaf, intermediate] = await chainOf({
      root: 'CN=Example Root',
      intermediate: 'CN=Hoster CA, OU=https://ca.example.test/cps?session=zq7ca',
      leaf: 'CN=www.example.test, OU=https://r.example.test/cb?session=zq7leaf',
      altNames: [
        { type: 'dns', value: 'www.example.test' },
        { type: 'dns', value: 'https://r.example.test/?u=zq7dns' },
      ],
    });
    const r = unknownRoot([leaf, intermediate]);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      reason: 'untrusted-root',
      issuer: 'CN=Hoster CA, OU=https://ca.example.test/cps?[redacted]',
      names: 'www.example.test, [redacted]',
    });
    expect(JSON.stringify(r)).not.toContain('zq7');
  });
});

describe('counterexample: a typical public chain is stored as the certificate names it', () => {
  it('names and alternative names unchanged; TLS-02 pairs leaf and issuer', async () => {
    const [leaf, intermediate] = await chainOf({
      root: 'C=US, O=Internet Security Research Group, CN=ISRG Root X1',
      intermediate: "C=US, O=Let's Encrypt, CN=R11",
      leaf: 'CN=www.example.test',
      altNames: [
        { type: 'dns', value: 'www.example.test' },
        { type: 'dns', value: 'example.test' },
      ],
    });

    expect(leaf).toMatchObject({
      subject: 'CN=www.example.test',
      issuer: "C=US, O=Let's Encrypt, CN=R11",
      subjectAltNames: ['DNS:www.example.test', 'DNS:example.test'],
    });
    expect(intermediate).toMatchObject({
      subject: "C=US, O=Let's Encrypt, CN=R11",
      issuer: 'C=US, O=Internet Security Research Group, CN=ISRG Root X1',
      subjectAltNames: [],
    });
    expect(observationsOf(unknownRoot([leaf, intermediate]))[0]?.params).toMatchObject({
      reason: 'untrusted-root',
      names: 'www.example.test, example.test',
    });
  });

  it.each([
    [
      'C=US, ST=Arizona, O=GoDaddy.com\\, Inc., OU=http://certs.godaddy.com/repository/, CN=Go Daddy Secure Certificate Authority - G2',
      'C=US, ST=Arizona, O=GoDaddy.com\\, Inc., OU=http://certs.godaddy.com/repository/, CN=Go Daddy Secure Certificate Authority - G2',
    ],
    ['O=A \\+ B GmbH, CN=www.example.test', 'O=A \\+ B GmbH, CN=www.example.test'],
    ['O=Firma \\"Schmidt\\" GmbH, L=München', 'O=Firma \\"Schmidt\\" GmbH, L=München'],
  ])('escaped characters without an address stay as Node writes them: %s', async (name, stored) => {
    expect((await selfSigned(name)).subject).toBe(stored);
  });

  it.each([
    'C=US, O=thawte\\, Inc., OU=Certification Services Division, OU=(c) 2006 thawte\\, Inc. - For authorized use only, CN=thawte Primary Root CA',
    'C=US, O=Entrust\\, Inc., OU=See www.entrust.net/legal-terms, OU=(c) 2012 Entrust\\, Inc. - for authorized use only, CN=Entrust Certification Authority - L1K',
    'O=Example Software, OU=C# Developers, CN=www.example.test',
  ])('a name without a URL query or an address stays as Node writes it: %s', async (name) => {
    expect((await selfSigned(name)).subject).toBe(name);
  });

  it('DNS names of host shape are stored as written', async () => {
    const names = [
      'www.example.test',
      '*.example.test',
      'xn--mnchen-3ya.example.test',
      '_acme.example.test',
      'localhost',
    ];
    const info = await selfSigned(
      'CN=www.example.test',
      names.map((value) => ({ type: 'dns', value })),
    );
    expect(info.subjectAltNames).toEqual(names.map((n) => `DNS:${n}`));
  });
});
