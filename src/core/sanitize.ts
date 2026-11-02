/**
 * Cleaning of external strings (from scanned sites) before console / Markdown output:
 * ANSI escapes, C0/C1 control characters, bidi overrides and CI workflow commands are neutralized.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

export function sanitizeExternal(input: string, maxLength = 300): string {
  let s = input
    .replace(ANSI_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(ZERO_WIDTH_RE, '');
  // GitHub/GitLab workflow commands start with "::" or "##[" at line start.
  s = s.replace(/^(::|##\[)/, ' $1');
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  return s;
}
