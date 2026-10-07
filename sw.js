// Offline app shell. When you upload new files, bump VERSION here and the ?v= numbers in index.html.
const VERSION = 'waldo-supply-v20';
const SHELL = ['./', 'index.html', 'app.js?v=20', 'parser.js?v=20', 'niimbluelib.js?v=20', 'qr.js?v=20', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Always try the network first, skipping the browser's HTTP cache, so a new upload shows up on the next open.
// Falls back to the saved copy only when offline. Sync calls (other sites) are never touched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: false })
      .then((r) => r || caches.match(e.request, { ignoreSearch: true }))
      .then((r) => r || caches.match('index.html')))
  );
});
