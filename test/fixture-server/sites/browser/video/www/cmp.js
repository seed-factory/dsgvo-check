// Minimal hand-written consent banner for fixtures (not vendor code). It blocks nothing: the videos load either way.
(function () {
  function has(v) { return document.cookie.split('; ').indexOf('stub_consent=' + v) >= 0; }
  function hide() { document.getElementById('stub-cmp').style.display = 'none'; }
  // `stored`: the page read the decision from the cookie when it loaded, as after a reload or on a control page.
  window.StubCmp = {
    state: function () { return has('granted') ? 'granted' : has('denied') ? 'denied' : 'unknown'; },
    stored: has('granted') || has('denied')
  };
  if (has('granted') || has('denied')) { hide(); return; }
  document.getElementById('stub-accept').addEventListener('click', function () {
    document.cookie = 'stub_consent=granted; path=/; max-age=31536000';
    hide();
  });
  document.getElementById('stub-reject').addEventListener('click', function () {
    document.cookie = 'stub_consent=denied; path=/; max-age=31536000';
    hide();
  });
})();
