// Transfer-risk grading + leg-strip model (audit P2).
import { test } from 'node:test';
import assert from 'node:assert';
import { worstTransferMin, transferTier, transferChipText, imminentText, legStripModel, groupByDaypart, plusTag } from '../../js/itinerary.js';

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

test('transferTier: >=15 calm, 6-14 tight, <=5 risky', () => {
  assert.strictEqual(transferTier(null), null);
  assert.strictEqual(transferTier(15), 'calm');
  assert.strictEqual(transferTier(14), 'tight');
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
