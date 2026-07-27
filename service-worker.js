// ── SERVICE WORKER ──
// App shell cache-first; /api/* never cached here (js/api.js owns API caching
// with staleness stamps). Bump CACHE on every deploy.
const CACHE = 'mangoit-v22';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css?v=0.9.0',
  '/js/app.js?v=0.9.0',
  '/js/api.js',
  '/js/board.js',
  '/js/itinerary.js',
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
  '/icons/modes/train.png',
  '/icons/modes/bus.png',
  '/icons/modes/pedestrian.png',
  '/icons/home.png',
  '/icons/place-pin.png',
  '/icons/gear.svg',
  '/icons/mango-mini.svg',
  '/icons/spinner-mango.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the HTTP cache: unversioned module URLs
  // (/js/saved.js …) must be fetched fresh from the server, or a new SW
  // precaches STALE modules next to a fresh index.html (torn app state —
  // the ManGO classic v8.34.2 bug, reproduced here on the Saved tab).
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
