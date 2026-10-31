/** Pure helpers for CMP recognition (D12: `high` needs ≥ 2 independent signals) and consent-state verdicts. */
import type { CmpDetection, Confidence, ConsentStateFact } from './types.ts';

/**
 * Independent signal kinds: `global`, `script`, `dom`, and the stored consent (`cookie`/`storage` count as one
 * kind: both are "consent cookie by name"). Several signals of one kind stay one signal.
 */
export function signalKinds(signals: readonly string[]): Set<string> {
  const kinds = new Set<string>();
  for (const s of signals) {
    const kind = s.split(':', 1)[0] ?? '';
    if (kind === 'cookie' || kind === 'storage') kinds.add('stored');
    else if (kind === 'global' || kind === 'script' || kind === 'dom') kinds.add(kind);
  }
  return kinds;
}

export function confidenceFromSignals(signals: readonly string[]): Confidence | null {
  const n = signalKinds(signals).size;
  if (n >= 2) return 'high';
  if (n === 1) return 'medium';
  return null;
}

export const NOT_DETECTED: CmpDetection = {
  cmpId: null,
  method: 'none',
  version: null,
  versionSupported: null,
  recognitionConfidence: 'low',
  signals: [],
};

/** A dotted version (`7.6.2`, `2.2.67`): a bare integer is a cache-busting counter or a timestamp, not a version. */
export const VERSION_PATTERN = /^\d{1,4}(\.\d+){1,3}$/;

/** A version string read from the CMP's own config object, or null when it is not a dotted version. */
export function cleanVersion(v: string | undefined): string | null {
  return v !== undefined && VERSION_PATTERN.test(v) ? v : null;
}

/** WordPress-style `?ver=1.2.3` (or `v=`) from a script URL; a timestamp such as `?ver=1793004134` is no version. */
export function versionFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('ver') ?? u.searchParams.get('v');
    return v && VERSION_PATTERN.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function majorOf(version: string | null): number | null {
  if (!version) return null;
  const m = /^(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

/** `true` when the major version is listed, `false` when it is known and not listed, `null` when unknown. */
export function majorSupported(version: string | null, majors: readonly number[]): boolean | null {
  const major = majorOf(version);
  if (major === null) return null;
  return majors.includes(major);
}

export interface StateVerdict {
  ok: boolean;
  methods: string[];
  reason?: string;
}

const SOURCE_ORDER: ReadonlyArray<ConsentStateFact['source']> = ['api', 'cookie', 'tcf'];

/**
 * Reject/accept confirmed by state (CONSENT-05, 5.3 `decision`): CMP ready, the user's answer positively recorded
 * (`decision.responded === true` — `false`, `unknown` or no decision never confirm), an origin that matches an answer
 * (`action` or `stored`; `default` and `special-branch` never confirm) and every optional category denied (reject)
 * or granted (accept). The API wins over the cookie. `requireAction` (right after our click, same document): only a
 * state that changed through the click (`origin: action`, see `originAfterClick`) confirms.
 */
export function stateVerdict(
  states: readonly ConsentStateFact[],
  action: 'reject' | 'accept',
  opts: { requireAction?: boolean; ignoreCategories?: readonly string[] } = {},
): StateVerdict {
  const want = action === 'reject' ? 'denied' : 'granted';
  const ignored = new Set(opts.ignoreCategories ?? []);
  const ready = states.filter((s) => s.ready === 'ready');
  if (ready.length === 0) return { ok: false, methods: [], reason: 'state-unavailable' };
  for (const source of SOURCE_ORDER) {
    const s = ready.find((x) => x.source === source && Object.keys(x.categories).length > 0);
    if (!s) continue;
    const responded = s.decision?.responded;
    if (responded === false) return { ok: false, methods: [], reason: `${source}:no-response-recorded` };
    if (responded !== true) return { ok: false, methods: [], reason: `${source}:response-unknown` };
    if (s.origin === 'default' || s.origin === 'special-branch')
      return { ok: false, methods: [], reason: `${source}:origin-${s.origin}` };
    if (opts.requireAction && s.origin !== 'action')
      return { ok: false, methods: [], reason: `${source}:unchanged-after-click` };
    const entries = Object.entries(s.categories).filter(([k]) => !ignored.has(k));
    if (entries.length === 0) return { ok: false, methods: [], reason: 'no-categories' };
    if (entries.every(([, v]) => v === want)) {
      const skipped = Object.keys(s.categories).filter((k) => ignored.has(k));
      return {
        ok: true,
        methods: [
          `${source}:all-${want}`,
          'decision:responded',
          `origin:${s.origin}`,
          ...(skipped.length > 0 ? [`categories-ignored:${skipped.join(',')}`] : []),
        ],
      };
    }
    return { ok: false, methods: [], reason: `${source}:not-all-${want}` };
  }
  return { ok: false, methods: [], reason: 'no-categories' };
}

/**
 * Categories of the first source that stayed `denied` through our accept click while at least one other category was
 * turned `granted` by it. For a CMP whose API cannot list the categories of an installation (CookieHub) such a category
 * may simply not exist there; it then does not take part in the accept verdict. A click that granted nothing excludes
 * nothing (an inert accept stays unverified). `before` is the state read right before the click.
 */
export function unchangedDeniedAfterAccept(
  before: readonly ConsentStateFact[] | null,
  now: readonly ConsentStateFact[],
): string[] {
  if (!before) return [];
  for (const source of SOURCE_ORDER) {
    const after = now.find((s) => s.source === source && Object.keys(s.categories).length > 0);
    const prev = before.find((s) => s.source === source && (s.scope ?? null) === (after?.scope ?? null));
    if (!after || !prev) continue;
    const entries = Object.entries(after.categories);
    const granted = entries.some(([k, v]) => v === 'granted' && prev.categories[k] !== 'granted');
    if (!granted) return [];
    return entries.filter(([k, v]) => v === 'denied' && prev.categories[k] === 'denied').map(([k]) => k);
  }
  return [];
}

function sameCategories(a: ConsentStateFact['categories'], b: ConsentStateFact['categories']): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * `origin: action` (5.3) only for a state our click produced: same document as the click, the CMP records an answer
 * (`decision.responded === true`) and that answer is new — the source had no recorded answer before the click, did
 * not exist yet (consent cookie written by the click) or its categories changed. Everything else keeps the origin
 * the adapter read (`default`, `stored`, `special-branch`). `before` is the state read right before the click.
 */
export function originAfterClick(
  now: readonly ConsentStateFact[],
  before: readonly ConsentStateFact[] | null,
  sameDocument: boolean,
): ConsentStateFact[] {
  return now.map((s) => {
    if (!sameDocument || s.origin === 'special-branch' || s.decision?.responded !== true) return s;
    const prev = before?.find((p) => p.source === s.source && (p.scope ?? null) === (s.scope ?? null));
    const unchanged =
      prev !== undefined &&
      prev.decision?.responded === true &&
      sameCategories(prev.categories, s.categories);
    return unchanged ? s : { ...s, origin: 'action' as const };
  });
}
