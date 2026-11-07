import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReporterContext } from '../../../../src/core/report/reporter.ts';
import { normalizeTemplateLayout, renderHtml } from '../../../../src/reporters/html.ts';
import { sampleFullReport } from '../../../utils/report/fixtures.ts';
import { cspOf } from '../../../utils/report/html-safety.ts';
import { reporterContext } from '../../../utils/report/reporter-inputs.ts';

describe('template layout', () => {
  it.each([
    ['tags on separate lines', '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>', '<ul><li>a</li><li>b</li></ul>'],
    ['expressions on separate lines', '{{#if x}}\n  {{a}}\n{{/if}}', '{{#if x}}{{a}}{{/if}}'],
    ['a tag and an expression', '<p>\n  {{a}}\n</p>', '<p>{{a}}</p>'],
    ['blank lines, tabs and trailing blanks', '<p>a</p> \t\n\n\t<p>b</p>', '<p>a</p><p>b</p>'],
  ])('drops the line break and indentation between %s', (_name, source, expected) => {
    expect(normalizeTemplateLayout(source)).toBe(expected);
  });

  it.each([
    ['inline elements', '<b>a</b> <i>b</i>'],
    ['expressions', '{{a}} {{b}}'],
    ['several spaces', '<b>a</b>   <i>b</i>'],
    ['a non-breaking space before the line break', '<b>a</b> \n<i>b</i>'],
  ])('keeps whitespace without a line break between %s', (_name, source) => {
    expect(normalizeTemplateLayout(source)).toBe(source);
  });

  it.each([
    ['text inside an element', '<p>one\n  two</p>'],
    ['text on its own line', '<p>\n  text\n</p>'],
    ['text after an expression', '{{a}}:\n  {{b}}'],
    ['text before an expression', '{{a}}\n  : {{b}}'],
  ])('keeps a line break next to %s because only markup is formatting', (_name, source) => {
    expect(normalizeTemplateLayout(source)).toBe(source);
  });

  it('turns {{nl}} into one line break and still drops the layout around it', () => {
    expect(normalizeTemplateLayout('<p>a</p>{{nl}}\n  <p>b</p>')).toBe('<p>a</p>\n<p>b</p>');
    expect(normalizeTemplateLayout('<p>a</p>{{nl}}\n  {{nl}}\n<p>b</p>')).toBe('<p>a</p>\n\n<p>b</p>');
  });

  it('folds line breaks and indentation inside <style> and nothing else there', () => {
    const source = [
      '<style>',
      '  a>b{',
      '    margin:0 auto;',
      '    font:1px/1 x,',
      '    y',
      '  }',
      '  @media print{',
      '    c{d:e}',
      '  }',
      '</style>',
    ].join('\n');
    expect(normalizeTemplateLayout(source)).toBe(
      '<style>a>b{margin:0 auto;font:1px/1 x,y}@media print{c{d:e}}</style>',
    );
  });

  it('does not treat {{nl}} inside <style> as a marker, so the loader still rejects expressions there', () => {
    expect(normalizeTemplateLayout('<style>a{b:c}{{nl}}</style>')).toBe('<style>a{b:c}{{nl}}</style>');
  });
});

describe('template layout in the HTML reporter', () => {
  const ctx = (dataDir?: string): ReporterContext => reporterContext('de', dataDir ? { dataDir } : {});

  it('hashes the folded style, and keeps only the line breaks written as {{nl}}', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'report-layout-'));
    mkdirSync(path.join(dataDir, 'report'));
    const template = [
      '<!doctype html>{{nl}}',
      '<html lang="{{lang}}">',
      '  <head>{{nl}}',
      '    <meta http-equiv="Content-Security-Policy" content="style-src \'sha256-{{styleHash}}\'">{{nl}}',
      '    <style>',
      '      a{',
      '        color:red;',
      '        margin:0 auto',
      '      }',
      '    </style>{{nl}}',
      '  </head>',
      '  <body>{{nl}}',
      '    <p>',
      '      one',
      '      two',
      '    </p>',
      '  </body>',
      '</html>',
      '',
    ].join('\n');
    writeFileSync(path.join(dataDir, 'report', 'report.html'), template);

    const hash = createHash('sha256').update('a{color:red;margin:0 auto}').digest('base64');
    expect(renderHtml(sampleFullReport(), ctx(dataDir))).toBe(
      [
        '<!doctype html>',
        '<html lang="de"><head>',
        `<meta http-equiv="Content-Security-Policy" content="style-src 'sha256-${hash}'">`,
        '<style>a{color:red;margin:0 auto}</style>',
        '</head><body>',
        '<p>\n      one\n      two\n    </p></body></html>\n',
      ].join('\n'),
    );
  });

  it('does not leak the layout of the shipped template into the document', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(html).not.toContain('{{');
    expect(html).not.toMatch(/\n[ \t]/);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(style).not.toContain('\n');
    expect(cspOf(html)).toContain(`'sha256-${createHash('sha256').update(style).digest('base64')}'`);
  });
});
