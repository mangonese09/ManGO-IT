// ── SERVICE WORKER ──
// App shell cache-first; /api/* never cached here (js/api.js owns API caching
// with staleness stamps). Bump CACHE on every deploy.
const CACHE = 'mangoit-v8';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css?v=0.4.0',
  '/js/app.js?v=0.4.0',
  '/js/api.js',
  '/js/board.js',
  '/js/mapview.js',
  '/js/operators.js',
  '/js/saved.js',
  '/js/search.js',
  '/js/settings.js',
  '/js/store.js',
  '/js/time.js',
  '/js/toast.js',
  '/js/ui.js',
  '/js/version.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/logo.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/version.json') return; // update checks must hit network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((hit) => hit ||
      fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())),
    ),
  );
});
