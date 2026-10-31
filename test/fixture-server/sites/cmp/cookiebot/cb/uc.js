/* Own minimal Cookiebot simulator for L2 tests (no vendor code). Mimics public identifiers only:
   window.Cookiebot API fields, #CybotCookiebotDialog ids, CookieConsent cookie, isSpider/isOutOfRegion. */
(function () {
  var script = document.currentScript;
  var cfg = {
    variant: (script && script.getAttribute('data-sim-variant')) || 'reject',
    region: (script && script.getAttribute('data-sim-region')) || 'eu',
    // Render delay in ms after the API is ready (late banners such as Borlabs 3 on some sites).
    delay: Number((script && script.getAttribute('data-sim-delay')) || 0),
    // Appearance animation of the dialog in ms (CSS transition from below the viewport, opacity 0 → 1).
    transition: Number((script && script.getAttribute('data-sim-transition')) || 0),
    // Hidden vendor toggles placed before the visible buttons in the DOM (a long second-layer vendor list).
    vendors: Number((script && script.getAttribute('data-sim-vendors')) || 0),
    // Dialog pushed below the viewport by this many px (settled geometry, buttons unreachable).
    offset: Number((script && script.getAttribute('data-sim-offset')) || 0),
    // A dialog that keeps moving by script (never settles).
    wobble: (script && script.getAttribute('data-sim-wobble')) === '1'
  };
  var CATS = ['preferences', 'statistics', 'marketing'];

  function getCookie(name) {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
    }
    return null;
  }
  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
  }

  var CB = {
    consent: { necessary: true, preferences: false, statistics: false, marketing: false, method: null, stamp: '0' },
    consented: false,
    declined: false,
    hasResponse: false,
    isOutOfRegion: false,
    regulations: { gdprApplies: true },
    isSpider: function () {
      return /Googlebot\/|bingbot\/|Chrome-Lighthouse|PTST\/|Prerender\//.test(navigator.userAgent);
    }
  };
  window.Cookiebot = CB;
  window.CookieConsent = CB;

  function apply(all, method, responded) {
    for (var i = 0; i < CATS.length; i++) CB.consent[CATS[i]] = all;
    CB.consent.method = method;
    CB.consented = all;
    CB.declined = !all;
    CB.hasResponse = responded;
  }
  function persist(all) {
    var v = "{stamp:'sim'";
    v += ',necessary:true';
    for (var i = 0; i < CATS.length; i++) v += ',' + CATS[i] + ':' + (all ? 'true' : 'false');
    v += ",method:'explicit',ver:1,region:'de'}";
    setCookie('CookieConsent', v);
  }
  function outOfRegion() {
    CB.isOutOfRegion = true;
    apply(true, 'implied', false);
    setCookie('CookieConsent', '-1');
  }

  if (CB.isSpider()) return outOfRegion();
  if (cfg.region !== 'eu') {
    CB.regulations.gdprApplies = false;
    return outOfRegion();
  }
  var stored = getCookie('CookieConsent');
  if (stored) {
    var all = /marketing:true/.test(stored);
    apply(all, 'explicit', true);
    return;
  }

  function render() {
    var blocking = cfg.variant === 'blocking';
    if (blocking) {
      var under = document.createElement('div');
      under.id = 'CybotCookiebotDialogBodyUnderlay';
      under.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483630';
      document.body.appendChild(under);
      document.documentElement.style.overflow = 'hidden';
    }
    var d = document.createElement('div');
    d.id = 'CybotCookiebotDialog';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', blocking ? 'true' : 'false');
    d.setAttribute('aria-label', 'Cookie-Banner');
    d.style.cssText =
      'position:fixed;left:0;right:0;bottom:' + (cfg.offset > 0 ? '-' + cfg.offset : '0') + 'px;z-index:2147483631;background:#fff;color:#141414;padding:16px 24px;' +
      'font:15px/1.4 sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.3)';
    var vendorList = '';
    if (cfg.vendors > 0) {
      vendorList = '<div id="CybotCookiebotDialogVendorList" style="display:none">';
      for (var v = 0; v < cfg.vendors; v++) {
        vendorList += '<button type="button" class="vendor-toggle" aria-label="Anbieter ' + (v + 1) + '">Anbieter ' + (v + 1) + '</button>';
      }
      vendorList += '</div>';
    }
    d.innerHTML =
      '<h2 style="margin:0 0 8px">Diese Webseite verwendet Cookies</h2>' +
      '<p style="margin:0 0 12px">Wir verwenden Cookies, um Inhalte zu personalisieren und Zugriffe zu analysieren. ' +
      'Weitere Informationen in der <a href="/datenschutz.html">Datenschutzerklärung</a>.</p>' +
      vendorList +
      '<div id="CybotCookiebotDialogDetail" style="display:none">' +
      '<label><input type="checkbox" id="CybotCookiebotDialogBodyLevelButtonStatistics"> Statistiken</label>' +
      '<button id="CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll" type="button">Alle ablehnen</button>' +
      '<button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection" type="button">Auswahl erlauben</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
      (blocking ? '' : '<button id="CybotCookiebotDialogBodyButtonDecline" type="button" style="padding:10px 18px;background:#fff;color:#1032cf;border:2px solid #1032cf">Ablehnen</button>') +
      '<button id="CybotCookiebotDialogBodyLevelButtonCustomize" type="button" style="padding:10px 18px;background:#fff;color:#1032cf;border:2px solid #1032cf">Anpassen</button>' +
      '<button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" type="button" style="padding:10px 18px;background:#1032cf;color:#fff;border:2px solid #1032cf">Alle zulassen</button>' +
      '</div>';
    if (cfg.transition > 0) {
      d.style.transform = 'translateY(100%)';
      d.style.opacity = '0';
      document.body.appendChild(d);
      void d.offsetHeight;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          d.style.transition = 'transform ' + cfg.transition + 'ms linear, opacity ' + cfg.transition + 'ms linear';
          d.style.transform = 'translateY(0)';
          d.style.opacity = '1';
        });
      });
    } else {
      document.body.appendChild(d);
    }
    if (cfg.wobble) {
      // Position derived from the clock: two readings 200 ms apart never see the same geometry.
      setInterval(function () {
        d.style.transform = 'translateY(-' + (Math.round(performance.now() / 20) % 24) + 'px)';
      }, 10);
    }

    function close(all) {
      apply(all, 'explicit', true);
      persist(all);
      d.style.display = 'none';
      var u = document.getElementById('CybotCookiebotDialogBodyUnderlay');
      if (u) u.remove();
      document.documentElement.style.overflow = '';
    }
    var decline = document.getElementById('CybotCookiebotDialogBodyButtonDecline');
    if (decline) decline.addEventListener('click', function () { close(false); });
    document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll').addEventListener('click', function () { close(false); });
    document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').addEventListener('click', function () { close(true); });
    document.getElementById('CybotCookiebotDialogBodyLevelButtonCustomize').addEventListener('click', function () {
      document.getElementById('CybotCookiebotDialogDetail').style.display = 'block';
    });
  }
  function start() {
    if (cfg.delay > 0) setTimeout(render, cfg.delay);
    else render();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
