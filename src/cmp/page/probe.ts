/**
 * In-page measurement of a consent banner (`frame.evaluate`). SELF-CONTAINED: the function is serialized into the page,
 * so every constant, type and helper it uses lives inside its body. Reads only; never clicks or changes the DOM.
 *
 * Inside: DOM helpers (shadow roots, geometry, text, accessible names), lexicon matching, page chrome, contrast,
 * selectors, then the steps of the probe (find the container, read its buttons, measure blocking, find covered links)
 * and the result. Constants sit above the helper that uses them; only those shared by several steps come first.
 */
import type { Box } from '../../core/snapshot/common.ts';
import type { DAnimation, DElement, DNode, DQueryRoot, DShadowRoot, DStyle, DWindow } from './dom.ts';
import type { ProbeArgs, ProbeResult, RawBlocking, RawButton } from './probe-types.ts';

export function cmpPageProbe(args: ProbeArgs): ProbeResult {
  const w = globalThis as unknown as DWindow;
  const doc = w.document;
  const vw = w.innerWidth;
  const vh = w.innerHeight;
  const viewport = { width: vw, height: vh };

  const INTERACTIVE =
    'button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]';

  /** Ancestor steps for style, landmark, animation and contrast checks of one element. */
  const MAX_ANCESTOR_STEPS = 60;
  /** Ancestor steps from the banner container (overlay, modal and aria-modal checks). */
  const MAX_BANNER_ANCESTOR_STEPS = 80;

  const styleCache = new Map<DElement, DStyle>();
  const style = (el: DElement): DStyle => {
    let s = styleCache.get(el);
    if (!s) {
      s = w.getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };

  const isElement = (n: DNode | null): n is DElement => !!n && n.nodeType === 1;

  const parentEl = (el: DElement): DElement | null => {
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode as DShadowRoot | null;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  };

  /** The element or one of its ancestors (through shadow hosts) satisfies the test. */
  const hasAncestor = (el: DElement, test: (c: DElement) => boolean, limit: number): boolean => {
    for (let c: DElement | null = el, i = 0; c && i < limit; i++, c = parentEl(c)) {
      if (test(c)) return true;
    }
    return false;
  };

  const MAX_COMPOSED_STEPS = 2000;
  const composedContains = (anc: DElement, n: DElement | null): boolean => {
    let c: DElement | null = n;
    for (let i = 0; c && i < MAX_COMPOSED_STEPS; i++) {
      if (c === anc) return true;
      c = parentEl(c);
    }
    return false;
  };

  const NAME_MAX_LENGTH = 200;
  const clean = (s: string, max = NAME_MAX_LENGTH): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

  const safeMatches = (el: DElement, sel: string): boolean => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  };

  const isFixedPosition = (s: DStyle): boolean => s.position === 'fixed' || s.position === 'sticky';

  /** Safety cap against huge pages. */
  const MAX_SHADOW_ROOTS = 200;
  const shadowRoots: DShadowRoot[] = [];
  const collectShadows = (root: DQueryRoot) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length && shadowRoots.length < MAX_SHADOW_ROOTS; i++) {
      const sr = (all[i] as DElement).shadowRoot;
      if (sr) {
        shadowRoots.push(sr);
        collectShadows(sr);
      }
    }
  };
  collectShadows(doc);

  const deepQueryAll = (sel: string): DElement[] => {
    const out: DElement[] = [];
    for (const root of [doc as DQueryRoot, ...shadowRoots]) {
      try {
        const list = root.querySelectorAll(sel);
        for (let i = 0; i < list.length; i++) out.push(list[i] as DElement);
      } catch {
        return out;
      }
    }
    return out;
  };

  const deepWithin = (el: DElement, sel: string): DElement[] => {
    const out: DElement[] = [];
    const roots: DQueryRoot[] = [el];
    if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const sr of shadowRoots) if (sr !== el.shadowRoot && composedContains(el, sr.host)) roots.push(sr);

    for (const root of roots) {
      const list = root.querySelectorAll(sel);
      for (let i = 0; i < list.length; i++) out.push(list[i] as DElement);
    }
    return out;
  };

  const rectOf = (el: DElement): Box => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  const isRendered = (el: DElement): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;

    const s = style(el);
    if (s.visibility !== 'visible' || s.display === 'none') return false;

    return !hasAncestor(el, (c) => Number(style(c).opacity) === 0, MAX_ANCESTOR_STEPS);
  };

  const visibleArea = (b: Box): number => {
    const x1 = Math.max(0, b.x);
    const y1 = Math.max(0, b.y);
    const x2 = Math.min(vw, b.x + b.width);
    const y2 = Math.min(vh, b.y + b.height);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  };

  const MAX_POINT_SHADOW_HOPS = 30;
  const deepElementFromPoint = (x: number, y: number): DElement | null => {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; el?.shadowRoot && i < MAX_POINT_SHADOW_HOPS; i++) {
      const inner: DElement | null = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  const isFixed = (el: DElement): boolean =>
    hasAncestor(el, (c) => isFixedPosition(style(c)), MAX_ANCESTOR_STEPS);

  const MAX_TEXT_DEPTH = 40;
  const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template'];
  const textOf = (node: DNode, includeHidden: boolean, depth = 0): string => {
    if (depth > MAX_TEXT_DEPTH) return '';

    let out = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as DNode;
      if (child.nodeType === 3) {
        out += child.textContent ?? '';
        continue;
      }
      if (!isElement(child)) continue;

      const tag = child.tagName.toLowerCase();
      if (NON_CONTENT_TAGS.includes(tag)) continue;

      const s = style(child);
      if (!includeHidden) {
        if (child.getAttribute('aria-hidden') === 'true') continue;
        if (s.display === 'none' || s.visibility === 'hidden') continue;
      }
      if (tag === 'img') {
        out += ` ${child.getAttribute('alt') ?? ''} `;
        continue;
      }

      const inner =
        textOf(child, includeHidden, depth + 1) +
        (child.shadowRoot ? ` ${textOf(child.shadowRoot, includeHidden, depth + 1)}` : '');
      out += s.display.startsWith('inline') ? inner : ` ${inner} `;
    }
    return out;
  };

  const accName = (el: DElement): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode() as DQueryRoot;
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : null) ?? doc.getElementById(id))
        .filter((e): e is DElement => !!e)
        .map((e) => textOf(e, true));
      const t = clean(parts.join(' '));
      if (t) return t;
    }

    const label = clean(el.getAttribute('aria-label') ?? '');
    if (label) return label;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type === 'image') return clean(el.getAttribute('alt') ?? el.getAttribute('value') ?? '');
      const v = clean(el.value ?? el.getAttribute('value') ?? '');
      if (v) return v;
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
    }

    const t = clean(textOf(el, false));
    if (t) return t;

    return clean(el.getAttribute('title') ?? '');
  };

  const roleOf = (el: DElement): string => {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();

    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
    }
    return 'generic';
  };

  const tokensOf = (label: string): string[] =>
    label
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+|×/gu) ?? [];

  const matchersOf = (phrases: string[] | undefined) =>
    (phrases ?? []).map((p) =>
      p.startsWith('*')
        ? { suffix: p.slice(1), tokens: [] as string[] }
        : { suffix: null, tokens: p.split(' ') },
    );
  const phraseMatchers = matchersOf(args.controlPhrases);
  const choiceMatchers = matchersOf(args.choicePhrases);

  const hasPhrase = (tokens: string[], phrase: string[]): boolean => {
    outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
      for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
      return true;
    }
    return false;
  };

  /** An accessible name with more tokens is a text blob, not a control label. */
  const MAX_NAME_TOKENS = 12;
  const nameMatches = (el: DElement, matchers: ReturnType<typeof matchersOf>): boolean => {
    const tokens = tokensOf(accName(el));
    if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) return false;
    return matchers.some((m) =>
      m.suffix !== null
        ? tokens.some((t) => t.endsWith(m.suffix as string))
        : m.tokens.length > 0 && hasPhrase(tokens, m.tokens),
    );
  };

  /** The accessible name contains an accept/reject/settings/save phrase of the lexicon. */
  const isLexiconControl = (el: DElement): boolean => nameMatches(el, phraseMatchers);

  /** The accessible name contains an accept or reject phrase of the lexicon (a real choice). */
  const isChoiceControl = (el: DElement): boolean => nameMatches(el, choiceMatchers);

  const inNavigation = (el: DElement, stop: DElement | null): boolean => {
    for (
      let c: DElement | null = el, i = 0;
      c && c !== stop && i < MAX_ANCESTOR_STEPS;
      i++, c = parentEl(c)
    ) {
      const t = c.tagName.toLowerCase();
      const r = (c.getAttribute('role') ?? '').toLowerCase();
      if (t === 'nav' || t === 'aside' || r === 'navigation' || r === 'complementary') return true;
    }
    return false;
  };

  /**
   * `navigation`: nav/aside landmark on the element or an ancestor, always chrome. `section`: the element is a header or
   * footer, chrome unless a dialog. `inside-section`: the caller decides, since a banner may sit in a footer partial.
   */
  const pageChromeOf = (el: DElement): 'navigation' | 'section' | 'inside-section' | null => {
    let found: 'section' | 'inside-section' | null = null;
    for (let c: DElement | null = el, i = 0; c && i < MAX_ANCESTOR_STEPS; i++, c = parentEl(c)) {
      const t = c.tagName.toLowerCase();
      const r = (c.getAttribute('role') ?? '').toLowerCase();
      if (t === 'nav' || t === 'aside' || r === 'navigation' || r === 'complementary') return 'navigation';
      if (t === 'header' || t === 'footer' || r === 'banner' || r === 'contentinfo') {
        if (c === el) found = 'section';
        else found ??= 'inside-section';
      }
    }
    return found;
  };

  const animatingAround = (el: DElement): boolean => {
    const runningFinite = (a: DAnimation): boolean => {
      if (a.playState !== 'running' && a.playState !== 'pending') return false;
      try {
        return a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY;
      } catch {
        return true;
      }
    };

    for (let c: DElement | null = el, i = 0; c && i < MAX_ANCESTOR_STEPS; i++, c = parentEl(c)) {
      try {
        const list = c.getAnimations ? c.getAnimations(i === 0 ? { subtree: true } : undefined) : [];
        if (list.some(runningFinite)) return true;
      } catch {
        // no Web Animations
      }
    }
    return false;
  };

  type Rgba = [number, number, number, number];
  type Rgb = [number, number, number];

  const parseColor = (c: string): Rgba | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m?.[1]) return null;

    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((x) => (x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x)));
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0] as number, p[1] as number, p[2] as number, p[3] ?? 1];
  };

  const blend = (top: Rgba, under: Rgb): Rgb => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];

  const luminance = (rgb: Rgb): number => {
    const ch = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
  };

  const contrastOf = (el: DElement): number | null => {
    const fg = parseColor(style(el).color);
    if (!fg) return null;

    // Background layers from the element up to the first opaque one.
    const layers: Rgba[] = [];
    let c: DElement | null = el;
    for (let i = 0; c && i < MAX_ANCESTOR_STEPS; i++) {
      const bg = parseColor(style(c).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
      c = parentEl(c);
    }

    let base: Rgb = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i] as Rgba, base);

    const text = blend(fg, base);
    const l1 = luminance(text);
    const l2 = luminance(base);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 100) / 100;
  };

  const esc = (v: string): string => (w.CSS?.escape ? w.CSS.escape(v) : v.replace(/[^\w-]/g, '\\$&'));

  /** A value with an "@" may be an address: no selector is built from it, since selectors are stored in the snapshot. */
  const isPlain = (v: string): boolean => !v.includes('@');

  /** A selector attribute value longer than this is not used to build a selector. */
  const MAX_SELECTOR_VALUE_LENGTH = 80;

  /** Selectors from the id, the configured attributes and the class list, most specific first. */
  const attributeSelectors = (el: DElement): string[] => {
    const tag = el.tagName.toLowerCase();
    const tries: string[] = [];

    if (el.id && isPlain(el.id)) tries.push(`#${esc(el.id)}`);

    for (const attr of args.selectorAttributes) {
      const v = el.getAttribute(attr);
      if (v !== null && v.length < MAX_SELECTOR_VALUE_LENGTH && isPlain(v) && !/[\n\r"\\]/.test(v))
        tries.push(`${tag}[${attr}="${v}"]`);
    }

    // A class token with an address is left out (the others may still be unique), else the structural path is used.
    // HTML whitespace, not JS `\s`: a token with a no-break space and an address is one token to the browser.
    const cls = (el.getAttribute('class') ?? '')
      .split(/[ \t\n\f\r]+/)
      .filter(Boolean)
      .filter(isPlain);
    if (cls.length > 0) tries.push(`${tag}.${cls.map(esc).join('.')}`);

    return tries;
  };

  const MAX_SELECTOR_PATH_DEPTH = 40;

  /** `tag:nth-child(n)` segments up to the nearest ancestor with a unique id (or the root of this tree). */
  const structuralPath = (el: DElement, count: (sel: string) => number): string => {
    const segs: string[] = [];
    let cur: DElement | null = el;
    for (let i = 0; cur && i < MAX_SELECTOR_PATH_DEPTH; i++) {
      if (cur.id && isPlain(cur.id) && count(`#${esc(cur.id)}`) === 1) {
        segs.unshift(`#${esc(cur.id)}`);
        break;
      }

      const parentNode = cur.parentNode as DQueryRoot | null;
      if (!parentNode) break;

      const siblings = parentNode.children;
      let idx = 1;
      for (let k = 0; k < siblings.length; k++) {
        if (siblings[k] === cur) {
          idx = k + 1;
          break;
        }
      }
      segs.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);

      if (!isElement(parentNode)) break;
      cur = parentNode;
    }
    return segs.join(' > ');
  };

  const uniqueIn = (el: DElement, root: DQueryRoot): string | null => {
    // One match that is `el` itself; "one match" alone would accept a selector pointing at a neighbour.
    const isOnly = (sel: string): boolean => {
      try {
        const found = root.querySelectorAll(sel);
        return found.length === 1 && found[0] === el;
      } catch {
        return false;
      }
    };
    const count = (sel: string): number => {
      try {
        return root.querySelectorAll(sel).length;
      } catch {
        return 0;
      }
    };

    const direct = attributeSelectors(el).find(isOnly);
    if (direct) return direct;

    const path = structuralPath(el, count);
    return path && isOnly(path) ? path : null;
  };

  const MAX_SELECTOR_SHADOW_HOPS = 10;

  /** Selector for the element; steps through shadow roots are joined with ` >> `. */
  const selectorFor = (el: DElement): string | null => {
    const chain: string[] = [];
    let node: DElement = el;
    for (let i = 0; i < MAX_SELECTOR_SHADOW_HOPS; i++) {
      const root = node.getRootNode() as DQueryRoot;
      const s = uniqueIn(node, root);
      if (!s) return null;

      chain.unshift(s);
      if (root.nodeType !== 11) break;
      node = (root as DShadowRoot).host;
    }
    return chain.join(' >> ');
  };

  const keywordRes = args.keywords.map((k) => {
    try {
      return new RegExp(k, 'iu');
    } catch {
      return null;
    }
  });
  const keywordHitsOf = (text: string): string[] =>
    args.keywords.filter((_k, i) => keywordRes[i]?.test(text) === true);

  const isPurAbo = (text: string): boolean =>
    args.purAbo.some((p) => {
      try {
        return new RegExp(p, 'iu').test(text);
      } catch {
        return false;
      }
    });

  const FRAME_BODY_TEXT_CAP = 5000;

  /** In a child frame the wording of the frame body is a hint that the frame is a consent dialog. */
  const frameBody = (): DElement | null =>
    args.frameMode && doc.body && isRendered(doc.body) ? doc.body : null;
  const frameBodyHits = (body: DElement): string[] =>
    keywordHitsOf(clean(textOf(body, false), FRAME_BODY_TEXT_CAP).toLowerCase());

  interface ContainerHit {
    el: DElement;
    count: number;
    selector: string | null;
    heuristic: ProbeResult['heuristic'];
  }

  /** The first container selector that matches; rendered matches win over hidden ones. */
  const findBySelectors = (): ContainerHit | null => {
    for (const sel of args.containers) {
      const found = [...new Set(deepQueryAll(sel))];
      if (found.length === 0) continue;

      const rendered = found.filter(isRendered);
      const el = rendered[0] ?? found[0];
      if (!el) continue;
      return {
        el,
        count: rendered.length > 0 ? rendered.length : found.length,
        selector: sel,
        heuristic: null,
      };
    }
    return null;
  };

  /** Controls looked at per candidate when asking whether it offers a choice. */
  const MAX_CONTROLS_SCANNED = 80;

  /** Whether one of the element's first controls, outside navigation landmarks, passes the test. */
  const hasControlOutsideNavigation = (
    el: DElement,
    controlEls: DElement[],
    test: (c: DElement) => boolean,
  ): boolean => controlEls.slice(0, MAX_CONTROLS_SCANNED).some((c) => !inNavigation(c, el) && test(c));

  interface BannerShape {
    dialogish: boolean;
    fixed: boolean;
    staticCandidate: boolean;
    label: string;
  }

  const NON_BANNER_TAGS = ['html', 'body', 'head', 'script', 'style', 'link', 'meta', 'noscript', 'template'];
  const LABEL_MAX_LENGTH = 120;

  /** How the element could be a banner: a dialog, a fixed/sticky box or a static cookie notice; null for anything else. */
  const bannerShape = (el: DElement): BannerShape | null => {
    const tag = el.tagName.toLowerCase();
    if (NON_BANNER_TAGS.includes(tag)) return null;

    const role = (el.getAttribute('role') ?? '').toLowerCase();
    const dialogish =
      role === 'dialog' ||
      role === 'alertdialog' ||
      el.getAttribute('aria-modal') === 'true' ||
      (tag === 'dialog' && !!el.open);
    const fixed = isFixedPosition(style(el));
    const label = clean(el.getAttribute('aria-label') ?? '', LABEL_MAX_LENGTH);

    // A static (not fixed) notice at the top of the page: a region or a labelled block about cookies.
    const staticCandidate =
      !dialogish &&
      !fixed &&
      !['main', 'article'].includes(tag) &&
      (role === 'region' || (label !== '' && keywordHitsOf(label.toLowerCase()).length > 0));
    if (!dialogish && !fixed && !staticCandidate) return null;

    return { dialogish, fixed, staticCandidate, label };
  };

  interface Candidate {
    el: DElement;
    score: number;
    area: number;
    signals: string[];
  }

  const MIN_FLOATING_AREA_RATIO = 0.02;
  const MAX_STATIC_AREA_RATIO = 0.4;
  /** A candidate whose text fills this cap is a page-sized container, not a banner. */
  const CANDIDATE_TEXT_CAP = 8000;
  const STATIC_NOTICE_MAX_TEXT = 1500;

  const heuristicCandidate = (el: DElement): Candidate | null => {
    const shape = bannerShape(el);
    if (!shape) return null;
    const { dialogish, fixed, staticCandidate, label } = shape;

    // Page chrome is no banner; one inside a header/footer needs an accept/reject control (checked below).
    const chrome = pageChromeOf(el);
    if (chrome === 'navigation' || (chrome === 'section' && !dialogish)) return null;
    const inSection = chrome === 'inside-section' && !dialogish;

    if (!isRendered(el)) return null;
    const box = rectOf(el);
    const areaRatio = visibleArea(box) / Math.max(1, vw * vh);
    if (areaRatio === 0 || (!dialogish && areaRatio < MIN_FLOATING_AREA_RATIO)) return null;
    // A static notice must be a compact block that lies completely in the first screen.
    if (staticCandidate && (areaRatio > MAX_STATIC_AREA_RATIO || box.y < -1 || box.y + box.height > vh + 1))
      return null;

    const rawText = clean(textOf(el, false), CANDIDATE_TEXT_CAP);
    if (rawText.length >= CANDIDATE_TEXT_CAP) return null;
    if (staticCandidate && rawText.length > STATIC_NOTICE_MAX_TEXT) return null;
    const hits = keywordHitsOf(`${label} ${rawText}`.toLowerCase());
    if (hits.length === 0 || (!dialogish && hits.length < 2)) return null;

    const controlEls = deepWithin(el, INTERACTIVE).filter(isRendered);
    const controls = controlEls.length;
    // A non-modal candidate must offer a choice: a control that the lexicon knows (navigation links do not count).
    if (
      !dialogish &&
      phraseMatchers.length > 0 &&
      !hasControlOutsideNavigation(el, controlEls, isLexiconControl)
    )
      return null;
    // Inside a header/footer the control must be an accept or reject: a footer strip with settings links is chrome.
    if (inSection && !hasControlOutsideNavigation(el, controlEls, isChoiceControl)) return null;

    // A dialog weighs 2, a fixed box 1, up to 4 keyword hits count, and any control adds 1.
    const score = (dialogish ? 2 : 0) + (fixed ? 1 : 0) + Math.min(hits.length, 4) + (controls > 0 ? 1 : 0);
    const signals = [
      ...(dialogish ? ['heuristic:dialog'] : []),
      ...(fixed ? ['heuristic:fixed'] : []),
      ...(staticCandidate ? ['heuristic:static'] : []),
      `heuristic:keywords:${hits.length}`,
      ...(controls > 0 ? [`heuristic:controls:${controls}`] : []),
    ];
    return { el, score, area: areaRatio, signals };
  };

  /** In a child frame the frame body itself may be the banner: wording of two keywords and one control. */
  const frameBodyCandidate = (): Candidate | null => {
    const body = frameBody();
    if (!body) return null;

    const hits = frameBodyHits(body);
    const controls = deepWithin(body, INTERACTIVE).filter(isRendered).length;
    if (hits.length < 2 || controls === 0) return null;

    return {
      el: body,
      score: Math.min(hits.length, 4) + 1,
      area: 1,
      signals: [
        'heuristic:frame-body',
        `heuristic:keywords:${hits.length}`,
        `heuristic:controls:${controls}`,
      ],
    };
  };

  /** Safety cap against huge pages. */
  const MAX_SCANNED_ELEMENTS = 6000;
  const allElements = (): DElement[] => {
    const all: DElement[] = [];
    for (const root of [doc as DQueryRoot, ...shadowRoots]) {
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length && all.length < MAX_SCANNED_ELEMENTS; i++)
        all.push(list[i] as DElement);
    }
    return all;
  };

  /** The best candidate: higher score wins, the larger area breaks ties. */
  const findByHeuristic = (): ContainerHit | null => {
    let best: Candidate | null = null;
    for (const el of allElements()) {
      const candidate = heuristicCandidate(el);
      if (!candidate) continue;
      if (
        !best ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.area > best.area)
      )
        best = candidate;
    }
    best ??= frameBodyCandidate();

    if (!best) return null;
    return { el: best.el, count: 1, selector: null, heuristic: { score: best.score, signals: best.signals } };
  };

  const findContainer = (): ContainerHit | null => {
    if (args.containerEl) {
      return { el: args.containerEl as DElement, count: 1, selector: null, heuristic: null };
    }
    return args.mode === 'banner' ? findBySelectors() : findByHeuristic();
  };

  const describeButton = (el: DElement, vendorRole: string | null): RawButton => {
    const rendered = isRendered(el);
    const box = rendered ? rectOf(el) : null;
    const cx = box ? box.x + box.width / 2 : -1;
    const cy = box ? box.y + box.height / 2 : -1;
    const inViewport = !!box && cx >= 0 && cy >= 0 && cx < vw && cy < vh;
    const visibleInViewport = !!box && visibleArea(box) > 0;
    const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';

    // Whatever sits at the centre of the control must be the control or inside it.
    let hitTestOk = false;
    if (inViewport && style(el).pointerEvents !== 'none') {
      const hit = deepElementFromPoint(cx, cy);
      hitTestOk = !!hit && composedContains(el, hit);
    }

    const fs = Number.parseFloat(style(el).fontSize);
    const href = el.getAttribute('href');
    return {
      role: roleOf(el),
      name: accName(el),
      tag: el.tagName.toLowerCase(),
      vendorRole,
      box,
      rendered,
      visibleInViewport,
      inViewport,
      enabled,
      hitTestOk,
      actionable: rendered && enabled && inViewport && hitTestOk,
      contrast: rendered ? contrastOf(el) : null,
      fontSizePx: Number.isFinite(fs) ? fs : null,
      selector: selectorFor(el),
      inShadowDom: el.getRootNode().nodeType === 11,
      href: href && !href.startsWith('javascript:') ? href : null,
    };
  };

  /** Controls ranked before the `maxButtons` cut. */
  const RANK_POOL = 2000;

  /**
   * The controls of the container. Over `maxButtons`, the first layer is kept: first controls with a CMP markup role,
   * then every rendered control, then the rest (hidden second-layer toggles), each group in DOM order. `truncated`
   * says that a dropped control could belong to the first layer (or was never looked at).
   */
  const readButtons = (root: DElement): { buttons: RawButton[]; truncated: boolean } => {
    const candidates = [...new Set(deepWithin(root, INTERACTIVE))];
    const candidateSet = new Set(candidates);
    const outermost = candidates.filter((el) => {
      let c = parentEl(el);
      for (let i = 0; c && c !== root && i < MAX_ANCESTOR_STEPS; i++) {
        if (candidateSet.has(c)) return false;
        c = parentEl(c);
      }
      return true;
    });

    const ranked = outermost.slice(0, RANK_POOL).map((el, order) => {
      const vendor = args.vendorRoles.find((v) => safeMatches(el, v.selector)) ?? null;
      return { el, order, vendor, rank: vendor ? 0 : isRendered(el) ? 1 : 2 };
    });
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);

    const kept = ranked.slice(0, args.maxButtons);
    const truncated = outermost.length > RANK_POOL || ranked.slice(args.maxButtons).some((r) => r.rank < 2);
    kept.sort((a, b) => a.order - b.order);

    return {
      buttons: kept.map(({ el, vendor }) => describeButton(el, vendor ? vendor.role : null)),
      truncated,
    };
  };

  /** A box with at least this share of the viewport (per side, or in area) counts as full-viewport. */
  const FULL_VIEWPORT_SHARE = 0.9;
  /** A backdrop has no text of its own: under `BACKDROP_MAX_TEXT` characters among the first `BACKDROP_TEXT_SAMPLE`. */
  const BACKDROP_TEXT_SAMPLE = 40;
  const BACKDROP_MAX_TEXT = 20;

  /**
   * The test "is this hit element the banner's overlay": a full-viewport fixed or absolute element that belongs to the
   * CMP's own subtree, or an empty backdrop (no text of its own) — never an app shell that holds the page content.
   */
  const overlayTestFor = (root: DElement): ((hit: DElement) => boolean) => {
    const ancestors = new Set<DElement>();
    for (let c: DElement | null = root, i = 0; c && i < MAX_BANNER_ANCESTOR_STEPS; i++, c = parentEl(c))
      ancestors.add(c);

    const backdropCache = new Map<DElement, boolean>();
    const isOverlayOfBanner = (el: DElement): boolean => {
      const cached = backdropCache.get(el);
      if (cached !== undefined) return cached;

      let result = clean(textOf(el, false), BACKDROP_TEXT_SAMPLE).length < BACKDROP_MAX_TEXT;
      let c: DElement | null = el;
      for (let i = 0; c && i < MAX_BANNER_ANCESTOR_STEPS && !result; i++) {
        if (ancestors.has(c)) {
          result = c !== doc.body && c !== doc.documentElement;
          break;
        }
        c = parentEl(c);
      }
      backdropCache.set(el, result);
      return result;
    };

    return (hit) => {
      let c: DElement | null = hit;
      for (
        let k = 0;
        c && k < MAX_BANNER_ANCESTOR_STEPS && c !== doc.body && c !== doc.documentElement;
        k++
      ) {
        const pos = style(c).position;
        if (pos === 'fixed' || pos === 'absolute') {
          const r = c.getBoundingClientRect();
          if (
            r.width >= vw * FULL_VIEWPORT_SHARE &&
            r.height >= vh * FULL_VIEWPORT_SHARE &&
            isOverlayOfBanner(c)
          )
            return true;
        }
        c = parentEl(c);
      }
      return false;
    };
  };

  /** A rendered element that matches one of the CMP's overlay selectors and fills the viewport. */
  const hasOverlaySelectorMatch = (): boolean => {
    for (const sel of args.overlays) {
      for (const el of deepQueryAll(sel)) {
        if (isRendered(el) && visibleArea(rectOf(el)) >= FULL_VIEWPORT_SHARE * vw * vh) return true;
      }
    }
    return false;
  };

  const isModalDialog = (c: DElement): boolean =>
    c.tagName.toLowerCase() === 'dialog' && safeMatches(c, ':modal');

  const HIT_GRID_COLS = 8;
  const HIT_GRID_ROWS = 6;

  /** Hit test on a grid over the viewport: which points lie on the banner, which under its overlay. */
  const hitTestGrid = (root: DElement, underOverlay: (hit: DElement) => boolean) => {
    let total = 0;
    let covered = 0;
    let overlayHits = 0;
    for (let i = 0; i < HIT_GRID_COLS; i++) {
      for (let j = 0; j < HIT_GRID_ROWS; j++) {
        total++;
        const hit = deepElementFromPoint(((i + 0.5) * vw) / HIT_GRID_COLS, ((j + 0.5) * vh) / HIT_GRID_ROWS);
        if (!hit) continue;

        if (composedContains(root, hit)) {
          covered++;
        } else if (underOverlay(hit)) {
          covered++;
          overlayHits++;
        }
      }
    }
    return { total, covered, overlayHits };
  };

  const isOverflowLocked = (s: DStyle): boolean => s.overflowY === 'hidden' || s.overflowY === 'clip';

  /** A scroll-locked page counts as locked only when it is taller than the viewport by more than this. */
  const TALL_PAGE_MARGIN_PX = 40;

  /** `locked` is false for an overflow-hidden page that is not taller than the viewport (nothing to scroll anyway). */
  const scrollLockOf = (): { locked: boolean; method: string } | null => {
    const html = doc.documentElement;
    const body = doc.body;

    if (isOverflowLocked(style(html)) || (body && isOverflowLocked(style(body)))) {
      const tallest = Math.max(
        html.getBoundingClientRect().height,
        body?.getBoundingClientRect().height ?? 0,
      );
      const tall = tallest > vh + TALL_PAGE_MARGIN_PX;
      return { locked: tall, method: tall ? 'overflow-hidden' : 'overflow-hidden-short-page' };
    }
    if (body && style(body).position === 'fixed') return { locked: true, method: 'body-position-fixed' };
    return null;
  };

  /** An element marked `inert` that is neither the banner nor around it: the page behind is made unusable. */
  const hasInertOutside = (root: DElement): boolean => {
    const inertEls = doc.querySelectorAll('[inert]');
    for (let i = 0; i < inertEls.length; i++) {
      const el = inertEls[i] as DElement;
      if (!composedContains(el, root) && !composedContains(root, el)) return true;
    }
    return false;
  };

  /** Share of grid points under the banner's overlay that makes the overlay blocking. */
  const OVERLAY_GRID_SHARE = 0.5;

  const measureBlocking = (
    root: DElement,
    visible: boolean,
    underOverlay: (hit: DElement) => boolean,
  ): RawBlocking => {
    const method: string[] = [];
    let overlay = false;
    let inert = false;

    if (hasOverlaySelectorMatch()) {
      overlay = true;
      method.push('overlay-selector');
    }

    if (hasAncestor(root, isModalDialog, MAX_BANNER_ANCESTOR_STEPS)) {
      overlay = true;
      inert = true;
      method.push('dialog-modal');
    }

    const grid = visible ? hitTestGrid(root, underOverlay) : { total: 0, covered: 0, overlayHits: 0 };
    if (visible) method.push('grid-hit-test');
    if (grid.total > 0 && grid.overlayHits >= grid.total * OVERLAY_GRID_SHARE) {
      overlay = true;
      method.push('overlay-grid');
    }
    const coveredRatio = grid.total > 0 ? Math.round((grid.covered / grid.total) * 100) / 100 : null;

    let scrollLock = false;
    const lock = visible ? scrollLockOf() : null;
    if (lock) {
      scrollLock = lock.locked;
      method.push(lock.method);
    }

    if (hasInertOutside(root)) {
      inert = true;
      method.push('inert-attr');
    }

    const ariaModal = hasAncestor(
      root,
      (c) => c.getAttribute('aria-modal') === 'true',
      MAX_BANNER_ANCESTOR_STEPS,
    );

    return { overlay, scrollLock, inert, coveredRatio, method, ariaModal };
  };

  /** A full-screen backdrop covers every link of the first screen, so the list is capped. */
  const MAX_COVERED_LINKS = 200;
  const MAX_COVERED_LINK_LABEL = 80;

  /** Hit test at each link's centre, not the container geometry; which links are legal is decided on the Node side. */
  const findCoveredLinks = (
    root: DElement,
    underOverlay: (hit: DElement) => boolean,
  ): ProbeResult['coveredLinks'] => {
    const covered: ProbeResult['coveredLinks'] = [];
    for (const a of deepQueryAll('a[href], [role="link"]')) {
      if (covered.length >= MAX_COVERED_LINKS) break;
      if (composedContains(root, a)) continue;

      const box = rectOf(a);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      if (!isRendered(a)) continue;

      const hit = deepElementFromPoint(cx, cy);
      if (!hit || composedContains(a, hit)) continue;
      const coveredBy = composedContains(root, hit) ? 'banner' : underOverlay(hit) ? 'overlay' : null;
      if (!coveredBy) continue;

      const name = accName(a);
      if (name && name.length <= MAX_COVERED_LINK_LABEL) covered.push({ label: name, box, coveredBy });
    }
    return covered;
  };

  const notFoundResult = (): ProbeResult => {
    const body = frameBody();
    return {
      found: false,
      containerCount: 0,
      visible: false,
      containerBox: null,
      containerFixed: false,
      containerSelector: null,
      textLength: 0,
      purAbo: false,
      keywordHits: body ? frameBodyHits(body) : [],
      buttons: [],
      buttonsTruncated: false,
      animating: false,
      coveredLinks: [],
      blocking: {
        overlay: false,
        scrollLock: false,
        inert: false,
        coveredRatio: null,
        method: [],
        ariaModal: false,
      },
      viewport,
      heuristic: null,
    };
  };

  const CONTAINER_TEXT_CAP = 20000;

  const container = findContainer();
  if (!container) return notFoundResult();

  const root = container.el;
  const rootRendered = isRendered(root);
  const text = clean(textOf(root, false), CONTAINER_TEXT_CAP).toLowerCase();
  const { buttons, truncated } = readButtons(root);

  // A `display: contents` (box-less) container still shows a banner when its controls render.
  const visible = rootRendered || buttons.some((b) => b.rendered);

  const underOverlay = overlayTestFor(root);
  const blocking = measureBlocking(root, visible, underOverlay);
  const coveredLinks = visible ? findCoveredLinks(root, underOverlay) : [];

  return {
    found: true,
    containerCount: container.count,
    visible,
    containerBox: rootRendered ? rectOf(root) : null,
    containerFixed: visible && isFixed(root),
    containerSelector: container.selector,
    textLength: text.length,
    purAbo: isPurAbo(text),
    keywordHits: keywordHitsOf(text),
    buttons,
    buttonsTruncated: truncated,
    animating: visible && animatingAround(root),
    blocking,
    viewport,
    coveredLinks,
    heuristic: container.heuristic,
  };
}
