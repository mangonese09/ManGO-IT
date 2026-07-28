'use strict';
// R-26: the app's served data and the GTFS feed diverged because only the feed
// side gated anything. pipeline/gates.py is the shared enforcement point; these
// tests pin the thresholds it publishes so a future edit to either exporter
// cannot quietly re-open the gap. Python-side logic, asserted through the data
// it actually produced.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const stops = require('../../server/coach-stops.json');
const trips = require('../../server/coach-trips.json');

const GATES = fs.readFileSync(path.join(__dirname, '..', '..', 'pipeline', 'gates.py'), 'utf8');

function havKm(a, b) {
  const p = Math.PI / 180;
  return 2 * 6371 * Math.asin(Math.sqrt(
    Math.sin((b[0] - a[0]) * p / 2) ** 2 +
    Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin((b[1] - a[1]) * p / 2) ** 2));
}

const MAX_KMH = Number(/^MAX_KMH = (\d+)$/m.exec(GATES)[1]);
const MAX_SPAN_MIN = Number(/^MAX_SPAN_MIN = (\d+)$/m.exec(GATES)[1]);
const SAME_MINUTE_MAX_KM = Number(/^SAME_MINUTE_MAX_KM = (\d+)$/m.exec(GATES)[1]);

test('gates.py publishes the thresholds both exporters rely on', () => {
  assert.ok(MAX_KMH > 0 && MAX_SPAN_MIN > 0 && SAME_MINUTE_MAX_KM > 0);
  // 325 min is the longest legitimate run measured in the corpus
  // (Militello–Scordia–Catania–Taormina–Messina); the ceiling must clear it.
  assert.ok(MAX_SPAN_MIN > 325, 'span ceiling must not reject the longest real run');
});

test('no served trip exceeds the span ceiling (R-16)', () => {
  const bad = trips.filter((t) => {
    const m = t.s.map(([, min]) => min);
    return Math.max(...m) - Math.min(...m) > MAX_SPAN_MIN;
  });
  assert.strictEqual(bad.length, 0, `${bad.length} trips over ${MAX_SPAN_MIN}min, e.g. ${bad[0] && bad[0].r}`);
});

test('no served trip implies an impossible speed (R-26)', () => {
  let worst = null;
  for (const t of trips) {
    for (let i = 0; i < t.s.length - 1; i++) {
      const [ia, ma] = t.s[i];
      const [ib, mb] = t.s[i + 1];
      const km = havKm([stops[ia].lat, stops[ia].lon], [stops[ib].lat, stops[ib].lon]);
      const bad = mb <= ma ? km > SAME_MINUTE_MAX_KM : km / ((mb - ma) / 60) > MAX_KMH;
      if (bad) { worst = `${t.r} — ${km.toFixed(0)}km in ${mb - ma}min`; break; }
    }
    if (worst) break;
  }
  assert.strictEqual(worst, null, `app data serves a trip the GTFS build rejects: ${worst}`);
});

test('every served stop is visited by at least one trip (R-14)', () => {
  const used = new Set();
  for (const t of trips) for (const [i] of t.s) used.add(i);
  assert.strictEqual(stops.length - used.size, 0,
    `${stops.length - used.size} stops are favouritable but served by nothing`);
});

test('no two stops share one coordinate (R-15)', () => {
  const seen = new Map();
  for (const s of stops) {
    const k = `${s.lat},${s.lon}`;
    assert.ok(!seen.has(k), `'${s.n}' sits exactly on '${seen.get(k)}' — pileups fabricate free transfers`);
    seen.set(k, s.n);
  }
});

test('no trip visits the same stop twice in a row', () => {
  for (const t of trips) {
    for (let i = 0; i < t.s.length - 1; i++) {
      assert.notStrictEqual(t.s[i][0], t.s[i + 1][0], `${t.r} claims a 0-minute leg`);
    }
  }
});

test('trip times never run backwards', () => {
  for (const t of trips) {
    for (let i = 0; i < t.s.length - 1; i++) {
      assert.ok(t.s[i + 1][1] >= t.s[i][1], `${t.r} goes back in time — overnight unwrap failed`);
    }
  }
});
