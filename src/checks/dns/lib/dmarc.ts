/**
 * DMARC record parser (RFC 9989 tags plus the legacy RFC 7489 `pct`) and the policy discovery Tree Walk. Pure; the
 * collector drives the walk with `analyzeDmarc(...).next`. The organizational domain comes from tldts, not a `psd` walk.
 */
import type { DnsQueryRecord } from '../../../core/snapshot/dns.ts';
import { type DnsLookup, isFailure, normalizeName, txtValues } from './records.ts';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type DmarcInvalidReason =
  | 'multiple-records'
  | 'version-not-first'
  | 'syntax'
  | 'p-missing'
  | 'p-invalid';

export interface DmarcRecord {
  raw: string;
  tags: Record<string, string>;
  p: DmarcPolicy | null;
  sp: DmarcPolicy | null;
  np: DmarcPolicy | null;
  psd: 'y' | 'n' | 'u' | null;
  t: 'y' | 'n' | null;
  /** Legacy RFC 7489 tag (removed in RFC 9989, still common). */
  pct: number | null;
  rua: string[];
  ruf: string[];
  /** Why receivers would ignore or reinterpret the record; null = usable. */
  invalid: DmarcInvalidReason | null;
}

/** RFC 9989 limits the walk; 8 is the cap (the RFC algorithm needs at most 5). */
export const DMARC_MAX_WALK = 8;

const POLICIES: ReadonlySet<string> = new Set(['none', 'quarantine', 'reject']);

function policy(v: string | undefined): DmarcPolicy | null {
  const x = v?.trim().toLowerCase();
  return x && POLICIES.has(x) ? (x as DmarcPolicy) : null;
}

function uriList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Starts with the version tag (strict: RFC 9989 discards everything else). */
export function isDmarcStart(txt: string): boolean {
  return /^\s*v\s*=\s*dmarc1\b/i.test(txt);
}

/** Contains a DMARC version tag anywhere (used to report records with a misplaced `v=`). */
export function isDmarcLike(txt: string): boolean {
  return /(^|;)\s*v\s*=\s*dmarc1\b/i.test(txt);
}

/** Splits `tag=value` pairs (the first occurrence of a tag wins) and notes the first syntax problem. */
function readTags(raw: string): { tags: Record<string, string>; problem: DmarcInvalidReason | null } {
  const tags: Record<string, string> = {};
  let problem: DmarcInvalidReason | null = null;
  const parts = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  parts.forEach((part, i) => {
    const m = /^([a-z0-9]+)\s*=\s*(.*)$/i.exec(part);
    if (!m) {
      problem ??= 'syntax';
      return;
    }

    const name = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (i === 0 && name !== 'v') problem ??= 'version-not-first';
    if (name === 'v' && value.toUpperCase() !== 'DMARC1') problem ??= 'syntax';
    if (!Object.hasOwn(tags, name)) tags[name] = value;
  });
  return { tags, problem };
}

/** The tag problem wins; otherwise the version must come first and `p` must be present and valid. */
function invalidReason(
  raw: string,
  tags: Record<string, string>,
  problem: DmarcInvalidReason | null,
): DmarcInvalidReason | null {
  if (problem !== null) return problem;
  if (!isDmarcStart(raw)) return 'version-not-first';
  if (tags.p === undefined) return 'p-missing';
  if (policy(tags.p) === null) return 'p-invalid';
  return null;
}

/** 0 to 100 as digits; anything else is ignored. */
function percentage(v: string | undefined): number | null {
  const x = v?.trim();
  return x && /^\d{1,3}$/.test(x) && Number(x) <= 100 ? Number(x) : null;
}

export function parseDmarcRecord(raw: string): DmarcRecord {
  const { tags, problem } = readTags(raw);
  const t = tags.t?.trim().toLowerCase();
  const psd = tags.psd?.trim().toLowerCase();

  return {
    raw,
    tags,
    p: policy(tags.p),
    sp: policy(tags.sp),
    np: policy(tags.np),
    psd: psd === 'y' || psd === 'n' || psd === 'u' ? psd : null,
    t: t === 'y' || t === 'n' ? t : null,
    pct: percentage(tags.pct),
    rua: uriList(tags.rua),
    ruf: uriList(tags.ruf),
    invalid: invalidReason(raw, tags, problem),
  };
}

/**
 * RFC 9989 §4.10: start at the host; with ≥ 5 labels jump to the last 4, otherwise drop the left-most label; then drop
 * one label at a time down to the TLD (public suffixes may publish a PSD policy).
 */
export function dmarcTreeWalkNames(host: string): string[] {
  const labels = normalizeName(host).split('.').filter(Boolean);
  if (labels.length === 0) return [];

  const names = [labels.join('.')];
  let current = labels.length >= 5 ? labels.slice(-4) : labels.slice(1);
  while (current.length > 0 && names.length < DMARC_MAX_WALK) {
    names.push(current.join('.'));
    current = current.slice(1);
  }
  return names;
}

export interface DmarcWalkStep {
  step: number;
  domain: string;
  qname: string;
  query: DnsQueryRecord;
}

export type DmarcScope = 'host' | 'intermediate' | 'org' | 'psd';

export interface DmarcFound {
  step: DmarcWalkStep;
  records: string[];
  /** Parsed record; null when several records were published. */
  record: DmarcRecord | null;
  invalid: DmarcInvalidReason | null;
  scope: DmarcScope;
}

export interface DmarcAnalysis {
  state: 'found' | 'missing' | 'failed' | 'incomplete';
  host: string;
  orgDomain: string;
  steps: DmarcWalkStep[];
  /** Query failed after the retry: the walk stops with state `failed`; a parent's record never stands in. */
  failures: DmarcWalkStep[];
  found: DmarcFound | null;
  next: { qname: string; step: number } | null;
}

function scopeOf(domain: string, host: string, orgDomain: string): DmarcScope {
  if (domain === orgDomain) return 'org';
  if (domain === host) return 'host';
  if (domain.endsWith(`.${orgDomain}`)) return 'intermediate';
  return 'psd';
}

export function analyzeDmarc(host: string, orgDomain: string, lookup: DnsLookup): DmarcAnalysis {
  const h = normalizeName(host);
  const org = normalizeName(orgDomain);
  const out: DmarcAnalysis = {
    state: 'missing',
    host: h,
    orgDomain: org,
    steps: [],
    failures: [],
    found: null,
    next: null,
  };

  for (const [step, domain] of dmarcTreeWalkNames(h).entries()) {
    const qname = `_dmarc.${domain}`;
    const query = lookup(qname, 'TXT');
    if (!query) {
      out.state = 'incomplete';
      out.next = { qname, step };
      return out;
    }

    const s: DmarcWalkStep = { step, domain, qname, query };
    out.steps.push(s);
    if (isFailure(query.rcode)) {
      // the policy of this more specific name is unknown; a parent record must not stand in for it.
      out.failures.push(s);
      out.state = 'failed';
      return out;
    }

    const records = txtValues(query).filter(isDmarcLike);
    if (records.length === 0) continue;

    const record = records.length === 1 ? parseDmarcRecord(records[0] as string) : null;
    out.state = 'found';
    out.found = {
      step: s,
      records,
      record,
      invalid: record ? record.invalid : 'multiple-records',
      scope: scopeOf(domain, h, org),
    };
    return out;
  }

  out.state = 'missing';
  return out;
}

/** The domain's own DMARC policy for the SPF matrix (a PSD-only record does not count as the domain's own). */
export type DmarcEnforcement = DmarcPolicy | 'missing' | 'invalid' | 'unknown';

/**
 * The policy that applies to the walk's start: its own record's `p`, or for a subdomain that inherits the record of a
 * parent the subdomain policy `sp` (RFC 9989), falling back to `p`.
 */
export function dmarcEnforcement(a: DmarcAnalysis): DmarcEnforcement {
  if (a.state === 'failed' || a.state === 'incomplete') return 'unknown';
  if (!a.found || a.found.scope === 'psd') return 'missing';
  if (a.found.invalid || !a.found.record?.p) return 'invalid';
  const inherited = a.found.step.domain !== a.host;
  return inherited ? (a.found.record.sp ?? a.found.record.p) : a.found.record.p;
}
