/**
 * Section schemas of `test/data/legal` besides the legal-link lexicon (`lexicon.ts` reads `legal:` itself). Pure, so
 * LEGAL-01 validates `ctx.data.legal` with the same schema the data test uses.
 */
import { z } from 'zod';
import { dataSection } from '../../../core/data/parse.ts';

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

export const legalSections = [providerDetailsSection] as const;
