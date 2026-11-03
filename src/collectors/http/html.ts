// Small heuristics over an HTML prefix (≤ 64 KiB for TLS-01 signals; `findLegalLinks` reads the whole body up to
// `MAX_DECODED_BYTES`). No DOM: page content is never executed, bodies are never stored, only derived facts. The text
// is untrusted, so every function is linear in its size (`indexOf` scans, no restart at each candidate): repeated
// unclosed `<a `, `<form ` or `<!--` must not cause quadratic rescanning.
import type { HeaderRecord } from '../../core/snapshot/common.ts';
import { parseUrl } from '../../core/url/url.ts';
import { type HtmlRules, loadHtmlRules } from './rules.ts';

export const HEURISTIC_BYTES = 64 * 1024;

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = tag.replace(/^<\s*[a-z0-9-]+/i, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || out.has(name)) continue;
    out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;|&#0*47;/gi, '/');
}

// A `<!--` without `-->` stays as text together with everything after it: a later one has no `-->` either, which ends
// the search (a restart at each is O(n²)).
function withoutComments(html: string): string {
  let open = html.indexOf('<!--');
  if (open < 0) return html;
  const parts: string[] = [];
  let pos = 0;
  while (open >= 0) {
    const close = html.indexOf('-->', open + 4);
    if (close < 0) break;
    parts.push(html.slice(pos, open));
    pos = close + 3;
    open = html.indexOf('<!--', pos);
  }
  parts.push(html.slice(pos));
  return parts.join('');
}

// Raw-text and escapable raw-text elements (plus `<noscript>`): their content is text, not markup. The first closing
// tag ends them; they do not nest; an unclosed one runs to the end.
const RAW_TEXT_NAMES: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);

// Tag start: `<` or `</` and a name ending at whitespace, `/` or `>` (`<template-card>` is a custom element, not
// `<template>`).
const TAG_START = '<(/?)([a-z][^ \\t\\n\\f\\r/>]*)';

const isHtmlSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

// `tagEnd(i)`: index after the `>` of the tag whose name ends at `i`, or -1 when it is not closed. A quoted attribute
// value belongs to the tag (a `>` inside is text); a quote elsewhere (`<p don't>`) is no quote. Linear over all calls:
// a walk that ends without `>` makes every position it passed end without one too, so those are remembered; otherwise a
// text whose every `>` sits inside a quoted value would be walked to its end once per tag.
function tagEnder(html: string): (i: number) => number {
  const lastGt = html.lastIndexOf('>');
  let dead: Uint8Array | null = null;
  const after = (i: number): number => {
    if (html.charCodeAt(i) !== 61) return i + 1;
    let j = i + 1;
    while (j < html.length && isHtmlSpace(html.charCodeAt(j))) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      return close === -1 ? -1 : close + 1;
    }
    return j;
  };
  return (from) => {
    if (from > lastGt) return -1;
    for (let i = from; i >= 0 && i < html.length; i = after(i)) {
      if (html.charCodeAt(i) === 62) return i + 1;
      if (dead !== null && dead[i] === 1) break;
    }
    dead ??= new Uint8Array(html.length);
    for (let i = from; i >= 0 && i < html.length && dead[i] === 0; i = after(i)) dead[i] = 1;
    return -1;
  };
}

const RAW_TEXT_CLOSE = new Map<string, RegExp>();

function rawTextEnd(html: string, name: string, from: number): number {
  let close = RAW_TEXT_CLOSE.get(name);
  if (!close) {
    close = new RegExp(`</${name}\\s*>`, 'gi');
    RAW_TEXT_CLOSE.set(name, close);
  }
  close.lastIndex = from;
  const m = close.exec(html);
  return m ? m.index + m[0].length : html.length;
}

// Index after the `</template>` that closes the template whose opening tag ends at `from`. Templates nest; raw-text
// content and quoted attribute values inside are text (a `"</template>"` string closes nothing). An unclosed template
// runs to the end.
function templateEnd(html: string, from: number, tagEnd: (i: number) => number): number {
  const tag = new RegExp(TAG_START, 'gi');
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const end = tagEnd(m.index + m[0].length);
    if (end < 0) continue;
    tag.lastIndex = end;
    const name = (m[2] as string).toLowerCase();
    if (name === 'template') {
      depth += m[1] === '/' ? -1 : 1;
      if (depth === 0) return end;
    } else if (m[1] !== '/' && RAW_TEXT_NAMES.has(name)) {
      tag.lastIndex = rawTextEnd(html, name, end);
    }
  }
  return html.length;
}

// HTML without comments and without the content of raw-text / inert elements. A `<textarea>` is a form control, so its
// empty tag stays. Markup after the closing tag of an outer `<template>` is the document's again; quoted attribute
// values are read, so a `<template>` in a value is no element.
function documentMarkup(html: string): string {
  return markupOf(withoutComments(html));
}

function markupOf(source: string): string {
  const tagEnd = tagEnder(source);
  const tag = new RegExp(TAG_START, 'gi');
  let out = '';
  let pos = 0;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    const end = tagEnd(m.index + m[0].length);
    if (end < 0) continue;
    tag.lastIndex = end;
    const name = (m[2] as string).toLowerCase();
    if (m[1] === '/' || !(name === 'template' || RAW_TEXT_NAMES.has(name))) continue;
    const stop = name === 'template' ? templateEnd(source, end, tagEnd) : rawTextEnd(source, name, end);
    out += source.slice(pos, m.index) + (name === 'textarea' ? '<textarea></textarea>' : ' ');
    pos = stop;
    tag.lastIndex = stop;
  }
  return out + source.slice(pos);
}

// Elements `<name …>body</name>` of a text in document order, as `/<name\b([^>]*)>([\s\S]*?)<\/name>/gi` finds them
// (with `closeOrEnd` an unclosed element runs to the end). One forward scan: a candidate without a `>` (or, unless
// `closeOrEnd`, without a closing tag) ends the search because every later one fails too; the regexp restarted at each
// one (O(n²)).
function* elements(
  text: string,
  name: string,
  closeOrEnd: boolean,
): Generator<{ attrs: string; body: string }> {
  const open = new RegExp(`<${name}\\b`, 'gi');
  const close = new RegExp(`</${name}>`, 'gi');
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const attrsAt = m.index + m[0].length;
    const gt = text.indexOf('>', attrsAt);
    if (gt < 0) return;
    close.lastIndex = gt + 1;
    const c = close.exec(text);
    if (!c) {
      if (closeOrEnd) yield { attrs: text.slice(attrsAt, gt), body: text.slice(gt + 1) };
      return;
    }
    yield { attrs: text.slice(attrsAt, gt), body: text.slice(gt + 1, c.index) };
    open.lastIndex = c.index + c[0].length;
  }
}

/** Start tags by the same scan as `elements`. */
function* startTags(text: string, name: string): Generator<string> {
  const open = new RegExp(`<${name}\\b`, 'gi');
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const gt = text.indexOf('>', m.index + m[0].length);
    if (gt < 0) return;
    yield text.slice(m.index, gt + 1);
    open.lastIndex = gt + 1;
  }
}

/** `text.replace(/<[^>]*>/g, ' ')`: a `<` without a `>` behind it ends the search (no later `<` has one). */
function stripTags(text: string): string {
  let lt = text.indexOf('<');
  if (lt < 0) return text;
  const parts: string[] = [];
  let pos = 0;
  while (lt >= 0) {
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) break;
    parts.push(text.slice(pos, lt), ' ');
    pos = gt + 1;
    lt = text.indexOf('<', pos);
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

function openTags(markup: string, name: string): string[] {
  const tagEnd = tagEnder(markup);
  const tag = new RegExp(TAG_START, 'gi');
  const out: string[] = [];
  for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
    const end = tagEnd(m.index + m[0].length);
    if (end < 0) continue;
    tag.lastIndex = end;
    if (m[1] !== '/' && (m[2] as string).toLowerCase() === name) out.push(markup.slice(m.index, end));
  }
  return out;
}

function resolve(raw: string, base: string): string | null {
  return parseUrl(raw.trim(), base, true)?.href ?? null;
}

function withHttps(base: string): string | null {
  const u = parseUrl(base);
  if (!u) return null;
  u.protocol = 'https:';
  return u.href;
}

// A meta inside `<template>`, `<noscript>` or `<script>` is inert and does not count. Values are as written; the
// collector stores them reduced.
export function extractMeta(html: string): { httpEquiv: HeaderRecord[]; referrer: string | null } {
  const httpEquiv: HeaderRecord[] = [];
  let referrer: string | null = null;
  for (const tag of openTags(documentMarkup(html), 'meta')) {
    const attrs = parseAttributes(tag);
    const equiv = attrs.get('http-equiv');
    const content = attrs.get('content') ?? '';
    if (equiv) httpEquiv.push({ name: equiv.toLowerCase(), value: content });
    if (attrs.get('name')?.toLowerCase() === 'referrer') referrer = content;
  }
  return { httpEquiv, referrer };
}

/** `url` is absolute, or null when it cannot be resolved. */
export function detectClientRedirect(
  html: string,
  base: string,
): { kind: 'meta' | 'js'; url: string | null } | null {
  const clean = withoutComments(html);
  for (const tag of openTags(markupOf(clean), 'meta')) {
    const attrs = parseAttributes(tag);
    if (attrs.get('http-equiv')?.toLowerCase() !== 'refresh') continue;
    const target = /url\s*=\s*['"]?([^'";]+)/i.exec(attrs.get('content') ?? '');
    return { kind: 'meta', url: target ? resolve(target[1] as string, base) : null };
  }
  for (const script of elements(clean, 'script', false)) {
    const js = script.body;
    const literal =
      /\blocation(?:\.href)?\s*=\s*(['"`])([^'"`]+)\1\s*(?:[;\n}]|$)/.exec(js) ??
      /\blocation\.(?:replace|assign)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(js);
    if (literal) return { kind: 'js', url: resolve(literal[2] as string, base) };
    if (/\blocation\.protocol\s*=\s*['"`]https:?['"`]/.test(js)) return { kind: 'js', url: withHttps(base) };
    if (
      /\blocation(?:\.href)?\s*=\s*['"`]https:\/\/['"`]\s*\+/.test(js) ||
      /\blocation\.(?:replace|assign)\s*\(\s*['"`]https:\/\/['"`]\s*\+/.test(js)
    ) {
      return { kind: 'js', url: withHttps(base) };
    }
  }
  return null;
}

// HTML input types that carry nothing the visitor types in.
const NON_DATA_INPUTS = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search']);

// A form that takes user input other than a site search (TLS-01). Markup inside `<script>`, `<template>`, `<noscript>`
// or `<textarea>` is no form.
export function detectForm(html: string, rules: HtmlRules = loadHtmlRules()): boolean {
  const clean = documentMarkup(html);
  for (const f of elements(clean, 'form', true)) {
    const formAttrs = parseAttributes(`<form ${f.attrs}>`);
    if (formAttrs.get('role')?.toLowerCase() === 'search') continue;
    if (rules.searchForm.test(`${formAttrs.get('id') ?? ''} ${formAttrs.get('class') ?? ''}`)) continue;
    const body = f.body;
    if (/<(textarea|select)\b/i.test(body)) return true;
    for (const input of startTags(body, 'input')) {
      const attrs = parseAttributes(input);
      const type = (attrs.get('type') ?? 'text').toLowerCase();
      if (NON_DATA_INPUTS.has(type)) continue;
      if (rules.searchFieldNames.has((attrs.get('name') ?? '').toLowerCase())) continue;
      return true;
    }
  }
  return false;
}

export function findLegalLinks(
  html: string,
  base: string,
  rules: HtmlRules = loadHtmlRules(),
): { impressum?: string; privacy?: string } {
  const out: { impressum?: string; privacy?: string } = {};
  for (const a of elements(withoutComments(html), 'a', false)) {
    const attrs = parseAttributes(`<a ${a.attrs}>`);
    const href = attrs.get('href')?.trim() ?? '';
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    const url = resolve(href, base);
    if (!url) continue;
    const text = decodeEntities(stripTags(a.body)).replace(/\s+/g, ' ').trim();
    const path = new URL(url).pathname;
    if (!out.impressum && (rules.impressumText.test(text) || rules.impressumPath.test(path)))
      out.impressum = url;
    else if (
      !out.privacy &&
      !rules.settingsText.test(text) &&
      (rules.privacyText.test(text) || rules.privacyPath.test(path))
    ) {
      out.privacy = url;
    }
    if (out.impressum && out.privacy) break;
  }
  return out;
}
