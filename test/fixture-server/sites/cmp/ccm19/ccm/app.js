/* Own minimal CCM19 simulator for L2 tests (no vendor code). Mimics public identifiers only:
   window.CCM (acceptedEmbeddings, embeddings), #ccm-widget.ccm-show, .ccm--decline-cookies,
   [data-full-consent], localStorage "ccm_consent". The widget is injected late, like the real one. */
(function () {
  var script = document.currentScript;
  var variant = (script && script.getAttribute('data-sim-variant')) || 'reject';
  var EMBEDDINGS = [
    { id: 'e1', name: 'CCM19 Cookie Consent Manager' },
    { id: 'e2', name: 'Google Analytics' },
    { id: 'e3', name: 'Google Maps' }
  ];
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('ccm_consent') || 'null'); } catch (e) {}
  function accepted() {
    if (!stored) return [EMBEDDINGS[0]];
    return EMBEDDINGS.filter(function (e) { return stored.embeddings.indexOf(e.id) >= 0; });
  }
  var CCM = { embeddings: EMBEDDINGS.slice(), acceptedEmbeddings: accepted(), consent: !!stored };
  window.CCM = CCM;
  function decide(all) {
    stored = { embeddings: all ? ['e1', 'e2', 'e3'] : ['e1'], ts: 1 };
    localStorage.setItem('ccm_consent', JSON.stringify(stored));
    CCM.acceptedEmbeddings = accepted();
    CCM.consent = true;
  }
  if (stored) return;
  function render() {
    var blocking = variant === 'blocking';
    var w = document.createElement('div');
    w.id = 'ccm-widget';
    w.className = 'ccm-widget ccm-show';
    w.innerHTML =
      '<div class="ccm-modal--overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;' + (blocking ? '' : 'display:none') + '"></div>' +
      '<div class="ccm-modal" role="dialog" aria-modal="' + blocking + '" aria-labelledby="ccm-title" style="position:fixed;z-index:99999;left:50%;bottom:24px;transform:translateX(-50%);width:640px;background:#fff;color:#222;font:14px/1.45 sans-serif">' +
      '<div class="ccm-modal-inner" style="padding:20px">' +
      '<h2 id="ccm-title" style="margin-top:0">Cookie-Einstellungen</h2>' +
      '<p>Diese Website verwendet Cookies und ähnliche Technologien (Embeddings). Ihre Einwilligung ist freiwillig. <a href="/datenschutz.html">Datenschutzerklärung</a> · <a href="/impressum.html">Impressum</a></p>' +
      '<div class="ccm-modal-footer" style="display:flex;gap:8px">' +
      '<a href="#" class="ccm--ctrl-init" role="button" style="padding:10px;color:#0074b3">Einstellungen</a>' +
      (blocking ? '' : '<button type="button" class="ccm--decline-cookies ccm--button-primary" style="padding:10px 16px;background:#0074b3;color:#fff;border:0">Ablehnen</button>') +
      '<button type="button" class="ccm--save-settings ccm--button-primary" data-full-consent="true" style="padding:10px 16px;background:#0074b3;color:#fff;border:0">Alle akzeptieren</button>' +
      '</div></div></div>';
    document.body.appendChild(w);
    if (blocking) document.body.style.overflow = 'hidden';
    function close(all, ev) { if (ev) ev.preventDefault(); decide(all); w.className = 'ccm-widget'; w.style.display = 'none'; document.body.style.overflow = ''; }
    w.querySelector('[data-full-consent="true"]').addEventListener('click', function () { close(true); });
    var dec = w.querySelector('.ccm--decline-cookies');
    if (dec) dec.addEventListener('click', function () { close(false); });
  }
  setTimeout(function () {
    if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
  }, 300);
})();
