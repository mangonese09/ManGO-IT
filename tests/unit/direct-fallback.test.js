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

test('Siracusa→Catania festivo services surface on a Sunday', () => {
  const sr = findStop(/^SIRACUSA/i);
  const ct = findStop(/^CATANIA$/i) || findStop(/^CATANIA/i);
  const { results } = directSearch(sr.lat, sr.lon, ct.lat, ct.lon, 1500, [SUNDAY]);
  assert.ok(results.length >= 3, `expected ≥3 Sunday runs, got ${results.length}`);
  assert.ok(results.some((r) => r.dep === '08:00'), 'the 08:00 festivo run is missing');
  assert.ok(results.every((r) => r.operator === 'Interbus'), 'unexpected operator in fixture corridor');
});

test('weekday offers at least as many runs as Sunday', () => {
  const sr = findStop(/^SIRACUSA/i);
  const ct = findStop(/^CATANIA/i);
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
