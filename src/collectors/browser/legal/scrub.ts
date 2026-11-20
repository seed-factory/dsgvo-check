/**
 * Takes the values of the visitor's cookies and Web Storage out of page text before it is stored or hashed. A page can
 * print them: a cookie declaration shows the consent ID of the scan profile, a script writes `document.cookie` into the
 * Impressum. Free-text redaction cannot tell such an ID from a word, so the text is searched for the values themselves.
 * The values are in memory only and the scrubber keeps no copy of them beyond its own lifetime.
 *
 * The page chooses both the values and the text, and the search runs on the event loop, where no timeout can stop it.
 * So all pieces are searched in one pass (Aho–Corasick): the time grows with the text, not with text times pieces.
 */
import { loadSection } from '../../../core/data/load.ts';
import { hasIdLikeRun } from '../../../core/redaction/page-names.ts';
import { addressSpans, REDACTED, safeDecode } from '../../../core/url/email.ts';
import { registrableDomain } from '../../../core/url/url.ts';
import { businessMarkersSection } from './sections.ts';

/**
 * The free-text redaction rewrites a link it sanitizes into the form the URL parser gives it (a lower-case host,
 * percent escapes, punycode), and it must see an address whole to mask its local part. So text is scrubbed twice:
 * before the redaction outside addresses, where a value stands as the page wrote it, and after it everywhere.
 */
export interface ValueScrubber {
  /** Every place of a value, also in the parser's form: for text the free-text redaction has rewritten. */
  (text: string): string;
  /** The places outside e-mail addresses and the starts of links: for text before the free-text redaction. */
  outsideAddresses(text: string): string;
}

/** Short digit-bearing pieces often are words of the page rather than values. */
const MIN_SECRET_CHARS = 8;
/** An ID-like run shorter than this (a 6-digit number, a register or postal number) is no value of a visitor. */
const MIN_WEAK_SECRET_CHARS = 6;
/** A piece longer than this is a whole JSON blob or a cache entry, which no page prints. */
const MAX_SECRET_CHARS = 512;
const MAX_PIECES_PER_VALUE = 50;
/** Weak pieces count apart, so that a value full of numbers cannot use up the room of the strong ones. */
const MAX_WEAK_PIECES_PER_VALUE = 10;
const MAX_SECRETS = 1_000;
/** What separates the fields of a cookie or storage value: JSON and JS object syntax, `k=v|k=v` lists, whitespace. */
const FIELD_SEPARATOR = /[^A-Za-z0-9+/=_.~-]+/;
/** What separates the parts of one field: `GA1.1.1234567890.1700000000`, a UUID, `uid=abc123`. */
const PART_SEPARATOR = /[._~=-]+/;
/** What separates a host name in a field from its key, the slashes before it and its path: `url=//host.test/p/`. */
const ADDRESS_SEPARATOR = /[/=+]+/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const TOP_LABEL = /^[a-z]{2,63}$/i;

/** Eight characters or more with a digit: an id, a hash, a stamp. */
const isStrong = (piece: string): boolean =>
  piece.length <= MAX_SECRET_CHARS && piece.length >= MIN_SECRET_CHARS && /\d/.test(piece);
/** A run of this many letters or more with no digit is an encoded id as well as a word: a visitor's value is not read as text. */
const MIN_LETTER_ID_CHARS = 20;
const LETTERS_ONLY = /^[A-Za-z]+$/;
/** An ID-like run that is no strong piece: six or seven digits, a long run of letters without a digit. */
const isWeak = (piece: string): boolean =>
  piece.length <= MAX_SECRET_CHARS &&
  piece.length >= MIN_WEAK_SECRET_CHARS &&
  !isStrong(piece) &&
  (hasIdLikeRun(piece) || (piece.length >= MIN_LETTER_ID_CHARS && LETTERS_ONLY.test(piece)));

/**
 * `key: value`, `"key":"value"` and `key=value` in a stored value: the key, then a value of six characters or more. The
 * quotes may be escaped, as in JSON inside a JSON string (`{\"uid\":\"1234567\"}`).
 */
const FIELD_PAIR =
  /\\{0,3}["']?([A-Za-z0-9_.-]{1,40})\\{0,3}["']?[ \t]{0,3}[:=][ \t]{0,3}\\{0,3}["']?([A-Za-z0-9+/_.~-]{6,512})/g;
/**
 * A key that reads as an identifier: `id`, `uid`, `sid`, `consentId`, `visitor_token`, `user`, `kundennummer`. A word
 * that names a thing of the visitor counts at the end of the key only, since `clientPhone` and `userAgent` are no ids.
 */
const ID_KEY_WORD =
  /(?:^|[^a-z])(?:id|uid|sid|cid|guid|uuid)$|(?:token|consent|session|visitor|user|client|device|kunden)(?:[_-]?(?:id|key|token|nummer))?$/i;
const ID_KEY_CAMEL = /[a-z0-9]Id$|[A-Z]ID$/;
const isIdKey = (key: string): boolean => ID_KEY_WORD.test(key) || ID_KEY_CAMEL.test(key);

/** Two labels or more, the last of letters: `www.autohaus24online.de`. */
function isHostName(token: string): boolean {
  const labels = token.split('.');
  return labels.length >= 2 && labels.every((l) => HOST_LABEL.test(l)) && TOP_LABEL.test(labels.at(-1)!);
}

/** The registrable domain of a host, the host itself when it has none (an IP address, `localhost`). */
const domainOf = (host: string): string => {
  const h = host.toLowerCase();
  return registrableDomain(h) ?? h;
};

/** How many labels on the right of `host` are a registrable domain of the site; 0 for a host of another site. */
function siteLabels(host: string, sites: ReadonlySet<string>): number {
  if (!isHostName(host)) return 0;
  const domain = domainOf(host);
  return sites.has(domain) ? domain.split('.').length : 0;
}

/**
 * The value, its decoded forms, its fields (a stamp in `{stamp:'…',necessary:true}`), the values of its `k=v` fields
 * and their parts that read as ids.
 *
 * A field with a host of the site is an address of the site: Borlabs keeps the host in `domainPath`, OneTrust the
 * landing page. The page prints its addresses anyway, and a label of its domain such as `autohaus24online` reads as an
 * id but is none: taken out of `[redacted]@autohaus24online.de` or a link of the site, it would only garble the text.
 * Of such a field only the labels of subdomains and the segments of the path count, and only with an id-like run
 * (`u-4f3a9c1d2e7b.www.site.de`, `/r/Xk2mQ9pLw8eR1tZ3`); a value with one is not taken whole. A host of any other site
 * goes by its labels like any value (`[redacted].tracker.test`).
 */
function piecesOf(value: string, sites: ReadonlySet<string>, cookie: boolean): string[] {
  const strong = new Set<string>();
  const weak = new Set<string>();
  const once = safeDecode(value);
  const forms = new Set([value, once, safeDecode(once)]);
  // Web Storage holds site data too (a cache of the Impressum has its register and phone numbers), so a weak piece
  // counts there only as the value of a field that reads as an id; a cookie value is the visitor's whole.
  const idFieldValues = new Set<string>();
  for (const form of forms) {
    for (const m of form.matchAll(FIELD_PAIR)) if (isIdKey(m[1]!)) idFieldValues.add(m[2]!);
  }
  const add = (p: string) => {
    if (isStrong(p)) {
      if (strong.size < MAX_PIECES_PER_VALUE) strong.add(p);
    } else if ((cookie || idFieldValues.has(p)) && isWeak(p) && weak.size < MAX_WEAK_PIECES_PER_VALUE) {
      weak.add(p);
    }
  };
  const addId = (p: string) => {
    if (hasIdLikeRun(p)) add(p);
  };
  // A host of another site goes by its labels: the id label, not the domain it is a part of.
  const addValue = (p: string) => {
    if (!isHostName(p)) add(p);
    else for (const label of p.split('.')) add(label);
  };
  const addSitePieces = (field: string) => {
    for (const token of field.split(ADDRESS_SEPARATOR)) {
      const host = isHostName(token);
      const labels = host ? token.split('.') : [token];
      const own = siteLabels(token, sites);
      const judge = host && own === 0 ? add : addId;
      for (const piece of labels.slice(0, labels.length - own)) {
        judge(piece);
        for (const part of piece.split(PART_SEPARATOR)) judge(part);
      }
    }
  };
  // The values of id fields come first, so that a value full of other numbers cannot use up the room they need.
  for (const p of idFieldValues) add(p);
  for (const form of forms) {
    const fields = form.split(FIELD_SEPARATOR);
    const ofSite = fields.map((f) => f.split(ADDRESS_SEPARATOR).some((t) => siteLabels(t, sites) > 0));
    if (!ofSite.includes(true)) addValue(form.trim());
    for (const [i, field] of fields.entries()) {
      if (ofSite[i]) {
        addSitePieces(field);
        continue;
      }
      addValue(field);
      for (const v of field.split('=')) addValue(v);
      // The host and the path segments of a link: `//tracker.test/c/4f3a9c1d2e7b`.
      for (const token of field.split(ADDRESS_SEPARATOR)) addValue(token);
      for (const part of field.split(PART_SEPARATOR)) add(part);
    }
  }
  return [...strong, ...weak];
}

/** Code units per state in the transition keys: `state * UNITS + unit`. */
const UNITS = 0x10000;

/**
 * ASCII letters in one case: the URL parser lower-cases a host, so `Xk2mQ9` of a value stands as `xk2mq9` in a
 * sanitized link. Other code units stay, so a needle and the text keep their lengths.
 */
const fold = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

/** The needles as a trie with failure links: every place of every needle is found in one pass over a text. */
interface Automaton {
  readonly next: ReadonlyMap<number, number>;
  readonly fail: Int32Array;
  /** Length of the needle that ends in the state, 0 when none does. */
  readonly ends: Int32Array;
  /** The nearest state on the failure chain in which a needle ends, 0 when there is none. */
  readonly output: Int32Array;
}

function automatonOf(needles: readonly string[]): Automaton {
  const next = new Map<number, number>();
  const parent = [0];
  const unit = [0];
  const depth = [0];
  const ends = [0];
  for (const needle of needles) {
    let s = 0;
    for (let i = 0; i < needle.length; i++) {
      const c = fold(needle.charCodeAt(i));
      const key = s * UNITS + c;
      let t = next.get(key);
      if (t === undefined) {
        t = depth.length;
        next.set(key, t);
        parent.push(s);
        unit.push(c);
        depth.push(depth[s]! + 1);
        ends.push(0);
      }
      s = t;
    }
    ends[s] = needle.length;
  }

  const size = depth.length;
  const fail = new Int32Array(size);
  const output = new Int32Array(size);
  // A failure link leads to a shallower state, so the states are linked level by level.
  const levels: number[][] = [];
  for (let v = 1; v < size; v++) {
    const d = depth[v]!;
    while (levels.length <= d) levels.push([]);
    levels[d]!.push(v);
  }
  for (const level of levels) {
    for (const v of level) {
      const p = parent[v]!;
      const c = unit[v]!;
      // The longest proper suffix of the state's string that is also in the trie; the root for a child of the root.
      let f = 0;
      for (let s = fail[p]!; p !== 0; s = fail[s]!) {
        const t = next.get(s * UNITS + c);
        if (t !== undefined || s === 0) {
          f = t ?? 0;
          break;
        }
      }
      fail[v] = f;
      output[v] = ends[f]! > 0 ? f : output[f]!;
    }
  }
  return { next, fail, ends: Int32Array.from(ends), output };
}

const isAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * A letter or digit right before `at` glues a needle to a longer word, unless it ends a percent escape: the URL parser
 * writes `{` and `ä` before a value as `%7B` and `%C3%A4`.
 */
function gluedBefore(text: string, at: number): boolean {
  if (at === 0 || !isAlnum(text.charCodeAt(at - 1))) return false;
  const escaped =
    at >= 3 &&
    text.charCodeAt(at - 3) === 37 &&
    isHex(text.charCodeAt(at - 2)) &&
    isHex(text.charCodeAt(at - 1));
  return !escaped;
}

/** Counts of protected code units before each position, so that a place can be tested against all spans at once. */
function protectedCounts(text: string, spans: ReadonlyArray<readonly [number, number]>): Int32Array | null {
  if (spans.length === 0) return null;
  const mark = new Uint8Array(text.length);
  let covered = 0;
  for (const [start, end] of spans) {
    for (let i = Math.max(start, covered); i < end; i++) mark[i] = 1;
    covered = Math.max(covered, end);
  }
  const counts = new Int32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) counts[i + 1] = counts[i]! + mark[i]!;
  return counts;
}

/**
 * Every place of a needle that is no part of a longer word or number (`DE123456789` keeps its digits) becomes
 * `[redacted]`; places that overlap become one. Places that overlap a span of `spans` stay.
 */
function scrubWith(a: Automaton, text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  const kept = protectedCounts(text, spans);
  const starts: number[] = [];
  const stops: number[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    const c = fold(text.charCodeAt(i));
    for (;;) {
      const t = a.next.get(s * UNITS + c);
      if (t !== undefined) {
        s = t;
        break;
      }
      if (s === 0) break;
      s = a.fail[s]!;
    }
    const stop = i + 1;
    if (stop < text.length && isAlnum(text.charCodeAt(stop))) continue;
    // The longest needle that ends here with no letter or digit glued to its start covers the shorter ones.
    for (let v = a.ends[s]! > 0 ? s : a.output[s]!; v !== 0; v = a.output[v]!) {
      let start = stop - a.ends[v]!;
      if (gluedBefore(text, start)) continue;
      if (kept && kept[stop]! > kept[start]!) continue;
      while (stops.length > 0 && stops.at(-1)! > start) {
        stops.pop();
        start = Math.min(start, starts.pop()!);
      }
      starts.push(start);
      stops.push(stop);
      break;
    }
  }
  if (starts.length === 0) return text;

  let out = '';
  let pos = 0;
  for (let k = 0; k < starts.length; k++) {
    out += text.slice(pos, starts[k]) + REDACTED;
    pos = stops[k]!;
  }
  return out + text.slice(pos);
}

/** The start of a link or a `mailto:` value, which the free-text redaction recognizes a token by. */
const TOKEN_START = /https?:\/\/|mailto:/gi;

/**
 * What the first pass leaves to the second: addresses, which the mask must see whole, and the start of every link. A
 * value that takes `https://` with it would leave the rest of the link (`?sid=…`) as text no redaction looks at.
 */
function deferredSpans(text: string): Array<readonly [number, number]> {
  const spans = addressSpans(text);
  for (const m of text.matchAll(TOKEN_START)) spans.push([m.index, m.index + m[0].length]);
  return spans.sort((a, b) => a[0] - b[0]);
}

const businessMarkers = loadSection(businessMarkersSection);
const markerPattern = businessMarkers.markers
  .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const BUSINESS_NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${markerPattern})(?![\\p{L}\\p{N}])\\s*[:.#-]?\\s*[A-Za-z0-9][A-Za-z0-9/.-]*`,
  'giu',
);

function businessSpans(text: string): Array<readonly [number, number]> {
  return Array.from(
    text.matchAll(BUSINESS_NUMBER),
    (match) => [match.index, match.index + match[0].length] as const,
  );
}

const IDENTITY: ValueScrubber = Object.assign((text: string) => text, {
  outsideAddresses: (text: string) => text,
});

/**
 * A scrubber for `values` (cookie values: they hold the consent IDs) and `storageValues`; identity without values.
 * `sites` are the hosts or registrable domains of the site whose addresses the values may hold: the document's and the
 * scan's.
 */
export function valueScrubber(
  values: readonly string[],
  sites: readonly string[] = [],
  storageValues: readonly string[] = [],
): ValueScrubber {
  const domains = new Set(sites.map(domainOf));
  const secrets = new Set<string>();
  for (const [list, cookie] of [
    [values, true],
    [storageValues, false],
  ] as const) {
    for (const v of list) {
      if (secrets.size >= MAX_SECRETS) break;
      for (const p of piecesOf(v, domains, cookie)) secrets.add(p);
    }
  }
  if (secrets.size === 0) return IDENTITY;
  const automaton = automatonOf([...secrets].slice(0, MAX_SECRETS));
  return Object.assign((text: string) => scrubWith(automaton, text, businessSpans(text)), {
    outsideAddresses: (text: string) =>
      scrubWith(
        automaton,
        text,
        [...businessSpans(text), ...deferredSpans(text)].sort((a, b) => a[0] - b[0]),
      ),
  });
}
