// ── ITINERARY MATH (pure, unit-tested) ──
import { dayPartKey, DAYPARTS } from './time.js';

// Whole-day results (§5.7, Ship 3) cluster into three dayparts with sticky
// headers so a 19-departure corridor reads as three scannable groups and a
// 3-a-day corridor shows its sparseness honestly. `hourOf(item)` returns the
// item's Rome departure hour (0–23); a null hour rides with the evening.
// Order is preserved (caller sorts); empty dayparts drop out.
export function groupByDaypart(items, hourOf) {
  const buckets = new Map(DAYPARTS.map((d) => [d.key, []]));
  for (const it of items || []) {
    const h = hourOf(it);
    buckets.get(dayPartKey(h == null ? 20 : h)).push(it);
  }
  return DAYPARTS.map((d) => ({ ...d, items: buckets.get(d.key) })).filter((g) => g.items.length);
}

// R-25: past-midnight times lose their day under %24 formatting. A run that
// departs 23:40 and arrives 00:30 needs the arrival marked "+1". `n` is whole
// days past the departure day (floor(arrMin/1440) - floor(depMin/1440)).
export function plusTag(n) {
  return n > 0 ? `+${n}` : '';
}

// Transfer-risk grading (audit P2, competitive §4): Sicilian coaches run
// hourly or worse, so a blown 5-minute change strands people. The card
// shows the WORST buffer across the itinerary, in three tiers.

export function worstTransferMin(legs) {
  const transit = (legs || []).filter((l) => l.mode !== 'WALK');
  let worst = null;
  for (let i = 1; i < transit.length; i++) {
    const prevEnd = new Date(transit[i - 1].endTime).getTime();
    const nextStart = new Date(transit[i].startTime).getTime();
    if (!isFinite(prevEnd) || !isFinite(nextStart)) continue;
    const buf = Math.round((nextStart - prevEnd) / 60000);
    if (worst === null || buf < worst) worst = buf;
  }
  return worst; // null = no transfers
}

// tiers per the teardown: >=15 calm / 6..14 tight / <=5 risky
export function transferTier(min) {
  if (min === null || min === undefined) return null;
  if (min >= 15) return 'calm';
  if (min >= 6) return 'tight';
  return 'risky';
}

export function transferChipText(min, tier) {
  if (tier === 'calm') return `${min} min change`;
  if (tier === 'tight') return `tight change · ${min} min`;
  return `risky change · ${min} min`;
}

// Relative "in X min" chip only when the departure is imminent (<60 min) —
// absolute clocks stay dominant on sparse schedules (competitive §2).
export function imminentText(startIso, now = Date.now()) {
  const ms = new Date(startIso).getTime() - now;
  const m = Math.round(ms / 60000);
  if (m < 0 || m >= 60) return null;
  return m <= 1 ? 'leaves now' : `in ${m} min`;
}

// Proportional leg strip: transit legs sized by duration (min 8% so short
// legs stay tappable/visible), walks collapsed to fixed thin connectors.
export function legStripModel(legs) {
  const out = [];
  const transit = (legs || []).filter((l) => l.mode !== 'WALK');
  const total = transit.reduce((a, l) => a + (l.duration || 0), 0) || 1;
  for (const l of legs || []) {
    if (l.mode === 'WALK') {
      const last = out[out.length - 1];
      if ((l.duration || 0) >= 600) out.push({ walk: true, long: true });
      else if (last && !last.walk) out.push({ walk: true });
      continue;
    }
    out.push({
      walk: false,
      mode: l.mode,
      label: l.routeShortName || l.displayName || '',
      pct: Math.max(8, Math.round(100 * (l.duration || 0) / total)),
      realTime: !!l.realTime,
    });
  }
  while (out.length && out[0].walk && !out[0].long) out.shift();
  while (out.length && out[out.length - 1].walk && !out[out.length - 1].long) out.pop();
  return out;
}
