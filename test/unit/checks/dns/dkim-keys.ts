/**
 * DKIM key records for fixtures, built without a key generator: a DER structure of the requested modulus size is all
 * the key-length analysis reads, and the bytes are fixed so fixtures stay stable. dkim.test.ts compares the parser with
 * keys from node:crypto as well.
 */

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

const tlv = (tag: number, content: readonly number[]): number[] => [
  tag,
  ...length(content.length),
  ...content,
];

/** A positive INTEGER with exactly `bits` significant bits (leading zero byte when the top bit is set). */
function modulus(bits: number): number[] {
  const bytes = Math.ceil(bits / 8);
  const body = Array.from({ length: bytes }, (_, i) => (i * 37 + 11) % 256);
  const topBits = bits - (bytes - 1) * 8;
  body[0] = (1 << (topBits - 1)) | ((body[0] ?? 0) & ((1 << (topBits - 1)) - 1));
  return (body[0] ?? 0) & 0x80 ? [0, ...body] : body;
}

const EXPONENT = [0x01, 0x00, 0x01];
const RSA_ENCRYPTION = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

export function rsaPkcs1Der(bits: number): number[] {
  return tlv(0x30, [...tlv(0x02, modulus(bits)), ...tlv(0x02, EXPONENT)]);
}

export function rsaSpkiDer(bits: number): number[] {
  const algorithm = tlv(0x30, [...RSA_ENCRYPTION, 0x05, 0x00]);
  return tlv(0x30, [...algorithm, ...tlv(0x03, [0x00, ...rsaPkcs1Der(bits)])]);
}

export const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');

/** `p=` of an RSA key with `bits` modulus bits, as SubjectPublicKeyInfo (what DKIM generators publish). */
export const rsaKey = (bits: number): string => base64(rsaSpkiDer(bits));

/** `p=` of an Ed25519 key (RFC 8463): the 32 raw bytes. */
export const ED25519_KEY = base64(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));

/** A DKIM key record as providers publish it. */
export const dkimRecord = (p: string, k = 'rsa'): string => `v=DKIM1; k=${k}; p=${p}`;
