/**
 * DKIM (RFC 6376) for MAIL-03: which selectors a mail domain is probed on, the key record's tag list and the key
 * length read from its DER structure. Pure; the collector queries the plan, the check reads the answers. Everything
 * here reads data a third party published, so nothing throws: what cannot be read is `unparsable`.
 */
import type { DkimPlanEntry, DkimSelectorReason, DnsQueryRecord } from '../../../core/snapshot/dns.ts';
import { type DnsLookup, isFailure, type MxState, mxState, normalizeName, txtValues } from './records.ts';
import { analyzeSpf, type SpfAnalysis } from './spf.ts';

/** A mail provider recognised by its MX host and its SPF include (test/data/dns/dkim.yaml). */
export interface DkimProvider {
  id: string;
  /** MX host names or their parent names (`mail.protection.outlook.com` matches `<tenant>.mail.protection.outlook.com`). */
  mx: readonly string[];
  /** SPF include or redirect targets, exact names. */
  spfIncludes: readonly string[];
  selectors: readonly string[];
  /** The provider always signs with these selectors; false when the customer can choose another one. */
  fixed: boolean;
}

export interface DkimRules {
  providers: readonly DkimProvider[];
  commonSelectors: readonly string[];
}

export const dkimQname = (selector: string, domain: string): string =>
  `${normalizeName(selector)}._domainkey.${normalizeName(domain)}`;

/** What MX and SPF say about a domain's mail, read from answers already collected. */
export interface DkimSignals {
  mx: MxState;
  mxHosts: string[];
  spf: SpfAnalysis['state'];
  /** The SPF answer is known and its tree resolved; otherwise a provider's include may be missing from `spfIncludes`. */
  spfComplete: boolean;
  /** Include and redirect targets anywhere in the SPF tree. */
  spfIncludes: string[];
  /** Why no selector is probed: the domain takes no mail (Null MX), or shows no mail records at all. */
  skip: 'null-mx' | 'no-mail-records' | null;
}

function spfTargets(spf: SpfAnalysis): string[] {
  const own = (spf.record?.mechanisms ?? []).filter((m) => m.name === 'include').map((m) => m.value ?? '');
  // Every other TXT query of the tree was asked for an include or a redirect, also of a nested record.
  const nested = spf.queries.filter((q) => q !== spf.query && q.type === 'TXT').map((q) => q.qname);
  const redirect = spf.record?.redirect ? [spf.record.redirect] : [];
  return [...new Set([...own, ...redirect, ...nested].filter(Boolean).map(normalizeName))];
}

export function dkimSignals(domain: string, lookup: DnsLookup): DkimSignals {
  const mxQuery = lookup(domain, 'MX');
  const mx = mxState(mxQuery);
  const spf = analyzeSpf(domain, lookup);
  const mxHosts = (mxQuery?.answers ?? []).filter((a) => a.type === 'MX').map((a) => normalizeName(a.value));
  let skip: DkimSignals['skip'] = null;
  if (mx === 'null') skip = 'null-mx';
  else if (mx === 'none' && spf.state === 'none') skip = 'no-mail-records';
  return {
    mx,
    mxHosts,
    spf: spf.state,
    spfComplete: spf.state === 'none' || spf.state === 'multiple' || (spf.state === 'found' && spf.complete),
    spfIncludes: spfTargets(spf),
    skip,
  };
}

const underName = (host: string, name: string) => host === name || host.endsWith(`.${name}`);

/** Providers whose MX host and SPF include both point at them: an MX alone may only receive, an include only send. */
export function recognizedProviders(signals: DkimSignals, rules: DkimRules): DkimProvider[] {
  return rules.providers.filter(
    (p) =>
      signals.mxHosts.some((h) => p.mx.some((m) => underName(h, normalizeName(m)))) &&
      signals.spfIncludes.some((i) => p.spfIncludes.some((s) => i === normalizeName(s))),
  );
}

/** Configured selectors that apply to `domain`: `selector` for every domain, `domain/selector` for that one. */
export function operatorSelectorsFor(domain: string, configured: readonly string[]): string[] {
  const d = normalizeName(domain);
  return configured.flatMap((entry) => {
    const slash = entry.indexOf('/');
    if (slash === -1) return [entry];
    return normalizeName(entry.slice(0, slash)) === d ? [entry.slice(slash + 1)] : [];
  });
}

export interface DkimPlanInput {
  domain: string;
  signals: DkimSignals;
  operatorSelectors: readonly string[];
  maxSelectors: number;
  rules: DkimRules;
}

/**
 * Selectors in query order: the operator's, then those of a recognised provider, then common names; each once with its
 * first reason, at most `maxSelectors` to query. A given selector over the cap is kept as `capped`, any other one is
 * left out. Empty when the domain is not probed (`signals.skip`).
 */
export function planDkimSelectors(i: DkimPlanInput): DkimPlanEntry[] {
  if (i.signals.skip) return [];
  const domain = normalizeName(i.domain);
  const out: DkimPlanEntry[] = [];
  let queried = 0;
  const add = (selector: string, reason: DkimSelectorReason, given: boolean) => {
    const s = normalizeName(selector);
    if (!s || out.some((e) => e.selector === s)) return;
    if (queried < i.maxSelectors) {
      queried++;
      out.push({ domain, selector: s, reason, given });
    } else if (given) {
      out.push({ domain, selector: s, reason, given, capped: true });
    }
  };

  for (const s of operatorSelectorsFor(domain, i.operatorSelectors)) add(s, 'operator', true);
  for (const p of recognizedProviders(i.signals, i.rules)) {
    for (const s of p.selectors) add(s, `provider:${p.id}`, p.fixed);
  }
  for (const s of i.rules.commonSelectors) add(s, 'common', false);
  return out;
}

const TAG = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * RFC 6376 §3.2 tag list: `name=value` separated by `;`, whitespace around names and values ignored, names
 * case-sensitive. A duplicate name, an empty part other than after a trailing `;`, or a part that is no tag makes the
 * whole list invalid (null).
 */
export function parseDkimTags(raw: string): ReadonlyMap<string, string> | null {
  const tags = new Map<string, string>();
  const parts = raw.split(';');
  for (const [i, part] of parts.entries()) {
    if (part.trim() === '') {
      if (i === parts.length - 1 && i > 0) continue;
      return null;
    }
    const eq = part.indexOf('=');
    if (eq === -1) return null;
    const name = part.slice(0, eq).trim();
    if (!TAG.test(name) || tags.has(name)) return null;
    tags.set(name, part.slice(eq + 1).trim());
  }
  return tags;
}

/**
 * A TXT answer at a selector name that is meant as a key record: it starts with a DKIM version tag, or it starts with
 * another tag and has a `p=` tag. Verification tokens, SPF or DMARC text from a wildcard record are not.
 */
export function isDkimCandidate(txt: string): boolean {
  const first = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=([^;]*)/.exec(txt);
  // Any DKIM version stays ("DKIM1.0", a quoted "DKIM1"): one the parser cannot read is an unreadable key, never an
  // absent one.
  if (first && (first[1] as string).toLowerCase() === 'v') return /^\s*"?\s*dkim/i.test(first[2] as string);
  return /(?:^|;)\s*p\s*=/i.test(txt);
}

/** Standard base64 with whitespace removed (TXT chunks, folded lines); null when it is not base64. */
export function decodeBase64(s: string): Uint8Array | null {
  const compact = s.replace(/\s+/g, '');
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    const binary = atob(compact);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

/** One DER element inside `[at, limit)`; null when its header or length does not fit. */
function readTlv(b: Uint8Array, at: number, limit: number): Tlv | null {
  if (at + 2 > limit) return null;
  const tag = b[at] as number;
  let len = b[at + 1] as number;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    // Indefinite length is not DER; four length bytes are far more than any key needs.
    if (n === 0 || n > 4 || p + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (b[p++] as number);
  }
  if (p + len > limit) return null;
  return { tag, start: p, end: p + len };
}

/** Significant bits of a positive INTEGER (leading zero bytes do not count); null for zero or a negative value. */
function integerBits(b: Uint8Array, t: Tlv): number | null {
  if (t.end <= t.start || ((b[t.start] as number) & 0x80) !== 0) return null;
  let i = t.start;
  while (i < t.end && b[i] === 0) i++;
  if (i === t.end) return null;
  return (t.end - i - 1) * 8 + (32 - Math.clz32(b[i] as number));
}

/** PKCS#1 RSAPublicKey: SEQUENCE { modulus INTEGER, publicExponent INTEGER }. */
function rsaPublicKeyBits(b: Uint8Array, seq: Tlv): number | null {
  if (seq.tag !== 0x30) return null;
  const modulus = readTlv(b, seq.start, seq.end);
  if (modulus?.tag !== 0x02) return null;
  const exponent = readTlv(b, modulus.end, seq.end);
  if (exponent?.tag !== 0x02 || exponent.end !== seq.end || integerBits(b, exponent) === null) {
    return null;
  }
  return integerBits(b, modulus);
}

/** DER of the OID 1.2.840.113549.1.1.1 (rsaEncryption). */
const RSA_ENCRYPTION = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const NULL_PARAMETERS = [0x05, 0x00];

/** AlgorithmIdentifier { rsaEncryption, NULL } (RFC 3279 §2.3.1); the parameters may be left out, nothing else. */
function isRsaAlgorithm(b: Uint8Array, algorithm: Tlv): boolean {
  const at = (bytes: readonly number[], from: number) => bytes.every((v, i) => b[from + i] === v);
  if (algorithm.tag !== 0x30 || !at(RSA_ENCRYPTION, algorithm.start)) return false;
  const rest = algorithm.end - (algorithm.start + RSA_ENCRYPTION.length);
  return rest === 0 || (rest === NULL_PARAMETERS.length && at(NULL_PARAMETERS, algorithm.end - rest));
}

/**
 * Modulus length of an RSA public key as DKIM publishes it: SubjectPublicKeyInfo (what key generators write) or a bare
 * PKCS#1 RSAPublicKey (RFC 6376 §3.6.1). Null for anything else, also for truncated input or trailing bytes.
 */
export function rsaModulusBits(der: Uint8Array): number | null {
  const outer = readTlv(der, 0, der.length);
  if (outer?.tag !== 0x30 || outer.end !== der.length) return null;
  const first = readTlv(der, outer.start, outer.end);
  if (!first) return null;
  if (first.tag === 0x02) return rsaPublicKeyBits(der, outer);

  if (!isRsaAlgorithm(der, first)) return null;
  const bits = readTlv(der, first.end, outer.end);
  if (bits?.tag !== 0x03 || bits.end !== outer.end || bits.end - bits.start < 2) return null;
  // The first content byte of a BIT STRING counts unused bits; a key fills whole bytes.
  if (der[bits.start] !== 0) return null;
  const key = readTlv(der, bits.start + 1, bits.end);
  if (!key || key.end !== bits.end) return null;
  return rsaPublicKeyBits(der, key);
}

/** Ed25519 public keys are 32 raw bytes in `p=` (RFC 8463). */
const ED25519_BYTES = 32;

export type DkimKey =
  | { kind: 'rsa'; bits: number }
  | { kind: 'ed25519' }
  /** `p=` is empty: the key was withdrawn (RFC 6376 §3.6.1). */
  | { kind: 'revoked' }
  | { kind: 'unparsable'; reason: 'syntax' | 'version' | 'no-key' | 'key-type' | 'key-data' };

/** The key a record publishes. `v=`, if present, must be the first tag and `DKIM1`; `k=` defaults to `rsa`. */
export function parseDkimKey(txt: string): DkimKey {
  const tags = parseDkimTags(txt);
  if (!tags) return { kind: 'unparsable', reason: 'syntax' };
  const names = [...tags.keys()];
  if (tags.has('v') && (names[0] !== 'v' || tags.get('v') !== 'DKIM1')) {
    return { kind: 'unparsable', reason: 'version' };
  }
  const p = tags.get('p');
  if (p === undefined) return { kind: 'unparsable', reason: 'no-key' };
  if (p.replace(/\s+/g, '') === '') return { kind: 'revoked' };

  const k = tags.get('k') ?? 'rsa';
  if (k !== 'rsa' && k !== 'ed25519') return { kind: 'unparsable', reason: 'key-type' };
  const bytes = decodeBase64(p);
  if (!bytes) return { kind: 'unparsable', reason: 'key-data' };
  if (k === 'ed25519') {
    return bytes.length === ED25519_BYTES ? { kind: 'ed25519' } : { kind: 'unparsable', reason: 'key-data' };
  }
  const bits = rsaModulusBits(bytes);
  return bits === null ? { kind: 'unparsable', reason: 'key-data' } : { kind: 'rsa', bits };
}

/** What one planned selector answered. */
export type DkimSelectorState =
  /** At least one readable key; `rsaBits` lists the RSA keys (an Ed25519 key has no RSA length). */
  | { state: 'key'; rsaBits: number[] }
  /** Only withdrawn keys (empty `p=`). */
  | { state: 'revoked' }
  /** NXDOMAIN, NODATA or no key record among the TXT answers. */
  | { state: 'absent' }
  /** A key record, but none of its keys could be read. */
  | { state: 'unparsable' }
  /** SERVFAIL, TIMEOUT or another failure after the retry: the answer is unknown. */
  | { state: 'failed' }
  /** Not queried (budget, abort). */
  | { state: 'pending' }
  /** A given selector over `dns.dkimMaxSelectors`: not queried on purpose. */
  | { state: 'capped' };

export interface DkimSelectorResult {
  entry: DkimPlanEntry;
  query: DnsQueryRecord | undefined;
  result: DkimSelectorState;
}

function selectorState(q: DnsQueryRecord | undefined): DkimSelectorState {
  if (!q) return { state: 'pending' };
  if (isFailure(q.rcode)) return { state: 'failed' };
  const keys = txtValues(q).filter(isDkimCandidate).map(parseDkimKey);
  if (keys.length === 0) return { state: 'absent' };
  const readable = keys.filter((k) => k.kind === 'rsa' || k.kind === 'ed25519');
  if (readable.length > 0) {
    return { state: 'key', rsaBits: readable.flatMap((k) => (k.kind === 'rsa' ? [k.bits] : [])) };
  }
  return keys.some((k) => k.kind === 'unparsable') ? { state: 'unparsable' } : { state: 'revoked' };
}

/** The answer of every planned selector of `domain`, in plan order. */
export function analyzeDkim(
  domain: string,
  plan: readonly DkimPlanEntry[],
  lookup: DnsLookup,
): DkimSelectorResult[] {
  const d = normalizeName(domain);
  return plan
    .filter((e) => normalizeName(e.domain) === d)
    .map((entry) => {
      const query = lookup(dkimQname(entry.selector, d), 'TXT');
      const result: DkimSelectorState = entry.capped && !query ? { state: 'capped' } : selectorState(query);
      return { entry, query, result };
    });
}
