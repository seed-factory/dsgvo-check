/** WAF / bot-challenge detection on a navigated page (start page → SCAN-BLOCKED, subpage → not evaluable). */

import type { ChallengeFacts } from '../../../core/snapshot/browser.ts';
import type { HeaderRecord } from '../../../core/snapshot/common.ts';

export interface ChallengeInput {
  status: number | null;
  headers: readonly HeaderRecord[];
  title: string;
  text: string;
  scripts: readonly string[];
}

const TITLE_PATTERNS: Array<[RegExp, ChallengeFacts['kind'], string]> = [
  [/^just a moment/i, 'cloudflare', 'title:just a moment'],
  [/attention required!? \| cloudflare/i, 'cloudflare', 'title:attention required'],
  [/^(access denied|zugriff verweigert)$/i, 'akamai', 'title:access denied'],
  [/sucuri website firewall/i, 'waf-block', 'title:sucuri'],
  [/^(ddos-guard|ddos protection)/i, 'waf-block', 'title:ddos-guard'],
  [/^(are you a robot|captcha|human verification|bot verification)/i, 'captcha', 'title:captcha'],
];

const SCRIPT_PATTERNS: Array<[RegExp, ChallengeFacts['kind'], string]> = [
  [/\/cdn-cgi\/challenge-platform\//, 'cloudflare', 'script:challenge-platform'],
  [/captcha-delivery\.com/, 'captcha', 'script:datadome'],
  [/_Incapsula_Resource/, 'waf-block', 'script:incapsula'],
];

const TEXT_PATTERNS: Array<[RegExp, ChallengeFacts['kind'], string]> = [
  [/incapsula incident id/i, 'waf-block', 'text:incapsula'],
  [/reference #\d+\.[0-9a-f]+/i, 'akamai', 'text:akamai-reference'],
  [/checking (if the site connection is secure|your browser)/i, 'cloudflare', 'text:checking-browser'],
];

/** Short page = typical interstitial; long pages only count with a header/status/script signal. */
const SHORT_TEXT = 600;

export function detectChallenge(i: ChallengeInput): ChallengeFacts {
  const signals: string[] = [];
  let kind: ChallengeFacts['kind'];
  const header = (n: string) => i.headers.find((h) => h.name === n)?.value;
  const short = i.text.trim().length < SHORT_TEXT;

  if (header('cf-mitigated')) {
    signals.push('header:cf-mitigated');
    kind = 'cloudflare';
  }
  if (header('x-datadome') !== undefined && i.status === 403) {
    signals.push('header:x-datadome');
    kind ??= 'captcha';
  }
  for (const [re, k, s] of SCRIPT_PATTERNS) {
    if (i.scripts.some((src) => re.test(src))) {
      signals.push(s);
      kind ??= k;
    }
  }
  if (short) {
    for (const [re, k, s] of TITLE_PATTERNS) {
      if (re.test(i.title.trim())) {
        signals.push(s);
        kind ??= k;
      }
    }
    for (const [re, k, s] of TEXT_PATTERNS) {
      if (re.test(i.text)) {
        signals.push(s);
        kind ??= k;
      }
    }
  }
  if (i.status === 403) {
    signals.push('status:403');
    kind ??= 'http-403';
  }
  // A challenge-platform script alone on a long, normal page (e.g. Turnstile in a form) is not a block.
  const detected =
    signals.some((s) => s.startsWith('status:') || s.startsWith('header:') || s.startsWith('title:')) ||
    (short && signals.length > 0);
  return detected ? { detected, kind: kind ?? 'other', signals } : { detected: false, signals: [] };
}
