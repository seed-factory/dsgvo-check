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
  purAbo: z.array(z.string()).optional(),
  bannerKeywords: z.array(z.string()).optional(),
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

interface PhraseMatcher {
  kind: LexiconKind;
  phrase: string;
  tokens: string[];
  suffix: string | null;
}

/** A `*suffix` phrase matches any token that ends with it; any other phrase matches its token sequence. */
function phraseMatcher(kind: LexiconKind, phrase: string): PhraseMatcher | null {
  if (phrase.startsWith('*')) {
    const suffix = normalizeLabel(phrase.slice(1));
    return suffix ? { kind, phrase, tokens: [], suffix } : null;
  }

  const tokens = labelTokens(phrase);
  return tokens.length > 0 ? { kind, phrase, tokens, suffix: null } : null;
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
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export interface LabelMatch {
  kind: LexiconKind | null;
  confidence: Confidence;
  phrase: string | null;
}

/** Kinds that only dismiss the dialog; combined with a decision ("Ablehnen und schließen") the decision counts. */
const DISMISS_KINDS: ReadonlySet<LexiconKind> = new Set(['close', 'hide', 'later']);
const DECISION_KINDS: ReadonlySet<LexiconKind> = new Set(['reject', 'accept']);

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
 * longest phrase wins; ties between kinds stay unclassified unless `breakTie` decides.
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

  const confidence: Confidence = top.exact ? 'high' : tokens.length > MAX_CONFIDENT_TOKENS ? 'low' : 'medium';
  return { kind: top.m.kind, confidence, phrase: top.m.phrase };
}

const DOWNGRADE: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };

export function isLinkRole(role: string): boolean {
  return role === 'link';
}

/** Kind of one control: label (lexicon) first, the CMP's own markup role as corroboration or fallback. */
export function classifyButton(
  b: Pick<CmpButton, 'name' | 'role'> & { vendorRole?: ButtonKind | null },
  lexicon: CmpLexicon,
): { kind: ButtonKind; kindConfidence: Confidence } {
  const m = classifyLabel(b.name, lexicon);
  const vendor = b.vendorRole && b.vendorRole !== 'other' && b.vendorRole !== 'link' ? b.vendorRole : null;
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
