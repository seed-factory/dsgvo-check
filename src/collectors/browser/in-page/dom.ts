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

// DOM facts of the main document including open shadow roots. Links are capped at `maxLinks`; a plain cut loses the
// footer (Impressum, Datenschutz) on pages with a long article list, so a page over the cap is read in two passes:
// first the links that matter for legal and navigation checks (legal keywords, then `footer`, `banner`, `header`,
// `nav`; at most `2 * maxLinks`), then the rest in document order up to `maxLinks`.
export function domFactsInPage(arg: {
  maxLinks: number;
  maxScripts: number;
  patterns: DomPatterns;
}): RawDomFacts {
  const BANNER_RE = new RegExp(arg.patterns.bannerNames, 'i');
  const BANNER_TEXT_RE = new RegExp(arg.patterns.bannerDialogText, 'i');
  const PH_CLASS_RE = new RegExp(arg.patterns.placeholderClass, 'i');
  const PH_TEXT_RE = new RegExp(arg.patterns.placeholderText, 'i');
  const PH_KINDS = arg.patterns.placeholderKinds.map((k) => ({
    kind: k.kind,
    re: new RegExp(k.source, 'i'),
  }));

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
  const clean = (s: string, max = 200) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const inShadow = (el: any) => {
    const root = el.getRootNode ? el.getRootNode() : null;
    return Boolean(root && root.host);
  };

  const LEGAL_LINK_RE = new RegExp(arg.patterns.legalLinkHints, 'i');
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
        const kind = PH_KINDS.find((k) => k.re.test(probe))?.kind ?? 'other';
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

// Box of the banner container holding the first-layer points (button centres), measured without scrolling: the closest
// common ancestor that is fixed/sticky, a dialog, or named like a consent banner.
export function bannerBoxInPage(arg: { points: Array<{ x: number; y: number }>; bannerNames: string }): {
  box: { x: number; y: number; width: number; height: number } | null;
  reason: string;
} {
  const BANNER_RE = new RegExp(arg.bannerNames, 'i');
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
