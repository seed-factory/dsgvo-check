/* Own minimal simulator of the Shopware 6 cookie bar for integration tests (no vendor code). Mimics public identifiers
   only: .cookie-permission-container[data-cookie-permission], .js-cookie-permission-button, .js-cookie-accept-all-button,
   .js-cookie-configuration-button, the answer cookie "cookie-preference" and one cookie per optional cookie of the
   installation (here "fixture-stats-enabled"). Accepting loads the local fake tracker. */
(function () {
  function has(name) {
    return document.cookie.split(';').some(function (c) { return c.trim().indexOf(name + '=') === 0; });
  }
  function set(name) {
    document.cookie = name + '=1; path=/; max-age=2592000; SameSite=Lax';
  }
  function loadTracker() {
    var s = document.createElement('script');
    s.src = 'https://stats.shopware.test/t.js';
    document.head.appendChild(s);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (has('fixture-stats-enabled')) loadTracker();
    var bar = document.querySelector('.cookie-permission-container[data-cookie-permission]');
    if (!bar || has('cookie-preference')) return;

    bar.style.display = 'block';
    function decide(acceptAll) {
      set('cookie-preference');
      if (acceptAll) {
        set('fixture-stats-enabled');
        loadTracker();
      }
      bar.style.display = 'none';
    }
    bar.querySelector('.js-cookie-permission-button button').addEventListener('click', function () { decide(false); });
    bar.querySelector('.js-cookie-accept-all-button button').addEventListener('click', function () { decide(true); });
    bar.querySelector('.js-cookie-configuration-button button').addEventListener('click', function () {});
  });
})();
