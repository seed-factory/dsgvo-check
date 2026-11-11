/** Canary corpus (canary/sites.yaml): schema, validation and filters; pure except `loadSites`. A measurement sample, not a list of suspects: reasons state facts only. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { KNOWN_CMP_IDS } from '../../src/cmp/types.ts';
import { isHttpUrl, registrableDomain } from '../../src/core/url/url.ts';

export const DEFAULT_SITES_FILE = fileURLToPath(new URL('../../canary/sites.yaml', import.meta.url));

export const REGIONS = ['de', 'eu', 'non-eu'] as const;
export type Region = (typeof REGIONS)[number];

export const SIZE_CLASSES = ['large', 'medium', 'small-business'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** The CMPs with an own adapter, then the catch-all values. */
export const KNOWN_CMPS = KNOWN_CMP_IDS;
export type KnownCmp = (typeof KNOWN_CMPS)[number];
export const EXPECTED_CMPS = [...KNOWN_CMPS, 'other', 'none', 'unknown'] as const;
export type ExpectedCmp = (typeof EXPECTED_CMPS)[number];

export const SECTORS = [
  'media',
  'ecommerce',
  'retail',
  'manufacturing',
  'crafts',
  'education',
  'government',
  'banking',
  'insurance',
  'tourism',
  'transport',
  'health',
  'technology',
  'telecom',
  'automotive',
  'energy',
  'food',
  'association',
  'nonprofit',
] as const;
export type Sector = (typeof SECTORS)[number];

/** EU member states plus the EEA states IS, LI, NO. Switzerland is deliberately not in the list. */
export const EU_EEA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
]);

/** Common non-ISO codes that look like countries (EU uses EL for Greece, UK is not ISO 3166-1). */
const NON_ISO: Readonly<Record<string, string>> = { UK: 'GB', EL: 'GR', EU: '' };

export const DOCUMENTED_CASE_PREFIX = 'öffentlich dokumentierter Fall:';

/** Same verdict words the stop-word test forbids in test/data/texts (plus "abmahn…": the corpus is not an Abmahn list). */
const VERDICT_WORDS: readonly RegExp[] = [
  /verstößt|verstoßen|verstoss|verstoß/i,
  /rechtswidrig/i,
  /unzulässig|unzulaessig/i,
  /dsgvo-konform|dsgvokonform|datenschutzkonform|rechtskonform|gesetzeskonform/i,
  /gesetzwidrig|illegal/i,
  /abmahn/i,
  /\bviolat(es|ed|ion|ing)\b/i,
  /\bunlawful\b/i,
  /\bnon-?compliant\b|\bgdpr-compliant\b/i,
  /\bin breach\b|\bbreaches\b/i,
];

export interface CanarySite {
  id: string;
  /** Normalized start URL. */
  url: string;
  host: string;
  etld1: string | null;
  region: Region;
  country: string;
  sector: Sector;
  sizeClass: SizeClass;
  expectedCmp: ExpectedCmp;
  /** How expectedCmp was confirmed (vendor page, homepage HTML marker…); null only for `unknown`. */
  cmpSignal: string | null;
  selectionReason: string;
  publicReference: string | null;
}

export interface SiteIssue {
  field: string;
  message: string;
}

export class SitesValidationError extends Error {
  readonly issues: SiteIssue[];
  constructor(issues: SiteIssue[]) {
    super(`canary sites invalid:\n${issues.map((i) => `  ${i.field}: ${i.message}`).join('\n')}`);
    this.name = 'SitesValidationError';
    this.issues = issues;
  }
}

const RawSiteSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  region: z.enum(REGIONS),
  country: z.string(),
  sector: z.enum(SECTORS),
  sizeClass: z.enum(SIZE_CLASSES),
  expectedCmp: z.enum(EXPECTED_CMPS),
  cmpSignal: z.string().nullish(),
  selectionReason: z.string().trim().min(1).max(300),
  publicReference: z.string().nullish(),
});

const RawCorpusSchema = z.strictObject({
  version: z.literal(1),
  sites: z.array(z.unknown()),
});

export function regionOfCountry(country: string): Region {
  if (country === 'DE') return 'de';
  return EU_EEA_COUNTRIES.has(country) ? 'eu' : 'non-eu';
}

function fieldPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out ? `.${String(p)}` : String(p);
  return out || '(root)';
}

function verdictIn(text: string): string | null {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, ' ');
  for (const re of VERDICT_WORDS) {
    const m = re.exec(withoutUrls);
    if (m) return m[0];
  }
  return null;
}

function normalizeUrl(raw: string): { url: string; host: string } | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `not a URL: "${raw}"`;
  }
  if (!isHttpUrl(u)) return `only http(s) URLs: "${raw}"`;
  if (u.username || u.password) return 'credentials are not allowed';
  if (u.search) return 'query strings are not allowed (start page only)';
  if (u.hash || raw.includes('#')) return 'fragments are not allowed';
  return { url: u.toString(), host: u.hostname.toLowerCase() };
}

type RawSite = z.infer<typeof RawSiteSchema>;
type ReportIssue = (field: string, message: string) => void;

function checkCountryAndRegion(raw: RawSite, issue: ReportIssue): void {
  const country = raw.country;
  if (!/^[A-Z]{2}$/.test(country) || Object.hasOwn(NON_ISO, country)) {
    const hint = NON_ISO[country] ? ` (use ${NON_ISO[country]})` : '';
    issue('country', `not an ISO 3166-1 alpha-2 code: "${country}"${hint}`);
  } else if (regionOfCountry(country) !== raw.region) {
    issue(
      'region',
      `country ${country} belongs to region "${regionOfCountry(country)}", not "${raw.region}"`,
    );
  }
}

function checkId(raw: RawSite, issue: ReportIssue): void {
  const country = raw.country;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw.id) || raw.id.length > 40) {
    issue('id', `must be lower-case kebab-case, at most 40 characters: "${raw.id}"`);
  } else if (/^[A-Z]{2}$/.test(country) && !raw.id.startsWith(`${country.toLowerCase()}-`)) {
    issue('id', `must start with "${country.toLowerCase()}-"`);
  }
}

/** A public reference and the "documented case" wording of the reason must come together. */
function checkPublicReference(reason: string, ref: string | null, issue: ReportIssue): void {
  const documented = reason.startsWith(DOCUMENTED_CASE_PREFIX.slice(0, -1));
  if (ref !== null) {
    if (!isHttpsUrl(ref)) {
      issue('publicReference', 'must be an https URL');
    } else if (!reason.startsWith(DOCUMENTED_CASE_PREFIX)) {
      issue('selectionReason', `must start with "${DOCUMENTED_CASE_PREFIX}" when publicReference is set`);
    } else if (!reason.includes(ref)) {
      issue('selectionReason', 'must contain the publicReference URL');
    }
  } else if (documented) {
    issue('publicReference', 'required when selectionReason is "öffentlich dokumentierter Fall"');
  }
}

function checkNoVerdict(reason: string, cmpSignal: string | null, issue: ReportIssue): void {
  const verdict = verdictIn(reason);
  if (verdict) issue('selectionReason', `contains a legal verdict ("${verdict}"); state facts only`);

  const signalVerdict = cmpSignal ? verdictIn(cmpSignal) : null;
  if (signalVerdict) issue('cmpSignal', `contains a legal verdict ("${signalVerdict}"); state facts only`);
}

/** Validate one already shape-checked site; returns the site or pushes issues. */
function checkSite(raw: RawSite, at: string, issues: SiteIssue[]): CanarySite | null {
  const before = issues.length;
  const issue: ReportIssue = (field, message) => issues.push({ field: `${at}.${field}`, message });

  checkCountryAndRegion(raw, issue);
  checkId(raw, issue);

  const norm = normalizeUrl(raw.url);
  if (typeof norm === 'string') issue('url', norm);

  const cmpSignal = raw.cmpSignal?.trim() ? raw.cmpSignal.trim() : null;
  if (raw.expectedCmp !== 'unknown' && cmpSignal === null) {
    issue('cmpSignal', `required when expectedCmp is "${raw.expectedCmp}"`);
  }

  const reason = raw.selectionReason.trim();
  const ref = raw.publicReference?.trim() ? raw.publicReference.trim() : null;
  checkPublicReference(reason, ref, issue);
  checkNoVerdict(reason, cmpSignal, issue);

  if (issues.length > before || typeof norm === 'string') return null;
  return {
    id: raw.id,
    url: norm.url,
    host: norm.host,
    etld1: registrableDomain(norm.host),
    region: raw.region,
    country: raw.country,
    sector: raw.sector,
    sizeClass: raw.sizeClass,
    expectedCmp: raw.expectedCmp,
    cmpSignal,
    selectionReason: reason,
    publicReference: ref,
  };
}

function isHttpsUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ParseSitesOptions {
  /** Optional required number of sites; omitted or null allows any corpus size. */
  expectedCount?: number | null;
}

/** Raw site entries of the corpus file; a broken file or top-level shape is reported before any site is looked at. */
function readCorpusEntries(text: string): unknown[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new SitesValidationError([{ field: '(root)', message: `invalid YAML: ${(err as Error).message}` }]);
  }

  const top = RawCorpusSchema.safeParse(doc);
  if (!top.success) {
    throw new SitesValidationError(
      top.error.issues.map((i) => ({ field: fieldPath(i.path), message: i.message })),
    );
  }
  return top.data.sites;
}

interface SeenSites {
  ids: Set<string>;
  urls: Set<string>;
  hosts: Set<string>;
  /** Registrable domain → id of the site that has it. */
  domains: Map<string, string>;
}

/** The first uniqueness rule the site breaks (url, host, registrable domain), or null. */
function duplicateOf(s: CanarySite, seen: SeenSites): string | null {
  if (seen.urls.has(s.url)) return `duplicate url "${s.url}"`;
  if (seen.hosts.has(s.host)) return `duplicate host "${s.host}"`;

  const domain = s.etld1 ?? s.host;
  const owner = seen.domains.get(domain);
  if (owner !== undefined) return `duplicate registrable domain "${domain}" (also ${owner})`;
  return null;
}

/** Parse and validate the corpus. Collects every issue and throws one `SitesValidationError`. */
export function parseSites(text: string, opts: ParseSitesOptions = {}): CanarySite[] {
  const expectedCount = opts.expectedCount ?? null;
  const entries = readCorpusEntries(text);

  const issues: SiteIssue[] = [];
  const sites: CanarySite[] = [];
  const seen: SeenSites = { ids: new Set(), urls: new Set(), hosts: new Set(), domains: new Map() };

  entries.forEach((entry, index) => {
    const at = `sites[${index}]`;
    const parsed = RawSiteSchema.safeParse(entry);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        issues.push({ field: fieldPath(['sites', index, ...i.path]), message: i.message });
      }
      return;
    }

    const raw = parsed.data;
    if (seen.ids.has(raw.id)) {
      issues.push({ field: `${at}.id`, message: `duplicate id "${raw.id}"` });
      return;
    }
    seen.ids.add(raw.id);

    const s = checkSite(raw, at, issues);
    if (!s) return;
    const duplicate = duplicateOf(s, seen);
    if (duplicate) {
      issues.push({ field: `${at}.url`, message: duplicate });
      return;
    }

    seen.urls.add(s.url);
    seen.hosts.add(s.host);
    seen.domains.set(s.etld1 ?? s.host, s.id);
    sites.push(s);
  });

  if (expectedCount !== null && entries.length !== expectedCount) {
    issues.push({
      field: 'sites',
      message: `expected exactly ${expectedCount} sites, got ${entries.length}`,
    });
  }
  if (issues.length > 0) throw new SitesValidationError(issues);
  return sites;
}

export function loadSites(file = DEFAULT_SITES_FILE, opts: ParseSitesOptions = {}): CanarySite[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new Error(
        'Canary corpus not found. Copy canary/sites.example.yaml to canary/sites.yaml and fill it in, or pass --sites <file>.',
        { cause: err },
      );
    }
    throw err;
  }
  return parseSites(text, opts);
}

export interface SiteFilter {
  regions?: readonly Region[] | null;
  ids?: readonly string[] | null;
  limit?: number | null;
}

/** Filters keep the corpus order (deterministic runs). Unknown ids are an error. */
export function filterSites<T extends { id: string; region: Region }>(
  sites: readonly T[],
  f: SiteFilter,
): T[] {
  const known = new Set(sites.map((s) => s.id));
  const unknown = (f.ids ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown site id: ${unknown.join(', ')}`);

  let out = sites.filter(
    (s) =>
      (!f.regions || f.regions.length === 0 || f.regions.includes(s.region)) &&
      (!f.ids || f.ids.length === 0 || f.ids.includes(s.id)),
  );
  if (f.limit !== null && f.limit !== undefined) out = out.slice(0, f.limit);
  return out;
}
