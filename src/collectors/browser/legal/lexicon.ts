// Pure lexicon of legal links: ranked labels and path slugs for the Impressum and the privacy policy, heading markers
// per language, navigation keys for intermediate pages. No I/O: the collector reads `test/data/legal/links.yaml`
// through `lexicon-file.ts`, LEGAL-01 gets it via `ctx.data.legal`. Matching is per word at word boundaries, the last
// word may continue ("datenschutz" matches "datenschutzerklaerung"); navigation keys are stricter.
import { z } from 'zod';
import type { DocumentRecord, DocumentsSection } from '../../../core/snapshot/browser.ts';

export type LegalKind = 'impressum' | 'privacy';
export const LEGAL_KINDS: readonly LegalKind[] = ['impressum', 'privacy'];

/** Longer labels are text blobs; they count only when they contain a document phrase. */
const MAX_LABEL_TOKENS = 8;
/** Plural endings (kontakt → kontakte) are allowed, compounds are not. */
const NAV_SUFFIX = 2;
/** A weak key counts only as the whole label or in a label of at most this many words ("Alles zur DSGVO" is no link). */
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
  fallbackPaths: z.object({ impressum: z.string().startsWith('/'), privacy: z.string().startsWith('/') }),
  kinds: z.object({ impressum: KindSchema, privacy: KindSchema }),
  navigation: z.object({
    contact: z.array(z.string()),
    hop: z.array(z.string()),
    hopStrict: z.array(z.string()).default([]),
  }),
  notFound: z.array(z.string()),
});

export interface Phrase {
  key: string;
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
  labels: Set<string>;
  /** Spaces removed: "Datenschutz-Hinweise" is the canonical "Datenschutzhinweise". */
  labelsJoined: Set<string>;
  link: LinkPhrase[];
  markers: Phrase[];
  falseFriends: Phrase[];
}

export interface LegalLexicon {
  version: string;
  /** Conventional paths probed once per kind when no link led to the document. */
  fallbackPaths: Record<LegalKind, string>;
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

/** NFKC, lower case, ä→ae ö→oe ü→ue ß→ss, other diacritics dropped, non-alphanumerics → one space. */
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

export function pageKey(raw: string): string {
  try {
    const u = new URL(raw);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${p}${u.search}`;
  } catch {
    return raw;
  }
}

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

function compileKind(spec: z.infer<typeof KindSchema>): KindLexicon {
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

  return {
    labels,
    labelsJoined,
    link: [...byRole.generic, ...byRole.key, ...byRole.weak],
    markers,
    falseFriends: spec.falseFriends.map((f) => phrase(f, '*')).filter((p) => p.tokens.length > 0),
  };
}

function compile(raw: z.infer<typeof LexiconSchema>): LegalLexicon {
  const kinds = {} as Record<LegalKind, KindLexicon>;
  for (const kind of LEGAL_KINDS) kinds[kind] = compileKind(raw.kinds[kind]);

  const strict = new Set(raw.navigation.hopStrict.map(normalizeLegalText));
  const nav = (list: string[]): NavPhrase[] =>
    list
      .map((k) => phrase(k, '*'))
      .filter((p) => p.tokens.length > 0)
      .map((p) => ({ ...p, strict: strict.has(p.norm) }));

  return {
    version: raw.version,
    fallbackPaths: raw.fallbackPaths,
    kinds,
    contact: nav(raw.navigation.contact),
    hop: nav(raw.navigation.hop),
    notFound: raw.notFound.map((k) => phrase(k, '*')).filter((p) => p.tokens.length > 0),
  };
}

const cache = new WeakMap<object, LegalLexicon>();

/** Accepts the merged `{ legal: … }` data or a bare lexicon; throws on an invalid shape. */
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
  /** Tie-break between equal tiers. */
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

/** Best label of the link for `kind`; a settings label ("Datenschutz-Einstellungen") is skipped unless it is primary. */
function bestLabelMatch(k: KindLexicon, kind: LegalKind, input: LinkInput): LabelMatch | null {
  let label: LabelMatch | null = null;
  for (const l of labelsOf(input)) {
    const m = matchLabel(k, l);
    if (!m) continue;
    if (kind === 'privacy' && !m.primary && hasFalseFriend(k, tokensOf(l))) continue;
    if (!label || m.tier < label.tier) label = m;
  }
  return label;
}

function bestPathMatch(
  k: KindLexicon,
  kind: LegalKind,
  path: string,
): { tier: 3 | 4; keyword: string } | null {
  const ptoks = tokensOf(path);
  if (ptoks.length === 0) return null;

  let best: { tier: 3 | 4; keyword: string } | null = null;
  let primaryInPath = false;
  for (const p of k.link) {
    if (matchAt(ptoks, p.tokens, 'prefix') < 0) continue;
    if (p.role === 'key') primaryInPath = true;
    const tier = p.role === 'weak' ? 4 : 3;
    if (!best || tier < best.tier) best = { tier, keyword: p.key };
  }

  // A settings word in the path ("cookie-settings") switches the path match off unless the path carries a primary key
  // ("privacy-policy-and-cookies"), as for a label.
  if (kind === 'privacy' && !primaryInPath && hasFalseFriend(k, ptoks)) return null;
  return best;
}

function matchOwn(lex: LegalLexicon, kind: LegalKind, input: LinkInput): LinkMatch | null {
  const k = lex.kinds[kind];
  const label = bestLabelMatch(k, kind, input);
  const path = bestPathMatch(k, kind, input.path);

  const slug = path !== null && path.tier === 3;
  if (label && (!path || label.tier <= path.tier)) {
    return { tier: label.tier, keyword: label.keyword, byText: true, slug };
  }
  if (path) return { tier: path.tier, keyword: path.keyword, byText: false, slug };
  return null;
}

export interface LegalLinkRef {
  input: LinkInput;
  page: string;
}

// Matches several links for `kind` at once. A weak key (tier 4: a generic umbrella label) is the last resort and loses
// against an exact canonical label of the other kind, on the same link or on another link to the same page, so one URL
// is not offered as Impressum when a link names it privacy. Stronger tiers stay: a combined page belongs to both.
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

// A privacy label that names a settings dialog ("Datenschutz-Einstellungen") is rejected unless it contains a document
// phrase ("Polityka prywatności i cookies"); the href path can still identify the link. A weak match yields to an exact
// label of the other kind on the same link.
export function matchLegalLink(lex: LegalLexicon, kind: LegalKind, input: LinkInput): LinkMatch | null {
  return matchLegalLinks(lex, kind, [{ input, page: '' }])[0] ?? null;
}

export interface NavMatch {
  /** 0 exact label, 1 label starts with the key, 2 key inside the label, 3 path only. */
  tier: 0 | 1 | 2 | 3;
  keyword: string;
  byText: boolean;
}

// Strict keys ("legal", "about") count only as the exact label or the first path segment; the others at word boundaries
// in the label and in the path words.
export function matchNavPhrase(p: NavPhrase, input: LinkInput): NavMatch | null {
  return matchNavLabels(p, input) ?? matchNavPath(p, input);
}

function matchNavLabels(p: NavPhrase, input: LinkInput): NavMatch | null {
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
  return best;
}

function matchNavPath(p: NavPhrase, input: LinkInput): NavMatch | null {
  if (p.strict) {
    const first = input.path.split('/').filter(Boolean)[0];
    return first !== undefined && normalizeLegalText(first) === p.norm
      ? { tier: 3, keyword: p.key, byText: false }
      : null;
  }
  const ptoks = tokensOf(input.path);
  return matchAt(ptoks, p.tokens, 'word') >= 0 ? { tier: 3, keyword: p.key, byText: false } : null;
}

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

// A marker inside a longer marker of another language does not count ("Informativa sulla privacy" is Italian, not
// English).
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

export function isNotFoundText(lex: LegalLexicon, text: string): boolean {
  const toks = tokensOf(text);
  return lex.notFound.some((p) => matchAt(toks, p.tokens, 'exact') >= 0);
}

// A fetched candidate that could not be confirmed as the document type (error or attempt outcome `unconfirmed`):
// neither found nor a soft-404.
export function isUnconfirmedDocument(d: DocumentRecord, attempts: DocumentsSection['attempts']): boolean {
  if (d.errors.includes('unconfirmed')) return true;
  return attempts.some(
    (a) => a.kind === d.kind && a.outcome === 'unconfirmed' && (a.url === d.url || a.url === d.finalUrl),
  );
}
