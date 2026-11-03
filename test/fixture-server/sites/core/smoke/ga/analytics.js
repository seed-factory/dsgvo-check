// Fake analytics: sends a hit with a client id (fixture data, no real tracking).
(() => {
  var img = new Image();
  img.src = 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&cid=111.222&en=page_view';
  document.cookie = '_ga=GA1.1.111.222; path=/; max-age=63072000';
})();
