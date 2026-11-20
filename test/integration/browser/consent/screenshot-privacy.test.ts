import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { collect, persisted } from '../helpers.ts';
import { page, useSite } from '../site-dir.ts';
import { stubCmpApi } from './stub-cmp.ts';

const VISITOR_VALUE = 'synthetic-visitor-value-7824';
const site = useSite({
  'index.html': page(`
    <main><h1>Beispiel</h1></main>
    <div id="stub-cmp" role="dialog" style="position:fixed;bottom:0;left:0;right:0;padding:16px;background:white">
      <output id="visitor"></output>
      <button type="button" id="stub-reject">Ablehnen</button>
      <button type="button" id="stub-accept">Alle akzeptieren</button>
    </div>
    <script>
      document.cookie = 'visitor=${VISITOR_VALUE}; path=/';
      document.getElementById('visitor').textContent = document.cookie;
      let decision = 'unknown';
      window.StubCmp = { state: () => decision };
      document.getElementById('stub-reject').onclick = () => {
        decision = 'denied';
        document.getElementById('stub-cmp').hidden = true;
      };
    </script>
  `),
});

it('records the banner and the cookie name without saving page pixels that can contain the cookie value', async () => {
  const run = await collect(site.server, {
    maxPages: 1,
    screenshots: true,
    deps: { cmp: stubCmpApi(), phases: ['A', 'B'] },
  });
  const browser = run.result.sections.browser;
  const phase = browser?.phases.find((p) => p.phase === 'B');
  const first = run.result.sections.cmp?.phases.find((p) => p.phase === 'B')?.facts[0];

  expect(first?.firstLayer.bannerVisible).toBe(true);
  expect(phase?.cookies.map((cookie) => cookie.name)).toContain('visitor');
  expect(browser?.screenshots).toEqual([]);
  expect(first?.screenshotId).toBeUndefined();
  expect(existsSync(path.join(run.artifactsDir, 'banner-B.jpg'))).toBe(false);
  expect(persisted(run)).not.toContain(VISITOR_VALUE);
});
