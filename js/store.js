// ── STORAGE ADAPTER ──
// v1 backend is localStorage (single user, works offline on roaming).
// Firebase Auth + Firestore mirror is a planned fast-follow — keep all
// persistence behind these functions so the swap is one file.

const NS = 'mangoit.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* quota — ignore */ }
}

// ── settings ──
export function getSettings() {
  return Object.assign({ theme: 'dark' }, read('settings', {}));
}
export function patchSettings(patch) {
  write('settings', Object.assign(getSettings(), patch));
}

// ── saved departures ──
export function getSaved() { return read('saved', []); }
export function saveDeparture(dep) {
  const all = getSaved();
  if (all.some((d) => d.id === dep.id)) return false;
  all.push(Object.assign({ savedAt: Date.now() }, dep));
  write('saved', all);
  return true;
}
export function removeSaved(id) {
  write('saved', getSaved().filter((d) => d.id !== id));
}
export function isSaved(id) { return getSaved().some((d) => d.id === id); }
// Drop departures more than 24h gone.
export function purgeSaved(now = Date.now()) {
  const keep = getSaved().filter((d) => !d.when || new Date(d.when).getTime() > now - 24 * 3600 * 1000);
  write('saved', keep);
  return keep;
}

// ── recent searches ──
// Favorite STOPS (whole departure boards on the Saved tab), any kind:
// train station / city bus / coach. Keyed by Transitous stopId when the
// stop has one, else by rounded coords (coach stops pre-ingestion).
export function getFavStops() { return read('favstops', []); }
export function addFavStop(stop) {
  const list = getFavStops().filter((s) => s.key !== stop.key);
  list.push(stop);
  write('favstops', list.slice(-12));
  return list;
}
export function removeFavStop(key) {
  write('favstops', getFavStops().filter((s) => s.key !== key));
}
export function isFavStop(key) { return getFavStops().some((s) => s.key === key); }

// ── FAVOURITE PLACES (trip endpoints: Home + named places) ──
// A place is a location you route to/from, distinct from a favourite STOP
// (a departures board). Keyed by rounded coords. At most one place is `home`.
export function getPlaces() { return read('places', []); }
export function addPlace(place) {
  let list = getPlaces().filter((p) => p.key !== place.key);
  if (place.home) list = list.map((p) => ({ ...p, home: false }));
  list.push(place);
  write('places', list.slice(-20));
  return list;
}
export function removePlace(key) { write('places', getPlaces().filter((p) => p.key !== key)); }
export function isPlace(key) { return getPlaces().some((p) => p.key === key); }
// key===null clears Home entirely; otherwise makes exactly that place Home.
export function setHomePlace(key) { write('places', getPlaces().map((p) => ({ ...p, home: p.key === key }))); }
// Home first, then most-recently-added.
export function getPlacesSorted() { return getPlaces().slice().sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0)); }

export function getRecents() { return read('recents', []); }
export function removeRecent(i) {
  const all = getRecents();
  all.splice(i, 1);
  write('recents', all);
}
export function pushRecent(entry) {
  const all = getRecents().filter((r) => !(r.from.name === entry.from.name && r.to.name === entry.to.name));
  all.unshift(entry);
  write('recents', all.slice(0, 6));
}

// ── api response cache (owned by api.js) ──
export function cacheRead(key) { return read('cache.' + key, null); }
export function cacheWrite(key, data) { write('cache.' + key, { data, fetchedAt: Date.now() }); }

// ── data freshness per source (Settings readout) ──
export function markFresh(source) {
  const f = read('freshness', {});
  f[source] = Date.now();
  write('freshness', f);
}
export function getFreshness() { return read('freshness', {}); }

// Drop API cache entries older than 48h — plan/geocode keys are per-query and
// would otherwise accumulate forever on a roaming phone.
export function pruneCache(maxAgeMs = 48 * 3600 * 1000, now = Date.now()) {
  const stale = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(NS + 'cache.')) continue;
    try {
      const { fetchedAt } = JSON.parse(localStorage.getItem(k));
      if (!fetchedAt || now - fetchedAt > maxAgeMs) stale.push(k);
    } catch { stale.push(k); }
  }
  stale.forEach((k) => localStorage.removeItem(k));
  return stale.length;
}

export function clearAllAppData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}
