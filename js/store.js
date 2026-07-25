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
export function getRecents() { return read('recents', []); }
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

export function clearAllAppData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}
