/**
 * Section schemas of `test/data/legal` besides the legal-link lexicon (`lexicon.ts` reads `legal:` itself). Pure, so
 * LEGAL-01 and LEGAL-02 validate `ctx.data.legal` with the same schema the data test uses.
 */
import { z } from 'zod';
import { dataSection } from '../../../core/data/parse.ts';
import { normalizeLegalText } from './lexicon.ts';

/** Phrases of one kind of provider details, per language. */
const PhrasesByLanguage = z
  .record(z.string().min(2), z.array(z.string().trim().min(1)).min(1))
  .refine((langs) => Object.keys(langs).length > 0, 'at least one language');

// The five kinds are fixed: DSGVO_CHECK_LEGAL_IMPRESSUM_MIN_GROUPS ranges up to five, so each must stay reachable.
export const providerDetailsSection = dataSection(
  'legal',
  'providerDetails',
  z.strictObject({
    groups: z.strictObject({
      register: PhrasesByLanguage,
      vatId: PhrasesByLanguage,
      representative: PhrasesByLanguage,
      statement: PhrasesByLanguage,
      responsible: PhrasesByLanguage,
    }),
  }),
);

export type ProviderDetails = ReturnType<typeof providerDetailsSection.parse>;

/** A term as normalised words; `prefix`: its last word may continue ("telemediengesetz*" → "telemediengesetzes"). */
export interface TermPhrase {
  words: readonly string[];
  prefix: boolean;
}

/** The words of a dictionary term, normalised like the text it is compared with. */
export function compileTerm(term: string): TermPhrase {
  const prefix = term.endsWith('*');
  const norm = normalizeLegalText(prefix ? term.slice(0, -1) : term);
  return { words: norm === '' ? [] : norm.split(' '), prefix };
}

/** The phrase starts at word `i`: its words in a row, the last one continued when the term allows it. */
export function phraseAt(words: readonly string[], phrase: TermPhrase, i: number): boolean {
  const n = phrase.words.length;
  if (n === 0 || i + n > words.length) return false;
  for (let j = 0; j < n; j++) {
    const w = words[i + j] as string;
    const p = phrase.words[j] as string;
    if (!(phrase.prefix && j === n - 1 ? w.startsWith(p) : w === p)) return false;
  }
  return true;
}

export function containsPhrase(words: readonly string[], phrase: TermPhrase): boolean {
  for (let i = 0; i < words.length; i++) if (phraseAt(words, phrase, i)) return true;
  return false;
}

/** Written like the text of a page; a `*` may only end it. */
const Term = z
  .string()
  .trim()
  .min(1)
  .refine((t) => !t.slice(0, -1).includes('*'), '`*` only at the end of a term')
  .refine((t) => compileTerm(t).words.length > 0, 'a term needs a letter or a digit');

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date written YYYY-MM-DD');

const OutdatedReference = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id'),
    label: z.string().trim().min(1),
    terms: z.array(Term).min(1),
    successors: z.array(Term),
    reason: z.enum(['replaced', 'renamed', 'invalidated', 'repealed']),
    replacedBy: z.string().trim().min(1),
    since: IsoDate,
    ruling: z.string().trim().min(1).nullable(),
  })
  .refine((r) => r.reason !== 'invalidated' || r.ruling !== null, {
    message: 'an invalidated reference names its ruling',
    path: ['ruling'],
  });

const PerLanguage = <T extends z.ZodType>(s: T) => z.strictObject({ de: s, en: s });

/** Words that, inside a term, would make every mention of it look historical or current. */
function hidingWords(
  terms: readonly string[],
  words: readonly string[],
): Array<{ word: string; term: string }> {
  const out: Array<{ word: string; term: string }> = [];
  for (const term of terms) {
    const termWords = compileTerm(term).words;
    for (const word of words) if (containsPhrase(termWords, compileTerm(word))) out.push({ word, term });
  }
  return out;
}

export const outdatedReferencesSection = dataSection(
  'legal',
  'outdatedReferences',
  z
    .strictObject({
      version: z.string().min(1),
      references: z.array(OutdatedReference).min(1),
      historicalCues: PerLanguage(z.array(Term)),
      abbreviations: PerLanguage(z.array(z.string().regex(/^[a-z]+$/, 'lower-case letters without the dot'))),
    })
    .superRefine((data, ctx) => {
      const cues = [...data.historicalCues.de, ...data.historicalCues.en];
      const seen = new Set<string>();
      data.references.forEach((r, i) => {
        if (seen.has(r.id))
          ctx.addIssue({ code: 'custom', message: `duplicate id ${r.id}`, path: ['references', i, 'id'] });
        seen.add(r.id);
        const spellings = new Set<string>();
        r.terms.forEach((t, j) => {
          const key = JSON.stringify(compileTerm(t));
          if (spellings.has(key))
            ctx.addIssue({
              code: 'custom',
              message: `${t}: normalises like another term`,
              path: ['references', i, 'terms', j],
            });
          spellings.add(key);
        });
        for (const { word, term } of hidingWords(r.terms, r.successors)) {
          ctx.addIssue({
            code: 'custom',
            message: `successor "${word}" occurs inside the term "${term}"`,
            path: ['references', i, 'successors'],
          });
        }
        for (const { word, term } of hidingWords(r.terms, cues)) {
          ctx.addIssue({
            code: 'custom',
            message: `historical cue "${word}" occurs inside the term "${term}"`,
            path: ['references', i, 'terms'],
          });
        }
      });
    }),
);

export type OutdatedReferences = ReturnType<typeof outdatedReferencesSection.parse>;

export const legalSections = [providerDetailsSection, outdatedReferencesSection] as const;
