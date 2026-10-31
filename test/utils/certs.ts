/**
 * Test PKI (@peculiar/x509, WebCrypto P-256). One test CA plus leaf certificates for any host set.
 *
 * Trust model in L2:
 * - Node (undici, node:tls): trust `pki.caPem` via the `ca` option → expired / wrong-name / self-signed produce the
 *   real Node errors (CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, DEPTH_ZERO_SELF_SIGNED_CERT).
 * - Chromium: `--ignore-certificate-errors-spki-list=<pki.trustedSpki>` — all "good" leaves share ONE key pair,
 *   so a single SPKI hash covers every host. Broken certificates use their own keys and stay broken for Chromium.
 */
import 'reflect-metadata'; // required by @peculiar/x509 (tsyringe)
import { createHash, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

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

export async function createTestPki(now: Date = new Date()): Promise<TestPki> {
  const caKeys = await keyPair();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: nextSerial(),
    name: 'CN=dsgvo-check Test CA, O=dsgvo-check tests',
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + 3650 * DAY),
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const caPem = ca.toString('pem');
  const sharedLeaf = await keyPair();
  const sharedLeafPem = await keyPem(sharedLeaf.privateKey);
  const trustedSpki = await spkiHash(sharedLeaf.publicKey);

  async function issue(o: IssueOptions): Promise<IssuedCert> {
    const notBefore = o.notBefore ?? new Date(now.getTime() - DAY);
    const notAfter = o.notAfter ?? new Date(now.getTime() + 365 * DAY);
    const cn = o.commonName ?? o.hosts[0] ?? 'localhost';
    const leafKeys = o.selfSigned || o.ownKey ? await keyPair() : sharedLeaf;
    const extensions: x509.Extension[] = [
      new x509.SubjectAlternativeNameExtension(o.hosts.map((h) => ({ type: 'dns' as const, value: h }))),
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
    ];
    let cert: x509.X509Certificate;
    if (o.selfSigned) {
      cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: nextSerial(),
        name: `CN=${cn}`,
        notBefore,
        notAfter,
        keys: leafKeys,
        signingAlgorithm: ALG,
        extensions,
      });
    } else {
      extensions.push(await x509.AuthorityKeyIdentifierExtension.create(ca, false));
      cert = await x509.X509CertificateGenerator.create({
        serialNumber: nextSerial(),
        subject: `CN=${cn}`,
        issuer: ca.subject,
        notBefore,
        notAfter,
        signingKey: caKeys.privateKey,
        publicKey: leafKeys.publicKey,
        signingAlgorithm: ALG,
        extensions,
      });
    }
    const certPem = cert.toString('pem');
    return {
      certPem,
      keyPem: leafKeys === sharedLeaf ? sharedLeafPem : await keyPem(leafKeys.privateKey),
      chainPem: o.selfSigned ? certPem : `${certPem}\n${caPem}`,
      notBefore,
      notAfter,
      hosts: o.hosts,
    };
  }

  async function issueKind(kind: CertKind, hosts: string[], at: Date = now): Promise<IssuedCert> {
    switch (kind) {
      case 'valid':
        return issue({ hosts });
      case 'expiring':
        return issue({
          hosts,
          notBefore: new Date(at.getTime() - 80 * DAY),
          notAfter: new Date(at.getTime() + 10 * DAY),
        });
      case 'expired':
        return issue({
          hosts,
          ownKey: true,
          notBefore: new Date(at.getTime() - 400 * DAY),
          notAfter: new Date(at.getTime() - 10 * DAY),
        });
      case 'wrong-name':
        return issue({
          hosts: ['*.alfahosting-server.de'],
          ownKey: true,
          commonName: '*.alfahosting-server.de',
        });
      case 'self-signed':
        return issue({ hosts, selfSigned: true });
    }
  }

  return { caPem, trustedSpki, issue, issueKind };
}
