/**
 * WAF / bot-challenge detection on a navigated page (start page → SCAN-BLOCKED, subpage → not evaluable). The
 * signatures are test/data/browser/challenges.yaml.
 */

import type { ChallengeFacts } from '../../../core/snapshot/browser.ts';
import type { HeaderRecord } from '../../../core/snapshot/common.ts';
import { type ChallengeRules, loadChallengeRules } from '../rules.ts';

export interface ChallengeInput {
  status: number | null;
  headers: readonly HeaderRecord[];
  title: string;
  text: string;
  scripts: readonly string[];
}

/** Short page = typical interstitial; long pages only count with a header/status/script signal. */
const SHORT_TEXT = 600;

export function detectChallenge(
  i: ChallengeInput,
  rules: ChallengeRules = loadChallengeRules(),
): ChallengeFacts {
  const signals: string[] = [];
  let kind: ChallengeFacts['kind'];
  /** The first signal names the kind. */
  const note = (signal: string, k: ChallengeFacts['kind']) => {
    signals.push(signal);
    kind ??= k;
  };
  const header = (n: string) => i.headers.find((h) => h.name === n)?.value;
  const short = i.text.trim().length < SHORT_TEXT;

  for (const h of rules.headers) {
    const value = header(h.name);
    const present = h.allowEmptyValue ? value !== undefined : Boolean(value);
    if (present && (h.status === undefined || i.status === h.status)) note(h.signal, h.kind);
  }
  for (const { re, kind: k, signal } of rules.scripts) {
    if (i.scripts.some((src) => re.test(src))) note(signal, k);
  }
  if (short) {
    for (const { re, kind: k, signal } of rules.titles) {
      if (re.test(i.title.trim())) note(signal, k);
    }
    for (const { re, kind: k, signal } of rules.texts) {
      if (re.test(i.text)) note(signal, k);
    }
  }
  if (i.status === 403) note('status:403', 'http-403');

  // A challenge-platform script alone on a long, normal page (e.g. Turnstile in a form) is not a block.
  const detected =
    signals.some((s) => s.startsWith('status:') || s.startsWith('header:') || s.startsWith('title:')) ||
    (short && signals.length > 0);
  return detected ? { detected, kind: kind ?? 'other', signals } : { detected: false, signals: [] };
}
