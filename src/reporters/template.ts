/** Small strict HTML template language. There is deliberately no unescaped output operation. */
import { formatMessage, templateParams } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { MessageParams } from '../core/report/schema.ts';

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string }
  | { kind: 'if'; path: string; yes: Node[]; no: Node[] }
  | { kind: 'each'; path: string; alias: string; body: Node[] }
  | { kind: 'translation'; key: string; params: Record<string, string> };
type Token = { text: string } | { expression: string };
type Scope = Record<string, unknown>;

const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z0-9_$]+)*$/;
const IF_BLOCK = /^#if\s+(.+)$/;
const EACH_BLOCK = /^#each\s+(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/;
const TRANSLATION = /^t\s+"([^"\r\n]+)"((?:\s+.*)?)$/;
const TRANSLATION_PARAM = /^([A-Za-z_$][\w$]*)=(.+)$/;

/** Blocks nest only this deep, so a hostile or broken template cannot exhaust the stack. */
const MAX_NESTING_DEPTH = 100;

/** Site text is bounded by the view already; the larger ceiling keeps verified screenshot data URIs whole. */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

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

function tokenize(source: string): Token[] {
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
  return tokens;
}

/** `t "key" name=path ...`: a UI text whose parameters are bound to paths of the view. */
function parseTranslation(expression: string): Node {
  const translation = TRANSLATION.exec(expression);
  if (!translation) throw new Error('Invalid template translation');

  const params: Record<string, string> = Object.create(null);
  const tail = translation[2]!.trim();
  for (const argument of tail ? tail.split(/\s+/) : []) {
    const match = TRANSLATION_PARAM.exec(argument);
    if (!match || FORBIDDEN_KEYS.has(match[1]!) || Object.hasOwn(params, match[1]!)) {
      throw new Error('Invalid template translation parameter');
    }
    params[match[1]!] = validPath(match[2]!);
  }
  return { kind: 'translation', key: translation[1]!, params };
}

function parse(source: string): Node[] {
  const tokens = tokenize(source);
  let index = 0;

  /** Reads nodes up to one of the `stops` expressions (`else`, `/if`, `/each`) or to the end of the template. */
  function sequence(stops: readonly string[] = [], depth = 0): { nodes: Node[]; stop?: string } {
    if (depth > MAX_NESTING_DEPTH) throw new Error('Template nesting limit exceeded');
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

      const condition = IF_BLOCK.exec(expression);
      const loop = EACH_BLOCK.exec(expression);
      if (condition) {
        const yes = sequence(['else', '/if'], depth + 1);
        const no = yes.stop === 'else' ? sequence(['/if'], depth + 1).nodes : [];
        nodes.push({ kind: 'if', path: validPath(condition[1]!), yes: yes.nodes, no });
      } else if (loop) {
        const path = validPath(loop[1]!);
        const alias = validPath(loop[2]!);
        nodes.push({ kind: 'each', path, alias, body: sequence(['/each'], depth + 1).nodes });
      } else if (/^t\s/.test(expression)) {
        nodes.push(parseTranslation(expression));
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

function output(value: unknown): string {
  return escapeHtml(sanitizeExternal(String(primitive(value) ?? '–'), MAX_OUTPUT_CHARS));
}

type TranslationNode = Extract<Node, { kind: 'translation' }>;

function renderTranslation(node: TranslationNode, scopes: readonly Scope[], ctx: ReporterContext): string {
  if (!Object.hasOwn(ctx.texts.ui, node.key)) throw new Error(`Unknown template translation: ${node.key}`);
  const text = ctx.texts.ui[node.key]!.text;

  const params: MessageParams = Object.create(null);
  const required = new Set(templateParams(text));
  for (const [key, path] of Object.entries(node.params)) {
    if (!required.has(key)) throw new Error(`Unknown translation parameter: ${key}`);
    const value = primitive(resolve(path, scopes));
    params[key] = typeof value === 'string' ? sanitizeExternal(value, MAX_OUTPUT_CHARS) : value;
    required.delete(key);
  }
  if (required.size) throw new Error('Missing template translation parameter');

  return output(formatMessage(text, params, ctx.lang));
}

function renderNode(node: Node, scopes: readonly Scope[], ctx: ReporterContext): string {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'value':
      return output(resolve(node.path, scopes));
    case 'if': {
      const value = resolve(node.path, scopes);
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      return renderNodes(truthy ? node.yes : node.no, scopes, ctx);
    }
    case 'each': {
      const values = resolve(node.path, scopes);
      if (!Array.isArray(values)) throw new Error('Template each requires an array');
      return values
        .map((value) => renderNodes(node.body, [...scopes, { [node.alias]: value }], ctx))
        .join('');
    }
    case 'translation':
      return renderTranslation(node, scopes, ctx);
  }
}

function renderNodes(nodes: readonly Node[], scopes: readonly Scope[], ctx: ReporterContext): string {
  return nodes.map((node) => renderNode(node, scopes, ctx)).join('');
}

export function renderTemplate(source: string, view: unknown, ctx: ReporterContext): string {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('Invalid template view');
  return renderNodes(parse(source), [view as Scope], ctx);
}
