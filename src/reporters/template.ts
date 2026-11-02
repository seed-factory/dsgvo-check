/** Small strict HTML template language. There is deliberately no unescaped output operation. */
import { formatMessage, templateParams } from '../core/messages.ts';
import type { MessageParams } from '../core/report-schema.ts';
import type { ReporterContext } from '../core/reporter.ts';
import { sanitizeExternal } from '../core/sanitize.ts';

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string }
  | { kind: 'if'; path: string; yes: Node[]; no: Node[] }
  | { kind: 'each'; path: string; alias: string; body: Node[] }
  | { kind: 'translation'; key: string; params: Record<string, string> };
type Token = { text: string } | { expression: string };
type Scope = Record<string, unknown>;

const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z0-9_$]+)*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (char) => ESCAPES[char]!).replace(/T(\d)_/g, 'T$1&#95;');
}

function validPath(value: string): string {
  if (!PATH.test(value) || value.split('.').some((key) => FORBIDDEN_KEYS.has(key))) {
    throw new Error('Invalid template path');
  }
  return value;
}

function parse(source: string): Node[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf('{{', offset);
    if (start < 0) {
      tokens.push({ text: source.slice(offset) });
      break;
    }
    if (start > offset) tokens.push({ text: source.slice(offset, start) });
    const end = source.indexOf('}}', start + 2);
    if (end < 0) throw new Error('Unclosed template expression');
    tokens.push({ expression: source.slice(start + 2, end).trim() });
    offset = end + 2;
  }
  let index = 0;
  function sequence(stops: readonly string[] = [], depth = 0): { nodes: Node[]; stop?: string } {
    if (depth > 100) throw new Error('Template nesting limit exceeded');
    const nodes: Node[] = [];
    while (index < tokens.length) {
      const token = tokens[index++]!;
      if ('text' in token) {
        nodes.push({ kind: 'text', text: token.text });
        continue;
      }
      const expression = token.expression;
      if (stops.includes(expression)) return { nodes, stop: expression };
      if (expression === 'else' || expression.startsWith('/'))
        throw new Error('Unexpected template block end');
      const condition = /^#if\s+(.+)$/.exec(expression);
      const loop = /^#each\s+(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(expression);
      if (condition) {
        const yes = sequence(['else', '/if'], depth + 1);
        const no = yes.stop === 'else' ? sequence(['/if'], depth + 1).nodes : [];
        nodes.push({ kind: 'if', path: validPath(condition[1]!), yes: yes.nodes, no });
      } else if (loop) {
        const path = validPath(loop[1]!);
        const alias = validPath(loop[2]!);
        nodes.push({ kind: 'each', path, alias, body: sequence(['/each'], depth + 1).nodes });
      } else if (/^t\s/.test(expression)) {
        const translation = /^t\s+"([^"\r\n]+)"((?:\s+.*)?)$/.exec(expression);
        if (!translation) throw new Error('Invalid template translation');
        const params: Record<string, string> = Object.create(null);
        const tail = translation[2]!.trim();
        for (const argument of tail ? tail.split(/\s+/) : []) {
          const match = /^([A-Za-z_$][\w$]*)=(.+)$/.exec(argument);
          if (!match || FORBIDDEN_KEYS.has(match[1]!) || Object.hasOwn(params, match[1]!)) {
            throw new Error('Invalid template translation parameter');
          }
          params[match[1]!] = validPath(match[2]!);
        }
        nodes.push({ kind: 'translation', key: translation[1]!, params });
      } else {
        nodes.push({ kind: 'value', path: validPath(expression) });
      }
    }
    if (stops.length) throw new Error('Unclosed template block');
    return { nodes };
  }
  return sequence().nodes;
}

function resolve(path: string, scopes: readonly Scope[]): unknown {
  const keys = path.split('.');
  const first = keys.shift()!;
  const owner = [...scopes].reverse().find((scope) => Object.hasOwn(scope, first));
  if (!owner) throw new Error(`Unknown template path: ${path}`);
  let value: unknown = owner[first];
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error(`Unknown template path: ${path}`);
    }
    value = (value as Scope)[key];
  }
  if (value === undefined) throw new Error(`Undefined template path: ${path}`);
  return value;
}

function primitive(value: unknown): string | number | boolean | null {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  throw new Error('Template substitution must be a scalar');
}

/** Site text is already bounded by the view; the larger ceiling preserves verified screenshot data URIs. */
function output(value: unknown): string {
  return escapeHtml(sanitizeExternal(String(primitive(value) ?? '–'), 4 * 1024 * 1024));
}

export function renderTemplate(source: string, view: unknown, ctx: ReporterContext): string {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('Invalid template view');
  const render = (nodes: readonly Node[], scopes: readonly Scope[]): string =>
    nodes
      .map((node) => {
        if (node.kind === 'text') return node.text;
        if (node.kind === 'value') return output(resolve(node.path, scopes));
        if (node.kind === 'if') {
          const value = resolve(node.path, scopes);
          const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
          return render(truthy ? node.yes : node.no, scopes);
        }
        if (node.kind === 'each') {
          const values = resolve(node.path, scopes);
          if (!Array.isArray(values)) throw new Error('Template each requires an array');
          return values.map((value) => render(node.body, [...scopes, { [node.alias]: value }])).join('');
        }
        if (!Object.hasOwn(ctx.texts.ui, node.key))
          throw new Error(`Unknown template translation: ${node.key}`);
        const text = ctx.texts.ui[node.key]!.text;
        const params: MessageParams = Object.create(null);
        const required = new Set(templateParams(text));
        for (const [key, path] of Object.entries(node.params)) {
          if (!required.has(key)) throw new Error(`Unknown translation parameter: ${key}`);
          const value = primitive(resolve(path, scopes));
          params[key] = typeof value === 'string' ? sanitizeExternal(value, 4 * 1024 * 1024) : value;
          required.delete(key);
        }
        if (required.size) throw new Error('Missing template translation parameter');
        return output(formatMessage(text, params, ctx.lang));
      })
      .join('');
  return render(parse(source), [view as Scope]);
}
