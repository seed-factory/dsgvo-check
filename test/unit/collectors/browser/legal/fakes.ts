import type { Page } from 'playwright-core';
import type { RawDocument } from '../../../../../src/collectors/browser/in-page/document.ts';
import type { extractDocument } from '../../../../../src/collectors/browser/legal/documents.ts';

export const POLICY = 'Wir verarbeiten personenbezogene Daten nach der DSGVO. '.repeat(20);

export const privacyContext = (
  url: string,
  contentType = 'text/html; charset=utf-8',
): Parameters<typeof extractDocument>[1] => ({
  id: 'doc-privacy-1',
  kind: 'privacy',
  phase: 'A',
  url,
  foundVia: 'link',
  status: 200,
  contentType,
});

export const rawPolicy = (over: Partial<RawDocument> = {}): RawDocument => ({
  lang: 'de',
  title: 'Datenschutzerklärung',
  h1: 'Datenschutzerklärung',
  parts: [],
  expandablesFound: 0,
  expandablesWithContent: 0,
  textLength: 0,
  truncated: false,
  ...over,
});

export function legalPage(
  url: string,
  main: unknown,
  children: Array<[string, RawDocument | Error]> = [],
): Page {
  const frame = (frameUrl: string, value: unknown) => ({
    url: () => frameUrl,
    evaluate: async () => {
      if (value instanceof Error) throw value;
      return value;
    },
  });
  const mainFrame = frame(url, main);
  return {
    ...mainFrame,
    frames: () => [mainFrame, ...children.map(([frameUrl, value]) => frame(frameUrl, value))],
    mainFrame: () => mainFrame,
  } as unknown as Page;
}
