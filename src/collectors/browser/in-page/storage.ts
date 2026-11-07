// biome-ignore-all lint/suspicious/noExplicitAny: in-page code runs in Chromium; tsconfig has no DOM lib
// biome-ignore-all lint/complexity/useOptionalChain: keep in-page code plain and defensive
// Cookie and Web Storage reads and init-script hooks, evaluated INSIDE the page (self-contained). They return names,
// lengths, places and times, never cookie or storage values.

declare const window: any;
declare const location: any;
declare const localStorage: any;
declare const sessionStorage: any;
declare const indexedDB: any;

export interface RawStorage {
  origin: string;
  local: Array<{ key: string; length: number }>;
  session: Array<{ key: string; length: number }>;
  idb: string[];
}

/** Keys, value LENGTHS and IndexedDB database names of this frame; no values. */
export async function storageInPage(arg: { maxKeys: number }): Promise<RawStorage> {
  const MAX_NAME_CHARS = 200;
  const out: RawStorage = { origin: String(location.origin), local: [], session: [], idb: [] };
  const read = (s: any, into: RawStorage['local']) => {
    for (let i = 0; i < s.length && into.length < arg.maxKeys; i++) {
      const k = s.key(i);
      if (k === null) continue;
      const v = s.getItem(k);
      into.push({ key: String(k).slice(0, MAX_NAME_CHARS), length: v === null ? 0 : String(v).length });
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
      for (const d of dbs) if (d && d.name) out.idb.push(String(d.name).slice(0, MAX_NAME_CHARS));
    }
  } catch {
    // opaque origin
  }
  return out;
}

/** Names and places only, never the value. */
export interface RawCookieWrite {
  name: string;
  t: number;
  script: string | null;
  deletion: boolean;
  /** Hostname of the writing document (a frame has its own); null for `about:blank`. */
  host: string | null;
  domain: string | null;
}

// Observes `document.cookie` writes (name and calling script only, never the value) so transient script cookies are
// seen and jar cookies can be attributed. A cookie belongs to the DOCUMENT the script runs in (or its `Domain=`), not
// to the script's host, so entries also carry the document hostname and the parsed `Domain=`.
export function cookieHookInit(): void {
  const KEY = Symbol.for('dsgvo-check.cookie-writes');
  if (window[KEY]) return;
  const MAX_WRITES = 1000;
  const MAX_NAME_CHARS = 200;
  const MAX_DOMAIN_CHARS = 253;
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
      .slice(0, MAX_DOMAIN_CHARS);
    return /^[a-z0-9.-]+$/.test(v) && v !== '' ? v : null;
  };
  /** The first http(s) URL of a stack is the script that wrote. */
  const scriptOf = (stack: string): string | null => {
    const m = stack.match(/https?:\/\/[^\s)]+?(?=:\d+:\d+)/g);
    return m && m.length > 0 ? (m[0] as string) : null;
  };
  /** One `document.cookie` assignment: name, deletion and `Domain=`; the value is not looked at. */
  const documentCookieWrite = (assignment: string, name: string, script: string | null): RawCookieWrite => {
    const deletion = /;\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(assignment);
    // Attributes start after the first ";" (a cookie value cannot contain one), so the value is never scanned.
    const semi = assignment.indexOf(';');
    const dm = semi >= 0 ? /;\s*domain\s*=\s*([^;]*)/i.exec(assignment.slice(semi)) : null;
    return {
      name: name.slice(0, MAX_NAME_CHARS),
      t: Date.now(),
      script,
      deletion,
      host: docHost(),
      domain: dm ? cleanDomain(dm[1]) : null,
    };
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
        if (name && log.length < MAX_WRITES) {
          log.push(documentCookieWrite(s, name, scriptOf(String(new Error().stack || ''))));
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
        if (name && log.length < MAX_WRITES) {
          log.push({
            name: String(name).slice(0, MAX_NAME_CHARS),
            t: Date.now(),
            script: scriptOf(String(new Error().stack || '')),
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

export function cookieWritesInPage(): RawCookieWrite[] {
  const log = window[Symbol.for('dsgvo-check.cookie-writes')];
  return Array.isArray(log) ? log.slice() : [];
}

// Logs `setItem` (storage type, key, time; never the value): a key that existed before the B/C click and is written
// again after it counts as a write after the click.
export function storageHookInit(): void {
  const KEY = Symbol.for('dsgvo-check.storage-writes');
  if (window[KEY]) return;
  const MAX_WRITES = 2000;
  const MAX_NAME_CHARS = 200;
  const log: Array<{ type: 'localStorage' | 'sessionStorage'; key: string; t: number }> = [];
  Object.defineProperty(window, KEY, { value: log, enumerable: false });

  const proto = window.Storage && window.Storage.prototype;
  const setItem = proto && typeof proto.setItem === 'function' ? proto.setItem : null;
  if (!setItem) return;

  proto.setItem = function (this: unknown, k: unknown, v: unknown) {
    try {
      if (log.length < MAX_WRITES) {
        let local: unknown = null;
        try {
          local = window.localStorage;
        } catch {
          local = null;
        }
        log.push({
          type: this === local ? 'localStorage' : 'sessionStorage',
          key: String(k).slice(0, MAX_NAME_CHARS),
          t: Date.now(),
        });
      }
    } catch {
      // never break the page
    }
    return setItem.call(this, k, v);
  };
}

export function storageWritesInPage(): Array<{
  type: 'localStorage' | 'sessionStorage';
  key: string;
  t: number;
}> {
  const log = window[Symbol.for('dsgvo-check.storage-writes')];
  return Array.isArray(log) ? log.slice() : [];
}
