/* Own minimal CCM19 simulator for integration tests (no vendor code). Mimics public identifiers only:
   window.CCM (acceptedEmbeddings, embeddings), #ccm-widget.ccm-modal, .ccm-modal-inner, .ccm--ctrl-init,
   .ccm--decline-cookies, [data-full-consent], [data-ccm-modal="ccm-control-panel"], localStorage "ccm_consent".
   Lifecycle as in CCM19: the widget is rendered into the page at once, hidden and with every control disabled, and
   opened later by showing it and enabling the controls; with an answer stored it stays closed.
   Variants (data-sim-variant): reject (default), blocking (no reject, overlay, scroll lock), not-opened (never
   opens), template (opens without `ccm-show` and keeps a hidden nested modal template). */
(function () {
  var script = document.currentScript;
  var variant = (script && script.getAttribute('data-sim-variant')) || 'reject';
  var OPEN_DELAY_MS = 500;
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

  var blocking = variant === 'blocking';
  function render() {
    var w = document.createElement('div');
    w.id = 'ccm-widget';
    w.className = 'ccm-modal ccm-widget';
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-modal', String(blocking));
    w.setAttribute('aria-labelledby', 'ccm-title');
    w.hidden = true;
    w.style.cssText = 'display:none;position:fixed;z-index:99999;left:0;right:0;bottom:24px;margin:0 auto;width:640px;font:14px/1.45 sans-serif';
    w.innerHTML =
      '<div class="ccm-modal--overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);' + (blocking ? '' : 'display:none') + '"></div>' +
      '<div class="ccm-modal-inner" style="position:relative;padding:20px;background:#fff;color:#222">' +
      '<div class="ccm-modal--header"><select class="ccm-widget--language-select ccm--ctrl-init" aria-label="Sprache"><option selected>Deutsch</option><option>English</option></select></div>' +
      '<h2 id="ccm-title" style="margin-top:0">Cookie-Einstellungen</h2>' +
      '<p>Diese Website verwendet Cookies und ähnliche Technologien (Embeddings). Ihre Einwilligung ist freiwillig. <a href="/datenschutz.html">Datenschutzerklärung</a> · <a href="/impressum.html">Impressum</a></p>' +
      '<div class="ccm-widget--buttons" style="display:flex;gap:8px">' +
      '<button type="button" class="ccm--ctrl-init" data-ccm-modal="ccm-control-panel" aria-haspopup="dialog" disabled style="padding:10px;color:#0074b3;background:#fff;border:1px solid #0074b3">Einstellungen</button>' +
      (blocking ? '' : '<button type="button" class="button ccm--decline-cookies ccm--ctrl-init" disabled style="padding:10px 16px;background:#0074b3;color:#fff;border:0">Ablehnen</button>') +
      '<button type="button" class="button ccm--save-settings ccm--button-primary ccm--ctrl-init" data-full-consent="true" disabled style="padding:10px 16px;background:#0074b3;color:#fff;border:0">Alle akzeptieren</button>' +
      '</div>' +
      (variant === 'template' ? '<div class="ccm-modal ccm-details" hidden><button type="button" class="ccm--ctrl-init" disabled>Zurück</button></div>' : '') +
      '</div>';
    document.body.appendChild(w);

    var controls = w.querySelectorAll('.ccm--ctrl-init');
    function close(all) {
      decide(all);
      w.classList.remove('ccm-show');
      w.hidden = true;
      w.style.display = 'none';
      document.body.style.overflow = '';
    }
    w.querySelector('[data-full-consent="true"]').addEventListener('click', function () { close(true); });
    var dec = w.querySelector('.ccm--decline-cookies');
    if (dec) dec.addEventListener('click', function () { close(false); });

    function open() {
      w.hidden = false;
      w.style.display = 'block';
      if (variant !== 'template') w.classList.add('ccm-show');
      for (var i = 0; i < controls.length; i++) controls[i].disabled = false;
      if (blocking) document.body.style.overflow = 'hidden';
    }
    if (!stored && variant !== 'not-opened') setTimeout(open, OPEN_DELAY_MS);
  }
  if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
})();
