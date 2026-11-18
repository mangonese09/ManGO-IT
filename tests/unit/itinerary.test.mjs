// Transfer-risk grading + leg-strip model (audit P2).
import { test } from 'node:test';
import assert from 'node:assert';
import { worstTransferMin, transferTier, transferChipText, imminentText, legStripModel, groupByDaypart, plusTag, isRailReplacement, RESULT_FILTERS, matchesFilter } from '../../js/itinerary.js';

const leg = (mode, start, end, extra = {}) => ({
  mode, startTime: `2026-08-05T${start}:00Z`, endTime: `2026-08-05T${end}:00Z`,
  duration: (new Date(`2026-08-05T${end}:00Z`) - new Date(`2026-08-05T${start}:00Z`)) / 1000,
  ...extra,
});

test('worstTransferMin: none for direct, min buffer across transfers, walks ignored', () => {
  assert.strictEqual(worstTransferMin([leg('BUS', '08:00', '09:00')]), null);
  const legs = [
    leg('BUS', '08:00', '09:00'),
    leg('WALK', '09:00', '09:05'),
    leg('RAIL', '09:20', '10:00'),   // 20 min after bus ends
    leg('COACH', '10:04', '11:00'),  // 4 min — the worst
  ];
  assert.strictEqual(worstTransferMin(legs), 4);
});

test('transferTier: >=10 calm, 6-9 tight, <=5 risky', () => {
  assert.strictEqual(transferTier(null), null);
  assert.strictEqual(transferTier(15), 'calm');
  assert.strictEqual(transferTier(10), 'calm');
  assert.strictEqual(transferTier(9), 'tight');
  assert.strictEqual(transferTier(6), 'tight');
  assert.strictEqual(transferTier(5), 'risky');
  assert.strictEqual(transferTier(0), 'risky');
  assert.match(transferChipText(4, 'risky'), /risky change · 4 min/);
});

test('imminentText: only inside the next hour', () => {
  const now = new Date('2026-08-05T08:00:00Z').getTime();
  assert.strictEqual(imminentText('2026-08-05T08:25:00Z', now), 'in 25 min');
  assert.strictEqual(imminentText('2026-08-05T08:00:30Z', now), 'leaves now');
  assert.strictEqual(imminentText('2026-08-05T09:05:00Z', now), null);
  assert.strictEqual(imminentText('2026-08-05T07:55:00Z', now), null);
});

test('legStripModel: proportional transit segs, walks collapsed, edges trimmed', () => {
  const legs = [
    leg('WALK', '07:55', '08:00'),            // leading walk trimmed
    leg('BUS', '08:00', '08:30', { routeShortName: '2' }),   // 30 min
    leg('WALK', '08:30', '08:35'),            // short connector kept
    leg('RAIL', '08:40', '10:10', { routeShortName: 'RE' }), // 90 min
    leg('WALK', '10:10', '10:30'),            // long walk (>=10 min) kept with glyph
  ];
  const m = legStripModel(legs);
  assert.strictEqual(m.filter((s) => !s.walk).length, 2);
  const [bus, rail] = m.filter((s) => !s.walk);
  assert.ok(rail.pct > bus.pct * 2, `rail ${rail.pct}% should dominate bus ${bus.pct}%`);
  assert.ok(m.some((s) => s.walk && !s.long), 'short connector present');
  assert.ok(m[m.length - 1].walk && m[m.length - 1].long, 'long trailing walk kept');
  assert.ok(!m[0].walk, 'leading short walk trimmed');
});

// ── WHOLE-DAY GROUPING (Ship 3, §5.7) ──
test('groupByDaypart clusters by hour, preserves order, drops empty dayparts', () => {
  const items = [
    { id: 'a', h: 7 }, { id: 'b', h: 9 },   // morning
    { id: 'c', h: 14 },                       // afternoon
    { id: 'd', h: 18 }, { id: 'e', h: 23 },  // evening
  ];
  const groups = groupByDaypart(items, (it) => it.h);
  assert.deepStrictEqual(groups.map((g) => g.key), ['morning', 'afternoon', 'evening']);
  assert.deepStrictEqual(groups[0].items.map((i) => i.id), ['a', 'b']);
  assert.deepStrictEqual(groups[1].items.map((i) => i.id), ['c']);
  assert.deepStrictEqual(groups[2].items.map((i) => i.id), ['d', 'e']);
  assert.strictEqual(groups[0].label, 'Morning');
});

test('groupByDaypart: a 3-a-day corridor shows only the dayparts it uses', () => {
  const groups = groupByDaypart([{ h: 6 }, { h: 13 }, { h: 19 }], (it) => it.h);
  assert.strictEqual(groups.length, 3);
  const only = groupByDaypart([{ h: 8 }, { h: 10 }], (it) => it.h);
  assert.deepStrictEqual(only.map((g) => g.key), ['morning']);
});

test('groupByDaypart: null hour and post-midnight ride the evening', () => {
  const groups = groupByDaypart([{ id: 'x', h: null }, { id: 'y', h: 1 }], (it) => it.h);
  assert.deepStrictEqual(groups.map((g) => g.key), ['evening']);
  assert.deepStrictEqual(groups[0].items.map((i) => i.id), ['x', 'y']);
});

test('groupByDaypart handles empty/nullish input', () => {
  assert.deepStrictEqual(groupByDaypart([], (i) => i), []);
  assert.deepStrictEqual(groupByDaypart(null, (i) => i), []);
});

test('plusTag marks past-midnight day carry (R-25)', () => {
  assert.strictEqual(plusTag(0), '');
  assert.strictEqual(plusTag(1), '+1');
  assert.strictEqual(plusTag(2), '+2');
});

test('isRailReplacement flags Trenitalia BUS legs only (R-09)', () => {
  assert.strictEqual(isRailReplacement({ mode: 'BUS', agencyName: 'Trenitalia' }), true);
  assert.strictEqual(isRailReplacement({ mode: 'BUS', agencyName: 'Trenitalia S.p.A.' }), true);
  assert.strictEqual(isRailReplacement({ mode: 'RAIL', agencyName: 'Trenitalia' }), false); // a real train
  assert.strictEqual(isRailReplacement({ mode: 'BUS', agencyName: 'AST' }), false);         // a real coach
  assert.strictEqual(isRailReplacement({ mode: 'BUS', agencyName: '' }), false);
  assert.strictEqual(isRailReplacement(null), false);
});

test('legStripModel labels a rail-replacement leg "Rail bus"', () => {
  const legs = [{ mode: 'BUS', agencyName: 'Trenitalia', duration: 3600, routeShortName: '' }];
  assert.strictEqual(legStripModel(legs)[0].label, 'Rail bus');
});

// ── RESULT FILTER (v1.2.0) ──
// Shapes taken from the real PMO -> RAFFADALI (Via Nazionale) plan response.
const iti = (transfers, ...modes) => ({
  transfers,
  legs: [{ mode: 'WALK', duration: 300 }, ...modes.map((m) => ({ mode: m.mode || m, agencyName: m.agencyName || '' }))],
});

test('matchesFilter: All keeps everything, including odd shapes', () => {
  assert.strictEqual(matchesFilter(iti(0, 'BUS'), 'all'), true);
  assert.strictEqual(matchesFilter({ legs: [] }, 'all'), true);
  assert.strictEqual(matchesFilter(iti(0, 'BUS'), undefined), true);
});

test('matchesFilter: Direct means no transfers, walks ignored', () => {
  assert.strictEqual(matchesFilter(iti(0, 'BUS'), 'direct'), true);
  assert.strictEqual(matchesFilter(iti(1, 'BUS', 'BUS'), 'direct'), false);
  // upstream `transfers` missing -> fall back to the transit-leg count
  assert.strictEqual(matchesFilter({ legs: [{ mode: 'WALK' }, { mode: 'COACH' }] }, 'direct'), true);
  assert.strictEqual(matchesFilter({ legs: [{ mode: 'COACH' }, { mode: 'BUS' }] }, 'direct'), false);
});

test('matchesFilter: Train needs a real rail leg, not a replacement bus', () => {
  assert.strictEqual(matchesFilter(iti(1, 'REGIONAL_RAIL', 'BUS'), 'train'), true);
  assert.strictEqual(matchesFilter(iti(0, 'METRO'), 'train'), true);
  // the Sunday Palermo-Agrigento reality: a Trenitalia BUS is not a train
  assert.strictEqual(matchesFilter(iti(1, { mode: 'BUS', agencyName: 'TRENITALIA' }, 'BUS'), 'train'), false);
  assert.strictEqual(matchesFilter(iti(1, 'BUS', 'COACH'), 'train'), false);
});

test('matchesFilter: Bus & coach excludes any rail leg, including tram', () => {
  assert.strictEqual(matchesFilter(iti(1, 'BUS', 'COACH'), 'bus'), true);
  assert.strictEqual(matchesFilter(iti(1, { mode: 'BUS', agencyName: 'TRENITALIA' }, 'BUS'), 'bus'), true);
  assert.strictEqual(matchesFilter(iti(1, 'REGIONAL_RAIL', 'BUS'), 'bus'), false);
  assert.strictEqual(matchesFilter(iti(1, 'TRAM', 'BUS'), 'bus'), false); // a tram is not a bus
});

test('matchesFilter: a walk-only itinerary answers no filtered question', () => {
  const walkOnly = { transfers: 0, legs: [{ mode: 'WALK', duration: 900 }] };
  assert.strictEqual(matchesFilter(walkOnly, 'direct'), false);
  assert.strictEqual(matchesFilter(walkOnly, 'bus'), false);
  assert.strictEqual(matchesFilter(walkOnly, 'train'), false);
  assert.strictEqual(matchesFilter(walkOnly, 'all'), true);
});

test('RESULT_FILTERS leads with All and covers every predicate branch', () => {
  assert.strictEqual(RESULT_FILTERS[0].key, 'all');
  assert.deepStrictEqual(RESULT_FILTERS.map((f) => f.key), ['all', 'direct', 'train', 'bus']);
});

test('a transfer of an hour or more reads as a wait, in hours', () => {
  assert.strictEqual(transferChipText(690, 'calm'), '11h 30m wait');
  assert.strictEqual(transferChipText(120, 'calm'), '2h wait');
  assert.strictEqual(transferChipText(25, 'calm'), '25 min change');
});

// v1.14.0: the longest gap flags an overnight layover; the strip reads in the direction of travel
import { longestWaitMin, LONG_WAIT_MIN } from '../../js/itinerary.js';
test('longestWaitMin: null when direct, the biggest gap otherwise', () => {
  assert.strictEqual(longestWaitMin([leg('RAIL', '08:00', '09:00')]), null);
  const legs = [leg('BUS', '06:00', '07:00'), leg('WALK', '07:00', '07:05'), leg('RAIL', '07:10', '08:00'), leg('BUS', '19:30', '20:00')];
  assert.strictEqual(longestWaitMin(legs), 690);
  assert.ok(longestWaitMin(legs) >= LONG_WAIT_MIN);
  assert.strictEqual(worstTransferMin(legs), 10);
});
test('legStripModel labels a two-way coach line toward its headsign', () => {
  const legs = [leg('COACH', '18:00', '20:00', { displayName: 'Agrigento - Palermo', headsign: 'Agrigento' })];
  assert.strictEqual(legStripModel(legs)[0].label, 'Palermo – Agrigento');
});

// ── v1.16.0: direct rows answer the asked time; duplicate coaches are named ──
{
  const { sameCoachAs, runsFromRequestedTime } = await import('../../js/itinerary.js');
  const hm = (iso) => iso.slice(11, 16);
  const coach = { mode: 'COACH', startTime: '2026-11-18T06:15:00', endTime: '2026-11-18T07:55:00', duration: 6000 };
  const cityBus = { mode: 'BUS', startTime: '2026-11-18T05:55:00', endTime: '2026-11-18T06:10:00', duration: 900 };
  const walk = { mode: 'WALK', duration: 300 };
  const run = { dep: '06:15', arr: '07:55', day: 'today', fromWalkM: 1400 };

  test('sameCoachAs: a coach behind a short city-bus hop is the same coach', () => {
    assert.equal(sameCoachAs({ legs: [walk, cityBus, walk, coach] }, [run], hm), run);
  });
  test('sameCoachAs: a lone coach, a train change, or a different time is not a repeat', () => {
    assert.equal(sameCoachAs({ legs: [walk, coach] }, [run], hm), null);
    assert.equal(sameCoachAs({ legs: [{ mode: 'REGIONAL_RAIL', duration: 900 }, coach] }, [run], hm), null);
    assert.equal(sameCoachAs({ legs: [cityBus, { ...coach, startTime: '2026-11-18T07:15:00' }] }, [run], hm), null);
    assert.equal(sameCoachAs({ legs: [{ ...cityBus, duration: 3600 }, coach] }, [run], hm), null);
  });
  test('runsFromRequestedTime: drops same-day runs before the asked time, keeps later days', () => {
    const list = [{ dep: '04:30', day: 'today' }, { dep: '21:45', day: 'today' }, { dep: '04:30', day: 'tomorrow' }];
    assert.deepEqual(runsFromRequestedTime(list, 21 * 60 + 30, '2026-11-18').map((r) => r.dep + r.day), ['21:45today', '04:30tomorrow']);
    assert.equal(runsFromRequestedTime(list, null, null).length, 3);
    assert.equal(runsFromRequestedTime([{ legs: [{ dep: '05:00' }], day: '2026-11-18' }], 600, '2026-11-18', (c) => c.legs[0].dep).length, 0);
  });
}
