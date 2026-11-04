// Small heuristics over an HTML prefix (≤ 64 KiB for TLS-01 signals; `findLegalLinks` reads the whole body up to
// `MAX_DECODED_BYTES`). No DOM: page content is never executed, bodies are never stored, only derived facts. The text
// is untrusted, so every function is linear in its size (`indexOf` scans, no restart at each candidate): repeated
// unclosed `<a `, `<form ` or `<!--` must not cause quadratic rescanning.
import type { HeaderRecord } from '../../core/snapshot/common.ts';
import { parseUrl } from '../../core/url/url.ts';
import { type HtmlRules, loadHtmlRules } from './rules.ts';

export const HEURISTIC_BYTES = 64 * 1024;

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

// Tag start: `<` or `</` and a name ending at whitespace, `/` or `>` (`<template-card>` is a custom element, not
// `<template>`).
const TAG_START = '<(/?)([a-z][^ \\t\\n\\f\\r/>]*)';

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

/** Closing-tag patterns by element name; `lastIndex` is set before each use. */
const RAW_TEXT_CLOSE = new Map<string, RegExp>();

// HTML input types that carry nothing the visitor types in.
const NON_DATA_INPUTS = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search']);

// Client-side redirects: the `url=` of a meta refresh and the script patterns that set `location`.
const META_REFRESH_URL = /url\s*=\s*['"]?([^'";]+)/i;
const JS_LOCATION_ASSIGN = /\blocation(?:\.href)?\s*=\s*(['"`])([^'"`]+)\1\s*(?:[;\n}]|$)/;
const JS_LOCATION_CALL = /\blocation\.(?:replace|assign)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/;
const JS_PROTOCOL_HTTPS = /\blocation\.protocol\s*=\s*['"`]https:?['"`]/;
const JS_HTTPS_CONCAT = [
  /\blocation(?:\.href)?\s*=\s*['"`]https:\/\/['"`]\s*\+/,
  /\blocation\.(?:replace|assign)\s*\(\s*['"`]https:\/\/['"`]\s*\+/,
];

// Char codes of `=` and `>`, compared in the tag scanner's inner loop.
const CHAR_EQUALS = 61;
const CHAR_GT = 62;

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

const isHtmlSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

// `tagEnd(i)`: index after the `>` of the tag whose name ends at `i`, or -1 when it is not closed. A quoted attribute
// value belongs to the tag (a `>` inside is text); a quote elsewhere (`<p don't>`) is no quote. Linear over all calls:
// a walk that ends without `>` makes every position it passed end without one too, so those are remembered; otherwise a
// text whose every `>` sits inside a quoted value would be walked to its end once per tag.
function tagEnder(html: string): (i: number) => number {
  const lastGt = html.lastIndexOf('>');
  let dead: Uint8Array | null = null;

  // Next position to look at: past a quoted attribute value after `=`, else the next character.
  const after = (i: number): number => {
    if (html.charCodeAt(i) !== CHAR_EQUALS) return i + 1;

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
      if (html.charCodeAt(i) === CHAR_GT) return i + 1;
      if (dead !== null && dead[i] === 1) break;
    }

    dead ??= new Uint8Array(html.length);
    for (let i = from; i >= 0 && i < html.length && dead[i] === 0; i = after(i)) dead[i] = 1;
    return -1;
  };
}

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

  const meta = metaRefreshTarget(clean, base);
  if (meta) return { kind: 'meta', url: meta.url };

  for (const script of elements(clean, 'script', false)) {
    const js = scriptRedirectTarget(script.body, base);
    if (js) return { kind: 'js', url: js.url };
  }
  return null;
}

/** The first `<meta http-equiv="refresh">` of the document. */
function metaRefreshTarget(clean: string, base: string): { url: string | null } | null {
  for (const tag of openTags(markupOf(clean), 'meta')) {
    const attrs = parseAttributes(tag);
    if (attrs.get('http-equiv')?.toLowerCase() !== 'refresh') continue;

    const target = META_REFRESH_URL.exec(attrs.get('content') ?? '');
    return { url: target ? resolve(target[1] as string, base) : null };
  }
  return null;
}

/** A script that assigns a literal address, or moves the page to `https` (a protocol assignment or `'https://' + …`). */
function scriptRedirectTarget(js: string, base: string): { url: string | null } | null {
  const literal = JS_LOCATION_ASSIGN.exec(js) ?? JS_LOCATION_CALL.exec(js);
  if (literal) return { url: resolve(literal[2] as string, base) };

  if (JS_PROTOCOL_HTTPS.test(js) || JS_HTTPS_CONCAT.some((re) => re.test(js))) {
    return { url: withHttps(base) };
  }
  return null;
}

// A form that takes user input other than a site search (TLS-01). Markup inside `<script>`, `<template>`, `<noscript>`
// or `<textarea>` is no form.
export function detectForm(html: string, rules: HtmlRules = loadHtmlRules()): boolean {
  const clean = documentMarkup(html);

  for (const f of elements(clean, 'form', true)) {
    const formAttrs = parseAttributes(`<form ${f.attrs}>`);
    if (isSearchForm(formAttrs, rules)) continue;
    if (takesUserInput(f.body, rules)) return true;
  }
  return false;
}

function isSearchForm(formAttrs: Map<string, string>, rules: HtmlRules): boolean {
  if (formAttrs.get('role')?.toLowerCase() === 'search') return true;
  return rules.searchForm.test(`${formAttrs.get('id') ?? ''} ${formAttrs.get('class') ?? ''}`);
}

function takesUserInput(formBody: string, rules: HtmlRules): boolean {
  if (/<(textarea|select)\b/i.test(formBody)) return true;

  for (const input of startTags(formBody, 'input')) {
    const attrs = parseAttributes(input);
    const type = (attrs.get('type') ?? 'text').toLowerCase();
    if (NON_DATA_INPUTS.has(type)) continue;
    if (rules.searchFieldNames.has((attrs.get('name') ?? '').toLowerCase())) continue;
    return true;
  }
  return false;
}

type LegalRole = 'impressum' | 'privacy';

/**
 * The Impressum and privacy links of the start page. The link text decides before the path: a site builder may serve
 * the privacy policy at `/impressum-2`, and a link whose text names one document is never taken for the other
 * by its path. A page that both links resolve to is kept as the Impressum only.
 */
export function findLegalLinks(
  html: string,
  base: string,
  rules: HtmlRules = loadHtmlRules(),
): { impressum?: string; privacy?: string } {
  const byText: Partial<Record<LegalRole, string>> = {};
  const byPath: Partial<Record<LegalRole, string>> = {};

  for (const a of elements(withoutComments(html), 'a', false)) {
    const attrs = parseAttributes(`<a ${a.attrs}>`);
    const href = attrs.get('href')?.trim() ?? '';
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;

    const url = resolve(href, base);
    if (!url) continue;

    const text = decodeEntities(stripTags(a.body)).replace(/\s+/g, ' ').trim();
    const path = new URL(url).pathname;
    const settings = rules.settingsText.test(text);
    const named = {
      impressum: rules.impressumText.test(text),
      privacy: !settings && rules.privacyText.test(text),
    };
    if (named.impressum) byText.impressum ??= url;
    if (named.privacy) byText.privacy ??= url;
    if (!named.privacy && rules.impressumPath.test(path)) byPath.impressum ??= url;
    if (!named.impressum && !settings && rules.privacyPath.test(path)) byPath.privacy ??= url;
    if (byText.impressum && byText.privacy) break;
  }

  const out: { impressum?: string; privacy?: string } = {};
  const impressum = byText.impressum ?? byPath.impressum;
  const privacy = byText.privacy ?? byPath.privacy;
  if (impressum) out.impressum = impressum;
  if (privacy && privacy !== impressum) out.privacy = privacy;
  return out;
}
