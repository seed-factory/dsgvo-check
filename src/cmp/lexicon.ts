/** Pure button lexicon: label normalization, phrase matching and button kind. Data: test/data/cmp/lexicon.yaml. */
import { z } from 'zod';
import type { ButtonKind, CmpButton, CmpLexicon, Confidence } from './types.ts';

export type LexiconKind = 'accept' | 'reject' | 'settings' | 'save' | 'close' | 'later' | 'hide';
export const LEXICON_KINDS: readonly LexiconKind[] = [
  'reject',
  'accept',
  'settings',
  'save',
  'close',
  'later',
  'hide',
];

/** Labels longer than this are text blobs, a phrase inside them is only weak evidence. */
const MAX_CONFIDENT_TOKENS = 8;

/** An exact phrase always outscores a partial one: its score is this bonus plus the phrase length. */
const EXACT_PHRASE_SCORE = 1000;

const LexiconSchema = z.object({
  version: z.string().min(1),
  accept: z.array(z.string()),
  reject: z.array(z.string()),
  settings: z.array(z.string()),
  save: z.array(z.string()),
  close: z.array(z.string()),
  later: z.array(z.string()),
  hide: z.array(z.string()),
  negations: z.array(z.string().min(1)).min(1),
  necessity: z.array(z.string().min(1)).min(1),
  restrictions: z.array(z.string().min(1)).min(1),
  paid: z.array(z.string().min(1)).min(1),
  acknowledgements: z.array(z.string().min(1)).optional(),
  purAbo: z.array(z.string()).optional(),
  bannerKeywords: z.array(z.string()).optional(),
  cookieKeywords: z.array(z.string()).optional(),
});

/** Accepts the merged `test/data/cmp` object (`{ lexicon: … }`) or a bare lexicon object. */
export function lexiconFromData(data: unknown): CmpLexicon {
  const raw =
    data !== null && typeof data === 'object' && 'lexicon' in data
      ? (data as { lexicon: unknown }).lexicon
      : data;
  const res = LexiconSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`cmp lexicon: ${issues}`);
  }
  return res.data;
}

const CLOSE_GLYPHS = /[✕✖✗✘╳⨯⤫]/gu;

export function normalizeLabel(label: string): string {
  return label.normalize('NFKC').replace(CLOSE_GLYPHS, '×').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function labelTokens(label: string): string[] {
  return normalizeLabel(label).match(/[\p{L}\p{N}]+|×/gu) ?? [];
}

interface TokenPattern {
  phrase: string;
  tokens: string[];
  suffix: string | null;
}

interface PhraseMatcher extends TokenPattern {
  kind: LexiconKind;
}

/** A `*suffix` phrase matches any token that ends with it; any other phrase matches its token sequence. */
function tokenPattern(phrase: string): TokenPattern | null {
  if (phrase.startsWith('*')) {
    const suffix = normalizeLabel(phrase.slice(1));
    return suffix ? { phrase, tokens: [], suffix } : null;
  }

  const tokens = labelTokens(phrase);
  return tokens.length > 0 ? { phrase, tokens, suffix: null } : null;
}

function phraseMatcher(kind: LexiconKind, phrase: string): PhraseMatcher | null {
  const pattern = tokenPattern(phrase);
  return pattern ? { ...pattern, kind } : null;
}

const matcherCache = new WeakMap<CmpLexicon, PhraseMatcher[]>();

function matchers(lexicon: CmpLexicon): PhraseMatcher[] {
  let list = matcherCache.get(lexicon);
  if (!list) {
    list = [];
    for (const kind of LEXICON_KINDS) {
      for (const phrase of lexicon[kind]) {
        const matcher = phraseMatcher(kind, phrase);
        if (matcher) list.push(matcher);
      }
    }
    matcherCache.set(lexicon, list);
  }
  return list;
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  return occurrences(haystack, needle) > 0;
}

function occurrences(haystack: string[], needle: string[]): number {
  let n = 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    n++;
  }
  return n;
}

/** How often the pattern occurs in the tokens; a `*suffix` pattern counts the tokens ending with it. */
function countPattern(p: TokenPattern, tokens: string[]): number {
  if (p.suffix) return tokens.filter((t) => t.endsWith(p.suffix as string)).length;
  return occurrences(tokens, p.tokens);
}

export type DecisionKind = 'reject' | 'accept';

/** Why a reject or accept phrase in a label is no decision. */
export type Qualifier = 'paid' | 'negation' | 'restriction';

export interface LabelMatch {
  kind: LexiconKind | null;
  confidence: Confidence;
  phrase: string | null;
  /** The label holds a reject or accept phrase that it qualifies, so it is no decision (`kind` is null). */
  qualified?: { kind: DecisionKind; by: Qualifier };
}

interface Qualifiers {
  negations: TokenPattern[];
  necessity: TokenPattern[];
  restrictions: TokenPattern[];
  paid: TokenPattern[];
}

const qualifierCache = new WeakMap<CmpLexicon, Qualifiers>();

function qualifiers(lexicon: CmpLexicon): Qualifiers {
  let q = qualifierCache.get(lexicon);
  if (!q) {
    const patterns = (list: string[] | undefined) =>
      (list ?? []).map(tokenPattern).filter((p): p is TokenPattern => p !== null);
    q = {
      negations: patterns(lexicon.negations),
      necessity: patterns(lexicon.necessity),
      restrictions: patterns(lexicon.restrictions),
      paid: patterns(lexicon.paid),
    };
    qualifierCache.set(lexicon, q);
  }
  return q;
}

/** The label names a subscription or a payment (pay-or-OK): clicking it is never a reject or an accept. */
export function isPaidLabel(label: string, lexicon: CmpLexicon): boolean {
  const tokens = labelTokens(label);
  return qualifiers(lexicon).paid.some((p) => countPattern(p, tokens) > 0);
}

/** Length of the pattern at index `at` of the tokens (0 = no match there). */
function lengthAt(p: TokenPattern, tokens: string[], at: number): number {
  if (p.suffix) return tokens[at]?.endsWith(p.suffix) ? 1 : 0;
  for (let j = 0; j < p.tokens.length; j++) if (tokens[at + j] !== p.tokens[j]) return 0;
  return p.tokens.length;
}

/**
 * A negation before the first occurrence of the decision phrase negates the decision ("Nicht alle akzeptieren", "Keine
 * optionalen Cookies akzeptieren", "I do not want to accept"), unless a necessity word follows it: then it negates a
 * cookie category ("Nicht notwendige Cookies ablehnen"). A negation inside or after the phrase never counts ("Nicht
 * zustimmen", "Reject non-essential cookies").
 */
function negatesDecision(phrase: TokenPattern, tokens: string[], q: Qualifiers): boolean {
  const end = tokens.findIndex((_t, i) => lengthAt(phrase, tokens, i) > 0);
  for (let i = 0; i < end; i++) {
    for (const n of q.negations) {
      const len = lengthAt(n, tokens, i);
      if (len === 0 || i + len > end) continue;
      if (!q.necessity.some((c) => lengthAt(c, tokens, i + len) > 0)) return true;
    }
  }
  return false;
}

/**
 * Why the decision phrase found in the label is no decision: payment wording anywhere, a negation of the decision
 * (`negatesDecision`), or for an accept a restriction outside the phrase ("Nur Statistik akzeptieren").
 */
function decisionQualifier(
  kind: DecisionKind,
  phrase: TokenPattern,
  tokens: string[],
  lexicon: CmpLexicon,
): Qualifier | null {
  const q = qualifiers(lexicon);
  const outside = (p: TokenPattern) => countPattern(p, tokens) > countPattern(p, phrase.tokens);
  if (q.paid.some((p) => countPattern(p, tokens) > 0)) return 'paid';
  if (negatesDecision(phrase, tokens, q)) return 'negation';
  if (kind === 'accept' && q.restrictions.some(outside)) return 'restriction';
  return null;
}

/** Kinds that only dismiss the dialog; combined with a decision ("Ablehnen und schließen") the decision counts. */
const DISMISS_KINDS: ReadonlySet<LexiconKind> = new Set(['close', 'hide', 'later']);
const DECISION_KINDS: ReadonlySet<string> = new Set(['reject', 'accept']);

const isDecision = (kind: string | null | undefined): kind is DecisionKind =>
  kind != null && DECISION_KINDS.has(kind);

/** Of equally scored kinds, the one decision when every other kind only dismisses the dialog; otherwise null. */
function breakTie(kinds: ReadonlySet<LexiconKind>): LexiconKind | null {
  const decisions = [...kinds].filter((k) => DECISION_KINDS.has(k));
  if (decisions.length !== 1) return null;
  return [...kinds].every((k) => DECISION_KINDS.has(k) || DISMISS_KINDS.has(k))
    ? (decisions[0] ?? null)
    : null;
}

const noMatch = (): LabelMatch => ({ kind: null, confidence: 'low', phrase: null });

/** How well one phrase matches the label tokens: 0 = no match; exact phrase > phrase inside the label > `*suffix`. */
function scorePhrase(m: PhraseMatcher, tokens: string[]): { score: number; exact: boolean } {
  if (m.suffix) return { score: tokens.some((t) => t.endsWith(m.suffix as string)) ? 1 : 0, exact: false };
  if (m.tokens.length === tokens.length && containsSequence(tokens, m.tokens)) {
    return { score: EXACT_PHRASE_SCORE + m.tokens.length, exact: true };
  }
  if (containsSequence(tokens, m.tokens)) return { score: m.tokens.length, exact: false };
  return { score: 0, exact: false };
}

interface ScoredPhrase {
  score: number;
  exact: boolean;
  m: PhraseMatcher;
}

/** The phrases with the highest score (several when they tie). */
function bestPhrases(tokens: string[], lexicon: CmpLexicon): ScoredPhrase[] {
  let best: ScoredPhrase[] = [];
  let bestScore = 0;
  for (const m of matchers(lexicon)) {
    const { score, exact } = scorePhrase(m, tokens);
    if (score === 0) continue;

    if (score > bestScore) {
      bestScore = score;
      best = [{ score, exact, m }];
    } else if (score === bestScore) {
      best.push({ score, exact, m });
    }
  }
  return best;
}

/**
 * Exact phrase → high; phrase inside a longer label (or a `*suffix` token) → medium (low for long text blobs); the
 * longest phrase wins; ties between kinds stay unclassified unless `breakTie` decides. A reject or accept that the
 * label qualifies (`decisionQualifier`) is no decision.
 */
export function classifyLabel(label: string, lexicon: CmpLexicon): LabelMatch {
  const tokens = labelTokens(label);
  if (tokens.length === 0) return noMatch();

  const best = bestPhrases(tokens, lexicon);
  let top = best[0];
  if (!top) return noMatch();

  const kinds = new Set(best.map((b) => b.m.kind));
  if (kinds.size > 1) {
    const winner = breakTie(kinds);
    top = winner ? best.find((b) => b.m.kind === winner) : undefined;
    if (!top) return noMatch();
  }

  const decision = top.m.kind;
  if (isDecision(decision)) {
    const by = decisionQualifier(decision, top.m, tokens, lexicon);
    if (by) return { ...noMatch(), qualified: { kind: decision, by } };
  }

  const confidence: Confidence = top.exact ? 'high' : tokens.length > MAX_CONFIDENT_TOKENS ? 'low' : 'medium';
  return { kind: top.m.kind, confidence, phrase: top.m.phrase };
}

const DOWNGRADE: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };

export function isLinkRole(role: string): boolean {
  return role === 'link';
}

/**
 * Whether the CMP's markup role may stand for a label that is no decision itself. Never for payment wording; never
 * an accept for a qualified label; a reject only when the label did not negate a reject ("Nur technisch benötigte
 * Cookies akzeptieren" on the vendor's reject button is that reject, "Nicht ablehnen" is not).
 */
function vendorRoleApplies(vendor: ButtonKind, m: LabelMatch, label: string, lexicon: CmpLexicon): boolean {
  if (!isDecision(vendor)) return true;
  if (isPaidLabel(label, lexicon)) return false;
  if (!m.qualified) return true;
  return vendor === 'reject' && m.qualified.kind !== 'reject';
}

/** Kind of one control: label (lexicon) first, the CMP's own markup role as corroboration or fallback. */
export function classifyButton(
  b: Pick<CmpButton, 'name' | 'role'> & { vendorRole?: ButtonKind | null },
  lexicon: CmpLexicon,
): { kind: ButtonKind; kindConfidence: Confidence } {
  const m = classifyLabel(b.name, lexicon);
  const role = b.vendorRole && b.vendorRole !== 'other' && b.vendorRole !== 'link' ? b.vendorRole : null;
  const vendor = role && vendorRoleApplies(role, m, b.name, lexicon) ? role : null;
  if (m.kind) {
    if (!vendor) return { kind: m.kind, kindConfidence: m.confidence };
    if (vendor === m.kind) return { kind: m.kind, kindConfidence: 'high' };
    // Conflict (e.g. the CMP's decline button relabelled "Verbergen"): the visible label decides, less sure.
    return { kind: m.kind, kindConfidence: DOWNGRADE[m.confidence] };
  }
  if (vendor) return { kind: vendor, kindConfidence: 'medium' };
  if (isLinkRole(b.role)) return { kind: 'link', kindConfidence: 'high' };
  return { kind: 'other', kindConfidence: 'low' };
}
