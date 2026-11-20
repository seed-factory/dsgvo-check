/** Own service catalog (Apache-2.0): test/data/services/*.yaml compiled into a pure matcher, loaded once per data dir. */
import { z } from 'zod';
import { DataError, DEFAULT_DATA_DIR, loadDataDir } from '../core/data/load.ts';
import { dataSection } from '../core/data/parse.ts';
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

/** Whole host name as an anchored regular expression, for vendor hosts that vary by country (`www.google.<cc>`). */
const HostPatternSchema = RegexSchema.refine(
  (s) => s.startsWith('^') && s.endsWith('$'),
  'host pattern must be anchored with ^ and $',
);

const SignatureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    hosts: z.array(HostSchema).default([]),
    hostPatterns: z.array(HostPatternSchema).default([]),
    /** Also match on any other host (first-party proxy, tag gateway, self-hosted install). */
    anyHost: z.boolean().default(false),
    path: RegexSchema,
    /** Regex per query parameter value; only allowlisted values survive sanitizing. */
    query: z.record(z.string(), RegexSchema).optional(),
    kind: z.enum(KINDS),
    stage: z.enum(STAGES).optional(),
    integration: z.string().optional(),
    /** Parameter names that carry a user/device identifier (presence only; values are redacted). */
    identifierParams: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (s) => s.anyHost || s.hosts.length > 0 || s.hostPatterns.length > 0,
    'signature needs hosts, hostPatterns or anyHost',
  );

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
    otherCookies: z.array(z.string().min(1)).default([]),
    /** Tracking identifier keys in Web Storage or IndexedDB names (same syntax as cookies). */
    storageKeys: z.array(z.string().min(1)).default([]),
    /** Known Web Storage keys or IndexedDB names of the service that are not identifiers. */
    otherStorageKeys: z.array(z.string().min(1)).default([]),
    /** Consent Mode storage type relevant for cookieless pings. */
    consentStorage: z.enum(['ad', 'analytics']).optional(),
    selfHostable: z.boolean().default(false),
    aliasesDe: z.array(z.string().min(2)).default([]),
    aliasesEn: z.array(z.string().min(2)).default([]),
    companyAliases: z.array(z.string().min(2)).default([]),
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
      })
      .strict(),
    categories: z.record(
      z.enum(CATEGORIES),
      z.object({ de: z.array(z.string().min(2)), en: z.array(z.string().min(2)) }).strict(),
    ),
    /**
     * Parameter names (lower case) of identifiers handed to the site with the visit, not generated per page load: ad-click
     * ids and a user id. Compared with the collector's `identifierNames`.
     */
    userSuppliedParams: z.array(
      z
        .string()
        .min(1)
        .refine((n) => n === n.toLowerCase(), 'must be lower case'),
    ),
    /** Letters of the community-documented Google Consent Mode `gcd` value: position 3 is ad storage, 5 analytics. */
    consentMode: z
      .object({
        gcdDenied: z.array(z.string().length(1)),
        gcdGranted: z.array(z.string().length(1)),
      })
      .strict()
      .refine(
        (m) => !m.gcdDenied.some((c) => m.gcdGranted.includes(c)),
        'a gcd letter cannot be both denied and granted',
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

/**
 * The services of the catalog alone, for a collector that searches page text for their names (`loadSection`): the same
 * schema as in the whole catalog.
 */
export const servicesSection = dataSection('services', 'services', z.array(ServiceSchema));

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

interface NameEntry {
  p: NamePattern;
  service: ServiceEntry;
  tracking: boolean;
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
  readonly userSuppliedParams: ReadonlySet<string>;
  readonly #domainIndex = new Map<string, ServiceEntry[]>();
  readonly #hostSignatures = new Map<string, CompiledSignature[]>();
  readonly #hostPatternSignatures: Array<{ host: RegExp; c: CompiledSignature }> = [];
  readonly #anyHostSignatures: CompiledSignature[] = [];
  readonly #cookiePatterns: NameEntry[] = [];
  readonly #storagePatterns: NameEntry[] = [];
  readonly #allowCookies: Array<{ p: NamePattern; cls: string }> = [];
  readonly #allowStorage: Array<{ p: NamePattern; cls: string }> = [];

  constructor(data: CatalogData) {
    this.data = data;
    this.userSuppliedParams = new Set(data.userSuppliedParams);

    const byId = new Map<string, ServiceEntry>();
    for (const s of data.services) {
      if (byId.has(s.id)) throw new DataError(`services: duplicate service id "${s.id}"`);
      byId.set(s.id, s);
      this.#indexService(s);
    }
    this.byId = byId;

    for (const [cls, list] of Object.entries(data.allowlist.cookies))
      for (const n of list) this.#allowCookies.push({ p: compileName(n, 'i'), cls });
    for (const [cls, list] of Object.entries(data.allowlist.storage))
      for (const n of list) this.#allowStorage.push({ p: compileName(n, 'i'), cls });
  }

  #indexService(s: ServiceEntry): void {
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
      for (const h of sig.hostPatterns)
        this.#hostPatternSignatures.push({ host: new RegExp(h), c: compiled });
      if (sig.anyHost) this.#anyHostSignatures.push(compiled);
    }

    for (const c of s.cookies) this.#cookiePatterns.push({ p: compileName(c), service: s, tracking: true });
    for (const c of s.otherCookies)
      this.#cookiePatterns.push({ p: compileName(c), service: s, tracking: false });
    for (const k of s.storageKeys)
      this.#storagePatterns.push({ p: compileName(k), service: s, tracking: true });
    for (const k of s.otherStorageKeys)
      this.#storagePatterns.push({ p: compileName(k), service: s, tracking: false });
  }

  get version(): string {
    return this.data.catalog.version;
  }

  get allowlistVersion(): string {
    return this.data.allowlist.version;
  }

  /**
   * Vendor-host signature (listed host before host pattern) > any-host signature > longest domain suffix. A host with
   * signatures of several services falls back to the domain index when no signature matches.
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
    for (const { host: re, c } of this.#hostPatternSignatures) {
      if (re.test(host) && signatureMatches(c, url))
        return { service: c.service, signature: c.sig, via: 'host' };
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

  categoryTerms(category: ServiceCategory): string[] {
    const c = this.data.categories[category];
    return c ? [...c.de, ...c.en] : [];
  }

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
      categoryTerms: this.categoryTerms(s.category),
      selfHostable: s.selfHostable,
    };
    // Optional parties are left out of the object, not set to undefined.
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
  return true;
}

/** A pattern bound to a domain beats any unbound one; among equals the longer literal part wins. */
const DOMAIN_BOUND_BONUS = 1000;

function nameSpecificity(entry: NameEntry): number {
  return entry.p.literal + (entry.p.domain ? DOMAIN_BOUND_BONUS : 0);
}

function bestName(patterns: readonly NameEntry[], name: string, domain: string | null): NameMatch | null {
  let best: NameEntry | null = null;
  for (const entry of patterns) {
    if (!nameMatches(entry.p, name, domain)) continue;
    if (!best || nameSpecificity(entry) > nameSpecificity(best)) best = entry;
  }
  return best ? { service: best.service, tracking: best.tracking } : null;
}

export function parseCatalog(raw: unknown): CatalogData {
  const res = CatalogFileSchema.safeParse(raw);
  if (!res.success) {
    throw new DataError(
      `test/data/services: ${res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return res.data;
}

const cache = new Map<string, ServiceCatalog>();

/** Load and compile test/data/services/*.yaml (cached per data dir). */
export function loadServiceCatalog(dataDir: string = DEFAULT_DATA_DIR): ServiceCatalog {
  let c = cache.get(dataDir);
  if (!c) {
    c = new ServiceCatalog(parseCatalog(loadDataDir('services', dataDir)));
    cache.set(dataDir, c);
  }
  return c;
}
