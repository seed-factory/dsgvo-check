/** Neutralizes ANSI escapes, control and bidi characters and CI workflow commands in strings from scanned sites. */
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
  // workflow commands (`::`, `##[`) take effect at the start of a line
  s = s.replace(/^(::|##\[)/, ' $1');
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  return s;
}
