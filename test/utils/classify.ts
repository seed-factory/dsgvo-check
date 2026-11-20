/** The first-layer table takes its threshold from the caller; tests that do not vary it use the default of the settings. */
import { type ClassifyOptions, classifyFirstLayer as classifyWith } from '../../src/cmp/classify.ts';
import type { CmpFacts, CmpLexicon, FirstLayerClassification } from '../../src/cmp/types.ts';
import { DEFAULT_CONFIG } from '../../src/core/config/schema.ts';

export const DEFAULT_CLASSIFY: ClassifyOptions = {
  blockingCoveredRatio: DEFAULT_CONFIG.cmp.blockingCoveredRatio,
};

export function classifyFirstLayer(
  facts: CmpFacts,
  lexicon: CmpLexicon,
  options: ClassifyOptions = DEFAULT_CLASSIFY,
): FirstLayerClassification {
  return classifyWith(facts, lexicon, options);
}
