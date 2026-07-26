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

// Pin the exact terminal stops: coach-stops.json ordering changes on every
// regeneration (and SAIS adds more SIRACUSA (...) berths), so a bare
// /^SIRACUSA/ prefix match can land on a stop outside the 1500m radius.
const SR_TERMINAL = /^SIRACUSA \(C\.so Umberto\/Terminal Bus\)$/;

test('Siracusa→Catania festivo services surface on a Sunday', () => {
  const sr = findStop(SR_TERMINAL);
  const ct = findStop(/^CATANIA$/i);
  const { results } = directSearch(sr.lat, sr.lon, ct.lat, ct.lon, 1500, [SUNDAY]);
  assert.ok(results.length >= 3, `expected ≥3 Sunday runs, got ${results.length}`);
  assert.ok(results.some((r) => r.dep === '08:00'), 'the 08:00 festivo run is missing');
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
  const sr = stops.find((x) => /^SIRACUSA \(C\.so Umberto\/Terminal Bus\)$/.test(x.n));
  const MONDAY = { iso: '2026-07-27', wd: 0, min: 6 * 60, month: 7, day: 27 };
  const { results, stopName } = coachBoard(sr.lat, sr.lon, 250, [MONDAY]);
  assert.ok(stopName, 'nearest stop name resolves');
  assert.ok(results.length >= 3, `expected departures from the Siracusa terminal, got ${results.length}`);
  assert.ok(results.every((r) => r.headsign && r.dep), 'each row has headsign and time');
  assert.ok(results.every((r) => r.depMin >= 6 * 60 - 2), 'no departed runs listed');
});
