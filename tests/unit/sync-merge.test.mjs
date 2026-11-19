// 1.18.1: the sync merge never loses an item. Three-way against the last
// agreed sync (base): additions on either side survive, a deletion since the
// last sync wins, an item both sides still hold keeps this phone's version.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
globalThis.window = { dispatchEvent() {}, addEventListener() {} };

import { test } from 'node:test';
import assert from 'node:assert';
const { merge3 } = await import('../../js/sync.js');

const P = (key, extra = {}) => ({ key, name: key, ...extra });
const keys = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.map((x) => x.key)]));

test('first sign-in on a phone with its own data: nothing on either side is lost', () => {
  const local = { places: [P('home'), P('work')], favstops: [P('s1')], favlines: [] };
  const cloud = { places: [P('beach')], favstops: [P('s2')], favlines: [P('l1')] };
  assert.deepEqual(keys(merge3(local, cloud, null)), { places: ['home', 'work', 'beach'], favstops: ['s1', 's2'], favlines: ['l1'] });
});

test('added on another device since the last sync: arrives here', () => {
  const base = { places: ['home'], favstops: [], favlines: [] };
  const local = { places: [P('home')], favstops: [], favlines: [] };
  const cloud = { places: [P('home'), P('beach')], favstops: [P('s9')], favlines: [] };
  assert.deepEqual(keys(merge3(local, cloud, base)), { places: ['home', 'beach'], favstops: ['s9'], favlines: [] });
});

test('added here while another device also saved: both kept', () => {
  const base = { places: ['home'], favstops: [], favlines: [] };
  const local = { places: [P('home'), P('gym')], favstops: [], favlines: [] };
  const cloud = { places: [P('home'), P('beach')], favstops: [], favlines: [] };
  assert.deepEqual(keys(merge3(local, cloud, base)).places, ['home', 'gym', 'beach']);
});

test('deleted on another device since the last sync: removed here too', () => {
  const base = { places: ['home', 'old'], favstops: [], favlines: [] };
  const local = { places: [P('home'), P('old')], favstops: [], favlines: [] };
  const cloud = { places: [P('home')], favstops: [], favlines: [] };
  assert.deepEqual(keys(merge3(local, cloud, base)).places, ['home']);
});

test('deleted here since the last sync: does not come back from the cloud', () => {
  const base = { places: ['home', 'old'], favstops: [], favlines: [] };
  const local = { places: [P('home')], favstops: [], favlines: [] };
  const cloud = { places: [P('home'), P('old')], favstops: [], favlines: [] };
  assert.deepEqual(keys(merge3(local, cloud, base)).places, ['home']);
});

test('an item both sides hold keeps this phone’s version (an icon changed here)', () => {
  const base = { places: ['home'], favstops: [], favlines: [] };
  const local = { places: [P('home', { icon: 'house' })], favstops: [], favlines: [] };
  const cloud = { places: [P('home', { icon: 'pin' })], favstops: [], favlines: [] };
  assert.equal(merge3(local, cloud, base).places[0].icon, 'house');
});

test('lists missing on either side read as empty, never as an error', () => {
  assert.deepEqual(keys(merge3({ places: [P('a')] }, {}, null)), { places: ['a'], favstops: [], favlines: [] });
});
