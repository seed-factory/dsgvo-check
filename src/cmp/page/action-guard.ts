import type { DDocument, DElement, DNode, DQueryRoot } from './dom.ts';

interface ActionElement extends DElement {
  isConnected: boolean;
  value?: string;
  labels?: ArrayLike<DElement>;
}

interface ActionEvent {
  type: string;
  isTrusted: boolean;
  composedPath(): unknown[];
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

interface GuardArgs {
  binding: string;
  token: string;
  submitter: string;
}

type Guard = (element: unknown, args: GuardArgs) => () => boolean;

interface ActionWindow {
  document: DDocument;
  Element: { prototype: DElement };
  HTMLElement: { prototype: ActionElement };
  Node: { prototype: DNode & Pick<DElement, 'getRootNode'> };
  Event: { new (type: string): ActionEvent; prototype: ActionEvent };
  EventTarget: { prototype: { dispatchEvent(event: ActionEvent): boolean } };
  addEventListener(type: string, listener: (event: ActionEvent) => void, capture: boolean): void;
  __dsgvoArmClick?: Guard;
}

export function clickGuardInit(): void {
  const w = globalThis as unknown as ActionWindow;
  const doc = w.document;
  const apply = Reflect.apply;
  const serialize = JSON.stringify;
  const hasPrototype = Object.prototype.isPrototypeOf;
  const some = Array.prototype.some;
  const includes = Array.prototype.includes;
  const elementPrototype = w.Element.prototype;
  const htmlPrototype = w.HTMLElement.prototype;
  const matches = elementPrototype.matches;
  const getAttribute = elementPrototype.getAttribute;
  const getRootNode = w.Node.prototype.getRootNode;
  const textContent = Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent')?.get;
  const renderedText = Object.getOwnPropertyDescriptor(htmlPrototype, 'innerText')?.get;
  const getElementById = doc.getElementById.bind(doc);
  const { composedPath, preventDefault, stopImmediatePropagation } = w.Event.prototype;
  const dispatchEvent = w.EventTarget.prototype.dispatchEvent;
  const NativeEvent = w.Event;
  const readinessType = 'dsgvo-click-guard-ready';
  let readinessEvent: ActionEvent | null = null;
  w.addEventListener(
    readinessType,
    (event) => {
      if (event !== readinessEvent) return;
      readinessEvent = null;
      apply(stopImmediatePropagation, event, []);
    },
    true,
  );
  const interactive =
    'button, a[href], input, label, summary, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"]';

  const attr = (node: DElement, name: string) => apply(getAttribute, node, [name]);
  const hasTag = (node: unknown, selector: string): boolean =>
    apply(hasPrototype, elementPrototype, [node]) && apply(matches, node, [selector]);

  const text = (node: DElement | null) => {
    if (!node) return null;
    return [
      attr(node, 'id'),
      textContent ? apply(textContent, node, []) : null,
      renderedText && apply(hasPrototype, htmlPrototype, [node]) ? apply(renderedText, node, []) : null,
      attr(node, 'aria-label'),
    ];
  };

  let active: { input(event: ActionEvent): void; submit(event: ActionEvent): void } | null = null;
  const arm: Guard = (element, args) => {
    if (active) throw new Error('CMP click already armed');
    const probe = new NativeEvent(readinessType);
    readinessEvent = probe;
    apply(dispatchEvent, w, [probe]);
    const ready = readinessEvent === null;
    readinessEvent = null;
    if (!ready) throw new Error('CMP click guard unavailable');
    const el = element as ActionElement;
    const bindings = w as unknown as Record<string, (token: string) => Promise<void>>;
    const acknowledge = bindings[args.binding];

    const identity = () => {
      const ids = attr(el, 'aria-labelledby') ?? '';
      const root = apply(getRootNode, el, []) as DQueryRoot;
      const refs = ids
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => text((root === doc ? getElementById(id) : root.getElementById?.(id)) ?? null));
      return serialize([
        text(el),
        el.value,
        attr(el, 'type'),
        attr(el, 'form'),
        attr(el, 'role'),
        attr(el, 'aria-hidden'),
        attr(el, 'title'),
        attr(el, 'alt'),
        attr(el, 'href'),
        ids,
        refs,
        Array.from(el.labels ?? []).map(text),
      ]);
    };
    const original = identity();
    let activated = false;
    let refused = false;
    let started = false;

    const cancel = (event: ActionEvent) => {
      refused = true;
      apply(preventDefault, event, []);
      apply(stopImmediatePropagation, event, []);
    };

    const action = {
      input(event: ActionEvent) {
        if (!event.isTrusted) return;
        started = true;
        try {
          const path = apply(composedPath, event, []);
          const nested = apply(some, path, [(node: unknown) => node !== el && hasTag(node, interactive)]);
          if (
            refused ||
            nested ||
            !apply(includes, path, [el]) ||
            !el.isConnected ||
            hasTag(el, args.submitter) ||
            identity() !== original
          ) {
            cancel(event);
            return;
          }
        } catch {
          cancel(event);
          return;
        }
        if (event.type === 'click') {
          activated = true;
          void acknowledge?.(args.token).catch(() => undefined);
        }
      },
      submit(event: ActionEvent) {
        if (started) cancel(event);
      },
    };
    active = action;
    return () => {
      if (active === action) active = null;
      return activated && !refused;
    };
  };

  Object.defineProperty(w, '__dsgvoArmClick', { value: arm });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    w.addEventListener(type, (event) => active?.input(event), true);
  }
  w.addEventListener('submit', (event) => active?.submit(event), true);
}

export function armClickGuard(element: unknown, args: GuardArgs): () => boolean {
  const w = globalThis as unknown as ActionWindow;
  if (!w.__dsgvoArmClick) throw new Error('CMP click guard unavailable');
  return w.__dsgvoArmClick(element, args);
}
