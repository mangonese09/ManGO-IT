// ManGO:IT proxy — Transitous routing + ViaggiaTreno live trains.
// Zero dependencies. Node 18+. Serves /api/*; static files only when STATIC=1 (local dev).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3041;
const STATIC = process.env.STATIC === '1';
const ROOT = path.join(__dirname, '..');

const TRANSITOUS = 'https://api.transitous.org';
const VT = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const UA = 'ManGO-IT/0.13.0 (+https://it.mangonese.dev; miconsig@gmail.com)';

// per-day upstream request counter (Transitous asks consumers to know their volume)
const dayCounts = {};
function countRequest(host) {
  const day = new Date().toISOString().slice(0, 10);
  dayCounts[day] = dayCounts[day] || {};
  dayCounts[day][host] = (dayCounts[day][host] || 0) + 1;
  const days = Object.keys(dayCounts).sort();
  while (days.length > 14) delete dayCounts[days.shift()];
}

// Sicily bounding box — geocode results outside it are dropped.
const SICILY = { latMin: 36.55, latMax: 38.85, lonMin: 11.85, lonMax: 15.75 };

// Coach stops from our own GTFS pipeline (autocomplete works even before
// Transitous ingests the feed). Optional file; empty list if absent.
let coachStops = [];
let coachTrips = [];
try {
  coachStops = JSON.parse(fs.readFileSync(path.join(__dirname, 'coach-stops.json'), 'utf8'));
} catch { /* not generated yet */ }
try {
  coachTrips = JSON.parse(fs.readFileSync(path.join(__dirname, 'coach-trips.json'), 'utf8'));
} catch { /* not generated yet */ }

// ── DEGRADED DIRECT-SERVICE LOOKUP ──
// When Transitous is unreachable, answer "next direct coaches A→B" from our
// own feed. Single-leg only, honestly labelled in the UI.
const IT_HOLIDAYS = new Set(['2026-08-15', '2026-11-01', '2026-12-08', '2026-12-25', '2026-12-26',
  '2027-01-01', '2027-01-06', '2027-03-28', '2027-03-29', '2027-04-25', '2027-05-01', '2027-06-02']);

function romeParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday];
  return { iso: `${p.year}-${p.month}-${p.day}`, wd, min: (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute, month: +p.month, day: +p.day };
}

function serviceRuns(trip, day) {
  // Explicit-date services (SAIS/Albatross): the exact calendar ships with
  // the trip; no weekday/holiday/school inference at all.
  if (trip.xd) return trip.xd.includes(day.iso);
  const holiday = IT_HOLIDAYS.has(day.iso) || day.wd === 6;
  if (trip.d === 'sun-holidays') { if (!holiday) return false; }
  else if (trip.d === 'daily') { /* runs */ }
  else if (trip.d === 'mon-fri') { if (day.wd > 4 || holiday) return false; }
  else { if (day.wd > 5 || holiday) return false; } // mon-sat
  if (trip.sc === 'school-days-only' || trip.sc === 'holidays-only') {
    const inSchool = (day.month > 9 || (day.month === 9 && day.day >= 14) || day.month < 6 ||
      (day.month === 6 && day.day <= 8));
    if (trip.sc === 'school-days-only' && !inSchool) return false;
    if (trip.sc === 'holidays-only' && inSchool) return false;
  }
  if (trip.se) {
    const [fd, fm] = trip.se.from.split('/').map(Number);
    const [td, tm] = trip.se.to.split('/').map(Number);
    const cur = day.month * 100 + day.day, lo = fm * 100 + fd, hi = tm * 100 + td;
    const inside = lo <= hi ? (cur >= lo && cur <= hi) : (cur >= lo || cur <= hi);
    if (!inside) return false;
  }
  return true;
}

// days injectable for tests: [{iso, wd, min, month, day}, …]; day 0 filters by "not departed yet"
// `full` (Ship 3, R-17): the whole-day view needs the entire remaining day,
// not the 10-row teardown cap — when set, no early break and no slice.
function directSearch(fLat, fLon, tLat, tLon, radius = 1500, days = null, full = false) {
  const fromIdx = new Map(attachStops(fLat, fLon, radius).map((x) => [x.i, x.d]));
  const toIdx = new Map(attachStops(tLat, tLon, radius).map((x) => [x.i, x.d]));
  if (!fromIdx.size || !toIdx.size) return { results: [], reason: !fromIdx.size ? 'no-stops-near-origin' : 'no-stops-near-destination' };
  const dayList = days || [romeParts(), romeParts(new Date(Date.now() + 86400000))];
  const now = dayList[0];
  const results = [];
  for (let dayOff = 0; dayOff < dayList.length; dayOff++) {
    const day = dayList[dayOff];
    for (const trip of coachTrips) {
      if (!serviceRuns(trip, day)) continue;
      let board = null;
      for (const [idx, min] of trip.s) {
        if (board === null) {
          if (fromIdx.has(idx)) board = { idx, min };
        } else if (toIdx.has(idx)) {
          const arrMin = trip.s.find(([i]) => i === idx)[1];
          if (dayOff > 0 || board.min >= now.min - 5) {
            results.push({
              day: dayOff === 0 ? 'today' : 'tomorrow',
              route: trip.r, operator: trip.op,
              from: coachStops[board.idx].n, to: coachStops[idx].n,
              fromWalkM: Math.round(fromIdx.get(board.idx) || 0),
              toWalkM: Math.round(toIdx.get(idx) || 0),
              dep: fmtMin(board.min),
              arr: fmtMin(arrMin),
              // R-25: an overnight leg (arrMin >= 1440) arrives the next day.
              arrPlus: Math.floor(arrMin / 1440) - Math.floor(board.min / 1440),
              depMin: board.min + dayOff * 1440,
              arrAbsMin: arrMin + dayOff * 1440, // absolute minutes for hub-stitch timing
              arrLat: coachStops[idx].lat, arrLon: coachStops[idx].lon, // drop point for onward routing
              routeId: trip.r,
            });
          }
          break;
        }
      }
    }
    if (!full && results.filter((r) => r.day === 'today').length >= 6) break;
  }
  results.sort((a, b) => a.depMin - b.depMin);
  return full
    ? { fetchedAt: Date.now(), results, truncated: false }
    : { fetchedAt: Date.now(), results: results.slice(0, 10), truncated: results.length > 10 };
}

// ── ONE-TRANSFER COACH CHAINING ──
// Until Transitous ingests the feed (PR #2327), multi-leg coach journeys
// don't exist anywhere. This answers A→X→B over our own schedule data:
// leg 1 boards near the origin, leg 2 departs a stop within XFER_WALK_M of
// the alighting point between XFER_MIN_MIN and XFER_MAX_MIN later.
// Schedule-only, honestly labeled in the UI. days injectable for tests.
const XFER_MIN_MIN = 10;    // coaches are hourly — never sell a 3-minute dash
const XFER_MAX_MIN = 150;
const XFER_WALK_M = 250;

let stopTripIdx = null;     // stop index → [{t: trip, k: position}]
function tripIndex() {
  if (!stopTripIdx) {
    stopTripIdx = new Map();
    for (const trip of coachTrips) {
      trip.s.forEach(([idx], k) => {
        if (!stopTripIdx.has(idx)) stopTripIdx.set(idx, []);
        stopTripIdx.get(idx).push({ t: trip, k });
      });
    }
  }
  return stopTripIdx;
}

function fmtMin(m) {
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function twoLegSearch(fLat, fLon, tLat, tLon, radius = 1500, days = null) {
  const fromIdx = new Map(attachStops(fLat, fLon, radius).map((x) => [x.i, x.d]));
  const toIdx = new Map(attachStops(tLat, tLon, radius).map((x) => [x.i, x.d]));
  if (!fromIdx.size || !toIdx.size) return [];
  const idxOf = tripIndex();
  const dayList = days || [romeParts(), romeParts(new Date(Date.now() + 86400000))];
  const now = dayList[0];
  const chains = [];
  for (let dayOff = 0; dayOff < dayList.length && !chains.length; dayOff++) {
    const day = dayList[dayOff];
    for (const t1 of coachTrips) {
      if (!serviceRuns(t1, day)) continue;
      let board = null;
      for (let k = 0; k < t1.s.length; k++) {
        const [idx, min] = t1.s[k];
        if (board === null) {
          if (fromIdx.has(idx) && (dayOff > 0 || min >= now.min - 5)) board = { idx, min };
          continue;
        }
        if (toIdx.has(idx)) break; // direct exists on this trip — directSearch owns it
        // try transferring at this alighting point
        const xferAt = coachStops[idx];
        for (const [cand, candStop] of nearTransferStops(idx, xferAt)) {
          for (const { t: t2, k: k2 } of idxOf.get(cand) || []) {
            if (t2 === t1 || k2 >= t2.s.length - 1 || !serviceRuns(t2, day)) continue;
            const dep2 = t2.s[k2][1];
            if (dep2 < min + XFER_MIN_MIN || dep2 > min + XFER_MAX_MIN) continue;
            for (let j = k2 + 1; j < t2.s.length; j++) {
              const [idx3, arr3] = t2.s[j];
              if (!toIdx.has(idx3)) continue;
              chains.push({
                day: dayOff === 0 ? 'today' : 'tomorrow',
                depMin: board.min + dayOff * 1440, arrMin: arr3 + dayOff * 1440,
                arrPlus: Math.floor(arr3 / 1440) - Math.floor(board.min / 1440), // R-25
                waitMin: dep2 - min,
                fromWalkM: Math.round(fromIdx.get(board.idx) || 0),
                toWalkM: Math.round(toIdx.get(idx3) || 0),
                legs: [
                  { route: t1.r, operator: t1.op, from: coachStops[board.idx].n,
                    to: xferAt.n, dep: fmtMin(board.min), arr: fmtMin(min) },
                  { route: t2.r, operator: t2.op, from: candStop.n,
                    to: coachStops[idx3].n, dep: fmtMin(dep2), arr: fmtMin(arr3) },
                ],
                xferStop: xferAt.n,
              });
              break;
            }
          }
        }
      }
    }
  }
  chains.sort((a, b) => a.arrMin - b.arrMin || a.waitMin - b.waitMin);
  // one best chain per (leg1 route + departure); cap at 4
  const seen = new Set();
  const out = [];
  for (const c of chains) {
    const key = `${c.legs[0].route}|${c.legs[0].dep}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 4) break;
  }
  return out;
}

function nearTransferStops(idx, at) {
  const out = [[idx, at]];
  for (let i = 0; i < coachStops.length; i++) {
    if (i !== idx && haversineM(at.lat, at.lon, coachStops[i].lat, coachStops[i].lon) <= XFER_WALK_M) {
      out.push([i, coachStops[i]]);
    }
  }
  return out;
}

// Departure board for a COACH stop from our own feed — coach stops have no
// Transitous stopId until the feed is ingested upstream, but the favorites
// tab must still show their next departures. days injectable for tests.
function coachBoard(lat, lon, radius = 300, days = null, all = false) {
  const here = new Map(nearStopIdxs(lat, lon, radius).map((x) => [x.i, x.d]));
  if (!here.size) return { fetchedAt: Date.now(), stopName: null, results: [] };
  const dayList = days || [romeParts(), romeParts(new Date(Date.now() + 86400000))];
  const now = dayList[0];
  const results = [];
  for (let dayOff = 0; dayOff < dayList.length && (all ? dayOff < 1 : results.length < 8); dayOff++) {
    const day = dayList[dayOff];
    for (const trip of coachTrips) {
      if (!serviceRuns(trip, day)) continue;
      for (let k = 0; k < trip.s.length - 1; k++) {   // never "depart" from the terminus
        const [idx, min] = trip.s[k];
        if (!here.has(idx)) continue;
        if (!all && dayOff === 0 && min < now.min - 2) continue;
        results.push({
          day: dayOff === 0 ? 'today' : 'tomorrow',
          route: trip.r, operator: trip.op,
          stopName: coachStops[idx].n,
          headsign: coachStops[trip.s[trip.s.length - 1][0]].n,
          dep: `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
          depMin: min + dayOff * 1440,
        });
        break;                                        // one boarding point per trip
      }
    }
  }
  results.sort((a, b) => a.depMin - b.depMin);
  const nearest = [...here.entries()].sort((a, b) => a[1] - b[1])[0];
  return { fetchedAt: Date.now(), stopName: coachStops[nearest[0]].n, results: all ? results : results.slice(0, 8) };
}

// ── VT SILENT-DEATH DETECTION (gtfs-rt-research mitigation #1) ──
// ViaggiaTreno is unofficial and single-sourced; if it changes shape it
// fails SILENTLY (every lookup honestly reports "no live data"). Track
// per-day outcomes, persisted across restarts, and flag consecutive days
// where nothing parsed — that pattern is an API break, not quiet rails.
const VT_STATS_F = path.join(__dirname, 'vt-stats.json');
let vtStats = {};
try { vtStats = JSON.parse(fs.readFileSync(VT_STATS_F, 'utf8')); } catch { /* first run */ }

function vtRecord(gotData) {
  const day = romeParts().iso;
  const s = vtStats[day] || (vtStats[day] = { req: 0, ok: 0 });
  s.req++;
  if (gotData) s.ok++;
  const days = Object.keys(vtStats).sort();
  while (days.length > 21) delete vtStats[days.shift()];
  try { fs.writeFileSync(VT_STATS_F, JSON.stringify(vtStats)); } catch { /* read-only fs */ }
}

// pure for tests: consecutive trailing days (>=3 requests) with zero parses
function vtSilence(stats) {
  const days = Object.keys(stats).sort().reverse();
  let silent = 0;
  for (const d of days) {
    const s = stats[d];
    if (!s || s.ok > 0 || s.req < 3) break;
    silent++;
  }
  const last7 = {};
  for (const d of Object.keys(stats).sort().slice(-7)) last7[d] = stats[d];
  return { silentDays: silent, alert: silent >= 2, recent: last7 };
}

// ── FEED HORIZON (audit F-6) ──
// PDF sheets and SAIS validities have real end dates; queries past them
// silently lose coaches. Expose "coach schedules known through <date>" so
// the client can say so instead of rendering absence as "no service".
// Horizon = last day (next 120) where the runnable-trip count holds ≥ 50%
// of today's count. Cached until the Rome day changes or data reloads.
let horizonCache = null;
function feedHorizon() {
  const today = romeParts().iso;
  if (horizonCache && horizonCache.computedFor === today) return horizonCache.value;
  // The cliff lives in the EXPLICIT-DATE services (harvested validities end
  // with the timetable period; PDF pattern trips have no end date and would
  // mask it). Rolling 7-day windows so the Sunday dip doesn't read as the
  // cliff; horizon = end of the last window holding >=50% of the first.
  const counts = [];
  for (let i = 0; i < 120; i++) {
    const day = romeParts(new Date(Date.now() + i * 86400000));
    let n = 0, xd = 0;
    for (const trip of coachTrips) if (serviceRuns(trip, day)) { n++; if (trip.xd) xd++; }
    counts.push({ iso: day.iso, n, xd });
  }
  const win = (i) => counts.slice(i, i + 7).reduce((a, c) => a + c.xd, 0);
  const base = win(0);
  let lastGood = counts[counts.length - 1].iso;
  if (base > 0) {
    lastGood = counts[6].iso;
    for (let i = 0; i + 7 <= counts.length; i++) {
      if (win(i) < base * 0.5) break;
      lastGood = counts[i + 6].iso;
    }
  }
  const value = { date: lastGood, tripsToday: counts[0].n };
  horizonCache = { computedFor: today, value };
  return value;
}

// far-attach (v0.7.1): an origin/destination that isn't close to any stop
// still deserves an answer — attach to the nearest stops up to a long-walk
// cap and surface the walk explicitly in the UI. Beyond the cap the
// nearest-served empty-state hint takes over.
const FAR_ATTACH_M = 6000; // ~75 min walk
function attachStops(lat, lon, radius) {
  const near = nearStopIdxs(lat, lon, radius);
  if (near.length) return near;
  const best = [];
  for (let i = 0; i < coachStops.length; i++) {
    const d = haversineM(lat, lon, coachStops[i].lat, coachStops[i].lon);
    if (d <= FAR_ATTACH_M) best.push({ i, d });
  }
  return best.sort((a, b) => a.d - b.d).slice(0, 8);
}

function nearStopIdxs(lat, lon, radiusM) {
  const out = [];
  for (let i = 0; i < coachStops.length; i++) {
    const s = coachStops[i];
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d <= radiusM) out.push({ i, d });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 25);
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── CACHE ──
const cache = new Map(); // key → {expires, body}
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.body;
  if (hit) cache.delete(key);
  return null;
}
function cacheSet(key, body, ttlMs) {
  if (cache.size > 2000) cache.clear(); // crude bound; fine for one user
  cache.set(key, { expires: Date.now() + ttlMs, body });
}

// ── RATE LIMIT ── (public unauth endpoint; be polite to upstreams)
//
// R-04: two buckets, not one. The 90/min limit exists to protect UPSTREAMS
// (Transitous, ViaggiaTreno). Applying it to our own-feed paths meant that a
// burst of plan requests also locked out /api/direct — a lookup against JSON
// already in this process's memory — in the one scenario where the coach feed
// is the whole product. Own-feed paths get their own, far looser bucket.
const OWN_FEED_PATHS = new Set([
  '/api/direct', '/api/coach-board', '/api/nearest-served', '/api/health', '/api/stops',
]);
const rateBuckets = new Map();     // ip → [timestamps]  (upstream-backed)
const ownBuckets = new Map();      // ip → [timestamps]  (own feed)

function hit(map, ip, limit) {
  const now = Date.now();
  const bucket = (map.get(ip) || []).filter((t) => now - t < 60000);
  bucket.push(now);
  map.set(ip, bucket);
  // R-19: evict expired buckets instead of flushing everyone's history
  if (map.size > 5000) {
    for (const [k, v] of map) if (!v.length || now - v[v.length - 1] > 60000) map.delete(k);
  }
  return bucket.length > limit;
}

function rateLimited(ip, pathname) {
  return OWN_FEED_PATHS.has(pathname) ? hit(ownBuckets, ip, 600) : hit(rateBuckets, ip, 90);
}

// ── UPSTREAM ──
async function upstream(url, { asText = false, timeoutMs = 25000 } = {}) {
  countRequest(new URL(url).host);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: asText ? 'text/plain, */*' : 'application/json, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return { status: 204, data: null };
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return { status: res.status, data: asText ? await res.text() : await res.json() };
}

// ── HUB-STITCH (cross-network) ──
// Our coach feed isn't in Transitous yet (PR #2327), so a trip that needs our
// coaches to escape a coach-only town AND a Transitous train/bus for the last
// leg (the classic case: a small town → Palermo airport) routes on neither
// path. Bridge it: our coach [origin → a big-city rail hub] + a MOTIS leg
// [hub → destination]. A stopgap that retires itself once the feed is ingested.
const HUBS = [
  { name: 'Palermo', lat: 38.1086, lon: 13.3670 },   // Palermo Centrale
  { name: 'Catania', lat: 37.5023, lon: 15.0920 },   // Catania Centrale
  { name: 'Messina', lat: 38.1799, lon: 15.5525 },   // Messina Centrale
  { name: 'Agrigento', lat: 37.3110, lon: 13.5766 }, // Agrigento (rail node)
];

// The UTC instant for `minutes` past midnight (Rome) on dateISO — DST-safe by
// converging the guess against the zone's own rendering (mirrors the client's
// romeWallToIso). minutes may exceed 1440 (rolls into the next day).
function romeInstant(dateISO, minutes) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const addDays = Math.floor(minutes / 1440), hh = Math.floor((minutes % 1440) / 60), mm = minutes % 60;
  let guess = Date.UTC(y, m - 1, d + addDays, hh, mm) - 2 * 3600 * 1000;
  for (let i = 0; i < 3; i++) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const got = Date.UTC(+f.year, +f.month - 1, +f.day, f.hour === '24' ? 0 : +f.hour, +f.minute);
    const want = Date.UTC(y, m - 1, d + addDays, hh, mm);
    if (got === want) break;
    guess += want - got;
  }
  return new Date(guess).toISOString();
}

// One MOTIS plan with the F-1 tuning, slimmed. Separate from the /api/plan
// route so the stitcher can reuse it without the cursor/mode plumbing.
async function motisPlan(fromPlace, toPlace, { timeIso, searchWindow = '21600', numItineraries = '3' } = {}) {
  const params = new URLSearchParams({
    fromPlace, toPlace, numItineraries: String(numItineraries), searchWindow: String(searchWindow),
    maxMatchingDistance: '600', additionalTransferTime: '3', maxPreTransitTime: '3600', maxPostTransitTime: '3600',
  });
  if (timeIso) params.set('time', timeIso);
  const key = `plan:${params.toString()}`;
  const hit = cacheGet(key);
  if (hit) return hit.itineraries || [];
  const { data } = await upstream(`${TRANSITOUS}/api/v3/plan?${params}`, { timeoutMs: 15000 });
  const its = (data.itineraries || []).map(slimItinerary);
  cacheSet(key, { fetchedAt: Date.now(), itineraries: its }, 60 * 1000);
  return its;
}

// Coach [origin → hub] + MOTIS [hub → dest]. Returns the best stitch per hub
// (earliest final arrival), sorted, capped. `days`/`baseDate` mirror /api/direct.
async function hubStitch(fLat, fLon, toPlace, days, baseDate) {
  const stitches = [];
  for (const hub of HUBS) {
    if (haversineM(fLat, fLon, hub.lat, hub.lon) < 8000) continue; // already at/near the hub
    const coach = directSearch(fLat, fLon, hub.lat, hub.lon, 2500, days, true);
    const leg1 = (coach.results || [])[0]; // earliest coach that reaches the hub
    if (!leg1) continue;
    const boardIso = romeInstant(baseDate, (leg1.arrAbsMin ?? 0) + 15); // 15-min transfer cushion
    // Onward search starts from the coach's ACTUAL drop point, so MOTIS walks
    // to whichever station is nearest (maxPreTransitTime 60 min) and renders
    // that walk as a leg — the drop is rarely on the platform itself.
    const onwardFrom = (isFinite(leg1.arrLat) && isFinite(leg1.arrLon)) ? `${leg1.arrLat},${leg1.arrLon}` : `${hub.lat},${hub.lon}`;
    let onward;
    try { onward = await motisPlan(onwardFrom, toPlace, { timeIso: boardIso, searchWindow: '21600' }); }
    catch { continue; }
    const best = (onward || [])[0];
    if (!best) continue;
    const depInstant = romeInstant(baseDate, leg1.depMin ?? 0);
    const journeyMin = Math.round((new Date(best.endTime).getTime() - new Date(depInstant).getTime()) / 60000);
    stitches.push({
      hub: hub.name, coach: leg1, onward: best,
      finalArrival: best.endTime, journeyMin,
    });
  }
  // Rank by total journey, not arrival clock: a coach leaving tonight and
  // arriving 04:49 after an 11 h overnight wait must not outrank a 3 h daytime
  // trip that departs tomorrow. Drop absurdly long stitches unless nothing else.
  const sane = stitches.filter((s) => s.journeyMin <= 600);
  const pool = sane.length ? sane : stitches;
  pool.sort((a, b) => a.journeyMin - b.journeyMin);
  return pool.slice(0, 2);
}

// ── ROME TIME ──
// RFC1123-ish string ViaggiaTreno expects: "Sat Jul 25 2026 18:30:00 GMT+0200"
function romeNowString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome', weekday: 'short', month: 'short', day: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'longOffset',
  }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  // longOffset gives "GMT+02:00" → "GMT+0200"
  const off = (parts.timeZoneName || 'GMT+01:00').replace(':', '');
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year} ${hour}:${parts.minute}:${parts.second} ${off}`;
}

// ── SLIMMERS ── (the user is on foreign roaming; send only what the UI uses)
function slimPlace(p) {
  if (!p) return null;
  return {
    name: p.name, stopId: p.stopId || null, lat: p.lat, lon: p.lon,
    arrival: p.arrival || null, departure: p.departure || null,
    scheduledArrival: p.scheduledArrival || null, scheduledDeparture: p.scheduledDeparture || null,
    track: p.track || p.scheduledTrack || null, cancelled: !!p.cancelled,
  };
}
function slimLeg(l) {
  return {
    mode: l.mode, duration: l.duration, distance: l.distance || null,
    startTime: l.startTime, endTime: l.endTime,
    scheduledStartTime: l.scheduledStartTime, scheduledEndTime: l.scheduledEndTime,
    realTime: !!l.realTime, cancelled: !!l.cancelled,
    agencyName: l.agencyName || null, agencyId: l.agencyId || null,
    routeShortName: l.routeShortName || null, routeLongName: l.routeLongName || null,
    displayName: l.displayName || null, tripShortName: l.tripShortName || null,
    headsign: l.headsign || null, source: l.source || null,
    from: slimPlace(l.from), to: slimPlace(l.to),
    intermediateStops: (l.intermediateStops || []).map(slimPlace),
  };
}
function slimItinerary(it) {
  return {
    duration: it.duration, startTime: it.startTime, endTime: it.endTime,
    transfers: it.transfers, legs: (it.legs || []).map(slimLeg),
  };
}
function inSicily(lat, lon) {
  return lat >= SICILY.latMin && lat <= SICILY.latMax && lon >= SICILY.lonMin && lon <= SICILY.lonMax;
}

// ── VIAGGIATRENO PARSERS ──
function parseVtStations(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [name, id] = line.split('|');
    return name && id ? { name: name.trim(), id: id.trim() } : null;
  }).filter(Boolean);
}
// "21757 - PALERMO CENTRALE|21757-S12002-1784930400000"
function parseVtTrainAutocomplete(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const right = line.split('|')[1] || '';
    const m = right.match(/^(\d+)-(\S+?)-(\d+)$/);
    return m ? { trainNumber: m[1], originId: m[2], departureEpochMs: Number(m[3]) } : null;
  }).filter(Boolean);
}
function slimVtDeparture(d) {
  return {
    trainNumber: d.numeroTreno, category: d.categoriaDescrizione || d.categoria || '',
    destination: d.destinazione || '', scheduledMs: d.partenzaTreno || null,
    delayMin: typeof d.ritardo === 'number' ? d.ritardo : null,
    platformScheduled: d.binarioProgrammatoPartenzaDescrizione || null,
    platformActual: d.binarioEffettivoPartenzaDescrizione || null,
    departed: d.nonPartito === false, circulating: !!d.circolante,
    cancelled: d.provvedimento === 1 || d.tipoTreno === 'ST',
  };
}

// ── ROUTES ──
const routes = {
  'GET /api/health': async () => ({ ok: true, version: '0.13.0', romeTime: romeNowString(), feedHorizon: feedHorizon(), viaggiaTreno: vtSilence(vtStats), upstreamRequests: dayCounts }),

  // nearest coach stops regardless of radius — the "this area isn't served"
  // empty state names the closest place our data actually covers (audit P1)
  'GET /api/nearest-served': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (![lat, lon].every(isFinite)) throw httpError(400, 'lat/lon required');
    const best = [];
    for (const s of coachStops) {
      const d = haversineM(lat, lon, s.lat, s.lon);
      if (best.length < 3 || d < best[best.length - 1].m) {
        best.push({ name: s.n, lat: s.lat, lon: s.lon, m: Math.round(d) });
        best.sort((a, b) => a.m - b.m);
        if (best.length > 3) best.pop();
      }
    }
    return { fetchedAt: Date.now(), stops: best };
  },

  'GET /api/geocode': async (q) => {
    const text = (q.get('text') || '').trim().slice(0, 64);
    if (text.length < 2) return [];
    const key = `geo:${text.toLowerCase()}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const { data } = await upstream(`${TRANSITOUS}/api/v1/geocode?text=${encodeURIComponent(text)}&language=it`);
    const results = (data || [])
      .filter((r) => inSicily(r.lat, r.lon))
      .map((r) => {
        const areas = r.areas || [];
        const town = areas.find((a) => a.adminLevel === 8)?.name
          || areas.find((a) => a.default)?.name || null;
        const province = areas.find((a) => a.adminLevel === 6)?.name || null;
        return {
          type: r.type, name: r.name, id: r.id, lat: r.lat, lon: r.lon,
          modes: r.modes || [], category: r.category || null,
          town, province,
          importance: r.importance || 0,
        };
      });
    // our own coach stops (name-matched) — these exist before Transitous ingests the feed
    const needle = norm(text);
    const coach = coachStops
      .filter((s) => norm(s.n).includes(needle))
      .slice(0, 4)
      .map((s) => ({
        type: 'COACH_STOP', name: s.n, id: null, lat: s.lat, lon: s.lon,
        modes: ['COACH'], category: null, town: null, province: null, importance: 0,
      }));
    // dedupe (name+town), rank: transit stops → towns → the rest
    const seen = new Set();
    const all = [...results, ...coach].filter((r) => {
      const k = `${norm(r.name)}|${norm(r.town || '')}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const bucket = (r) => {
      if (r.type === 'STOP') return 0;
      if (r.type === 'COACH_STOP') return 1;
      if (/^(city|town|village|hamlet)/.test(r.category || '') || (r.name.toLowerCase() === text.toLowerCase() && !r.category)) return 2; // settlements
      if (r.type === 'ADDRESS' || /^(via|viale|corso|salita|piazza)\b/i.test(r.name)) return 4;
      return 3;
    };
    const out = all.sort((a, b) => bucket(a) - bucket(b) || b.importance - a.importance).slice(0, 10);
    cacheSet(key, out, 24 * 3600 * 1000);
    return out;
  },

  'GET /api/plan': async (q) => {
    const fromPlace = q.get('fromPlace'), toPlace = q.get('toPlace');
    if (!fromPlace || !toPlace) throw httpError(400, 'fromPlace and toPlace required');
    if (fromPlace.length > 120 || toPlace.length > 120) throw httpError(400, 'place too long');
    const params = new URLSearchParams({ fromPlace, toPlace });
    if (q.get('time')) params.set('time', q.get('time'));
    if (q.get('arriveBy') === 'true') params.set('arriveBy', 'true');
    params.set('numItineraries', q.get('n') || '6');
    // Whole-day view (Ship 3, R-24): the client raises maxItineraries and a
    // wide searchWindow; Earlier/Later pills page the edges via pageCursor.
    const maxIt = Number(q.get('maxItineraries'));
    if (Number.isInteger(maxIt) && maxIt > 0 && maxIt <= 60) params.set('maxItineraries', String(maxIt));
    // MOTIS: "keep the original request as is" and add the cursor; URLSearchParams
    // encodes the load-bearing pipe (a raw pipe is HTTP 400, §5.4).
    const cursor = q.get('pageCursor');
    if (cursor && cursor.length <= 200 && /^[A-Za-z0-9_|=-]+$/.test(cursor)) params.set('pageCursor', cursor);
    // mode filter (v0.9.0 home toggles): validated pass-through to MOTIS
    const modes = q.get('modes');
    if (modes && /^[A-Z_]+(,[A-Z_]+)*$/.test(modes) && modes.length <= 200) {
      params.set('transitModes', modes);
    }
    // Routing controls tuned for a sparse rural network (audit F-1).
    // MOTIS defaults are metro-grade: searchWindow 900s = 15 MINUTES —
    // on a 3-runs-a-day coach corridor that alone fabricates dead ends.
    params.set('searchWindow', q.get('searchWindow') || '21600');       // 6 h
    params.set('maxMatchingDistance', '600');   // town-centroid stops sit off the road graph at 250 m
    params.set('additionalTransferTime', '3');  // minutes; hourly coaches deserve a cushion
    params.set('maxPreTransitTime', '3600');    // 60 min first/last-mile ceiling — rural addresses sit far from the network
    params.set('maxPostTransitTime', '3600');
    const key = `plan:${params.toString()}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    // 18 s: the client aborts at 20 s — a 45 s upstream wait answered nobody (audit 1C)
    const { data } = await upstream(`${TRANSITOUS}/api/v3/plan?${params}`, { timeoutMs: 18000 });
    const out = {
      fetchedAt: Date.now(),
      itineraries: (data.itineraries || []).map(slimItinerary),
      // Ship 3: edge paging for the whole-day view (Earlier ▲ / Later ▼).
      nextPageCursor: data.nextPageCursor || null,
      previousPageCursor: data.previousPageCursor || null,
    };
    cacheSet(key, out, 60 * 1000);
    return out;
  },

  'GET /api/stops': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) throw httpError(400, 'lat/lon required');
    const r = Math.min(Number(q.get('r')) || 1200, 5000); // metres
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
    const key = `stops:${lat.toFixed(3)},${lon.toFixed(3)},${r}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const url = `${TRANSITOUS}/api/v1/map/stops?min=${lat - dLat},${lon - dLon}&max=${lat + dLat},${lon + dLon}`;
    const { data } = await upstream(url);
    const out = (data || []).map((s) => ({
      name: s.name, stopId: s.stopId, parentId: s.parentId || null,
      lat: s.lat, lon: s.lon, modes: s.modes || [],
      dist: Math.round(haversineM(lat, lon, s.lat, s.lon)),
    })).sort((a, b) => a.dist - b.dist).slice(0, 40);
    cacheSet(key, out, 5 * 60 * 1000);
    return out;
  },

  'GET /api/stoptimes': async (q) => {
    const stopId = q.get('stopId');
    if (!stopId) throw httpError(400, 'stopId required');
    const n = Math.min(Number(q.get('n')) || 6, 20);
    const key = `st:${stopId}:${n}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const { data } = await upstream(`${TRANSITOUS}/api/v1/stoptimes?stopId=${encodeURIComponent(stopId)}&n=${n}`);
    const out = {
      fetchedAt: Date.now(),
      stopTimes: (data.stopTimes || []).map((st) => ({
        stopName: st.place?.name || null, stopId: st.place?.stopId || null,
        departure: st.place?.departure || st.place?.arrival || null,
        scheduledDeparture: st.place?.scheduledDeparture || st.place?.scheduledArrival || null,
        cancelled: !!st.place?.cancelled, mode: st.mode, realTime: !!st.realTime,
        headsign: st.headsign || '', routeShortName: st.routeShortName || st.displayName || '',
        agencyName: st.agencyName || null, tripId: st.tripId || null,
        track: st.place?.track || null,
      })),
    };
    cacheSet(key, out, 60 * 1000);
    return out;
  },

  'GET /api/direct': async (q) => {
    const fLat = Number(q.get('fromLat')), fLon = Number(q.get('fromLon'));
    const tLat = Number(q.get('toLat')), tLon = Number(q.get('toLon'));
    if (![fLat, fLon, tLat, tLon].every(isFinite)) throw httpError(400, 'fromLat/fromLon/toLat/toLon required');
    const radius = Math.min(Number(q.get('r')) || 1500, 5000);
    // QA-01: identical endpoints would match urban loop trips as "journeys"
    if (haversineM(fLat, fLon, tLat, tLon) < 400) {
      return { fetchedAt: Date.now(), results: [], transfers: [], reason: 'same-place' };
    }
    // explicit travel date (audit P2 visual QA): without this, a query for
    // Oct 15 rendered TODAY's coaches under a date-picked search — wrong-day
    // information presented as an answer
    const dateStr = q.get('date');
    let days = null, dayLabels = null;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr !== romeParts().iso) {
      const noon = new Date(dateStr + 'T12:00:00Z');
      if (isNaN(noon)) throw httpError(400, 'bad date');
      const d0 = romeParts(noon);
      d0.min = Math.max(0, Math.min(1439, Number(q.get('afterMin')) || 0));
      const d1 = romeParts(new Date(noon.getTime() + 86400000));
      days = [d0, d1];
      dayLabels = { today: d0.iso, tomorrow: d1.iso };
    }
    const full = q.get('full') === '1'; // whole-day view (Ship 3, R-17)
    const out = directSearch(fLat, fLon, tLat, tLon, radius, days, full);
    // one-transfer chains: most useful when direct service is thin
    if ((out.results || []).length < 6) {
      out.transfers = twoLegSearch(fLat, fLon, tLat, tLon, radius, days);
    }
    if (dayLabels) {
      for (const r of out.results || []) r.day = dayLabels[r.day] || r.day;
      for (const c of out.transfers || []) c.day = dayLabels[c.day] || c.day;
    }
    return out;
  },

  // Cross-network stitch: our coach [origin → big-city rail hub] + a MOTIS leg
  // [hub → destination]. Answers trips like "small coach town → Palermo airport"
  // that neither the pure-MOTIS plan (doesn't know our coaches) nor /api/direct
  // (doesn't know the airport train) can complete on its own.
  'GET /api/via-hub': async (q) => {
    const fLat = Number(q.get('fromLat')), fLon = Number(q.get('fromLon'));
    const toPlace = q.get('toPlace');
    if (![fLat, fLon].every(isFinite) || !toPlace) throw httpError(400, 'fromLat/fromLon/toPlace required');
    if (toPlace.length > 120) throw httpError(400, 'place too long');
    const dateStr = q.get('date');
    let days = null, baseDate = romeParts().iso;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr !== romeParts().iso) {
      const noon = new Date(dateStr + 'T12:00:00Z');
      if (isNaN(noon)) throw httpError(400, 'bad date');
      const d0 = romeParts(noon);
      d0.min = Math.max(0, Math.min(1439, Number(q.get('afterMin')) || 0));
      const d1 = romeParts(new Date(noon.getTime() + 86400000));
      days = [d0, d1]; baseDate = dateStr;
    }
    const key = `viahub:${fLat.toFixed(3)},${fLon.toFixed(3)}:${toPlace}:${baseDate}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const out = { fetchedAt: Date.now(), stitches: await hubStitch(fLat, fLon, toPlace, days, baseDate) };
    cacheSet(key, out, 60 * 1000);
    return out;
  },

  'GET /api/coach-board': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (![lat, lon].every(isFinite)) throw httpError(400, 'lat/lon required');
    const radius = Math.min(Number(q.get('r')) || 300, 1500);
    return coachBoard(lat, lon, radius, null, q.get('all') === '1');
  },

  'GET /api/vt/stations': async (q) => {
    const text = (q.get('q') || '').trim().toUpperCase();
    if (text.length < 2) return [];
    const key = `vts:${text}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const { data } = await upstream(`${VT}/autocompletaStazione/${encodeURIComponent(text)}`, { asText: true });
    const out = parseVtStations(data || '');
    cacheSet(key, out, 24 * 3600 * 1000);
    return out;
  },

  'GET /api/vt/departures': async (q) => {
    const stationId = q.get('stationId');
    if (!/^S\d+$/.test(stationId || '')) throw httpError(400, 'stationId like S12002 required');
    const key = `vtd:${stationId}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const when = encodeURIComponent(romeNowString());
    const { data } = await upstream(`${VT}/partenze/${stationId}/${when}`);
    const out = { fetchedAt: Date.now(), departures: (data || []).map(slimVtDeparture) };
    cacheSet(key, out, 60 * 1000);
    return out;
  },

  // Resolve a train number to live status entirely server-side:
  // autocomplete → (train, originId, midnight epoch) → andamentoTreno.
  'GET /api/vt/live': async (q) => {
    const train = (q.get('train') || '').replace(/\D/g, '');
    if (!train) throw httpError(400, 'train number required');
    const key = `vtl:${train}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    let auto;
    try {
      auto = await upstream(`${VT}/cercaNumeroTrenoTrenoAutocomplete/${train}`, { asText: true });
    } catch (e) {
      vtRecord(false);
      throw e;
    }
    const candidates = parseVtTrainAutocomplete(auto.data || '');
    vtRecord(candidates.length > 0);
    if (!candidates.length) {
      const out = { live: false, reason: 'unknown-train' };
      cacheSet(key, out, 5 * 60 * 1000);
      return out;
    }
    // Train numbers repeat across days (and rarely across regions) — take the
    // run whose departure date is closest to now.
    const c = pickVtCandidate(candidates, Date.now());
    const res = await upstream(`${VT}/andamentoTreno/${c.originId}/${c.trainNumber}/${c.departureEpochMs}`);
    if (res.status === 204 || !res.data) {
      // 204 = train exists but no live data (common for cancelled/rescheduled). Not an error.
      const out = { live: false, reason: 'no-live-data' };
      cacheSet(key, out, 60 * 1000);
      return out;
    }
    const d = res.data;
    const out = {
      live: true, fetchedAt: Date.now(),
      trainNumber: c.trainNumber,
      delayMin: typeof d.ritardo === 'number' ? d.ritardo : null,
      lastSeenStation: d.stazioneUltimoRilevamento && d.stazioneUltimoRilevamento !== '--'
        ? d.stazioneUltimoRilevamento : null,
      lastSeenAtMs: d.oraUltimoRilevamento || null,
      origin: d.origine || null, destination: d.destinazione || null,
      cancelled: d.provvedimento === 1 || d.tipoTreno === 'ST',
    };
    cacheSet(key, out, 60 * 1000);
    return out;
  },
};

function pickVtCandidate(candidates, nowMs) {
  return [...candidates].sort((a, b) =>
    Math.abs(a.departureEpochMs - nowMs) - Math.abs(b.departureEpochMs - nowMs))[0];
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * toR) / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(((lon2 - lon1) * toR) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── STATIC (local dev only) ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ── SERVER ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*'); // same-origin in prod; harmless for GETs
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
  if (url.pathname.startsWith('/api/') && rateLimited(ip, url.pathname)) {
    // R-20: tell the client how long to wait so it can say so
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'rate limited', retryAfter: 60 }));
    return;
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = await handler(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    } catch (e) {
      const status = e.status || 502;
      console.error(new Date().toISOString(), req.url, e.message);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'upstream failure' }));
    }
    return;
  }
  if (STATIC) { serveStatic(req, res); return; }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`ManGO:IT proxy on :${PORT}${STATIC ? ' (static+api)' : ''}`));
}

module.exports = { romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, haversineM, inSicily, directSearch, coachBoard, twoLegSearch, serviceRuns, romeParts, feedHorizon, vtSilence };
