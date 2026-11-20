/**
 * Phases B and C with a stub CMP whose controls the real CMP probe measures on a page that chose their values: an
 * attribute with a query and a `role` that is no ARIA role on the reject, a replaced `Array.prototype.map` through which
 * the probe's answer carries a tag, a vendor role and a selector the page wrote, a press log the page rewrites while the
 * button is pressed, and a cover laid over the accept right before its click. The probe builds the click selectors from
 * names only and its answer is kept only in its own forms, so the reject is clicked and verified, the failed accept
 * keeps the kind of failure only, and the snapshot keeps none of these values. Markers: `zq8`, `4f3a9c1d`,
 * `12345678901234`.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { clickButton } from '../../../../src/cmp/adapters/base.ts';
import { loadLexicon } from '../../../../src/cmp/lexicon-file.ts';
import { measureBanner } from '../../../../src/cmp/page/measure.ts';
import type { ClickOutcome, ClickTarget } from '../../../../src/cmp/types.ts';
import type { CmpApi } from '../../../../src/collectors/browser/index.ts';
import { persisted } from '../helpers.ts';
import { page, useSite } from '../site-dir.ts';
import { stubCmpApi } from './stub-cmp.ts';

/** A hex consent ID as a string: it compares as a large number with the press times. */
const FORGED_PRESS = '0x4F3A9C1D2E7B8A9F0C1D';

const INDEX = page(`
  <main><h1>Willkommen</h1></main>
  <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>
  <div id="stub-cmp" role="dialog" aria-label="Cookie-Einstellungen"
       style="position:fixed;left:0;right:0;bottom:0;height:150px;background:#fff;padding:16px;z-index:1000">
    <p>Wir verwenden Cookies für Statistik.</p>
    <button id="stub-accept" type="button">Alle akzeptieren</button>
    <button type="button" role="uid-zq8role" data-testid="?sid=zq8sel&amp;uid=12345678901234">Ablehnen</button>
    <button type="button">Einstellungen</button>
  </div>
  <script>
    (function () {
      function has(v) { return document.cookie.split('; ').indexOf('stub_consent=' + v) >= 0; }
      function hide() { document.getElementById('stub-cmp').style.display = 'none'; }
      window.StubCmp = {
        state: function () { return has('granted') ? 'granted' : has('denied') ? 'denied' : 'unknown'; },
        stored: has('granted') || has('denied')
      };
      // The probe's answer passes through Array.prototype.map, which the page replaced.
      var map = Array.prototype.map;
      Array.prototype.map = function () {
        var out = map.apply(this, arguments);
        for (var i = 0; i < out.length; i++) {
          var o = out[i];
          if (o && typeof o === 'object' && 'vendorRole' in o && o.name === 'Einstellungen') {
            o.tag = 'x-zq8k2m9q4w8e1r5t3-alice@example.com';
            o.vendorRole = '?sid=zq8vendor';
            o.role = 'uid-zq8role';
            o.selector = '#cmp-settings-4f3a9c1d2e7b8a9f0c1d';
          }
        }
        return out;
      };
      if (has('granted') || has('denied')) { hide(); return; }
      var reject = document.querySelector('[data-testid]');
      // The press log of the collector is the page's to change: the real presses go, a string takes their place.
      function forge() {
        var log = window[Symbol.for('dsgvo-check.input-events')];
        if (log) { log.splice(0); log.push('${FORGED_PRESS}'); }
      }
      reject.addEventListener('pointerdown', forge);
      reject.addEventListener('mousedown', forge);
      reject.addEventListener('click', function () {
        document.cookie = 'stub_consent=denied; path=/; max-age=31536000';
        hide();
      });
    })();
  </script>`);

/** A cover the page lays over its banner, with a marker the call log of a failed click would quote. */
const COVER = `document.body.insertAdjacentHTML('beforeend',
  '<div data-x="zq8cover" style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2000"></div>')`;

/** The stub's facts with the controls as the CMP probe measures them on this page. */
function hostileApi(): CmpApi {
  const act = async (
    p: Page,
    action: 'reject' | 'accept',
    target: ClickTarget | null,
  ): Promise<ClickOutcome> => {
    const button = target
      ? { name: target.name, role: target.role, kind: action, kindConfidence: target.kindConfidence }
      : null;
    if (!target) return { action, clicked: false, button, error: `no-unambiguous-${action}` };
    if (action === 'accept') await p.evaluate(COVER);
    return { action, button, ...(await clickButton(p, target, 300)) };
  };
  const base = stubCmpApi({ act });
  return {
    ...base,
    extract: async (p, adapter, moment, phase) => {
      const facts = await base.extract(p, adapter, moment, phase);
      const { firstLayer } = await measureBanner(p, { containers: ['#stub-cmp'] }, loadLexicon());
      return { ...facts, firstLayer: { ...facts.firstLayer, buttons: firstLayer.buttons } };
    },
  };
}

const site = useSite(
  {
    'index.html': INDEX,
    'impressum/index.html': page('<main><h1>Impressum</h1></main>'),
    'datenschutz/index.html': page('<main><h1>Datenschutzerklärung</h1></main>'),
  },
  { collect: { maxPages: 3, deps: { cmp: hostileApi(), phases: ['A', 'B', 'C'] } } },
);

const phase = (p: 'B' | 'C') => site.run.result.sections.browser?.phases.find((x) => x.phase === p);
const cmpPhase = (p: 'B' | 'C') => site.run.result.sections.cmp?.phases.find((x) => x.phase === p);

describe('CMP controls with values the page chose', () => {
  it('the reject is clicked through the selector the probe built from names and verified', () => {
    expect(phase('B')?.click).toMatchObject({ action: 'reject', name: 'Ablehnen', success: true });
    expect(cmpPhase('B')?.verify).toMatchObject({ verified: true });
    expect(site.run.result.sections.plan?.click.B?.target).toEqual({
      cmpId: 'stub',
      name: 'Ablehnen',
      role: 'button',
      selector: '#stub-cmp > button:nth-child(3)',
      kindConfidence: 'high',
    });
  });

  it('the stored facts keep only selectors of names, ARIA roles, tag names and the vendor roles of the adapter', () => {
    const buttons = cmpPhase('B')?.facts[0]?.firstLayer.buttons ?? [];
    expect(buttons.map((b) => [b.name, b.role, b.selector, b.tag, b.vendorRole])).toEqual([
      ['Alle akzeptieren', 'button', '#stub-accept', 'button', null],
      ['Ablehnen', 'button', '#stub-cmp > button:nth-child(3)', 'button', null],
      ['Einstellungen', 'generic', undefined, 'unknown', null],
    ]);
  });

  it('a press log the page rewrote gives no press: the click moment is the adapter call, a number', () => {
    const click = phase('B')?.click;
    expect(typeof click?.clickedAt).toBe('number');
    expect(click?.clickedAtSource).toBe('adapter-call');
  });

  it('a click that timed out keeps only the kind of failure', () => {
    expect(phase('C')?.click).toMatchObject({ success: false, error: 'click-failed:timed out' });
    expect(cmpPhase('C')?.click?.error).toBe('click-failed:timed out');
  });

  it('nothing of these values is in what the collector persists', () => {
    expect(persisted(site.run).match(/[^"]{0,40}(?:zq8|4f3a9c1d|12345678901234)[^"]{0,40}/gi) ?? []).toEqual(
      [],
    );
  });

  it('touches only declared hosts', () => {
    expect(site.server.unexpected).toEqual([]);
  });
});
