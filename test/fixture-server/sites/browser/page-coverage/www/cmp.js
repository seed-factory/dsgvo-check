// Minimal hand-written consent banner for fixtures (not vendor code). Like some CMPs it adds a 4x4 helper frame far
// above the page, on every page.
(function () {
  var frame = document.createElement('iframe');
  frame.src = 'https://consent.example.net/frame.html';
  frame.title = 'Consent helper';
  frame.style.cssText = 'position:absolute;top:-9999px;left:0;width:4px;height:4px;border:0';
  document.body.appendChild(frame);

  function has(v) { return document.cookie.split('; ').indexOf('stub_consent=' + v) >= 0; }
  function hide() { document.getElementById('stub-cmp').style.display = 'none'; }
  window.StubCmp = { state: function () { return has('granted') ? 'granted' : has('denied') ? 'denied' : 'unknown'; } };
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
