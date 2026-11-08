import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { sampleFullReport } from '../../../utils/report/fixtures.ts';
import { cspOf } from '../../../utils/report/html-safety.ts';
import { reporterContext } from '../../../utils/report/reporter-inputs.ts';

function renderWithTemplate(template: string): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'report-layout-'));
  try {
    mkdirSync(path.join(dataDir, 'report'));
    writeFileSync(path.join(dataDir, 'report', 'report.html'), template);
    return renderHtml(sampleFullReport(), reporterContext('de', { dataDir }));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

it('the HTML report preserves text spacing and hashes the style it actually writes', () => {
  const html = renderWithTemplate(`
    <!doctype html>{{nl}}
    <html lang="{{lang}}">
      <head>
        <meta http-equiv="Content-Security-Policy" content="style-src 'sha256-{{styleHash}}'">
        <style>
          a {
            color:red;
          }
        </style>
      </head>
      <body>
        <p><b>one</b> <i>two</i></p>{{nl}}
        <p>first line
          second line</p>
      </body>
    </html>`);

  expect(html).toContain('<p><b>one</b> <i>two</i></p>\n<p>first line\n');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  expect(style).toMatch(/color:\s*red/);
  const hash = createHash('sha256').update(style!).digest('base64');
  expect(cspOf(html)).toContain(`'sha256-${hash}'`);
});

it('rejects template expressions inside CSS', () => {
  expect(() => renderWithTemplate('<style>a{color:red}{{nl}}</style>')).toThrow(/style/i);
});
