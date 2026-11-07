/**
 * A site that puts values of its own choosing everywhere the browser collector reads short values: attributes, request
 * methods and parameters, cookie paths, the in-page logs of the collector and, through replaced globals, the answers of
 * the collector's page code. Its legal pages print cookie and storage values of the visitor, also inside addresses of
 * the site and of other hosts and inside a link the redaction rewrites. Every planted value holds the marker `zq8` (in
 * any case) or the hex run `4f3a9c1d`, none of which may reach a snapshot or a report. It is served as `SITE_HOST`.
 */
import { LOREM } from './site-dir.ts';

/** The values of the visitor that the legal pages print. */
export const PRINTED_COOKIE = 'zq8cookie77aa';
export const PRINTED_STORAGE = 'zq8uid0042a1b2';

/**
 * The host of the site, whose domain label reads like an id. Borlabs keeps it in its consent cookie beside the
 * visitor's ID, and the Impressum prints it in an address and a link.
 */
export const SITE_HOST = 'www.autohaus24online.test';
const BORLABS_COOKIE = encodeURIComponent(
  JSON.stringify({ domainPath: `${SITE_HOST}/`, uid: 'zq8a1b2c-3d4e5f6g-7h8i9j0k', version: '3' }),
);

/**
 * Values whose IDs hold no long digit or hex run: beside a host of another site, in the path of an address of the
 * site, as the label of a tracker host, in the landing page a storage entry keeps, and as the host of a link with a
 * query, which the redaction rewrites into the parser's lower-case form. The legal pages print each of them.
 */
const PRINTED_IDS = `
    document.cookie = 'sess=Xk2mQ9pLzq8w8eR1tZ.prod; path=/';
    document.cookie = 'ref=${SITE_HOST}/r/Zq8mQ9pLw8eR1tZ3; path=/';
    document.cookie = 'pix=zq8k2m9plw8er1tz3.tracker.test; path=/';
    document.cookie = 'trk=Zq8k2m9q4w8e1r5t3AB; path=/';
    localStorage.setItem('landing', JSON.stringify({ landing: 'https://${SITE_HOST}/p/Zq8LmQ9pw8eR1tZ3' }));
    document.getElementById('sess').textContent = 'Xk2mQ9pLzq8w8eR1tZ';
    document.getElementById('ref').textContent = '${SITE_HOST}/r/Zq8mQ9pLw8eR1tZ3';
    document.getElementById('pix').textContent = 'zq8k2m9plw8er1tz3.tracker.test';
    document.getElementById('landing').textContent = 'Zq8LmQ9pw8eR1tZ3';
    document.getElementById('trk').textContent = 'https://Zq8k2m9q4w8e1r5t3AB.tracker.test/?a=1';
`;

/** What the in-page logs of the collector hold is the page's to change: an entry that carries a query and an address. */
const FORGE_LOGS = `
  var writes = window[Symbol.for('dsgvo-check.cookie-writes')];
  if (writes) writes.push({ name: 'forged', t: Date.now(), script: null, deletion: false, host: '${SITE_HOST}',
    domain: ' ?sid=zq8dom alice@example.com' });
  if (writes) writes.push({ name: 'forgedhost', t: Date.now(), script: null, deletion: false,
    host: 'zq8-4f3a9c1d.example.test', domain: null });
`;

/** The page code of the collector calls Array.prototype.push: a page can change every object it pushes. */
const PATCH_PUSH = `
  var push = Array.prototype.push;
  Array.prototype.push = function () {
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (o && typeof o === 'object' && 'region' in o && 'hreflang' in o) {
        o.region = 'zq8region@example.test';
        o.visible = '?sid=zq8visible';
      }
      if (o && typeof o === 'object' && 'fieldCount' in o) o.method = 'zq8method@example.test';
    }
    return push.apply(this, arguments);
  };
`;

const START = `<!doctype html>
<html lang="de https://example.test/?sid=zq8lang alice@example.com">
<head>
  <meta charset="utf-8">
  <title>Beispiel GmbH</title>
  <link rel="stylesheet zq8linkrel alice@example.com" as="style zq8as" href="/style.css">
  <link rel="preload" as="style" href="/style.css">
  <meta http-equiv="refresh" content="3600; url=javascript:void(zq8metarefreshAlice)">
</head>
<body>
  <nav><a href="/leistungen/" rel="nofollow sid=zq8rel alice@example.com">Leistungen</a></nav>
  <aside>
    <a href="skype:zq8skype.alice.mueller?call">Skype</a>
    <a href="whatsapp:zq8whats.alice">WhatsApp</a>
    <a href="intent:zq8intent.alice#Intent;end">App</a>
  </aside>
  <main>
    <h1>Willkommen</h1>
    <form method="post?token=zq8form&mail=alice@example.com" action="/suche/"><input name="q"></form>
    <script type="text/plain; sid=zq8type alice@example.com" data-cookieconsent="statistics">void 0;</script>
    <script type="text/zq8k2m9q4w8e1r5t3">void 0;</script>
    <script type="evil.test/zq8alice">void 0;</script>
  </main>
  <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>
  <script>
    ${PATCH_PUSH}
    document.cookie = 'pathprobe=1; path=/?sid=zq8path&mail=alice@example.com';
    document.cookie = 'pathid=1; path=/s/zq8k2m9q4w8e1r5t3';
    document.cookie = 'domainprobe=1; domain=zq8-4f3a9c1d-7a2b-1730291234.example.test';
    ${FORGE_LOGS}
    fetch('/api/ping', { method: 'ZQ8METHOD' }).catch(function () {});
    navigator.sendBeacon('/collect', 'en=zq8event4f3a9c1d&gcs=zq8gcs&npa=zq8npa&gcd=zq8gcd');
    navigator.sendBeacon('/collect-id', 'en=zq8k2m9q4w8e1r5t3');
  </script>
</body>
</html>`;

/** A legal page in German that prints the visitor's cookie and storage values, under a `lang` with a query. */
const legal = (title: string) => `<!doctype html>
<html lang="de https://example.test/?sid=zq8doclang">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <main>
    <h1>${title}</h1>
    <h2>Allgemeines</h2>
    <p>${LOREM.repeat(4)}</p>
    <h2>Cookies</h2>
    <p>Ihre Einwilligungs-ID: <span id="cid"></span>. Ihre Kennung: <span id="uid"></span>.</p>
    <p>Sitzung: <span id="sess"></span>. Empfehlung: <span id="ref"></span>. Pixel: <span id="pix"></span>.
      Startseite: <span id="landing"></span>. Link: <span id="trk"></span> Ende.</p>
  </main>
  <script>
    document.cookie = 'cid=${PRINTED_COOKIE}; path=/';
    document.cookie = 'borlabs-cookie=${BORLABS_COOKIE}; path=/';
    localStorage.setItem('uid', '${PRINTED_STORAGE}');
    document.getElementById('cid').textContent = '${PRINTED_COOKIE}';
    document.getElementById('uid').textContent = localStorage.getItem('uid');
    ${PRINTED_IDS}
  </script>
</body>
</html>`;

const IMPRESSUM_DETAILS = `<p>Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch Erika Muster. Handelsregister: HRB 12345, Amtsgericht Berlin. USt-IdNr.: DE123456789.</p>
    <p>E-Mail: max.mustermann@autohaus24online.test. Website: https://${SITE_HOST}/de/impressum/ (Stand 2026).</p>`;

export const HOSTILE_SITE: Record<string, string> = {
  'index.html': START,
  'style.css': 'body { font-family: sans-serif; }',
  'leistungen/index.html': `<!doctype html><html lang="de-DE"><head><meta charset="utf-8"><title>Leistungen</title></head><body><main><h1>Leistungen</h1></main></body></html>`,
  'impressum/index.html': legal('Impressum').replace(
    '<h2>Allgemeines</h2>',
    `<h2>Angaben</h2>${IMPRESSUM_DETAILS}`,
  ),
  'datenschutz/index.html': legal('Datenschutzerklärung'),
};
