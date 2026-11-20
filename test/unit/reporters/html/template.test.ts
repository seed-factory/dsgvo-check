import { describe, expect, it } from 'vitest';
import type { ReporterContext } from '../../../../src/core/report/reporter.ts';
import { renderTemplate } from '../../../../src/reporters/template.ts';

const ctx: ReporterContext = {
  texts: {
    lang: 'en',
    messages: {},
    legalNotes: {},
    actions: {},
    ui: {
      'report.title': { text: 'Report for {target}', draft: true },
      'report.literal': { text: '<em> & T2_LABEL', draft: true },
    },
  },
  lang: 'en',
  outDir: '.',
  color: false,
};

describe('safe report templates', () => {
  it('escapes every scalar substitution and removes terminal and direction controls', () => {
    const text = '\u001b[31m\u202e\u0000\'"<>&`T1_COOKIE';
    expect(renderTemplate('<p>{{text}}</p>', { text }, ctx)).toBe(
      '<p>&#39;&quot;&lt;&gt;&amp;&#96;T1&#95;COOKIE</p>',
    );
  });

  it('escapes translation text and external parameters in the same way', () => {
    expect(renderTemplate('{{t "report.title" target=host}}', { host: '<img> T1_SITE' }, ctx)).toBe(
      'Report for &lt;img&gt; T1&#95;SITE',
    );
    expect(renderTemplate('{{t "report.literal"}}', {}, ctx)).toBe('&lt;em&gt; &amp; T2&#95;LABEL');
  });

  it('keeps a check id in running text on one line and escapes the rest as usual', () => {
    expect(renderTemplate('<p>{{prose text}}</p>', { text: 'Prüfung CONSENT-03 & <b>HDR-01</b>' }, ctx)).toBe(
      '<p>Prüfung <span class="id">CONSENT-03</span> &amp; &lt;b&gt;<span class="id">HDR-01</span>&lt;/b&gt;</p>',
    );
    // Lowercase codes and words with a hyphen are no check ids.
    expect(renderTemplate('{{prose text}}', { text: 'first-layer x-01 Zwei-Klick' }, ctx)).toBe(
      'first-layer x-01 Zwei-Klick',
    );
  });

  it('lets a URL break only after its separators, never inside the host or a value', () => {
    const url = 'https://www.example.test/a/b?x=1&y=[redacted]';
    expect(renderTemplate('{{url u}}', { u: url }, ctx)).toBe(
      'https://<wbr>www.example.test/<wbr>a/<wbr>b?<wbr>x=<wbr>1&amp;<wbr>y=<wbr>[redacted]',
    );
    expect(renderTemplate('{{url u}}', { u: '<script>/x' }, ctx)).toBe('&lt;script&gt;/<wbr>x');
  });

  it('nests loops and branches with local aliases and access to the root view', () => {
    const source =
      '{{#each groups as group}}{{title}}:{{#each group.items as item}}' +
      '{{#if item.show}}{{item.value}}{{else}}-{{/if}}{{/each}}{{/each}}';
    const view = {
      title: 'A',
      groups: [
        {
          items: [
            { show: true, value: 1 },
            { show: false, value: 2 },
          ],
        },
      ],
    };
    expect(renderTemplate(source, view, ctx)).toBe('A:1-');
  });

  it.each([false, null, 0, '', []].map((condition) => ({ condition })))(
    'treats $condition as an empty condition',
    ({ condition }) => {
      expect(renderTemplate('{{#if condition}}yes{{else}}no{{/if}}', { condition }, ctx)).toBe('no');
    },
  );

  it('leaves literal stylesheet braces intact and keeps long verified image data', () => {
    const image = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    expect(
      renderTemplate('<style>@media print{p{color:black}}</style><img src="{{image}}">', { image }, ctx),
    ).toBe(`<style>@media print{p{color:black}}</style><img src="${image}">`);
  });

  it.each([
    '{{missing}}',
    '{{nested.missing}}',
    '{{inherited}}',
    '{{nested.toString}}',
    '{{constructor}}',
    '{{nested.__proto__}}',
    '{{t "report.missing"}}',
    '{{t "report.title"}}',
    '{{t "report.title" target=missing}}',
    '{{t "report.literal" unexpected=host}}',
    '{{t "report.title" target=host target=host}}',
    '{{t dynamic}}',
    '{{nested}}',
    '{{#each host as item}}{{item}}{{/each}}',
  ])('rejects unknown, inherited, unsafe or incorrectly typed data: %s', (source) => {
    const view = Object.assign(Object.create({ inherited: 'secret' }), { nested: {}, host: 'example.test' });
    expect(() => renderTemplate(source, view, ctx)).toThrow();
  });

  it.each([
    '{{{host}}}',
    '{{& host}}',
    '{{host',
    '{{#if host}}x',
    '{{#each groups as item}}x',
    '{{else}}',
    '{{/if}}',
    '{{#if host}}x{{/each}}',
    '{{#each groups as x}}x{{else}}{{/each}}',
    '{{#if host}}a{{else}}b{{else}}c{{/if}}',
    '{{#with host}}{{/with}}',
  ])('rejects unsupported or unbalanced syntax: %s', (source) => {
    expect(() => renderTemplate(source, { host: 'example.test', groups: [] }, ctx)).toThrow();
  });
});
