// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
/**
 * Text of a legal document, evaluated INSIDE the page via `frame.evaluate`. Self-contained (no references to module
 * scope); reads only, without any click.
 */

declare const document: any;
declare const window: any;

export interface RawDocument {
  lang: string;
  title: string;
  /**
   * The first visible h1 that belongs to the content of the document (not to a navigation, aside, footer, page-level
   * header or hidden element; the same rule as `headingPlaces`), '' when there is none.
   */
  h1: string;
  /**
   * Visible headings (h1-h6, text only) by place: `chrome` sits in a navigation / aside / search / menu landmark,
   * in a page-level header, footer or menu-like wrapper outside `main` and `article` (`outsideText`); `content` is every
   * other one. Consent banners and scripts are skipped. Optional so that a reader without it sees no chrome headings.
   */
  headingPlaces?: { chrome: string[]; content: string[] };
  parts: Array<{ section: string; text: string; origin: 'visible' | 'expandable' | 'hidden-irrelevant' }>;
  /** Collapsed elements inside the text of the document (see `documentInPage`). */
  expandablesFound: number;
  expandablesWithContent: number;
  /** Collapsed elements left out because they belong to navigation, header, footer, aside or a consent banner. */
  expandablesIgnored?: number;
  textLength: number;
  truncated: boolean;
}

/**
 * Text of a legal document by heading sections without any click: rendered text, content of collapsed
 * `<details>` and `aria-expanded=false` panels (`expandable`), other hidden text (`hidden-irrelevant`).
 * Fixed consent banners are skipped so that banner texts are not mistaken for the document.
 *
 * Only collapsed elements inside the text of the document count in `expandablesFound` / `expandablesWithContent`
 * (the completeness manifest): an empty menu panel in `nav`, `header`, `footer`, `aside` or a banner is not part of the
 * policy and must not make it incomplete. Those are counted in `expandablesIgnored` and their text is not
 * `expandable` (it stays `visible` or `hidden-irrelevant`).
 *
 * The same rule (`outsideText`) sorts the visible headings into `headingPlaces.chrome` and `.content` and picks `h1`:
 * the rule is written once, so the manifest and the type of the page cannot disagree about what is page chrome
 * (an in-page function cannot share code with another one).
 */
export function documentInPage(arg: { maxChars: number }): RawDocument {
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
  const BANNER_RE =
    /(cookie|consent|cmp|gdpr|borlabs|cybot|cookiebot|usercentrics|cmplz|complianz|ccm19|cookiehub|real-cookie-banner|rcb-)/i;
  /** The names of the parts of a page in id/class tokens: `main-menu`, `site-header`, `page_footer`, `offcanvas`… */
  const NAV_NOUNS =
    'nav|navbar|navigation|menu|megamenu|mainmenu|flyout|offcanvas|sidebar|breadcrumbs?|topbar|masthead|header|footer';
  const NAV_WRAPPER_RE = new RegExp(`(?:^|[\\s_-])(?:${NAV_NOUNS})(?:$|[\\s_-])`, 'i');
  /**
   * A state of the layout, not a part of the page: `has-fixed-header`, `with-footer`, `page-with-header`, `no-sidebar`.
   * The token ends in the name of a part, but it says that the page has one (or has none), and the wrapper holds the
   * whole page. Judged per token: `site-header--no-border` or `header-with-logo` are still the header.
   */
  const LAYOUT_STATE_RE = new RegExp(
    `(?:^|[_-])(?:has|with|without|no)[_-](?:[a-z0-9]+[_-]){0,2}(?:${NAV_NOUNS})$`,
    'i',
  );
  /**
   * Header or footer of a component, not of the page: `accordion-header`, `card-header`, `panel-header`,
   * `el-collapse-item__header`, `section-header`, `card-footer`. The component name comes first (`header-menu` and
   * `footer-panel` are parts of the page chrome and stay so). Such tokens are removed before NAV_WRAPPER_RE looks at
   * the class: an accordion of a policy outside `main` must not count as page chrome.
   * Only the header of an ambiguous noun is a bar of a component (`item`, `entry`, `post`, `article`, `section`,
   * `block`): `section-footer` or `block-footer` is a footer of the page as often as a footer of a content block, and
   * a footer column "Impressum" in it must not confirm the page.
   */
  const COMPONENT_BAR_RE =
    /(^|[\s_-])(?:(?:accordion|collapse|collapsible|card|panel|expansion|faq|toggle|expand|expandable|tab|tabs)[_-]+(?:header|footer)|(?:item|entry|post|article|section|block)[_-]+header)(?=$|[\s_-])/gi;
  /** The id/class of an element names a part of the page (header, footer, menu…) rather than a component or a layout state. */
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
    title: String(document.title || '')
      .replace(/\s+/g, ' ')
      .trim(),
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
    const idc = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    if (!BANNER_RE.test(idc)) return false;
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
  /**
   * The element is a control or panel of the page chrome, not of the document text: a menu button (`aria-haspopup`,
   * `role=menuitem`), or it sits in a navigation / aside / search / menu landmark, in a consent banner, or in a
   * page-level header, footer or menu-like wrapper that is not inside `main` or an `article`.
   */
  const outsideText = (el: any): boolean => {
    const popup = el.getAttribute ? el.getAttribute('aria-haspopup') : null;
    const ownRole = el.getAttribute ? el.getAttribute('role') : null;
    if ((popup && popup !== 'false') || ownRole === 'menuitem') return true;
    let inContent = false;
    let chrome = false;
    for (let n = parentOf(el); n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      const tag = String(n.tagName || '').toLowerCase();
      const role = n.getAttribute ? n.getAttribute('role') : null;
      if (
        tag === 'nav' ||
        tag === 'aside' ||
        role === 'navigation' ||
        role === 'complementary' ||
        role === 'search' ||
        role === 'menu' ||
        role === 'menubar'
      ) {
        return true;
      }
      if (isBanner(n)) return true;
      if (tag === 'main' || tag === 'article' || role === 'main') inContent = true;
      if (tag === 'header' || tag === 'footer' || role === 'banner' || role === 'contentinfo') chrome = true;
      const idc = `${n.id || ''} ${typeof n.className === 'string' ? n.className : ''}`;
      if (namesPageChrome(idc)) chrome = true;
    }
    return chrome && !inContent;
  };

  const expandable = new Set<any>();
  let ignored = 0;
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
  out.expandablesIgnored = ignored;

  const headings: Array<{ level: number; text: string }> = [];
  const places = out.headingPlaces as { chrome: string[]; content: string[] };
  let cur: RawDocument['parts'][number] | null = null;
  let total = 0;
  const push = (text: string, origin: RawDocument['parts'][number]['origin']) => {
    if (total >= arg.maxChars) {
      out.truncated = true;
      return;
    }
    const t = text.slice(0, arg.maxChars - total);
    total += t.length + 1;
    const section = headings.map((h) => h.text).join(' > ');
    if (cur && cur.section === section && cur.origin === origin) cur.text += ` ${t}`;
    else {
      cur = { section, origin, text: t };
      out.parts.push(cur);
    }
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
  const walk = (node: any, inherited: 'visible' | 'expandable') => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = String(child.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!t) continue;
        if (inherited === 'expandable') push(t, 'expandable');
        else push(t, child.parentElement && isVisible(child.parentElement) ? 'visible' : 'hidden-irrelevant');
      } else if (child.nodeType === 1) {
        if (SKIP.has(child.tagName) || isBanner(child)) continue;
        const m = /^H([1-6])$/.exec(child.tagName);
        if (m && isVisible(child)) {
          const level = Number(m[1]);
          while (headings.length > 0 && (headings[headings.length - 1] as { level: number }).level >= level) {
            headings.pop();
          }
          const full = String(child.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          headings.push({ level, text: full.slice(0, 120) });
          cur = null;
          // One rule for chrome and content: the place of a heading is judged by the function that judges collapsed
          // elements. Only headings of the content name the type of the page.
          if (full !== '') {
            const chromeHeading = outsideText(child);
            places[chromeHeading ? 'chrome' : 'content'].push(full.slice(0, 120));
            if (level === 1 && !chromeHeading && out.h1 === '') out.h1 = full.slice(0, 200);
          }
        }
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
