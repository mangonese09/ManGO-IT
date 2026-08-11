// ManGO:IT proxy — Transitous routing + ViaggiaTreno live trains.
// Zero dependencies. Node 18+. Serves /api/*; static files only when STATIC=1 (local dev).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3041;
const STATIC = process.env.STATIC === '1';
const ROOT = path.join(__dirname, '..');

// Single-source version: read the deployed app's version.json so /api/health
// (and the UA) can never drift from the client again — the hardcoded string
// sat at 0.45.2 through five releases. Web root first (VPS), repo root for dev.
let APP_VERSION = 'unknown';
for (const vp of ['/var/www/mangoit/version.json', path.join(__dirname, '..', 'version.json')]) {
  try { APP_VERSION = JSON.parse(fs.readFileSync(vp, 'utf8')).version; break; } catch { /* try next */ }
}

const TRANSITOUS = 'https://api.transitous.org';
const VT = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const UA = `ManGO-IT/${APP_VERSION} (+https://it.mangonese.dev; miconsig@gmail.com)`;

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

// #5 Tidy line labels at the data layer so EVERY consumer (direct rows, coach
// board, map trace) serves clean names — not just the map legend. Strips the
// parse-damage leading "0 " corsa token and normalises doubled/spaced hyphens
// to a spaced en-dash. Title-casing stays client-side (displayName). Deep
// parse damage (fused double-names) is still a pipeline-frontier item.
function tidyRoute(name) {
  let s = String(name == null ? '' : name).trim();
  s = s.replace(/^0\s+(?=\D)/, '');
  s = s.replace(/\s*-\s*-\s*/g, ' – ');
  s = s.replace(/\s+-\s+/g, ' – ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}
for (const t of coachTrips) t.r = tidyRoute(t.r);

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
  // trip.lh: comune patron-saint feasts this route serves, as [month, day]
  // pairs (set in export_stops from the shared gates.route_local_hols). Local
  // to the route — a Palermo line observes Santa Rosalia, a Catania one doesn't.
  const localHoliday = Array.isArray(trip.lh) && trip.lh.some((p) => p[0] === day.month && p[1] === day.day);
  const holiday = IT_HOLIDAYS.has(day.iso) || day.wd === 6 || localHoliday;
  if (trip.d === 'sun-holidays') { if (!holiday) return false; }
  else if (trip.d === 'daily') { /* runs */ }
  else if (trip.d === 'mon-fri') { if (day.wd > 4 || holiday) return false; }
  else { if (day.wd > 5 || holiday) return false; } // mon-sat
  if (trip.sc === 'school-days-only' || trip.sc === 'holidays-only') {
    const inSchool = (day.month > 9 || (day.month === 9 && day.day >= 14) || day.month < 6 ||
      (day.month === 6 && day.day <= 8)) && !localHoliday; // a local feast closes its schools
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
function coachBoard(lat, lon, radius = 300, days = null, all = false, withVia = false) {
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
          // remaining calls after boarding WITH their times — a destination
          // search matches them, the row can say "reaches X at HH:MM", and a
          // tap can show the full remaining route. ci + boarding coords let
          // the client hand the row to the map's route tracer.
          ...(withVia ? {
            ci: idx, sLat: coachStops[idx].lat, sLon: coachStops[idx].lon,
            via: trip.s.slice(k + 1).map(([i, m]) => ({
              n: coachStops[i].n,
              t: `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
            })),
          } : {}),
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

// ── ROAD SNAPPING ──
// A traced route drawn as straight "connect the dots" lines between stops looks
// wrong — buses follow roads, not the countryside. Snap an ordered stop list to
// the road network so the drawn line hugs the real roads. Approximate by design
// (OSRM `driving`, not the operator's exact path — the user only wants "the road
// it likely uses"). ONLY for road modes (BUS/COACH): trains do NOT follow roads,
// so rail/tram/metro keep straight stop-to-stop segments. Geometry is static, so
// it's cached hard and reused across every stop on the same line.
const OSRM = 'https://router.project-osrm.org';

// #6 Persistent shape cache. A snapped line is static, so once OSRM has drawn
// it we keep it forever — on disk, not just in memory — so restarts don't
// re-hit OSRM and a viewed line never depends on OSRM being up twice. This is
// the durable form of a precomputed shapes sidecar: it fills lazily as lines
// are viewed (or eagerly via scripts/warm-shapes.mjs). Keyed by the waypoint
// signature so identical stop sequences share one geometry.
const SHAPES_F = path.join(__dirname, 'route-shapes.json');
let shapeCache = new Map();
try {
  shapeCache = new Map(Object.entries(JSON.parse(fs.readFileSync(SHAPES_F, 'utf8'))));
} catch { /* first run — created on first write */ }
let shapeWriteTimer = null;
function persistShapes() {
  clearTimeout(shapeWriteTimer);
  shapeWriteTimer = setTimeout(() => {
    try { fs.writeFileSync(SHAPES_F, JSON.stringify(Object.fromEntries(shapeCache))); } catch { /* disk read-only — memory cache still serves */ }
  }, 4000);
}

async function snapToRoads(stops) {
  const pts = (stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lon));
  if (pts.length < 2) return null;
  // OSRM's demo server caps waypoints per request; sample evenly if a line is huge.
  let way = pts;
  if (pts.length > 90) {
    way = [];
    const step = pts.length / 90;
    for (let i = 0; i < 90; i++) way.push(pts[Math.floor(i * step)]);
    way[way.length - 1] = pts[pts.length - 1];
  }
  const sig = way.map((s) => `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`).join(';');
  if (shapeCache.has(sig)) return shapeCache.get(sig);
  const coords = way.map((s) => `${s.lon},${s.lat}`).join(';');
  try {
    const { data } = await upstream(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`, { timeoutMs: 12000 });
    if (data && data.code === 'Ok' && data.routes && data.routes[0]) {
      const pathLL = data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      shapeCache.set(sig, pathLL);
      persistShapes();
      return pathLL;
    }
  } catch { /* fall back to straight lines */ }
  return null;
}
const isRoadMode = (m) => /BUS|COACH/i.test(m || '');

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

// Coach drops reachable from the origin that make real PROGRESS toward the dest
// — candidate transfer points where MOTIS then walks to the nearest station and
// continues by train. Generalises the fixed 4-hub list to ANY station en route
// (the user's "bus drops me near a small station, I catch the train" case).
// Returns leg1-shaped coach results (earliest per drop), deduped, capped.
function coachDropsToward(fLat, fLon, tLat, tLon, days, radius = 2500) {
  const fromIdx = new Map(attachStops(fLat, fLon, radius).map((x) => [x.i, x.d]));
  if (!fromIdx.size) return [];
  const originDist = haversineM(fLat, fLon, tLat, tLon);
  const dayList = days || [romeParts(), romeParts(new Date(Date.now() + 86400000))];
  const now = dayList[0];
  const best = new Map(); // dropIdx → earliest-arriving candidate
  for (let dayOff = 0; dayOff < dayList.length; dayOff++) {
    const day = dayList[dayOff];
    for (const trip of coachTrips) {
      if (!serviceRuns(trip, day)) continue;
      let board = null;
      for (const [idx, min] of trip.s) {
        if (board === null) { if (fromIdx.has(idx)) board = { idx, min }; continue; }
        if (dayOff === 0 && board.min < now.min - 5) break; // this run already departed
        const drop = coachStops[idx];
        const dropDist = haversineM(drop.lat, drop.lon, tLat, tLon);
        if (dropDist >= originDist - 8000 || dropDist <= 2500) continue; // no real progress / basically at dest
        const arrAbsMin = min + dayOff * 1440;
        const prev = best.get(idx);
        if (prev && prev.arrAbsMin <= arrAbsMin) continue;
        best.set(idx, {
          day: dayOff === 0 ? 'today' : 'tomorrow', route: trip.r, operator: trip.op,
          from: coachStops[board.idx].n, to: drop.n,
          fromWalkM: Math.round(fromIdx.get(board.idx) || 0), toWalkM: 0,
          dep: fmtMin(board.min), arr: fmtMin(min),
          arrPlus: Math.floor(min / 1440) - Math.floor(board.min / 1440),
          depMin: board.min + dayOff * 1440, arrAbsMin,
          arrLat: drop.lat, arrLon: drop.lon, routeId: trip.r, dropDist,
        });
      }
    }
  }
  const ranked = [...best.values()].sort((a, b) => a.dropDist - b.dropDist || a.arrAbsMin - b.arrAbsMin);
  const picked = [];
  for (const c of ranked) {
    if (picked.some((p) => haversineM(p.arrLat, p.arrLon, c.arrLat, c.arrLon) < 3000)) continue;
    picked.push(c);
    if (picked.length >= 5) break;
  }
  return picked;
}

// Coach [origin → transfer] + MOTIS [transfer → dest]. Transfer points = the
// named rail hubs (fast-train backtracks) PLUS any coach drop that progresses
// toward the dest. MOTIS onward is run in PARALLEL so trying more stations
// stays fast. Returns the best stitch per transfer, sorted/capped downstream.
async function hubStitch(fLat, fLon, toPlace, destCoords, days, baseDate) {
  // named hubs → coach leg1s
  const cands = [];
  for (const hub of HUBS) {
    if (haversineM(fLat, fLon, hub.lat, hub.lon) < 8000) continue; // already at/near the hub
    const leg1 = (directSearch(fLat, fLon, hub.lat, hub.lon, 2500, days, true).results || [])[0];
    if (leg1) { leg1._name = hub.name; cands.push(leg1); }
  }
  // dynamic drops toward the dest (needs dest coords)
  if (destCoords) {
    for (const c of coachDropsToward(fLat, fLon, destCoords.lat, destCoords.lon, days)) {
      if (isFinite(c.arrLat) && isFinite(c.arrLon)) cands.push(c);
    }
  }
  // dedup by drop location (~3km); hubs listed first so they win, cap the fan-out
  const uniq = [];
  for (const c of cands) {
    if (!isFinite(c.arrLat) || !isFinite(c.arrLon)) continue;
    if (uniq.some((p) => haversineM(p.arrLat, p.arrLon, c.arrLat, c.arrLon) < 3000)) continue;
    uniq.push(c);
    if (uniq.length >= 6) break;
  }
  const stitches = await Promise.all(uniq.map(async (leg1) => {
    const boardIso = romeInstant(baseDate, (leg1.arrAbsMin ?? 0) + 15); // 15-min transfer cushion
    // Onward search starts from the coach's ACTUAL drop point, so MOTIS walks
    // to whichever station is nearest (maxPreTransitTime 60 min) and renders
    // that walk as a leg — the drop is rarely on the platform itself.
    let onward;
    try { onward = await motisPlan(`${leg1.arrLat},${leg1.arrLon}`, toPlace, { timeIso: boardIso, searchWindow: '21600' }); }
    catch { return null; }
    const best = (onward || [])[0];
    if (!best) return null;
    const depInstant = romeInstant(baseDate, leg1.depMin ?? 0);
    const journeyMin = Math.round((new Date(best.endTime).getTime() - new Date(depInstant).getTime()) / 60000);
    return { hub: leg1._name || leg1.to, coach: leg1, onward: best, finalArrival: best.endTime, journeyMin };
  }));
  return stitches.filter(Boolean);
}

// Reverse orientation: MOTIS [origin → hub] + our coach [hub → destination].
// Answers a rail-served origin (an airport) to a coach-only town (Raffadali):
// take the train to the city, then the coach onward. `fromPlace` is a MOTIS
// place; the destination is coords for the coach search.
async function hubStitchReverse(fromPlace, tLat, tLon, days, baseDate, queryTimeIso) {
  const stitches = [];
  for (const hub of HUBS) {
    if (haversineM(tLat, tLon, hub.lat, hub.lon) < 8000) continue; // dest already at the hub
    // Cheap gate first: does our feed even run hub → dest? (no upstream cost)
    if (!(directSearch(hub.lat, hub.lon, tLat, tLon, 2500, days, false).results || []).length) continue;
    let toHub;
    try { toHub = await motisPlan(fromPlace, `${hub.lat},${hub.lon}`, { timeIso: queryTimeIso }); }
    catch { continue; }
    const rail = (toHub || [])[0];
    if (!rail) continue;
    // Coach from the hub departing after the train arrives (+15 min cushion).
    const arr = romeParts(new Date(rail.endTime));
    const coachDays = [{ ...arr, min: arr.min + 15 }, romeParts(new Date(new Date(rail.endTime).getTime() + 86400000))];
    const coach = directSearch(hub.lat, hub.lon, tLat, tLon, 2500, coachDays, true);
    const leg2 = (coach.results || [])[0];
    if (!leg2) continue;
    const coachArrIso = romeInstant(arr.iso, leg2.arrAbsMin ?? 0);
    stitches.push({
      hub: hub.name, reverse: true, onward: rail, coach: leg2,
      finalArrival: coachArrIso,
      journeyMin: Math.round((new Date(coachArrIso).getTime() - new Date(rail.startTime).getTime()) / 60000),
    });
  }
  return stitches;
}

// Rank forward + reverse together by total journey, not arrival clock: a coach
// leaving tonight and arriving 04:49 after an 11 h overnight wait must not
// outrank a 3 h daytime trip that departs tomorrow. A stitch over 10 h is not
// a real answer — drop it entirely rather than surface a 13 h "option" next to
// a good direct coach the caller may already be showing.
function rankStitches(all) {
  return all
    .filter((s) => s.journeyMin > 0 && s.journeyMin <= 600)
    .sort((a, b) => a.journeyMin - b.journeyMin)
    .slice(0, 3);
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
    // F-7: the trip id lets "Show on map" fetch this leg's REAL geometry via
    // /api/trip on demand — polylines stay out of every plan response.
    tripId: l.tripId || null,
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

// Drop strictly-dominated itineraries (audit 2026-07-28). MOTIS timetableView
// returns departure-ordered, so a 10 h rail milk-run can sit ABOVE a 3 h coach
// leaving at nearly the same time (Catania→Ragusa, Palermo→Enna). A traveller
// wants to leave no earlier and arrive no later: itinerary B dominates A when it
// departs >= A and arrives <= A with at least one strict — then A is pure waste.
// Ties (same start+end) are both kept; the caller sorts for display.
function dropDominated(its) {
  const t = (x) => [new Date(x.startTime).getTime(), new Date(x.endTime).getTime()];
  return its.filter((a, i) => {
    const [as, ae] = t(a);
    if (!isFinite(as) || !isFinite(ae)) return true;
    return !its.some((b, j) => {
      if (i === j) return false;
      const [bs, be] = t(b);
      if (!isFinite(bs) || !isFinite(be)) return false;
      return bs >= as && be <= ae && (bs > as || be < ae);
    });
  });
}
function inSicily(lat, lon) {
  return lat >= SICILY.latMin && lat <= SICILY.latMax && lon >= SICILY.lonMin && lon <= SICILY.lonMax;
}

// Geocode location bias: the client sends "lat,lon" (its known position when
// inside Italy, else the Sicily centroid). Forwarded to Transitous as &place=
// so a bare street query ("Via Crocifisso") surfaces NEARBY matches instead of
// a globally-ranked list where Sicily barely appears. Returns null if malformed.
function parseBias(str) {
  if (!str || typeof str !== 'string' || str.length > 40) return null;
  const m = str.match(/^(-?\d{1,3}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// Big urban hubs (AMAT Palermo, AMTS Catania) model each direction and platform
// as a SEPARATE stop node, so a place like Palermo Centrale returns dozens of
// pins packed together — a transit-depot area. Collapse any stops within ~200m
// of a seed into ONE pin REGARDLESS of name: seeds are taken nearest-the-centre
// first (so the surviving pin is the most central), modes are unioned, `merged`
// records how many folded in. Stops >200m from every seed stay separate — in
// normal areas bus stops are 300m+ apart, so this only fires on dense clusters.
// Name a merged depot by what its stops CALL the area, not by whichever single
// stop is nearest the centre. At a station the boarding islands nearly all share
// a leading phrase ("STAZIONE CENTRALE Lincoln / Balsamo / Pensilina …") — that
// shared phrase is the area name. Returns the longest leading token-run present
// in a majority (≥50%) of the members, min 2 tokens (a lone "Via"/"Piazza" is
// not an area name), else null → keep the seed's own name.
function clusterAreaName(names) {
  let pool = names.map((n) => (n || '').trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
  const total = pool.length;
  if (total < 2) return null;
  const need = Math.max(2, Math.ceil(total * 0.5));
  const out = [];
  for (let i = 0; i < 4; i++) {
    const counts = new Map();
    for (const t of pool) if (i < t.length) counts.set(t[i].toUpperCase(), (counts.get(t[i].toUpperCase()) || 0) + 1);
    let best = null, bestC = 0;
    for (const [w, c] of counts) if (c > bestC) { best = w; bestC = c; }
    if (!best || bestC < need) break;
    out.push(best);
    pool = pool.filter((t) => i < t.length && t[i].toUpperCase() === best);
  }
  return out.length >= 2 ? out.join(' ') : null;
}

// ── TRANSIT HUBS ──
// Curated airport/main-station "hubs" that get a single unified departures pin
// on the map. A tap fans out to rail + coach + urban buses within radiusM and
// merges the boards (see /api/hub-board). Coords are approximate — fine for a
// ~400–500m hub radius. Airports are limited to the 4 mainland-served fields.
// Curated 2026-08-01 (user review of live boards): hubs are the MAJOR gateways
// only — Palermo/Catania stations+airports and the Messina rail gateway. The
// provincial stations (Siracusa, Ragusa, Agrigento, Caltanissetta, Enna,
// Trapani) and minor airports (Trapani-Birgi, Comiso) returned thin or empty
// boards and diluted the concept; their stops render as normal pins instead.
// Pins audited 2026-08-02 against exact Trenitalia GTFS station coords + the
// feed's forecourt stop clusters — the original "approximate" pins were up to
// ~1.2km off (Messina 931m, Palermo airport 1.2km), silently dropping real
// forecourt stops out of the fan-out radius.
const TRANSIT_HUBS = [
  { id: 'palermo-airport', name: 'Aeroporto Falcone Borsellino', kind: 'airport', lat: 38.1881, lon: 13.1093, radiusM: 500, railName: 'PALERMO AEROPORTO' },
  { id: 'catania-airport', name: 'Aeroporto Catania Fontanarossa', kind: 'airport', lat: 37.4700, lon: 15.0670, radiusM: 500, railName: 'CATANIA AEROPORTO FONTANAROSSA' },
  { id: 'palermo-centrale', name: 'Palermo Centrale', kind: 'rail', lat: 38.1089, lon: 13.3675, radiusM: 500, railName: 'PALERMO CENTRALE' },
  { id: 'catania-centrale', name: 'Catania Centrale', kind: 'rail', lat: 37.5049, lon: 15.0994, radiusM: 400, railName: 'CATANIA CENTRALE' },
  { id: 'messina-centrale', name: 'Messina Centrale', kind: 'rail', lat: 38.1833, lon: 15.5613, radiusM: 500, railName: 'MESSINA CENTRALE' },
];
function hubsInBbox(minLat, minLon, maxLat, maxLon) {
  return TRANSIT_HUBS.filter((h) => h.lat >= minLat && h.lat <= maxLat && h.lon >= minLon && h.lon <= maxLon);
}

// ── AIRPORT SEARCH ALIASES ──
// An IATA code is how people name an airport, and the geocoder knows none of
// them (measured 2026-08-07: "PMO" returned nothing; "CTA" confidently returned
// a hamlet near Paternò — a wrong answer is worse than none, because it gets
// picked). Colloquial names fail the same way: "punta raisi", "falcone
// borsellino" and "birgi" all land on unrelated piazzas and towns.
//
// This is a SEARCH-time layer only — it does not make an airport a hub.
// Trapani-Birgi and Comiso stay off the hub map (their boards were too thin,
// see the note above), but a code that lands on the right coordinate is useful
// regardless of how busy the departures board is.
//
// Every entry resolves to its COORDINATE, never to an upstream stop id.
// Measured: planning Palermo airport → Palermo Centrale from the coordinate
// returns the same REG 5636 train as planning from the rail station's stop id,
// PLUS the shuttle coach — the coordinate is a superset, and it keeps a
// fragile third-party id out of our source. The other three airports have no
// rail station at all, so the coordinate is the only honest answer there.
// Palermo/Catania coords are the audited hub pins; Trapani/Comiso are their
// terminal bus areas from the coach feed.
const AIRPORTS = [
  { iata: 'PMO', name: 'Aeroporto Falcone Borsellino', town: 'Cinisi', province: 'Palermo', lat: 38.1881, lon: 13.1093,
    aliases: ['punta raisi', 'palermo punta raisi', 'falcone borsellino', 'aeroporto di palermo'] },
  { iata: 'CTA', name: 'Aeroporto Catania Fontanarossa', town: 'Catania', province: 'Catania', lat: 37.4700, lon: 15.0670,
    aliases: ['fontanarossa', 'aeroporto di catania'] },
  { iata: 'TPS', name: 'Aeroporto Trapani-Birgi Vincenzo Florio', town: 'Misiliscemi', province: 'Trapani', lat: 37.91136, lon: 12.48747,
    aliases: ['birgi', 'trapani birgi', 'aeroporto di trapani'] },
  { iata: 'CIY', name: 'Aeroporto Comiso Pio La Torre', town: 'Comiso', province: 'Ragusa', lat: 36.99428, lon: 14.60716,
    aliases: ['aeroporto di comiso'] },
];
// EXACT match only, on the code or on a listed alias. Never a substring — a
// 3-letter code matched loosely turns "CTA" into a hit on every "Catania…"
// string and the fix becomes noise.
function airportMatch(text) {
  // norm() lowercases and strips diacritics but leaves whitespace alone, so
  // trim/collapse here — the handler trims its input, other callers may not.
  const n = norm(text || '').trim().replace(/\s+/g, ' ');
  if (!n) return null;
  return AIRPORTS.find((a) => norm(a.iata) === n || a.aliases.some((x) => norm(x) === n)) || null;
}
// Shaped like a geocode row so it merges into the same list/dedupe/sort.
function airportResult(a) {
  return {
    type: 'AIRPORT', iata: a.iata, name: a.name, id: null, lat: a.lat, lon: a.lon,
    modes: [], category: 'aerodrome', town: a.town, province: a.province, importance: 1,
  };
}

// F-6 (2026-08-10 walkthrough): "AGRIGENTO (P.LE ROSSELLI)" and "Agrigento
// P.Rosselli" are the same stop wearing different punctuation — the old
// name|town key kept both. The key now strips punctuation and drops
// abbreviation stubs (letter tokens ≤2 chars: P, LE, C…), so punctuation
// variants collapse while genuinely distinct names ("Agrigento Centrale" vs
// "Agrigento Bassa") stay apart. Digit tokens always count ("N2" vs "N4").
function geoDedupeKey(name, town) {
  const toks = norm(name || '').replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/)
    .filter((t) => t.length >= 3 || /\d/.test(t));
  return `${toks.join(' ') || norm(name || '')}|${norm(town || '')}`;
}

// ── TICKET SELLERS (v1.6.0) ──
// Sicily rivendite from OSM (shop=tobacco/newsagent/ticket; Overpass extract
// 2026-08-10 → server/ticket-shops.json, 1,520 points). "Buy before boarding"
// is only actionable if the app can point at a seller near the boarding stop.
let ticketShops = [];
try {
  ticketShops = JSON.parse(fs.readFileSync(path.join(__dirname, 'ticket-shops.json'), 'utf8'));
} catch { /* endpoint answers empty — the how-to-buy text stands alone */ }
const SHOP_LABEL = { tobacco: 'Tabaccheria', newsagent: 'Edicola', ticket: 'Biglietteria' };
function nearestTicketShops(shops, lat, lon, radiusM = 600, n = 3) {
  const out = [];
  for (const s of shops) {
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d <= radiusM) out.push({ s, d: Math.round(d) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, n).map(({ s, d }) => ({
    name: s.n || SHOP_LABEL[s.t] || 'Rivendita',
    kind: SHOP_LABEL[s.t] || null,
    lat: s.lat, lon: s.lon, dist: d,
  }));
}

// ── NOMINATIM COVERAGE FALLBACK (v1.3.1) ──
// Transitous's geocoder skips some OSM natural features: "Punta Bianca" (the
// Agrigento cape, natural=cape in OSM) returned NOTHING Sicilian, so the app
// confidently offered an Alpine peak 1060 km away — the exact confident-wrong-
// answer failure we design against. When upstream yields zero Sicilian rows,
// ask Nominatim hard-bounded to the Sicily bbox (it can only answer with local
// places; a truly unknown name stays an honest empty). Rare by construction —
// any query with one Sicilian hit never reaches it — cached with the geocode
// response for 24h, and rate-guarded to respect Nominatim's 1 req/s policy.
const SICILY_VIEWBOX = '12.3,38.4,15.7,36.6'; // lon1,lat1,lon2,lat2
let lastNominatimMs = 0;
function nominatimToRow(n) {
  const a = n.address || {};
  return {
    type: 'PLACE', name: n.name || String(n.display_name || '').split(',')[0], id: null,
    lat: Number(n.lat), lon: Number(n.lon),
    modes: [], category: n.type || null,
    town: a.city || a.town || a.village || null,
    province: a.county || a.province || null,
    importance: n.importance || 0,
  };
}
async function nominatimFallback(text) {
  const now = Date.now();
  if (now - lastNominatimMs < 1100) return []; // policy: ≤1 req/s — skip, never queue
  lastNominatimMs = now;
  try {
    const { data } = await upstream(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}`
      + `&viewbox=${SICILY_VIEWBOX}&bounded=1&format=jsonv2&addressdetails=1&limit=6`,
      { timeoutMs: 8000 },
    );
    return (data || []).map(nominatimToRow)
      .filter((r) => r.name && isFinite(r.lat) && isFinite(r.lon) && inSicily(r.lat, r.lon));
  } catch { return []; } // fallback of a fallback is the status quo
}

// Merge already-shaped departure rows from N sources into one board: drop
// anything already departed, sort ascending by time, stamp `minutes` from now,
// then apply a per-mode cap (so one busy mode can't crowd out the others) and
// an overall cap. Rows keep their common shape {mode,line,headsign,timeISO,…}.
function mergeDepartures(lists, nowMs, opts = {}) {
  const perMode = opts.perMode || 8, cap = opts.cap || 30;
  // full boards keep the WHOLE day: already-departed rows survive back to
  // dayStartMs (client dims them); the default board stays future-only.
  const floor = opts.dayStartMs != null ? opts.dayStartMs : nowMs;
  let rows = [].concat(...(lists || [])).filter((r) => r && r.timeISO && Date.parse(r.timeISO) >= floor);
  rows.sort((a, b) => Date.parse(a.timeISO) - Date.parse(b.timeISO));
  // Collapse exact repeats: a big station has many platform/stop nodes, so the
  // same line+destination+time comes back once per node (Palermo Centrale
  // returned "101 → Stazione Centrale" 7×). Same mode+line+headsign+instant =
  // one departure. Genuinely-spaced runs of a line keep their own rows. Prefer
  // the realtime copy when duplicates disagree.
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.mode}|${r.line}|${r.headsign}|${r.timeISO}`;
    if (!byKey.has(k)) byKey.set(k, r);
    else if (r.realtime && !byKey.get(k).realtime) byKey.set(k, r);
  }
  rows = [...byKey.values()];
  const seen = {};
  rows = rows.filter((r) => { seen[r.mode] = (seen[r.mode] || 0) + 1; return seen[r.mode] <= perMode; });
  rows = rows.slice(0, cap);
  return rows.map((r) => ({ ...r, minutes: Math.round((Date.parse(r.timeISO) - nowMs) / 60000) }));
}

function clusterStopsByProximity(stops, radiusM = 200) {
  const byDist = [...stops].sort((a, b) => a.dist - b.dist);
  const claimed = new Set();
  const out = [];
  for (const seed of byDist) {
    if (claimed.has(seed)) continue;
    claimed.add(seed);
    const modes = new Set(seed.modes || []);
    // members = the real underlying stops (id + specific name + modes), so the
    // map can offer a "pick the exact stop" list on a merged depot pin with
    // the right mode icon per row.
    const members = [{ id: seed.id, name: seed.name, lat: seed.lat, lon: seed.lon, modes: seed.modes || [] }];
    for (const s of byDist) {
      if (claimed.has(s)) continue;
      if (haversineM(seed.lat, seed.lon, s.lat, s.lon) <= radiusM) {
        claimed.add(s);
        for (const md of s.modes || []) modes.add(md);
        members.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, modes: s.modes || [] });
      }
    }
    // Transitous often emits one stop record per DIRECTION, so a cluster can
    // hold several members with the IDENTICAL name ("Messina Marine Alagna" ×2).
    // That double-counted the pin and showed repeat rows in the picker. Collapse
    // same-name members (within the cluster only — different-named boarding
    // islands like Palermo Centrale's platforms are kept): keep the closest
    // (members are dist-ordered) and union the ids so a board can query both.
    const byName = new Map();
    for (const m of members) {
      const key = m.name.trim().replace(/\s+/g, " ").toUpperCase();
      const prev = byName.get(key);
      if (prev) prev.ids.push(m.id);
      else byName.set(key, { id: m.id, ids: [m.id], name: m.name, lat: m.lat, lon: m.lon });
    }
    const uniq = [...byName.values()];
    const merged = uniq.length;
    // Only re-name real depots (3+ distinct stops); a pair keeps its own name.
    const name = (merged >= 3 && clusterAreaName(uniq.map((m) => m.name))) || seed.name;
    const o = { ...seed, name, modes: [...modes], merged };
    if (merged > 1) o.members = uniq; // drives the map's specific-stop picker
    out.push(o);
  }
  return out;
}

// Sort key for a geocode result. Lower sorts first. Region is PRIMARY — this is
// a Sicily-first app, so every Sicilian result ranks above every mainland one
// (mainland still appears, just below). Within a region the type bucket orders
// stops → coach stops → settlements → other → addresses. Without the region
// term, two mainland stops named "Via Crocifisso" (Puglia/Lazio) outranked the
// whole Sicilian street list a Sicily user is actually after.
function geoScore(r, text) {
  const cat = r.category || '';
  const name = (r.name || '');
  let bucket;
  // an exact airport code/alias hit is the answer to the query, not a candidate
  if (r.type === 'AIRPORT') bucket = -1;
  else if (r.type === 'STOP') bucket = 0;
  else if (r.type === 'COACH_STOP') bucket = 1;
  else if (/^(city|town|village|hamlet)/.test(cat) || (name.toLowerCase() === (text || '').toLowerCase() && !cat)) bucket = 2;
  else if (r.type === 'ADDRESS' || /^(via|viale|corso|salita|piazza)\b/i.test(name)) bucket = 4;
  else bucket = 3;
  return (inSicily(r.lat, r.lon) ? 0 : 10) + bucket;
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
    trainNumber: d.numeroTreno,
    // "REG 21840" ready-made; falls back to category + number.
    label: (d.compNumeroTreno || '').trim() || `${d.categoria || ''} ${d.numeroTreno}`.trim(),
    category: d.categoriaDescrizione || d.categoria || '',
    destination: d.destinazione || '',
    // orarioPartenza is the reliable SCHEDULED epoch; partenzaTreno is usually
    // null. compOrarioPartenza is the pre-formatted "21:03" clock.
    scheduledMs: d.orarioPartenza || d.partenzaTreno || null,
    clock: d.compOrarioPartenza || null,
    delayMin: typeof d.ritardo === 'number' ? d.ritardo : null,
    platform: d.binarioEffettivoPartenzaDescrizione || d.binarioProgrammatoPartenzaDescrizione || null,
    departed: d.nonPartito === false && !d.inStazione, circulating: !!d.circolante,
    cancelled: d.provvedimento === 1 || d.tipoTreno === 'ST',
  };
}

// Resolve a Transitous rail stopId (or a station name) to a ViaggiaTreno S-code.
// The Trenitalia stopId embeds the RFI code: …otherTRENITALIA:830012002 → S12002.
async function resolveVtCode(stopId, name) {
  const m = String(stopId || '').match(/(?:TRENITALIA:)?8300(\d{4,6})$/);
  if (m) return `S${m[1]}`;
  const n = String(name || '').trim();
  if (n.length >= 2) {
    try {
      const { data } = await upstream(`${VT}/autocompletaStazione/${encodeURIComponent(n.toUpperCase())}`, { asText: true });
      const st = parseVtStations(data || '')[0];
      if (st && /^S\d+$/.test(st.id)) return st.id;
    } catch { /* VT down — caller falls back */ }
  }
  return null;
}

// ── HUB-BOARD PRODUCERS (shared with the existing routes; DRY) ──
// Transitous map/stops in a radius around a point → common stop records. The
// upstream query is a bbox; callers that need a true circle filter by haversine.
// Also the producer behind /api/map-stops' transit array.
// Malta is in Transitous but out of our coverage — an island-zoom radius swept
// in "Aeroporto di Malta (MLA)" and drew it as a lone pin in open sea (map
// deep dive M-2). Exclusion is Malta's OWN bbox, not a latitude line: the
// Pelagie islands (Lampedusa 35.50, Linosa 35.86) are Sicilian and sit further
// SOUTH than Malta — they survive because they lie west of 13.9°E.
function outOfCoverage(lat, lon) {
  return lat > 35.6 && lat < 36.2 && lon > 13.9 && lon < 14.9;
}

async function transitStopsInRadius(lat, lon, r) {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  const { data } = await upstream(`${TRANSITOUS}/api/v1/map/stops?min=${lat - dLat},${lon - dLon}&max=${lat + dLat},${lon + dLon}`);
  return (data || []).filter((s) => !outOfCoverage(s.lat, s.lon)).map((s) => ({
    stopId: s.stopId, name: s.name, lat: s.lat, lon: s.lon,
    modes: s.modes || [], dist: Math.round(haversineM(lat, lon, s.lat, s.lon)),
  }));
}

// Google encoded-polyline decoder (MOTIS legGeometry, precision usually 7).
function decodePolyline(str, precision = 7) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lon = 0;
  const path = [];
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += d; else lon += d;
    }
    path.push([lat / factor, lon / factor]);
  }
  return path;
}

function romeClockMs(ms) {
  if (!ms || !isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

// One Transitous trip normalized for the map tracer: ordered stops with
// clocks + the real route geometry. Works for ANY network trip — city buses
// and trains alike (Trenitalia trips ship track polylines).
async function tripShape(tripId) {
  if (!tripId) throw httpError(400, 'tripId required');
  const key = `trip:${tripId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { data } = await upstream(`${TRANSITOUS}/api/v1/trip?tripId=${encodeURIComponent(tripId)}`);
  const leg = ((data && data.legs) || []).find((l) => l.mode !== 'WALK');
  if (!leg) throw httpError(404, 'no transit leg on this trip');
  const pts = [leg.from, ...(leg.intermediateStops || []), leg.to].filter((p) => p && isFinite(p.lat) && isFinite(p.lon));
  const shape = {
    name: leg.routeShortName || leg.displayName || '', mode: leg.mode,
    operator: leg.agencyName || null, headsign: leg.headsign || '',
    stops: pts.map((p) => ({
      name: p.name, lat: p.lat, lon: p.lon, stopId: p.stopId || null,
      t: romeClockMs(Date.parse(p.departure || p.scheduledDeparture || p.arrival || p.scheduledArrival || '')),
    })),
    path: (leg.legGeometry && leg.legGeometry.points)
      ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision || 7) : null,
  };
  cacheSet(key, shape, 5 * 60 * 1000);
  return shape;
}

// Normalized upcoming stoptimes for a Transitous stop. The producer behind
// /api/stoptimes (identical shape + 60s cache).
async function stoptimesData(stopId, n = 6, timeIso = null) {
  const nn = Math.min(n, 20);
  const key = `st:${stopId}:${nn}${timeIso ? `:${timeIso}` : ''}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const timeQ = timeIso ? `&time=${encodeURIComponent(timeIso)}` : '';
  const { data } = await upstream(`${TRANSITOUS}/api/v1/stoptimes?stopId=${encodeURIComponent(stopId)}&n=${nn}${timeQ}`);
  let rows = (data.stopTimes || []).map((st) => ({
    stopName: st.place?.name || null, stopId: st.place?.stopId || null,
    departure: st.place?.departure || st.place?.arrival || null,
    scheduledDeparture: st.place?.scheduledDeparture || st.place?.scheduledArrival || null,
    cancelled: !!st.place?.cancelled, mode: st.mode, realTime: !!st.realTime,
    headsign: st.headsign || '', routeShortName: st.routeShortName || st.displayName || '',
    agencyName: st.agencyName || null, tripId: st.tripId || null,
    track: st.place?.track || null,
  }));
  // Upstream feeds duplicate some departures (AMAT per-direction records,
  // Trenitalia rail-replacement "BUS" rows ×3): same instant + line + headsign
  // = one departure everywhere downstream (sheet, fav cards, hub boards).
  // Prefer the realtime copy when duplicates disagree.
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.departure || r.scheduledDeparture}|${r.routeShortName}|${r.headsign}|${r.mode}`;
    if (!seen.has(k) || (r.realTime && !seen.get(k).realTime)) seen.set(k, r);
  }
  rows = [...seen.values()];
  // Trenitalia's GTFS ships EMPTY headsigns for many trips, leaving schedule
  // rows that say "REG 21850" with no direction — unusable. VT knows every
  // train's destination; enrich the blanks from it (cached per train, bounded
  // fan-out, best-effort: a VT miss just leaves the row as it was).
  // F-3: Trenitalia's rail-REPLACEMENT buses ship the same blank headsigns as
  // its trains — when the route name carries the train number, VT can name
  // their destination too (mode BUS + a Trenitalia trip id = replacement run).
  const vtEligible = (r) => /RAIL|LONG_DISTANCE/.test(r.mode || '')
    || (r.mode === 'BUS' && /trenitalia/i.test(r.tripId || ''));
  const blanks = [...new Set(rows
    .filter((r) => vtEligible(r) && !r.headsign)
    .map((r) => (r.routeShortName.match(/(\d{3,6})\s*$/) || [])[1])
    .filter(Boolean))].slice(0, 15);
  if (blanks.length) {
    const dests = new Map();
    await Promise.all(blanks.map(async (num) => {
      const meta = await vtTrainMeta(num);
      if (meta.destination) dests.set(num, meta.destination);
    }));
    for (const r of rows) {
      if (r.headsign) continue;
      const num = (r.routeShortName.match(/(\d{3,6})\s*$/) || [])[1];
      if (num && dests.has(num)) r.headsign = dests.get(num);
    }
  }
  const out = { fetchedAt: Date.now(), stopTimes: rows };
  cacheSet(key, out, 60 * 1000);
  return out;
}

// Live ViaggiaTreno board for an already-resolved S-code. The producer behind
// /api/vt/board (shared so the endpoint and the hub board never diverge).
async function vtBoardByCode(code) {
  if (!code) return { source: 'viaggiatreno', code: null, departures: [] };
  const key = `vtb:${code}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let departures = [];
  try {
    const { data } = await upstream(`${VT}/partenze/${code}/${encodeURIComponent(romeNowString())}`);
    departures = (data || []).map(slimVtDeparture)
      .filter((d) => d.scheduledMs || d.clock)
      .sort((a, b) => (a.scheduledMs || 0) - (b.scheduledMs || 0));
  } catch { /* VT down → empty → client uses MOTIS */ }
  const out = { source: 'viaggiatreno', code, fetchedAt: Date.now(), departures };
  cacheSet(key, out, 60 * 1000);
  return out;
}
// Resolve a rail hub's station name to its VT board.
async function vtBoardData(name) {
  return vtBoardByCode(await resolveVtCode(null, name));
}

// ── HUB-BOARD NORMALIZERS (each returns the common departure row shape) ──
// COACH: our own feed board around the hub. depMin already folds tomorrow
// (+1440), so romeInstant gives a DST-safe instant for today OR tomorrow.
function coachRows(hub, withVia = false) {
  const { results = [] } = coachBoard(hub.lat, hub.lon, hub.radiusM, null, true, withVia);
  const todayIso = romeParts().iso;
  return results.map((r) => ({
    mode: 'COACH', line: r.route, headsign: r.headsign,
    timeISO: romeInstant(todayIso, r.depMin),
    operator: r.operator || null, stopName: r.stopName || hub.name, realtime: false, stopId: null,
    ...(withVia ? { via: r.via || [], ci: r.ci, sLat: r.sLat, sLon: r.sLon } : {}),
  }));
}
// URBAN (+ any rail Transitous also carries): stoptimes for the hub's nearest
// transit stops inside the radius. Bounded to the 8 nearest stops to cap the
// upstream fan-out on dense station forecourts.
async function urbanRows(hub, full = false) {
  const stops = (await transitStopsInRadius(hub.lat, hub.lon, hub.radiusM))
    .filter((s) => haversineM(hub.lat, hub.lon, s.lat, s.lon) <= hub.radiusM)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);
  const lists = await Promise.all(stops.map((s) => stoptimesData(s.stopId, full ? 20 : 12).then((d) => (d.stopTimes || [])
    // heavy rail comes authoritatively from the VT board (every hub has a
    // railName now); the Transitous copy of the same trains (REGIONAL_RAIL etc,
    // often headsign-less) would render as phantom "BUS REG 22204" duplicates
    .filter((st) => !/RAIL|LONG_DISTANCE/.test(st.mode || ''))
    .map((st) => ({
      mode: 'BUS', line: st.routeShortName || '', headsign: st.headsign || '',
      timeISO: st.departure || st.scheduledDeparture, operator: st.agencyName || null,
      stopName: st.stopName || s.name, realtime: !!st.realTime, stopId: s.stopId,
      tripId: st.tripId || null, // → /api/trip-shape (route + geometry on tap)
    }))).catch(() => [])));
  return [].concat(...lists);
}
// RAIL: live ViaggiaTreno board for the hub's station (any hub with a railName
// — both airports have real stations: Fontanarossa on the CT–SR line, Punta
// Raisi in-terminal). scheduledMs is the reliable epoch; rows without one drop
// out in mergeDepartures.
async function railRows(hub, withVia = false) {
  const board = await vtBoardData(hub.railName);
  const rows = (board.departures || []).map((d) => ({
    mode: 'RAIL', line: d.label || d.category || 'Treno', headsign: d.destination,
    timeISO: d.scheduledMs ? new Date(d.scheduledMs).toISOString() : null,
    operator: 'Trenitalia', stopName: hub.name, realtime: true, stopId: null,
    trainNumber: d.trainNumber || null,
  }));
  if (withVia) {
    await Promise.all(rows.map(async (r) => {
      r.via = r.trainNumber ? await vtCallsAfter(r.trainNumber, hub.railName) : [];
    }));
  }
  return rows;
}

// One cached VT lookup per train: its ordered stop list + destination.
// Feeds both the hub-board "via" search (calls after a station) and the
// empty-headsign enrichment in stoptimesData. Stop lists don't change within
// a run, so cache long. Any failure degrades to empties.
async function vtTrainMeta(trainNumber) {
  const key = `vtmeta:${trainNumber}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const meta = { stops: [], destination: null };
  try {
    const auto = await upstream(`${VT}/cercaNumeroTrenoTrenoAutocomplete/${trainNumber}`, { asText: true });
    const c = pickVtCandidate(parseVtTrainAutocomplete(auto.data || ''), Date.now());
    if (c) {
      const res = await upstream(`${VT}/andamentoTreno/${c.originId}/${c.trainNumber}/${c.departureEpochMs}`);
      const d = res.data || {};
      meta.stops = (d.fermate || []).filter((f) => f.stazione).map((f) => ({
        n: f.stazione,
        t: (f.programmata || f.partenza_teorica) ? new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(f.programmata || f.partenza_teorica)) : null,
      }));
      meta.destination = d.destinazione || (meta.stops[meta.stops.length - 1] || {}).n || null;
    }
  } catch { /* VT down → empties */ }
  cacheSet(key, meta, 30 * 60 * 1000);
  return meta;
}
// Stations a train calls at AFTER the given one — so a hub-board destination
// search can match a Messina-bound REG when you type "Taormina".
async function vtCallsAfter(trainNumber, stationName) {
  return afterStation((await vtTrainMeta(trainNumber)).stops, stationName);
}
function afterStation(stops, stationName) {
  const want = String(stationName || '').toUpperCase();
  const nameOf = (s) => String(s && s.n != null ? s.n : s).toUpperCase();
  const i = stops.findIndex((s) => {
    const u = nameOf(s);
    return u === want || u.includes(want) || want.includes(u);
  });
  return i >= 0 ? stops.slice(i + 1) : stops.slice();
}

// ── ROUTES ──
const routes = {
  'GET /api/health': async () => ({ ok: true, version: APP_VERSION, romeTime: romeNowString(), feedHorizon: feedHorizon(), viaggiaTreno: vtSilence(vtStats), upstreamRequests: dayCounts }),

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
    const bias = parseBias(q.get('place'));
    // Bias is part of the identity of the result set — cache per coarse locale
    // so a Palermo-biased and an Agrigento-biased "Via Roma" don't collide.
    const biasKey = bias ? `${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}` : '';
    const key = `geo:${text.toLowerCase()}|${biasKey}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const placeParam = bias ? `&place=${bias.lat},${bias.lon}` : '';
    const { data } = await upstream(`${TRANSITOUS}/api/v1/geocode?text=${encodeURIComponent(text)}&language=it${placeParam}`);
    // All of Italy (was Sicily-only): mainland addresses are now valid trip
    // endpoints; cross-border noise (France/Malta/Switzerland) drops by country.
    const results = (data || [])
      .filter((r) => r.country === 'IT')
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
    const COACH_AREA_M = 3000; // how close an upstream row must be to lend its town/province
    const needle = norm(text);
    const coach = coachStops
      .filter((s) => norm(s.n).includes(needle))
      .slice(0, 4)
      .map((s) => ({
        type: 'COACH_STOP', name: s.n, id: null, lat: s.lat, lon: s.lon,
        modes: ['COACH'], category: null, town: null, province: null, importance: 0,
      }));
    // Our own coach stops are {n,lat,lon} with no admin areas, so they rendered
    // BARE ("San Leone · coach stop") next to a fully-labelled homonym ("San
    // Leone · town · Tortorici · prov. Messina") — nothing on screen said which
    // one was the local one. Borrow town/province from a co-located upstream
    // result (same physical place, already carrying areas). Nothing within
    // reach => stay null: an invented province is worse than none, and a wrong
    // one would be exactly the confident-wrong-answer failure we design against.
    for (const c of coach) {
      let best = null, bestD = COACH_AREA_M;
      for (const r of results) {
        if (!r.town && !r.province) continue;
        const d = haversineM(c.lat, c.lon, r.lat, r.lon);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best) { c.town = best.town; c.province = best.province; }
    }
    // an exact IATA code / airport alias answers the query outright (see
    // AIRPORTS). It leads the array so the name+town dedupe below keeps OUR
    // row over a near-identical upstream one ("AEROPORTO CATANIA Fontanarossa"),
    // and geoScore's -1 bucket keeps it first after the sort. Upstream results
    // are still returned underneath — the alias adds an answer, it never hides
    // the geocoder's.
    const airport = airportMatch(text);
    // dedupe (name+town), rank: airport → transit stops → towns → the rest
    const seen = new Set();
    const all = [...(airport ? [airportResult(airport)] : []), ...results, ...coach].filter((r) => {
      const k = geoDedupeKey(r.name, r.town);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    let sorted = all.sort((a, b) => geoScore(a, text) - geoScore(b, text) || b.importance - a.importance);
    // Prioritise Sicily "for the time being": when Sicily has enough matches,
    // don't dilute the list with mainland homonyms (the app is Sicily-first).
    // Fall back to the all-Italy list only when the Sicilian side is sparse —
    // that's a genuine mainland query (e.g. "Via Dante Milano"), which still works.
    let sic = sorted.filter((r) => inSicily(r.lat, r.lon));
    // Zero Sicilian rows = the coverage gap case ("Punta Bianca") — see
    // nominatimFallback above. Merged rows re-enter the same dedupe + sort.
    if (!sic.length) {
      const extra = await nominatimFallback(text);
      const fresh = extra.filter((r) => {
        const k = geoDedupeKey(r.name, r.town);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      if (fresh.length) {
        sorted = [...sorted, ...fresh].sort((a, b) => geoScore(a, text) - geoScore(b, text) || b.importance - a.importance);
        sic = sorted.filter((r) => inSicily(r.lat, r.lon));
      }
    }
    const out = (sic.length >= 6 ? sic : sorted).slice(0, 15);
    cacheSet(key, out, 24 * 3600 * 1000);
    return out;
  },

  // Nearest bus-ticket sellers to a boarding stop (own data, no upstream).
  'GET /api/ticket-shops': (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) throw httpError(400, 'lat and lon required');
    const radius = Math.min(Number(q.get('r')) || 600, 1500);
    return { shops: nearestTicketShops(ticketShops, lat, lon, radius, 4) };
  },

  'GET /api/plan': async (q) => {
    const fromPlace = q.get('fromPlace'), toPlace = q.get('toPlace');
    if (!fromPlace || !toPlace) throw httpError(400, 'fromPlace and toPlace required');
    if (fromPlace.length > 120 || toPlace.length > 120) throw httpError(400, 'place too long');
    const params = new URLSearchParams({ fromPlace, toPlace });
    if (q.get('time')) params.set('time', q.get('time'));
    if (q.get('arriveBy') === 'true') params.set('arriveBy', 'true');
    // Whole-day view (Ship 3, R-24): the client raises maxItineraries and a
    // wide searchWindow; Earlier/Later pills page the edges via pageCursor.
    const maxIt = Number(q.get('maxItineraries'));
    const hasMax = Number.isInteger(maxIt) && maxIt > 0 && maxIt <= 60;
    if (hasMax) params.set('maxItineraries', String(maxIt));
    // numItineraries is a MINIMUM; MOTIS 400s when it exceeds maxItineraries.
    let numIt = Number(q.get('n')) || 6;
    if (hasMax) numIt = Math.min(numIt, maxIt);
    params.set('numItineraries', String(numIt));
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
      itineraries: dropDominated((data.itineraries || []).map(slimItinerary)),
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

  // Map tab: transit stops (Transitous) + our own coach stops in one bbox call,
  // each tagged with kind so the map can pin and route-highlight both.
  'GET /api/map-stops': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) throw httpError(400, 'lat/lon required');
    const agg = q.get('agg') === '1';
    const cellM = agg ? Math.max(60, Math.min(80000, Number(q.get('cell')) || 4000)) : 0;
    const r = Math.min(Number(q.get('r')) || 1500, agg ? 200000 : 8000);
    const dLat = r / 111320, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
    const key = `mapstops:${agg ? `a${cellM}:` : ''}${lat.toFixed(3)},${lon.toFixed(3)},${r}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    // Curated hubs in the viewport are returned as their OWN layer (both zoom
    // modes) so the client can draw them on top, never clustered or folded into
    // the heat map — a hub pin must stand out and show at every zoom level.
    const hubsInView = hubsInBbox(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
    const hubFeatures = hubsInView.map((h) => ({ kind: 'hub', id: `hub:${h.id}`, hubId: h.id, subkind: h.kind, name: h.name, lat: h.lat, lon: h.lon }));
    let transit = [];
    try {
      transit = (await transitStopsInRadius(lat, lon, r)).map((s) => ({
        kind: 'transit', id: s.stopId, name: s.name, lat: s.lat, lon: s.lon,
        modes: s.modes, dist: s.dist,
      }));
    } catch { /* coach stops still render if Transitous is down */ }
    const coach = [];
    for (let i = 0; i < coachStops.length; i++) {
      const s = coachStops[i];
      if (s.lat >= lat - dLat && s.lat <= lat + dLat && s.lon >= lon - dLon && s.lon <= lon + dLon) {
        coach.push({ kind: 'coach', id: `c${i}`, name: s.n, lat: s.lat, lon: s.lon, modes: ['COACH'], dist: Math.round(haversineM(lat, lon, s.lat, s.lon)) });
      }
    }
    // Aggregated mode (zoomed out): bucket every in-view stop onto an ABSOLUTE
    // grid sized to ~a fixed screen distance (cellM, passed by the client per
    // zoom). Absolute cell keys are stable across pans, so the client reconciles
    // cleanly (no stale-cluster pileup). A cell holding a SINGLE stop is
    // returned as that stop (client draws its icon, not a "1" bubble); cells
    // with more become one counted cluster. Counts are exact (whole bbox).
    if (agg) {
      const cellLat = cellM / 111320, cellLon = cellM / (111320 * Math.cos((lat * Math.PI) / 180));
      // Per-FAMILY cell counts (rail/city/coach, not just transit/coach) so the
      // client's filter chips can re-total the heat map without a refetch — a
      // transit-only split made Trains/City toggles no-ops at cluster zoom.
      const famOf = (s) => (s.kind === 'coach' ? 'coach'
        : (s.modes || []).some((m) => /RAIL|METRO|SUBWAY|TRAM|LONG_DISTANCE/.test(m)) ? 'rail' : 'city');
      const cells = new Map();
      for (const s of [...transit, ...coach]) {
        const ck = `${Math.floor(s.lon / cellLon)},${Math.floor(s.lat / cellLat)}`;
        const c = cells.get(ck) || { count: 0, sumLat: 0, sumLon: 0, rail: 0, city: 0, coach: 0, one: null };
        c.count++; c.sumLat += s.lat; c.sumLon += s.lon; c[famOf(s)]++;
        c.one = c.count === 1 ? s : null;
        cells.set(ck, c);
      }
      const clusters = [...cells.entries()].map(([ck, c]) => (c.count === 1
        ? { id: c.one.id, single: true, count: 1, lat: c.one.lat, lon: c.one.lon, name: c.one.name, kind: c.one.kind, modes: c.one.modes || [] }
        : { id: `g${ck}`, count: c.count, rail: c.rail, city: c.city, coach: c.coach,
            lat: c.sumLat / c.count, lon: c.sumLon / c.count, kind: c.coach >= c.rail + c.city ? 'coach' : 'transit' }
      )).sort((a, b) => b.count - a.count).slice(0, 300);
      const aggOut = { fetchedAt: Date.now(), aggregated: true, clusters, hubs: hubFeatures };
      cacheSet(key, aggOut, 5 * 60 * 1000);
      return aggOut;
    }
    // Collapse dense depot/interchange pile-ups: any transit stops within ~250m
    // fold into one pin (big hubs like Palermo Centrale model every direction &
    // platform as its own stop node). 250m (up from 200) consolidates the
    // station depots further without merging genuinely separate stops.
    transit = clusterStopsByProximity(transit, 250);
    transit.sort((a, b) => a.dist - b.dist);
    coach.sort((a, b) => a.dist - b.dist);
    // The transit/coach stops inside a hub's radius fold under its pin (a tap
    // opens the merged board), so the forecourt shows the hub pin instead of a
    // pile of stop pins. Hubs themselves ride the separate `hubs` layer above.
    const absorbed = (s) => hubsInView.some((h) => haversineM(h.lat, h.lon, s.lat, s.lon) <= h.radiusM);
    const out = { fetchedAt: Date.now(), hubs: hubFeatures, stops: [
      ...transit.filter((s) => !absorbed(s)).slice(0, 60),
      ...coach.filter((s) => !absorbed(s)).slice(0, 90),
    ] };
    cacheSet(key, out, 5 * 60 * 1000);
    return out;
  },

  // Routes serving a stop, with geometry, for the map's click-to-highlight.
  // Coach stops (?ci=<index>) resolve from our own feed (full paths). Transit
  // stops (?stopId=) resolve via MOTIS stoptimes → trip geometry, capped.
  'GET /api/stop-routes': async (q) => {
    let ci = q.get('ci');
    const stopId = q.get('stopId');
    // Favourites store coach stops by coords (no index) — resolve the nearest
    // coach stop so a saved coach stop can still trace its routes from the map.
    if (ci == null && !stopId) {
      const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
      if (isFinite(lat) && isFinite(lon)) {
        let best = -1, bestD = 250;
        for (let i = 0; i < coachStops.length; i++) {
          const d = haversineM(lat, lon, coachStops[i].lat, coachStops[i].lon);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) ci = String(best);
      }
    }
    if (ci != null && /^\d+$/.test(ci)) {
      const idx = Number(ci);
      if (idx < 0 || idx >= coachStops.length) throw httpError(400, 'bad ci');
      const key = `sr:c${idx}`;
      const hit = cacheGet(key);
      if (hit) return hit;
      const byRoute = new Map(); // route name → longest stop sequence seen
      for (const t of coachTrips) {
        if (!t.s.some(([i]) => i === idx)) continue;
        const prev = byRoute.get(t.r);
        if (!prev || t.s.length > prev.len) {
          byRoute.set(t.r, { len: t.s.length, operator: t.op, stops: t.s.map(([i]) => ({ name: coachStops[i].n, lat: coachStops[i].lat, lon: coachStops[i].lon })) });
        }
      }
      const routes = [...byRoute.entries()].slice(0, 10).map(([name, v]) => ({ name, mode: 'COACH', operator: v.operator, stops: v.stops }));
      // Road-snap each line so the drawn path follows real roads (coaches only).
      await Promise.all(routes.map(async (rt) => { rt.path = await snapToRoads(rt.stops); }));
      const o = coachStops[idx];
      const out = { origin: { name: o.n, lat: o.lat, lon: o.lon }, routes };
      cacheSet(key, out, 10 * 60 * 1000);
      return out;
    }
    if (!stopId) throw httpError(400, 'ci or stopId required');
    const key = `sr:${stopId}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const { data } = await upstream(`${TRANSITOUS}/api/v1/stoptimes?stopId=${encodeURIComponent(stopId)}&n=16`);
    const seen = new Set(), trips = [];
    for (const st of data.stopTimes || []) {
      const rk = st.routeShortName || st.displayName;
      if (!rk || seen.has(rk) || !st.tripId) continue;
      seen.add(rk);
      trips.push({ route: rk, mode: st.mode, tripId: st.tripId });
      if (trips.length >= 5) break; // cap MOTIS trip calls per click
    }
    const routes = [];
    for (const t of trips) {
      try {
        const { data: td } = await upstream(`${TRANSITOUS}/api/v1/trip?tripId=${encodeURIComponent(t.tripId)}`, { timeoutMs: 8000 });
        const leg = (td.legs || []).find((l) => l.mode !== 'WALK');
        if (!leg) continue;
        const stops = [leg.from, ...(leg.intermediateStops || []), leg.to]
          .filter((p) => p && isFinite(p.lat) && isFinite(p.lon))
          .map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }));
        if (stops.length >= 2) routes.push({ name: t.route, mode: t.mode, stops });
      } catch { /* skip a trip that won't resolve */ }
    }
    // Road-snap bus lines only — trains/trams don't follow the road network.
    await Promise.all(routes.map(async (rt) => { if (isRoadMode(rt.mode)) rt.path = await snapToRoads(rt.stops); }));
    const o = data.stopTimes?.[0]?.place;
    const out = { origin: o ? { name: o.name, lat: o.lat, lon: o.lon } : null, routes };
    cacheSet(key, out, 10 * 60 * 1000);
    return out;
  },

  'GET /api/stoptimes': async (q) => {
    const stopId = q.get('stopId');
    if (!stopId) throw httpError(400, 'stopId required');
    // optional ISO start time (stop-sheet day chips): board for a future day
    const t = q.get('time');
    const timeIso = t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(t) ? t : null;
    return stoptimesData(stopId, Math.min(Number(q.get('n')) || 6, 20), timeIso);
  },

  // Unified departures board for a curated hub: fan out to VT rail (railName),
  // our coach feed, and Transitous urban stops in radius, then merge-sort-cap.
  // Each source is wrapped so one dead upstream never blanks the whole board.
  'GET /api/hub-board': async (q) => {
    const hub = TRANSIT_HUBS.find((h) => h.id === q.get('hubId'));
    if (!hub) throw httpError(404, 'unknown hub');
    // full=1 (destination search): the whole rest of today, uncapped, with
    // intermediate calls (via) on coach + rail rows so "Taormina" matches a
    // Messina-bound REG. The default board stays the tight next-departures cut.
    const full = q.get('full') === '1';
    const now = Date.now();
    const [rail, coach, urban] = await Promise.all([
      hub.railName ? railRows(hub, full).catch(() => []) : Promise.resolve([]),
      Promise.resolve().then(() => coachRows(hub, full)).catch(() => []),
      urbanRows(hub, full).catch(() => []),
    ]);
    const departures = mergeDepartures([rail, coach, urban], now,
      full ? { perMode: 500, cap: 1000, dayStartMs: Date.parse(romeInstant(romeParts().iso, 0)) } : { perMode: 10, cap: 40 });
    return { hub: { id: hub.id, name: hub.name, kind: hub.kind }, asOf: now, full, departures };
  },

  // Reverse geocode for the map's "Choose on map" pin: nearest address + town.
  'GET /api/rev': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (![lat, lon].every(isFinite)) throw httpError(400, 'lat/lon required');
    const key = `rev:${lat.toFixed(5)},${lon.toFixed(5)}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    let name = null, town = null;
    try {
      const { data } = await upstream(`${TRANSITOUS}/api/v1/reverse-geocode?place=${lat.toFixed(6)},${lon.toFixed(6)}&type=ADDRESS`);
      const r = (data || [])[0];
      if (r && r.name) {
        name = r.name;
        const area = (r.areas || []).find((a) => a.adminLevel >= 6 && a.adminLevel <= 9);
        town = area ? area.name : null;
      }
    } catch { /* upstream down → client falls back to raw coords label */ }
    const out = { name, town };
    cacheSet(key, out, 10 * 60 * 1000);
    return out;
  },

  // Route + geometry for one network trip (city bus / train) — the map tracer's
  // food. tripId comes off hub-board urban rows.
  'GET /api/trip-shape': async (q) => tripShape(q.get('tripId')),

  // Same, but for a VT-sourced train row (no tripId): match the train number
  // against the hub station's own Transitous stoptimes around the departure
  // time, then fetch that trip's shape.
  'GET /api/rail-shape': async (q) => {
    const hub = TRANSIT_HUBS.find((h) => h.id === q.get('hubId'));
    const train = (q.get('train') || '').replace(/\D/g, '');
    if (!hub || !train) throw httpError(400, 'hubId + train required');
    const timeISO = q.get('time');
    const railStops = (await transitStopsInRadius(hub.lat, hub.lon, Math.max(hub.radiusM, 1200)))
      .filter((s) => (s.modes || []).some((m) => /RAIL|LONG_DISTANCE/.test(m)))
      .sort((a, b) => a.dist - b.dist);
    if (!railStops.length) throw httpError(404, 'no rail stop at this hub');
    // The merged station area is flooded with urban rows (Palermo Centrale =
    // AMAT every couple of minutes), so ask upstream for a WIDE window and
    // filter to rail before matching the train number.
    const fromIso = timeISO ? new Date(Date.parse(timeISO) - 10 * 60000).toISOString() : null;
    const timeQ = fromIso ? `&time=${encodeURIComponent(fromIso)}` : '';
    const { data } = await upstream(`${TRANSITOUS}/api/v1/stoptimes?stopId=${encodeURIComponent(railStops[0].stopId)}&n=60${timeQ}`);
    const numRe = new RegExp(`\\b${train}\\s*$`);
    const row = ((data && data.stopTimes) || []).find((st) =>
      /RAIL|LONG_DISTANCE/.test(st.mode || '') && st.tripId && numRe.test(st.routeShortName || st.displayName || ''));
    if (!row) throw httpError(404, 'train not found in network data');
    return tripShape(row.tripId);
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
    const tLat = Number(q.get('toLat')), tLon = Number(q.get('toLon'));
    const toPlace = q.get('toPlace'), fromPlace = q.get('fromPlace');
    if (![fLat, fLon].every(isFinite)) throw httpError(400, 'fromLat/fromLon required');
    if ((toPlace && toPlace.length > 120) || (fromPlace && fromPlace.length > 120)) throw httpError(400, 'place too long');
    const dateStr = q.get('date');
    let days = null, baseDate = romeParts().iso, queryTimeIso;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr !== romeParts().iso) {
      const noon = new Date(dateStr + 'T12:00:00Z');
      if (isNaN(noon)) throw httpError(400, 'bad date');
      const d0 = romeParts(noon);
      d0.min = Math.max(0, Math.min(1439, Number(q.get('afterMin')) || 0));
      const d1 = romeParts(new Date(noon.getTime() + 86400000));
      days = [d0, d1]; baseDate = dateStr;
      queryTimeIso = romeInstant(dateStr, d0.min);
    }
    const key = `viahub:${fLat.toFixed(3)},${fLon.toFixed(3)}:${toPlace || tLat + ',' + tLon}:${baseDate}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    // Forward: coach [origin → hub] + MOTIS [hub → dest]. Reverse: MOTIS
    // [origin → hub] + coach [hub → dest]. Run whichever the endpoints allow.
    // dest coords for the forward drop-scan: explicit toLat/toLon, else parse a
    // "lat,lon" toPlace (a stopId toPlace just falls back to the named hubs).
    let destCoords = null;
    if ([tLat, tLon].every(isFinite)) destCoords = { lat: tLat, lon: tLon };
    else if (toPlace) { const m = String(toPlace).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/); if (m) destCoords = { lat: +m[1], lon: +m[2] }; }
    const all = [];
    if (toPlace) all.push(...await hubStitch(fLat, fLon, toPlace, destCoords, days, baseDate));
    if (fromPlace && [tLat, tLon].every(isFinite)) all.push(...await hubStitchReverse(fromPlace, tLat, tLon, days, baseDate, queryTimeIso));
    const out = { fetchedAt: Date.now(), stitches: rankStitches(all) };
    cacheSet(key, out, 60 * 1000);
    return out;
  },

  'GET /api/coach-board': async (q) => {
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    if (![lat, lon].every(isFinite)) throw httpError(400, 'lat/lon required');
    const radius = Math.min(Number(q.get('r')) || 300, 1500);
    // explicit board date (stop-sheet day chips): full-day board for that Rome
    // date, service calendars (feriale/festivo/scolastico/feste) resolved for
    // the ACTUAL day — same honest-date pattern as /api/direct.
    let days = null;
    const dateStr = q.get('date');
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr !== romeParts().iso) {
      const noon = new Date(dateStr + 'T12:00:00Z');
      if (isNaN(noon)) throw httpError(400, 'bad date');
      const d0 = romeParts(noon);
      d0.min = 0;
      days = [d0, romeParts(new Date(noon.getTime() + 86400000))];
    }
    return coachBoard(lat, lon, radius, days, q.get('all') === '1');
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

  // Live departures board for a rail station, resolved from a Transitous stopId
  // (or name). Returns [] on no-code / VT-down / no-trains so the client falls
  // back to the MOTIS board (e.g. bus-substituted lines like Agrigento).
  'GET /api/vt/board': async (q) => {
    return vtBoardByCode(await resolveVtCode(q.get('stopId'), q.get('name')));
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
    const romeClock = (ms) => ms ? new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms)) : null;
    const out = {
      live: true, fetchedAt: Date.now(),
      trainNumber: c.trainNumber,
      delayMin: typeof d.ritardo === 'number' ? d.ritardo : null,
      lastSeenStation: d.stazioneUltimoRilevamento && d.stazioneUltimoRilevamento !== '--'
        ? d.stazioneUltimoRilevamento : null,
      lastSeenAtMs: d.oraUltimoRilevamento || null,
      origin: d.origine || null, destination: d.destinazione || null,
      cancelled: d.provvedimento === 1 || d.tipoTreno === 'ST',
      // full ordered call list with scheduled clocks — the "where does this
      // train go" answer, rendered by the hub-board train sheet
      stops: (d.fermate || []).filter((f) => f.stazione).map((f) => ({
        n: f.stazione, t: romeClock(f.programmata || f.partenza_teorica),
      })),
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

module.exports = { romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, haversineM, inSicily, outOfCoverage, directSearch, coachBoard, twoLegSearch, serviceRuns, romeParts, feedHorizon, vtSilence, dropDominated, parseBias, geoScore, clusterStopsByProximity, clusterAreaName, HUBS: TRANSIT_HUBS, hubsInBbox, AIRPORTS, airportMatch, airportResult, nominatimToRow, geoDedupeKey, nearestTicketShops, mergeDepartures, afterStation, decodePolyline };
