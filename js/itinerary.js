// ── ITINERARY MATH (pure, unit-tested) ──
import { dayPartKey, DAYPARTS } from './time.js';
import { directionalRouteName } from './names.js';

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

// R-09: Trenitalia runs no scheduled city buses, so any Trenitalia BUS leg is a
// rail-replacement service. These render as anonymous identical BUS cards with
// no route identity; naming them lets the traveller tell the six lookalikes
// apart from the genuine coach sitting below them.
export function isRailReplacement(leg) {
  return !!leg && leg.mode === 'BUS' && /trenitalia/i.test(leg.agencyName || '');
}

// ── RESULT FILTER PREDICATES (v1.2.0) ──
// A view over results already in hand, NOT a routing restriction: the
// home-screen Trains/Buses toggles constrain what MOTIS may use, so "trains
// only" on a route whose last mile is bus-only returns nothing at all.
// Mode tests are local (mirroring ui.js's isRailMode) to keep this module
// pure — it imports nothing that touches the DOM.
export const RESULT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'direct', label: 'Direct' },
  { key: 'train', label: 'Train' },
  { key: 'bus', label: 'Bus & coach' },
];

export function isTrainLeg(leg) {
  return !!leg && /RAIL|LONG_DISTANCE|METRO|SUBWAY/.test(leg.mode || '');
}
// A Trenitalia rail-replacement service is mode BUS, so it counts as a bus and
// not as a train — which is what you actually board.
export function isBusLeg(leg) {
  return !!leg && (leg.mode === 'BUS' || leg.mode === 'COACH');
}

export function matchesFilter(it, key) {
  if (key === 'all' || !key) return true;
  const legs = (it?.legs || []).filter((l) => l.mode !== 'WALK');
  if (!legs.length) return false; // walk-only: never an answer to a filtered question
  if (key === 'direct') {
    // read defensively — `transfers` is upstream's field, leg count is ours
    const n = Number.isInteger(it.transfers) ? it.transfers : legs.length - 1;
    return n === 0;
  }
  if (key === 'train') return legs.some(isTrainLeg);
  if (key === 'bus') return legs.every(isBusLeg);
  return true;
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

// The LONGEST gap between two rides. worstTransferMin answers "can I make
// it"; this answers "how long am I stuck" — a 13 h itinerary with a night in
// a station looked like any other card.
export function longestWaitMin(legs) {
  const transit = (legs || []).filter((l) => l.mode !== 'WALK');
  let longest = null;
  for (let i = 1; i < transit.length; i++) {
    const buf = Math.round((new Date(transit[i].startTime) - new Date(transit[i - 1].endTime)) / 60000);
    if (isFinite(buf) && (longest === null || buf > longest)) longest = buf;
  }
  return longest;
}
export const LONG_WAIT_MIN = 120;

// tiers: >=10 calm / 6..9 tight / <=5 risky. The teardown's 15 put an amber
// chip on a 13-minute change, so 8 of 10 cards on a busy corridor carried a
// warning and the real 5-minute risk stopped standing out (critique 2026-11-18).
export function transferTier(min) {
  if (min === null || min === undefined) return null;
  if (min >= 10) return 'calm';
  if (min >= 6) return 'tight';
  return 'risky';
}

export function transferChipText(min, tier) {
  // An hour or more is not a "change", it is a wait — "690 min change" hid an
  // overnight layover behind a number nobody converts in their head.
  if (tier === 'calm' && min >= 60) {
    const h = Math.floor(min / 60); const m = min % 60;
    return `${h}h${m ? ` ${m}m` : ''} wait`;
  }
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
      label: isRailReplacement(l) ? 'Rail bus' : directionalRouteName(l.routeShortName || l.displayName || '', l.headsign || l.to?.name),
      pct: Math.max(8, Math.round(100 * (l.duration || 0) / total)),
      realTime: !!l.realTime,
    });
  }
  while (out.length && out[0].walk && !out[0].long) out.shift();
  while (out.length && out[out.length - 1].walk && !out[out.length - 1].long) out.pop();
  return out;
}

// A plan card can be the very same coach as a direct row shown above it,
// wrapped in a short city-bus hop to the coach stop. Returns that direct run
// (so the card can say so), or null. `hm(iso)` gives a leg's Rome HH:MM.
export function sameCoachAs(it, runs, hm) {
  const transit = (it?.legs || []).filter((l) => l.mode !== 'WALK');
  if (transit.length < 2 || transit.length > 3) return null;
  for (const r of runs || []) {
    const i = transit.findIndex((l) => isBusLeg(l) && hm(l.startTime) === r.dep && hm(l.endTime) === r.arr);
    if (i === -1) continue;
    const hops = transit.filter((_, k) => k !== i);
    if (hops.every((l) => l.mode === 'BUS' && (l.duration || 0) <= 25 * 60)) return r;
  }
  return null;
}

// Direct rows must answer the time that was asked. `afterMin` is the requested
// Rome minute-of-day (null = "now", nothing to filter); `day` is a run's day
// tag ('today', 'tomorrow' or an ISO date) and `queryDate` the searched date.
export function runsFromRequestedTime(list, afterMin, queryDate, depOf = (r) => r.dep) {
  if (afterMin == null) return list || [];
  return (list || []).filter((r) => {
    const sameDay = !r.day || r.day === 'today' || r.day === queryDate;
    if (!sameDay) return true;
    const dep = depOf(r);
    return Number(dep.slice(0, 2)) * 60 + Number(dep.slice(3, 5)) >= afterMin;
  });
}
