/** Loads the legal-link lexicon from data/legal (collector side; LEGAL-01 gets it through `ctx.data.legal`). */
import { DEFAULT_DATA_DIR, loadDataDir } from '../../core/data.ts';
import { type LegalLexicon, legalLexiconFromData } from './legal-lexicon.ts';

const cache = new Map<string, LegalLexicon>();

export function loadLegalLexicon(dataDir: string = DEFAULT_DATA_DIR): LegalLexicon {
  let lexicon = cache.get(dataDir);
  if (!lexicon) {
    lexicon = legalLexiconFromData(loadDataDir('legal', dataDir));
    cache.set(dataDir, lexicon);
  }
  return lexicon;
}
