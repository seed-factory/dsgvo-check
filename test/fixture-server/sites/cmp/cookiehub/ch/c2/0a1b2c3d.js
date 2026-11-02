/* Own minimal CookieHub simulator for integration tests (no vendor code). Mimics public identifiers only:
   window.cookiehub (load, hasAnswered, hasConsented), .ch2 > .ch2-container > .ch2-dialog, .ch2-*-btn classes,
   settings layer .ch2-settings, cookie "cookiehub". */
(function () {
  var CATS = ['preferences', 'analytics', 'marketing'];
  // Categories this installation offers (cpm.simCategories); an unconfigured category reads as "not consented".
  var configured = CATS;
  function getCookie() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('cookiehub=') === 0) return p.slice('cookiehub='.length);
    }
    return null;
  }
  var state = null;
  try { var raw = getCookie(); if (raw) state = JSON.parse(atob(decodeURIComponent(raw))); } catch (e) { state = null; }
  function save(all) {
    var categories = { necessary: true };
    for (var i = 0; i < configured.length; i++) categories[configured[i]] = all;
    state = { answered: true, categories: categories };
    document.cookie = 'cookiehub=' + encodeURIComponent(btoa(JSON.stringify(state))) + '; path=/; max-age=31536000; SameSite=Lax';
  }
  window.cookiehub = {
    load: function (cpm) {
      if (cpm && cpm.simCategories) configured = cpm.simCategories;
      if (state) return;
      render((cpm && cpm.simVariant) || 'reject');
    },
    hasAnswered: function () { return !!(state && state.answered); },
    hasConsented: function (cat) { return cat === 'necessary' || !!(state && state.categories[cat]); },
    openSettings: function () {}
  };
  function render(variant) {
    var blocking = variant === 'blocking';
    var s = document.createElement('section');
    s.className = 'ch2';
    var btn = 'padding:10px 14px;border:0;margin:4px;';
    s.innerHTML =
      '<div class="ch2-container ch2-theme-default">' +
      (blocking ? '<div class="ch2-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483640"></div>' : '') +
      '<div class="ch2-dialog ch2-dialog-' + (blocking ? 'center' : 'bottom') + '" role="dialog" aria-modal="' + blocking + '" aria-labelledby="ch2-dialog-title" style="position:fixed;z-index:2147483641;' +
      (blocking ? 'top:50%;left:50%;transform:translate(-50%,-50%);width:540px;' : 'left:0;right:0;bottom:0;') + 'background:#fff;color:#222;padding:20px;font:14px/1.45 sans-serif">' +
      '<p id="ch2-dialog-title" style="font-weight:bold">Wir verwenden Cookies</p>' +
      '<p class="ch2-dialog-description">Wir verwenden Cookies, um Inhalte zu personalisieren und unseren Datenverkehr zu analysieren. <a href="/datenschutz.html" class="ch2-learn-more">Mehr erfahren</a></p>' +
      '<div class="ch2-dialog-actions">' +
      '<button type="button" class="ch2-btn ch2-btn-text ch2-open-settings-btn" style="' + btn + 'background:#eee;color:#222">Einstellungen</button>' +
      (blocking ? '' : '<button type="button" class="ch2-btn ch2-btn-secondary ch2-deny-all-btn" style="' + btn + 'background:#14315c;color:#fff">Alle ablehnen</button>') +
      '<button type="button" class="ch2-btn ch2-btn-primary ch2-allow-all-btn" style="' + btn + 'background:#14315c;color:#fff">Alle zulassen</button>' +
      '</div></div>' +
      '<div class="ch2-settings" role="dialog" aria-label="Cookie-Einstellungen" style="display:none">' +
      '<button type="button" class="ch2-btn ch2-deny-all-btn">Alle ablehnen</button>' +
      '<button type="button" class="ch2-btn ch2-save-settings-btn">Einstellungen speichern</button>' +
      '</div></div>';
    document.body.appendChild(s);
    if (blocking) document.body.style.overflow = 'hidden';
    function close(all) { save(all); s.remove(); document.body.style.overflow = ''; }
    s.querySelector('.ch2-allow-all-btn').addEventListener('click', function () { close(true); });
    var denies = s.querySelectorAll('.ch2-deny-all-btn');
    for (var i = 0; i < denies.length; i++) denies[i].addEventListener('click', function () { close(false); });
    s.querySelector('.ch2-open-settings-btn').addEventListener('click', function () {
      s.querySelector('.ch2-settings').style.display = 'block';
    });
  }
})();
