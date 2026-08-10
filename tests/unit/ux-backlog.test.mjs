// v1.3.0 UX backlog — items 7 (multi-modal stop labels) and 6 (recent
// destinations in the quick-picks).
//
// Item 7 evidence: Transitous merges a station complex into ONE stop carrying
// every mode (PALERMO CENTRALE ships LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,
// TRAM,BUS and its stop-id board serves them all — probed 16 BUS + 3 rail).
// classifySuggestion used to label first-family-only ("train station"),
// hiding the buses from the user who wants one.
//
// classifySuggestion() builds icon elements, so it needs a DOM stub.
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
const { classifySuggestion, recentDestinations } = await import('../../js/search.js');

// ── item 7: what a stop row SAYS it is ──

test('a merged station complex names every family it serves', () => {
  // verbatim modes from GET /api/geocode?text=Palermo Centrale (2026-08-09)
  const { kind } = classifySuggestion({ type: 'STOP',
    modes: ['LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_RAIL', 'TRAM', 'BUS'] });
  assert.strictEqual(kind, 'train, tram & bus station');
});

test('rail + bus reads as one station serving both', () => {
  const { kind } = classifySuggestion({ type: 'STOP', modes: ['REGIONAL_RAIL', 'BUS'] });
  assert.strictEqual(kind, 'train & bus station');
});

test('single-family stops keep their original labels', () => {
  assert.strictEqual(classifySuggestion({ type: 'STOP', modes: ['REGIONAL_RAIL'] }).kind, 'train station');
  assert.strictEqual(classifySuggestion({ type: 'STOP', modes: ['BUS'] }).kind, 'city bus stop');
  assert.strictEqual(classifySuggestion({ type: 'STOP', modes: ['TRAM'] }).kind, 'tram stop');
  assert.strictEqual(classifySuggestion({ type: 'COACH_STOP', modes: ['COACH'] }).kind, 'coach stop');
});

test('a stop with no recognisable mode still gets the bus fallback', () => {
  assert.strictEqual(classifySuggestion({ type: 'STOP', modes: ['FERRY'] }).kind, 'city bus stop');
  assert.strictEqual(classifySuggestion({ type: 'STOP', modes: [] }).kind, 'city bus stop');
});

// ── item 6: which endpoints resurface as recent destinations ──

const ep = (name, lat, lon) => ({ name, place: `${lat},${lon}`, lat, lon });
const ME = ep('My location', 38.1, 13.3);

test('destinations lead, My location never appears, newest route first', () => {
  const recents = [
    { from: ME, to: ep('AEROPORTO FALCONE BORSELLINO', 38.1881, 13.1093) },
    { from: ep('RAFFADALI', 37.404, 13.533), to: ep('AGRIGENTO CENTRALE', 37.3111, 13.5765) },
  ];
  const got = recentDestinations(recents, []);
  assert.deepStrictEqual(got.map((d) => d.name),
    ['AEROPORTO FALCONE BORSELLINO', 'AGRIGENTO CENTRALE', 'RAFFADALI']);
});

test('an endpoint already saved as a place stays out', () => {
  const recents = [{ from: ME, to: ep('PALERMO CENTRALE', 38.1089, 13.3675) }];
  const places = [{ name: 'PALERMO CENTRALE', lat: 38.1089, lon: 13.3675 }];
  assert.deepStrictEqual(recentDestinations(recents, places), []);
});

test('the same destination searched twice appears once, capped at 4', () => {
  const pmo = ep('PMO', 38.1881, 13.1093);
  const recents = [
    { from: ME, to: pmo },
    { from: ME, to: ep('A', 37.1, 14.1) },
    { from: ME, to: pmo },
    { from: ME, to: ep('B', 37.2, 14.2) },
    { from: ME, to: ep('C', 37.3, 14.3) },
    { from: ME, to: ep('D', 37.4, 14.4) },
  ];
  const got = recentDestinations(recents, []);
  assert.strictEqual(got.length, 4);
  assert.deepStrictEqual(got.map((d) => d.name), ['PMO', 'A', 'B', 'C']);
});

test('malformed recents entries are skipped, not fatal', () => {
  const recents = [null, {}, { from: { name: 'x' }, to: { name: 'y', lat: NaN, lon: 13 } },
    { from: ME, to: ep('OK', 37.5, 14.5) }];
  assert.deepStrictEqual(recentDestinations(recents, []).map((d) => d.name), ['OK']);
});
