/* Own minimal Real Cookie Banner simulator for L2 tests (no vendor code). Mimics public identifiers only:
   window.consentApi, div[consent-skip-blocker="1"][data-bg] with a random (digit-leading) id and a dialog,
   anchors with role=button, cookie real_cookie_banner-… = uuid:revision:{groupId:[cookieIds]},
   accept-all-for-bots with an isbot-like UA pattern. */
(function () {
  var opts = window.realCookieBanner;
  var sim = opts.sim || {};
  var COOKIE = 'real_cookie_banner-v:3_blog:1_path:sim';
  function getCookie() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(COOKIE + '=') === 0) return decodeURIComponent(p.slice(COOKIE.length + 1));
    }
    return null;
  }
  function save(all) {
    var groups = {};
    for (var i = 0; i < opts.groups.length; i++) {
      var g = opts.groups[i];
      if (g.isEssential || all) groups[g.id] = [g.id * 10 + 1];
    }
    var v = '1d5e1b5a-0000-4000-8000-00000000c0de:rev1:' + JSON.stringify(groups);
    document.cookie = COOKIE + '=' + encodeURIComponent(v) + '; path=/; max-age=31536000; SameSite=Lax';
  }
  window.consentApi = {
    consent: function () { return Promise.resolve(); },
    consentAll: function () { return Promise.resolve(); },
    consentSync: function () { return { cookie: null, consentGiven: !!getCookie(), cookieOptIn: true }; },
    unblock: function () { return Promise.resolve(); }
  };
  var isBot = /bot|crawl|spider|slurp|headless|lighthouse|http|\.com\b|scan|check|monitor|fetch|curl|wget|python/i.test(navigator.userAgent);
  if (getCookie()) return;
  if (isBot && opts.isAcceptAllForBots) { save(true); return; }

  function render() {
    var root = document.createElement('div');
    root.setAttribute('consent-skip-blocker', '1');
    root.id = '4a1f9c2e-7d3b-4f6a-9e21-5c8d0b7a3e11';
    root.setAttribute('data-bg', 'rgba(0, 0, 0, 0.5)');
    root.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center';
    var btn = 'display:block;margin:6px 0;padding:10px;text-align:center;text-decoration:none;';
    root.innerHTML =
      '<dialog open aria-modal="true" aria-labelledby="rcb-h" style="position:static;width:520px;border:0;padding:24px;background:#fff;color:#2b2b2b;font:15px/1.45 sans-serif">' +
      '<div id="rcb-h" style="font-weight:bold;font-size:18px">Privatsphäre-Einstellungen</div>' +
      '<p>Wir benötigen deine Einwilligung, bevor du unsere Website weiter besuchen kannst. Wir verwenden Cookies und ähnliche Technologien von Drittanbietern.</p>' +
      '<div>' +
      '<a role="button" tabindex="0" style="' + btn + 'background:#15779b;color:#fff">Alle akzeptieren</a>' +
      (sim.reject ? '<a role="button" tabindex="0" style="' + btn + 'background:#15779b;color:#fff">Weiter ohne Einwilligung</a>' : '') +
      '<a href="#" style="' + btn + 'color:#15779b">Individuelle Privatsphäre-Einstellungen</a>' +
      '</div>' +
      '<p style="font-size:12px"><a href="/datenschutz/">Datenschutzerklärung</a> • <a href="/impressum/">Impressum</a></p>' +
      '</dialog>';
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    var anchors = root.querySelectorAll('a[role="button"]');
    function close(all) { save(all); root.remove(); document.body.style.overflow = ''; }
    anchors[0].addEventListener('click', function () { close(true); });
    if (anchors[1]) anchors[1].addEventListener('click', function () { close(false); });
  }
  if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
})();
