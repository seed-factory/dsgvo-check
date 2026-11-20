/**
 * Bot and WAF challenges answered to the HTTP probe. The header signatures are those of
 * test/data/browser/challenges.yaml, which the browser collector reads too; the probe has no DOM, so titles, texts and
 * scripts are left to the browser. The scanner never solves or bypasses a challenge.
 */
import type { HeaderRecord } from '../../core/snapshot/common.ts';
import { type ChallengeRules, loadChallengeRules } from '../browser/rules.ts';

export interface HttpChallenge {
  kind: string;
  signals: string[];
}

export interface ChallengeResponse {
  status: number;
  /** Stored records: their names tell which headers were sent. */
  headers: readonly HeaderRecord[];
  blankHeaderNames: readonly string[];
}

/** The challenge a response shows by its headers, or null; the first signal names the kind. */
export function httpChallenge(
  r: ChallengeResponse,
  rules: ChallengeRules = loadChallengeRules(),
): HttpChallenge | null {
  const signals: string[] = [];
  let kind: string | undefined;
  for (const rule of rules.headers) {
    const sent = r.headers.some((h) => h.name === rule.name);
    const present = sent && (rule.allowEmptyValue || !r.blankHeaderNames.includes(rule.name));
    if (!present || (rule.status !== undefined && rule.status !== r.status)) continue;
    signals.push(rule.signal);
    kind ??= rule.kind;
  }
  return kind ? { kind, signals } : null;
}
