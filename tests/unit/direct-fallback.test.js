'use strict';
// Regression fixture for the degraded direct-service lookup: the Interbus
// Siracusa→Catania festivo runs must surface on a Sunday. Frozen from the
// live verification on 2026-07-25 (08:00 / 16:00 / 18:00 departures).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { directSearch, serviceRuns } = require('../../server/proxy.js');

const stops = require(path.join(__dirname, '..', '..', 'server', 'coach-stops.json'));

const SUNDAY = { iso: '2026-07-26', wd: 6, min: 0, month: 7, day: 26 };
const MONDAY = { iso: '2026-07-27', wd: 0, min: 0, month: 7, day: 27 };

function findStop(re) {
  const s = stops.find((x) => re.test(x.n));
  assert.ok(s, `fixture stop matching ${re} missing from coach-stops.json`);
  return s;
}

// Pin the exact terminal stop: coach-stops.json ordering changes on every
// regeneration (and SAIS adds more SIRACUSA (...) berths), so a bare
// /^SIRACUSA/ prefix match can land on a stop outside the 1500m radius.
// R-15 collapsed the four co-located berths at 37.0706,15.2851 — including the
// old fixture name 'SIRACUSA (C.so Umberto/Terminal Bus)' — into one stop, and
// the generic name is the survivor by design. Same pole, same coordinate.
const SR_TERMINAL = /^SIRACUSA$/;

test('Siracusa→Catania festivo services surface on a Sunday', () => {
  const sr = findStop(SR_TERMINAL);
  const ct = findStop(/^CATANIA$/i);
  const { results } = directSearch(sr.lat, sr.lon, ct.lat, ct.lon, 1500, [SUNDAY]);
  assert.ok(results.length >= 3, `expected ≥3 Sunday runs, got ${results.length}`);
  // The 08:00 run this fixture used to assert is gone on purpose. R-26 put the
  // app's data behind the same speed gate as the GTFS build, and that trip
  // carries 'SANTA TERESA' geocoded to 37.473,15.211 — 55 km up the coast, a
  // 10-minute leg from Cassibile at 330 km/h. The feed has always rejected it;
  // only the app was still serving it. Recovering the run means fixing the
  // geocode (the interpolate override is not producing a sane coordinate), not
  // loosening the gate — tracked in reports/gated-trips.md.
  assert.ok(results.some((r) => r.dep === '16:00'), 'the 16:00 festivo run is missing');
  assert.ok(results.every((r) => r.operator === 'Interbus'), 'unexpected operator in fixture corridor');
});

test('weekday offers at least as many runs as Sunday', () => {
  const sr = findStop(SR_TERMINAL);
  const ct = findStop(/^CATANIA$/i);
  const sun = directSearch(sr.lat, sr.lon, ct.lat, ct.lon, 1500, [SUNDAY]).results.length;
  const mon = directSearch(sr.lat, sr.lon, ct.lat, ct.lon, 1500, [MONDAY]).results.length;
  assert.ok(mon >= sun, `weekday (${mon}) should be ≥ Sunday (${sun})`);
});

test('serviceRuns: feriale never runs on Ferragosto, festivo always does', () => {
  const ferragosto = { iso: '2026-08-15', wd: 5, min: 0, month: 8, day: 15 };
  assert.strictEqual(serviceRuns({ d: 'mon-sat', sc: null, se: null }, ferragosto), false);
  assert.strictEqual(serviceRuns({ d: 'sun-holidays', sc: null, se: null }, ferragosto), true);
  assert.strictEqual(serviceRuns({ d: 'daily', sc: null, se: null }, ferragosto), true);
});

test('serviceRuns: explicit-date services (SAIS) ignore weekday/holiday inference', () => {
  const ferragosto = { iso: '2026-08-15', wd: 5, min: 0, month: 8, day: 15 };
  const monday = { iso: '2026-08-17', wd: 0, min: 0, month: 8, day: 17 };
  const trip = { d: 'explicit', sc: null, se: null, xd: ['2026-08-15', '2026-08-16'] };
  assert.strictEqual(serviceRuns(trip, ferragosto), true, 'listed date must run');
  assert.strictEqual(serviceRuns(trip, monday), false, 'unlisted date must not run');
});

test('coachBoard: lists next departures from a coach stop, never the terminus', () => {
  const { coachBoard } = require('../../server/proxy.js');
  const stops = require('../../server/coach-stops.json');
  const sr = stops.find((x) => SR_TERMINAL.test(x.n));
  const MONDAY = { iso: '2026-07-27', wd: 0, min: 6 * 60, month: 7, day: 27 };
  const { results, stopName } = coachBoard(sr.lat, sr.lon, 250, [MONDAY]);
  assert.ok(stopName, 'nearest stop name resolves');
  assert.ok(results.length >= 3, `expected departures from the Siracusa terminal, got ${results.length}`);
  assert.ok(results.every((r) => r.headsign && r.dep), 'each row has headsign and time');
  assert.ok(results.every((r) => r.depMin >= 6 * 60 - 2), 'no departed runs listed');
});

test('twoLegSearch: Raffadali→Catania chains via Agrigento with a sane transfer window', () => {
  const { twoLegSearch } = require('../../server/proxy.js');
  // Raffadali centre → Catania centre, Monday morning
  const MONDAY = { iso: '2026-07-27', wd: 0, min: 5 * 60, month: 7, day: 27 };
  const chains = twoLegSearch(37.4029, 13.5339, 37.5023, 15.0873, 2500, [MONDAY]);
  assert.ok(chains.length >= 1, `expected at least one 1-transfer chain, got ${chains.length}`);
  for (const c of chains) {
    assert.strictEqual(c.legs.length, 2);
    assert.ok(c.waitMin >= 10 && c.waitMin <= 150, `transfer wait ${c.waitMin} outside 10-150min`);
    assert.ok(c.arrMin > c.depMin, 'arrives after departing');
  }
  assert.ok(/AGRIGENTO/i.test(chains[0].xferStop), `expected Agrigento transfer, got ${chains[0].xferStop}`);
});

test('far-attach: an origin ~4km from the nearest stop still gets runs, with the walk stated (v0.7.1)', () => {
  const MON = { iso: '2026-08-03', wd: 0, min: 0, month: 8, day: 3 };
  // countryside point between Aragona and Favara, ~3km+ from any stop
  const far = { lat: 37.435, lon: 13.615 };
  const ag = { lat: 37.3114, lon: 13.5872 };
  const { results } = directSearch(far.lat, far.lon, ag.lat, ag.lon, 1500, [MON]);
  assert.ok(results.length > 0, 'expected runs via far-attach');
  const r = results[0];
  assert.ok(r.fromWalkM > 1500 && r.fromWalkM <= 6000, `fromWalkM ${r.fromWalkM} should be a real long walk`);
  assert.ok(r.toWalkM <= 1500, `toWalkM ${r.toWalkM} — destination is at a served stop`);
});
