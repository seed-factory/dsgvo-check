/**
 * Structural safety assertions for the HTML report (unit and e2e): every real tag is ours, no script/handlers/inline
 * style attributes, no external resources, CSP with the hash of the only style block, no `T[0-9]_` strings.
 */
import { createHash } from 'node:crypto';

const ALLOWED_TAGS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'header',
  'nav',
  'main',
  'section',
  'article',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'div',
  'span',
  'strong',
  'em',
  'small',
  'code',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'details',
  'summary',
  'figure',
  'figcaption',
  'img',
  'a',
  'br',
]);

export interface HtmlTag {
  name: string;
  closing: boolean;
  attrs: Array<{ name: string; value: string }>;
  raw: string;
}

/** Remove the style block content so CSS cannot be mistaken for markup. */
function withoutStyleContent(html: string): string {
  return html.replace(/(<style>)[\s\S]*?(<\/style>)/g, '$1$2');
}

export function tagsOf(html: string): HtmlTag[] {
  const out: HtmlTag[] = [];
  for (const m of withoutStyleContent(html).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const attrs: HtmlTag['attrs'] = [];
    for (const a of (m[3] ?? '').matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs.push({ name: (a[1] ?? '').toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? '' });
    }
    out.push({ name: (m[2] ?? '').toLowerCase(), closing: m[1] === '/', attrs, raw: m[0] });
  }
  return out;
}

export function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
}

export function cspOf(html: string): string | null {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  return m ? (m[1] ?? null) : null;
}

/** Returns a list of problems (empty = safe). */
export function htmlSafetyProblems(html: string): string[] {
  const problems: string[] = [];
  if (!html.startsWith('<!doctype html>')) problems.push('missing doctype');
  if (/T[0-9]_/.test(html)) problems.push('contains T[0-9]_ string');
  if (/<script/i.test(html)) problems.push('contains <script');
  const csp = cspOf(html);
  if (!csp) problems.push('missing CSP meta');
  else {
    for (const d of ["default-src 'none'", 'img-src data:', "base-uri 'none'", "form-action 'none'"]) {
      if (!csp.includes(d)) problems.push(`CSP lacks ${d}`);
    }
    const styles = styleBlocks(html);
    if (styles.length !== 1) problems.push(`expected exactly one style block, got ${styles.length}`);
    const hash = createHash('sha256')
      .update(styles[0] ?? '')
      .digest('base64');
    if (!csp.includes(`style-src 'sha256-${hash}'`)) problems.push('CSP style hash does not match');
    if (/unsafe-(inline|eval)/.test(csp)) problems.push('CSP allows unsafe-*');
  }
  if (!/<meta name="referrer" content="no-referrer">/.test(html)) problems.push('missing referrer policy');
  for (const tag of tagsOf(html)) {
    if (!ALLOWED_TAGS.has(tag.name)) problems.push(`unexpected tag <${tag.name}>`);
    for (const a of tag.attrs) {
      if (a.name.startsWith('on')) problems.push(`event handler ${a.name} in ${tag.raw}`);
      if (a.name === 'style') problems.push(`style attribute in ${tag.raw}`);
      if (['srcset', 'action', 'formaction', 'poster', 'background', 'data', 'ping'].includes(a.name)) {
        problems.push(`attribute ${a.name} in ${tag.raw}`);
      }
      if (a.name === 'src' && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.value)) {
        problems.push(`non-data src in ${tag.raw.slice(0, 120)}`);
      }
      if (a.name === 'href' && !/^#[A-Za-z0-9_-]+$/.test(a.value))
        problems.push(`external href in ${tag.raw}`);
      if (/^\s*(javascript|vbscript|https?|ftp|file):/i.test(a.value) || /^\s*\/\//.test(a.value)) {
        problems.push(`URL-like attribute value in ${tag.raw}`);
      }
    }
    if (tag.name === 'meta' && tag.attrs.some((a) => a.name === 'http-equiv' && /refresh/i.test(a.value))) {
      problems.push('meta refresh');
    }
  }
  return problems;
}
