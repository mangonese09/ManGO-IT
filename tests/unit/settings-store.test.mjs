// S-1 (settings deep dive, v1.5.0): "clear cache" must be SAFE by definition —
// clearCachedData may only ever remove cache.* blobs (+ the freshness
// metadata), never favourites, places, recents, saved departures or settings.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

import { test } from 'node:test';
import assert from 'node:assert';
const store = await import('../../js/store.js');

function seed() {
  mem.clear();
  store.addFavStop({ key: 's1', name: 'PALERMO CENTRALE' });
  store.addPlace({ key: 'p1', name: 'Mondello', lat: 38.2, lon: 13.3 });
  store.pushRecent({ from: { name: 'A' }, to: { name: 'B' } });
  store.patchSettings({ theme: 'light' });
  store.cacheWrite('geo:test', [1, 2, 3]);
  store.markFresh('transitous');
}

test('clearCachedData drops only cache + freshness', () => {
  seed();
  const n = store.clearCachedData();
  assert.ok(n >= 2, `expected >=2 keys cleared, got ${n}`);
  assert.strictEqual(store.cacheRead('geo:test'), null);
  assert.deepStrictEqual(store.getFreshness(), {});
  // user data survives — the whole point
  assert.strictEqual(store.getFavStops().length, 1);
  assert.strictEqual(store.getPlaces().length, 1);
  assert.strictEqual(store.getRecents().length, 1);
  assert.strictEqual(store.getSettings().theme, 'light');
});

// ── v1.7.0 storage durability ──

test('migration 1→2 fills iconMode and re-encodes raw stray keys', () => {
  mem.clear();
  mem.set('mangoit.favstops', JSON.stringify([{ key: 'k', name: 'X', icon: '🚌' }, { key: 'k2', name: 'Y', iconMode: 'RAIL' }]));
  mem.set('mangoit.view', 'saved');       // pre-v1.7 RAW string
  mem.set('mangoit.mapStyle', 'auto');    // pre-v1.7 RAW string
  store.migrateStorage();
  assert.strictEqual(store.getFavStops()[0].iconMode, 'COACH');
  assert.strictEqual(store.getFavStops()[1].iconMode, 'RAIL');
  assert.strictEqual(store.getPref('view', null), 'saved');
  assert.strictEqual(store.getPref('mapStyle', 'x'), 'auto');
  assert.strictEqual(JSON.parse(mem.get('mangoit.schemaVersion')), 2);
});

test('corrupt user data is quarantined, never silently dropped', () => {
  mem.clear();
  mem.set('mangoit.schemaVersion', '2');
  mem.set('mangoit.favstops', '{corrupt!!');
  assert.deepStrictEqual(store.getFavStops(), []);
  assert.strictEqual(store.quarantineCount(), 1);
  const qKey = [...mem.keys()].find((k) => k.startsWith('mangoit.__quarantine.favstops.'));
  assert.strictEqual(mem.get(qKey), '{corrupt!!'); // the raw bytes survive
});

test('quota pressure evicts cache and the user write succeeds', () => {
  mem.clear();
  mem.set('mangoit.schemaVersion', '2');
  store.cacheWrite('big', [1, 2, 3]);
  const realSet = globalThis.localStorage.setItem;
  let failures = 1; // first attempt hits "quota", the retry succeeds
  globalThis.localStorage.setItem = (k, v) => {
    if (k === 'mangoit.places' && failures > 0) { failures -= 1; throw new Error('QuotaExceededError'); }
    realSet(k, v);
  };
  const ok = store.addPlace({ key: 'p', name: 'Mondello', lat: 38, lon: 13 });
  globalThis.localStorage.setItem = realSet;
  assert.ok(ok);
  assert.strictEqual(store.getPlaces().length, 1);        // user data landed
  assert.strictEqual(store.cacheRead('big'), null);       // cache paid for it
});

test('export → import round trip, with a v1 backup migrated on the way in', () => {
  mem.clear();
  mem.set('mangoit.schemaVersion', '2');
  store.addFavStop({ key: 's1', name: 'PALERMO CENTRALE', iconMode: 'RAIL' });
  store.addPlace({ key: 'p1', name: 'Mondello', lat: 38.2, lon: 13.3 });
  const backup = store.exportBackup();
  assert.strictEqual(backup.app, 'mangoit');
  assert.match(store.describeBackup(backup), /1 saved stop, 1 place/);
  store.clearAllAppData();
  store.importBackup(backup);
  assert.strictEqual(store.getFavStops().length, 1);
  assert.strictEqual(store.getPlaces()[0].name, 'Mondello');
  // a v1-era backup (emoji icon, no iconMode) migrates during import
  store.importBackup({ app: 'mangoit', schemaVersion: 1, data: { favstops: [{ key: 'k', name: 'X', icon: '🚌' }] } });
  assert.strictEqual(store.getFavStops()[0].iconMode, 'COACH');
  assert.strictEqual(store.getPlaces().length, 0); // absent keys clear — a backup REPLACES
});

test('favourite lines: cap evicts oldest, backup carries them', () => {
  mem.clear();
  mem.set('mangoit.schemaVersion', '2');
  for (let i = 0; i < 9; i++) store.addFavLine({ key: 'L' + i, mode: 'COACH', line: 'Linea ' + i, headsign: 'X', lat: 38, lon: 13, stopName: 'S' });
  const lines = store.getFavLines();
  assert.strictEqual(lines.length, 8);
  assert.strictEqual(lines[0].key, 'L1'); // L0 evicted
  assert.ok(store.isFavLine('L8') && !store.isFavLine('L0'));
  assert.match(store.describeBackup(store.exportBackup()), /8 lines/);
  store.removeFavLine('L8');
  assert.strictEqual(store.getFavLines().length, 7);
});

test('importBackup rejects foreign files', () => {
  assert.throws(() => store.importBackup({ app: 'other', data: {} }));
  assert.throws(() => store.importBackup({ app: 'mangoit' }));
});

test('clearAllAppData erases everything under the namespace', () => {
  seed();
  store.clearAllAppData();
  assert.strictEqual(store.getFavStops().length, 0);
  assert.strictEqual(store.getPlaces().length, 0);
  assert.strictEqual(store.getSettings().theme, 'dark'); // back to default
});
