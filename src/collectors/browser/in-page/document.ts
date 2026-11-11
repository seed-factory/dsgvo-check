// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
/** Text of a legal document, evaluated INSIDE the page (self-contained); reads only, no click. */

declare const document: any;
declare const window: any;

export interface RawDocument {
  lang: string;
  title: string;
  // First visible h1 of the document content (not navigation, aside, footer, page-level header or hidden elements; same
  // rule as `headingPlaces`), '' when none.
  h1: string;
  // Visible headings by place: `chrome` in a navigation/aside/search/menu landmark or in a page-level header, footer or
  // menu-like wrapper outside `main` and `article` (`outsideText`); `content` is every other one. Banners and scripts
  // are skipped. Optional so that a reader without it sees no chrome headings.
  headingPlaces?: { chrome: string[]; content: string[] };
  // `place` by the same rule as `headingPlaces`, so footer text after a content section is a part of its own. Optional
  // like `headingPlaces`.
  parts: Array<{
    section: string;
    text: string;
    origin: 'visible' | 'expandable' | 'hidden-irrelevant';
    place?: 'content' | 'chrome';
  }>;
  expandablesFound: number;
  expandablesWithContent: number;
  /** Collapsed elements outside the document text (navigation, header, footer, aside, consent banner). */
  expandablesIgnored?: number;
  textLength: number;
  truncated: boolean;
}

/** Regular-expression sources (case-insensitive in the page) from test/data/browser/dom.yaml; the page cannot import. */
export interface DocumentPatterns {
  /** id/class names of a banner whose container is skipped. */
  bannerNames: string;
  /** Page-part names in id/class tokens (`main-menu`, `site-header`). */
  navWrapper: string;
  /** A layout state ending in a part name (`has-fixed-header`), judged per token. */
  layoutState: string;
  /** Header or footer of a component (`accordion-header`); one capture group, restored with `$1`. */
  componentBar: string;
}

// Text of a legal document by heading sections without any click: rendered text, collapsed `<details>` and
// `aria-expanded=false` panels (`expandable`), other hidden text (`hidden-irrelevant`). Only collapsed elements inside
// the document text count for completeness (an empty menu panel in a nav, header, footer, aside or banner must not make
// the policy incomplete). `outsideText` is the one rule for manifest, `headingPlaces` and `h1`.
export function documentInPage(arg: { maxChars: number; patterns: DocumentPatterns }): RawDocument {
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'IFRAME',
    'FRAME',
    'OBJECT',
    'CANVAS',
  ]);
  const MAX_HEADING_CHARS = 120;
  const MAX_H1_CHARS = 200;
  // Landmarks whose content is page chrome, not document text.
  const CHROME_TAGS = ['nav', 'aside'];
  const CHROME_ROLES = ['navigation', 'complementary', 'search', 'menu', 'menubar'];

  const BANNER_RE = new RegExp(arg.patterns.bannerNames, 'i');
  const NAV_WRAPPER_RE = new RegExp(arg.patterns.navWrapper, 'i');
  // A layout state, not a part (`has-fixed-header`, `with-footer`): the token ends in a part name but says the page has
  // one, and the wrapper holds the whole page. Judged per token: `site-header--no-border` is still the header.
  const LAYOUT_STATE_RE = new RegExp(arg.patterns.layoutState, 'i');
  // Header or footer of a component, not of the page (`accordion-header`, `card-footer`): removed before NAV_WRAPPER_RE
  // looks at the class, so an accordion of a policy outside `main` is no page chrome. Only the header of an ambiguous
  // noun (`item`, `entry`, `post`, `article`, `section`, `block`) is a component bar: `section-footer` is as often a
  // page footer, and a footer column "Impressum" in it must not confirm the page.
  const COMPONENT_BAR_RE = new RegExp(arg.patterns.componentBar, 'gi');

  const squash = (text: any): string =>
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  const idAndClass = (el: any): string =>
    `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
  const namesPageChrome = (idc: string): boolean =>
    NAV_WRAPPER_RE.test(
      idc
        .replace(COMPONENT_BAR_RE, '$1')
        .split(/\s+/)
        .filter((t) => !LAYOUT_STATE_RE.test(t))
        .join(' '),
    );

  const out: RawDocument = {
    lang: String(document.documentElement.getAttribute('lang') || ''),
    title: squash(document.title),
    h1: '',
    headingPlaces: { chrome: [], content: [] },
    parts: [],
    expandablesFound: 0,
    expandablesWithContent: 0,
    expandablesIgnored: 0,
    textLength: 0,
    truncated: false,
  };
  const body = document.body;
  if (!body) return out;

  const isBanner = (el: any): boolean => {
    if (!BANNER_RE.test(idAndClass(el))) return false;
    try {
      const p = window.getComputedStyle(el).position;
      return p === 'fixed' || p === 'sticky' || el.getAttribute('role') === 'dialog';
    } catch {
      return false;
    }
  };
  const parentOf = (n: any): any => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  // A control or panel of the page chrome, not of the document text: a menu button, or inside a navigation, aside,
  // search or menu landmark, a consent banner, or a page-level header, footer or menu-like wrapper outside `main`.
  const outsideText = (el: any): boolean => {
    const popup = el.getAttribute ? el.getAttribute('aria-haspopup') : null;
    const ownRole = el.getAttribute ? el.getAttribute('role') : null;
    if ((popup && popup !== 'false') || ownRole === 'menuitem') return true;

    let inContent = false;
    let chrome = false;
    for (let n = parentOf(el); n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      const tag = String(n.tagName || '').toLowerCase();
      const role = n.getAttribute ? n.getAttribute('role') : null;
      if (CHROME_TAGS.includes(tag) || CHROME_ROLES.includes(role)) return true;
      if (isBanner(n)) return true;
      if (tag === 'main' || tag === 'article' || role === 'main') inContent = true;
      if (tag === 'header' || tag === 'footer' || role === 'banner' || role === 'contentinfo') chrome = true;
      if (namesPageChrome(idAndClass(n))) chrome = true;
    }
    return chrome && !inContent;
  };

  const expandable = new Set<any>();
  let ignored = 0;
  const collectDetails = () => {
    for (const d of document.querySelectorAll('details')) {
      if (outsideText(d)) {
        ignored++;
        continue;
      }
      out.expandablesFound++;
      const content = Array.from(d.children).filter((c: any) => c.tagName !== 'SUMMARY');
      if (content.some((c: any) => String(c.textContent || '').trim())) out.expandablesWithContent++;
      if (!d.open) for (const c of content) expandable.add(c);
    }
  };
  const collectAriaExpanded = () => {
    for (const t of document.querySelectorAll('[aria-expanded="false"]')) {
      const ids = String(t.getAttribute('aria-controls') || '')
        .split(/\s+/)
        .filter(Boolean);
      const panels = ids.map((id) => document.getElementById(id)).filter(Boolean);
      if (panels.length === 0 && t.nextElementSibling && !t.nextElementSibling.checkVisibility()) {
        panels.push(t.nextElementSibling);
      }

      const chrome = outsideText(t) || panels.some((p: any) => outsideText(p));
      for (const p of panels) {
        if (expandable.has(p)) continue;
        if (chrome) {
          ignored++;
          continue;
        }
        out.expandablesFound++;
        if (String(p.textContent || '').trim()) out.expandablesWithContent++;
        expandable.add(p);
      }
    }
  };
  collectDetails();
  collectAriaExpanded();
  out.expandablesIgnored = ignored;

  const headings: Array<{ level: number; text: string }> = [];
  const places = out.headingPlaces as { chrome: string[]; content: string[] };
  type Part = RawDocument['parts'][number];
  let cur: Part | null = null;
  let total = 0;
  const push = (text: string, origin: Part['origin'], place: 'content' | 'chrome') => {
    if (total >= arg.maxChars) {
      out.truncated = true;
      return;
    }
    const t = text.slice(0, arg.maxChars - total);
    total += t.length + 1;
    const section = headings.map((h) => h.text).join(' > ');
    if (cur && cur.section === section && cur.origin === origin && cur.place === place) cur.text += ` ${t}`;
    else {
      cur = { section, origin, place, text: t };
      out.parts.push(cur);
    }
  };
  // Text nodes of one element share its place; the walk up the ancestors runs once per element.
  const placeCache = new Map<any, 'content' | 'chrome'>();
  const placeOf = (textNode: any): 'content' | 'chrome' => {
    const key = textNode.parentElement || parentOf(textNode);
    let place = placeCache.get(key);
    if (place === undefined) {
      place = outsideText(textNode) ? 'chrome' : 'content';
      placeCache.set(key, place);
    }
    return place;
  };
  const visibleCache = new Map<any, boolean>();
  const isVisible = (el: any): boolean => {
    let v = visibleCache.get(el);
    if (v === undefined) {
      try {
        v = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
      } catch {
        v = true;
      }
      visibleCache.set(el, v as boolean);
    }
    return v as boolean;
  };

  const startSection = (heading: any, level: number) => {
    while (headings.length > 0 && (headings[headings.length - 1] as { level: number }).level >= level) {
      headings.pop();
    }
    const full = squash(heading.textContent);
    headings.push({ level, text: full.slice(0, MAX_HEADING_CHARS) });
    cur = null;

    // One rule for chrome and content: the place of a heading is judged by the function that judges collapsed
    // elements. Only headings of the content name the type of the page.
    if (full === '') return;
    const chromeHeading = outsideText(heading);
    places[chromeHeading ? 'chrome' : 'content'].push(full.slice(0, MAX_HEADING_CHARS));
    if (level === 1 && !chromeHeading && out.h1 === '') out.h1 = full.slice(0, MAX_H1_CHARS);
  };
  const walkText = (textNode: any, inherited: 'visible' | 'expandable') => {
    const t = squash(textNode.textContent);
    if (!t) return;
    const place = placeOf(textNode);
    if (inherited === 'expandable') push(t, 'expandable', place);
    else
      push(
        t,
        textNode.parentElement && isVisible(textNode.parentElement) ? 'visible' : 'hidden-irrelevant',
        place,
      );
  };
  const walk = (node: any, inherited: 'visible' | 'expandable') => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        walkText(child, inherited);
      } else if (child.nodeType === 1) {
        if (SKIP.has(child.tagName) || isBanner(child)) continue;

        const m = /^H([1-6])$/.exec(child.tagName);
        if (m && isVisible(child)) startSection(child, Number(m[1]));

        const origin = inherited === 'expandable' || expandable.has(child) ? 'expandable' : 'visible';
        if (child.shadowRoot) walk(child.shadowRoot, origin);
        walk(child, origin);
      }
    }
  };
  walk(body, 'visible');
  out.textLength = total;
  return out;
}
