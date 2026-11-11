/* Own minimal Usercentrics v2 simulator for integration tests (no vendor code). Mimics public identifiers only:
   window.UC_UI (isInitialized, getServicesBaseInfo), shadow host #usercentrics-root with
   [data-testid="uc-default-banner"] and uc-*-button test ids, localStorage uc_settings / uc_user_interaction. */
(function () {
  var services = [
    { id: 'svc-uc', name: 'Usercentrics Consent Management Platform', categorySlug: 'essential', isEssential: true, consent: { status: true } },
    { id: 'svc-ga', name: 'Google Analytics', categorySlug: 'marketing', isEssential: false, consent: { status: false } },
    { id: 'svc-yt', name: 'YouTube Video', categorySlug: 'functional', isEssential: false, consent: { status: false } }
  ];
  try {
    var saved = JSON.parse(localStorage.getItem('uc_settings') || 'null');
    if (saved) for (var i = 0; i < services.length; i++) if (!services[i].isEssential) services[i].consent.status = !!saved[services[i].id];
  } catch (e) {}
  if (!localStorage.getItem('uc_user_interaction')) localStorage.setItem('uc_user_interaction', 'false');
  var initialized = false;
  window.UC_UI = {
    isInitialized: function () { return initialized; },
    getServicesBaseInfo: function () { return JSON.parse(JSON.stringify(services)); },
    areAllConsentsAccepted: function () { return services.every(function (s) { return s.consent.status; }); }
  };
  function decide(all) {
    var map = {};
    for (var i = 0; i < services.length; i++) {
      if (!services[i].isEssential) services[i].consent.status = all;
      map[services[i].id] = services[i].consent.status;
    }
    localStorage.setItem('uc_settings', JSON.stringify(map));
    localStorage.setItem('uc_user_interaction', 'true');
  }
  function render() {
    initialized = true;
    if (localStorage.getItem('uc_user_interaction') === 'true') return;
    var host = document.createElement('div');
    host.id = 'usercentrics-root';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<div data-testid="uc-default-banner" role="dialog" aria-label="Cookie-Banner" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#fff;color:#303030;padding:18px;font:14px/1.4 sans-serif">' +
      '<p>Wir nutzen Cookies und Dienste von Drittanbietern, um unsere Website zu verbessern.</p>' +
      '<button data-testid="uc-more-button" type="button">Mehr Informationen</button> ' +
      '<button data-testid="uc-deny-all-button" type="button">Ablehnen</button> ' +
      '<button data-testid="uc-accept-all-button" type="button">Alle akzeptieren</button>' +
      '</div>';
    function close(all) { decide(all); host.remove(); }
    root.querySelector('[data-testid="uc-accept-all-button"]').addEventListener('click', function () { close(true); });
    root.querySelector('[data-testid="uc-deny-all-button"]').addEventListener('click', function () { close(false); });
  }
  if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
})();
