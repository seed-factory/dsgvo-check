/**
 * The notice section of the HTML report: the disclaimer paragraphs sorted into labelled groups, so a reader finds what
 * the report is and stores, and what shaped this scan, without reading every paragraph.
 */

import type { ReporterContext } from '../core/report/reporter.ts';
import type { Report } from '../core/report/schema.ts';
import { type DisclaimerEntry, disclaimerEntries } from './disclaimer.ts';

type NoticeGroupId = 'report' | 'scan';

/** Group of every paragraph key; the label of an item is its key without the `disclaimer.` prefix. */
const GROUP_OF: Record<DisclaimerEntry['key'], NoticeGroupId> = {
  disclaimer: 'report',
  'disclaimer.noFinding': 'report',
  'disclaimer.dependence': 'report',
  'disclaimer.usage': 'report',
  'disclaimer.draft': 'report',
  'disclaimer.egressUnknown': 'scan',
  'disclaimer.egressAsserted': 'scan',
  'disclaimer.proxy': 'scan',
  'disclaimer.phaseC': 'scan',
  'disclaimer.phaseCFailed': 'scan',
  'disclaimer.botOrGeo': 'scan',
  'disclaimer.bannerNotRecognized': 'scan',
  'disclaimer.incomplete': 'scan',
  'disclaimer.sandboxOff': 'scan',
  'disclaimer.data': 'report',
  'disclaimer.screenshots': 'report',
};

const GROUP_ORDER: readonly NoticeGroupId[] = ['report', 'scan'];

/** Within the scan group the region comes first: it decides how far the consent observations carry. */
const SCAN_ORDER: readonly DisclaimerEntry['key'][] = [
  'disclaimer.egressUnknown',
  'disclaimer.egressAsserted',
  'disclaimer.proxy',
  'disclaimer.phaseC',
  'disclaimer.phaseCFailed',
  'disclaimer.botOrGeo',
  'disclaimer.bannerNotRecognized',
  'disclaimer.incomplete',
  'disclaimer.sandboxOff',
];

export interface NoticeItem {
  label: string;
  text: string;
  /** The draft stamp printed in front of the text. */
  stamp: string | null;
}

export interface NoticeGroup {
  title: string;
  items: NoticeItem[];
}

export interface NoticeTools {
  label: (key: string, params?: Record<string, string>) => string;
  clean: (value: unknown, max?: number) => string;
  /** The draft line and its stamp, or null when the report is not a draft. */
  draft: { text: string; stamp: string } | null;
  rechtsstand: string | null;
}

const labelKey = (key: DisclaimerEntry['key']): string =>
  key === 'disclaimer' ? 'nature' : key.slice('disclaimer.'.length);

export function noticeGroups(report: Report, ctx: ReporterContext, t: NoticeTools): NoticeGroup[] {
  // The draft line stands next to the stamp; the draft paragraph would say the same again.
  const entries = disclaimerEntries(report, ctx.texts, { detail: ctx.detail, withoutDraft: true });
  const items = new Map<NoticeGroupId, Array<{ key: string; item: NoticeItem }>>();
  const add = (group: NoticeGroupId, key: string, text: string, stamp: string | null = null) => {
    const list = items.get(group) ?? [];
    list.push({ key, item: { label: t.label('notice.label', { key }), text: t.clean(text, 6000), stamp } });
    items.set(group, list);
  };

  for (const entry of entries) add(GROUP_OF[entry.key], labelKey(entry.key), entry.text);
  if (t.rechtsstand) add('report', 'rechtsstand', t.rechtsstand);
  if (t.draft) add('report', 'draft', t.draft.text, t.draft.stamp);

  const scanRank = (key: string) => SCAN_ORDER.findIndex((k) => labelKey(k) === key);
  const scan = items.get('scan');
  if (scan) scan.sort((a, b) => scanRank(a.key) - scanRank(b.key));

  return GROUP_ORDER.flatMap((group) => {
    const list = items.get(group);
    return list?.length
      ? [{ title: t.label('notice.group', { group }), items: list.map((e) => e.item) }]
      : [];
  });
}
