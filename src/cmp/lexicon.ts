/**
 * Pure button lexicon (D13): label normalization, phrase matching and button kind. No I/O — checks may import it.
 * Data: data/cmp/lexicon.yaml (`lexicon:` block), loaded by `lexicon-file.ts` or by a check via `data: ['cmp']`.
 */
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

/** Parse either the merged `data/cmp` object (`{ lexicon: … }`) or a bare lexicon object. */
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

const matcherCache = new WeakMap<CmpLexicon, PhraseMatcher[]>();

function matchers(lexicon: CmpLexicon): PhraseMatcher[] {
  let list = matcherCache.get(lexicon);
  if (!list) {
    list = [];
    for (const kind of LEXICON_KINDS) {
      for (const phrase of lexicon[kind]) {
        if (phrase.startsWith('*')) {
          const suffix = normalizeLabel(phrase.slice(1));
          if (suffix) list.push({ kind, phrase, tokens: [], suffix });
          continue;
        }
        const tokens = labelTokens(phrase);
        if (tokens.length > 0) list.push({ kind, phrase, tokens, suffix: null });
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

/**
 * Of equally scored matches of different kinds, the one decision (reject or accept) when every other kind only
 * dismisses the dialog; otherwise null (reject vs accept, or a decision vs settings/save stays unclassified).
 */
function breakTie(kinds: ReadonlySet<LexiconKind>): LexiconKind | null {
  const decisions = [...kinds].filter((k) => DECISION_KINDS.has(k));
  if (decisions.length !== 1) return null;
  return [...kinds].every((k) => DECISION_KINDS.has(k) || DISMISS_KINDS.has(k))
    ? (decisions[0] ?? null)
    : null;
}

/**
 * Exact phrase → high; phrase inside a longer label (or a `*suffix` token) → medium (low for long text blobs);
 * longest phrase wins; equal best scores of different kinds → unclassified, except a single decision (reject or
 * accept) tied only with close/hide/later ("Ablehnen und schließen"), which counts as that decision.
 */
export function classifyLabel(label: string, lexicon: CmpLexicon): LabelMatch {
  const tokens = labelTokens(label);
  if (tokens.length === 0) return { kind: null, confidence: 'low', phrase: null };
  let best: { score: number; exact: boolean; m: PhraseMatcher }[] = [];
  let bestScore = 0;
  for (const m of matchers(lexicon)) {
    let score = 0;
    let exact = false;
    if (m.suffix) {
      if (tokens.some((t) => t.endsWith(m.suffix as string))) score = 1;
    } else if (m.tokens.length === tokens.length && containsSequence(tokens, m.tokens)) {
      score = 1000 + m.tokens.length;
      exact = true;
    } else if (containsSequence(tokens, m.tokens)) {
      score = m.tokens.length;
    }
    if (score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      best = [{ score, exact, m }];
    } else if (score === bestScore) {
      best.push({ score, exact, m });
    }
  }
  let top = best[0];
  if (!top) return { kind: null, confidence: 'low', phrase: null };
  const kinds = new Set(best.map((b) => b.m.kind));
  if (kinds.size > 1) {
    const winner = breakTie(kinds);
    top = winner ? best.find((b) => b.m.kind === winner) : undefined;
    if (!top) return { kind: null, confidence: 'low', phrase: null };
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
