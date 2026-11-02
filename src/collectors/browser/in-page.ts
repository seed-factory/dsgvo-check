// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/performance/useDomNodeTextContent: innerText is the rendered text we want
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
/**
 * Functions evaluated INSIDE the page via `page.evaluate` / `frame.evaluate`. They must be self-contained (no
 * references to module scope) and must never return cookie, storage or form values: only names, lengths and
 * structural facts. Node-side code sanitizes URLs before anything is stored.
 */

declare const document: any;
declare const window: any;
declare const location: any;
declare const localStorage: any;
declare const sessionStorage: any;
declare const indexedDB: any;

export interface RawLink {
  href: string;
  attr: string;
  text: string;
  name: string;
  region: 'header' | 'nav' | 'main' | 'footer' | 'banner' | 'aside' | 'other';
  visible: boolean;
  inShadowDom: boolean;
  rel: string;
}

export interface RawForm {
  action: string;
  method: string;
  visible: boolean;
  fieldCount: number;
  hasPasswordField: boolean;
  hasEmailField: boolean;
}

export interface RawIframe {
  src: string;
  srcdoc: boolean;
  title: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
  loading: string;
}

export interface RawDomFacts {
  title: string;
  lang: string;
  h1: string;
  links: RawLink[];
  forms: RawForm[];
  iframes: RawIframe[];
  linkRels: Array<{ rel: string; href: string; as: string }>;
  scripts: Array<{ src: string; inline: boolean; type: string; async: boolean; defer: boolean }>;
  metaRefresh: string | null;
  visibleTextLength: number;
  textSample: string;
  placeholders: Array<{ kind: 'maps' | 'video' | 'other'; text: string }>;
  /** All `a[href]` / `area[href]` elements of the document (also the ones that were not returned). */
  linksTotal: number;
  /** `links` holds fewer links than the document has (the cap `maxLinks` applied, see `domFactsInPage`). */
  linksTruncated: boolean;
}

/**
 * DOM facts of the main document including open shadow roots.
 *
 * Links are capped at `maxLinks`. A cap that simply cuts at document order loses the footer with Impressum and
 * Datenschutz on pages with a long article list, so a page over the cap is read in two passes: first the links
 * that matter for the legal and navigation checks (legal keywords anywhere, then `footer`, `banner`, `header`,
 * `nav` regions; at most `2 * maxLinks` of them as a safety bound), then the other links in document order up to
 * `maxLinks` in total. The result keeps document order; `linksTruncated` tells that links were left out.
 */
export function domFactsInPage(arg: { maxLinks: number; maxScripts: number }): RawDomFacts {
  const BANNER_RE =
    /(cookie|consent|cmp|gdpr|dsgvo|borlabs|cybot|cookiebot|usercentrics|cmplz|complianz|ccm19|cookiehub|real-cookie-banner|rcb-)/i;
  const PH_CLASS_RE =
    /(content-blocker|contentblocker|cmplz-placeholder|cmplz-blocked|uc-embedding|cookieconsent-optout|consent-placeholder|two-click|2-click|zwei-klick|ccm-blocked)/i;
  const PH_TEXT_RE =
    /((karte|map|video|inhalt|youtube|vimeo|google maps)[^.]{0,40}(laden|anzeigen|aktivieren|entsperren|load))|((laden|anzeigen|aktivieren)[^.]{0,20}(karte|video|inhalt))/i;

  const all: any[] = [];
  const collect = (root: any, depth: number) => {
    if (depth > 8) return;
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
    }
  };
  collect(document, 0);

  const parentOf = (n: any): any => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const isFixed = (el: any): boolean => {
    try {
      const p = window.getComputedStyle(el).position;
      return p === 'fixed' || p === 'sticky';
    } catch {
      return false;
    }
  };
  const isBannerContainer = (el: any): boolean => {
    const idc = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    if (BANNER_RE.test(idc)) return true;
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (
      role === 'dialog' ||
      role === 'alertdialog' ||
      (el.getAttribute && el.getAttribute('aria-modal') === 'true')
    ) {
      return isFixed(el) && /cookie|datenschutz|einwillig|consent|privacy/i.test(el.textContent || '');
    }
    return false;
  };
  const regionOf = (el: any): RawLink['region'] => {
    let n = parentOf(el);
    while (n && n !== document.body && n !== document.documentElement) {
      const tag = (n.tagName || '').toLowerCase();
      const role = n.getAttribute ? n.getAttribute('role') : null;
      if (isBannerContainer(n)) return 'banner';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'nav' || role === 'navigation') return 'nav';
      if (tag === 'header' || role === 'banner') return 'header';
      if (tag === 'aside' || role === 'complementary') return 'aside';
      if (tag === 'main' || role === 'main') return 'main';
      n = parentOf(n);
    }
    return 'other';
  };
  const visible = (el: any): boolean => {
    try {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  };
  const clean = (s: string, max = 200) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const inShadow = (el: any) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return Boolean(root && root.host);
  };

  const LEGAL_LINK_RE =
    /(impressum|imprint|datenschutz|privacy|data[-\s]?protection|rechtliches|legal|agb|nutzungsbedingungen|terms|kontakt|contact|cookie|widerruf|barrierefreiheit|accessibility|anbieter)/i;
  const linkEls = all.filter((el) => {
    const t = (el.tagName || '').toLowerCase();
    return (t === 'a' || t === 'area') && el.hasAttribute('href');
  });
  const chosenLinks = new Set<any>();
  if (linkEls.length <= arg.maxLinks) {
    for (const el of linkEls) chosenLinks.add(el);
  } else {
    const legal: any[] = [];
    const footer: any[] = [];
    const navigation: any[] = [];
    const rest: any[] = [];
    for (const el of linkEls) {
      const probe = `${el.getAttribute('href') || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
      const region = regionOf(el);
      if (LEGAL_LINK_RE.test(probe.slice(0, 600))) legal.push(el);
      else if (region === 'footer') footer.push(el);
      else if (region === 'banner' || region === 'header' || region === 'nav') navigation.push(el);
      else rest.push(el);
    }
    for (const el of [...legal, ...footer, ...navigation].slice(0, arg.maxLinks * 2)) chosenLinks.add(el);
    let budget = arg.maxLinks - chosenLinks.size;
    for (const el of rest) {
      if (budget <= 0) break;
      chosenLinks.add(el);
      budget--;
    }
  }
  const linksTruncated = chosenLinks.size < linkEls.length;

  const links: RawLink[] = [];
  const forms: RawForm[] = [];
  const iframes: RawIframe[] = [];
  const linkRels: RawDomFacts['linkRels'] = [];
  const scripts: RawDomFacts['scripts'] = [];
  const placeholders: RawDomFacts['placeholders'] = [];
  let metaRefresh: string | null = null;

  for (const el of all) {
    const tag = (el.tagName || '').toLowerCase();
    if ((tag === 'a' || tag === 'area') && chosenLinks.has(el)) {
      const text = clean(el.innerText || el.textContent || '');
      let name = clean(el.getAttribute('aria-label') || '');
      if (!name && el.getAttribute('aria-labelledby')) {
        name = clean(
          el
            .getAttribute('aria-labelledby')
            .split(/\s+/)
            .map((id: string) => {
              const t = document.getElementById(id);
              return t ? t.textContent : '';
            })
            .join(' '),
        );
      }
      if (!name) name = clean(el.getAttribute('title') || '');
      if (!name) {
        const img = el.querySelector ? el.querySelector('img[alt]') : null;
        if (img) name = clean(img.getAttribute('alt') || '');
      }
      links.push({
        href: String(el.href || ''),
        attr: String(el.getAttribute('href') || ''),
        text,
        name: name && name !== text ? name : '',
        region: regionOf(el),
        visible: visible(el),
        inShadowDom: inShadow(el),
        rel: String(el.getAttribute('rel') || ''),
      });
    } else if (tag === 'form') {
      const fields = el.querySelectorAll('input:not([type=hidden]), select, textarea');
      forms.push({
        action: String(el.getAttribute('action') === null ? '' : el.action || ''),
        method: String(el.getAttribute('method') || 'get').toLowerCase(),
        visible: visible(el),
        fieldCount: fields.length,
        hasPasswordField: Boolean(el.querySelector('input[type=password]')),
        hasEmailField: Boolean(el.querySelector('input[type=email], input[name*=mail i]')),
      });
    } else if (tag === 'iframe' || tag === 'frame') {
      const r = el.getBoundingClientRect();
      iframes.push({
        src: String(el.getAttribute('src') === null ? '' : el.src || ''),
        srcdoc: el.hasAttribute('srcdoc'),
        title: clean(el.getAttribute('title') || ''),
        visible: visible(el),
        box: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        loading: String(el.getAttribute('loading') || ''),
      });
    } else if (tag === 'link' && el.hasAttribute('rel') && el.hasAttribute('href')) {
      const rel = String(el.getAttribute('rel') || '').toLowerCase();
      if (/(preconnect|dns-prefetch|preload|modulepreload|prefetch|prerender|stylesheet)/.test(rel)) {
        linkRels.push({ rel, href: String(el.href || ''), as: String(el.getAttribute('as') || '') });
      }
    } else if (tag === 'script' && scripts.length < arg.maxScripts) {
      const src = el.getAttribute('src');
      scripts.push({
        src: src === null ? '' : String(el.src || ''),
        inline: src === null,
        type: String(el.getAttribute('type') || ''),
        async: el.hasAttribute('async'),
        defer: el.hasAttribute('defer'),
      });
    } else if (tag === 'meta' && /^refresh$/i.test(el.getAttribute('http-equiv') || '')) {
      metaRefresh = String(el.getAttribute('content') || '');
    }
    if (placeholders.length < 20 && tag !== 'script' && tag !== 'style') {
      const idc = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      let hit = PH_CLASS_RE.test(idc);
      if (!hit && (tag === 'button' || tag === 'a' || tag === 'div' || tag === 'span' || tag === 'p')) {
        const own = clean(el.innerText || '', 160);
        hit = own.length > 0 && own.length < 160 && PH_TEXT_RE.test(own) && el.children.length <= 3;
      }
      if (hit) {
        const text = clean(el.innerText || '', 120);
        const probe = `${idc} ${text}`;
        const kind = /map|karte/i.test(probe)
          ? 'maps'
          : /video|youtube|vimeo/i.test(probe)
            ? 'video'
            : 'other';
        if (!placeholders.some((p) => p.text === text && p.kind === kind)) placeholders.push({ kind, text });
      }
    }
  }

  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const h1 = document.querySelector('h1');
  return {
    title: clean(document.title || '', 300),
    lang: String(document.documentElement.getAttribute('lang') || ''),
    h1: h1 ? clean(h1.innerText || h1.textContent || '', 200) : '',
    links,
    forms,
    iframes,
    linkRels,
    scripts,
    metaRefresh,
    visibleTextLength: bodyText.replace(/\s+/g, ' ').trim().length,
    textSample: bodyText.replace(/\s+/g, ' ').trim().slice(0, 4000),
    placeholders,
    linksTotal: linkEls.length,
    linksTruncated,
  };
}

export interface RawStorage {
  origin: string;
  local: Array<{ key: string; length: number }>;
  session: Array<{ key: string; length: number }>;
  idb: string[];
}

/** Keys and value LENGTHS of Web Storage plus IndexedDB database names of this frame (no values). */
export async function storageInPage(arg: { maxKeys: number }): Promise<RawStorage> {
  const out: RawStorage = { origin: String(location.origin), local: [], session: [], idb: [] };
  const read = (s: any, into: RawStorage['local']) => {
    for (let i = 0; i < s.length && into.length < arg.maxKeys; i++) {
      const k = s.key(i);
      if (k === null) continue;
      const v = s.getItem(k);
      into.push({ key: String(k).slice(0, 200), length: v === null ? 0 : String(v).length });
    }
  };
  try {
    read(localStorage, out.local);
  } catch {
    // storage blocked for this frame
  }
  try {
    read(sessionStorage, out.session);
  } catch {
    // storage blocked for this frame
  }
  try {
    if (indexedDB && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      for (const d of dbs) if (d && d.name) out.idb.push(String(d.name).slice(0, 200));
    }
  } catch {
    // opaque origin
  }
  return out;
}

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

/**
 * Box of the banner container that holds the given first-layer points (button centres), measured without scrolling
 * The container is the closest common ancestor that is fixed/sticky, a dialog, or named like a consent banner.
 */
export function bannerBoxInPage(arg: { points: Array<{ x: number; y: number }> }): {
  box: { x: number; y: number; width: number; height: number } | null;
  reason: string;
} {
  const BANNER_RE =
    /(cookie|consent|cmp|gdpr|dsgvo|borlabs|cybot|cookiebot|usercentrics|cmplz|complianz|ccm19|cookiehub|real-cookie-banner|rcb-)/i;
  const parentOf = (n: any): any => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const chain = (el: any): any[] => {
    const out: any[] = [];
    for (let n = el; n; n = parentOf(n)) out.push(n);
    return out;
  };
  const els = arg.points.map((p) => document.elementFromPoint(p.x, p.y)).filter(Boolean);
  if (els.length === 0) return { box: null, reason: 'no-element-at-buttons' };
  let common = chain(els[0]);
  for (const e of els.slice(1)) {
    const set = new Set(chain(e));
    common = common.filter((x) => set.has(x));
  }
  const candidate = common.find((el) => {
    if (el === document.body || el === document.documentElement) return false;
    let position = '';
    try {
      position = window.getComputedStyle(el).position;
    } catch {
      position = '';
    }
    const role = el.getAttribute ? el.getAttribute('role') : null;
    const idc = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    return (
      position === 'fixed' ||
      position === 'sticky' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      BANNER_RE.test(idc) ||
      el.tagName === 'IFRAME'
    );
  });
  if (!candidate) return { box: null, reason: 'no-unique-container' };
  const r = candidate.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(vw, r.x + r.width) - x;
  const height = Math.min(vh, r.y + r.height) - y;
  if (width <= 0 || height <= 0) return { box: null, reason: 'container-off-screen' };
  return { box: { x, y, width, height }, reason: 'ok' };
}

/** One logged cookie write: names and places only, never the value. */
export interface RawCookieWrite {
  name: string;
  t: number;
  /** URL of the calling script (first stack frame), if any. */
  script: string | null;
  deletion: boolean;
  /** `location.hostname` of the document that wrote the cookie (a frame has its own); null for `about:blank` etc. */
  host: string | null;
  /** Parsed `Domain=` attribute (lower-case, no leading dot); null when the write has none. */
  domain: string | null;
}

/**
 * Init script: observe `document.cookie` writes (name and calling script only, never the value) so that transient
 * script cookies are seen and jar cookies can be attributed (`setter: script`). A cookie written by a script belongs
 * to the DOCUMENT it runs in (or to its `Domain=` attribute), not to the host the script was loaded from, so every
 * entry also carries the hostname of the document and the parsed `Domain=` attribute. Semantics are
 * unchanged.
 */
export function cookieHookInit(): void {
  const KEY = Symbol.for('dsgvo-check.cookie-writes');
  if (window[KEY]) return;
  const log: RawCookieWrite[] = [];
  const docHost = (): string | null => {
    try {
      const h = String(location.hostname || '').toLowerCase();
      return h || null;
    } catch {
      return null;
    }
  };
  const cleanDomain = (d: unknown): string | null => {
    const v = String(d || '')
      .trim()
      .replace(/^\.+/, '')
      .toLowerCase()
      .slice(0, 253);
    return /^[a-z0-9.-]+$/.test(v) && v !== '' ? v : null;
  };
  Object.defineProperty(window, KEY, { value: log, enumerable: false });
  const proto = window.Document && window.Document.prototype;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'cookie') : null;
  if (!desc || !desc.set || !desc.get) return;
  const getter = desc.get;
  const setter = desc.set;
  Object.defineProperty(proto, 'cookie', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return getter.call(this);
    },
    set(v: unknown) {
      try {
        const s = String(v);
        const eq = s.indexOf('=');
        const name = eq > 0 ? s.slice(0, eq).trim() : '';
        if (name && log.length < 1000) {
          let script: string | null = null;
          const stack = String(new Error().stack || '');
          const m = stack.match(/https?:\/\/[^\s)]+?(?=:\d+:\d+)/g);
          if (m && m.length > 0) script = m[0] as string;
          const deletion = /;\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(s);
          // Attributes start after the first ";" (a cookie value cannot contain one), so the value is never scanned.
          const semi = s.indexOf(';');
          const dm = semi >= 0 ? /;\s*domain\s*=\s*([^;]*)/i.exec(s.slice(semi)) : null;
          log.push({
            name: name.slice(0, 200),
            t: Date.now(),
            script,
            deletion,
            host: docHost(),
            domain: dm ? cleanDomain(dm[1]) : null,
          });
        }
      } catch {
        // never break the page
      }
      return setter.call(this, v);
    },
  });
  // Async Cookie Store API (`cookieStore.set`) writes bypass `document.cookie`: log their names too.
  const cs = window.CookieStore && window.CookieStore.prototype;
  const csSet = cs && typeof cs.set === 'function' ? cs.set : null;
  if (csSet) {
    cs.set = function (this: unknown, ...args: any[]) {
      try {
        const a = args[0];
        const name = typeof a === 'string' ? a : a && typeof a.name === 'string' ? a.name : '';
        if (name && log.length < 1000) {
          let script: string | null = null;
          const m = String(new Error().stack || '').match(/https?:\/\/[^\s)]+?(?=:\d+:\d+)/g);
          if (m && m.length > 0) script = m[0] as string;
          log.push({
            name: String(name).slice(0, 200),
            t: Date.now(),
            script,
            deletion: false,
            host: docHost(),
            domain: a && typeof a === 'object' ? cleanDomain(a.domain) : null,
          });
        }
      } catch {
        // never break the page
      }
      return csSet.apply(this, args);
    };
  }
}

/** Read the cookie-write log of this frame (names, places and times only). */
export function cookieWritesInPage(): RawCookieWrite[] {
  const log = window[Symbol.for('dsgvo-check.cookie-writes')];
  return Array.isArray(log) ? log.slice() : [];
}

/**
 * Init script: log Web Storage writes (`setItem`: storage type, key and time — never the value) so that a key that
 * existed before the B/C click and is written again after it is seen as a write after the click.
 */
export function storageHookInit(): void {
  const KEY = Symbol.for('dsgvo-check.storage-writes');
  if (window[KEY]) return;
  const log: Array<{ type: 'localStorage' | 'sessionStorage'; key: string; t: number }> = [];
  Object.defineProperty(window, KEY, { value: log, enumerable: false });
  const proto = window.Storage && window.Storage.prototype;
  const setItem = proto && typeof proto.setItem === 'function' ? proto.setItem : null;
  if (!setItem) return;
  proto.setItem = function (this: unknown, k: unknown, v: unknown) {
    try {
      if (log.length < 2000) {
        let local: unknown = null;
        try {
          local = window.localStorage;
        } catch {
          local = null;
        }
        log.push({
          type: this === local ? 'localStorage' : 'sessionStorage',
          key: String(k).slice(0, 200),
          t: Date.now(),
        });
      }
    } catch {
      // never break the page
    }
    return setItem.call(this, k, v);
  };
}

/** Read the storage-write log of this frame (keys and times only). */
export function storageWritesInPage(): Array<{
  type: 'localStorage' | 'sessionStorage';
  key: string;
  t: number;
}> {
  const log = window[Symbol.for('dsgvo-check.storage-writes')];
  return Array.isArray(log) ? log.slice() : [];
}

/**
 * Init script: epoch ms of trusted pointer presses (capture phase, registered before any page script). The moment of
 * the CMP click is the first press after the collector armed the click — not the moment the adapter was called
 * Requests started while the adapter still classified and waited for the button are not "after the click".
 */
export function inputHookInit(): void {
  const KEY = Symbol.for('dsgvo-check.input-events');
  if (window[KEY]) return;
  const log: number[] = [];
  Object.defineProperty(window, KEY, { value: log, enumerable: false });
  const onPress = (e: any) => {
    try {
      if (e && e.isTrusted && log.length < 200) log.push(Date.now());
    } catch {
      // never break the page
    }
  };
  try {
    window.addEventListener('pointerdown', onPress, { capture: true, passive: true });
    window.addEventListener('mousedown', onPress, { capture: true, passive: true });
  } catch {
    // no window events (e.g. opaque frame)
  }
}

/** Epoch ms of trusted presses seen by this frame. */
export function inputEventsInPage(): number[] {
  const log = window[Symbol.for('dsgvo-check.input-events')];
  return Array.isArray(log) ? log.slice() : [];
}
