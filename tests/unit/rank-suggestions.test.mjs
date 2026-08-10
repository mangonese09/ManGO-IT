// rankSuggestions proximity ranking (v1.2.2): typing a name that exists in
// several Sicilian towns must lead with the one the user can actually reach,
// not whichever homonym the geocoder happened to return first.
//
// The live bug: "San Leone" led with a hamlet in Tortorici (prov. Messina,
// 137 km from Agrigento's San Leone beach). Planning to it returns zero
// itineraries — a dead end for a stop with 27 departures a day.
//
// classifySuggestion() builds icon elements, so rankSuggestions needs a DOM.
// A stub is enough: the test asserts on ORDER, never on the icons.
globalThis.document = {
  createElement: () => ({
    className: '', textContent: '', innerHTML: '',
    setAttribute() {}, addEventListener() {}, appendChild() {},
  }),
  addEventListener() {}, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

import { test } from 'node:test';
import assert from 'node:assert';
const { rankSuggestions } = await import('../../js/search.js');

// Verbatim from GET /api/geocode?text=San Leone (2026-08-09), trimmed to the
// fields ranking reads. The categories matter: only "hamlet" classifies as a
// town — "quarter"/"neighbourhood"/"carto_shrine" fall through to the unknown
// kind, which is why real fixtures beat invented ones here.
const SAN_LEONE = [
  { type: 'STOP',  name: 'SAN LEONE', modes: ['BUS'], category: null,
    lat: 37.26609, lon: 13.582042, town: 'Agrigento', province: 'Agrigento' },
  { type: 'PLACE', name: 'San Leone', modes: [], category: 'hamlet',
    lat: 38.006757, lon: 14.8329215, town: 'Tortorici', province: 'Messina' },
  { type: 'PLACE', name: 'San Leone', modes: [], category: 'quarter',
    lat: 37.5024574, lon: 15.0595522, town: 'Catania', province: 'Catania' },
  { type: 'PLACE', name: 'San Leone', modes: [], category: 'carto_shrine',
    lat: 36.9757464, lon: 15.1951951, town: 'Siracusa', province: 'Siracusa' },
  { type: 'PLACE', name: 'San Leone', modes: [], category: 'neighbourhood',
    lat: 37.4164838, lon: 14.4478462, town: 'Aidone', province: 'Enna' },
];

const AGRIGENTO = { lat: 37.31, lon: 13.58 };
// What geoBias() falls back to when the browser has no position — the state
// EVERY first-time user is in, since nothing has prompted for geolocation yet.
const SICILY_CENTROID = { lat: 37.6, lon: 14.15 };
const led = (rows, q, origin) => rankSuggestions(rows, q, origin)[0];

test('a user standing in Agrigento gets Agrigento\'s San Leone first', () => {
  const top = led(SAN_LEONE, 'San Leone', AGRIGENTO);
  assert.strictEqual(top.town, 'Agrigento');
  assert.strictEqual(top.type, 'STOP');
});

// The bug this file was written for. v1.2.2 only fixed it for users who had
// already granted geolocation; with the centroid fallback the Aidone homonym
// still led, which is what a first-time user saw. Verified in the browser.
test('with no device position, the reachable stop still leads the homonyms', () => {
  // The centroid cannot separate two Sicilian places by distance alone
  // (Agrigento 62 km, Tortorici 75 km — same coarse band), so distance must
  // not be the ONLY tiebreak: a result with departures beats one without.
  const top = led(SAN_LEONE, 'San Leone', SICILY_CENTROID);
  assert.strictEqual(top.town, 'Agrigento',
    `expected the servable stop to lead, got "${top.name}" in ${top.town}`);
});

test('a boardable stop leads same-named places regardless of array order', () => {
  // Order-independent: the geocoder does not promise a stable order, so the
  // fix must not depend on the stop arriving first in the array.
  const shuffled = [...SAN_LEONE].reverse();
  assert.strictEqual(led(shuffled, 'San Leone', SICILY_CENTROID).town, 'Agrigento');
});

test('mainland homonyms stay below the Sicilian result', () => {
  const puntaBianca = [
    { type: 'PLACE', name: 'Punta Bianca', modes: [], category: 'hamlet',
      lat: 40.8917, lon: 12.9583, town: 'Ponza', province: 'Latina' },     // ~470 km
    { type: 'STOP',  name: 'PUNTA BIANCA', modes: ['BUS'], category: null,
      lat: 37.2019, lon: 13.7178, town: 'Agrigento', province: 'Agrigento' },
  ];
  assert.strictEqual(led(puntaBianca, 'Punta Bianca', SICILY_CENTROID).province, 'Agrigento');
});

test('an exact name still beats a merely-prefixed one nearby', () => {
  // Guards the ranking rankSuggestions already had: typing "palermo" leads
  // with Palermo itself, not a stop merely NAMED after it.
  const rows = [
    { type: 'STOP', name: 'Palermo Notarbartolo', modes: ['RAIL'], category: null,
      lat: 38.1362, lon: 13.3389, town: 'Palermo', province: 'Palermo' },
    { type: 'PLACE', name: 'Palermo', modes: [], category: 'city',
      lat: 38.1157, lon: 13.3615, town: 'Palermo', province: 'Palermo' },
  ];
  assert.strictEqual(led(rows, 'palermo', SICILY_CENTROID).name, 'Palermo');
});
