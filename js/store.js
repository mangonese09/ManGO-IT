// ── STORAGE ADAPTER ──
// v1 backend is localStorage (single user, works offline on roaming).
// Firebase Auth + Firestore mirror is a planned fast-follow — keep all
// persistence behind these functions so the swap is one file.
//
// v1.7.0 (storage-durability design, 2026-08-09): this file is the ONLY door
// to localStorage. It owns the schema version + migration chain, quarantines
// unreadable user data instead of dropping it, evicts cache before ever
// failing a user-data write, and produces/consumes the backup format.
import { toast } from './toast.js';

const NS = 'mangoit.';
export const SCHEMA_VERSION = 2; // 1 = the pre-v1.7 unversioned shape

// Every key that holds USER state (preferences included). Cache and metadata
// keys are deliberately absent: they are disposable, these are not.
const USER_KEYS = ['settings', 'saved', 'favstops', 'places', 'recents', 'view', 'mapStyle', 'mapModes', 'modes'];

function rawGet(k) { try { return localStorage.getItem(NS + k); } catch { return null; } }
function rawDel(k) { try { localStorage.removeItem(NS + k); } catch { /* hostile storage */ } }

function read(key, fallback) {
  const raw = rawGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // Unreadable USER data is QUARANTINED, never dropped: the raw bytes move
    // aside so a later import/human can recover them. Cache is disposable.
    if (USER_KEYS.includes(key)) {
      try { localStorage.setItem(`${NS}__quarantine.${key}.${Date.now()}`, raw); } catch { /* keep booting */ }
    }
    rawDel(key);
    return fallback;
  }
}

function write(key, value) {
  const s = JSON.stringify(value);
  try {
    localStorage.setItem(NS + key, s);
    return true;
  } catch {
    if (!USER_KEYS.includes(key)) return false; // a cache write may fail silently
    // Quota: USER data wins over cache — evict every cache blob, retry once.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS + 'cache.')) localStorage.removeItem(k);
      }
      localStorage.setItem(NS + key, s);
      return true;
    } catch {
      try { toast('Could not save — device storage is full', 'warn'); } catch { /* headless */ }
      return false;
    }
  }
}

// ── SCHEMA MIGRATIONS ──
// migrateData lifts a {key: value} bag from `version` to SCHEMA_VERSION —
// shared by the boot migration and by importing an older backup file.
function fillIconModes(list) {
  return (list || []).map((s) => (s && !s.iconMode ? { ...s, iconMode: s.icon === '🚌' ? 'COACH' : 'BUS' } : s));
}
export function migrateData(version, data) {
  if (version < 2 && data.favstops) data.favstops = fillIconModes(data.favstops);
  return data;
}

function snapshotUserKeys() {
  const snap = {};
  for (const k of USER_KEYS) snap[k] = rawGet(k);
  try { localStorage.setItem(`${NS}__backup.v1`, JSON.stringify(snap)); } catch { /* best effort */ }
}
function restoreSnapshot() {
  const raw = rawGet('__backup.v1');
  if (raw === null) return;
  try {
    const snap = JSON.parse(raw);
    for (const k of USER_KEYS) {
      if (snap[k] === null || snap[k] === undefined) rawDel(k);
      else localStorage.setItem(NS + k, snap[k]);
    }
  } catch { /* the snapshot itself is gone — nothing to restore */ }
}

// Runs at module load (before any reader — every module reads through here).
// Exported so tests can exercise it against a seeded storage stub.
export function migrateStorage() {
  // A migration that died mid-flight leaves the flag set: restore the
  // pre-migration snapshot rather than proceeding on half-migrated data.
  if (rawGet('__migrating') !== null) restoreSnapshot();
  const v = Number(read('schemaVersion', 1)) || 1;
  if (v >= SCHEMA_VERSION) { rawDel('__migrating'); return; }
  snapshotUserKeys();
  try { localStorage.setItem(`${NS}__migrating`, '1'); } catch { /* private mode */ }
  // 1→2a: two stray keys predate this file owning them and hold RAW strings
  // ('home', 'auto') — re-encode as JSON so read() stops quarantining them.
  for (const k of ['view', 'mapStyle']) {
    const raw = rawGet(k);
    if (raw === null) continue;
    try { JSON.parse(raw); } catch { try { localStorage.setItem(NS + k, JSON.stringify(raw)); } catch { /* skip */ } }
  }
  // 1→2b: the favstops iconMode legacy patch moves here from saved.js —
  // one owner (this migration) instead of an inline fallback that never dies.
  // Only when the key exists: a fresh (or freshly-erased) device must not
  // grow an empty list it never had.
  if (rawGet('favstops') !== null) write('favstops', fillIconModes(read('favstops', [])));
  write('schemaVersion', SCHEMA_VERSION);
  rawDel('__migrating');
}
try { migrateStorage(); } catch { /* a broken storage layer must never block boot */ }

// ── settings ──
export function getSettings() {
  return Object.assign({ theme: 'dark' }, read('settings', {}));
}
export function patchSettings(patch) {
  write('settings', Object.assign(getSettings(), patch));
}

// ── small preferences (view / mapStyle / mapModes / modes) ──
// The four former stray keys — behind the same door as everything else.
export function getPref(key, fallback) { return read(key, fallback); }
export function setPref(key, value) { return write(key, value); }

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
  // SV-4: the cap evicts LOUDLY — a silently vanished favourite reads as a bug
  if (list.length > 12) {
    list.splice(0, list.length - 12);
    try { toast('Stop limit (12) reached — oldest removed', 'info', 2400); } catch { /* headless */ }
  }
  write('favstops', list);
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
  if (list.length > 20) {
    list.splice(0, list.length - 20);
    try { toast('Place limit (20) reached — oldest removed', 'info', 2400); } catch { /* headless */ }
  }
  write('places', list);
  return list;
}
export function removePlace(key) { write('places', getPlaces().filter((p) => p.key !== key)); }
export function isPlace(key) { return getPlaces().some((p) => p.key === key); }
// Set a place's chosen icon (one of PLACE_ICONS keys). Persists across renders.
export function setPlaceIcon(key, icon) {
  write('places', getPlaces().map((p) => (p.key === key ? { ...p, icon } : p)));
}
// key===null clears Home entirely; otherwise makes exactly that place Home.
// Marking Home adopts the house icon unless the user already picked a custom
// one; unsetting drops a defaulted house back to the neutral pin.
export function setHomePlace(key) {
  write('places', getPlaces().map((p) => {
    const home = p.key === key;
    let icon = p.icon;
    if (home && (!icon || icon === 'pin')) icon = 'home';
    else if (!home && icon === 'home') icon = 'pin';
    return { ...p, home, icon };
  }));
}
// Home first, Work second (SV-5), then most-recently-added.
const placeRank = (p) => (p.home ? 2 : p.icon === 'work' ? 1 : 0);
export function getPlacesSorted() { return getPlaces().slice().sort((a, b) => placeRank(b) - placeRank(a)); }

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

// ── BACKUP (export / import, storage-durability §6) ──
export function exportBackup() {
  const data = {};
  for (const k of USER_KEYS) {
    const v = read(k, null);
    if (v !== null) data[k] = v;
  }
  return { app: 'mangoit', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data };
}
// Counts for the confirm modal — the import names exactly what lands.
export function describeBackup(obj) {
  const d = (obj && obj.data) || {};
  const bits = [];
  const add = (n, word) => { if (n) bits.push(`${n} ${word}${n > 1 ? 's' : ''}`); };
  add((d.favstops || []).length, 'saved stop');
  add((d.places || []).length, 'place');
  add((d.recents || []).length, 'recent search');
  add((d.saved || []).length, 'saved departure');
  return bits.length ? bits.join(', ') : 'settings only';
}
export function importBackup(obj) {
  if (!obj || obj.app !== 'mangoit' || typeof obj.data !== 'object' || obj.data === null) {
    throw new Error('not a ManGO:IT backup');
  }
  const data = migrateData(Number(obj.schemaVersion) || 1, { ...obj.data });
  for (const k of USER_KEYS) {
    if (k in data && data[k] !== null && data[k] !== undefined) write(k, data[k]);
    else rawDel(k); // a backup REPLACES device state — absent keys clear
  }
  write('schemaVersion', SCHEMA_VERSION);
  return data;
}

export function quarantineCount() {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS + '__quarantine.')) n += 1;
  }
  return n;
}

// S-1: cache-only clear — "clear cache" must be SAFE by definition. User data
// (favstops, places, recents, saved, settings) is never touched here; erasing
// that is clearAllAppData, a separate deliberate action.
export function clearCachedData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith(NS + 'cache.') || k === NS + 'freshness')) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

export function clearAllAppData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}
