/* Own minimal Usercentrics v3 simulator for integration tests (no vendor code). Mimics public identifiers only:
   window.__ucCmp (isInitialized, getConsentDetails, isConsentRequired), shadow host #usercentrics-cmp-ui with
   #uc-main-dialog and [data-action-type] buttons, localStorage "ucData". */
(function () {
  var script = document.currentScript;
  var variant = (script && script.getAttribute('data-sim-variant')) || 'reject';
  var region = (script && script.getAttribute('data-sim-region')) || 'eu';
  var CATS = { essential: true, functional: false, marketing: false };
  var KEY = 'ucData';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function store(d) { localStorage.setItem(KEY, JSON.stringify(d)); }
  var data = load();
  if (!data) {
    var geoFree = region !== 'eu';
    // "broken-deny": a CMP that reports no consent type at all (answer unknown) and whose deny button only hides.
    data = { type: variant === 'broken-deny' ? '' : 'IMPLICIT', status: geoFree ? 'ALL_ACCEPTED' : 'ALL_DENIED', categories: { functional: geoFree, marketing: geoFree } };
    store(data);
  }
  var initialized = false;
  function details() {
    var cats = { essential: { state: 'ALL_ACCEPTED', essential: true } };
    for (var k in data.categories) cats[k] = { state: data.categories[k] ? 'ALL_ACCEPTED' : 'ALL_DENIED' };
    return { consent: { status: data.status, type: data.type, required: region === 'eu' && data.type !== 'EXPLICIT' }, categories: cats, services: {} };
  }
  window.__ucCmp = {
    isInitialized: function () { return Promise.resolve(initialized); },
    getConsentDetails: function () { return Promise.resolve(details()); },
    isConsentRequired: function () { return Promise.resolve(region === 'eu' && data.type !== 'EXPLICIT'); },
    acceptAllConsents: function () { return Promise.resolve(); },
    denyAllConsents: function () { return Promise.resolve(); }
  };
  function decide(all) {
    data = { type: 'EXPLICIT', status: all ? 'ALL_ACCEPTED' : 'ALL_DENIED', categories: { functional: all, marketing: all } };
    store(data);
  }
  function render() {
    initialized = true;
    if (region !== 'eu' || data.type === 'EXPLICIT') return;
    var host = document.createElement('div');
    host.id = 'usercentrics-cmp-ui';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    var blocking = variant === 'blocking';
    root.innerHTML =
      (blocking ? '<div id="uc-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646"></div>' : '') +
      '<div id="uc-main-dialog" role="dialog" aria-modal="' + blocking + '" aria-labelledby="uc-title" style="position:fixed;z-index:2147483647;' +
      (blocking ? 'top:50%;left:50%;transform:translate(-50%,-50%);width:560px;' : 'left:0;right:0;bottom:0;') +
      'background:#fff;color:#303030;padding:20px;font:14px/1.45 sans-serif">' +
      '<h2 id="uc-title" style="margin:0 0 8px">Datenschutz-Einstellungen</h2>' +
      '<p>Wir verwenden Cookies und ähnliche Technologien. Mit „Alle akzeptieren" willigen Sie in die Verarbeitung durch Drittanbieter ein. <a href="/datenschutz.html">Datenschutzerklärung</a></p>' +
      '<div style="display:flex;gap:8px">' +
      '<button type="button" data-action-type="more" style="padding:10px 14px;background:#fff;color:#0045a5;border:1px solid #0045a5">Einstellungen</button>' +
      (blocking ? '' : '<button type="button" data-action-type="deny" style="padding:10px 14px;background:#0045a5;color:#fff;border:0">Ablehnen</button>') +
      '<button type="button" data-action-type="accept" style="padding:10px 14px;background:#0045a5;color:#fff;border:0">Alle akzeptieren</button>' +
      '</div></div>';
    if (blocking) document.documentElement.style.overflow = 'hidden';
    function close(all) {
      if (!(variant === 'broken-deny' && !all)) decide(all);
      host.remove();
      document.documentElement.style.overflow = '';
    }
    root.querySelector('[data-action-type="accept"]').addEventListener('click', function () { close(true); });
    var deny = root.querySelector('[data-action-type="deny"]');
    if (deny) deny.addEventListener('click', function () { close(false); });
  }
  setTimeout(function () {
    if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
  }, 150);
})();
