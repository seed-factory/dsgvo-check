/** Node-side mapping of raw in-page DOM facts to redacted `DomFacts` (sanitized URLs, same-site flags). */
import type { Frame, Page } from 'playwright-core';
import {
  type DomFacts,
  type FormFact,
  type HrefKind,
  type IframeFact,
  isHttpHref,
  type LinkFact,
  type LinkRelFact,
} from '../../../core/snapshot/browser.ts';
import type { HeaderRecord } from '../../../core/snapshot/common.ts';
import { parseUrl, registrableDomain } from '../../../core/url/url.ts';
import { domFactsInPage, type RawDomFacts } from '../in-page/dom.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { loadDomPatterns } from '../rules.ts';
import { redactFreeText } from '../util.ts';
import type { CandidateLink } from './pages.ts';

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
    const rel = /rel\s*=\s*"?([^";]+)"?/i.exec(params)?.[1]?.toLowerCase().trim();
    if (!rel || !/(preconnect|dns-prefetch|preload|modulepreload|prefetch|prerender|stylesheet)/.test(rel))
      continue;
    const href = parseUrl(m[1] as string, base)?.toString();
    if (href === undefined) continue;
    const as = /\bas\s*=\s*"?([^";]+)"?/i.exec(params)?.[1];
    out.push({ rel, href: sanitizeRequestUrl(href), ...(as ? { as } : {}), source: 'header' });
  }
  return out;
}

function metaRefresh(content: string | null, base: string): DomFacts['metaRefresh'] | undefined {
  if (content === null) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]*)['"]?)?/i.exec(content);
  if (!m) return undefined;
  let url: string | null = null;
  if (m[2]) {
    const absolute = parseUrl(m[2], base);
    if (absolute) url = sanitizeRequestUrl(absolute.toString());
  }
  return { url, delaySec: Number(m[1]) };
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

export async function collectDom(
  page: Page,
  target: { etld1: string | null; host: string },
  responseHeaders: readonly HeaderRecord[],
): Promise<DomResult> {
  const raw = await page.evaluate(domFactsInPage, {
    maxLinks: 1500,
    maxScripts: 300,
    patterns: loadDomPatterns().page,
  });
  const base = page.url();
  const candidates: CandidateLink[] = [];
  const links: LinkFact[] = raw.links.map((l, order) => {
    const kind = hrefKind(l.attr, l.href);
    const navigable = isHttpHref(kind);
    // Free text is redacted here, before anything is stored or hashed: addresses, mailto:, URLs with a query.
    const text = redactFreeText(l.text);
    const name = redactFreeText(l.name);
    candidates.push({
      raw: l.href,
      hrefKind: kind,
      text,
      ...(name ? { accessibleName: name } : {}),
      region: l.region,
      visible: l.visible,
      order,
    });
    const sameSite = navigable ? sameSiteAs(l.href, target.etld1, target.host) : undefined;
    return {
      href: navigable || kind === 'other' ? sanitizeRequestUrl(l.href) : null,
      hrefKind: kind,
      text,
      ...(name ? { accessibleName: name } : {}),
      region: l.region,
      visible: l.visible,
      inShadowDom: l.inShadowDom,
      ...(sameSite !== undefined ? { sameSite } : {}),
      ...(l.rel ? { rel: l.rel } : {}),
    };
  });
  const forms: FormFact[] = raw.forms.map((f) => {
    const scheme: FormFact['actionScheme'] = !f.action
      ? 'none'
      : f.action.startsWith('https:')
        ? 'https'
        : f.action.startsWith('http:')
          ? 'http'
          : 'other';
    return {
      action: f.action && (scheme === 'http' || scheme === 'https') ? sanitizeRequestUrl(f.action) : null,
      actionScheme: scheme,
      method: f.method,
      visible: f.visible,
      fieldCount: f.fieldCount,
      hasPasswordField: f.hasPasswordField,
      hasEmailField: f.hasEmailField,
    };
  });
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
  const linkRels: LinkRelFact[] = raw.linkRels
    .filter((r) => /^https?:/.test(r.href))
    .map((r) => ({
      rel: r.rel,
      href: sanitizeRequestUrl(r.href),
      ...(r.as ? { as: r.as } : {}),
      source: 'dom',
    }));
  for (const h of responseHeaders) if (h.name === 'link') linkRels.push(...parseLinkHeader(h.value, base));
  const refresh = metaRefresh(raw.metaRefresh, base);
  const dom: DomFacts = {
    ...(raw.title ? { title: redactFreeText(raw.title) } : {}),
    ...(raw.lang ? { lang: raw.lang } : {}),
    ...(raw.h1 ? { h1: redactFreeText(raw.h1) } : {}),
    links,
    ...(raw.linksTruncated ? { linksTruncated: true } : {}),
    forms,
    iframes,
    linkRels,
    scripts: raw.scripts.map((s) => ({
      src: s.src && /^https?:/.test(s.src) ? sanitizeRequestUrl(s.src) : null,
      inline: s.inline,
      ...(s.type ? { type: s.type } : {}),
      ...(s.async ? { async: true } : {}),
      ...(s.defer ? { defer: true } : {}),
    })),
    ...(refresh ? { metaRefresh: refresh } : {}),
    visibleTextLength: raw.visibleTextLength,
    ...(raw.placeholders.length > 0
      ? { embedPlaceholders: raw.placeholders.map((p) => ({ kind: p.kind, text: redactFreeText(p.text) })) }
      : {}),
  };
  return { dom, candidates, raw };
}
