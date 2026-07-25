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
const UA = 'ManGO-IT/0.1 (personal transit app; miconsig@gmail.com)';

// Sicily bounding box — geocode results outside it are dropped.
const SICILY = { latMin: 36.55, latMax: 38.85, lonMin: 11.85, lonMax: 15.75 };

// Coach stops from our own GTFS pipeline (autocomplete works even before
// Transitous ingests the feed). Optional file; empty list if absent.
let coachStops = [];
try {
  coachStops = JSON.parse(fs.readFileSync(path.join(__dirname, 'coach-stops.json'), 'utf8'));
} catch { /* not generated yet */ }

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
const rateBuckets = new Map(); // ip → [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((t) => now - t < 60000);
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return bucket.length > 90; // 90 req/min per IP
}

// ── UPSTREAM ──
async function upstream(url, { asText = false, timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: asText ? 'text/plain, */*' : 'application/json, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return { status: 204, data: null };
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return { status: res.status, data: asText ? await res.text() : await res.json() };
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
  'GET /api/health': async () => ({ ok: true, version: '0.2.0', romeTime: romeNowString() }),

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
    const key = `plan:${params.toString()}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const { data } = await upstream(`${TRANSITOUS}/api/v3/plan?${params}`, { timeoutMs: 45000 });
    const out = {
      fetchedAt: Date.now(),
      itineraries: (data.itineraries || []).map(slimItinerary),
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
    const auto = await upstream(`${VT}/cercaNumeroTrenoTrenoAutocomplete/${train}`, { asText: true });
    const candidates = parseVtTrainAutocomplete(auto.data || '');
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
  if (url.pathname.startsWith('/api/') && rateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limited' }));
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

module.exports = { romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, haversineM, inSicily };
