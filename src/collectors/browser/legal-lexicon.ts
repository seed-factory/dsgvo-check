/**
 * Pure lexicon of legal links: which link labels and path slugs point to the
 * Impressum or the privacy policy, with a rank by precision, which headings mark a fetched page as that document
 * (and in which language), and which navigation keys lead to an intermediate page (Kontakt, Rechtliches, Über uns).
 * No I/O: the collector reads test/data/legal/links.yaml through `legal-lexicon-file.ts`, LEGAL-01 gets the same data
 * through `ctx.data.legal`.
 *
 * Matching works on words: both sides are normalised (NFKC, case, ä/ae, ß/ss, diacritics, punctuation → space) and a
 * phrase matches where its words start at word boundaries; the last word may continue ("datenschutz" matches
 * "datenschutzerklaerung"), which is how German compounds are written. Navigation keys are stricter: "kontakt" must
 * not match "kontaktlinsen".
 */
import { z } from 'zod';
import type { DocumentRecord, DocumentsSection } from '../../core/snapshot-browser.ts';

export type LegalKind = 'impressum' | 'privacy';
export const LEGAL_KINDS: readonly LegalKind[] = ['impressum', 'privacy'];

/** Longer labels are text blobs (headlines, sentences); they count only when they contain a document phrase. */
const MAX_LABEL_TOKENS = 8;
/** A navigation key may carry this many more letters (plural: kontakt → kontakte), not a compound. */
const NAV_SUFFIX = 2;
/** A weak key counts only as the whole label or in a label of at most this many words: "Alles zur DSGVO" is no link. */
const WEAK_LABEL_TOKENS = 2;

const LanguageSchema = z.object({
  labels: z.array(z.string()).default([]),
  keys: z.array(z.string()).default([]),
  generic: z.array(z.string()).default([]),
  weak: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),
});

const KindSchema = z.object({
  falseFriends: z.array(z.string()).default([]),
  languages: z.record(z.string(), LanguageSchema),
});

const LexiconSchema = z.object({
  version: z.string().min(1),
  kinds: z.object({ impressum: KindSchema, privacy: KindSchema }),
  navigation: z.object({
    contact: z.array(z.string()),
    hop: z.array(z.string()),
    hopStrict: z.array(z.string()).default([]),
  }),
  notFound: z.array(z.string()),
});

export interface Phrase {
  /** As written in the data file (shown in plan reasons). */
  key: string;
  /** Normalised words. */
  tokens: string[];
  norm: string;
  lang: string;
}
type LinkRole = 'generic' | 'key' | 'weak';
interface LinkPhrase extends Phrase {
  role: LinkRole;
}
export interface NavPhrase extends Phrase {
  strict: boolean;
}

interface KindLexicon {
  /** Normalised canonical labels. */
  labels: Set<string>;
  /** The same labels with the spaces removed: "Datenschutz-Hinweise" is the canonical "Datenschutzhinweise". */
  labelsJoined: Set<string>;
  /** Phrases for link matching in rank order of their role: generic, key, weak. */
  link: LinkPhrase[];
  /** Heading markers (labels, keys, generic words and extra markers; weak keys excluded). */
  markers: Phrase[];
  falseFriends: Phrase[];
}

export interface LegalLexicon {
  version: string;
  kinds: Record<LegalKind, KindLexicon>;
  contact: NavPhrase[];
  hop: NavPhrase[];
  notFound: Phrase[];
}

const FOLD: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
};

/** NFKC, case, ä→ae ö→oe ü→ue ß→ss, other diacritics dropped, everything but letters and digits → one space. */
export function normalizeLegalText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[äöüßæœøłđðþ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokensOf(s: string): string[] {
  const n = normalizeLegalText(s);
  return n === '' ? [] : n.split(' ');
}

function phrase(key: string, lang: string): Phrase {
  const norm = normalizeLegalText(key);
  return { key, tokens: norm === '' ? [] : norm.split(' '), norm, lang };
}

/** Identity of a page for dedup: origin + path (trailing slash ignored) + query. */
export function pageKey(raw: string): string {
  try {
    const u = new URL(raw);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${p}${u.search}`;
  } catch {
    return raw;
  }
}

/** Decoded path of an absolute URL (empty when it cannot be parsed). */
export function pathOfUrl(href: string): string {
  try {
    const p = new URL(href).pathname;
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  } catch {
    return '';
  }
}

function compile(raw: z.infer<typeof LexiconSchema>): LegalLexicon {
  const kinds = {} as Record<LegalKind, KindLexicon>;
  for (const kind of LEGAL_KINDS) {
    const spec = raw.kinds[kind];
    const labels = new Set<string>();
    const labelsJoined = new Set<string>();
    const byRole: Record<LinkRole, LinkPhrase[]> = { generic: [], key: [], weak: [] };
    const markers: Phrase[] = [];
    const seenMarker = new Set<string>();
    const addMarker = (p: Phrase) => {
      const id = `${p.lang}|${p.norm}`;
      if (p.tokens.length === 0 || seenMarker.has(id)) return;
      seenMarker.add(id);
      markers.push(p);
    };
    for (const [lang, entry] of Object.entries(spec.languages)) {
      for (const l of entry.labels) {
        const p = phrase(l, lang);
        if (p.norm !== '') {
          labels.add(p.norm);
          labelsJoined.add(p.tokens.join(''));
        }
        addMarker(p);
      }
      for (const role of ['generic', 'key', 'weak'] as const) {
        const list = role === 'key' ? entry.keys : entry[role];
        for (const k of list) {
          const p = phrase(k, lang);
          if (p.tokens.length === 0) continue;
          byRole[role].push({ ...p, role });
          if (role !== 'weak') addMarker(p);
        }
      }
      for (const m of entry.markers) addMarker(phrase(m, lang));
    }
    kinds[kind] = {
      labels,
      labelsJoined,
      link: [...byRole.generic, ...byRole.key, ...byRole.weak],
      markers,
      falseFriends: spec.falseFriends.map((f) => phrase(f, '*')).filter((p) => p.tokens.length > 0),
    };
  }
  const strict = new Set(raw.navigation.hopStrict.map(normalizeLegalText));
  const nav = (list: string[]): NavPhrase[] =>
    list
      .map((k) => phrase(k, '*'))
      .filter((p) => p.tokens.length > 0)
      .map((p) => ({ ...p, strict: strict.has(p.norm) }));
  return {
    version: raw.version,
    kinds,
    contact: nav(raw.navigation.contact),
    hop: nav(raw.navigation.hop),
    notFound: raw.notFound.map((k) => phrase(k, '*')).filter((p) => p.tokens.length > 0),
  };
}

const cache = new WeakMap<object, LegalLexicon>();

/** Parse the merged `test/data/legal` object (`{ legal: … }`) or a bare lexicon object; throws on an invalid shape. */
export function legalLexiconFromData(data: unknown): LegalLexicon {
  if (data !== null && typeof data === 'object') {
    const hit = cache.get(data);
    if (hit) return hit;
  }
  const raw =
    data !== null && typeof data === 'object' && 'legal' in data ? (data as { legal: unknown }).legal : data;
  const res = LexiconSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`legal lexicon: ${issues}`);
  }
  const lex = compile(res.data);
  if (data !== null && typeof data === 'object') cache.set(data, lex);
  return lex;
}

type Mode = 'exact' | 'prefix' | 'word';

function wordMatches(token: string, key: string, mode: Mode): boolean {
  if (mode === 'exact') return token === key;
  if (mode === 'prefix') return token.startsWith(key);
  return token === key || (token.startsWith(key) && token.length - key.length <= NAV_SUFFIX);
}

/** Index of the first word position where `p` matches (all words but the last exactly), or -1. */
function matchAt(tokens: readonly string[], p: readonly string[], mode: Mode): number {
  const n = p.length;
  for (let i = 0; i + n <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      const t = tokens[i + j] as string;
      const k = p[j] as string;
      ok = j < n - 1 ? t === k : wordMatches(t, k, mode);
    }
    if (ok) return i;
  }
  return -1;
}

export interface LinkInput {
  text: string;
  accessibleName?: string;
  /** Decoded path of the href ('' when there is none). */
  path: string;
}

function labelsOf(input: LinkInput): string[] {
  const out: string[] = [];
  for (const s of [input.text, input.accessibleName ?? '']) {
    const t = s.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface LinkMatch {
  /** 0 exact canonical label, 1 label starts with a key, 2 key inside the label, 3 href slug only, 4 weak. */
  tier: 0 | 1 | 2 | 3 | 4;
  keyword: string;
  byText: boolean;
  /** The href path carries a legal slug (tie-break between equal tiers). */
  slug: boolean;
}

interface LabelMatch {
  tier: 0 | 1 | 2 | 4;
  keyword: string;
  primary: boolean;
}

function matchLabel(k: KindLexicon, label: string): LabelMatch | null {
  const toks = tokensOf(label);
  if (toks.length === 0) return null;
  const norm = toks.join(' ');
  let best: LabelMatch | null = null;
  let primary = false;
  for (const p of k.link) {
    const i = matchAt(toks, p.tokens, 'prefix');
    if (i < 0) continue;
    // A weak key inside a longer label is a headline or a badge ("Webdesign DSGVO konform"), not a link to the document.
    if (p.role === 'weak' && p.norm !== norm && toks.length > WEAK_LABEL_TOKENS) continue;
    if (p.role === 'key') primary = true;
    const tier = p.role === 'weak' ? 4 : i === 0 ? 1 : 2;
    if (!best || tier < best.tier) best = { tier, keyword: p.key, primary: false };
  }
  // Hyphen and space do not matter for a canonical label: "Datenschutz-Hinweise" is "Datenschutzhinweise".
  if (k.labels.has(norm) || k.labelsJoined.has(toks.join(''))) {
    return { tier: 0, keyword: best?.keyword ?? label.trim().toLowerCase(), primary: true };
  }
  if (!best) return null;
  best.primary = primary;
  if (toks.length > MAX_LABEL_TOKENS && !primary) return null;
  return best;
}

function hasFalseFriend(k: KindLexicon, toks: readonly string[]): boolean {
  return k.falseFriends.some((f) => matchAt(toks, f.tokens, 'prefix') >= 0);
}

/** The label-level and href-level match of one link for one kind, before the other kind is taken into account. */
function matchOwn(lex: LegalLexicon, kind: LegalKind, input: LinkInput): LinkMatch | null {
  const k = lex.kinds[kind];
  let label: LabelMatch | null = null;
  for (const l of labelsOf(input)) {
    const m = matchLabel(k, l);
    if (!m) continue;
    if (kind === 'privacy' && !m.primary && hasFalseFriend(k, tokensOf(l))) continue;
    if (!label || m.tier < label.tier) label = m;
  }
  const ptoks = tokensOf(input.path);
  let path: { tier: 3 | 4; keyword: string } | null = null;
  let primaryInPath = false;
  if (ptoks.length > 0) {
    for (const p of k.link) {
      if (matchAt(ptoks, p.tokens, 'prefix') < 0) continue;
      if (p.role === 'key') primaryInPath = true;
      const tier = p.role === 'weak' ? 4 : 3;
      if (!path || tier < path.tier) path = { tier, keyword: p.key };
    }
    // A settings word in the path ("cookie-settings") switches the path match off, unless the path carries a primary
    // key of the document ("privacy-policy-and-cookies"): the same rule as for a label (`primary`).
    if (kind === 'privacy' && !primaryInPath && hasFalseFriend(k, ptoks)) path = null;
  }
  const slug = path !== null && path.tier === 3;
  if (label && (!path || label.tier <= path.tier)) {
    return { tier: label.tier, keyword: label.keyword, byText: true, slug };
  }
  if (path) return { tier: path.tier, keyword: path.keyword, byText: false, slug };
  return null;
}

/** A link as seen by the matcher; `page` is the identity of its target (`pageKey`), '' when it has none. */
export interface LegalLinkRef {
  input: LinkInput;
  page: string;
}

/**
 * Match several links for the document `kind` at once. A weak key (tier 4: a generic umbrella label such as "Legal
 * information") is the last resort and loses against an exact canonical label of the other kind: on the same link
 * ("Privacy Policy" with the accessible name "Legal Information") and on another link to the same page, so one URL
 * is not offered as the Impressum when a link names it the privacy policy. Stronger tiers are not
 * touched: a combined page with an exact label for each kind belongs to both. The result is parallel to `links`.
 */
export function matchLegalLinks(
  lex: LegalLexicon,
  kind: LegalKind,
  links: readonly LegalLinkRef[],
): (LinkMatch | null)[] {
  const own = links.map((l) => matchOwn(lex, kind, l.input));
  if (!own.some((m) => m?.tier === 4)) return own;
  const other: LegalKind = kind === 'privacy' ? 'impressum' : 'privacy';
  const exact = links.map((l) => matchOwn(lex, other, l.input)?.tier === 0);
  const exactPages = new Set(links.flatMap((l, i) => (exact[i] && l.page !== '' ? [l.page] : [])));
  return own.map((m, i) => {
    if (m?.tier !== 4) return m;
    const l = links[i] as LegalLinkRef;
    return exact[i] || (l.page !== '' && exactPages.has(l.page)) ? null : m;
  });
}

/**
 * Does the link point to the document `kind`, and how precisely? A privacy label that names a settings dialog
 * ("Datenschutz-Einstellungen", "Privacy settings") is rejected unless it contains a document phrase
 * ("Polityka prywatności i cookies"); the href path can still identify the link. A weak match yields to an exact
 * label of the other kind on the same link; links to one page are compared by `matchLegalLinks`.
 */
export function matchLegalLink(lex: LegalLexicon, kind: LegalKind, input: LinkInput): LinkMatch | null {
  return matchLegalLinks(lex, kind, [{ input, page: '' }])[0] ?? null;
}

export interface NavMatch {
  /** 0 exact label, 1 label starts with the key, 2 key inside the label, 3 path only. */
  tier: 0 | 1 | 2 | 3;
  keyword: string;
  byText: boolean;
}

/**
 * Match one navigation key. Strict keys ("legal", "about") count only as the exact label or the first path segment;
 * the others on word boundaries in the label and in the words of the path.
 */
export function matchNavPhrase(p: NavPhrase, input: LinkInput): NavMatch | null {
  let best: NavMatch | null = null;
  for (const l of labelsOf(input)) {
    const toks = tokensOf(l);
    if (toks.length === 0) continue;
    if (p.strict) {
      if (toks.join(' ') === p.norm) return { tier: 0, keyword: p.key, byText: true };
      continue;
    }
    const i = matchAt(toks, p.tokens, 'word');
    if (i < 0) continue;
    const exact = i === 0 && toks.length === p.tokens.length;
    const tier = exact ? 0 : i === 0 ? 1 : 2;
    if (!best || tier < best.tier) best = { tier, keyword: p.key, byText: true };
  }
  if (best) return best;
  if (p.strict) {
    const first = input.path.split('/').filter(Boolean)[0];
    return first !== undefined && normalizeLegalText(first) === p.norm
      ? { tier: 3, keyword: p.key, byText: false }
      : null;
  }
  const ptoks = tokensOf(input.path);
  return matchAt(ptoks, p.tokens, 'word') >= 0 ? { tier: 3, keyword: p.key, byText: false } : null;
}

/** Best match of a link over several navigation keys (ties: order of the keys). */
export function matchNav(phrases: readonly NavPhrase[], input: LinkInput): NavMatch | null {
  let best: NavMatch | null = null;
  for (const p of phrases) {
    const m = matchNavPhrase(p, input);
    if (m && (!best || m.tier < best.tier)) best = m;
  }
  return best;
}

interface Hit {
  lang: string;
  start: number;
  end: number;
  size: number;
}

/**
 * Languages whose markers for `kind` occur in the given texts (title, h1, section headings). A marker that lies
 * inside a longer marker of another language does not count ("Informativa sulla privacy" is Italian, not English;
 * "Privacyverklaring" is Dutch).
 */
export function markerLanguages(lex: LegalLexicon, kind: LegalKind, texts: readonly string[]): string[] {
  const langs: string[] = [];
  for (const text of texts) {
    const toks = tokensOf(text);
    if (toks.length === 0) continue;
    const hits: Hit[] = [];
    for (const m of lex.kinds[kind].markers) {
      const i = matchAt(toks, m.tokens, 'prefix');
      if (i >= 0) hits.push({ lang: m.lang, start: i, end: i + m.tokens.length, size: m.norm.length });
    }
    for (const h of hits) {
      const covered = hits.some(
        (o) =>
          o.lang !== h.lang &&
          o.start <= h.start &&
          o.end >= h.end &&
          (o.end - o.start > h.end - h.start || o.size > h.size),
      );
      if (!covered && !langs.includes(h.lang)) langs.push(h.lang);
    }
  }
  return langs;
}

/** An error-page phrase (or the number 404) in a title or heading. */
export function isNotFoundText(lex: LegalLexicon, text: string): boolean {
  const toks = tokensOf(text);
  return lex.notFound.some((p) => matchAt(toks, p.tokens, 'exact') >= 0);
}

/**
 * A page the collector fetched as a candidate document but could not confirm as that document type: the
 * stored document carries the error `unconfirmed`, or the attempt for its URL has the outcome `unconfirmed`. It is
 * neither found nor a soft-404.
 */
export function isUnconfirmedDocument(d: DocumentRecord, attempts: DocumentsSection['attempts']): boolean {
  if (d.errors.includes('unconfirmed')) return true;
  return attempts.some(
    (a) => a.kind === d.kind && a.outcome === 'unconfirmed' && (a.url === d.url || a.url === d.finalUrl),
  );
}
