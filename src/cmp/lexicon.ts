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
  // Optional: without it every necessity word beside an accept phrase restricts it, which only costs accepts.
  allWords: z.array(z.string().min(1)).optional(),
  // Optional: without it a recommendation beside a reject phrase that names the necessary cookies leaves the label
  // without a decision, which only costs rejects.
  neutralWords: z.array(z.string().min(1)).optional(),
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

const TOKEN = /[\p{L}\p{N}]+|×/gu;

export function labelTokens(label: string): string[] {
  return normalizeLabel(label).match(TOKEN) ?? [];
}

/**
 * Punctuation between words that ends a clause: comma, semicolon, colon, full stop, question and exclamation mark,
 * brackets, ampersand, slash, dashes and a hyphen between spaces. A hyphen or an apostrophe inside a word ends none
 * ("non-essential", "don't"). The group keeps the punctuation in the split, so brackets can be told apart.
 */
const CLAUSE_BREAK = /([,;:.!?()[\]{}&/|–—]|\s-\s)/u;
const OPENING_BRACKET = /^[([{]$/u;
const CLOSING_BRACKET = /^[)\]}]$/u;

/** Stands for a clause break among the tokens of a label; never a token of a phrase, negation or category word. */
const BREAK = ',';
/**
 * Clause breaks that open and close an outermost pair of brackets: a bracketed insertion ends the clause for phrases,
 * but a negation of a consent reaches across it (`acceptNegationScopes`). Inner brackets and a closing bracket without
 * an opening one are a `BREAK`; an opening bracket that is never closed stays `OPEN`, an insertion that runs to the end.
 */
const OPEN = '(';
const CLOSE = ')';

const isBreak = (token: string | undefined): boolean => token === BREAK || token === OPEN || token === CLOSE;

/**
 * The label tokens with a clause break (`BREAK`, `OPEN` or `CLOSE`) between two clauses: no phrase, negation or negated
 * category reaches across it. The `CLOSE` of a final insertion stays, so that the insertion reads as complete.
 */
function clauseTokens(label: string): string[] {
  const out: string[] = [];
  let depth = 0;
  normalizeLabel(label)
    .split(CLAUSE_BREAK)
    .forEach((part, i) => {
      if (i % 2 === 0) {
        out.push(...(part.match(TOKEN) ?? []));
        return;
      }
      let mark = BREAK;
      if (OPENING_BRACKET.test(part)) {
        if (depth === 0) mark = OPEN;
        depth++;
      } else if (CLOSING_BRACKET.test(part) && depth > 0) {
        depth--;
        if (depth === 0) mark = CLOSE;
      }
      if (out.length > 0) out.push(mark);
    });
  while (out.at(-1) === BREAK || out.at(-1) === OPEN) out.pop();
  return out;
}

/** End (exclusive) of the clause that holds the token at index `at`. */
function clauseEnd(tokens: string[], at: number): number {
  for (let i = at; i < tokens.length; i++) if (isBreak(tokens[i])) return i;
  return tokens.length;
}

/** Start of the clause that holds the token at index `at`. */
function clauseStart(tokens: string[], at: number): number {
  for (let i = at - 1; i >= 0; i--) if (isBreak(tokens[i])) return i + 1;
  return 0;
}

/**
 * End (exclusive) of the clause that holds the token at index `at`, which a complete bracketed insertion interrupts
 * but does not end ("Ich akzeptiere (die Cookies) nicht").
 */
function clauseEndPastInsertions(tokens: string[], at: number): number {
  let end = clauseEnd(tokens, at);
  for (let next = pastInsertions(tokens, end); next > end; next = pastInsertions(tokens, end)) {
    end = clauseEnd(tokens, next);
  }
  return end;
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

/**
 * Why a reject or accept phrase in a label is no decision. `category`: the phrase only matched half of a negated cookie
 * category ("Ich akzeptiere nicht notwendige Cookies" holds "ich akzeptiere nicht"), and no other phrase decides.
 */
export type Qualifier = 'paid' | 'negation' | 'restriction' | 'category';

export interface LabelMatch {
  kind: LexiconKind | null;
  confidence: Confidence;
  phrase: string | null;
  /**
   * The label holds a reject or accept phrase that it qualifies, so it is no decision (`kind` is null); a reject phrase
   * that refuses not all cookies reads as a negated accept ("Ich akzeptiere nicht alle Cookies").
   */
  qualified?: { kind: DecisionKind; by: Qualifier };
}

interface Qualifiers {
  negations: TokenPattern[];
  necessity: TokenPattern[];
  restrictions: TokenPattern[];
  paid: TokenPattern[];
  allWords: TokenPattern[];
  neutralWords: TokenPattern[];
  /** `cookieKeywords` as the probe reads them: case-insensitive regex sources, an invalid one matches nothing. */
  cookieWords: RegExp[];
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
      allWords: patterns(lexicon.allWords),
      neutralWords: patterns(lexicon.neutralWords),
      cookieWords: (lexicon.cookieKeywords ?? []).flatMap((k) => {
        try {
          return [new RegExp(k, 'iu')];
        } catch {
          return [];
        }
      }),
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

/** Index of the first token after the bracketed insertions that start at index `at`. */
function pastInsertions(tokens: string[], at: number): number {
  let i = at;
  while (tokens[i] === OPEN) {
    const close = tokens.indexOf(CLOSE, i);
    if (close < 0) return i;
    i = close + 1;
  }
  return i;
}

/**
 * Where a negation before the accept phrase at index `at` negates it: its clause up to the phrase and, while a bracketed
 * insertion directly precedes the clause, the clause the insertion interrupts ("Nicht (alle Cookies) akzeptieren").
 */
function acceptNegationScopes(tokens: string[], at: number): Span[] {
  let start = clauseStart(tokens, at);
  const scopes: Span[] = [[start, at]];
  while (tokens[start - 1] === CLOSE) {
    const open = tokens.lastIndexOf(OPEN, start - 2);
    if (open < 0) break;
    start = clauseStart(tokens, open);
    scopes.push([start, open]);
  }
  return scopes;
}

/** A negation in the clause before the bracketed insertion that opens at index `open` ends directly before it. */
function negationBefore(tokens: string[], open: number, q: Qualifiers): boolean {
  for (let i = clauseStart(tokens, open); i < open; i++) {
    if (q.negations.some((n) => lengthAt(n, tokens, i) === open - i)) return true;
  }
  return false;
}

/** The accept phrase at index `at` opens a bracketed insertion that directly follows a negation ("Do not (accept all)"). */
function negatedBeforeInsertion(tokens: string[], at: number, q: Qualifiers): boolean {
  return tokens[at - 1] === OPEN && negationBefore(tokens, at - 1, q);
}

/**
 * The reject phrase at index `at` directly follows a bracketed insertion that directly follows a negation, and starts
 * with no necessity word ("Nicht (alle Cookies) ablehnen"). A reject phrase inside the insertion stays one: "No (reject
 * all)" answers.
 */
function negatedAcrossInsertion(tokens: string[], at: number, q: Qualifiers): boolean {
  if (tokens[at - 1] !== CLOSE) return false;
  const open = tokens.lastIndexOf(OPEN, at - 2);
  if (open < 0 || q.necessity.some((c) => lengthAt(c, tokens, at) > 0)) return false;
  return negationBefore(tokens, open, q);
}

/**
 * A negation before the first occurrence of the decision phrase, in its clause, negates the decision ("Nicht alle
 * akzeptieren", "Keine optionalen Cookies akzeptieren", "I do not want to accept"), unless a necessity word follows it,
 * also past a bracketed insertion: then it negates a cookie category ("Nicht notwendige Cookies ablehnen"). A negation
 * inside the phrase never counts ("Nicht zustimmen"), one after it only after an accept phrase (`negatedAfterAccept`),
 * and one in a clause of its own answers rather than negates ("No, reject all"). A bracketed insertion does not end the
 * negation of an accept that it interrupts or that opens it (`acceptNegationScopes`, `negatedBeforeInsertion`); before
 * a reject it does, since what stands there answers ("Kein Tracking (empfohlen) alle ablehnen"), unless the negation
 * directly precedes the insertion and the phrase directly follows it (`negatedAcrossInsertion`).
 */
function negatesDecision(kind: DecisionKind, phrase: TokenPattern, tokens: string[], q: Qualifiers): boolean {
  const at = firstAt(phrase, tokens);
  if (at < 0) return false;
  const scopes: Span[] =
    kind === 'accept' ? acceptNegationScopes(tokens, at) : [[clauseStart(tokens, at), at]];
  for (const [start, end] of scopes) {
    for (let i = start; i < end; i++) {
      for (const n of q.negations) {
        const len = lengthAt(n, tokens, i);
        if (len === 0 || i + len > end) continue;
        const next = pastInsertions(tokens, i + len);
        if (!q.necessity.some((c) => lengthAt(c, tokens, next) > 0)) return true;
      }
    }
  }
  return kind === 'accept' ? negatedBeforeInsertion(tokens, at, q) : negatedAcrossInsertion(tokens, at, q);
}

/** Length of the longest of the patterns at index `at` of the tokens (0 = none matches there). */
function longestAt(patterns: TokenPattern[], tokens: string[], at: number): number {
  let best = 0;
  for (const p of patterns) best = Math.max(best, lengthAt(p, tokens, at));
  return best;
}

/** Token range [start, end) of a label. */
type Span = readonly [start: number, end: number];

/**
 * The negated cookie categories of the label: a negation directly followed by necessity words ("nicht notwendige",
 * "non-essential", "not strictly necessary"). Each one is a single adjective that names the optional cookies.
 */
function negatedCategories(tokens: string[], q: Qualifiers): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const negation = longestAt(q.negations, tokens, i);
    if (negation === 0) continue;
    let end = i + negation;
    while (longestAt(q.necessity, tokens, end) > 0) end += longestAt(q.necessity, tokens, end);
    if (end > i + negation) spans.push([i, end]);
  }
  return spans;
}

/**
 * The phrase starts or ends inside a negated category, so it reads only half of it: "ich akzeptiere nicht" in "Ich
 * akzeptiere nicht notwendige Cookies" (the negation belongs to the category, not to the verb), "notwendige cookies
 * akzeptieren" in "Nicht notwendige Cookies akzeptieren".
 */
function cutsCategory(p: TokenPattern, tokens: string[], categories: Span[]): boolean {
  if (categories.length === 0) return false;
  for (let i = 0; i < tokens.length; i++) {
    const len = lengthAt(p, tokens, i);
    if (len === 0) continue;
    const end = i + len;
    if (categories.some(([s, e]) => (i > s && i < e) || (end > s && end < e))) return true;
  }
  return false;
}

/**
 * An accept that names the necessary cookies, i.e. refuses all others ("Accept strictly necessary cookies"): a necessity
 * word outside every negated category ("Accept non-essential cookies" names the optional ones), and no word for all
 * cookies except one that quantifies a necessity word ("Alle Cookies akzeptieren, auch technisch notwendige" is all
 * cookies, "Alle notwendigen Cookies akzeptieren" is not). Accept phrases hold no necessity word (lexicon test).
 */
function namesNecessaryOnly(tokens: string[], q: Qualifiers, categories: Span[]): boolean {
  const negated = (i: number) => categories.some(([s, e]) => i >= s && i < e);
  const necessary = tokens.some((_t, i) => !negated(i) && longestAt(q.necessity, tokens, i) > 0);
  if (!necessary) return false;
  return !tokens.some((_t, i) => {
    const len = longestAt(q.allWords, tokens, i);
    return len > 0 && longestAt(q.necessity, tokens, i + len) === 0;
  });
}

/** Index of the first occurrence of the pattern in the tokens, -1 when there is none. */
function firstAt(p: TokenPattern, tokens: string[]): number {
  return tokens.findIndex((_t, i) => lengthAt(p, tokens, i) > 0);
}

/**
 * A negation directly after an accept phrase negates its object ("Ich akzeptiere keine Cookies", "Accept no tracking
 * cookies"), one at the end of the phrase's clause the sentence ("Ich akzeptiere die Cookies nicht"), also where a
 * bracketed insertion interrupts the clause ("Ich akzeptiere (die Cookies) nicht"), unless it starts a negated category
 * ("Accept non-essential cookies"). Elsewhere after the phrase it stands in a clause of its own ("Akzeptieren und nicht
 * mehr anzeigen", "Akzeptieren, nicht mehr anzeigen"), inside an insertion it remarks on the consent ("Ich akzeptiere
 * (nicht empfohlen)"), and after a reject phrase it names what is refused ("Ablehnen (keine Statistik)").
 */
function negatedAfterAccept(
  phrase: TokenPattern,
  tokens: string[],
  q: Qualifiers,
  categories: Span[],
): boolean {
  const start = firstAt(phrase, tokens);
  if (start < 0) return false;
  const after = start + lengthAt(phrase, tokens, start);
  const end = clauseEndPastInsertions(tokens, after);
  for (let i = after; i < end; i++) {
    if (tokens[i] === OPEN) {
      i = pastInsertions(tokens, i) - 1;
      continue;
    }
    const len = longestAt(q.negations, tokens, i);
    if (len === 0 || categories.some(([s]) => s === i)) continue;
    if (i === after || i + len === end || tokens[i + len] === OPEN) return true;
  }
  return false;
}

/**
 * A reject phrase that negates a consent ("ich akzeptiere nicht", "do not accept", "i don't agree") followed in its
 * clause by a word for all cookies refuses only part of them, like "Nicht alle akzeptieren" ("Ich akzeptiere nicht alle
 * Cookies", "Do not accept all"); a cookie word between the negation and that word makes the negation refuse the
 * cookies ("Accept no cookies at all"). The negation reaches into and across a bracketed insertion in its clause ("Ich
 * akzeptiere nicht (alle Cookies)").
 */
function refusesNotAll(phrase: TokenPattern, tokens: string[], q: Qualifiers): boolean {
  const start = firstAt(phrase, tokens);
  if (start < 0) return false;
  const end = start + phrase.tokens.length;
  let negation = -1;
  for (let i = start; i < end && negation < 0; i++) {
    const len = longestAt(q.negations, tokens, i);
    if (len > 0 && i + len <= end) negation = i;
  }
  if (negation < 0) return false;
  const clause = clauseEndPastInsertions(tokens, negation);
  for (let i = negation + 1; i < clause; i++) {
    if (q.cookieWords.some((re) => re.test(tokens[i] ?? ''))) return false;
    if (i >= end && longestAt(q.allWords, tokens, i) > 0) return true;
  }
  return false;
}

/**
 * A reject phrase that refuses only by naming the necessary cookies, without a restriction or negation word ("Accept
 * necessary", "Notwendige Cookies akzeptieren"), with other words beside it than cookie, necessity, restriction and
 * neutral words ("Mit notwendigen Cookies fortfahren (empfohlen)" refuses). Another category makes it consent to more
 * than the necessary cookies ("Accept necessary and analytics cookies", "Accept necessary cookies (incl. analytics)"),
 * and other wording is not read ("Accept necessary cookies and continue"): the phrase does not count, and the label
 * stays an accept restricted to the necessary cookies, by the accept phrase it holds (`namesNecessaryOnly`) or by
 * `classifyLabel` when no other phrase decides.
 */
function necessaryOnlyAmidOtherWords(m: PhraseMatcher, tokens: string[], q: Qualifiers): boolean {
  if (m.kind !== 'reject' || m.suffix) return false;
  const holds = (list: TokenPattern[]) => list.some((p) => countPattern(p, m.tokens) > 0);
  if (!holds(q.necessity) || holds(q.negations) || holds(q.restrictions)) return false;
  const start = firstAt(m, tokens);
  if (start < 0) return false;
  const end = start + m.tokens.length;
  for (let i = 0; i < tokens.length; ) {
    if ((i >= start && i < end) || isBreak(tokens[i])) {
      i = i >= start && i < end ? end : i + 1;
      continue;
    }
    const len = Math.max(
      longestAt(q.necessity, tokens, i),
      longestAt(q.restrictions, tokens, i),
      longestAt(q.neutralWords, tokens, i),
    );
    if (len > 0) i += len;
    else if (q.cookieWords.some((re) => re.test(tokens[i] ?? ''))) i++;
    else return true;
  }
  return false;
}

/**
 * Why the decision phrase found in the label is no decision: payment wording anywhere, a negation of the decision
 * (`negatesDecision`, `negatedAfterAccept`), a reject that refuses not all cookies (`refusesNotAll`, a negated accept),
 * or for an accept a restriction outside the phrase ("Nur Statistik akzeptieren") or the necessary cookies alone
 * (`namesNecessaryOnly`).
 */
function decisionQualifier(
  kind: DecisionKind,
  phrase: TokenPattern,
  tokens: string[],
  q: Qualifiers,
  categories: Span[],
): { kind: DecisionKind; by: Qualifier } | null {
  const outside = (p: TokenPattern) => countPattern(p, tokens) > countPattern(p, phrase.tokens);
  if (q.paid.some((p) => countPattern(p, tokens) > 0)) return { kind, by: 'paid' };
  if (negatesDecision(kind, phrase, tokens, q)) return { kind, by: 'negation' };
  if (kind === 'reject') return refusesNotAll(phrase, tokens, q) ? { kind: 'accept', by: 'negation' } : null;
  if (negatedAfterAccept(phrase, tokens, q, categories)) return { kind, by: 'negation' };
  if (q.restrictions.some(outside) || namesNecessaryOnly(tokens, q, categories))
    return { kind, by: 'restriction' };
  return null;
}

/**
 * Kinds that only dismiss the dialog; combined with a decision ("Ablehnen und schließen", "Ablehnen und Fenster
 * schließen") the decision counts.
 */
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

/**
 * How well one phrase matches the label tokens: 0 = no match; exact phrase > phrase inside the label > `*suffix`. A
 * label that is the phrase is it whatever its punctuation ("OK, verstanden"), inside a longer label a phrase stays in
 * one clause (`words`: the tokens without breaks).
 */
function scorePhrase(m: PhraseMatcher, tokens: string[], words: string[]): { score: number; exact: boolean } {
  if (m.suffix) return { score: tokens.some((t) => t.endsWith(m.suffix as string)) ? 1 : 0, exact: false };
  if (m.tokens.length === words.length && containsSequence(words, m.tokens)) {
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

/**
 * The phrases with the highest score (several when they tie), without those that cut a negated category or name the
 * necessary cookies amid other words; `cut` is the decision of a phrase that cut a category, reject before accept, and
 * `amid` says a phrase of `necessaryOnlyAmidOtherWords` was left out. Phrases that only dismiss the dialog do not
 * outscore a decision ("Ablehnen und Fenster schließen" is a reject): beside one they leave the best of the others.
 */
function bestPhrases(
  tokens: string[],
  words: string[],
  lexicon: CmpLexicon,
  q: Qualifiers,
  categories: Span[],
): { best: ScoredPhrase[]; cut: DecisionKind | null; amid: boolean } {
  let best: ScoredPhrase[] = [];
  let bestScore = 0;
  let cut: DecisionKind | null = null;
  let amid = false;
  const scored: ScoredPhrase[] = [];
  for (const m of matchers(lexicon)) {
    const { score, exact } = scorePhrase(m, tokens, words);
    if (score === 0) continue;
    if (cutsCategory(m, tokens, categories)) {
      if (isDecision(m.kind) && cut !== 'reject') cut = m.kind;
      continue;
    }
    if (necessaryOnlyAmidOtherWords(m, tokens, q)) {
      amid = true;
      continue;
    }

    scored.push({ score, exact, m });
    if (score > bestScore) {
      bestScore = score;
      best = [{ score, exact, m }];
    } else if (score === bestScore) {
      best.push({ score, exact, m });
    }
  }
  if (best.every((b) => DISMISS_KINDS.has(b.m.kind))) {
    const others = scored.filter((s) => !DISMISS_KINDS.has(s.m.kind));
    const top = Math.max(0, ...others.map((s) => s.score));
    const atTop = others.filter((s) => s.score === top);
    if (atTop.some((s) => isDecision(s.m.kind))) best = atTop;
  }
  return { best, cut, amid };
}

/**
 * No decision, with its strongest qualifier: payment wording, then a reject phrase that cut a negated category (such a
 * label speaks of the optional cookies, so the vendor's reject markup cannot make it a reject), then the qualifier of
 * the phrase found instead. Callers pass a left-out necessary-only phrase as an accept restricted to the necessary
 * cookies.
 */
function undecided(cut: DecisionKind | null, qualified?: { kind: DecisionKind; by: Qualifier }): LabelMatch {
  const category = cut ? { kind: cut, by: 'category' as const } : undefined;
  const strongest = qualified?.by === 'paid' || cut !== 'reject' ? (qualified ?? category) : category;
  return strongest ? { ...noMatch(), qualified: strongest } : noMatch();
}

/**
 * Exact phrase → high; phrase inside a longer label, within one clause (or a `*suffix` token) → medium (low for long
 * text blobs); the longest phrase wins, a dismissing one not over a decision (`bestPhrases`); a phrase that cuts a
 * negated category does not count (`cutsCategory`); ties between kinds stay unclassified unless `breakTie` decides,
 * also among the phrases the label does not qualify. A reject or accept that the label qualifies (`decisionQualifier`)
 * is no decision.
 */
export function classifyLabel(label: string, lexicon: CmpLexicon): LabelMatch {
  const tokens = clauseTokens(label);
  if (tokens.length === 0) return noMatch();
  const words = tokens.filter((t) => !isBreak(t));

  const q = qualifiers(lexicon);
  const categories = negatedCategories(tokens, q);
  const { best, cut, amid } = bestPhrases(tokens, words, lexicon, q, categories);
  const judged = best.map((b) => {
    const kind = b.m.kind;
    const qualified = isDecision(kind) ? decisionQualifier(kind, b.m, tokens, q, categories) : null;
    return { b, qualified: qualified ?? undefined };
  });
  const kinds = new Set(best.map((b) => b.m.kind));
  // A phrase the label qualifies is no decision, so on a tie the other decision may win alone ("Ich akzeptiere nur
  // notwendige": "nur notwendige" against the restricted "ich akzeptiere").
  const open = new Set(judged.flatMap((j) => (j.qualified ? [] : [j.b.m.kind])));
  const winner = kinds.size === 1 ? (best[0]?.m.kind ?? null) : (breakTie(kinds) ?? breakTie(open));

  // On an undecided tie every phrase counts, so a qualified one keeps the vendor role from deciding instead.
  const pool = winner ? judged.filter((j) => j.b.m.kind === winner) : judged;
  // Of equally long phrases of the winning kind, one the label does not qualify decides.
  const top = winner ? pool.find((j) => !j.qualified)?.b : undefined;
  // A left-out necessary-only phrase still names the necessary cookies: without another decision the label is none.
  if (!top || (amid && !isDecision(top.m.kind))) {
    // A qualified reject goes first: it keeps the vendor's reject markup from deciding.
    const qualified = pool.flatMap((j) => (j.qualified ? [j.qualified] : []));
    const necessaryOnly = amid ? { kind: 'accept' as const, by: 'restriction' as const } : undefined;
    return undecided(cut, qualified.find((x) => x.kind === 'reject') ?? qualified[0] ?? necessaryOnly);
  }

  const confidence: Confidence = top.exact ? 'high' : words.length > MAX_CONFIDENT_TOKENS ? 'low' : 'medium';
  return { kind: top.m.kind, confidence, phrase: top.m.phrase };
}

const DOWNGRADE: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };

export function isLinkRole(role: string): boolean {
  return role === 'link';
}

/**
 * Whether the CMP's markup role may stand for a label that is no decision itself. Never for payment wording; never
 * an accept for a qualified label; a reject only when the qualified phrase is no reject ("Nur technisch benötigte
 * Cookies akzeptieren" on the vendor's reject button is that reject, "Nicht ablehnen" is not, and neither is a label
 * whose reject phrase cut a negated category).
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
