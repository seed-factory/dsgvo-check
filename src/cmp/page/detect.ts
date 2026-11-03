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
  const globals = args.globals.filter((path) => {
    let cur: unknown = w;
    for (const part of path.split('.')) {
      if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) return false;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur !== undefined && cur !== null;
  });
  const versions: Record<string, string> = {};
  for (const path of args.versionGlobals ?? []) {
    let cur: unknown = w;
    for (const part of path.split('.')) {
      if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    if (typeof cur === 'string' && cur.length <= 40) versions[path] = cur;
  }
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
  const dom = args.dom.filter((sel) => {
    try {
      return doc.querySelector(sel) !== null;
    } catch {
      return false;
    }
  });
  const cookieNames = doc.cookie
    .split(';')
    .map((c) => c.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
  const cookies = cookieNames.filter((n) =>
    args.cookies.some((p) => {
      try {
        return new RegExp(p).test(n);
      } catch {
        return false;
      }
    }),
  );
  const keys: string[] = [];
  try {
    for (let i = 0; i < w.localStorage.length; i++) {
      const k = w.localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {
    // storage blocked
  }
  const storage = keys.filter((k) =>
    args.storage.some((p) => {
      try {
        return new RegExp(p).test(k);
      } catch {
        return false;
      }
    }),
  );
  return { globals, versions, scripts, scriptUrls, dom, cookies: [...new Set(cookies)], storage };
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
  return new Promise((resolve) => {
    const api = w.__tcfapi;
    if (typeof api !== 'function') {
      resolve({ present: false, gdprApplies: null, cmpId: null });
      return;
    }
    const timer = w.setTimeout(() => resolve({ present: true, gdprApplies: null, cmpId: null }), 1000);
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
