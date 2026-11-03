/**
 * In-page measurement of a consent banner (runs via `frame.evaluate`). SELF-CONTAINED: no references outside the
 * function bodies (they are serialized into the page). Reads only; never clicks, never changes the DOM.
 *
 * Banner mode: container from vendor selectors (open shadow DOM included). Heuristic mode: best fixed/modal
 * candidate with consent wording (5.5: facts only, the verdict stays `info`).
 * Measured before any action: buttons (role, accessible name, box, rendered, in viewport, enabled, hit test,
 * contrast), blocking (overlay via grid hit test, scroll lock on html/body, inert, coveredRatio).
 */
import type { Box } from '../../core/snapshot-common.ts';
import type { DAnimation, DElement, DNode, DQueryRoot, DShadowRoot, DStyle, DWindow } from './dom.ts';
import type { ProbeArgs, ProbeResult, RawButton } from './probe-types.ts';

export function cmpPageProbe(args: ProbeArgs): ProbeResult {
  const w = globalThis as unknown as DWindow;
  const doc = w.document;
  const vw = w.innerWidth;
  const vh = w.innerHeight;
  const INTERACTIVE =
    'button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]';

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
  const composedContains = (anc: DElement, n: DElement | null): boolean => {
    let c: DElement | null = n;
    for (let i = 0; c && i < 2000; i++) {
      if (c === anc) return true;
      c = parentEl(c);
    }
    return false;
  };
  const clean = (s: string, max = 200): string => s.replace(/\s+/g, ' ').trim().slice(0, max);
  const safeMatches = (el: DElement, sel: string): boolean => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  };

  const shadowRoots: DShadowRoot[] = [];
  const collectShadows = (root: DQueryRoot) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length && shadowRoots.length < 200; i++) {
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
    let c: DElement | null = el;
    for (let i = 0; c && i < 60; i++) {
      if (Number(style(c).opacity) === 0) return false;
      c = parentEl(c);
    }
    return true;
  };
  const visibleArea = (b: Box): number => {
    const x1 = Math.max(0, b.x);
    const y1 = Math.max(0, b.y);
    const x2 = Math.min(vw, b.x + b.width);
    const y2 = Math.min(vh, b.y + b.height);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  };
  const deepElementFromPoint = (x: number, y: number): DElement | null => {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; el?.shadowRoot && i < 30; i++) {
      const inner: DElement | null = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const isFixed = (el: DElement): boolean => {
    let c: DElement | null = el;
    for (let i = 0; c && i < 60; i++) {
      const p = style(c).position;
      if (p === 'fixed' || p === 'sticky') return true;
      c = parentEl(c);
    }
    return false;
  };

  const textOf = (node: DNode, includeHidden: boolean, depth = 0): string => {
    if (depth > 40) return '';
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
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
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
  const nameMatches = (el: DElement, matchers: ReturnType<typeof matchersOf>): boolean => {
    const tokens = tokensOf(accName(el));
    if (tokens.length === 0 || tokens.length > 12) return false;
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
    for (let c: DElement | null = el, i = 0; c && c !== stop && i < 60; i++, c = parentEl(c)) {
      const t = c.tagName.toLowerCase();
      const r = (c.getAttribute('role') ?? '').toLowerCase();
      if (t === 'nav' || t === 'aside' || r === 'navigation' || r === 'complementary') return true;
    }
    return false;
  };
  /**
   * Page chrome. `navigation`: the element or an ancestor is a navigation landmark (nav, aside, role
   * navigation/complementary), always chrome. `section`: the element itself is a header/footer (role banner/
   * contentinfo), chrome for a non-dialog candidate. `inside-section`: an ancestor is one; a real banner may sit in a
   * footer or header partial, so the caller decides by whether the candidate offers an accept/reject control.
   * A true dialog may sit in a header or footer.
   */
  const pageChromeOf = (el: DElement): 'navigation' | 'section' | 'inside-section' | null => {
    let found: 'section' | 'inside-section' | null = null;
    for (let c: DElement | null = el, i = 0; c && i < 60; i++, c = parentEl(c)) {
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
  /** A finite animation or transition is running on the element's subtree or on one of its ancestors. */
  const animatingAround = (el: DElement): boolean => {
    const runningFinite = (a: DAnimation): boolean => {
      if (a.playState !== 'running' && a.playState !== 'pending') return false;
      try {
        return a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY;
      } catch {
        return true;
      }
    };
    for (let c: DElement | null = el, i = 0; c && i < 60; i++, c = parentEl(c)) {
      try {
        const list = c.getAnimations ? c.getAnimations(i === 0 ? { subtree: true } : undefined) : [];
        if (list.some(runningFinite)) return true;
      } catch {
        // no Web Animations
      }
    }
    return false;
  };

  const parseColor = (c: string): [number, number, number, number] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m?.[1]) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((x) => (x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x)));
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0] as number, p[1] as number, p[2] as number, p[3] ?? 1];
  };
  const blend = (
    top: [number, number, number, number],
    under: [number, number, number],
  ): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  const luminance = (rgb: [number, number, number]): number => {
    const ch = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
  };
  const contrastOf = (el: DElement): number | null => {
    const fg = parseColor(style(el).color);
    if (!fg) return null;
    const layers: Array<[number, number, number, number]> = [];
    let c: DElement | null = el;
    for (let i = 0; c && i < 60; i++) {
      const bg = parseColor(style(c).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
      c = parentEl(c);
    }
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--)
      base = blend(layers[i] as [number, number, number, number], base);
    const text = blend(fg, base);
    const l1 = luminance(text);
    const l2 = luminance(base);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 100) / 100;
  };

  const esc = (v: string): string => (w.CSS?.escape ? w.CSS.escape(v) : v.replace(/[^\w-]/g, '\\$&'));
  const uniqueIn = (el: DElement, root: DQueryRoot): string | null => {
    // A selector is good when it finds exactly this element: one match that is `el` itself. "One match" alone would
    // accept a selector that points at a neighbour.
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
    const tag = el.tagName.toLowerCase();
    const tries: string[] = [];
    // A value with an "@" may be an address (an aria-label "Fragen an name@firma.de", a class "kontakt-name@firma.de"):
    // no selector is built from it, the selector is stored in the snapshot. A class token with an
    // address is left out, the other tokens may still make the selector unique; otherwise the structural path below
    // is used.
    const plain = (v: string): boolean => !v.includes('@');
    if (el.id && plain(el.id)) tries.push(`#${esc(el.id)}`);
    for (const attr of [
      'data-testid',
      'data-action-type',
      'data-cookie-refuse',
      'data-cookie-accept-all',
      'data-role',
      'name',
      'aria-label',
    ]) {
      const v = el.getAttribute(attr);
      if (v !== null && v.length < 80 && plain(v) && !/[\n\r"\\]/.test(v))
        tries.push(`${tag}[${attr}="${v}"]`);
    }
    // The class attribute is split by the whitespace of HTML (space, tab, LF, FF, CR), not by JavaScript `\s`: a token
    // with a no-break space and an address is one token for the browser and is dropped as a whole.
    const cls = (el.getAttribute('class') ?? '')
      .split(/[ \t\n\f\r]+/)
      .filter(Boolean)
      .filter(plain);
    if (cls.length > 0) tries.push(`${tag}.${cls.map(esc).join('.')}`);
    for (const t of tries) if (isOnly(t)) return t;
    const segs: string[] = [];
    let cur: DElement | null = el;
    for (let i = 0; cur && i < 40; i++) {
      if (cur.id && plain(cur.id) && count(`#${esc(cur.id)}`) === 1) {
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
    const sel = segs.join(' > ');
    return sel && isOnly(sel) ? sel : null;
  };
  const selectorFor = (el: DElement): string | null => {
    const chain: string[] = [];
    let node: DElement = el;
    for (let i = 0; i < 10; i++) {
      const root = node.getRootNode() as DQueryRoot;
      const s = uniqueIn(node, root);
      if (!s) return null;
      chain.unshift(s);
      if (root.nodeType !== 11) break;
      node = (root as DShadowRoot).host;
    }
    return chain.join(' >> ');
  };

  let container: DElement | null = null;
  let containerCount = 0;
  let containerSelector: string | null = null;
  let heuristic: ProbeResult['heuristic'] = null;
  const keywordRes = args.keywords.map((k) => {
    try {
      return new RegExp(k, 'iu');
    } catch {
      return null;
    }
  });
  const keywordHitsOf = (text: string): string[] =>
    args.keywords.filter((_k, i) => keywordRes[i]?.test(text) === true);

  if (args.containerEl) {
    container = args.containerEl as DElement;
    containerCount = 1;
  } else if (args.mode === 'banner') {
    for (const sel of args.containers) {
      const found = [...new Set(deepQueryAll(sel))];
      if (found.length === 0) continue;
      const rendered = found.filter(isRendered);
      container = rendered[0] ?? found[0] ?? null;
      containerCount = rendered.length > 0 ? rendered.length : found.length;
      containerSelector = sel;
      break;
    }
  } else {
    let best: { el: DElement; score: number; area: number; signals: string[] } | null = null;
    const all: DElement[] = [];
    for (const root of [doc as DQueryRoot, ...shadowRoots]) {
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length && all.length < 6000; i++) all.push(list[i] as DElement);
    }
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (['html', 'body', 'head', 'script', 'style', 'link', 'meta', 'noscript', 'template'].includes(tag))
        continue;
      const role = (el.getAttribute('role') ?? '').toLowerCase();
      const dialogish =
        role === 'dialog' ||
        role === 'alertdialog' ||
        el.getAttribute('aria-modal') === 'true' ||
        (tag === 'dialog' && !!el.open);
      const pos = style(el).position;
      const fixed = pos === 'fixed' || pos === 'sticky';
      const label = clean(el.getAttribute('aria-label') ?? '', 120);
      // A static (not fixed) notice at the top of the page: a region or a labelled block about cookies.
      const staticCandidate =
        !dialogish &&
        !fixed &&
        !['main', 'article'].includes(tag) &&
        (role === 'region' || (label !== '' && keywordHitsOf(label.toLowerCase()).length > 0));
      if (!dialogish && !fixed && !staticCandidate) continue;
      // Page chrome (header/nav/footer/aside with a "Datenschutz" link, or anything inside a navigation) is no banner.
      // A candidate inside a header/footer is kept for now: it needs an accept/reject control (checked below).
      const chrome = pageChromeOf(el);
      if (chrome === 'navigation' || (chrome === 'section' && !dialogish)) continue;
      const inSection = chrome === 'inside-section' && !dialogish;
      if (!isRendered(el)) continue;
      const box = rectOf(el);
      const areaRatio = visibleArea(box) / Math.max(1, vw * vh);
      if (areaRatio === 0 || (!dialogish && areaRatio < 0.02)) continue;
      // A static notice must be a compact block that lies completely in the first screen.
      if (staticCandidate && (areaRatio > 0.4 || box.y < -1 || box.y + box.height > vh + 1)) continue;
      const rawText = clean(textOf(el, false), 8000);
      if (rawText.length >= 8000) continue; // a page-sized container, not a banner
      if (staticCandidate && rawText.length > 1500) continue;
      const hits = keywordHitsOf(`${label} ${rawText}`.toLowerCase());
      if (hits.length === 0 || (!dialogish && hits.length < 2)) continue;
      const controlEls = deepWithin(el, INTERACTIVE).filter(isRendered);
      const controls = controlEls.length;
      // A non-modal candidate must offer a choice: a control that the lexicon knows (navigation links do not count).
      if (
        !dialogish &&
        phraseMatchers.length > 0 &&
        !controlEls.slice(0, 80).some((c) => !inNavigation(c, el) && isLexiconControl(c))
      )
        continue;
      // Inside a header/footer landmark the control must be an accept or reject (a footer strip with settings links
      // is chrome); without choice phrases the landmark stays chrome.
      if (inSection && !controlEls.slice(0, 80).some((c) => !inNavigation(c, el) && isChoiceControl(c)))
        continue;
      const score = (dialogish ? 2 : 0) + (fixed ? 1 : 0) + Math.min(hits.length, 4) + (controls > 0 ? 1 : 0);
      const signals = [
        ...(dialogish ? ['heuristic:dialog'] : []),
        ...(fixed ? ['heuristic:fixed'] : []),
        ...(staticCandidate ? ['heuristic:static'] : []),
        `heuristic:keywords:${hits.length}`,
        ...(controls > 0 ? [`heuristic:controls:${controls}`] : []),
      ];
      if (!best || score > best.score || (score === best.score && areaRatio > best.area)) {
        best = { el, score, area: areaRatio, signals };
      }
    }
    if (!best && args.frameMode && doc.body && isRendered(doc.body)) {
      const hits = keywordHitsOf(clean(textOf(doc.body, false), 5000).toLowerCase());
      const controls = deepWithin(doc.body, INTERACTIVE).filter(isRendered).length;
      if (hits.length >= 2 && controls > 0) {
        best = {
          el: doc.body,
          score: Math.min(hits.length, 4) + 1,
          area: 1,
          signals: [
            'heuristic:frame-body',
            `heuristic:keywords:${hits.length}`,
            `heuristic:controls:${controls}`,
          ],
        };
      }
    }
    if (best) {
      container = best.el;
      containerCount = 1;
      heuristic = { score: best.score, signals: best.signals };
    }
  }

  const viewport = { width: vw, height: vh };
  if (!container) {
    return {
      found: false,
      containerCount: 0,
      visible: false,
      containerBox: null,
      containerFixed: false,
      containerSelector: null,
      textLength: 0,
      purAbo: false,
      // In a child frame the wording of its body is still a hint that the frame is a consent dialog.
      keywordHits:
        args.frameMode && doc.body && isRendered(doc.body)
          ? keywordHitsOf(clean(textOf(doc.body, false), 5000).toLowerCase())
          : [],
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
      heuristic,
    };
  }
  const root: DElement = container;
  const rootRendered = isRendered(root);
  const containerBox = rootRendered ? rectOf(root) : null;
  const text = clean(textOf(root, false), 20000).toLowerCase();
  const purAbo = args.purAbo.some((p) => {
    try {
      return new RegExp(p, 'iu').test(text);
    } catch {
      return false;
    }
  });

  const candidates = [...new Set(deepWithin(root, INTERACTIVE))];
  const candidateSet = new Set(candidates);
  const outermost = candidates.filter((el) => {
    let c = parentEl(el);
    for (let i = 0; c && c !== root && i < 60; i++) {
      if (candidateSet.has(c)) return false;
      c = parentEl(c);
    }
    return true;
  });
  // Keep the controls of the first layer when there are more than `maxButtons`: first those with a CMP markup role,
  // then every rendered control, then the rest (hidden second-layer toggles), each group in DOM order.
  const RANK_POOL = 2000;
  const ranked = outermost.slice(0, RANK_POOL).map((el, order) => {
    const vendor = args.vendorRoles.find((v) => safeMatches(el, v.selector)) ?? null;
    return { el, order, vendor, rank: vendor ? 0 : isRendered(el) ? 1 : 2 };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const kept = ranked.slice(0, args.maxButtons);
  // Dropped controls matter only when one of them could belong to the first layer (or was never looked at).
  const buttonsTruncated =
    outermost.length > RANK_POOL || ranked.slice(args.maxButtons).some((r) => r.rank < 2);
  kept.sort((a, b) => a.order - b.order);
  const buttons: RawButton[] = kept.map(({ el, vendor }) => {
    const rendered = isRendered(el);
    const box = rendered ? rectOf(el) : null;
    const cx = box ? box.x + box.width / 2 : -1;
    const cy = box ? box.y + box.height / 2 : -1;
    const inViewport = !!box && cx >= 0 && cy >= 0 && cx < vw && cy < vh;
    const visibleInViewport = !!box && visibleArea(box) > 0;
    const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
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
      vendorRole: vendor ? vendor.role : null,
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
  });

  // A `display: contents` (box-less) container still shows a banner when its controls render.
  const visible = rootRendered || buttons.some((b) => b.rendered);
  const containerFixed = visible && isFixed(root);

  const method: string[] = [];
  let overlay = false;
  let inert = false;
  const ancestors = new Set<DElement>();
  for (let c: DElement | null = root, i = 0; c && i < 80; i++, c = parentEl(c)) ancestors.add(c);
  // A full-viewport element counts as the banner's overlay when it belongs to the CMP's own subtree, or when it is
  // an empty backdrop (no text of its own) — never an app shell that holds the page content.
  const backdropCache = new Map<DElement, boolean>();
  const isOverlayOfBanner = (el: DElement): boolean => {
    const cached = backdropCache.get(el);
    if (cached !== undefined) return cached;
    let result = clean(textOf(el, false), 40).length < 20;
    let c: DElement | null = el;
    for (let i = 0; c && i < 80 && !result; i++) {
      if (ancestors.has(c)) {
        result = c !== doc.body && c !== doc.documentElement;
        break;
      }
      c = parentEl(c);
    }
    backdropCache.set(el, result);
    return result;
  };
  /** The hit element lies under a full-viewport backdrop that belongs to the banner. */
  const underOverlay = (hit: DElement): boolean => {
    let c: DElement | null = hit;
    for (let k = 0; c && k < 80 && c !== doc.body && c !== doc.documentElement; k++) {
      const pos = style(c).position;
      if (pos === 'fixed' || pos === 'absolute') {
        const r = c.getBoundingClientRect();
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9 && isOverlayOfBanner(c)) return true;
      }
      c = parentEl(c);
    }
    return false;
  };
  for (const sel of args.overlays) {
    for (const el of deepQueryAll(sel)) {
      if (isRendered(el) && visibleArea(rectOf(el)) >= 0.9 * vw * vh) {
        overlay = true;
        if (!method.includes('overlay-selector')) method.push('overlay-selector');
      }
    }
  }
  let modal = false;
  for (let c: DElement | null = root, i = 0; c && i < 80; i++, c = parentEl(c)) {
    if (c.tagName.toLowerCase() === 'dialog' && safeMatches(c, ':modal')) modal = true;
  }
  if (modal) {
    overlay = true;
    inert = true;
    method.push('dialog-modal');
  }
  const cols = 8;
  const rows = 6;
  let covered = 0;
  let overlayHits = 0;
  let total = 0;
  if (visible) {
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        total++;
        const hit = deepElementFromPoint(((i + 0.5) * vw) / cols, ((j + 0.5) * vh) / rows);
        if (!hit) continue;
        if (composedContains(root, hit)) {
          covered++;
          continue;
        }
        if (underOverlay(hit)) {
          covered++;
          overlayHits++;
        }
      }
    }
    method.push('grid-hit-test');
  }
  if (total > 0 && overlayHits >= total * 0.5) {
    overlay = true;
    method.push('overlay-grid');
  }
  const coveredRatio = total > 0 ? Math.round((covered / total) * 100) / 100 : null;
  const locked = (s: DStyle) => s.overflowY === 'hidden' || s.overflowY === 'clip';
  const html = doc.documentElement;
  const tallerThanViewport =
    Math.max(html.getBoundingClientRect().height, doc.body?.getBoundingClientRect().height ?? 0) > vh + 40;
  let scrollLock = false;
  if (visible) {
    if (locked(style(html)) || (doc.body && locked(style(doc.body)))) {
      scrollLock = tallerThanViewport;
      method.push(tallerThanViewport ? 'overflow-hidden' : 'overflow-hidden-short-page');
    } else if (doc.body && style(doc.body).position === 'fixed') {
      scrollLock = true;
      method.push('body-position-fixed');
    }
  }
  const inertEls = doc.querySelectorAll('[inert]');
  for (let i = 0; i < inertEls.length; i++) {
    const el = inertEls[i] as DElement;
    if (!composedContains(el, root) && !composedContains(root, el)) {
      inert = true;
      if (!method.includes('inert-attr')) method.push('inert-attr');
    }
  }
  let ariaModal = false;
  for (let c: DElement | null = root, i = 0; c && i < 80; i++, c = parentEl(c)) {
    if (c.getAttribute('aria-modal') === 'true') ariaModal = true;
  }

  // Links of the page (outside the banner) that are visible at the first screen and lie under the banner or its
  // backdrop: a hit test at the centre of each link, not the geometry of the container. Which of them are legal
  // links is not decided here.
  const coveredLinks: ProbeResult['coveredLinks'] = [];
  // At most this many are reported (a full-screen backdrop covers every link of the first screen). Kept inside the
  // function: the probe is serialized into the page and sees no module scope.
  const MAX_COVERED_LINKS = 200;
  if (visible) {
    for (const a of deepQueryAll('a[href], [role="link"]')) {
      if (coveredLinks.length >= MAX_COVERED_LINKS) break;
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
      if (name && name.length <= 80) coveredLinks.push({ label: name, box, coveredBy });
    }
  }

  return {
    found: true,
    containerCount,
    visible,
    containerBox,
    containerFixed,
    containerSelector,
    textLength: text.length,
    purAbo,
    keywordHits: keywordHitsOf(text),
    buttons,
    buttonsTruncated,
    animating: visible && animatingAround(root),
    blocking: { overlay, scrollLock, inert, coveredRatio, method, ariaModal },
    viewport,
    coveredLinks,
    heuristic,
  };
}
