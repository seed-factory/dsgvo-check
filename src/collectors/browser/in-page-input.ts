// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
/** Init script and read of trusted presses, evaluated INSIDE the page. Self-contained (no references to module scope). */

declare const window: any;

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
