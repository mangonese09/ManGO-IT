// ── SERVICE WORKER ──
// App shell cache-first; /api/* never cached here (js/api.js owns API caching
// with staleness stamps). Bump CACHE on every deploy.
const CACHE = 'mangoit-v1100';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css?v=1.10.0',
  '/js/app.js?v=1.10.0',
  '/js/api.js',
  '/js/board.js',
  '/js/itinerary.js',
  '/js/mapview.js',
  '/js/city-labels.js',
  '/js/names.js',
  '/js/operators.js',
  '/js/fares-od.js',
  '/js/saved.js',
  '/js/search.js',
  '/js/settings.js',
  '/js/store.js',
  '/js/time.js',
  '/js/toast.js',
  '/js/ui.js',
  '/js/version.js',
  '/vendor/sicily-places.json',
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
  '/icons/mango-star.svg',
  '/icons/plane-mango.png',
  '/icons/calendar-mango.svg',
  '/icons/locate-mango.svg',
  '/icons/town-mango.svg',
  '/icons/spinner-mango.png',
  '/icons/places/place-home.svg',
  '/icons/places/place-work.svg',
  '/icons/places/place-pin.svg',
  '/icons/places/place-coffee.svg',
  '/icons/places/place-food.svg',
  '/icons/places/place-friend.svg',
  '/icons/places/place-gym.svg',
  '/icons/places/place-school.svg',
  '/icons/places/place-shopping.svg',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-shadow.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the HTTP cache: unversioned module URLs
  // (/js/saved.js …) must be fetched fresh from the server, or a new SW
  // precaches STALE modules next to a fresh index.html (torn app state —
  // the ManGO classic v8.34.2 bug, reproduced here on the Saved tab).
  //
  // Precache each asset INDEPENDENTLY (allSettled), not atomically (addAll):
  // one flaky/slow fetch used to reject the whole install, so the new SW never
  // activated and "Check for updates" silently no-op'd. A missing asset now
  // just falls back to the network at runtime instead of blocking the update.
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

// Let the page force an installed-but-waiting worker to take over immediately.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
      // Module cache-misses revalidate with the SERVER (v1.5.1): nginx serves
      // /js/* with max-age=86400, so a plain fetch could fill the cache with a
      // day-stale module next to a fresh shell — the torn state that bricked
      // the settings tab. 'no-cache' still rides ETags (cheap 304s).
      fetch(url.pathname.startsWith('/js/') ? new Request(e.request, { cache: 'no-cache' }) : e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())),
    ),
  );
});
