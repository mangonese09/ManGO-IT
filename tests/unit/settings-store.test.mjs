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

test('clearAllAppData erases everything under the namespace', () => {
  seed();
  store.clearAllAppData();
  assert.strictEqual(store.getFavStops().length, 0);
  assert.strictEqual(store.getPlaces().length, 0);
  assert.strictEqual(store.getSettings().theme, 'dark'); // back to default
});
