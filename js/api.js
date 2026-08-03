// ── API LAYER ──
// Every call goes to our same-origin proxy (/api/*). Every GET degrades to
// the last cached response with stale:true instead of throwing — the UI
// shows a "last updated" stamp rather than an error state.
//
// R-06: `source` is the thing that actually answered, not the thing we asked.
// /api/direct and /api/coach-board are served from our own coach feed inside
// the proxy — crediting them to Transitous made Settings read "Transitous
// routing - just now" during the exact outage the coach feed exists to survive.

import { cacheRead, cacheWrite, markFresh } from './store.js';

const TIMEOUT_MS = 20000;

async function getJson(path, { cacheKey = path, source = 'transitous', allowStale = true } = {}) {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheWrite(cacheKey, data);
    if (source) markFresh(source);
    return { data, stale: false, fetchedAt: Date.now() };
  } catch (err) {
    if (allowStale) {
      const hit = cacheRead(cacheKey);
      if (hit) return { data: hit.data, stale: true, fetchedAt: hit.fetchedAt };
    }
    throw err;
  }
}

export const api = {
  geocode: (text, place) =>
    getJson(`/api/geocode?text=${encodeURIComponent(text)}${place ? `&place=${encodeURIComponent(place)}` : ''}`, {
      cacheKey: `geo:${text}${place ? `|${place}` : ''}`, source: 'transitous',
    }),

  plan: ({ fromPlace, toPlace, time, arriveBy, modes, searchWindow, maxItineraries, pageCursor }) => {
    const p = new URLSearchParams({ fromPlace, toPlace });
    if (time) p.set('time', time);
    if (arriveBy) p.set('arriveBy', 'true');
    if (modes) p.set('modes', modes);
    if (searchWindow) p.set('searchWindow', String(searchWindow));
    if (maxItineraries) p.set('maxItineraries', String(maxItineraries));
    if (pageCursor) p.set('pageCursor', pageCursor);
    return getJson(`/api/plan?${p}`, { source: 'transitous' });
  },

  nearbyStops: (lat, lon, r = 1200) =>
    getJson(`/api/stops?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${r}`, {
      cacheKey: `stops:${lat.toFixed(3)},${lon.toFixed(3)}`, source: 'transitous',
    }),

  mapStops: (lat, lon, r = 1500, agg = false, cell = 0) =>
    getJson(`/api/map-stops?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${r}${agg ? `&agg=1&cell=${Math.round(cell)}` : ''}`, {
      cacheKey: `mapstops:${agg ? `a${Math.round(cell)}:` : ''}${lat.toFixed(3)},${lon.toFixed(3)},${r}`, source: 'transitous',
    }),

  stopRoutes: ({ ci, stopId, lat, lon }) => {
    const qs = ci != null ? `ci=${ci}`
      : stopId ? `stopId=${encodeURIComponent(stopId)}`
      : `lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}`;
    return getJson(`/api/stop-routes?${qs}`, {
      cacheKey: `sr:${ci != null ? 'c' + ci : stopId || `${(+lat).toFixed(4)},${(+lon).toFixed(4)}`}`, source: 'transitous',
    });
  },

  stoptimes: (stopId, n = 6, timeIso = null) =>
    getJson(`/api/stoptimes?stopId=${encodeURIComponent(stopId)}&n=${n}${timeIso ? `&time=${encodeURIComponent(timeIso)}` : ''}`, { source: 'transitous' }),

  coachBoard: (lat, lon, r = 300, all = false, date = null) =>
    getJson(`/api/coach-board?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${r}${all ? '&all=1' : ''}${date ? `&date=${date}` : ''}`, {
      cacheKey: `coachboard:${lat.toFixed(4)},${lon.toFixed(4)}${all ? ':all' : ''}${date ? `:${date}` : ''}`, source: 'coachfeed',
    }),

  direct: ({ fromLat, fromLon, toLat, toLon, date, afterMin, full }) => {
    let url = `/api/direct?fromLat=${fromLat.toFixed(4)}&fromLon=${fromLon.toFixed(4)}&toLat=${toLat.toFixed(4)}&toLon=${toLon.toFixed(4)}`;
    if (date) url += `&date=${date}`;
    if (afterMin != null) url += `&afterMin=${afterMin}`;
    if (full) url += '&full=1';
    return getJson(url, { source: 'coachfeed' });
  },

  viaHub: ({ fromLat, fromLon, fromPlace, toPlace, toLat, toLon, date, afterMin }) => {
    let url = `/api/via-hub?fromLat=${fromLat.toFixed(4)}&fromLon=${fromLon.toFixed(4)}`;
    if (fromPlace) url += `&fromPlace=${encodeURIComponent(fromPlace)}`;
    if (toPlace) url += `&toPlace=${encodeURIComponent(toPlace)}`;
    if (isFinite(toLat) && isFinite(toLon)) url += `&toLat=${toLat.toFixed(4)}&toLon=${toLon.toFixed(4)}`;
    if (date) url += `&date=${date}`;
    if (afterMin != null) url += `&afterMin=${afterMin}`;
    return getJson(url, { source: 'transitous', allowStale: false });
  },

  health: () =>
    getJson('/api/health', { source: null }),

  nearestServed: (lat, lon) =>
    getJson(`/api/nearest-served?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, {
      cacheKey: `nearserved:${lat.toFixed(3)},${lon.toFixed(3)}`, source: 'coachfeed',
    }),

  vtLive: (train) =>
    getJson(`/api/vt/live?train=${encodeURIComponent(train)}`, { source: 'viaggiatreno' }),

  vtDepartures: (stationId) =>
    getJson(`/api/vt/departures?stationId=${encodeURIComponent(stationId)}`, { source: 'viaggiatreno' }),

  // Live train board for a rail station (resolved from its Transitous stopId).
  vtBoard: (stopId, name = '') =>
    getJson(`/api/vt/board?stopId=${encodeURIComponent(stopId)}${name ? `&name=${encodeURIComponent(name)}` : ''}`, {
      cacheKey: `vtboard:${stopId}`, source: 'viaggiatreno',
    }),

  // Route + geometry for one network trip (city bus / train) → map tracer.
  tripShape: (tripId) =>
    getJson(`/api/trip-shape?tripId=${encodeURIComponent(tripId)}`, {
      cacheKey: `tsh:${tripId}`, source: 'transitous',
    }),

  // Trip shape for a VT train row (no tripId): matched server-side at the hub.
  railShape: (hubId, train, timeISO) =>
    getJson(`/api/rail-shape?hubId=${encodeURIComponent(hubId)}&train=${encodeURIComponent(train)}${timeISO ? `&time=${encodeURIComponent(timeISO)}` : ''}`, {
      source: 'transitous',
    }),

  // Unified rail+coach+urban departures board for a curated hub. full=true
  // fetches the whole rest of today with intermediate calls (destination search).
  hubBoard: (hubId, full = false) =>
    getJson(`/api/hub-board?hubId=${encodeURIComponent(hubId)}${full ? '&full=1' : ''}`, {
      cacheKey: `hubboard:${hubId}${full ? ':full' : ''}`, source: 'transitous',
    }),
};
