/**
 * SPF (RFC 7208) record parser and a static analysis of the include/redirect tree: lookup count (≤ 10, §4.6.4),
 * void lookups (≤ 2), loops, nested records, the effective `all` qualifier and `ptr`. No evaluation for a client IP.
 * Pure; the collector resolves `pending` queries until the analysis is complete.
 */
import type { DnsQueryRecord, DnsRecordType } from '../../../collectors/dns/types.ts';
import {
  type DnsLookup,
  isFailure,
  isVoid,
  normalizeName,
  type PendingQuery,
  queryKey,
  txtValues,
} from './records.ts';

export type SpfQualifier = '+' | '-' | '~' | '?';
export type SpfMechanismName = 'all' | 'include' | 'a' | 'mx' | 'ptr' | 'ip4' | 'ip6' | 'exists';

export interface SpfMechanism {
  qualifier: SpfQualifier;
  name: SpfMechanismName;
  /** Domain-spec (a/mx: without the CIDR suffix) or IP network as written; null when the term has none. */
  value: string | null;
  raw: string;
}

export interface SpfRecord {
  raw: string;
  mechanisms: SpfMechanism[];
  redirect: string | null;
  exp: string | null;
  /** `<code>:<term>`; any entry makes the record a permerror. */
  errors: string[];
}

export const SPF_LOOKUP_LIMIT = 10;
export const SPF_VOID_LIMIT = 2;

const LOOKUP_MECHANISMS: ReadonlySet<SpfMechanismName> = new Set(['include', 'a', 'mx', 'ptr', 'exists']);

/** RFC 7208 §4.5: exactly `v=spf1` followed by a space or the end (ABNF literals are case-insensitive). */
export function isSpfRecord(txt: string): boolean {
  return /^v=spf1( |$)/i.test(txt);
}

/** Lenient: keeps near misses (`v=spf1-all`, leading space) so evidence shows them; unrelated TXT is dropped. */
export function isSpfCandidate(txt: string): boolean {
  return /^\s*v\s*=\s*spf/i.test(txt);
}

function validIp4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * RFC 4291 §2.2 text form (pure; `node:net` is not available to checks): 1–4 hex digits per group, at most one
 * `::` standing for at least one group, an optional dotted IPv4 tail counting as two groups, 8 groups in total.
 */
export function validIp6(s: string): boolean {
  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s)) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groupsOf = (part: string): string[] | null => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0] as string);
  const tail = halves.length === 2 ? groupsOf(halves[1] as string) : [];
  if (!head || !tail) return false;
  const groups = [...head, ...tail];
  let count = 0;
  for (const [i, g] of groups.entries()) {
    if (g.includes('.')) {
      // An IPv4 tail is only allowed as the very last group.
      if (i !== groups.length - 1 || !validIp4(g)) return false;
      count += 2;
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) {
      count += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? count <= 7 : count === 8;
}

function validCidr(s: string, max: number): boolean {
  return /^\d{1,3}$/.test(s) && Number(s) <= max;
}

function parseTerm(term: string, rec: SpfRecord): void {
  const mod = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
  if (mod) {
    const name = (mod[1] as string).toLowerCase();
    const value = mod[2] as string;
    if (name !== 'redirect' && name !== 'exp') return; // unknown modifiers are ignored (§6)
    if (rec[name] !== null) {
      rec.errors.push(`duplicate-modifier:${term}`);
      return;
    }
    if (!value) {
      rec.errors.push(`missing-domain:${term}`);
      return;
    }
    rec[name] = value;
    return;
  }
  const m = /^([+\-~?]?)([a-z][a-z0-9_.-]*)(.*)$/i.exec(term);
  const name = m?.[2]?.toLowerCase();
  if (!m || !name) {
    rec.errors.push(`unknown-mechanism:${term}`);
    return;
  }
  const qualifier = ((m[1] as string) || '+') as SpfQualifier;
  const rest = m[3] as string;
  const push = (value: string | null) =>
    rec.mechanisms.push({ qualifier, name: name as SpfMechanismName, value, raw: term });
  switch (name) {
    case 'all':
      if (rest) rec.errors.push(`invalid-all:${term}`);
      else push(null);
      return;
    case 'include':
    case 'exists':
      if (!rest.startsWith(':') || rest.length < 2) rec.errors.push(`missing-domain:${term}`);
      else push(rest.slice(1));
      return;
    case 'ptr':
      if (rest && (!rest.startsWith(':') || rest.length < 2)) rec.errors.push(`missing-domain:${term}`);
      else push(rest ? rest.slice(1) : null);
      return;
    case 'a':
    case 'mx': {
      const dm = /^(?::([^/]+))?(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(rest);
      if (!dm || (dm[2] && !validCidr(dm[2], 32)) || (dm[3] && !validCidr(dm[3], 128))) {
        rec.errors.push(`invalid-cidr:${term}`);
        return;
      }
      push(dm[1] ?? null);
      return;
    }
    case 'ip4':
    case 'ip6': {
      const [addr = '', cidr, extra] = rest.startsWith(':') ? rest.slice(1).split('/') : [''];
      const valid =
        extra === undefined &&
        (name === 'ip4' ? validIp4(addr) : validIp6(addr)) &&
        (cidr === undefined || validCidr(cidr, name === 'ip4' ? 32 : 128));
      if (!valid) rec.errors.push(`invalid-${name}:${term}`);
      else push(rest.slice(1));
      return;
    }
    default:
      rec.errors.push(`unknown-mechanism:${term}`);
  }
}

export function parseSpfRecord(raw: string): SpfRecord {
  const rec: SpfRecord = { raw, mechanisms: [], redirect: null, exp: null, errors: [] };
  const [version, ...terms] = raw.trim().split(/ +/);
  if (!version || !/^v=spf1$/i.test(version)) rec.errors.push(`syntax:${version ?? ''}`);
  for (const term of terms) if (term) parseTerm(term, rec);
  return rec;
}

export type SpfPermerrorReason =
  | 'syntax'
  | 'too-many-lookups'
  | 'void-lookups'
  | 'loop'
  | 'include-no-record'
  | 'redirect-no-record'
  | 'include-multiple-records'
  | 'redirect-multiple-records';

export interface SpfPermerror {
  reason: SpfPermerrorReason;
  /** Domain whose record (or lookup) causes the permerror. */
  domain: string;
  detail?: string;
}

export interface SpfAnalysis {
  /** Top-level state of `<domain> TXT`. */
  state: 'pending' | 'failed' | 'none' | 'multiple' | 'found';
  domain: string;
  query: DnsQueryRecord | null;
  /** `v=spf1` records at the domain. */
  records: string[];
  record: SpfRecord | null;
  /** Effective `all` qualifier (record or redirect chain; `?` by default); null = unknown or permerror. */
  all: SpfQualifier | null;
  allSource: 'record' | 'redirect' | 'default' | null;
  /** DNS-querying terms counted (stops at the first one over the limit). */
  lookups: number;
  voidLookups: number;
  permerrors: SpfPermerror[];
  /** `ptr` in the domain's own record or its redirect chain (deprecated, §5.5). */
  ptr: boolean;
  pending: PendingQuery[];
  /** Nested lookups that failed temporarily (include/redirect/void checks). */
  failures: DnsQueryRecord[];
  /** Every query record the analysis read (evidence). */
  queries: DnsQueryRecord[];
  /** True when nothing is pending and no nested lookup failed (or a limit already decided the result). */
  complete: boolean;
}

const hasMacro = (domain: string) => domain.includes('%');

class SpfWalker {
  lookups = 0;
  voidLookups = 0;
  stopped = false;
  ptr = false;
  readonly permerrors: SpfPermerror[] = [];
  readonly pending = new Map<string, PendingQuery>();
  readonly failures: DnsQueryRecord[] = [];
  readonly queries = new Map<string, DnsQueryRecord>();
  private readonly lookup: DnsLookup;

  constructor(lookup: DnsLookup) {
    this.lookup = lookup;
  }

  fetch(qname: string, type: DnsRecordType, purpose: string): DnsQueryRecord | undefined {
    const q = this.lookup(qname, type);
    if (!q) {
      const key = queryKey(qname, type);
      if (!this.pending.has(key)) this.pending.set(key, { qname: normalizeName(qname), type, purpose });
      return undefined;
    }
    this.queries.set(q.id, q);
    if (isFailure(q.rcode)) {
      if (!this.failures.includes(q)) this.failures.push(q);
      return undefined;
    }
    return q;
  }

  permerror(reason: SpfPermerrorReason, domain: string, detail?: string): void {
    this.permerrors.push({ reason, domain, ...(detail ? { detail } : {}) });
  }

  count(domain: string): boolean {
    this.lookups++;
    if (this.lookups > SPF_LOOKUP_LIMIT) {
      this.permerror('too-many-lookups', domain);
      this.stopped = true;
    }
    return !this.stopped;
  }

  void(q: DnsQueryRecord, domain: string): void {
    if (!isVoid(q)) return;
    this.voidLookups++;
    if (this.voidLookups > SPF_VOID_LIMIT) {
      this.permerror('void-lookups', domain);
      this.stopped = true;
    }
  }

  voidCheck(target: string, type: DnsRecordType, domain: string): void {
    if (hasMacro(target)) return;
    const q = this.fetch(target, type, 'spf-void-check');
    if (q) this.void(q, domain);
  }

  /**
   * Resolve and walk a referenced record. Returns its effective `all` (for redirect), `undefined` when unknown.
   */
  follow(
    target: string,
    kind: 'include' | 'redirect',
    path: readonly string[],
    owner: boolean,
  ): SpfQualifier | null | undefined {
    const t = normalizeName(target);
    if (hasMacro(t)) return undefined;
    if (path.includes(t)) {
      this.permerror('loop', t);
      return null;
    }
    const q = this.fetch(t, 'TXT', `spf-${kind}`);
    if (!q) return undefined;
    this.void(q, t);
    if (this.stopped) return null;
    const records = txtValues(q).filter(isSpfRecord);
    if (records.length === 0) {
      this.permerror(`${kind}-no-record`, t);
      return null;
    }
    if (records.length > 1) {
      this.permerror(`${kind}-multiple-records`, t);
      return null;
    }
    return this.visit(t, parseSpfRecord(records[0] as string), [...path, t], owner).all;
  }

  visit(
    domain: string,
    rec: SpfRecord,
    path: readonly string[],
    owner: boolean,
  ): { all: SpfQualifier | null | undefined; source: 'record' | 'redirect' | 'default' } {
    if (rec.errors.length > 0) {
      this.permerror('syntax', domain, rec.errors[0]);
      return { all: null, source: 'record' };
    }
    for (const m of rec.mechanisms) {
      if (this.stopped) return { all: null, source: 'record' };
      if (m.name === 'all') return { all: m.qualifier, source: 'record' };
      if (LOOKUP_MECHANISMS.has(m.name) && !this.count(domain)) return { all: null, source: 'record' };
      switch (m.name) {
        case 'include':
          this.follow(m.value as string, 'include', path, false);
          break;
        case 'a':
          this.voidCheck(m.value ?? domain, 'A', domain);
          break;
        case 'mx':
          this.voidCheck(m.value ?? domain, 'MX', domain);
          break;
        case 'exists':
          this.voidCheck(m.value as string, 'A', domain);
          break;
        case 'ptr':
          if (owner) this.ptr = true;
          break;
        default:
          break;
      }
    }
    if (this.stopped) return { all: null, source: 'record' };
    if (rec.redirect === null) return { all: '?', source: 'default' };
    if (!this.count(domain)) return { all: null, source: 'redirect' };
    return { all: this.follow(rec.redirect, 'redirect', path, owner), source: 'redirect' };
  }
}

export function analyzeSpf(domain: string, lookup: DnsLookup): SpfAnalysis {
  const d = normalizeName(domain);
  const out: SpfAnalysis = {
    state: 'pending',
    domain: d,
    query: null,
    records: [],
    record: null,
    all: null,
    allSource: null,
    lookups: 0,
    voidLookups: 0,
    permerrors: [],
    ptr: false,
    pending: [],
    failures: [],
    queries: [],
    complete: false,
  };
  const q = lookup(d, 'TXT');
  if (!q) {
    out.pending = [{ qname: d, type: 'TXT', purpose: 'spf' }];
    return out;
  }
  out.query = q;
  out.queries = [q];
  if (isFailure(q.rcode)) {
    out.state = 'failed';
    return out;
  }
  out.records = txtValues(q).filter(isSpfRecord);
  if (out.records.length === 0) {
    out.state = 'none';
    out.complete = true;
    return out;
  }
  if (out.records.length > 1) {
    out.state = 'multiple';
    out.complete = true;
    return out;
  }
  out.state = 'found';
  out.record = parseSpfRecord(out.records[0] as string);
  const walker = new SpfWalker(lookup);
  const result = walker.visit(d, out.record, [d], true);
  out.all = result.all ?? null;
  out.allSource = out.all === null ? null : result.source;
  out.lookups = walker.lookups;
  out.voidLookups = walker.voidLookups;
  out.permerrors = walker.permerrors;
  out.ptr = walker.ptr;
  out.failures = walker.failures;
  out.queries = [q, ...[...walker.queries.values()].filter((x) => x !== q)];
  out.pending = walker.stopped ? [] : [...walker.pending.values()];
  out.complete = walker.stopped || (out.pending.length === 0 && out.failures.length === 0);
  return out;
}
