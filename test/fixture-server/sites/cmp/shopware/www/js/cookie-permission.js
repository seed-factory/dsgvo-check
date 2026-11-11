/* Own minimal simulator of the Shopware 6 cookie bar for integration tests (no vendor code). Mimics public identifiers
   only: .cookie-permission-container[data-cookie-permission], .js-cookie-permission-button, .js-cookie-accept-all-button,
   .js-cookie-configuration-button, window.router['frontend.cookie.offcanvas'], the answer cookie "cookie-preference"
   and one permission cookie per optional cookie of the installation, which the offcanvas lists as data-cookie.
   As in Shopware, "Nur technisch notwendige" sets the answer cookie and removes the analytics permission cookie, which
   is there only after an earlier answer. "Alle Cookies akzeptieren" first fetches the offcanvas and then sets every
   cookie it lists with a value, the answer cookie last, so the answer comes some time after the click. With the
   analytics permission cookie the page loads the tracker of data-sim-tracker (default: the local fake tracker). The
   values are test markers: no report may show them.
   Variants by attributes of the script tag:
   data-sim-deny="sets-flag"  the reject also sets the analytics permission cookie;
   data-sim-deny="no-answer"  the reject hides the bar and records nothing;
   data-sim-bar="always"      the bar shows even with an answer stored, as for an answer from before the scan. */
(function () {
  var script = document.currentScript;
  function attr(name) {
    return (script && script.getAttribute(name)) || '';
  }
  var deny = attr('data-sim-deny');
  var barAlways = attr('data-sim-bar') === 'always';
  var tracker = attr('data-sim-tracker') || 'https://stats.shopware.test/t.js';
  var ANSWER = 'cookie-preference';
  var ANALYTICS = 'google-analytics-enabled';
  var FLAG_VALUE = 'SECRET_SW_FLAG_7';

  function has(name) {
    return document.cookie.split(';').some(function (c) { return c.trim().indexOf(name + '=') === 0; });
  }
  function set(name, value) {
    document.cookie = name + '=' + value + '; path=/; max-age=2592000; SameSite=Lax';
  }
  function remove(name) {
    document.cookie = name + '=; path=/; max-age=0; SameSite=Lax';
  }
  function loadTracker() {
    var s = document.createElement('script');
    s.async = true;
    s.src = tracker;
    document.head.appendChild(s);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (has(ANALYTICS)) loadTracker();
    var bar = document.querySelector('.cookie-permission-container[data-cookie-permission]');
    if (!bar || (has(ANSWER) && !barAlways)) return;

    bar.style.display = 'block';
    function hide() {
      bar.style.display = 'none';
    }
    function reject() {
      hide();
      if (deny === 'no-answer') return;
      set(ANSWER, '1');
      if (deny === 'sets-flag') {
        set(ANALYTICS, FLAG_VALUE);
        loadTracker();
      } else {
        remove(ANALYTICS);
      }
    }
    function acceptAll() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', (window.router || {})['frontend.cookie.offcanvas']);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.onload = function () {
        var dom = new DOMParser().parseFromString(xhr.responseText, 'text/html');
        var listed = dom.querySelectorAll('[data-cookie]');
        for (var i = 0; i < listed.length; i++) {
          var name = listed[i].getAttribute('data-cookie');
          var value = listed[i].getAttribute('data-cookie-value');
          if (name && value && name !== ANSWER) set(name, value);
        }
        set(ANSWER, '1');
        hide();
        if (has(ANALYTICS)) loadTracker();
      };
      xhr.send();
    }
    bar.querySelector('.js-cookie-permission-button button').addEventListener('click', reject);
    bar.querySelector('.js-cookie-accept-all-button button').addEventListener('click', acceptAll);
    bar.querySelector('.js-cookie-configuration-button button').addEventListener('click', function () {});
  });
})();
