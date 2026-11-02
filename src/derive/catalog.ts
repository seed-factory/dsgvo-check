/**
 * Own service catalog (Apache-2.0): data/services/*.yaml → validated, compiled matcher.
 * Loaded synchronously once per data dir; matching is pure.
 */
import { z } from 'zod';
import { DataError, DEFAULT_DATA_DIR, loadDataDir } from '../core/data.ts';
import type { RequestKind, ServiceCategory, ServiceInfo, TrackingStage } from './types.ts';

const CATEGORIES = [
  'analytics',
  'ads',
  'session-recording',
  'tag-manager',
  'cdn',
  'payment',
  'consent-provider',
  'fonts',
  'maps',
  'video',
  'captcha',
  'widget',
  'social',
  'reviews',
  'chat',
  'monitoring',
  'unknown',
] as const satisfies readonly ServiceCategory[];

const KINDS = [
  'library',
  'config',
  'hit',
  'embed',
  'stylesheet',
  'font',
  'tile',
  'image',
  'resource',
] as const satisfies readonly RequestKind[];

const STAGES = ['loaded', 'initialised', 'event-sent'] as const satisfies readonly TrackingStage[];

const HostSchema = z
  .string()
  .regex(/^[a-z0-9.-]+$/)
  .refine((h) => !h.startsWith('.') && !h.endsWith('.'), 'host must not start or end with a dot');

const PartySchema = z
  .object({
    name: z.string().min(1),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
  })
  .strict();

const RegexSchema = z.string().refine((s) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}, 'invalid regular expression');

const SignatureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** Vendor hosts (exact host or domain suffix). */
    hosts: z.array(HostSchema).default([]),
    /** Also match on any other host (first-party proxy, tag gateway, self-hosted install). */
    anyHost: z.boolean().default(false),
    /** Regex tested against the URL path. */
    path: RegexSchema,
    /** Regex per query parameter value (only allowlisted values survive sanitizing, e.g. `id`, `tid`). */
    query: z.record(z.string(), RegexSchema).optional(),
    /** Query parameters that must be present (values may be redacted). */
    queryHas: z.array(z.string()).optional(),
    kind: z.enum(KINDS),
    stage: z.enum(STAGES).optional(),
    integration: z.string().optional(),
    /** Parameter names that carry a user/device identifier (presence only; values are redacted). */
    identifierParams: z.array(z.string()).optional(),
  })
  .strict()
  .refine((s) => s.anyHost || s.hosts.length > 0, 'signature needs hosts or anyHost');

const ServiceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    category: z.enum(CATEGORIES),
    policyRelevance: z.enum(['required', 'optional', 'none']),
    provider: PartySchema.optional(),
    parent: PartySchema.optional(),
    dpfEntity: z
      .object({
        name: z.string().min(1),
        listed: z.boolean().nullable().default(null),
        checkedAt: z.string().nullable().default(null),
        source: z.string().nullable().default(null),
      })
      .strict()
      .optional(),
    domains: z.array(HostSchema).default([]),
    signatures: z.array(SignatureSchema).default([]),
    /** Tracking identifier cookies: `name`, glob `name_*`, optional `@domain` restriction. */
    cookies: z.array(z.string().min(1)).default([]),
    /** Known cookies of the service that are not identifiers. */
    otherCookies: z.array(z.string().min(1)).default([]),
    /** Tracking identifier keys in local/session storage or IndexedDB names (same syntax as cookies). */
    storageKeys: z.array(z.string().min(1)).default([]),
    /** Consent Mode storage type relevant for cookieless pings. */
    consentStorage: z.enum(['ad', 'analytics']).optional(),
    selfHostable: z.boolean().default(false),
    aliasesDe: z.array(z.string().min(2)).default([]),
    aliasesEn: z.array(z.string().min(2)).default([]),
    companyAliases: z.array(z.string().min(2)).default([]),
    categoryTerms: z.array(z.string().min(2)).default([]),
    notes: z.string().optional(),
  })
  .strict();

const PatternMapSchema = z.record(z.string(), z.array(z.string().min(1)));

const CatalogFileSchema = z
  .object({
    catalog: z
      .object({
        name: z.string(),
        version: z.string(),
        date: z.string(),
        license: z.string(),
        attribution: z.string().optional(),
        draft: z.boolean().default(true),
      })
      .strict(),
    categories: z.record(
      z.enum(CATEGORIES),
      z.object({ de: z.array(z.string().min(2)), en: z.array(z.string().min(2)) }).strict(),
    ),
    services: z.array(ServiceSchema),
    allowlist: z
      .object({
        version: z.string(),
        cookies: PatternMapSchema,
        storage: PatternMapSchema.default({}),
      })
      .strict(),
  })
  .strict();

export type ServiceEntry = z.infer<typeof ServiceSchema>;
export type SignatureEntry = z.infer<typeof SignatureSchema>;
export type CatalogData = z.infer<typeof CatalogFileSchema>;

/** Name pattern (`_ga`, `_ga_*`, `fr@facebook.com`). */
interface NamePattern {
  re: RegExp;
  /** Length of the literal part (more specific wins). */
  literal: number;
  domain: string | null;
}

interface CompiledSignature {
  service: ServiceEntry;
  sig: SignatureEntry;
  path: RegExp;
  query: Array<[string, RegExp]>;
}

export interface RequestMatch {
  service: ServiceEntry;
  signature: SignatureEntry | null;
  /** `host` (vendor host signature), `any-host` (path signature on another host) or `domain`. */
  via: 'host' | 'any-host' | 'domain';
}

export interface NameMatch {
  service: ServiceEntry;
  tracking: boolean;
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function compileName(pattern: string, flags = ''): NamePattern {
  const at = pattern.lastIndexOf('@');
  const name = at > 0 ? pattern.slice(0, at) : pattern;
  const domain = at > 0 ? pattern.slice(at + 1).toLowerCase() : null;
  const re = new RegExp(
    `^${name
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    flags,
  );
  return { re, literal: name.replace(/\*/g, '').length, domain };
}

function nameMatches(p: NamePattern, name: string, domain: string | null): boolean {
  if (!p.re.test(name)) return false;
  if (p.domain === null) return true;
  return domain !== null && hostMatches(domain, p.domain);
}

/** Compiled catalog: lookup tables for hosts, signatures, cookie and storage names. */
export class ServiceCatalog {
  readonly data: CatalogData;
  readonly byId: ReadonlyMap<string, ServiceEntry>;
  readonly #domainIndex = new Map<string, ServiceEntry[]>();
  readonly #hostSignatures = new Map<string, CompiledSignature[]>();
  readonly #anyHostSignatures: CompiledSignature[] = [];
  readonly #cookiePatterns: Array<{ p: NamePattern; service: ServiceEntry; tracking: boolean }> = [];
  readonly #storagePatterns: Array<{ p: NamePattern; service: ServiceEntry; tracking: boolean }> = [];
  readonly #allowCookies: Array<{ p: NamePattern; cls: string }> = [];
  readonly #allowStorage: Array<{ p: NamePattern; cls: string }> = [];

  constructor(data: CatalogData) {
    this.data = data;
    const byId = new Map<string, ServiceEntry>();
    for (const s of data.services) {
      if (byId.has(s.id)) throw new DataError(`services: duplicate service id "${s.id}"`);
      byId.set(s.id, s);
      for (const d of s.domains) this.#domainIndex.set(d, [...(this.#domainIndex.get(d) ?? []), s]);
      for (const sig of s.signatures) {
        const compiled: CompiledSignature = {
          service: s,
          sig,
          path: new RegExp(sig.path),
          query: Object.entries(sig.query ?? {}).map(([k, v]) => [k, new RegExp(v)]),
        };
        for (const h of sig.hosts)
          this.#hostSignatures.set(h, [...(this.#hostSignatures.get(h) ?? []), compiled]);
        if (sig.anyHost) this.#anyHostSignatures.push(compiled);
      }
      for (const c of s.cookies) this.#cookiePatterns.push({ p: compileName(c), service: s, tracking: true });
      for (const c of s.otherCookies)
        this.#cookiePatterns.push({ p: compileName(c), service: s, tracking: false });
      for (const k of s.storageKeys)
        this.#storagePatterns.push({ p: compileName(k), service: s, tracking: true });
    }
    this.byId = byId;
    for (const [cls, list] of Object.entries(data.allowlist.cookies))
      for (const n of list) this.#allowCookies.push({ p: compileName(n, 'i'), cls });
    for (const [cls, list] of Object.entries(data.allowlist.storage))
      for (const n of list) this.#allowStorage.push({ p: compileName(n, 'i'), cls });
  }

  get version(): string {
    return this.data.catalog.version;
  }

  get allowlistVersion(): string {
    return this.data.allowlist.version;
  }

  /**
   * Classify a URL: vendor-host signature > any-host signature > longest domain suffix.
   * Hosts with signatures of several services fall back to the domain index when no signature matches.
   */
  matchUrl(url: URL): RequestMatch | null {
    const host = url.hostname.toLowerCase();
    const labels = host.split('.');
    const suffixes = labels.map((_, i) => labels.slice(i).join('.'));
    for (const suffix of suffixes) {
      for (const c of this.#hostSignatures.get(suffix) ?? []) {
        if (signatureMatches(c, url)) return { service: c.service, signature: c.sig, via: 'host' };
      }
    }
    for (const c of this.#anyHostSignatures) {
      if (signatureMatches(c, url)) return { service: c.service, signature: c.sig, via: 'any-host' };
    }
    for (const suffix of suffixes) {
      const entries = this.#domainIndex.get(suffix);
      if (entries?.[0]) return { service: entries[0], signature: null, via: 'domain' };
    }
    return null;
  }

  /** Service of a cookie by name (and cookie domain for `@domain` patterns); most specific pattern wins. */
  matchCookie(name: string, domain: string | null): NameMatch | null {
    return bestName(this.#cookiePatterns, name, domain);
  }

  matchStorage(key: string, originHost: string | null): NameMatch | null {
    return bestName(this.#storagePatterns, key, originHost);
  }

  allowlistedCookie(name: string): string | null {
    return this.#allowCookies.find((a) => a.p.re.test(name))?.cls ?? null;
  }

  allowlistedStorage(key: string): string | null {
    return this.#allowStorage.find((a) => a.p.re.test(key))?.cls ?? null;
  }

  /** Category terms (de + en) for a category. */
  categoryTerms(category: ServiceCategory): string[] {
    const c = this.data.categories[category];
    return c ? [...c.de, ...c.en] : [];
  }

  /** Check-facing fields of a catalog entry. */
  info(id: string): ServiceInfo | null {
    const s = this.byId.get(id);
    if (!s) return null;
    const company = new Set<string>(s.companyAliases);
    for (const party of [s.provider, s.parent]) if (party) company.add(party.name);
    const info: ServiceInfo = {
      serviceId: s.id,
      name: s.name,
      category: s.category,
      policyRelevance: s.policyRelevance,
      aliasesDe: s.aliasesDe,
      aliasesEn: s.aliasesEn,
      companyAliases: [...company],
      domains: s.domains,
      categoryTerms: [...new Set([...this.categoryTerms(s.category), ...s.categoryTerms])],
      selfHostable: s.selfHostable,
    };
    if (s.provider) info.provider = s.provider;
    if (s.parent) info.parent = s.parent;
    if (s.dpfEntity) info.dpfEntity = s.dpfEntity;
    return info;
  }
}

function signatureMatches(c: CompiledSignature, url: URL): boolean {
  if (!c.path.test(url.pathname)) return false;
  for (const [k, re] of c.query) {
    const v = url.searchParams.get(k);
    if (v === null || !re.test(v)) return false;
  }
  for (const k of c.sig.queryHas ?? []) if (!url.searchParams.has(k)) return false;
  return true;
}

function bestName(
  patterns: ReadonlyArray<{ p: NamePattern; service: ServiceEntry; tracking: boolean }>,
  name: string,
  domain: string | null,
): NameMatch | null {
  let best: { p: NamePattern; service: ServiceEntry; tracking: boolean } | null = null;
  for (const entry of patterns) {
    if (!nameMatches(entry.p, name, domain)) continue;
    const score = entry.p.literal + (entry.p.domain ? 1000 : 0);
    const bestScore = best ? best.p.literal + (best.p.domain ? 1000 : 0) : -1;
    if (score > bestScore) best = entry;
  }
  return best ? { service: best.service, tracking: best.tracking } : null;
}

export function parseCatalog(raw: unknown): CatalogData {
  const res = CatalogFileSchema.safeParse(raw);
  if (!res.success) {
    throw new DataError(
      `data/services: ${res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return res.data;
}

const cache = new Map<string, ServiceCatalog>();

/** Load and compile data/services/*.yaml (cached per data dir). */
export function loadServiceCatalog(dataDir: string = DEFAULT_DATA_DIR): ServiceCatalog {
  let c = cache.get(dataDir);
  if (!c) {
    c = new ServiceCatalog(parseCatalog(loadDataDir('services', dataDir)));
    cache.set(dataDir, c);
  }
  return c;
}
