/**
 * Test PKI (@peculiar/x509, WebCrypto P-256): one test CA plus leaf certificates for any host set. Node (undici,
 * node:tls) trusts `pki.caPem`, so expired / wrong-name / self-signed leaves give the real Node errors. Chromium uses
 * `--ignore-certificate-errors-spki-list=<pki.trustedSpki>`: valid leaves share ONE key pair, broken ones have their own.
 */
import 'reflect-metadata'; // required by @peculiar/x509 (tsyringe)
import { createHash, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 86_400_000;

export interface IssuedCert {
  certPem: string;
  keyPem: string;
  /** Leaf + CA (what the server sends). For self-signed: the leaf only. */
  chainPem: string;
  notBefore: Date;
  notAfter: Date;
  hosts: string[];
}

export type CertKind = 'valid' | 'expired' | 'wrong-name' | 'self-signed' | 'expiring';

export interface IssueOptions {
  /** DNS names in the SAN. */
  hosts: string[];
  notBefore?: Date;
  notAfter?: Date;
  /** Self-signed leaf with its own key (not chained to the test CA). */
  selfSigned?: boolean;
  /** Use a separate key pair (not covered by Chromium's SPKI allowlist). Default: false for valid leaves. */
  ownKey?: boolean;
  commonName?: string;
}

export interface TestPki {
  caPem: string;
  /** base64(sha256(SPKI)) of the shared leaf key, for `--ignore-certificate-errors-spki-list`. */
  trustedSpki: string;
  issue(opts: IssueOptions): Promise<IssuedCert>;
  /** Convenience presets used by fixture sites: valid, expired, wrong-name (*.alfahosting-server.de), self-signed, expiring (10 days). */
  issueKind(kind: CertKind, hosts: string[], now?: Date): Promise<IssuedCert>;
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function keyPem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

async function spkiHash(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('spki', key));
  return createHash('sha256').update(der).digest('base64');
}

let serial = 1;
const nextSerial = () => (serial++).toString(16).padStart(8, '0');

const daysFrom = (at: Date, days: number) => new Date(at.getTime() + days * DAY);

/** The test CA: self-signed, valid from a day ago for ten years. */
async function createCa(now: Date) {
  const keys = await keyPair();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: nextSerial(),
    name: 'CN=dsgvo-check Test CA, O=dsgvo-check tests',
    notBefore: daysFrom(now, -1),
    notAfter: daysFrom(now, 3650),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { keys, cert };
}

/** What every leaf carries: the host names as SAN, no CA rights, server authentication only. */
async function leafExtensions(hosts: string[], publicKey: CryptoKey): Promise<x509.Extension[]> {
  return [
    new x509.SubjectAlternativeNameExtension(hosts.map((h) => ({ type: 'dns' as const, value: h }))),
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    await x509.SubjectKeyIdentifierExtension.create(publicKey),
  ];
}

interface Validity {
  notBefore: Date;
  notAfter: Date;
}

function createSelfSignedLeaf(cn: string, v: Validity, keys: CryptoKeyPair, extensions: x509.Extension[]) {
  return x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: nextSerial(),
    name: `CN=${cn}`,
    ...v,
    keys,
    signingAlgorithm: ALG,
    extensions,
  });
}

/** Issue options per certificate kind; `at` is the moment the validity dates are relative to. */
const KIND_OPTIONS: Record<CertKind, (hosts: string[], at: Date) => IssueOptions> = {
  valid: (hosts) => ({ hosts }),
  expiring: (hosts, at) => ({ hosts, notBefore: daysFrom(at, -80), notAfter: daysFrom(at, 10) }),
  // Its own key: Chromium's SPKI allowlist must not cover a broken certificate.
  expired: (hosts, at) => ({
    hosts,
    ownKey: true,
    notBefore: daysFrom(at, -400),
    notAfter: daysFrom(at, -10),
  }),
  'wrong-name': () => ({
    hosts: ['*.alfahosting-server.de'],
    ownKey: true,
    commonName: '*.alfahosting-server.de',
  }),
  'self-signed': (hosts) => ({ hosts, selfSigned: true }),
};

export async function createTestPki(now: Date = new Date()): Promise<TestPki> {
  const { keys: caKeys, cert: ca } = await createCa(now);
  const caPem = ca.toString('pem');
  const sharedLeaf = await keyPair();
  const sharedLeafPem = await keyPem(sharedLeaf.privateKey);
  const trustedSpki = await spkiHash(sharedLeaf.publicKey);

  async function createCaSignedLeaf(
    cn: string,
    v: Validity,
    publicKey: CryptoKey,
    extensions: x509.Extension[],
  ) {
    const authorityKey = await x509.AuthorityKeyIdentifierExtension.create(ca, false);
    return x509.X509CertificateGenerator.create({
      serialNumber: nextSerial(),
      subject: `CN=${cn}`,
      issuer: ca.subject,
      ...v,
      signingKey: caKeys.privateKey,
      publicKey,
      signingAlgorithm: ALG,
      extensions: [...extensions, authorityKey],
    });
  }

  async function issue(o: IssueOptions): Promise<IssuedCert> {
    const validity = {
      notBefore: o.notBefore ?? daysFrom(now, -1),
      notAfter: o.notAfter ?? daysFrom(now, 365),
    };
    const cn = o.commonName ?? o.hosts[0] ?? 'localhost';
    const leafKeys = o.selfSigned || o.ownKey ? await keyPair() : sharedLeaf;
    const extensions = await leafExtensions(o.hosts, leafKeys.publicKey);

    const cert = o.selfSigned
      ? await createSelfSignedLeaf(cn, validity, leafKeys, extensions)
      : await createCaSignedLeaf(cn, validity, leafKeys.publicKey, extensions);
    const certPem = cert.toString('pem');

    return {
      certPem,
      keyPem: leafKeys === sharedLeaf ? sharedLeafPem : await keyPem(leafKeys.privateKey),
      chainPem: o.selfSigned ? certPem : `${certPem}\n${caPem}`,
      ...validity,
      hosts: o.hosts,
    };
  }

  const issueKind = (kind: CertKind, hosts: string[], at: Date = now) => issue(KIND_OPTIONS[kind](hosts, at));

  return { caPem, trustedSpki, issue, issueKind };
}
