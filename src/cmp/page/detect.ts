/** In-page CMP detection (`frame.evaluate`): presence signals and the TCF ping. Reads only. */
import type { DWindow } from './dom.ts';

export interface DetectArgs {
  globals: string[];
  versionGlobals?: string[];
  scripts: Array<{ label: string; pattern: string }>;
  dom: string[];
  cookies: string[];
  storage: string[];
}

export interface DetectRaw {
  globals: string[];
  versions: Record<string, string>;
  scripts: string[];
  /** Matched script URLs (raw; only used to read a version, never stored). */
  scriptUrls: string[];
  dom: string[];
  cookies: string[];
  storage: string[];
}

/** In-page presence signals. Cookie and storage NAMES only. SELF-CONTAINED. */
export function cmpDetectProbe(args: DetectArgs): DetectRaw {
  const w = globalThis as unknown as DWindow & Record<string, unknown>;
  const doc = w.document;

  /** The value at a dotted path below `window`; undefined as soon as the walk leaves objects and functions. */
  const resolvePath = (path: string): unknown => {
    let cur: unknown = w;
    for (const part of path.split('.')) {
      if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };

  const matchesAny = (patterns: string[], name: string): boolean =>
    patterns.some((p) => {
      try {
        return new RegExp(p).test(name);
      } catch {
        return false;
      }
    });

  const presentGlobals = (): string[] =>
    args.globals.filter((path) => {
      const value = resolvePath(path);
      return value !== undefined && value !== null;
    });

  /** Version strings the vendor reports about itself; a longer string is no version. */
  const readVersions = (): Record<string, string> => {
    const versions: Record<string, string> = {};
    for (const path of args.versionGlobals ?? []) {
      const value = resolvePath(path);
      if (typeof value === 'string' && value.length <= 40) versions[path] = value;
    }
    return versions;
  };

  /** Script tags of the document and every resource the page loaded. */
  const loadedUrls = (): string[] => {
    const urls: string[] = [];
    for (let i = 0; i < doc.scripts.length; i++) {
      const src = (doc.scripts[i] as { src: string }).src;
      if (src) urls.push(src);
    }
    try {
      const entries = w.performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) urls.push((entries[i] as { name: string }).name);
    } catch {
      // no resource timing
    }
    return urls;
  };

  /** Labels of the script patterns that match a loaded URL, and the first matching URL of each. */
  const matchScripts = (urls: string[]): { scripts: string[]; scriptUrls: string[] } => {
    const scripts: string[] = [];
    const scriptUrls: string[] = [];
    for (const s of args.scripts) {
      let re: RegExp;
      try {
        re = new RegExp(s.pattern, 'i');
      } catch {
        continue;
      }

      const hit = urls.find((u) => re.test(u));
      if (hit) {
        scripts.push(s.label);
        scriptUrls.push(hit);
      }
    }
    return { scripts, scriptUrls };
  };

  const matchingDom = (): string[] =>
    args.dom.filter((sel) => {
      try {
        return doc.querySelector(sel) !== null;
      } catch {
        return false;
      }
    });

  const matchingCookies = (): string[] => {
    const names = doc.cookie
      .split(';')
      .map((c) => c.split('=')[0]?.trim() ?? '')
      .filter(Boolean);
    return [...new Set(names.filter((n) => matchesAny(args.cookies, n)))];
  };

  const matchingStorage = (): string[] => {
    const keys: string[] = [];
    try {
      for (let i = 0; i < w.localStorage.length; i++) {
        const k = w.localStorage.key(i);
        if (k) keys.push(k);
      }
    } catch {
      // storage blocked
    }
    return keys.filter((k) => matchesAny(args.storage, k));
  };

  const globals = presentGlobals();
  const versions = readVersions();
  const { scripts, scriptUrls } = matchScripts(loadedUrls());
  const dom = matchingDom();
  const cookies = matchingCookies();
  const storage = matchingStorage();

  return { globals, versions, scripts, scriptUrls, dom, cookies, storage };
}

/** TCF v2 `ping` (read-only). SELF-CONTAINED. */
export function tcfPingProbe(): Promise<{
  present: boolean;
  gdprApplies: boolean | null;
  cmpId: number | null;
}> {
  type TcfApi = (cmd: string, version: number, cb: (r: unknown, ok: boolean) => void) => void;
  const w = globalThis as unknown as {
    __tcfapi?: TcfApi;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  /** A `__tcfapi` that does not answer within this time is reported as present without an answer. */
  const PING_TIMEOUT_MS = 1000;

  return new Promise((resolve) => {
    const api = w.__tcfapi;
    if (typeof api !== 'function') {
      resolve({ present: false, gdprApplies: null, cmpId: null });
      return;
    }

    const timer = w.setTimeout(
      () => resolve({ present: true, gdprApplies: null, cmpId: null }),
      PING_TIMEOUT_MS,
    );
    try {
      api('ping', 2, (r) => {
        w.clearTimeout(timer);
        const p = (r ?? {}) as { gdprApplies?: unknown; cmpId?: unknown };
        resolve({
          present: true,
          gdprApplies: typeof p.gdprApplies === 'boolean' ? p.gdprApplies : null,
          cmpId: typeof p.cmpId === 'number' ? p.cmpId : null,
        });
      });
    } catch {
      w.clearTimeout(timer);
      resolve({ present: true, gdprApplies: null, cmpId: null });
    }
  });
}
