/**
 * Minimal DOM typings for code that runs inside the page (`page.evaluate`). The project compiles without
 * `lib.dom`, and in-page functions must not reference anything outside their own body, so they cast
 * `globalThis` to these interfaces. Type-only module.
 */

export interface DRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface DStyle {
  display: string;
  visibility: string;
  opacity: string;
  position: string;
  zIndex: string;
  overflow: string;
  overflowY: string;
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  fontSize: string;
  pointerEvents: string;
}

export interface DNode {
  nodeType: number;
  parentNode: DNode | null;
  textContent: string | null;
  childNodes: ArrayLike<DNode>;
}

export interface DQueryRoot extends DNode {
  querySelectorAll(selector: string): ArrayLike<DElement>;
  querySelector(selector: string): DElement | null;
  getElementById?(id: string): DElement | null;
  children: ArrayLike<DElement>;
}

export interface DShadowRoot extends DQueryRoot {
  host: DElement;
  elementFromPoint(x: number, y: number): DElement | null;
}

export interface DAnimation {
  playState: string;
  effect: { getComputedTiming(): { iterations: number } } | null;
}

export interface DElement extends DQueryRoot {
  tagName: string;
  id: string;
  shadowRoot: DShadowRoot | null;
  parentElement: DElement | null;
  open?: boolean;
  disabled?: boolean;
  value?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(selector: string): boolean;
  closest(selector: string): DElement | null;
  getBoundingClientRect(): DRect;
  getAnimations?(options?: { subtree?: boolean }): DAnimation[];
  getRootNode(): DNode;
  getAttributeNames(): string[];
}

export interface DDocument extends DQueryRoot {
  documentElement: DElement;
  body: DElement | null;
  cookie: string;
  scripts: ArrayLike<DElement & { src: string }>;
  elementFromPoint(x: number, y: number): DElement | null;
  getElementById(id: string): DElement | null;
}

export interface DStorage {
  length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export interface DWindow {
  document: DDocument;
  innerWidth: number;
  innerHeight: number;
  location: { href: string; search: string };
  navigator: { userAgent: string; doNotTrack?: string | null };
  localStorage: DStorage;
  getComputedStyle(el: DElement): DStyle;
  CSS: { escape(value: string): string };
  performance: { getEntriesByType(type: string): ArrayLike<{ name: string }> };
}
