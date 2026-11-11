// Fake analytics for the e2e fixture (no real tracking). The values carry the marker E2ESECRET so the test can
// assert that no cookie or storage value reaches any report.
(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: the fixture imitates a classic analytics snippet
  document.cookie = '_ga=GA1.1.E2ESECRET-GA-4711.1730000000; path=/; max-age=63072000; SameSite=Lax';
  try {
    localStorage.setItem('_e2e_tracker_id', 'E2ESECRET-STORAGE-4711');
  } catch {}
  const img = new Image();
  img.src = 'https://www.google-analytics.com/g/collect?v=2&tid=G-E2ETEST&cid=4711.1730000000&en=page_view';
})();
