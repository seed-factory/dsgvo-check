/** Re-export: the disclaimer composition is pure and lives in core, so scan() can apply it too (FP-11). */
export {
  DISCLAIMER_KEYS,
  type DisclaimerKey,
  disclaimerParagraphs,
  disclaimerText,
  phaseCPerformed,
} from '../core/disclaimer.ts';
