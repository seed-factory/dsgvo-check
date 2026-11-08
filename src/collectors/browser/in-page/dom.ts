// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/performance/useDomNodeTextContent: innerText is the rendered text we want
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
/** Evaluated INSIDE the page, self-contained: only names, lengths and structure, never cookie, storage or form values. */

declare const document: any;
declare const window: any;

export interface RawLink {
  href: string;
  attr: string;
  text: string;
  name: string;
  region: 'header' | 'nav' | 'main' | 'footer' | 'banner' | 'aside' | 'other';
  visible: boolean;
  inShadowDom: boolean;
  rel: string;
  hreflang: string;
}

export interface RawForm {
  action: string;
  method: string;
  visible: boolean;
  fieldCount: number;
  hasPasswordField: boolean;
  hasEmailField: boolean;
  /** Takes input other than a site search, by the rules the HTTP collector applies to markup. */
  takesInput: boolean;
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
  /** Includes links dropped by the `maxLinks` cap. */
  linksTotal: number;
  linksTruncated: boolean;
}

/** Regular-expression sources (case-insensitive in the page) from test/data/browser/dom.yaml; the page cannot import. */
export interface DomPatterns {
  /** id/class names of a consent banner container. */
  bannerNames: string;
  /** Text that makes a fixed `role=dialog` a banner. */
  bannerDialogText: string;
  /** Link texts and paths read first when the link cap applies. */
  legalLinkHints: string;
  /** Class names of two-click placeholders. */
  placeholderClass: string;
  /** Short text of a placeholder ("Karte laden"). */
  placeholderText: string;
  /** What a placeholder stands for, first match wins. */
  placeholderKinds: Array<{ kind: 'maps' | 'video'; source: string }>;
}

/** What a site search is (test/data/http/html.yaml) and the input types that carry nothing typed in. */
export interface FormRules {
  /** Source of the id/class pattern of a search form (case-insensitive). */
  searchForm: string;
  /** Lower-case `name` of a search field. */
  searchFieldNames: string[];
  /** Lower-case `type` of inputs that take no typed input (hidden, submit, search, …). */
  nonDataInputs: string[];
}

// DOM facts of the main document including open shadow roots. Links are capped at `maxLinks`; a plain cut loses the
// footer (Impressum, Datenschutz) on pages with a long article list, so a page over the cap is read in two passes:
// first the links that matter for legal and navigation checks (legal keywords, then `footer`, `banner`, `header`,
// `nav`; at most `2 * maxLinks`), then the rest in document order up to `maxLinks`.
export function domFactsInPage(arg: {
  maxLinks: number;
  maxScripts: number;
  maxPlaceholders: number;
  patterns: DomPatterns;
  forms: FormRules;
}): RawDomFacts {
  const MAX_SHADOW_DEPTH = 8;
  const LINK_PROBE_CHARS = 600;
  const TEXT_SAMPLE_CHARS = 4000;
  // Tags that can hold the short text of a two-click placeholder.
  const PLACEHOLDER_TEXT_TAGS = ['button', 'a', 'div', 'span', 'p'];
  const LINK_REL_RE = /(preconnect|dns-prefetch|preload|modulepreload|prefetch|prerender|stylesheet)/;

  const BANNER_RE = new RegExp(arg.patterns.bannerNames, 'i');
  const BANNER_TEXT_RE = new RegExp(arg.patterns.bannerDialogText, 'i');
  const PH_CLASS_RE = new RegExp(arg.patterns.placeholderClass, 'i');
  const PH_TEXT_RE = new RegExp(arg.patterns.placeholderText, 'i');
  const LEGAL_LINK_RE = new RegExp(arg.patterns.legalLinkHints, 'i');
  const PH_KINDS = arg.patterns.placeholderKinds.map((k) => ({
    kind: k.kind,
    re: new RegExp(k.source, 'i'),
  }));

  const clean = (s: string, max = 200) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const idAndClass = (el: any): string =>
    `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
  const parentOf = (n: any): any => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  };
  const inShadow = (el: any) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return Boolean(root && root.host);
  };
  const isFixed = (el: any): boolean => {
    try {
      const p = window.getComputedStyle(el).position;
      return p === 'fixed' || p === 'sticky';
    } catch {
      return false;
    }
  };
  const visible = (el: any): boolean => {
    try {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      // Unknown visibility counts as visible, like in the text walk: a dropped link would read as a missing one.
      return true;
    }
  };

  const isBannerContainer = (el: any): boolean => {
    if (BANNER_RE.test(idAndClass(el))) return true;
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (
      role === 'dialog' ||
      role === 'alertdialog' ||
      (el.getAttribute && el.getAttribute('aria-modal') === 'true')
    ) {
      return isFixed(el) && BANNER_TEXT_RE.test(el.textContent || '');
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

  const collectElements = (): any[] => {
    const found: any[] = [];
    const collect = (root: any, depth: number) => {
      if (depth > MAX_SHADOW_DEPTH) return;
      for (const el of root.querySelectorAll('*')) {
        found.push(el);
        if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
      }
    };
    collect(document, 0);
    return found;
  };

  const chooseLinks = (linkEls: any[]): Set<any> => {
    const chosen = new Set<any>();
    if (linkEls.length <= arg.maxLinks) {
      for (const el of linkEls) chosen.add(el);
      return chosen;
    }

    const legal: any[] = [];
    const footer: any[] = [];
    const navigation: any[] = [];
    const rest: any[] = [];
    for (const el of linkEls) {
      const probe = `${el.getAttribute('href') || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
      const region = regionOf(el);
      if (LEGAL_LINK_RE.test(probe.slice(0, LINK_PROBE_CHARS))) legal.push(el);
      else if (region === 'footer') footer.push(el);
      else if (region === 'banner' || region === 'header' || region === 'nav') navigation.push(el);
      else rest.push(el);
    }

    for (const el of [...legal, ...footer, ...navigation].slice(0, arg.maxLinks * 2)) chosen.add(el);
    let budget = arg.maxLinks - chosen.size;
    for (const el of rest) {
      if (budget <= 0) break;
      chosen.add(el);
      budget--;
    }
    return chosen;
  };

  /** Accessible name of a link: aria-label, aria-labelledby, title, then the alt text of an image inside. */
  const linkName = (el: any): string => {
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
    return name;
  };
  const readLink = (el: any): RawLink => {
    const text = clean(el.innerText || el.textContent || '');
    const name = linkName(el);
    return {
      href: String(el.href || ''),
      attr: String(el.getAttribute('href') || ''),
      text,
      name: name && name !== text ? name : '',
      region: regionOf(el),
      visible: visible(el),
      inShadowDom: inShadow(el),
      rel: String(el.getAttribute('rel') || ''),
      hreflang: String(el.getAttribute('hreflang') || ''),
    };
  };
  // The same test as the HTTP collector's on markup: not a site search, and a field one types into.
  const SEARCH_FORM_RE = new RegExp(arg.forms.searchForm, 'i');
  const SEARCH_FIELDS = new Set(arg.forms.searchFieldNames);
  const NON_DATA_INPUTS = new Set(arg.forms.nonDataInputs);
  const takesInput = (el: any): boolean => {
    if (String(el.getAttribute('role') || '').toLowerCase() === 'search') return false;
    if (SEARCH_FORM_RE.test(`${el.getAttribute('id') || ''} ${el.getAttribute('class') || ''}`)) return false;
    if (el.querySelector('textarea, select')) return true;
    const inputs = el.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i++) {
      const type = String(inputs[i].getAttribute('type') || 'text').toLowerCase();
      const name = String(inputs[i].getAttribute('name') || '').toLowerCase();
      if (!NON_DATA_INPUTS.has(type) && !SEARCH_FIELDS.has(name)) return true;
    }
    return false;
  };
  const readForm = (el: any): RawForm => {
    const fields = el.querySelectorAll('input:not([type=hidden]), select, textarea');
    return {
      action: String(el.getAttribute('action') === null ? '' : el.action || ''),
      method: String(el.getAttribute('method') || 'get').toLowerCase(),
      visible: visible(el),
      fieldCount: fields.length,
      hasPasswordField: Boolean(el.querySelector('input[type=password]')),
      hasEmailField: Boolean(el.querySelector('input[type=email], input[name*=mail i]')),
      takesInput: takesInput(el),
    };
  };
  const readIframe = (el: any): RawIframe => {
    const r = el.getBoundingClientRect();
    return {
      src: String(el.getAttribute('src') === null ? '' : el.src || ''),
      srcdoc: el.hasAttribute('srcdoc'),
      title: clean(el.getAttribute('title') || ''),
      visible: visible(el),
      box: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      loading: String(el.getAttribute('loading') || ''),
    };
  };
  const readScript = (el: any): RawDomFacts['scripts'][number] => {
    const src = el.getAttribute('src');
    return {
      src: src === null ? '' : String(el.src || ''),
      inline: src === null,
      type: String(el.getAttribute('type') || ''),
      async: el.hasAttribute('async'),
      defer: el.hasAttribute('defer'),
    };
  };

  /** A two-click placeholder ("Karte laden") by class name or by a short own text; null for any other element. */
  const readPlaceholder = (el: any, tag: string): RawDomFacts['placeholders'][number] | null => {
    const idc = idAndClass(el);
    let hit = PH_CLASS_RE.test(idc);
    if (!hit && PLACEHOLDER_TEXT_TAGS.includes(tag)) {
      const own = clean(el.innerText || '', 160);
      hit = own.length > 0 && own.length < 160 && PH_TEXT_RE.test(own) && el.children.length <= 3;
    }
    if (!hit) return null;

    const text = clean(el.innerText || '', 120);
    const probe = `${idc} ${text}`;
    const kind = PH_KINDS.find((k) => k.re.test(probe))?.kind ?? 'other';
    return { kind, text };
  };

  const all = collectElements();
  const linkEls = all.filter((el) => {
    const t = (el.tagName || '').toLowerCase();
    return (t === 'a' || t === 'area') && el.hasAttribute('href');
  });
  const chosenLinks = chooseLinks(linkEls);

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
      links.push(readLink(el));
    } else if (tag === 'form') {
      forms.push(readForm(el));
    } else if (tag === 'iframe' || tag === 'frame') {
      iframes.push(readIframe(el));
    } else if (tag === 'link' && el.hasAttribute('rel') && el.hasAttribute('href')) {
      const rel = String(el.getAttribute('rel') || '').toLowerCase();
      if (LINK_REL_RE.test(rel)) {
        linkRels.push({ rel, href: String(el.href || ''), as: String(el.getAttribute('as') || '') });
      }
    } else if (tag === 'script' && scripts.length < arg.maxScripts) {
      scripts.push(readScript(el));
    } else if (tag === 'meta' && /^refresh$/i.test(el.getAttribute('http-equiv') || '')) {
      metaRefresh = String(el.getAttribute('content') || '');
    }

    if (placeholders.length < arg.maxPlaceholders && tag !== 'script' && tag !== 'style') {
      const found = readPlaceholder(el, tag);
      if (found && !placeholders.some((p) => p.text === found.text && p.kind === found.kind)) {
        placeholders.push(found);
      }
    }
  }

  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const normalizedBodyText = bodyText.replace(/\s+/g, ' ').trim();
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
    visibleTextLength: normalizedBodyText.length,
    textSample: normalizedBodyText.slice(0, TEXT_SAMPLE_CHARS),
    placeholders,
    linksTotal: linkEls.length,
    linksTruncated: chosenLinks.size < linkEls.length,
  };
}

export interface RawScrollFacts {
  /** Height of the document in CSS px: the larger of the root's and the body's scroll height. */
  heightPx: number;
  scrollY: number;
  /** The root does not scroll (`overflow: hidden` or `clip`, also from the body): a visitor cannot scroll down. */
  locked: boolean;
}

/** How far the document reaches below the viewport, and whether a visitor could scroll there. */
export function scrollFactsInPage(): RawScrollFacts {
  const root = document.documentElement;
  const body = document.body;
  const overflowY = (el: any) =>
    el ? String(window.getComputedStyle(el).overflowY || 'visible') : 'visible';
  const clips = (value: string) => value === 'hidden' || value === 'clip';
  const rootOverflow = overflowY(root);
  // The body's overflow applies to the viewport only while the root's is `visible` (CSS overflow propagation).
  const locked = clips(rootOverflow) || (rootOverflow === 'visible' && clips(overflowY(body)));
  return {
    heightPx: Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0),
    scrollY: Math.max(0, Number(window.scrollY) || 0),
    locked,
  };
}
