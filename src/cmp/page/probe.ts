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
import type { BlockingMethod, ProbeArgs, ProbeResult, RawBlocking, RawButton } from './probe-types.ts';

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

  /** The element hides what overflows its box; the root and the body pass their overflow on to the viewport. */
  const clipsOverflow = (el: DElement, s: DStyle): boolean =>
    !['html', 'body'].includes(el.tagName.toLowerCase()) &&
    [s.overflow, s.overflowY].some((v) => /\b(hidden|clip)\b/.test(v ?? ''));

  const intersect = (a: Box, b: Box): Box => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
    };
  };

  /**
   * Whether an element in a box that clips its overflow lies wholly outside that box (or the box has no area): it is
   * not shown. A fixed element escapes the clip, a box-less one (`display: contents`) is judged by its children.
   */
  const clippedAway = (el: DElement, s: DStyle, clip: Box | null): boolean => {
    if (!clip || s.position === 'fixed' || s.display === 'contents') return false;
    if (clip.width <= 0 || clip.height <= 0) return true;
    const r = rectOf(el);
    const shown = intersect(r, clip);
    return r.width > 0 && r.height > 0 && shown.width * shown.height === 0;
  };

  /**
   * `all`: every text node; `visible`: what is shown on screen, also under `aria-hidden` (a description hidden from
   * screen readers is still read by the visitor), without content folded in a closed `<details>` or clipped away by a
   * box that hides its overflow (a collapsed vendor list); `accessible`: what assistive technology reads.
   */
  type TextMode = 'all' | 'visible' | 'accessible';
  const textOf = (node: DNode, mode: TextMode, depth = 0, outerClip: Box | null = null): string => {
    if (depth > MAX_TEXT_DEPTH) return '';

    // The element whose text is read may clip its own overflow.
    const clip =
      outerClip ??
      (mode === 'visible' && depth === 0 && isElement(node) && clipsOverflow(node, style(node))
        ? rectOf(node)
        : null);
    const folded =
      mode !== 'all' && isElement(node) && node.tagName.toLowerCase() === 'details' && !node.open;
    let out = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as DNode;
      if (child.nodeType === 3) {
        if (!folded) out += child.textContent ?? '';
        continue;
      }
      if (!isElement(child)) continue;

      const tag = child.tagName.toLowerCase();
      if (NON_CONTENT_TAGS.includes(tag) || (folded && tag !== 'summary')) continue;

      const s = style(child);
      if (mode === 'accessible' && child.getAttribute('aria-hidden') === 'true') continue;
      if (mode !== 'all' && (s.display === 'none' || s.visibility === 'hidden')) continue;
      if (mode === 'visible' && clippedAway(child, s, clip)) continue;
      if (tag === 'img') {
        out += ` ${child.getAttribute('alt') ?? ''} `;
        continue;
      }

      let childClip = s.position === 'fixed' ? null : clip;
      if (mode === 'visible' && clipsOverflow(child, s))
        childClip = childClip ? intersect(childClip, rectOf(child)) : rectOf(child);
      const inner =
        textOf(child, mode, depth + 1, childClip) +
        (child.shadowRoot ? ` ${textOf(child.shadowRoot, mode, depth + 1, childClip)}` : '');
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
        .map((e) => textOf(e, 'all'));
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

    const t = clean(textOf(el, 'accessible'));
    if (t) return t;

    return clean(el.getAttribute('title') ?? '');
  };

  /**
   * The rules for names (`args.names`); a pattern that does not compile makes nothing a name. The Node side applies the
   * same rules again, since the page can change what this code returns.
   */
  const compileRule = (p: { source: string; flags: string }): RegExp | null => {
    try {
      return new RegExp(p.source, p.flags);
    } catch {
      return null;
    }
  };
  const nameCharsRe = compileRule(args.names.chars);
  const notNameRes = args.names.notName.map(compileRule);
  const tagNameRe = compileRule(args.names.tag);
  const idLike = args.names.idLike;
  const otherDigitRe = compileRule(idLike.otherDigit);
  const separatorRe = compileRule(idLike.separator);
  const compactRes = idLike.compact.map(compileRule);
  const plainRes = idLike.plain.map(compileRule);
  const tokenRe = compileRule(idLike.token);
  const tokenSplitRe = compileRule(idLike.tokenSplit);
  const wordRe = compileRule(idLike.word);
  const wordsWithGroupRe = compileRule(idLike.wordsWithGroup);

  /** The steps of `hasIdLikeRun` in page-names.ts; a rule that does not compile makes every value ID-like. */
  const hasIdLikeRun = (v: string): boolean => {
    if (!otherDigitRe || !separatorRe || !tokenRe || !tokenSplitRe || !wordRe || !wordsWithGroupRe)
      return true;
    if (!compactRes.every((re) => re !== null) || !plainRes.every((re) => re !== null)) return true;
    const n = v.normalize('NFKC').replace(otherDigitRe, '0');
    const compact = n.replace(separatorRe, '');
    if (compactRes.some((re) => re?.test(compact)) || plainRes.some((re) => re?.test(n))) return true;
    return (n.match(tokenRe) ?? []).some((run) => {
      const rest = run.split(tokenSplitRe).filter((part) => !wordRe.test(part));
      return rest.length > 1 || !rest.every((part) => wordsWithGroupRe.test(part));
    });
  };

  const hasNameSyntax = (v: string): boolean =>
    v.length > 0 &&
    v.length <= args.names.maxLength &&
    nameCharsRe?.test(v) === true &&
    notNameRes.every((re) => re !== null && !re.test(v));

  /**
   * A value a stored selector may carry. The page chooses ids, classes and attribute values, so one with query or
   * address syntax, whitespace, an invisible or look-alike character or a run that looks like an ID or a token is left
   * out of the selector.
   */
  const isNameLike = (v: string): boolean =>
    hasNameSyntax(v) && hasNameSyntax(v.normalize('NFKC')) && !hasIdLikeRun(v);

  const UNKNOWN_TAG = 'unknown';
  /** The element's tag name when it reads as one (`button`, `uc-button`); the HTML parser takes almost any name. */
  const tagOf = (el: DElement): string => {
    const t = el.tagName.toLowerCase();
    return t.length <= args.names.tag.maxLength && tagNameRe?.test(t) && !hasIdLikeRun(t) ? t : UNKNOWN_TAG;
  };
  /** The tag as a CSS type selector; null for one that is no tag name or holds a `.`, which CSS reads as a class. */
  const selectorTag = (el: DElement): string | null => {
    const t = tagOf(el);
    return t !== UNKNOWN_TAG && /^[a-z][a-z0-9_-]*$/.test(t) ? t : null;
  };

  const ariaRoles = new Set(args.names.roles);
  /** The first token of `role` that names a role, as the browser reads it; else the element's implicit role. */
  const roleOf = (el: DElement): string => {
    for (const token of (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)) {
      if (ariaRoles.has(token)) return token;
    }

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
  const kindMatchers = {
    accept: matchersOf(args.kindPhrases?.accept),
    reject: matchersOf(args.kindPhrases?.reject),
    settings: matchersOf(args.kindPhrases?.settings),
    save: matchersOf(args.kindPhrases?.save),
  };
  const CONTROL_KINDS = ['accept', 'reject', 'settings', 'save'] as const;
  const phraseMatchers = CONTROL_KINDS.flatMap((k) => kindMatchers[k]);
  const choiceMatchers = [...kindMatchers.accept, ...kindMatchers.reject];
  const paidMatchers = matchersOf(args.paidPhrases);
  const acknowledgements = new Set(args.acknowledgePhrases ?? []);
  /** Accept phrases that give consent: an acknowledgement ("ok", "verstanden") only confirms a notice. */
  const consentAcceptMatchers = matchersOf(
    (args.kindPhrases?.accept ?? []).filter((p) => !acknowledgements.has(p)),
  );
  const explicitChoiceMatchers = [...consentAcceptMatchers, ...kindMatchers.reject];

  const hasPhrase = (tokens: string[], phrase: string[]): boolean => {
    outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
      for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
      return true;
    }
    return false;
  };

  /** An accessible name with more tokens is a text blob, not a control label. */
  const MAX_NAME_TOKENS = 12;

  const nameTokenCache = new Map<DElement, string[]>();
  /**
   * Tokens of the accessible name; for a text blob those of the visible label (an `aria-label` that describes the
   * button at length over "Alle akzeptieren"), empty when that is a text blob too.
   */
  const nameTokens = (el: DElement): string[] => {
    let tokens = nameTokenCache.get(el);
    if (!tokens) {
      const all = tokensOf(accName(el));
      const shown = all.length > MAX_NAME_TOKENS ? tokensOf(clean(textOf(el, 'visible'))) : all;
      tokens = shown.length > MAX_NAME_TOKENS ? [] : shown;
      nameTokenCache.set(el, tokens);
    }
    return tokens;
  };

  const tokensMatch = (tokens: string[], matchers: ReturnType<typeof matchersOf>): boolean =>
    tokens.length > 0 &&
    matchers.some((m) =>
      m.suffix !== null
        ? tokens.some((t) => t.endsWith(m.suffix as string))
        : m.tokens.length > 0 && hasPhrase(tokens, m.tokens),
    );

  /** The accessible name contains an accept/reject/settings/save phrase of the lexicon. */
  const isLexiconControl = (el: DElement): boolean => tokensMatch(nameTokens(el), phraseMatchers);

  /** The accessible name contains an accept or reject phrase of the lexicon (a real choice). */
  const isChoiceControl = (el: DElement): boolean => tokensMatch(nameTokens(el), choiceMatchers);

  /** A choice without subscription or payment wording: "Newsletter abonnieren und akzeptieren" is no consent choice. */
  const isUnpaidChoiceControl = (el: DElement): boolean =>
    isChoiceControl(el) && !tokensMatch(nameTokens(el), paidMatchers);

  /** An unpaid reject, or an accept that is more than an acknowledgement: "OK" under a shipping notice is no choice. */
  const isExplicitChoiceControl = (el: DElement): boolean =>
    tokensMatch(nameTokens(el), explicitChoiceMatchers) && !tokensMatch(nameTokens(el), paidMatchers);

  /**
   * Lexicon classes of a control in a dismissed candidate; `other` for a control without one, with subscription or
   * payment wording, or with an acknowledgement as its only accept phrase.
   */
  const controlKindsOf = (el: DElement): Array<(typeof CONTROL_KINDS)[number] | 'other'> => {
    const tokens = nameTokens(el);
    if (tokensMatch(tokens, paidMatchers)) return ['other'];
    const kinds = CONTROL_KINDS.filter((k) =>
      tokensMatch(tokens, k === 'accept' ? consentAcceptMatchers : kindMatchers[k]),
    );
    return kinds.length > 0 ? kinds : ['other'];
  };

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

  /**
   * Selectors from the id, the configured attributes and the class list, most specific first, only from values that are
   * names (`isNameLike`). An element whose tag is no CSS type name gets no tag-qualified selector.
   */
  const attributeSelectors = (el: DElement): string[] => {
    const tries: string[] = [];

    if (el.id && isNameLike(el.id)) tries.push(`#${esc(el.id)}`);

    const tag = selectorTag(el);
    if (!tag) return tries;

    for (const attr of args.selectorAttributes) {
      const v = el.getAttribute(attr);
      // A presence attribute (Borlabs `data-cookie-refuse`) has an empty value, which carries nothing.
      if (v !== null && (v === '' || isNameLike(v))) tries.push(`${tag}[${attr}="${v}"]`);
    }

    // A class token that is no name is left out (the others may still be unique), else the structural path is used.
    // HTML whitespace, not JS `\s`: a token with a no-break space and an address is one token to the browser.
    const cls = (el.getAttribute('class') ?? '')
      .split(/[ \t\n\f\r]+/)
      .filter(Boolean)
      .filter(isNameLike);
    if (cls.length > 0) tries.push(`${tag}.${cls.map(esc).join('.')}`);

    return tries;
  };

  const MAX_SELECTOR_PATH_DEPTH = 40;

  /**
   * `tag:nth-child(n)` segments up to the nearest ancestor with a unique id that is a name (or the root of this tree);
   * `*` for a tag that is no CSS type name.
   */
  const structuralPath = (el: DElement, count: (sel: string) => number): string => {
    const segs: string[] = [];
    let cur: DElement | null = el;
    for (let i = 0; cur && i < MAX_SELECTOR_PATH_DEPTH; i++) {
      if (cur.id && isNameLike(cur.id) && count(`#${esc(cur.id)}`) === 1) {
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
      segs.unshift(`${selectorTag(cur) ?? '*'}:nth-child(${idx})`);

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

  const cookieKeywordRes = (args.cookieKeywords ?? []).map((k) => {
    try {
      return new RegExp(k, 'giu');
    } catch {
      return null;
    }
  });
  const negationTokens = (args.negations ?? []).map((n) => n.split(' ')).filter((n) => n.length > 0);
  /** Characters before a cookie word read for a negation in front of it. */
  const NEGATION_LOOKBACK = 40;
  /** The text right before `at` ends with a negation ("keine Cookies", "no cookies"). */
  const negatedAt = (text: string, at: number): boolean => {
    const before = tokensOf(text.slice(Math.max(0, at - NEGATION_LOOKBACK), at));
    return negationTokens.some(
      (n) => n.length <= before.length && n.every((t, j) => before[before.length - n.length + j] === t),
    );
  };
  /**
   * The text names cookies themselves, not only privacy or tracking, at least once without a negation in front: "Wir
   * verwenden keine Cookies" tells that none are used.
   */
  const hasCookieWording = (text: string): boolean =>
    cookieKeywordRes.some((re) => !!re && [...text.matchAll(re)].some((m) => !negatedAt(text, m.index ?? 0)));

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
    keywordHitsOf(clean(textOf(body, 'visible'), FRAME_BODY_TEXT_CAP).toLowerCase());

  interface ContainerHit {
    el: DElement;
    count: number;
    selector: string | null;
    heuristic: ProbeResult['heuristic'];
  }

  const showsControl = (el: DElement): boolean => deepWithin(el, INTERACTIVE).some(isRendered);

  /**
   * The first container selector that matches, its shown matches first: rendered, or (box-less) showing a control, as
   * the probe judges a banner below. When it finds only hidden ones, a later selector may still find the dialog, but
   * only with a match that shows a control: a hidden copy an earlier, narrower selector finds (a template, a closed
   * second dialog) must not hide the open dialog, and a wrapper whose own box is all that shows of a closed dialog must
   * not pass for it.
   */
  const findBySelectors = (): ContainerHit | null => {
    let hidden: ContainerHit | null = null;
    for (const sel of args.containers) {
      const found = [...new Set(deepQueryAll(sel))];
      const first = found[0];
      if (!first) continue;

      const shown = found.filter((el) => (hidden ? showsControl(el) : isRendered(el) || showsControl(el)));
      if (shown[0]) return { el: shown[0], count: shown.length, selector: sel, heuristic: null };
      hidden ??= { el: first, count: found.length, selector: sel, heuristic: null };
    }
    return hidden;
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

  type Rejected = NonNullable<ProbeResult['rejectedCandidate']>['fact'];

  /** A banner shows on at least this share of the first screen, a dialog too (a 1 px dialog is screen-reader text). */
  const MIN_FLOATING_AREA_RATIO = 0.02;
  const MAX_STATIC_AREA_RATIO = 0.4;
  /** Hit points per side over the part of a candidate in the first screen. */
  const CANDIDATE_HIT_STEPS = 3;

  /**
   * A hit test on a grid over the part of the box in the first screen finds the element or one inside it: a box clipped
   * away (`clip`, `clip-path`) or covered by the opaque page is not shown. A box that takes no pointer events cannot
   * be hit tested and counts as shown.
   */
  const hitAnywhere = (el: DElement, box: Box): boolean => {
    if (style(el).pointerEvents === 'none') return true;
    const shown = intersect(box, { x: 0, y: 0, width: vw, height: vh });
    for (let i = 0; i < CANDIDATE_HIT_STEPS; i++) {
      for (let j = 0; j < CANDIDATE_HIT_STEPS; j++) {
        const x = shown.x + ((i + 0.5) * shown.width) / CANDIDATE_HIT_STEPS;
        const y = shown.y + ((j + 0.5) * shown.height) / CANDIDATE_HIT_STEPS;
        if (composedContains(el, deepElementFromPoint(x, y))) return true;
      }
    }
    return false;
  };
  /** A candidate whose text fills this cap is a page-sized container, not a banner. */
  const CANDIDATE_TEXT_CAP = 8000;
  const STATIC_NOTICE_MAX_TEXT = 1500;

  const containerNameRes = (args.bannerContainerNames ?? []).map((n) => {
    try {
      return new RegExp(n, 'iu');
    } catch {
      return null;
    }
  });
  /** The id or class names a banner container (test/data/cmp/probe.yaml). */
  const isNamedContainer = (el: DElement): boolean => {
    const names = `${el.id} ${el.getAttribute('class') ?? ''}`;
    return containerNameRes.some((re) => re?.test(names) === true);
  };

  /** Lexicon classes of the first controls outside navigation landmarks, in a fixed order. */
  const CANDIDATE_KIND_ORDER = [...CONTROL_KINDS, 'other'] as const;
  const candidateControls = (el: DElement, controlEls: DElement[]): Rejected['controls'] => {
    const kinds = new Set<string>();
    for (const c of controlEls.slice(0, MAX_CONTROLS_SCANNED)) {
      if (!inNavigation(c, el)) for (const k of controlKindsOf(c)) kinds.add(k);
    }
    return CANDIDATE_KIND_ORDER.filter((k) => kinds.has(k));
  };

  /**
   * A banner-shaped, rendered box with consent wording is taken (`candidate`) or dismissed with its features
   * (`rejected`); null for anything else.
   */
  const heuristicCandidate = (el: DElement): { candidate: Candidate } | { rejected: Rejected } | null => {
    const shape = bannerShape(el);
    if (!shape) return null;
    const { dialogish, fixed, staticCandidate, label } = shape;

    // Page chrome (a navigation landmark around the element, the element a header or footer, or a box inside one) needs
    // an accept or reject control (checked below): a sidebar or a menu drawer with privacy links is chrome, a cookie bar
    // marked up as <aside> or role="banner" is not.
    const chrome = pageChromeOf(el);
    const isChrome = chrome === 'navigation' || (chrome === 'section' && !dialogish);
    const inSection = chrome === 'inside-section' && !dialogish;

    if (!isRendered(el)) return null;
    const box = rectOf(el);
    const areaRatio = visibleArea(box) / Math.max(1, vw * vh);
    if (areaRatio < MIN_FLOATING_AREA_RATIO) return null;
    // A static notice must be a compact block that lies completely in the first screen.
    if (staticCandidate && (areaRatio > MAX_STATIC_AREA_RATIO || box.y < -1 || box.y + box.height > vh + 1))
      return null;
    if (!hitAnywhere(el, box)) return null;

    const rawText = clean(textOf(el, 'visible'), CANDIDATE_TEXT_CAP);
    if (rawText.length >= CANDIDATE_TEXT_CAP) return null;
    if (staticCandidate && rawText.length > STATIC_NOTICE_MAX_TEXT) return null;
    const wording = `${label} ${rawText}`.toLowerCase();
    const hits = keywordHitsOf(wording);
    if (hits.length === 0) return null;

    const controlEls = deepWithin(el, INTERACTIVE).filter(isRendered);
    const controls = controlEls.length;
    const named = isNamedContainer(el);
    const cookieWording = hasCookieWording(wording);
    const reject = (reason: Rejected['reason']) => ({
      rejected: {
        reason,
        keywordHits: hits.length,
        controls: candidateControls(el, controlEls),
        cookieWording,
        fixed,
        dialog: dialogish,
        named,
      },
    });
    const hasControl = (test: (c: DElement) => boolean) => hasControlOutsideNavigation(el, controlEls, test);

    // In the page chrome the control must be an accept or reject: a footer strip with settings links is chrome,
    // whatever its wording. A landmark itself is no candidate either, one inside a header or footer is kept.
    if (isChrome && !hasControl(isChoiceControl)) return null;
    if (inSection && !hasControl(isChoiceControl)) return reject('page-section');
    // One keyword is enough with the name of a banner, an explicit accept or reject, or cookie wording: in a dialog
    // alone, in a box with an acknowledgement ("Diese Website verwendet Cookies. [OK]"). A newsletter, login or age
    // dialog with a "Datenschutz" link is none.
    if (
      hits.length < 2 &&
      !named &&
      !hasControl(isExplicitChoiceControl) &&
      !(cookieWording && (dialogish || hasControl(isUnpaidChoiceControl)))
    )
      return reject('keywords');
    // A non-modal candidate must offer a choice: a control that the lexicon knows (navigation links do not count).
    if (!dialogish && phraseMatchers.length > 0 && !hasControl(isLexiconControl)) return reject('no-control');

    // A dialog weighs 2, a fixed box 1, up to 4 keyword hits count, and any control adds 1.
    const score = (dialogish ? 2 : 0) + (fixed ? 1 : 0) + Math.min(hits.length, 4) + (controls > 0 ? 1 : 0);
    const signals = [
      ...(dialogish ? ['heuristic:dialog'] : []),
      ...(fixed ? ['heuristic:fixed'] : []),
      ...(staticCandidate ? ['heuristic:static'] : []),
      ...(named ? ['heuristic:named'] : []),
      `heuristic:keywords:${hits.length}`,
      ...(controls > 0 ? [`heuristic:controls:${controls}`] : []),
    ];
    return { candidate: { el, score, area: areaRatio, signals } };
  };

  /**
   * Of the dismissed candidates the one most like a banner: outside the page chrome, named like a banner, with an
   * accept or reject, with any lexicon control, with cookie wording, then by keyword hits.
   */
  const rejectedRank = (r: Rejected): number =>
    (r.reason === 'page-section' ? 0 : 1000) +
    (r.named ? 100 : 0) +
    (r.controls.includes('accept') || r.controls.includes('reject')
      ? 20
      : r.controls.some((k) => k !== 'other')
        ? 10
        : 0) +
    (r.cookieWording ? 5 : 0) +
    Math.min(r.keywordHits, 4);

  /**
   * In a child frame the frame body itself may be the banner: wording of two keywords and a control the lexicon knows
   * (an embedded form with a privacy notice and "Absenden" is none).
   */
  const frameBodyCandidate = (): Candidate | null => {
    const body = frameBody();
    if (!body) return null;

    const hits = frameBodyHits(body);
    const controlEls = deepWithin(body, INTERACTIVE).filter(isRendered);
    const controls = controlEls.length;
    if (hits.length < 2 || !hasControlOutsideNavigation(body, controlEls, isLexiconControl)) return null;

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
  /**
   * Past the cap, the last elements of the document are scanned too: a banner is often appended at the end of a long
   * body, and one that floats between the points of the hit grid is found there.
   */
  const MAX_TAIL_ELEMENTS = 1500;
  const allElements = (): DElement[] => {
    const all: DElement[] = [];
    for (const root of [doc as DQueryRoot, ...shadowRoots]) {
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length && all.length < MAX_SCANNED_ELEMENTS; i++)
        all.push(list[i] as DElement);
    }
    const list = doc.querySelectorAll('*');
    for (let i = Math.max(MAX_SCANNED_ELEMENTS, list.length - MAX_TAIL_ELEMENTS); i < list.length; i++)
      all.push(list[i] as DElement);
    return all;
  };

  const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog';
  /** Safety cap of the dialogs and fixed boxes looked at before the capped scan. */
  const MAX_PRIORITY_ELEMENTS = 300;
  /** Hit points per side of the viewport, edges included: a thin bar at the bottom edge is hit too. */
  const PRIORITY_GRID_STEPS = 7;
  const EDGE_INSET_PX = 2;

  /**
   * Dialogs and the fixed or sticky boxes at the first screen (hit test, then their ancestors). A banner is often
   * appended at the end of a long body, past the cap of the scan in document order, so these come first.
   */
  const priorityElements = (): DElement[] => {
    const out = new Set<DElement>();
    for (const el of deepQueryAll(DIALOG_SELECTOR)) {
      if (out.size >= MAX_PRIORITY_ELEMENTS) return [...out];
      out.add(el);
    }

    const at = (i: number, size: number) =>
      Math.min(size - EDGE_INSET_PX, Math.max(EDGE_INSET_PX, (i * size) / (PRIORITY_GRID_STEPS - 1)));
    for (let i = 0; i < PRIORITY_GRID_STEPS; i++) {
      for (let j = 0; j < PRIORITY_GRID_STEPS; j++) {
        const hit = deepElementFromPoint(at(i, vw), at(j, vh));
        for (let c = hit, k = 0; c && k < MAX_ANCESTOR_STEPS; k++, c = parentEl(c)) {
          if (c === doc.body || c === doc.documentElement) break;
          if (out.size >= MAX_PRIORITY_ELEMENTS) return [...out];
          if (isFixedPosition(style(c))) out.add(c);
        }
      }
    }
    return [...out];
  };

  /**
   * The best candidate: higher score wins, the larger area breaks ties. Without one, the dismissed candidate most like
   * a banner is kept as a diagnostic.
   */
  const findByHeuristic = (): { hit: ContainerHit | null; rejected: ProbeResult['rejectedCandidate'] } => {
    let best: Candidate | null = null;
    let rejected: ProbeResult['rejectedCandidate'] = null;
    const seen = new Set<DElement>();
    for (const el of [...priorityElements(), ...allElements()]) {
      if (seen.has(el)) continue;
      seen.add(el);

      const found = heuristicCandidate(el);
      if (!found) continue;
      if ('rejected' in found) {
        const rank = rejectedRank(found.rejected);
        if (!rejected || rank > rejected.rank) rejected = { fact: found.rejected, rank, box: rectOf(el) };
        continue;
      }
      const { candidate } = found;
      if (
        !best ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.area > best.area)
      )
        best = candidate;
    }
    best ??= frameBodyCandidate();

    if (!best) return { hit: null, rejected };
    return {
      hit: { el: best.el, count: 1, selector: null, heuristic: { score: best.score, signals: best.signals } },
      rejected: null,
    };
  };

  const findContainer = (): { hit: ContainerHit | null; rejected: ProbeResult['rejectedCandidate'] } => {
    if (args.containerEl) {
      return {
        hit: { el: args.containerEl as DElement, count: 1, selector: null, heuristic: null },
        rejected: null,
      };
    }
    return args.mode === 'banner' ? { hit: findBySelectors(), rejected: null } : findByHeuristic();
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
      tag: tagOf(el),
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

      let result = clean(textOf(el, 'accessible'), BACKDROP_TEXT_SAMPLE).length < BACKDROP_MAX_TEXT;
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
  const scrollLockOf = (): { locked: boolean; method: BlockingMethod } | null => {
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
    const method: BlockingMethod[] = [];
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

  const notFoundResult = (rejected: ProbeResult['rejectedCandidate']): ProbeResult => {
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
      rejectedCandidate: rejected,
    };
  };

  /**
   * The group switches inside the container: on or off from `checked` of an input, else from `aria-checked` (null when
   * neither says), and whether the visitor can change it. A matched wrapper around another match (a `role="switch"`
   * around its input) is the same group, so only the innermost one counts. Hidden switches count as well: a group the
   * visitor cannot see is still saved with the layer.
   */
  const readSwitches = (root: DElement, sel: string): NonNullable<ProbeResult['switches']> => {
    let found: DElement[];
    try {
      found = [...new Set(deepWithin(root, sel))];
    } catch {
      return [];
    }
    const wrappers = new Set<DElement>();
    for (const el of found) {
      for (let c = parentEl(el), i = 0; c && c !== root && i < MAX_ANCESTOR_STEPS; c = parentEl(c), i++) {
        wrappers.add(c);
      }
    }
    const disabledMark = (c: DElement) =>
      c.getAttribute('aria-disabled') === 'true' ||
      (c.tagName.toLowerCase() === 'fieldset' && c.hasAttribute('disabled'));
    return found
      .filter((el) => !wrappers.has(el))
      .map((el) => {
        const input = el as DElement & { checked?: boolean; type?: string };
        const box =
          el.tagName.toLowerCase() === 'input' && (input.type === 'checkbox' || input.type === 'radio');
        const aria = el.getAttribute('aria-checked');
        return {
          checked: box ? input.checked === true : aria === 'true' ? true : aria === 'false' ? false : null,
          disabled: el.disabled === true || hasAncestor(el, disabledMark, MAX_ANCESTOR_STEPS),
        };
      });
  };

  const CONTAINER_TEXT_CAP = 20000;

  /** Every text node of the container (`all`), so the details a dialog keeps collapsed or hidden are read too. */
  const fullTextOf = (root: DElement, max: number): NonNullable<ProbeResult['fullText']> => {
    const all = textOf(root, 'all').replace(/\s+/g, ' ').trim();
    return { text: all.slice(0, max), truncated: all.length > max };
  };

  const { hit: container, rejected } = findContainer();
  if (!container) return notFoundResult(rejected);

  const root = container.el;
  const rootRendered = isRendered(root);
  const text = clean(textOf(root, 'visible'), CONTAINER_TEXT_CAP).toLowerCase();
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
    rejectedCandidate: null,
    ...(args.switches ? { switches: readSwitches(root, args.switches) } : {}),
    ...(args.fullTextMaxChars !== undefined ? { fullText: fullTextOf(root, args.fullTextMaxChars) } : {}),
  };
}
