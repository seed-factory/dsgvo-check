/**
 * Statements of the privacy policy about how the site embeds a service (PRIV-02): the dictionary of
 * test/data/legal/claims.yaml, the sentence splitter, the phrase matcher and the binding of a sentence to the catalog
 * service it is about. Pure: the check passes the policy parts, the dictionary from `ctx.data.legal` and
 * `derived.serviceNames`.
 */
import { z } from 'zod';
import { dataSection } from '../../core/data/parse.ts';
import type { ServiceCategory, ServiceName } from '../../derive/types.ts';
import { normalizeText, type PolicyPart } from './documents.ts';

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
// A category added to ServiceCategory but not to the list above fails to compile here.
const EVERY_CATEGORY: Exclude<ServiceCategory, (typeof CATEGORIES)[number]> extends never ? true : never =
  true;
void EVERY_CATEGORY;

const Category = z.enum(CATEGORIES);

/** Lower-case words (umlauts allowed) separated by one space; a word may end in `*`. */
const Phrase = z
  .string()
  .regex(
    /^[a-z0-9äöüß]+\*?( [a-z0-9äöüß]+\*?)*$/,
    'lower-case words separated by one space, `*` only at the end of a word',
  );
/** Phrases that must all occur in one sentence. */
const Pattern = z.array(Phrase).min(1);
const PerLang = <T extends z.ZodType>(s: T) => z.object({ de: s, en: s }).strict();

const KindWords = z
  .object({
    patterns: z.array(Pattern).min(1),
    reversals: z.array(Phrase),
    hedges: z.array(Phrase),
    disclosures: z.array(Pattern),
  })
  .strict();

const KindSchema = z
  .object({
    scope: z.enum(['unconditional', 'until-consent']),
    categories: z.array(Category).min(1),
    de: KindWords,
    en: KindWords,
  })
  .strict();

const ClaimsSchema = z
  .object({
    version: z.string().min(1),
    abbreviations: PerLang(z.array(z.string().regex(/^[a-z]+$/, 'lower-case letters without the dot'))),
    quantifiers: PerLang(z.array(Phrase)),
    negations: PerLang(z.array(Phrase)),
    notNegating: PerLang(z.array(Phrase)),
    negationEnds: PerLang(z.array(Phrase)),
    hedges: PerLang(z.array(Phrase)),
    external: PerLang(z.array(Phrase)),
    exclusions: PerLang(z.array(Phrase)),
    topics: z.partialRecord(Category, PerLang(z.array(Phrase))),
    // The kind id is the code of the statement in the report (`text-match.claim`) and in the finding texts.
    kinds: z.record(z.string().regex(/^[a-z]+(?:-[a-z]+)*$/, 'kebab-case id'), KindSchema),
  })
  .strict();

export type ClaimsData = z.infer<typeof ClaimsSchema>;

/** `claims:` of test/data/legal/claims.yaml. */
export const claimsSection = dataSection('legal', 'claims', ClaimsSchema);

export type ClaimScope = 'unconditional' | 'until-consent';

interface Word {
  w: string;
  prefix: boolean;
}
type CompiledPhrase = Word[];
type CompiledPattern = CompiledPhrase[];

/** A pattern of a statement; `denies` when its own words hold a negation ("keine Verbindung"). */
interface ClaimPattern {
  phrases: CompiledPattern;
  denies: boolean;
}

export interface ClaimKind {
  id: string;
  scope: ClaimScope;
  categories: ReadonlySet<ServiceCategory>;
  patterns: ClaimPattern[];
  reversals: CompiledPhrase[];
  hedges: CompiledPhrase[];
  disclosures: CompiledPattern[];
}

/** The dictionary ready for matching; the German and the English words are merged (see claims.yaml). */
export interface PolicyClaims {
  version: string;
  abbreviations: ReadonlySet<string>;
  quantifiers: CompiledPhrase[];
  negations: CompiledPhrase[];
  notNegating: CompiledPhrase[];
  negationEnds: CompiledPhrase[];
  /** Reservations of every kind, next to the hedges of each kind. */
  hedges: CompiledPhrase[];
  external: CompiledPhrase[];
  exclusions: CompiledPhrase[];
  topics: Array<{ category: ServiceCategory; phrases: CompiledPhrase[] }>;
  kinds: ClaimKind[];
}

function compilePhrase(phrase: string): CompiledPhrase {
  return phrase.split(' ').map((word) => {
    const prefix = word.endsWith('*');
    return { w: normalizeText(prefix ? word.slice(0, -1) : word).trim(), prefix };
  });
}

const phrases = (lists: readonly (readonly string[])[]): CompiledPhrase[] => lists.flat().map(compilePhrase);
const patterns = (lists: readonly (readonly string[][])[]): CompiledPattern[] =>
  lists.flat().map((p) => p.map(compilePhrase));

export function compileClaims(data: ClaimsData): PolicyClaims {
  const negations = phrases([data.negations.de, data.negations.en]);
  const claimPattern = (p: CompiledPattern): ClaimPattern => {
    const own = p.flatMap((phrase) => phrase.map((x) => x.w));
    return { phrases: p, denies: negations.some((n) => hasPhrase(own, n)) };
  };
  return {
    version: data.version,
    abbreviations: new Set([...data.abbreviations.de, ...data.abbreviations.en]),
    quantifiers: phrases([data.quantifiers.de, data.quantifiers.en]),
    negations,
    notNegating: phrases([data.notNegating.de, data.notNegating.en]),
    negationEnds: phrases([data.negationEnds.de, data.negationEnds.en]),
    hedges: phrases([data.hedges.de, data.hedges.en]),
    external: phrases([data.external.de, data.external.en]),
    exclusions: phrases([data.exclusions.de, data.exclusions.en]),
    topics: Object.entries(data.topics).map(([category, words]) => ({
      category: category as ServiceCategory,
      phrases: phrases([words?.de ?? [], words?.en ?? []]),
    })),
    kinds: Object.entries(data.kinds).map(([id, k]) => ({
      id,
      scope: k.scope,
      categories: new Set(k.categories),
      patterns: patterns([k.de.patterns, k.en.patterns]).map(claimPattern),
      reversals: phrases([k.de.reversals, k.en.reversals]),
      hedges: phrases([k.de.hedges, k.en.hedges]),
      disclosures: patterns([k.de.disclosures, k.en.disclosures]),
    })),
  };
}

const cache = new WeakMap<object, PolicyClaims>();

/** The compiled dictionary of the merged `ctx.data.legal`; a broken file throws a `DataError` naming the key. */
export function claimsFromData(merged: unknown): PolicyClaims {
  const key = merged !== null && typeof merged === 'object' ? merged : null;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const claims = compileClaims(claimsSection.parse(merged));
  if (key) cache.set(key, claims);
  return claims;
}

/** Words of a sentence as the matcher sees them (normalised like PRIV-01). */
export function words(text: string): string[] {
  const n = normalizeText(text).trim();
  return n === '' ? [] : n.split(' ');
}

function phraseAt(tokens: readonly string[], phrase: CompiledPhrase, i: number): boolean {
  for (let j = 0; j < phrase.length; j++) {
    const t = tokens[i + j];
    const p = phrase[j] as Word;
    if (t === undefined || !(p.prefix ? t.startsWith(p.w) : t === p.w)) return false;
  }
  return true;
}

/** The phrase occurs in the words, its words in order and next to each other. */
export function hasPhrase(tokens: readonly string[], phrase: CompiledPhrase): boolean {
  for (let i = 0; i + phrase.length <= tokens.length; i++) if (phraseAt(tokens, phrase, i)) return true;
  return false;
}

const anyPhrase = (tokens: readonly string[], list: readonly CompiledPhrase[]) =>
  list.some((p) => hasPhrase(tokens, p));

/** Word positions `from` (inclusive) to `to` (exclusive). */
interface Span {
  from: number;
  to: number;
}

/** Words from the first to the end of the last phrase of a pattern found in the sentence; null when one is missing. */
function patternSpan(tokens: readonly string[], pattern: CompiledPattern): Span | null {
  let from = Number.POSITIVE_INFINITY;
  let to = -1;
  for (const phrase of pattern) {
    let at = -1;
    for (let i = 0; i + phrase.length <= tokens.length && at < 0; i++)
      if (phraseAt(tokens, phrase, i)) at = i;
    if (at < 0) return null;
    from = Math.min(from, at);
    to = Math.max(to, at + phrase.length);
  }
  return { from, to };
}

/**
 * A negation this many words before (and for a disclosure after) the matched words belongs to them: "are not installed
 * locally", "lädt die Schriften nicht von Google". One further away negates something else ("…, dabei werden keine
 * Cookies gespeichert").
 */
const NEGATION_WINDOW_WORDS = 3;

/**
 * A negation in the words `from`–`to` that applies to the matched words `span`. One that adds ("nicht nur") does not.
 * One before the span does not when a contrast word stands between them ("nicht extern, sondern lokal"); one after it
 * does not when a contrast word follows ("lädt die Schriften nicht von unserem Server, sondern von Google"). One among
 * the matched words always does.
 */
function negationIn(tokens: readonly string[], from: number, to: number, span: Span, claims: PolicyClaims) {
  const contrastIn = (a: number, b: number) => {
    for (let j = a; j < b; j++) if (claims.negationEnds.some((e) => phraseAt(tokens, e, j))) return true;
    return false;
  };
  for (let i = Math.max(0, from); i < Math.min(tokens.length, to); i++) {
    if (!claims.negations.some((n) => phraseAt(tokens, n, i))) continue;
    if (claims.notNegating.some((n) => phraseAt(tokens, n, i))) continue;
    if (i < span.from && contrastIn(i + 1, span.from)) continue;
    if (i >= span.to && contrastIn(i + 1, tokens.length)) continue;
    return true;
  }
  return false;
}

/**
 * How the sentence states the kind: `denies` with a pattern that holds a negation itself ("keine Verbindung"),
 * `affirms` with one that does not; null when no pattern is found or a negation just before it turns it around. The
 * negation of a denying pattern is its own, so only the words before it are looked at.
 */
function statement(
  tokens: readonly string[],
  kind: ClaimKind,
  claims: PolicyClaims,
): 'denies' | 'affirms' | null {
  let out: 'denies' | 'affirms' | null = null;
  for (const p of kind.patterns) {
    const span = patternSpan(tokens, p.phrases);
    if (!span) continue;
    const before = span.from - NEGATION_WINDOW_WORDS;
    if (negationIn(tokens, before, p.denies ? span.from : span.to, span, claims)) continue;
    if (p.denies) return 'denies';
    out = 'affirms';
  }
  return out;
}

/** A disclosure pattern of the kind is found without a negation next to it. */
function discloses(tokens: readonly string[], kind: ClaimKind, claims: PolicyClaims): boolean {
  return kind.disclosures.some((pattern) => {
    const span = patternSpan(tokens, pattern);
    if (!span) return false;
    const [from, to] = [span.from - NEGATION_WINDOW_WORDS, span.to + NEGATION_WINDOW_WORDS];
    return !negationIn(tokens, from, to, span, claims);
  });
}

const hedged = (tokens: readonly string[], kind: ClaimKind, claims: PolicyClaims) =>
  anyPhrase(tokens, kind.hedges) || anyPhrase(tokens, claims.hedges);

/** Up to this many digits before a dot are an ordinal ("5. Plugins"), not the end of a sentence. */
const ORDINAL_DIGITS = 3;
/** A sentence ends at `.`, `!` or `?` (closing quotes may follow) before a capital letter (opening quotes may precede). */
const BOUNDARY = /([.!?])["“”»’')\]]*(\s+)(?=["„“«‚'([]*[A-ZÄÖÜ])/gu;
/** Also before a paragraph sign or a digit: a legal text starts sentences with them ("… § 5 DDG. § 7 TMG regelt …"). */
const LEGAL_BOUNDARY = /([.!?])["“”»’')\]]*(\s+)(?=["„“«‚'([]*[A-ZÄÖÜ§\d])/gu;

/** Whether the word before the dot at `dot` makes it no sentence end: an abbreviation, a letter, an ordinal. */
function abbreviated(text: string, dot: number, abbreviations: ReadonlySet<string>): boolean {
  if (text[dot] !== '.') return false;
  const before = /([\p{L}\p{N}]+)$/u.exec(text.slice(Math.max(0, dot - 20), dot));
  if (!before) return false;
  const word = before[1] as string;
  if (/^\p{L}$/u.test(word)) return true;
  if (/^\d+$/.test(word)) return word.length <= ORDINAL_DIGITS;
  return abbreviations.has(word.toLowerCase());
}

/**
 * The sentences of a text, each verbatim (trimmed). Dots inside a URL or a domain are followed by no space, so they end
 * no sentence. `legalStarts`: a sentence may also start with `§` or a digit.
 */
export function splitSentences(
  text: string,
  abbreviations: ReadonlySet<string>,
  opts: { legalStarts?: boolean } = {},
): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(opts.legalStarts ? LEGAL_BOUNDARY : BOUNDARY)) {
    const dot = m.index;
    if (abbreviated(text, dot, abbreviations)) continue;
    const end = dot + m[0].length - (m[2] as string).length;
    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = dot + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Brands shorter than this are common words ("New" of New Relic). */
const MIN_BRAND_CHARS = 4;

interface VocabularyService {
  serviceId: string;
  category: ServiceCategory;
  /** Name and aliases as words. */
  terms: string[][];
  /** First words of the provider and parent names ("Google" of "Google Ireland Limited"), matched case-sensitively. */
  brands: ReadonlySet<string>;
}

/** The catalog names by which a sentence names a service or its company. */
export interface ServiceVocabulary {
  services: VocabularyService[];
  byId: ReadonlyMap<string, VocabularyService>;
  /** Names and aliases by their first word. */
  byFirstWord: ReadonlyMap<string, Array<{ serviceId: string; term: string[] }>>;
  brands: Array<{ brand: string; re: RegExp }>;
}

function brandOf(company: string): string | null {
  const m = /^[\p{L}\p{N}]+/u.exec(company.trim());
  return m && m[0].length >= MIN_BRAND_CHARS ? m[0] : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function serviceVocabulary(names: readonly ServiceName[]): ServiceVocabulary {
  const services = names.map((n) => {
    const companies = [n.provider?.name, n.parent?.name, ...n.companyAliases].filter((c): c is string => !!c);
    return {
      serviceId: n.serviceId,
      category: n.category,
      terms: [...new Set([n.name, ...n.aliases])].map(words).filter((t) => t.length > 0),
      brands: new Set(companies.map(brandOf).filter((b): b is string => b !== null)),
    };
  });
  const brands = [...new Set(services.flatMap((s) => [...s.brands]))].sort().map((brand) => ({
    brand,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(brand)}(?![\\p{L}\\p{N}])`, 'u'),
  }));
  const byFirstWord = new Map<string, Array<{ serviceId: string; term: string[] }>>();
  for (const svc of services) {
    for (const term of svc.terms) {
      const first = term[0] as string;
      byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), { serviceId: svc.serviceId, term }]);
    }
  }
  return { services, byId: new Map(services.map((s) => [s.serviceId, s])), byFirstWord, brands };
}

/** Where the words name services: one entry per place, with every service whose name or alias stands there. */
interface Mention {
  from: number;
  to: number;
  serviceIds: string[];
}

/**
 * The places where the words name a service by catalog name or alias. A name inside a longer name of another service
 * that also matched there does not count ("Google Maps" inside "Google Maps Platform"); services that share an alias
 * ("YouTube") are named at one place.
 */
function mentions(tokens: readonly string[], vocab: ServiceVocabulary): Mention[] {
  const hits: Array<{ serviceId: string; from: number; to: number }> = [];
  tokens.forEach((token, i) => {
    for (const { serviceId, term } of vocab.byFirstWord.get(token) ?? []) {
      if (term.every((w, j) => tokens[i + j] === w)) hits.push({ serviceId, from: i, to: i + term.length });
    }
  });
  const inside = (a: (typeof hits)[number]) =>
    hits.some(
      (b) => b.serviceId !== a.serviceId && b.from <= a.from && b.to >= a.to && b.to - b.from > a.to - a.from,
    );
  const byPlace = new Map<string, Mention>();
  for (const h of hits.filter((x) => !inside(x))) {
    const key = `${h.from}:${h.to}`;
    const m = byPlace.get(key) ?? { from: h.from, to: h.to, serviceIds: [] };
    if (!m.serviceIds.includes(h.serviceId)) m.serviceIds.push(h.serviceId);
    byPlace.set(key, m);
  }
  return [...byPlace.values()].map((m) => ({ ...m, serviceIds: m.serviceIds.sort() }));
}

/** Services the words name (see `mentions`). */
export function namedServices(tokens: readonly string[], vocab: ServiceVocabulary): string[] {
  return [...new Set(mentions(tokens, vocab).flatMap((m) => m.serviceIds))].sort();
}

/** The words name different services at different places ("Google Fonts …, Google Maps …"). */
const severalServices = (ms: readonly Mention[]) => new Set(ms.map((m) => m.serviceIds.join(','))).size > 1;

/** The services of a heading or a previous sentence a statement may inherit: none when it names several. */
const soleServices = (ms: readonly Mention[]) => (severalServices(ms) ? [] : ms.flatMap((m) => m.serviceIds));

/**
 * The sentence names a source outside the site for the services: an `external` word, or a company of theirs outside a
 * service name ("von Google" counts, the "Google" of "Google Fonts" does not).
 */
function outsideSource(
  tokens: readonly string[],
  ms: readonly Mention[],
  serviceIds: readonly string[],
  claims: PolicyClaims,
  vocab: ServiceVocabulary,
): boolean {
  if (anyPhrase(tokens, claims.external)) return true;
  const brands = new Set(
    serviceIds.flatMap((id) => [...(vocab.byId.get(id)?.brands ?? [])].map((b) => words(b).join(' '))),
  );
  return tokens.some((t, i) => brands.has(t) && !ms.some((m) => m.from <= i && i < m.to));
}

/** Company brands the sentence names, as written (case-sensitive, so "HERE" is no "here"). */
export function brandsIn(sentence: string, vocab: ServiceVocabulary): Set<string> {
  return new Set(vocab.brands.filter((b) => b.re.test(sentence)).map((b) => b.brand));
}

/** How a statement found its service. */
export type SubjectSource = 'sentence' | 'heading' | 'previous-sentence' | 'category';
/**
 * Why a statement is not evaluated: a condition or possibility, text the page does not show, a sentence that also
 * describes the outside source (both variants), one that names several services (which of them the statement is about
 * is not parsed), too long to quote.
 */
export type Ambiguity = 'hedge' | 'hidden' | 'both-variants' | 'several-services' | 'long-sentence';

/** One sentence of the policy that states a kind of embedding for one or more services. */
export interface PolicyClaim {
  kind: string;
  scope: ClaimScope;
  serviceIds: string[];
  via: SubjectSource;
  part: PolicyPart;
  sentence: string;
  ambiguous: Ambiguity | null;
}

/** One sentence that describes the external connection of a service (the other variant of a template). */
export interface PolicyDisclosure {
  kind: string;
  serviceIds: string[];
  part: PolicyPart;
  sentence: string;
}

/** A quote is a whole sentence of at most this many characters (the report's limit). */
export const QUOTE_MAX_CHARS = 200;

interface SentenceContext {
  tokens: string[];
  sentence: string;
  headingServices: readonly string[];
  previousServices: readonly string[];
  observedByCategory: ReadonlyMap<ServiceCategory, readonly string[]>;
}

/**
 * The services a sentence of `kind` is about. A service the sentence names is its subject, whatever the category: such
 * a statement never falls back to another service. Otherwise the sentence inherits a service named in the last
 * heading of its section, then one named in the previous sentence; a category word ("Schriften") or a company
 * ("Servern von Google") in the sentence restricts what it inherits. A category word with a quantifier ("alle
 * Schriftarten") makes it a statement about every observed service of that category.
 */
function subjectOf(
  kind: ClaimKind,
  s: SentenceContext,
  claims: PolicyClaims,
  vocab: ServiceVocabulary,
): { serviceIds: string[]; via: SubjectSource; several?: boolean } | null {
  const inKind = (id: string) => {
    const svc = vocab.byId.get(id);
    return !!svc && kind.categories.has(svc.category);
  };
  const named = mentions(s.tokens, vocab);
  if (named.length > 0) {
    const ids = [...new Set(named.flatMap((m) => m.serviceIds))].sort().filter(inKind);
    return ids.length > 0 ? { serviceIds: ids, via: 'sentence', several: severalServices(named) } : null;
  }

  const topics = new Set(claims.topics.filter((t) => anyPhrase(s.tokens, t.phrases)).map((t) => t.category));
  const brands = brandsIn(s.sentence, vocab);
  const fits = (id: string) => {
    const svc = vocab.byId.get(id);
    if (!svc || !inKind(id)) return false;
    if (topics.size > 0 && !topics.has(svc.category)) return false;
    return brands.size === 0 || [...svc.brands].some((b) => brands.has(b));
  };

  const fromHeading = s.headingServices.filter(fits);
  if (fromHeading.length > 0) return { serviceIds: fromHeading, via: 'heading' };
  const fromPrevious = s.previousServices.filter(fits);
  if (fromPrevious.length > 0) return { serviceIds: fromPrevious, via: 'previous-sentence' };

  if (topics.size > 0 && anyPhrase(s.tokens, claims.quantifiers)) {
    const ids = [...topics].flatMap((c) => s.observedByCategory.get(c) ?? []).filter(fits);
    if (ids.length > 0) return { serviceIds: [...new Set(ids)].sort(), via: 'category' };
  }
  return null;
}

/** The last heading of a part's section path ("Plugins und Tools > Google Web Fonts" → "Google Web Fonts"). */
function lastHeading(section: string | undefined): string {
  return section?.split(' > ').at(-1) ?? '';
}

/**
 * Statements and disclosures of the policy parts. A question, a sentence of `exclusions`, a statement with a
 * `reversal` or a negation just before its words are none; a statement with a hedge, in a part the page hides, that
 * also describes the outside source, naming several services or too long to quote whole is kept as ambiguous. A
 * disclosure is a sentence of a kind's `disclosures` with an outside source, without a hedge and without a negation
 * next to the matched words, about services the sentence or its heading names.
 */
export function readPolicyClaims(
  parts: readonly PolicyPart[],
  claims: PolicyClaims,
  vocab: ServiceVocabulary,
  observedByCategory: ReadonlyMap<ServiceCategory, readonly string[]>,
): { claims: PolicyClaim[]; disclosures: PolicyDisclosure[] } {
  const found: PolicyClaim[] = [];
  const disclosures: PolicyDisclosure[] = [];

  for (const part of parts) {
    const headingServices = soleServices(mentions(words(lastHeading(part.section)), vocab));
    const sentences = splitSentences(part.text, claims.abbreviations);
    let previousServices: string[] = [];

    for (const sentence of sentences) {
      const tokens = words(sentence);
      const ctx: SentenceContext = {
        tokens,
        sentence,
        headingServices,
        previousServices,
        observedByCategory,
      };
      previousServices = soleServices(mentions(tokens, vocab));
      if (sentence.endsWith('?') || anyPhrase(tokens, claims.exclusions)) continue;

      const ms = mentions(tokens, vocab);
      // A sentence that denies the connection ("keine Verbindung zu Servern von Google") describes none.
      const denied = claims.kinds.some(
        (k) => statement(tokens, k, claims) === 'denies' && !anyPhrase(tokens, k.reversals),
      );
      const describes = (serviceIds: readonly string[]) =>
        !denied &&
        claims.kinds.some((k) => discloses(tokens, k, claims) && !hedged(tokens, k, claims)) &&
        outsideSource(tokens, ms, serviceIds, claims, vocab);

      let claimed = false;
      let bothVariants = false;
      for (const kind of claims.kinds) {
        const how = statement(tokens, kind, claims);
        if (!how || anyPhrase(tokens, kind.reversals)) continue;
        const subject = subjectOf(kind, ctx, claims, vocab);
        if (!subject) continue;
        claimed = true;
        const both = how === 'affirms' && describes(subject.serviceIds);
        bothVariants ||= both;
        const ambiguous: Ambiguity | null =
          part.origin === 'hidden-irrelevant'
            ? 'hidden'
            : hedged(tokens, kind, claims)
              ? 'hedge'
              : both
                ? 'both-variants'
                : subject.several
                  ? 'several-services'
                  : sentence.length > QUOTE_MAX_CHARS
                    ? 'long-sentence'
                    : null;
        const { serviceIds, via } = subject;
        found.push({ kind: kind.id, scope: kind.scope, serviceIds, via, part, sentence, ambiguous });
      }

      // A statement sentence describes its own way of loading ("lädt die Schriften von unserem eigenen Server"),
      // unless it also names the outside source: then it holds both variants and counts as a disclosure too.
      if ((claimed && !bothVariants) || denied || part.origin === 'hidden-irrelevant') continue;
      for (const kind of claims.kinds) {
        if (!discloses(tokens, kind, claims) || hedged(tokens, kind, claims)) continue;
        const subject = subjectOf(kind, ctx, claims, vocab);
        if (!subject || (subject.via !== 'sentence' && subject.via !== 'heading')) continue;
        if (outsideSource(tokens, ms, subject.serviceIds, claims, vocab)) {
          disclosures.push({ kind: kind.id, serviceIds: subject.serviceIds, part, sentence });
        }
      }
    }
  }
  return { claims: found, disclosures };
}
