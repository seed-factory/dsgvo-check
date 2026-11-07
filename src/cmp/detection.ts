/** Pure helpers for CMP recognition (`high` needs ≥ 2 independent signals) and consent-state verdicts. */
import type { CmpDetection, Confidence, ConsentStateFact } from './types.ts';

export const SIGNAL_KINDS = ['global', 'script', 'dom', 'stored'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Independent signal kinds: `global`, `script`, `dom` and stored consent (`cookie` and `storage` count as one). */
export function signalKinds(signals: readonly string[]): Set<string> {
  const kinds = new Set<string>();
  for (const s of signals) {
    const kind = s.split(':', 1)[0] ?? '';
    if (kind === 'cookie' || kind === 'storage') kinds.add('stored');
    else if (kind === 'global' || kind === 'script' || kind === 'dom') kinds.add(kind);
  }
  return kinds;
}

/**
 * `high` for two independent kinds, `medium` for one. With `required`, nothing is recognised unless one of those kinds
 * was found: a platform global on every page of the platform (Shopware's `salesChannelId`) is no consent tool alone.
 */
export function confidenceFromSignals(
  signals: readonly string[],
  required: readonly SignalKind[] = [],
): Confidence | null {
  const kinds = signalKinds(signals);
  if (required.length > 0 && !required.some((k) => kinds.has(k))) return null;
  const n = kinds.size;
  if (n >= 2) return 'high';
  if (n === 1) return 'medium';
  return null;
}

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 } as const;

/** Only stored consent (cookie or storage names): such a name may be shared between vendors (`CookieConsent`). */
function storedOnly(signals: readonly string[]): boolean {
  const kinds = signalKinds(signals);
  return kinds.size === 1 && kinds.has('stored');
}

/**
 * Whether detection `a` beats `b` (adapters are tried in registry order, so on a tie the earlier one stays): higher
 * confidence wins; at the same confidence a signal of the page itself beats a consent cookie or storage name alone.
 */
export function outranks(
  a: Pick<CmpDetection, 'recognitionConfidence' | 'signals'>,
  b: Pick<CmpDetection, 'recognitionConfidence' | 'signals'>,
): boolean {
  const diff = CONFIDENCE_RANK[a.recognitionConfidence] - CONFIDENCE_RANK[b.recognitionConfidence];
  if (diff !== 0) return diff > 0;
  return storedOnly(b.signals) && !storedOnly(a.signals);
}

export const NOT_DETECTED: CmpDetection = {
  cmpId: null,
  method: 'none',
  version: null,
  versionSupported: null,
  recognitionConfidence: 'low',
  signals: [],
};

/** A dotted version; a bare integer is a cache-busting counter or timestamp, not a version. */
export const VERSION_PATTERN = /^\d{1,4}(\.\d+){1,3}$/;

export function cleanVersion(v: string | undefined): string | null {
  return v !== undefined && VERSION_PATTERN.test(v) ? v : null;
}

/** WordPress-style `?ver=1.2.3` (or `v=`) from a script URL; a timestamp is no version. */
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

const unconfirmed = (reason: string): StateVerdict => ({ ok: false, methods: [], reason });

export interface VerdictOptions {
  /** Only a state our click changed (`origin: action`) confirms. */
  requireAction?: boolean;
  /** Categories left out of the verdict (see `unchangedDeniedAfterAccept`). */
  ignoreCategories?: readonly string[];
  /**
   * The categories are the vendor's permission cookies the adapter knows by name (Shopware), not the installation's own
   * list: a confirmed state names that basis (`known-flags-absent`, `known-flags-present`) instead of `all-denied`.
   */
  knownFlags?: boolean;
}

/** The verdict of one source: an answer was recorded by the visitor or our click, and every counted category is `want`. */
function verdictOfSource(
  s: ConsentStateFact,
  want: 'denied' | 'granted',
  opts: VerdictOptions,
  ignored: ReadonlySet<string>,
): StateVerdict {
  const source = s.source;

  const responded = s.decision?.responded;
  if (responded === false) return unconfirmed(`${source}:no-response-recorded`);
  if (responded !== true) return unconfirmed(`${source}:response-unknown`);

  if (s.origin === 'default' || s.origin === 'special-branch')
    return unconfirmed(`${source}:origin-${s.origin}`);
  if (opts.requireAction && s.origin !== 'action') return unconfirmed(`${source}:unchanged-after-click`);

  const entries = Object.entries(s.categories).filter(([k]) => !ignored.has(k));
  if (entries.length === 0) return unconfirmed('no-categories');
  if (!entries.every(([, v]) => v === want)) return unconfirmed(`${source}:not-all-${want}`);

  const skipped = Object.keys(s.categories).filter((k) => ignored.has(k));
  const basis = opts.knownFlags ? `known-flags-${want === 'denied' ? 'absent' : 'present'}` : `all-${want}`;
  return {
    ok: true,
    methods: [
      `${source}:${basis}`,
      'decision:responded',
      `origin:${s.origin}`,
      ...(skipped.length > 0 ? [`categories-ignored:${skipped.join(',')}`] : []),
    ],
  };
}

/**
 * Confirms reject/accept by recorded state (`decision.responded === true`, origin `action` or `stored`, every optional
 * category denied/granted); the API wins over the cookie. `requireAction` accepts only `origin: action`.
 */
export function stateVerdict(
  states: readonly ConsentStateFact[],
  action: 'reject' | 'accept',
  opts: VerdictOptions = {},
): StateVerdict {
  const want = action === 'reject' ? 'denied' : 'granted';
  const ignored = new Set(opts.ignoreCategories ?? []);

  const ready = states.filter((s) => s.ready === 'ready');
  if (ready.length === 0) return unconfirmed('state-unavailable');

  // The first source that lists categories decides.
  for (const source of SOURCE_ORDER) {
    const s = ready.find((x) => x.source === source && Object.keys(x.categories).length > 0);
    if (s) return verdictOfSource(s, want, opts, ignored);
  }
  // A CMP may list its categories only once answered (Shopware): then the missing answer is why nothing is confirmed.
  for (const source of SOURCE_ORDER) {
    if (ready.some((x) => x.source === source && x.decision?.responded === false))
      return unconfirmed(`${source}:no-response-recorded`);
  }
  return unconfirmed('no-categories');
}

/**
 * Categories of the first source that stayed `denied` through our accept click while another was granted by it. A CMP
 * whose API cannot list its categories (CookieHub) may simply lack such a category, so it is left out of the verdict.
 * A category the state before the click did not list counts as denied there when no answer was recorded yet: a CMP that
 * lists its categories only once answered (Shopware) had granted nothing before.
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
    const unanswered = prev.decision?.responded === false;
    const deniedBefore = (k: string) =>
      prev.categories[k] === 'denied' || (unanswered && !Object.hasOwn(prev.categories, k));
    return entries.filter(([k, v]) => v === 'denied' && deniedBefore(k)).map(([k]) => k);
  }
  return [];
}

function sameCategories(a: ConsentStateFact['categories'], b: ConsentStateFact['categories']): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * `origin: action` only for a state our click produced: same document, an answer recorded that was not there before
 * (new source or changed categories). Everything else keeps the origin the adapter read. With `newAnswerOnly` an answer
 * recorded before the click stays the CMP's own whatever its categories do: categories that are known names only
 * (Shopware) prove too little, so only an answer our click newly recorded counts.
 */
export function originAfterClick(
  now: readonly ConsentStateFact[],
  before: readonly ConsentStateFact[] | null,
  sameDocument: boolean,
  opts: { newAnswerOnly?: boolean } = {},
): ConsentStateFact[] {
  return now.map((s) => {
    if (!sameDocument || s.origin === 'special-branch' || s.decision?.responded !== true) return s;
    const prev = before?.find((p) => p.source === s.source && (p.scope ?? null) === (s.scope ?? null));
    const unchanged =
      prev !== undefined &&
      prev.decision?.responded === true &&
      (opts.newAnswerOnly === true || sameCategories(prev.categories, s.categories));
    return unchanged ? s : { ...s, origin: 'action' as const };
  });
}
