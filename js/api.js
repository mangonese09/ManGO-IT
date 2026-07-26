// ── API LAYER ──
// Every call goes to our same-origin proxy (/api/*). Every GET degrades to
// the last cached response with stale:true instead of throwing — the UI
// shows a "last updated" stamp rather than an error state.

import { cacheRead, cacheWrite, markFresh } from './store.js';

const TIMEOUT_MS = 20000;

async function getJson(path, { cacheKey = path, source = 'transitous', allowStale = true } = {}) {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheWrite(cacheKey, data);
    markFresh(source);
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
  geocode: (text) =>
    getJson(`/api/geocode?text=${encodeURIComponent(text)}`, { source: 'transitous' }),

  plan: ({ fromPlace, toPlace, time, arriveBy }) => {
    const p = new URLSearchParams({ fromPlace, toPlace });
    if (time) p.set('time', time);
    if (arriveBy) p.set('arriveBy', 'true');
    return getJson(`/api/plan?${p}`, { source: 'transitous' });
  },

  nearbyStops: (lat, lon, r = 1200) =>
    getJson(`/api/stops?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${r}`, {
      cacheKey: `stops:${lat.toFixed(3)},${lon.toFixed(3)}`, source: 'transitous',
    }),

  stoptimes: (stopId, n = 6) =>
    getJson(`/api/stoptimes?stopId=${encodeURIComponent(stopId)}&n=${n}`, { source: 'transitous' }),

  coachBoard: (lat, lon, r = 300) =>
    getJson(`/api/coach-board?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${r}`, {
      cacheKey: `coachboard:${lat.toFixed(4)},${lon.toFixed(4)}`, source: 'transitous',
    }),

  direct: ({ fromLat, fromLon, toLat, toLon }) =>
    getJson(`/api/direct?fromLat=${fromLat.toFixed(4)}&fromLon=${fromLon.toFixed(4)}&toLat=${toLat.toFixed(4)}&toLon=${toLon.toFixed(4)}`, { source: 'transitous' }),

  vtLive: (train) =>
    getJson(`/api/vt/live?train=${encodeURIComponent(train)}`, { source: 'viaggiatreno' }),

  vtDepartures: (stationId) =>
    getJson(`/api/vt/departures?stationId=${encodeURIComponent(stationId)}`, { source: 'viaggiatreno' }),
};
