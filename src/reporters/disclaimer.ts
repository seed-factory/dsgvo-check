/** Re-export: the disclaimer composition is pure and lives in core, so scan() can apply it too. */
export {
  DISCLAIMER_KEYS,
  type DisclaimerEntry,
  type DisclaimerKey,
  type DisclaimerOptions,
  disclaimerEntries,
  disclaimerParagraphs,
  disclaimerText,
  exitReasonText,
  type PhaseCState,
  phaseCState,
} from '../core/data/disclaimer.ts';
