/* Own minimal simulator of the TYPO3 extension cookieman for integration tests (no vendor code). Mimics public
   identifiers only: window.cookieman (showOnce, show, hide, hasConsented), #cookieman-modal with
   data-cookieman-settings, the data-cookieman-accept-none / -accept-all / -save buttons, the group checkboxes and the
   cookie "CookieConsent" listing the accepted groups separated by "|". Accepting "marketing" loads the local tracker. */
(function () {
  function stored() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('CookieConsent=') === 0) return decodeURIComponent(p.slice('CookieConsent='.length)).split('|');
    }
    return null;
  }
  function loadTracker() {
    var s = document.createElement('script');
    s.src = 'https://stats.cookieman.test/t.js';
    document.head.appendChild(s);
  }
  function modal() { return document.getElementById('cookieman-modal'); }
  function backdrop() { return document.querySelector('.modal-backdrop'); }

  function show() {
    var m = modal();
    if (!m) return;
    m.classList.add('show');
    m.style.display = 'block';
    var b = document.createElement('div');
    b.className = 'modal-backdrop fade show';
    document.body.appendChild(b);
    document.body.classList.add('modal-open');
  }
  function hide() {
    var m = modal();
    if (m) { m.classList.remove('show'); m.style.display = 'none'; }
    var b = backdrop();
    if (b) b.remove();
    document.body.classList.remove('modal-open');
  }
  function save() {
    var boxes = modal().querySelectorAll('[data-cookieman-form] input[type=checkbox]');
    var groups = [];
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) groups.push(boxes[i].name);
    document.cookie = 'CookieConsent=' + encodeURIComponent(groups.join('|')) + '; path=/; max-age=31536000; SameSite=Lax';
    if (groups.indexOf('marketing') !== -1) loadTracker();
    hide();
  }
  function setOptional(checked) {
    var boxes = modal().querySelectorAll('[data-cookieman-form] input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) if (!boxes[i].disabled) boxes[i].checked = checked;
  }

  window.cookieman = {
    show: show,
    hide: hide,
    showOnce: function () { if (stored() === null) show(); },
    hasConsented: function (group) { var s = stored(); return !!s && s.indexOf(group) !== -1; }
  };

  document.addEventListener('DOMContentLoaded', function () {
    var m = modal();
    if (!m) return;
    var s = stored();
    if (s && s.indexOf('marketing') !== -1) loadTracker();

    var none = m.querySelector('[data-cookieman-accept-none]');
    if (none) none.addEventListener('click', function () { setOptional(false); });
    var all = m.querySelector('[data-cookieman-accept-all]');
    if (all) all.addEventListener('click', function () { setOptional(true); });
    // Registered after accept-none and accept-all, so the save of those buttons sees their selection.
    var saves = m.querySelectorAll('[data-cookieman-save]');
    for (var i = 0; i < saves.length; i++) saves[i].addEventListener('click', save);
    var toggle = m.querySelector('[data-target="#cookieman-settings"]');
    toggle.addEventListener('click', function () {
      var settings = document.getElementById('cookieman-settings');
      var open = settings.style.display === 'block';
      settings.style.display = open ? 'none' : 'block';
      m.querySelector('[data-cookieman-save]:not([data-cookieman-accept-none]):not([data-cookieman-accept-all])').style.display = open ? 'none' : '';
    });
    if (m.getAttribute('data-cookieman-showonce') === '1') window.cookieman.showOnce();
  });
})();
