/**
 * Evidence as the full report shows it: field names and coded values in words, ids and clocks that only link records
 * inside report.json left out, a request in a few lines, and pages or headers of one finding as one list.
 */
import type { Evidence, MessageParams } from '../core/report/schema.ts';

export interface Item {
  text: string;
  code: boolean;
  url: boolean;
  href: string | null;
}

export interface Row {
  label: string;
  items: Item[];
}

export interface EvidenceView {
  type: string;
  missing: string | null;
  /** "5× im Auszug" when identical items are shown as one; null for a single occurrence. */
  occurrences: string | null;
  /** The first field, printed together with the type so a page never ends with the type alone. */
  lead: Row[];
  fields: Row[];
  screenshot: { dataUri: string | null; missing: string | null; path: string } | null;
  /** Short enough to be kept on one page in print; a longer item may break after its first field. */
  compact: boolean;
}

/** What the evidence view needs from the report view: cleaned labels and items, phase names and screenshots. */
export interface EvidenceTools {
  label: (key: string, params?: MessageParams) => string;
  item: (value: unknown, max?: number, code?: boolean) => Item;
  urlItem: (value: unknown) => Item;
  phase: (phase: string) => string;
  screenshot: (ev: Evidence) => EvidenceView['screenshot'];
  /** Fields never shown: values of cookies, storage and consent strings, ids and crmCode (kept in report-view). */
  hidden: (ev: Evidence) => ReadonlySet<string>;
}

/**
 * Ids and clocks that tie records together inside report.json, and facts the rest of the card already states (the
 * service, the registrable domain of the URL). They stay in the JSON report.
 */
const INTERNAL_FIELDS = new Set([
  'tMs',
  'navigationId',
  'actionId',
  'parentRequestId',
  'frameId',
  'thirdPartyETLD1',
  'serviceId',
]);

/**
 * Fields that tell repeated observations apart: when and where in the run they were made. A merged item lists the
 * pages and phases of all of them instead; the URL of a frame stays part of what is compared, so requests of an
 * embedded frame are not merged with those of the page itself.
 */
const OCCURRENCE_FIELDS = new Set([
  'page',
  'phase',
  'tMs',
  'navigationId',
  'frameId',
  'actionId',
  'parentRequestId',
]);

/** An item of at most this many printed lines stays on one page; a longer one would leave a gap before it. */
const COMPACT_LINES = 16;

/** Characters of a value per printed line in the value column, roughly. */
const LINE_CHARS = 60;

const printedLines = (rows: readonly Row[]): number =>
  rows.reduce(
    (n, r) => n + r.items.reduce((m, i) => m + Math.max(1, Math.ceil(i.text.length / LINE_CHARS)), 0),
    0,
  );

/** The view of an item from its rows: the first one leads, the item is compact when it is short. */
function withRows(base: Omit<EvidenceView, 'lead' | 'fields' | 'compact'>, rows: Row[]): EvidenceView {
  return {
    ...base,
    lead: rows.slice(0, 1),
    fields: rows.slice(1),
    compact: printedLines(rows) <= COMPACT_LINES,
  };
}

/** Types whose items of one finding are shown as one list, one line each. */
const LIST_TYPES = new Set(['page', 'header', 'link']);

/**
 * A request that carried nothing beyond its URL (no identifier, event or Consent Mode signal, not from an embedded
 * frame) says all in one line; such requests of one page and phase form one list.
 */
function plainRequest(ev: Evidence): boolean {
  if (ev.type !== 'request') return false;
  const f = ev as Fields;
  const features = (f.features ?? {}) as {
    identifier?: { kind?: string };
    eventType?: string;
    consentSignal?: object;
  };
  return (
    (features.identifier?.kind ?? 'none') === 'none' &&
    !features.eventType &&
    !features.consentSignal &&
    !f.frameUrl
  );
}

/** The list an item joins, or null for an item shown on its own. */
function listKey(ev: Evidence): string | null {
  if (LIST_TYPES.has(ev.type)) return ev.type;
  const f = ev as Fields;
  return plainRequest(ev) ? `request|${str(f.phase)}|${str(f.page)}` : null;
}

/** A list field (pages, evidence values) shows at most this many entries. */
export const MAX_LIST_ITEMS = 50;

/** Nested evidence values deeper than this are cut; evidence objects are shallow. */
const MAX_VALUE_DEPTH = 4;

const URL_VALUE = /^(https?|wss?):\/\//i;

type Fields = Record<string, unknown>;

/** A structured value as `key: value` pairs (nested keys joined by dots), so the report shows no JSON. */
export function plainValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '–';
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_VALUE_DEPTH) return '…';
  if (Array.isArray(value)) {
    return value
      .map((v) => (v && typeof v === 'object' ? `(${plainValue(v, depth + 1)})` : plainValue(v)))
      .join(', ');
  }
  const pairs: string[] = [];
  const walk = (obj: object, prefix: string, level: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && level < MAX_VALUE_DEPTH) walk(v, key, level + 1);
      else pairs.push(`${key}: ${plainValue(v, level + 1)}`);
    }
  };
  walk(value, '', depth);
  return pairs.join(' · ') || '–';
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One value as a list item: URLs get link styling, a phase and a yes/no read as words, objects are `key: value` code. */
function valueItem(key: string, value: unknown, t: EvidenceTools): Item {
  if (typeof value === 'string') {
    if (key === 'phase') return t.item(t.phase(value), 200);
    if (key === 'recognitionConfidence') return t.item(t.label(`confidence.${value}`), 200);
    return URL_VALUE.test(value) ? t.urlItem(value) : t.item(value, 1000);
  }
  if (typeof value === 'boolean') return t.item(t.label(value ? 'yes' : 'no'));
  if (value === null || ['number', 'undefined'].includes(typeof value)) return t.item(value, 1000);
  return t.item(plainValue(value), 1000, true);
}

function row(key: string, value: unknown, t: EvidenceTools): Row {
  const values = Array.isArray(value) ? value.slice(0, MAX_LIST_ITEMS) : [value];
  return {
    label: t.label('evidence.field', { key }),
    items: values.length ? values.map((v) => valueItem(key, v, t)) : [t.item('–')],
  };
}

const labelled = (key: string, items: Item[], t: EvidenceTools): Row => ({
  label: t.label('evidence.field', { key }),
  items,
});

/** The fetch of a request in one line: method, resource type, answer and how it was delivered. */
function fetchLine(ev: Fields, t: EvidenceTools): string {
  const result = (ev.result ?? {}) as { kind?: string; status?: number; errorText?: string };
  return t.label('evidence.fetch', {
    method: str(ev.method),
    resourceType: str(ev.resourceType),
    result: result.kind ?? 'none',
    status: result.status ?? '',
    error: result.errorText ?? '',
    delivery: str(ev.delivery),
    provenance: str(ev.provenance),
  });
}

/** What the request carried: the identifier kind, the event and the Consent Mode signal; parser details stay in JSON. */
function requestFeatureRows(ev: Fields, t: EvidenceTools): Row[] {
  const features = (ev.features ?? {}) as {
    identifier?: { kind?: string; param?: string };
    eventType?: string;
    consentSignal?: Record<string, unknown>;
  };
  const out: Row[] = [];
  if (features.identifier?.kind) {
    const identifier = t.label('evidence.identifier', {
      kind: features.identifier.kind,
      hasParam: Boolean(features.identifier.param),
      param: features.identifier.param ?? '',
    });
    out.push(labelled('identifier', [t.item(identifier, 300)], t));
  }
  if (features.eventType) out.push(labelled('event', [t.item(features.eventType, 200)], t));
  if (features.consentSignal && Object.keys(features.consentSignal).length > 0) {
    out.push(labelled('consentSignal', [t.item(plainValue(features.consentSignal), 400, true)], t));
  }
  return out;
}

function requestRows(ev: Fields, t: EvidenceTools): Row[] {
  const out: Row[] = [row('url', ev.url, t), labelled('fetch', [t.item(fetchLine(ev, t), 400)], t)];
  if (ev.phase) out.push(row('phase', ev.phase, t));
  if (ev.page) out.push(row('page', ev.page, t));
  out.push(...requestFeatureRows(ev, t));
  if (ev.frameUrl) out.push(row('frameUrl', ev.frameUrl, t));
  const initiator = (ev.initiator ?? null) as { type?: string; url?: string } | null;
  if (initiator?.url) out.push(labelled('initiator', [t.urlItem(initiator.url)], t));
  else if (initiator?.type) out.push(labelled('initiator', [t.item(initiator.type, 80)], t));
  const ip = (ev.connectedIp ?? null) as { value?: string; origin?: string } | null;
  if (ip?.value) {
    const value = t.label('evidence.ip', { value: ip.value, origin: ip.origin ?? '' });
    out.push(labelled('connectedIp', [t.item(value, 200)], t));
  }
  return out;
}

function cookieRows(ev: Fields, t: EvidenceTools): Row[] {
  const out: Row[] = [row('name', ev.name, t)];
  const domain = str(ev.domain);
  out.push(
    labelled(
      'domain',
      [t.item(domain === 'first-party' ? t.label('evidence.firstPartyDomain') : domain, 300)],
      t,
    ),
  );
  if (ev.path) out.push(row('path', ev.path, t));
  if (ev.state)
    out.push(labelled('state', [t.item(t.label('evidence.cookieState', { state: str(ev.state) }))], t));
  const lifetime = (ev.lifetime ?? null) as { kind?: string; days?: number } | null;
  if (lifetime?.kind) {
    const text = t.label('evidence.lifetime', {
      kind: lifetime.kind,
      hasDays: typeof lifetime.days === 'number',
      days: lifetime.days ?? 0,
    });
    out.push(labelled('lifetime', [t.item(text)], t));
  }
  const attributes = [
    ev.secure === true ? 'Secure' : null,
    ev.httpOnly === true ? 'HttpOnly' : null,
    typeof ev.sameSite === 'string' && ev.sameSite ? `SameSite=${ev.sameSite}` : null,
  ].filter((a): a is string => a !== null);
  if (attributes.length) out.push(labelled('attributes', [t.item(attributes.join(' · '), 200, true)], t));
  if (typeof ev.length === 'number') out.push(row('length', ev.length, t));
  if (ev.setter || ev.setterHost) {
    const setBy = t.label('evidence.setBy', {
      setter: str(ev.setter),
      hasHost: Boolean(ev.setterHost),
      host: str(ev.setterHost),
    });
    out.push(labelled('setBy', [t.item(setBy, 300)], t));
  }
  if (ev.partitionKey) out.push(row('partitionKey', ev.partitionKey, t));
  if (ev.phase) out.push(row('phase', ev.phase, t));
  if (ev.page) out.push(row('page', ev.page, t));
  return out;
}

/** A banner button in one line: its label, what it does and whether it could be used on the first screen. */
function buttonText(b: Fields, t: EvidenceTools): string {
  return t.label('evidence.button', {
    name: str(b.name),
    kind: str(b.kind),
    visible: b.visibleAtFirstScreen === true,
    actionable: b.actionableAtFirstScreen === true,
    hasContrast: typeof b.contrast === 'number',
    contrast: typeof b.contrast === 'number' ? b.contrast : 0,
  });
}

/** What the document reader took in, in words: parts, characters, opened sections, frames and linked pages. */
function manifestText(m: Fields, t: EvidenceTools): string {
  const n = (key: string) => (typeof m[key] === 'number' ? (m[key] as number) : 0);
  return t.label('evidence.manifest', {
    parts: n('partCount'),
    chars: n('textLength'),
    opened: n('expandablesOpened'),
    found: n('expandablesFound'),
    frames: n('framesIncluded'),
    linked: n('linkedPages'),
    truncated: m.truncated === true,
  });
}

/** A coded value of a field in words (`ready` → bereit); a value the texts do not know is shown as it is. */
const coded = (field: string, value: unknown, t: EvidenceTools): string =>
  t.label('evidence.value', { field, value: String(value) }) || String(value);

/** Fields whose values are codes of a closed set, worded by `evidence.value`. */
const CODED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'consent-state': new Set(['source', 'ready', 'origin']),
  'text-match': new Set(['matchLevel', 'negation']),
};

/** One field of a type without its own layout; structured values that have words of their own get them here. */
function genericRow(ev: Evidence, k: string, v: unknown, t: EvidenceTools): Row {
  if (k === 'role' || (ev.type === 'document' && k === 'kind')) {
    return labelled(k, [t.item(t.label('pageRole', { role: str(v) }), 200)], t);
  }
  if (k === 'reason' && typeof v === 'string') return labelled(k, [t.item(reasonText(v, t), 300)], t);
  if (CODED_FIELDS[ev.type]?.has(k)) return labelled(k, [t.item(coded(k, v, t), 300)], t);
  if (k === 'buttons' && Array.isArray(v) && v.length > 0) {
    const buttons = v.slice(0, MAX_LIST_ITEMS).map((b) => t.item(buttonText((b ?? {}) as Fields, t), 400));
    return labelled(k, buttons, t);
  }
  if (k === 'parts' && Array.isArray(v)) {
    const origins = v.map((p) => t.item(coded('part', str((p as Fields | null)?.origin), t), 200));
    return labelled(k, origins.length ? origins : [t.item('–')], t);
  }
  if (k === 'manifest' && v && typeof v === 'object') {
    return labelled(k, [t.item(manifestText(v as Fields, t), 400)], t);
  }
  if (k === 'viewport' && v && typeof v === 'object') {
    const vp = v as Fields;
    return labelled(k, [t.item(`${vp.width ?? '–'} × ${vp.height ?? '–'}`, 40)], t);
  }
  if (k === 'categories' && v && typeof v === 'object') {
    const states = Object.entries(v as Fields).map(([name, state]) => `${name}: ${coded('state', state, t)}`);
    return labelled(k, [t.item(states.join(' · ') || '–', 1000)], t);
  }
  return row(k, v, t);
}

/** The fields of a type without its own layout, in their order, with their names in words. */
function genericRows(ev: Evidence, t: EvidenceTools): Row[] {
  const hidden = t.hidden(ev);
  return Object.entries(ev as Fields)
    .filter(([k, v]) => !hidden.has(k) && !INTERNAL_FIELDS.has(k) && v !== undefined)
    .map(([k, v]) => genericRow(ev, k, v, t));
}

function fieldRows(ev: Evidence, t: EvidenceTools): Row[] {
  if (ev.type === 'request') return requestRows(ev as Fields, t);
  if (ev.type === 'cookie') return cookieRows(ev as Fields, t);
  return genericRows(ev, t);
}

/** A reason code in words (`http-404`, `navigation-failed:timeout`); a code the texts do not know is shown as it is. */
export function reasonText(reason: string, t: Pick<EvidenceTools, 'label'>): string {
  const status = /^http-(\d{3})$/.exec(reason);
  const colon = reason.indexOf(':');
  const code = status ? 'http' : colon === -1 ? reason : reason.slice(0, colon);
  const detail = status ? status[1]! : colon === -1 ? '' : reason.slice(colon + 1);
  return t.label('reason', { code, detail }) || reason;
}

function typeLabel(type: string, count: number, t: EvidenceTools): string {
  return t.label('evidence.type', { type, count });
}

export function evidenceView(ev: Evidence, t: EvidenceTools): EvidenceView {
  const base = {
    type: typeLabel(ev.type, 1, t),
    missing: null,
    occurrences: null,
    screenshot: t.screenshot(ev),
  };
  return withRows(base, fieldRows(ev, t));
}

/** Observations that agree in everything the view shows except time and place are one observation seen several times. */
function occurrenceKey(ev: Evidence, t: EvidenceTools): string | null {
  if (ev.type === 'screenshot') return null;
  const hidden = t.hidden(ev);
  const shown = Object.entries(ev as Fields)
    .filter(([k, v]) => !hidden.has(k) && !OCCURRENCE_FIELDS.has(k) && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([ev.type, shown]);
}

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

const fieldValues = (group: readonly Evidence[], field: string): string[] =>
  distinct(group.flatMap((e) => (str((e as Fields)[field]) ? [str((e as Fields)[field])] : [])));

/** One item for identical observations: the shared fields once, the pages and phases of all of them, and their count. */
function mergedView(group: readonly Evidence[], t: EvidenceTools): EvidenceView {
  const view = evidenceView(group[0]!, t);
  const placeLabels = new Set(['phase', 'page'].map((key) => t.label('evidence.field', { key })));
  const shared = [...view.lead, ...view.fields].filter((r) => !placeLabels.has(r.label));
  const phases = fieldValues(group, 'phase');
  const pages = fieldValues(group, 'page');
  if (phases.length) {
    shared.push({
      label: t.label('evidence.phases'),
      items: [t.item(phases.sort().map(t.phase).join(', '), 400)],
    });
  }
  if (pages.length) {
    shared.push({ label: t.label('evidence.pages'), items: pages.slice(0, MAX_LIST_ITEMS).map(t.urlItem) });
  }
  return withRows({ ...view, occurrences: t.label('evidence.occurrences', { count: group.length }) }, shared);
}

/** One line of a listed page, header or link: what it is on the left, where and in which state on the right. */
function listRow(ev: Evidence, t: EvidenceTools): Row {
  const f = ev as Fields;
  if (ev.type === 'page') {
    const line = t.label('evidence.pageLine', {
      hasStatus: typeof f.status === 'number',
      status: typeof f.status === 'number' ? f.status : '',
      evaluable: f.evaluable === undefined ? '' : String(f.evaluable),
      hasReason: Boolean(f.reason),
      reason: f.reason ? reasonText(str(f.reason), t) : '',
      hasPhase: Boolean(f.phase),
      phase: f.phase ? t.phase(str(f.phase)) : '',
    });
    return {
      label: t.label('pageRole', { role: str(f.role) }),
      items: [t.urlItem(f.url), t.item(line, 400)],
    };
  }
  if (ev.type === 'header') {
    const line = t.label('evidence.headerLine', {
      present: f.present === true,
      hasValue: typeof f.value === 'string' && f.value !== '',
      value: str(f.value),
    });
    return { label: t.item(f.name, 80).text, items: [t.item(line, 1000), t.urlItem(f.url)] };
  }
  const status = typeof f.status === 'number' ? ` · HTTP ${f.status}` : '';
  return {
    label: t.item(f.text || '–', 80).text,
    items: [t.urlItem(f.href), t.item(`${str(f.target)}${status}`)],
  };
}

/** Requests of one page and phase: where once, then the fetch and URL of each. */
function requestListFields(group: readonly Evidence[], t: EvidenceTools): Row[] {
  const first = group[0] as Fields;
  const place: Row[] = [];
  if (first.phase) place.push(row('phase', first.phase, t));
  if (first.page) place.push(row('page', first.page, t));
  const lines = group.slice(0, MAX_LIST_ITEMS).map((ev) => ({
    label: t.item(fetchLine(ev as Fields, t), 200).text,
    items: [t.urlItem((ev as Fields).url)],
  }));
  return [...place, ...lines];
}

function listView(group: readonly Evidence[], t: EvidenceTools): EvidenceView {
  const type = group[0]!.type;
  const rows =
    type === 'request'
      ? requestListFields(group, t)
      : group.slice(0, MAX_LIST_ITEMS).map((ev) => listRow(ev, t));
  return withRows(
    { type: typeLabel(type, group.length, t), missing: null, occurrences: null, screenshot: null },
    rows,
  );
}

/**
 * The evidence of one finding in the order of its ids. Identical observations are shown once with their count, and
 * the pages, headers or links of a finding form one list where it has more than one of them.
 */
export function evidenceViews(
  ids: readonly string[],
  evidence: ReadonlyMap<string, Evidence>,
  t: EvidenceTools,
  missingLabel: (id: string) => string,
): EvidenceView[] {
  const views: EvidenceView[] = [];
  const repeated = new Map<string, { index: number; group: Evidence[] }>();
  const lists = new Map<string, { index: number; group: Evidence[] }>();
  const resolved = distinct(ids).map((id) => ({ id, ev: evidence.get(id) }));
  const listSizes = new Map<string, number>();
  for (const { ev } of resolved) {
    const key = ev ? listKey(ev) : null;
    if (key) listSizes.set(key, (listSizes.get(key) ?? 0) + 1);
  }

  for (const { id, ev } of resolved) {
    if (!ev) {
      views.push({
        type: '',
        missing: missingLabel(id),
        occurrences: null,
        lead: [],
        fields: [],
        screenshot: null,
        compact: true,
      });
      continue;
    }
    const list = listKey(ev);
    if (list && (listSizes.get(list) ?? 0) > 1) {
      const open = lists.get(list);
      if (open) open.group.push(ev);
      else {
        lists.set(list, { index: views.length, group: [ev] });
        views.push(evidenceView(ev, t));
      }
      continue;
    }

    const key = occurrenceKey(ev, t);
    const seen = key === null ? undefined : repeated.get(key);
    if (seen) {
      seen.group.push(ev);
      continue;
    }
    if (key !== null) repeated.set(key, { index: views.length, group: [ev] });
    views.push(evidenceView(ev, t));
  }

  for (const { index, group } of repeated.values()) {
    if (group.length > 1) views[index] = mergedView(group, t);
  }
  for (const { index, group } of lists.values()) views[index] = listView(group, t);
  return views;
}
