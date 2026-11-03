/** Loads the default lexicon from test/data/cmp (collector side; checks get it via `ctx.data.cmp`). */
import { DEFAULT_DATA_DIR, loadDataDir } from '../core/data.ts';
import { lexiconFromData } from './lexicon.ts';
import type { CmpLexicon } from './types.ts';

const cache = new Map<string, CmpLexicon>();

export function loadLexicon(dataDir: string = DEFAULT_DATA_DIR): CmpLexicon {
  let lexicon = cache.get(dataDir);
  if (!lexicon) {
    lexicon = lexiconFromData(loadDataDir('cmp', dataDir));
    cache.set(dataDir, lexicon);
  }
  return lexicon;
}
