/**
 * The click selectors the probe builds (`selectorFor` in probe.ts) as the Node side accepts them: `#id`,
 * `tag[attribute="value"]`, `tag.class.class` and structural paths `#id > tag:nth-child(n) > *:nth-child(n)`, with steps
 * through shadow roots joined by ` >> `. The probe runs in the page, which can change what it returns, so a selector is
 * kept only in exactly these forms, with every id, class and attribute value a name (`isNameLike`), every tag a tag name
 * and every attribute one the probe may use.
 */
import { isNameLike, isTagName } from '../../core/redaction/page-names.ts';

/** A longer selector is no probe selector: ten shadow steps of forty path segments stay below it. */
const MAX_SELECTOR_LENGTH = 8192;

/** Identifier characters CSS takes without an escape (and every non-ASCII one). */
const PLAIN_IDENT_CHAR = /^[A-Za-z0-9_-]$/;
const HEX_ESCAPE = /^[0-9a-fA-F]{1,6}/;
const TAG = /^[a-z][a-z0-9_-]*/;
const ATTRIBUTE = /^[a-z][a-z0-9-]*/;
const NTH_CHILD = /^:nth-child\(\d{1,5}\)/;

/** A CSS identifier from `at` with its escapes resolved (`\31 23` → `123`); null when an escape is broken. */
function readIdent(s: string, at: number): { value: string; end: number } | null {
  let value = '';
  let i = at;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '\\') {
      const hex = HEX_ESCAPE.exec(s.slice(i + 1, i + 7))?.[0];
      if (hex) {
        const cp = Number.parseInt(hex, 16);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
        value += String.fromCodePoint(cp);
        i += 1 + hex.length;
        if (s.charAt(i) === ' ') i++;
        continue;
      }
      const cp = s.codePointAt(i + 1);
      if (cp === undefined || cp === 0x0a || cp === 0x0c || cp === 0x0d) return null;
      value += String.fromCodePoint(cp);
      i += cp > 0xffff ? 3 : 2;
      continue;
    }
    if (!PLAIN_IDENT_CHAR.test(c) && c.charCodeAt(0) < 0x80) break;
    value += c;
    i++;
  }
  return i > at ? { value, end: i } : null;
}

/** `[attribute="value"]` from `at`: the end, or null. The probe writes the value unescaped, so it has no `"` or `\`. */
function readAttribute(s: string, at: number, attributes: ReadonlySet<string>): number | null {
  if (s.charAt(at) !== '[') return null;
  const name = ATTRIBUTE.exec(s.slice(at + 1))?.[0];
  if (!name || !attributes.has(name)) return null;
  let i = at + 1 + name.length;
  if (!s.startsWith('="', i)) return null;
  i += 2;
  const close = s.indexOf('"]', i);
  if (close < 0) return null;
  const value = s.slice(i, close);
  // A presence attribute has an empty value, which carries nothing.
  if (value !== '' && !isNameLike(value)) return null;
  return close + 2;
}

/** One compound selector of the forms above from `at`: its end, or null. */
function readCompound(s: string, at: number, attributes: ReadonlySet<string>): number | null {
  if (s.charAt(at) === '#') {
    const id = readIdent(s, at + 1);
    return id && isNameLike(id.value) ? id.end : null;
  }

  let i = at;
  let tag: string | null = null;
  if (s.charAt(at) === '*') {
    i++;
  } else {
    tag = TAG.exec(s.slice(at))?.[0] ?? null;
    if (!tag || !isTagName(tag)) return null;
    i += tag.length;
  }

  const nth = NTH_CHILD.exec(s.slice(i))?.[0];
  if (nth) return i + nth.length;
  if (tag === null) return null;

  if (s.charAt(i) === '[') return readAttribute(s, i, attributes);
  if (s.charAt(i) !== '.') return null;
  while (s.charAt(i) === '.') {
    const cls = readIdent(s, i + 1);
    if (!cls || !isNameLike(cls.value)) return null;
    i = cls.end;
  }
  return i;
}

/** Whether `selector` is one the probe builds, from names only, with attributes out of `attributes`. */
export function isProbeSelector(selector: string, attributes: readonly string[]): boolean {
  if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return false;
  const allowed = new Set(attributes);
  let i = 0;
  for (;;) {
    const end = readCompound(selector, i, allowed);
    if (end === null) return false;
    if (end === selector.length) return true;
    if (selector.startsWith(' >> ', end)) i = end + 4;
    else if (selector.startsWith(' > ', end)) i = end + 3;
    else return false;
  }
}
