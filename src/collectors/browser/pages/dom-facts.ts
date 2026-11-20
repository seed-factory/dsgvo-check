/** Node-side mapping of raw in-page DOM facts to redacted `DomFacts` (sanitized URLs, same-site flags). */
import type { Frame, Page } from 'playwright-core';
import { isNameLike, languagePrefix } from '../../../core/redaction/page-names.ts';
import {
  type DomFacts,
  type DomRegion,
  type FormFact,
  type HrefKind,
  type IframeFact,
  isHttpHref,
  type LinkFact,
  type LinkRelFact,
} from '../../../core/snapshot/browser.ts';
import type { HeaderRecord, SanitizedUrl } from '../../../core/snapshot/common.ts';
import { REDACTED } from '../../../core/url/email.ts';
import { maskMailto, parseUrl, registrableDomain } from '../../../core/url/url.ts';
import { NON_DATA_INPUT_TYPES } from '../../http/html.ts';
import { loadHtmlRules } from '../../http/rules.ts';
import {
  domFactsInPage,
  type FormRules,
  type RawDomFacts,
  type RawForm,
  type RawIframe,
  type RawLink,
} from '../in-page/dom.ts';
import {
  anchorRel,
  box,
  count,
  fetchDestination,
  fields,
  flag,
  formMethod,
  hintRel,
  list,
  scriptType,
  str,
} from '../page-values.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { loadDomPatterns } from '../rules.ts';
import { redactFreeText } from '../util.ts';
import type { CandidateLink } from './pages.ts';

/** Read caps of the in-page walk; a page over them is marked `linksTruncated` and the rest is not read. */
const MAX_LINKS = 1500;
const MAX_SCRIPTS = 300;
const MAX_PLACEHOLDERS = 20;
/**
 * The page code keeps up to twice `MAX_LINKS` on a page over the cap (legal, footer and navigation links first). Its
 * caps hold in Node too: a page that replaces `Array.prototype.push` makes its answer as long as it likes.
 */
const MAX_STORED_LINKS = 2 * MAX_LINKS;
/** Caps of the page code's text fields (`clean` in in-page/dom.ts), kept in Node too. */
const LINK_TEXT_CHARS = 200;
const TITLE_CHARS = 300;
const H1_CHARS = 200;
const PLACEHOLDER_TEXT_CHARS = 120;
const TEXT_SAMPLE_CHARS = 4000;

const DOM_REGIONS: ReadonlySet<string> = new Set<DomRegion>([
  'header',
  'nav',
  'main',
  'footer',
  'banner',
  'aside',
  'other',
]);
const PLACEHOLDER_KINDS: ReadonlySet<string> = new Set(['maps', 'video', 'other']);

const regionOf = (v: unknown): DomRegion =>
  typeof v === 'string' && DOM_REGIONS.has(v) ? (v as DomRegion) : 'other';

function checkedLink(v: unknown): RawLink {
  const l = fields(v);
  return {
    href: str(l.href),
    attr: str(l.attr),
    text: str(l.text, LINK_TEXT_CHARS),
    name: str(l.name, LINK_TEXT_CHARS),
    region: regionOf(l.region),
    visible: flag(l.visible),
    inShadowDom: flag(l.inShadowDom),
    rel: str(l.rel),
    hreflang: str(l.hreflang),
  };
}

function checkedForm(v: unknown): RawForm {
  const f = fields(v);
  return {
    action: str(f.action),
    method: str(f.method),
    visible: flag(f.visible),
    fieldCount: count(f.fieldCount),
    hasPasswordField: flag(f.hasPasswordField),
    hasEmailField: flag(f.hasEmailField),
    takesInput: flag(f.takesInput),
  };
}

function checkedIframe(v: unknown): RawIframe {
  const f = fields(v);
  return {
    src: str(f.src),
    srcdoc: flag(f.srcdoc),
    title: str(f.title, LINK_TEXT_CHARS),
    visible: flag(f.visible),
    box: box(f.box),
    loading: str(f.loading),
  };
}

/**
 * The answer of `domFactsInPage` in the shape the page code promises. It runs in the page's main world, whose script
 * can replace the globals it calls (`Array.prototype.push`, `String`, `Math`), so every field is checked here: a string
 * or '', a flag only when `true`, a count only as a safe integer, a region or kind of the closed set, a box of numbers.
 */
export function checkedRawDom(v: unknown): RawDomFacts {
  const d = fields(v);
  const links = list(d.links);
  return {
    title: str(d.title, TITLE_CHARS),
    lang: str(d.lang),
    h1: str(d.h1, H1_CHARS),
    links: links.slice(0, MAX_STORED_LINKS).map(checkedLink),
    forms: list(d.forms).map(checkedForm),
    iframes: list(d.iframes).map(checkedIframe),
    linkRels: list(d.linkRels).map((x) => {
      const r = fields(x);
      return { rel: str(r.rel), href: str(r.href), as: str(r.as) };
    }),
    scripts: list(d.scripts)
      .slice(0, MAX_SCRIPTS)
      .map((x) => {
        const r = fields(x);
        return {
          src: str(r.src),
          inline: flag(r.inline),
          type: str(r.type),
          async: flag(r.async),
          defer: flag(r.defer),
        };
      }),
    metaRefresh: typeof d.metaRefresh === 'string' ? d.metaRefresh : null,
    visibleTextLength: count(d.visibleTextLength),
    textSample: str(d.textSample, TEXT_SAMPLE_CHARS),
    placeholders: list(d.placeholders)
      .slice(0, MAX_PLACEHOLDERS)
      .map((x) => {
        const p = fields(x);
        const kind = typeof p.kind === 'string' && PLACEHOLDER_KINDS.has(p.kind) ? p.kind : 'other';
        return { kind: kind as 'maps' | 'video' | 'other', text: str(p.text, PLACEHOLDER_TEXT_CHARS) };
      }),
    linksTotal: count(d.linksTotal),
    linksTruncated: flag(d.linksTruncated) || links.length > MAX_STORED_LINKS,
  };
}

export interface DomResult {
  dom: DomFacts;
  candidates: CandidateLink[];
  raw: RawDomFacts;
}

function hrefKind(attr: string, resolved: string): HrefKind {
  const a = attr.trim();
  if (a === '') return 'empty';
  if (a.startsWith('#')) return 'fragment';
  const lower = a.toLowerCase();
  if (lower.startsWith('javascript:')) return 'javascript';
  if (lower.startsWith('mailto:')) return 'mailto';
  if (lower.startsWith('tel:')) return 'tel';
  if (resolved.startsWith('https:')) return 'https';
  if (resolved.startsWith('http:')) return 'http';
  return 'other';
}

function safeHost(url: string): string | null {
  return parseUrl(url)?.hostname.toLowerCase() ?? null;
}

function sameSiteAs(url: string, etld1: string | null, host: string): boolean | undefined {
  const h = safeHost(url);
  if (h === null) return undefined;
  return etld1 === null ? h === host : registrableDomain(h) === etld1;
}

export function parseLinkHeader(value: string, base: string): LinkRelFact[] {
  const out: LinkRelFact[] = [];
  for (const part of value.split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>\s*(.*)$/.exec(part.trim());
    if (!m) continue;

    const params = m[2] as string;
    // The site's server writes the parameters: only the hint types and a Fetch destination are kept.
    const rel = hintRel(/rel\s*=\s*"?([^";]+)"?/i.exec(params)?.[1] ?? '');
    if (!rel) continue;
    const href = parseUrl(m[1] as string, base)?.toString();
    if (href === undefined) continue;

    const as = fetchDestination(/\bas\s*=\s*"?([^";]+)"?/i.exec(params)?.[1] ?? '');
    out.push({ rel, href: sanitizeRequestUrl(href), ...(as ? { as } : {}), source: 'header' });
  }
  return out;
}

function metaRefresh(content: string | null, base: string): DomFacts['metaRefresh'] | undefined {
  if (content === null) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]*)['"]?)?/i.exec(content);
  if (!m) return undefined;
  // Only an http(s) target: a `javascript:` or `data:` target is text the page wrote, no address a sanitizer reads.
  const absolute = m[2] ? parseUrl(m[2], base, true) : null;
  return { url: absolute ? sanitizeRequestUrl(absolute.toString()) : null, delaySec: Number(m[1]) };
}

async function nestedFrames(page: Page): Promise<IframeFact[]> {
  const out: IframeFact[] = [];
  const depthOf = (f: Frame) => {
    let d = 0;
    for (let p = f.parentFrame(); p; p = p.parentFrame()) d++;
    return d;
  };
  for (const f of page.frames()) {
    const depth = depthOf(f);
    if (depth < 2) continue;

    const url = f.url();
    let visible = false;
    try {
      const el = await f.frameElement();
      visible = await el.isVisible();
    } catch {
      visible = false;
    }
    out.push({ src: /^https?:/.test(url) ? sanitizeRequestUrl(url) : null, srcdoc: false, visible, depth });
  }
  return out;
}

function actionSchemeOf(action: string): FormFact['actionScheme'] {
  if (!action) return 'none';
  if (action.startsWith('https:')) return 'https';
  if (action.startsWith('http:')) return 'http';
  return 'other';
}

/** A BCP 47 language[-Script][-Region] (`de`, `en-gb`) or `x-default`, lower case; anything else is no language. */
function languageTag(value: string): string | null {
  if (value.trim().toLowerCase() === 'x-default') return 'x-default';
  return languagePrefix(value)?.toLowerCase() ?? null;
}

/**
 * The HTML link type `bookmark` among the tokens of `rel`: the link is the permalink of the nearest article. Tokens are
 * separated by ASCII whitespace and compared ASCII case-insensitively (HTML, "set of space-separated tokens").
 */
const isPermalink = (rel: string): boolean =>
  rel
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .includes('bookmark');

/** Longest scheme a link of another kind keeps. */
const MAX_SCHEME = 32;

/**
 * The href of a link of another kind (`skype:`, `whatsapp:`, `ftp:`) as stored: its scheme only, when that is a name.
 * The rest is the page's to choose, and no sanitizer knows what it means: a user name, a phone number, an intent.
 */
function otherHref(href: string): SanitizedUrl | null {
  const scheme = parseUrl(href)?.protocol.slice(0, -1);
  return scheme && isNameLike(scheme, MAX_SCHEME) ? `${scheme}:${REDACTED}` : null;
}

/** Raw links to stored link facts (redacted) and to the in-memory candidates of the page planner. */
export function mapLinks(
  raw: Pick<RawDomFacts, 'links'>,
  target: { etld1: string | null; host: string },
): { links: LinkFact[]; candidates: CandidateLink[] } {
  const candidates: CandidateLink[] = [];
  const links: LinkFact[] = list(raw.links).map((rawLink, order) => {
    const l = checkedLink(rawLink);
    const kind = hrefKind(l.attr, l.href);
    const navigable = isHttpHref(kind);
    // Free text is redacted here, before anything is stored or hashed: addresses, mailto:, URLs with a query.
    const text = redactFreeText(l.text);
    const name = redactFreeText(l.name);
    const hreflang = languageTag(l.hreflang);
    candidates.push({
      raw: l.href,
      hrefKind: kind,
      text,
      ...(name ? { accessibleName: name } : {}),
      region: l.region,
      visible: l.visible,
      order,
      ...(hreflang ? { hreflang } : {}),
    });

    const sameSite = navigable ? sameSiteAs(l.href, target.etld1, target.host) : undefined;
    // The page writes `rel`: only HTML link types are kept; the permalink flag is read from the whole value.
    const rel = anchorRel(l.rel);
    return {
      href: navigable ? sanitizeRequestUrl(l.href) : kind === 'other' ? otherHref(l.href) : null,
      hrefKind: kind,
      // The recipient domain names the mail domain of an Impressum whose link text is no address ("E-Mail schreiben").
      ...(kind === 'mailto' ? { mailto: maskMailto(l.attr) } : {}),
      text,
      ...(name ? { accessibleName: name } : {}),
      region: l.region,
      visible: l.visible,
      inShadowDom: l.inShadowDom,
      ...(sameSite !== undefined ? { sameSite } : {}),
      ...(rel ? { rel } : {}),
      ...(isPermalink(l.rel) ? { permalink: true as const } : {}),
    };
  });
  return { links, candidates };
}

function mapForms(raw: RawDomFacts): FormFact[] {
  return raw.forms.map((f) => {
    const scheme = actionSchemeOf(f.action);
    return {
      action: f.action && (scheme === 'http' || scheme === 'https') ? sanitizeRequestUrl(f.action) : null,
      actionScheme: scheme,
      method: formMethod(f.method),
      visible: f.visible,
      fieldCount: f.fieldCount,
      hasPasswordField: f.hasPasswordField,
      hasEmailField: f.hasEmailField,
      takesInput: f.takesInput,
    };
  });
}

/** The search-form wording of test/data/http/html.yaml, as the page code takes it (sources and lists). */
export function formRules(): FormRules {
  const rules = loadHtmlRules();
  return {
    searchForm: rules.searchForm.source,
    searchFieldNames: [...rules.searchFieldNames],
    nonDataInputs: [...NON_DATA_INPUT_TYPES],
  };
}

/** Iframes of the main document (depth 1) and the nested frames Playwright knows (depth 2 and deeper). */
async function mapIframes(page: Page, raw: RawDomFacts): Promise<IframeFact[]> {
  const iframes: IframeFact[] = raw.iframes.map((f) => ({
    src: /^https?:/.test(f.src) ? sanitizeRequestUrl(f.src) : null,
    srcdoc: f.srcdoc,
    ...(f.title ? { title: redactFreeText(f.title) } : {}),
    visible: f.visible,
    box: f.box,
    ...(f.loading === 'lazy' || f.loading === 'eager' ? { loading: f.loading } : {}),
    depth: 1,
  }));
  iframes.push(...(await nestedFrames(page)));
  return iframes;
}

/** `<link rel>` hints of the document and of the `Link` response headers. */
function mapLinkRels(
  raw: RawDomFacts,
  responseHeaders: readonly HeaderRecord[],
  base: string,
): LinkRelFact[] {
  const linkRels: LinkRelFact[] = [];
  for (const r of raw.linkRels) {
    // The page writes `rel` and `as`: only the hint types and a Fetch destination are kept, as for the header.
    const rel = hintRel(r.rel);
    if (!rel || !/^https?:/.test(r.href)) continue;
    const as = fetchDestination(r.as);
    linkRels.push({ rel, href: sanitizeRequestUrl(r.href), ...(as ? { as } : {}), source: 'dom' });
  }
  for (const h of responseHeaders) if (h.name === 'link') linkRels.push(...parseLinkHeader(h.value, base));
  return linkRels;
}

function mapScripts(raw: RawDomFacts): DomFacts['scripts'] {
  return raw.scripts.map((s) => {
    const type = scriptType(s.type);
    return {
      src: s.src && /^https?:/.test(s.src) ? sanitizeRequestUrl(s.src) : null,
      inline: s.inline,
      ...(type ? { type } : {}),
      ...(s.async ? { async: true } : {}),
      ...(s.defer ? { defer: true } : {}),
    };
  });
}

export async function collectDom(
  page: Page,
  target: { etld1: string | null; host: string },
  responseHeaders: readonly HeaderRecord[],
): Promise<DomResult> {
  const raw = checkedRawDom(
    await page.evaluate(domFactsInPage, {
      maxLinks: MAX_LINKS,
      maxScripts: MAX_SCRIPTS,
      maxPlaceholders: MAX_PLACEHOLDERS,
      patterns: loadDomPatterns().page,
      forms: formRules(),
    }),
  );
  const base = page.url();

  const { links, candidates } = mapLinks(raw, target);
  const forms = mapForms(raw);
  const iframes = await mapIframes(page, raw);
  const linkRels = mapLinkRels(raw, responseHeaders, base);
  const refresh = metaRefresh(raw.metaRefresh, base);
  // Only a language tag, as written: a `lang` attribute can hold any text the page puts there.
  const lang = languagePrefix(raw.lang);

  const dom: DomFacts = {
    ...(raw.title ? { title: redactFreeText(raw.title) } : {}),
    ...(lang ? { lang } : {}),
    ...(raw.h1 ? { h1: redactFreeText(raw.h1) } : {}),
    links,
    ...(raw.linksTruncated ? { linksTruncated: true } : {}),
    forms,
    iframes,
    linkRels,
    scripts: mapScripts(raw),
    ...(refresh ? { metaRefresh: refresh } : {}),
    visibleTextLength: raw.visibleTextLength,
    ...(raw.placeholders.length > 0
      ? { embedPlaceholders: raw.placeholders.map((p) => ({ kind: p.kind, text: redactFreeText(p.text) })) }
      : {}),
  };
  return { dom, candidates, raw };
}
