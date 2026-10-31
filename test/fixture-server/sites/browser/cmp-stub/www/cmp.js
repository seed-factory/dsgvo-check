// Minimal hand-written consent banner for fixtures (not vendor code).
(function () {
  function has(v) { return document.cookie.split('; ').indexOf('stub_consent=' + v) >= 0; }
  function loadGa() {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-TEST123';
    document.head.appendChild(s);
  }
  function hide() { document.getElementById('stub-cmp').style.display = 'none'; }
  window.StubCmp = { state: function () { return has('granted') ? 'granted' : has('denied') ? 'denied' : 'unknown'; } };
  if (has('granted')) { hide(); loadGa(); return; }
  if (has('denied')) { hide(); return; }
  document.getElementById('stub-accept').addEventListener('click', function () {
    document.cookie = 'stub_consent=granted; path=/; max-age=31536000';
    hide();
    loadGa();
  });
  document.getElementById('stub-reject').addEventListener('click', function () {
    document.cookie = 'stub_consent=denied; path=/; max-age=31536000';
    hide();
  });
})();
