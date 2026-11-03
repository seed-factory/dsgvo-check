/**
 * Minimal ICU-MessageFormat-1 subset for test/data/texts: `{name}`, `{n, number}`,
 * `{n, plural, =0 {…} one {# Seite} other {# Seiten}}`, `{x, select, a {…} other {…}}`, `''` → `'`.
 */

import type { Texts } from './data.ts';
import type { MessageParams } from './report-schema.ts';

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string; format?: 'number' }
  | { kind: 'hash' }
  | { kind: 'plural' | 'select'; name: string; options: Record<string, Node[]> };

export class MessageSyntaxError extends Error {}

function parse(src: string): Node[] {
  let i = 0;
  function parseNodes(inPlural: boolean, untilBrace: boolean): Node[] {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    while (i < src.length) {
      const ch = src[i] as string;
      if (ch === "'" && src[i + 1] === "'") {
        text += "'";
        i += 2;
      } else if (ch === "'" && (src[i + 1] === '{' || src[i + 1] === '}' || src[i + 1] === '#')) {
        const end = src.indexOf("'", i + 1);
        if (end === -1) throw new MessageSyntaxError(`unterminated quote at ${i}`);
        text += src.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '{') {
        flush();
        i++;
        nodes.push(parseArg(inPlural));
      } else if (ch === '}') {
        if (!untilBrace) throw new MessageSyntaxError(`unexpected } at ${i}`);
        flush();
        return nodes;
      } else if (ch === '#' && inPlural) {
        flush();
        nodes.push({ kind: 'hash' });
        i++;
      } else {
        text += ch;
        i++;
      }
    }
    if (untilBrace) throw new MessageSyntaxError('unterminated {');
    flush();
    return nodes;
  }
  function readToken(): string {
    const m = /^\s*([^,{}\s]+)\s*/.exec(src.slice(i));
    if (!m) throw new MessageSyntaxError(`expected token at ${i}`);
    i += m[0].length;
    return m[1] as string;
  }
  function parseArg(inPlural: boolean): Node {
    const name = readToken();
    if (src[i] === '}') {
      i++;
      return { kind: 'arg', name };
    }
    if (src[i] !== ',') throw new MessageSyntaxError(`expected , or } at ${i}`);
    i++;
    const type = readToken();
    if (type === 'number') {
      if (src[i] !== '}') throw new MessageSyntaxError(`expected } at ${i}`);
      i++;
      return { kind: 'arg', name, format: 'number' };
    }
    if (type !== 'plural' && type !== 'select') throw new MessageSyntaxError(`unsupported type ${type}`);
    if (src[i] !== ',') throw new MessageSyntaxError(`expected , at ${i}`);
    i++;
    const options: Record<string, Node[]> = {};
    for (;;) {
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] === '}') {
        i++;
        break;
      }
      const key = readToken();
      if (src[i] !== '{') throw new MessageSyntaxError(`expected { after ${key}`);
      i++;
      options[key] = parseNodes(type === 'plural' || inPlural, true);
      i++; // closing }
    }
    if (!options.other) throw new MessageSyntaxError(`${type} without "other"`);
    return { kind: type, name, options };
  }
  return parseNodes(false, false);
}

const cache = new Map<string, Node[]>();
function compiled(template: string): Node[] {
  let nodes = cache.get(template);
  if (!nodes) {
    nodes = parse(template);
    cache.set(template, nodes);
  }
  return nodes;
}

/** Throws MessageSyntaxError for invalid templates (used by the texts completeness test). */
export function validateTemplate(template: string): void {
  compiled(template);
}

/** Argument names referenced by the template. */
export function templateParams(template: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.kind === 'arg') names.add(n.name);
      else if (n.kind === 'plural' || n.kind === 'select') {
        names.add(n.name);
        for (const opt of Object.values(n.options)) walk(opt);
      }
    }
  };
  walk(compiled(template));
  return [...names];
}

export function formatMessage(template: string, params: MessageParams, lang: 'de' | 'en'): string {
  const numberFmt = new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB');
  const pluralRules = new Intl.PluralRules(lang === 'de' ? 'de-DE' : 'en-GB');
  const render = (nodes: Node[], hashValue: number | null): string =>
    nodes
      .map((n) => {
        switch (n.kind) {
          case 'text':
            return n.value;
          case 'hash':
            return hashValue === null ? '#' : numberFmt.format(hashValue);
          case 'arg': {
            const v = params[n.name];
            if (v === undefined) return `{${n.name}}`;
            if (v === null) return '–';
            if (typeof v === 'number' && n.format === 'number') return numberFmt.format(v);
            return String(v);
          }
          case 'plural': {
            const v = Number(params[n.name] ?? 0);
            const exact = n.options[`=${v}`];
            const opt = exact ?? n.options[pluralRules.select(v)] ?? (n.options.other as Node[]);
            return render(opt, v);
          }
          case 'select': {
            const v = String(params[n.name] ?? 'other');
            return render(n.options[v] ?? (n.options.other as Node[]), hashValue);
          }
          default:
            return '';
        }
      })
      .join('');
  return render(compiled(template), null);
}

export interface RenderedMessage {
  title: string;
  body: string;
  draft: boolean;
}

/** Render `messageId` from loaded texts; missing keys render a visible placeholder (completeness test catches it). */
export function renderMessage(texts: Texts, messageId: string, params: MessageParams): RenderedMessage {
  const entry = texts.messages[messageId];
  if (!entry) return { title: messageId, body: `[missing text: ${messageId}]`, draft: true };
  return {
    title: formatMessage(entry.title, params, texts.lang),
    body: formatMessage(entry.body, params, texts.lang),
    draft: entry.draft,
  };
}

/** UI string with `{param}` substitution; falls back to the key. */
export function uiText(texts: Texts, key: string, params: MessageParams = {}): string {
  const entry = texts.ui[key];
  if (!entry) return key;
  return formatMessage(entry.text, params, texts.lang);
}
