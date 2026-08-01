// ── MAP TAB (M6) ──
// Real interactive map: self-hosted Leaflet, Carto basemaps (light/dark to
// match the app theme), stops loaded for the visible area from /api/stops,
// every marker opening the same "Today — <stop>" schedule sheet as Saved.
// Leaflet (147 KB) loads lazily on first tab open so Home paint stays fast.
// If it can't load (first visit offline), the old nearest-stops list renders.

import { api } from './api.js';
import { el, modeIcon, openSheet, closeSheet } from './ui.js';
import { getLastPos } from './board.js';
import { displayName, cleanRouteName } from './names.js';
import { openStopSchedule, openHubBoard } from './saved.js';
import { isFavStop, addFavStop, removeFavStop, getFavStops } from './store.js';
import { toast } from './toast.js';

// Favourite key — same scheme as Home/Saved: transit stops key by id, coach
// stops (no stable id) by rounded coords.
// Works on both a marker meta and a raw server stop (transit stops key by their
// stopId — which is `id` in the map-stops response; coach stops by coords).
function favKey(o) {
  const sid = o.stopId || (o.kind === 'transit' ? o.id : null);
  return sid || `${(+o.lat).toFixed(5)},${(+o.lon).toFixed(5)}`;
}

const SICILY_CENTER = [37.55, 14.27]; // no-fix fallback: the whole island
const SICILY_ZOOM = 8;
const NEAR_ZOOM = 16;

let map = null;
let tileLayer = null;
let tileTheme = null;
let youMarker = null;
let leafletPromise = null;
let hintEl = null;
const markers = new Map(); // stopId -> L.Marker

// #2 Pin-family filters. 'rail' = trains/metro/tram, 'city' = urban buses,
// 'coach' = our long-distance coaches, 'hub' = the curated hub pins. All on by
// default, persisted. Migrate the legacy single 'road' key (buses+coaches)
// onto both city+coach so an upgrade never silently hides pins.
const MAP_FILTER_KEYS = ['rail', 'city', 'coach', 'hub'];
let mapFilter = { rail: true, city: true, coach: true, hub: true };
try {
  const saved = JSON.parse(localStorage.getItem('mangoit.mapModes') || '{}');
  if ('road' in saved && !('city' in saved)) { saved.city = saved.road; saved.coach = saved.road; }
  for (const k of MAP_FILTER_KEYS) if (k in saved) mapFilter[k] = !!saved[k];
} catch { /* default */ }
// Which toggle family a stop belongs to.
function stopBucket(s) {
  if (s.kind === 'hub') return 'hub';
  if (s.kind === 'coach') return 'coach';
  return (s.modes || []).some((m) => /RAIL|METRO|SUBWAY|TRAM|LONG_DISTANCE/.test(m)) ? 'rail' : 'city';
}
function stopShown(s) { return mapFilter[stopBucket(s)]; }

// #3 De-overlap: stops sharing a ~40m cell (e.g. RAFFADALI + RAFFADALI Via
// Nazionale) fan out onto a small circle so each stays visible and tappable.
// Only the DISPLAY position moves; meta keeps the true coords for schedules.
function declutter(stops) {
  const cell = new Map();
  for (const s of stops) {
    const k = `${Math.round(s.lat * 2800)},${Math.round(s.lon * 2800)}`;
    (cell.get(k) || cell.set(k, []).get(k)).push(s);
  }
  const pos = new Map();
  for (const group of cell.values()) {
    if (group.length === 1) { pos.set(group[0].id, [group[0].lat, group[0].lon]); continue; }
    const R = 0.0002; // ~22m
    group.forEach((s, i) => {
      const a = (2 * Math.PI * i) / group.length;
      pos.set(s.id, [s.lat + R * Math.cos(a), s.lon + R * Math.sin(a) / Math.cos(s.lat * Math.PI / 180)]);
    });
  }
  return pos;
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// Carto raster basemaps pair with OSM data; attribution per their policy.
const TILE_URL = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leafletPromise ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = () => resolve();
    s.onerror = () => { leafletPromise = null; reject(new Error('leaflet load failed')); };
    document.head.appendChild(s);
  });
  return leafletPromise;
}

function locateHere() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 60000 },
    );
  });
}

function modeImgSrc(mode) {
  if (/RAIL|LONG_DISTANCE|METRO|SUBWAY|TRAM/.test(mode || '')) return '/icons/modes/train.png';
  return '/icons/modes/bus.png';
}

function stopIcon(mode, kind, merged = false) {
  const src = kind === 'coach' ? '/icons/modes/bus.png' : modeImgSrc(mode);
  // Merged depot pins (several stops folded into one, opening the stop picker)
  // get a distinct teal disc so it's obvious the tap leads to a choice of stops.
  const cls = `stop-pin${kind === 'coach' ? ' pin-coach' : ''}${merged ? ' pin-merged' : ''}`;
  return window.L.divIcon({
    className: cls,
    html: `<img src="${src}" alt="">`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

// A curated transit hub (airport / main station) — one distinct pin that opens
// the unified multi-mode departures board. Glyph marks airport vs rail.
function hubIcon(subkind) {
  return window.L.divIcon({
    className: 'hub-pin',
    html: `<span class="hub-glyph">${subkind === 'airport' ? '✈️' : '🚉'}</span>`,
    iconSize: [40, 40], iconAnchor: [20, 20],
  });
}

// Favourited stops get a distinct GOLD STAR pin (bigger, star-shaped backdrop)
// so they stand out and stay visible even when everything else clusters.
function favIcon(mode, kind) {
  const src = kind === 'coach' ? '/icons/modes/bus.png' : modeImgSrc(mode);
  return window.L.divIcon({
    className: 'stop-pin fav-pin',
    html: `<span class="fav-star"></span><img src="${src}" alt="">`,
    iconSize: [38, 38], iconAnchor: [19, 19],
  });
}

// Cluster shown zoomed out — a soft, translucent heat blob sized by how many
// stops sit in that grid cell (log scale). Transparent edges let the basemap +
// city labels read through; overlapping blobs blend like a heatmap.
function clusterIcon(count, kind) {
  const d = Math.round(Math.min(74, 30 + Math.log2(count) * 8));
  const fs = Math.max(11, Math.round(d * 0.34));
  return window.L.divIcon({
    className: `cluster-blob cluster-${kind}`,
    html: `<span style="font-size:${fs}px">${count}</span>`,
    iconSize: [d, d], iconAnchor: [d / 2, d / 2],
  });
}

function showYou(pos) {
  if (!map || !pos) return;
  const L = window.L;
  if (youMarker) youMarker.setLatLng([pos.lat, pos.lon]);
  else {
    youMarker = L.circleMarker([pos.lat, pos.lon], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#3f8cff', fillOpacity: 1,
    }).addTo(map);
  }
}

// Below this zoom the map aggregates stops into counted clusters; at/above it,
// individual pins. Favourites are always shown individually, either way.
const CLUSTER_ZOOM = 12;
const clusterMarkers = new Map(); // cell id -> L.Marker
const favMarkers = new Map();     // fav key -> L.Marker

// Favourite pins render from the saved store (not the viewport feed), so they
// stay visible everywhere — including zoomed out, beside the clusters.
function renderFavorites() {
  if (!map) return;
  const favs = getFavStops();
  const keep = new Set();
  for (const f of favs) {
    if (!isFinite(f.lat) || !isFinite(f.lon)) continue;
    keep.add(f.key);
    if (favMarkers.has(f.key)) continue;
    if (f.kind === 'hub' && f.hubId) {
      const hubMeta = { hubId: f.hubId, subkind: f.iconMode === 'RAIL' ? 'rail' : 'airport', name: f.name, lat: f.lat, lon: f.lon };
      const hm = window.L.marker([f.lat, f.lon], { icon: hubIcon(hubMeta.subkind), keyboard: false, zIndexOffset: 1000 }).addTo(map);
      hm.bindTooltip(displayName(f.name), { direction: 'top', offset: [0, -18] });
      hm.on('click', () => openHubBoard(hubMeta));
      favMarkers.set(f.key, hm);
      continue;
    }
    const kind = f.stopId ? 'transit' : 'coach';
    const meta = { id: f.key, kind, ci: null, name: f.name, stopId: f.stopId || null, lat: f.lat, lon: f.lon };
    const m = window.L.marker([f.lat, f.lon], { icon: favIcon(f.iconMode, kind), keyboard: false, zIndexOffset: 1000 }).addTo(map);
    m.bindTooltip(displayName(f.name), { direction: 'top', offset: [0, -18] });
    m.on('click', () => openStopRoutes(meta));
    favMarkers.set(f.key, m);
  }
  for (const [k, m] of favMarkers) if (!keep.has(k)) { m.remove(); favMarkers.delete(k); }
}
function clearIndividual() { for (const m of markers.values()) m.remove(); markers.clear(); }
function clearClusters() { for (const m of clusterMarkers.values()) m.remove(); clusterMarkers.clear(); }

let loadSeq = 0;
async function loadVisibleStops() {
  if (!map || highlightActive) return; // don't churn markers under an active highlight
  renderFavorites();                   // always, at every zoom
  const seq = ++loadSeq;
  const c = map.getCenter();
  const corner = map.getBounds().getNorthEast();
  const clustered = map.getZoom() < CLUSTER_ZOOM;
  // Clustered mode covers the whole viewport (up to the island); individual mode
  // stays a tight radius so it samples the centre and stays fast.
  const reach = Math.round(map.distance(c, corner));
  const r = clustered ? Math.min(200000, Math.max(4000, reach)) : Math.min(8000, Math.max(500, reach));
  // Grid cell ≈ a fixed on-screen distance so cluster density feels the same at
  // every zoom (groups split as you zoom in). Measured from 64px at the centre.
  const sz = map.getSize();
  const px = map.distance(map.containerPointToLatLng([sz.x / 2, sz.y / 2]), map.containerPointToLatLng([sz.x / 2 + 54, sz.y / 2]));
  const cellM = clustered ? Math.max(50, Math.round(px / 50) * 50) : 0; // snap to 50m so a pan doesn't churn the grid/cache
  try {
    const { data } = await api.mapStops(c.lat, c.lng, r, clustered, cellM);
    if (seq !== loadSeq || !map || highlightActive) return;
    if (clustered) { renderClusters(data.clusters || []); return; }
    renderIndividual(data.stops || [], c, r);
  } catch { /* pan on — stale markers beat an error state */ }
}

const favKeys = () => new Set(getFavStops().map((f) => f.key));

function renderIndividual(all, c, r) {
  clearClusters();
  const fk = favKeys();
  const stops = all.filter(stopShown).filter((s) => !fk.has(favKey(s))); // favourites show via favMarkers
  const pos = declutter(stops);
  const keep = new Set();
  for (const s of stops) {
    keep.add(s.id);
    const ll = pos.get(s.id) || [s.lat, s.lon];
    if (markers.has(s.id)) { markers.get(s.id).setLatLng(ll); continue; }
    if (s.kind === 'hub') {
      const hubMeta = { hubId: s.hubId, subkind: s.subkind, name: s.name, lat: s.lat, lon: s.lon };
      const hm = window.L.marker(ll, { icon: hubIcon(s.subkind), keyboard: false, zIndexOffset: 900 }).addTo(map);
      hm.meta = hubMeta;
      hm.bindTooltip(displayName(s.name), { direction: 'top', offset: [0, -18] });
      hm.on('click', () => openHubBoard(hubMeta));
      markers.set(s.id, hm);
      continue;
    }
    const meta = { id: s.id, kind: s.kind, ci: s.kind === 'coach' ? Number(s.id.slice(1)) : null, name: s.name, stopId: s.kind === 'transit' ? s.id : null, lat: s.lat, lon: s.lon, members: s.members || null };
    const m = window.L.marker(ll, { icon: stopIcon((s.modes || [])[0], s.kind, s.merged > 1), keyboard: false }).addTo(map);
    m.meta = meta;
    m.bindTooltip(displayName(s.name), { direction: 'top', offset: [0, -14] });
    m.on('click', () => openStopRoutes(meta));
    markers.set(s.id, m);
  }
  const limit = r * 2.5;
  for (const [id, m] of markers) {
    if (keep.has(id)) continue;
    if (map.distance(c, m.getLatLng()) > limit) { m.remove(); markers.delete(id); }
  }
}

function renderClusters(clusters) {
  clearIndividual();
  const fk = favKeys();
  // Reconcile by stable id: singletons key on the stop id, clusters on their
  // absolute-grid id — so pans keep markers but a zoom (new grid) swaps them,
  // instead of piling stale bubbles up.
  const want = new Map();
  for (const cl of clusters) {
    // Aggregated clusters can't split rail vs city within a transit blob, so a
    // transit cluster shows if EITHER trains or city buses are on.
    if (!(cl.kind === 'coach' ? mapFilter.coach : (mapFilter.rail || mapFilter.city))) continue;
    if (cl.single && fk.has(favKey(cl))) continue;                   // shown as a fav star
    want.set(cl.id, cl);
  }
  for (const [id, m] of clusterMarkers) if (!want.has(id)) { m.remove(); clusterMarkers.delete(id); }
  for (const [id, cl] of want) {
    if (clusterMarkers.has(id)) continue;
    let m;
    if (cl.single) {
      // a lone stop draws as its own icon (not a "1" bubble) and opens its routes
      const meta = { id: cl.id, kind: cl.kind, ci: cl.kind === 'coach' ? Number(cl.id.slice(1)) : null, name: cl.name, stopId: cl.kind === 'transit' ? cl.id : null, lat: cl.lat, lon: cl.lon };
      m = window.L.marker([cl.lat, cl.lon], { icon: stopIcon((cl.modes || [])[0], cl.kind), keyboard: false }).addTo(map);
      m.bindTooltip(displayName(cl.name), { direction: 'top', offset: [0, -14] });
      m.on('click', () => openStopRoutes(meta));
    } else {
      m = window.L.marker([cl.lat, cl.lon], { icon: clusterIcon(cl.count, cl.kind), keyboard: false }).addTo(map);
      m.on('click', () => map.flyTo([cl.lat, cl.lon], Math.min(map.getZoom() + 3, 16), { duration: 0.8 }));
    }
    clusterMarkers.set(id, m);
  }
}

// Toggling a filter changes which pins belong on the map — drop them and reload.
function applyFilter() { clearIndividual(); clearClusters(); loadVisibleStops(); }

// ── CLICK-TO-HIGHLIGHT ROUTES ──
const ROUTE_COLORS = { COACH: '#ffb454', BUS: '#46c878', RAIL: '#4a90e2', REGIONAL_RAIL: '#4a90e2',
  HIGHSPEED_RAIL: '#4a90e2', LONG_DISTANCE: '#4a90e2', TRAM: '#e267c8', METRO: '#e2a04a', SUBWAY: '#e2a04a', FERRY: '#2ac0c0' };
function routeColor(mode, i) { return ROUTE_COLORS[mode] || ['#ffb454', '#46c878', '#4a90e2', '#e267c8', '#e2a04a'][i % 5]; }
function modeLabel(mode) {
  if (/RAIL|LONG_DISTANCE/.test(mode || '')) return 'train';
  if (mode === 'COACH') return 'coach';
  if (/TRAM/.test(mode || '')) return 'tram';
  if (/METRO|SUBWAY/.test(mode || '')) return 'metro';
  if (/FERRY/.test(mode || '')) return 'ferry';
  return 'bus';
}

let highlightLayer = null;
let highlightActive = false;
let infoBar = null;
let suppressClearOnce = false; // tapping a line opens its sheet without dropping the trace

function clearHighlight() {
  if (suppressClearOnce) { suppressClearOnce = false; return; }
  highlightActive = false;
  if (highlightLayer) { highlightLayer.remove(); highlightLayer = null; }
  const cv = document.getElementById('map-canvas');
  if (cv) cv.classList.remove('has-highlight');
  for (const m of markers.values()) {
    const e = m.getElement();
    if (e) e.classList.remove('lit', 'origin');
  }
  if (infoBar) { infoBar.remove(); infoBar = null; }
}

// Tapping a stop:
//  • COACH stop (our feed, the differentiator) → a window listing its routes,
//    each traceable on the map (one at a time), flying there smoothly.
//  • TRAIN station / city transit stop → straight to its departures. Tracing a
//    rail line on a map has little value (it obviously follows the rails), and
//    dumping every line/departure is "too intense" — the schedule is what you
//    actually want at a station.
// Tapping a stop eases the map in and lifts the stop toward the upper third, so
// you see WHERE it is (above where the info sheet will cover the bottom) before
// the sheet appears. Zooms in to at least street level; never zooms out.
function focusStop(lat, lon) {
  if (!map || !isFinite(lat) || !isFinite(lon)) return;
  const z = Math.max(map.getZoom(), 15);
  const size = map.getSize();
  const center = map.unproject(map.project([lat, lon], z).add([0, size.y * 0.18]), z);
  map.flyTo(center, z, { duration: 0.5 });
}

async function openStopRoutes(meta) {
  if (hintEl) hintEl.classList.add('gone');
  focusStop(meta.lat, meta.lon);
  await new Promise((r) => setTimeout(r, 320)); // let the zoom read before the info sheet
  if (meta.kind === 'transit') {
    // A merged depot pin (several boarding islands within 200m): let the user
    // pick the exact stop first, then show that stop's departures.
    if (meta.members && meta.members.length > 1) { openStopPicker(meta); return; }
    openStopSchedule(meta); return; // schedule-first for a single station stop
  }
  // viewport coach → ci; saved coach (no index) → coords.
  const q = meta.ci != null ? { ci: meta.ci } : { lat: meta.lat, lon: meta.lon };
  let data;
  try {
    ({ data } = await api.stopRoutes(q));
  } catch { openStopSchedule(meta); return; }
  const routes = (data && data.routes) || [];
  if (!routes.length) { openStopSchedule(meta); return; }
  openRoutesSheet(meta, routes);
}

// Merged-depot picker: the map draws one pin for a cluster of boarding islands
// (Palermo Centrale = ~12 stops). Tapping it lists the real stops with their
// specific names; picking one opens that exact stop's departures board.
function openStopPicker(meta) {
  const body = el('div', { class: 'stop-picker' });
  body.appendChild(el('p', { class: 'muted stop-picker-note', text:
    'Several stops here — pick one for its departures.' }));
  for (const s of meta.members) {
    body.appendChild(el('button', {
      class: 'stop-picker-row',
      // Stack the departures ON TOP of the picker (don't closeSheet first — its
      // history.back() fires a popstate that would close the board we just
      // opened). Closing the board then returns to this stop list.
      onclick: () => openStopSchedule({ id: s.id, kind: 'transit', stopId: s.id, name: s.name, lat: s.lat, lon: s.lon }),
    }, [
      el('span', { class: 'sp-icon' }, [modeIcon('BUS', 'mode-img mode-img-sm')]),
      el('span', { class: 'sp-name', text: displayName(s.name) }),
      el('span', { class: 'dep-chevron', text: '›' }),
    ]));
  }
  openSheet(body, { title: `${displayName(meta.name)} · ${meta.members.length} stops` });
}

function openRoutesSheet(meta, routes) {
  const key = favKey(meta);
  const body = el('div', { class: 'iti-detail routes-sheet' });
  const favBtn = el('button', { class: `chip-btn${isFavStop(key) ? ' on' : ''}` });
  const paintFav = () => { const on = isFavStop(key); favBtn.classList.toggle('on', on); favBtn.textContent = on ? '★ Saved' : '☆ Save'; };
  paintFav();
  favBtn.addEventListener('click', () => { toggleFav(meta, null); paintFav(); });
  body.appendChild(el('div', { class: 'routes-actions' }, [
    el('button', { class: 'chip-btn', text: 'Schedule', onclick: () => openStopSchedule(meta) }),
    favBtn,
  ]));
  body.appendChild(el('p', { class: 'muted routes-hint', text: 'Tap a route to trace it on the map.' }));
  routes.forEach((rt, i) => {
    const color = routeColor(rt.mode, i);
    body.appendChild(el('button', {
      class: 'dep-row dep-row-btn route-pick-row',
      onclick: () => { closeSheet(); traceRoute(meta, routes, i); },
    }, [
      el('span', { class: 'line-swatch', style: `background:${color}` }),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: cleanRouteName(rt.name) || modeLabel(rt.mode) }),
        el('span', { class: 'muted dep-headsign', text: `${rt.operator ? displayName(rt.operator) + ' · ' : ''}${rt.stops.length} stops` }),
      ]),
      el('span', { class: 'dep-chevron', text: '›' }),
    ]));
  });
  openSheet(body, { title: displayName(meta.name) });
}

// Trace ONE chosen route: draw its (road-snapped) line + stop dots, fly the map
// to it smoothly, and show an info-bar scoped to that route.
function traceRoute(meta, routes, idx) {
  const L = window.L;
  clearHighlight();
  const rt = routes[idx];
  const color = routeColor(rt.mode, idx);
  highlightActive = true;
  highlightLayer = L.layerGroup().addTo(map);
  const line = (rt.path && rt.path.length >= 2) ? rt.path : rt.stops.map((s) => [s.lat, s.lon]);
  // Visible line first (non-interactive), fat transparent casing ON TOP as the
  // tap target — taps land on the casing (→ stop list), not the map background.
  L.polyline(line, { color, weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(highlightLayer);
  const hit = L.polyline(line, { color, weight: 20, opacity: 0, lineCap: 'round', interactive: true }).addTo(highlightLayer);
  hit.on('click', () => { keepTrace(); openLineSheet(rt, color); });
  // A dot at every OTHER stop on the route (deduped), tappable for its schedule.
  const originK = `${(+meta.lat).toFixed(4)},${(+meta.lon).toFixed(4)}`;
  const dotSeen = new Set();
  for (const s of rt.stops) {
    if (!isFinite(s.lat) || !isFinite(s.lon)) continue;
    const k = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
    if (k === originK || dotSeen.has(k)) continue;
    dotSeen.add(k);
    const dot = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: 'route-dot', html: '<span></span>', iconSize: [11, 11], iconAnchor: [6, 6] }),
      keyboard: false, zIndexOffset: -200,
    }).addTo(highlightLayer);
    dot.bindTooltip(displayName(s.name), { direction: 'top', offset: [0, -8] });
    dot.on('click', () => { keepTrace(); openStopSchedule({ name: s.name, lat: s.lat, lon: s.lon, stopId: s.stopId || null }); });
  }
  document.getElementById('map-canvas').classList.add('has-highlight');
  for (const [id, m] of markers) {
    const e = m.getElement();
    if (!e) continue;
    if (id === meta.id) { e.classList.add('lit', 'origin'); continue; }
    const ll = m.getLatLng();
    if (rt.stops.some((s) => map.distance(ll, [s.lat, s.lon]) < 45)) e.classList.add('lit');
  }
  // Smooth animated zoom to the route's extent (flyTo, not a hard fitBounds).
  const b = L.latLngBounds(rt.stops.map((s) => [s.lat, s.lon]));
  if (b.isValid()) map.flyToBounds(b.pad(0.14), { maxZoom: 13, duration: 0.9 });
  showRouteInfoBar(meta, routes, idx, color);
}

// A dot/line tap opens a sheet; the map-bg click that Leaflet fires next must
// NOT drop the trace. One-shot suppress that resets after this event tick.
function keepTrace() { suppressClearOnce = true; setTimeout(() => { suppressClearOnce = false; }, 0); }

function showRouteInfoBar(meta, routes, idx, color) {
  const holder = document.getElementById('map-canvas');
  if (infoBar) infoBar.remove();
  const rt = routes[idx];
  const key = favKey(meta);
  const favBtn = el('button', {
    class: `mib-fav${isFavStop(key) ? ' on' : ''}`, 'aria-label': 'Save this stop', text: '★',
    onclick: () => toggleFav(meta, favBtn),
  });
  infoBar = el('div', { class: 'map-info-bar' }, [
    el('div', { class: 'mib-main' }, [
      el('div', { class: 'mib-name' }, [
        el('span', { class: 'mib-swatch', style: `background:${color}` }),
        el('span', { class: 'lg-text', text: cleanRouteName(rt.name) || modeLabel(rt.mode) }),
      ]),
      el('div', { class: 'mib-sub', text: `${displayName(meta.name)} · ${rt.stops.length} stops` }),
    ]),
    routes.length > 1 ? el('button', { class: 'mib-x mib-back', 'aria-label': 'Back to routes', text: '‹', onclick: () => openRoutesSheet(meta, routes) }) : null,
    el('button', { class: 'mib-btn', text: 'Stops', onclick: () => openLineSheet(rt, color) }),
    favBtn,
    el('button', { class: 'mib-x', 'aria-label': 'Clear', text: '✕', onclick: clearHighlight }),
  ]);
  // Without this, a tap on any info-bar button also reaches the Leaflet map as a
  // background click → clearHighlight yanks the bar out from under the tap.
  window.L.DomEvent.disableClickPropagation(infoBar);
  holder.appendChild(infoBar);
}

// #E Favourite / unfavourite a stop straight from the map. The star pin lives in
// the always-on favourites layer, so sync that + the info-bar star + Saved tab.
function toggleFav(meta, btn) {
  const key = favKey(meta);
  const nowFav = !isFavStop(key);
  if (nowFav) {
    addFavStop({ key, name: meta.name, kind: meta.kind === 'coach' ? 'coach stop' : 'stop', iconMode: meta.kind === 'coach' ? 'COACH' : (meta.modes || [])[0] || 'BUS', stopId: meta.stopId || null, lat: meta.lat, lon: meta.lon });
  } else {
    removeFavStop(key);
  }
  btn && btn.classList.toggle('on', nowFav);
  toast(nowFav ? 'Saved to favorites' : 'Removed from favorites');
  renderFavorites();
  // reconcile the plain/cluster layers: the now-favourite drops its plain pin
  // (shown as a star instead); an un-favourite comes back as a plain pin.
  if (!highlightActive) loadVisibleStops();
}

// #1 Tap a drawn line → its full ordered stop list, each row opening that
// stop's schedule. Turns the traced geometry from decoration into navigation.
function openLineSheet(rt, color) {
  const stops = rt.stops || [];
  const body = el('div', { class: 'iti-detail line-sheet' });
  body.appendChild(el('div', { class: 'line-sheet-head' }, [
    el('span', { class: 'line-swatch', style: `background:${color}` }),
    el('div', {}, [
      el('div', { class: 'line-op muted', text: `${rt.operator ? displayName(rt.operator) + ' · ' : ''}${stops.length} stops` }),
    ]),
  ]));
  body.appendChild(el('p', { class: 'muted line-sheet-hint', text: 'Tap a stop to move the map there.' }));
  for (const s of stops) {
    body.appendChild(el('button', {
      class: 'dep-row dep-row-btn line-stop-row',
      // #9 tapping a stop pans the map to it (the trace stays drawn underneath)
      onclick: () => {
        if (!isFinite(s.lat) || !isFinite(s.lon)) return;
        closeSheet();
        map.setView([s.lat, s.lon], Math.max(map.getZoom(), NEAR_ZOOM), { animate: true });
      },
    }, [
      el('span', { class: 'line-stop-dot', style: `border-color:${color}` }),
      el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: displayName(s.name) })]),
      el('span', { class: 'dep-chevron', text: '›' }),
    ]));
  }
  openSheet(body, { title: cleanRouteName(rt.name) || modeLabel(rt.mode) });
}

function ensureTiles() {
  const theme = currentTheme();
  if (tileLayer && tileTheme === theme) return;
  if (tileLayer) tileLayer.remove();
  tileTheme = theme;
  tileLayer = window.L.tileLayer(TILE_URL[theme], {
    attribution: TILE_ATTR, maxZoom: 19, subdomains: 'abcd',
  }).addTo(map);
}

function addLocateControl() {
  const L = window.L;
  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'map-locate-btn');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Center on my location');
      btn.innerHTML = '<img src="/icons/place-pin.png" alt="">';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', async () => {
        try {
          const pos = await locateHere();
          showYou(pos);
          map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), NEAR_ZOOM));
        } catch {
          toast('Location unavailable — check the permission', 'warn');
        }
      });
      return btn;
    },
  });
  map.addControl(new Locate());
}

async function initMap(pos) {
  const L = window.L;
  map = L.map('map-canvas', { zoomControl: false, attributionControl: true });
  addLocateControl();
  // Zoom sits top-right under the locate button — the bottom edge belongs to the
  // stop info-bar, which used to collide with a bottom-right zoom control (the ✕
  // ended up hidden behind the +/− buttons).
  L.control.zoom({ position: 'topright' }).addTo(map);
  ensureTiles();
  if (pos) {
    map.setView([pos.lat, pos.lon], NEAR_ZOOM);
    showYou(pos);
  } else {
    map.setView(SICILY_CENTER, SICILY_ZOOM);
  }
  let moveTimer = null;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(loadVisibleStops, 350);
  });
  map.on('click', clearHighlight); // tap the map background to drop a highlight
  buildControls();
  // Usage hint (bottom, above where the info-bar appears) — fades out after the
  // first stop tap. Bottom keeps the top-left clear for the search + filters.
  hintEl = el('div', { class: 'map-hint', text: 'Tap a stop to trace its routes' });
  document.getElementById('map-canvas').appendChild(hintEl);
  loadVisibleStops();
}

// #2 filter chips + #4 place search, as a top-left in-map overlay.
const MAP_CHIPS = [
  { key: 'rail', label: 'Trains', icon: 'RAIL' },
  { key: 'city', label: 'City buses', icon: 'BUS' },
  { key: 'coach', label: 'Coaches', icon: 'COACH' },
  { key: 'hub', label: 'Hubs', icon: null }, // 🚉 glyph, matches the hub pin
];
function buildControls() {
  const holder = document.getElementById('map-canvas');
  const mkChip = ({ key, label, icon }) => {
    const glyph = icon ? modeIcon(icon, 'mode-img mode-img-sm') : el('span', { class: 'chip-hub-glyph', text: '🚉' });
    const chip = el('button', {
      class: `map-chip${mapFilter[key] ? ' on' : ''}`,
      onclick: () => {
        const next = !mapFilter[key];
        if (!next && MAP_FILTER_KEYS.filter((k) => mapFilter[k]).length === 1) {
          toast('Keep at least one filter on', 'warn'); return;
        }
        mapFilter[key] = next;
        try { localStorage.setItem('mangoit.mapModes', JSON.stringify(mapFilter)); } catch { /* private mode */ }
        chip.classList.toggle('on', next);
        applyFilter();
      },
    }, [glyph, el('span', { text: label })]);
    return chip;
  };
  const search = el('button', { class: 'map-chip map-search-btn', 'aria-label': 'Search a place', onclick: openMapSearch }, [
    el('span', { class: 'map-search-ico', text: '⌕' }), el('span', { text: 'Search' }),
  ]);
  const bar = el('div', { class: 'map-controls' }, [search, ...MAP_CHIPS.map(mkChip)]);
  window.L.DomEvent.disableClickPropagation(bar);
  holder.appendChild(bar);
}

// #4 Place search — a sheet with a debounced geocode input; picking a result
// recenters the map there and loads its stops.
let mapSearchSeq = 0;
function openMapSearch() {
  const results = el('div', { class: 'map-search-results' });
  const input = el('input', {
    class: 'map-search-input', type: 'search', placeholder: 'Search a town, station or stop…',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  const body = el('div', { class: 'map-search-body' }, [input, results]);
  openSheet(body, { title: 'Find a place' });
  setTimeout(() => input.focus(), 60);
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const seq = ++mapSearchSeq;
      try {
        const { data } = await api.geocode(q);
        if (seq !== mapSearchSeq) return;
        results.innerHTML = '';
        const rows = (data || []).filter((r) => isFinite(r.lat) && isFinite(r.lon)).slice(0, 8);
        if (!rows.length) { results.appendChild(el('div', { class: 'suggest-row suggest-dead muted', text: 'No match' })); return; }
        for (const r of rows) {
          const kind = r.type === 'COACH_STOP' ? 'coach stop'
            : r.type === 'STOP' ? ((r.modes || []).some((x) => /RAIL|LONG_DISTANCE/.test(x)) ? 'train station' : 'stop')
            : (/^(city|town|village|hamlet)/.test(r.category || '') ? 'town' : '');
          const bits = [];
          if (kind) bits.push(kind);
          if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(displayName(r.town));
          if (r.province && r.province !== r.town) bits.push(`prov. ${r.province}`);
          results.appendChild(el('button', {
            class: 'suggest-row map-search-row',
            onclick: () => {
              closeSheet();
              clearHighlight();
              map.setView([r.lat, r.lon], Math.max(map.getZoom(), NEAR_ZOOM));
              loadVisibleStops();
            },
          }, [
            el('span', { class: 'suggest-name', text: displayName(r.name) }),
            bits.length ? el('span', { class: 'suggest-area', text: bits.join(' · ') }) : null,
          ]));
        }
      } catch {
        if (seq !== mapSearchSeq) return;
        results.innerHTML = '';
        results.appendChild(el('div', { class: 'suggest-row suggest-dead muted', text: 'Search unavailable' }));
      }
    }, 300);
  });
}

export async function renderMapTab() {
  const holder = document.getElementById('map-list');

  if (map) {
    // returning to the tab: fix the size (was display:none), match the theme
    requestAnimationFrame(() => { map.invalidateSize(); });
    ensureTiles();
    const pos = getLastPos();
    if (pos) showYou(pos);
    return;
  }

  holder.innerHTML = '';
  holder.appendChild(el('div', { id: 'map-canvas' }));

  try {
    await loadLeaflet();
  } catch {
    renderListFallback(holder);
    return;
  }

  let pos = getLastPos();
  if (!pos) {
    // only ask outright if the user already granted it (same rule as Home)
    try {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      if (st.state === 'granted') pos = await locateHere().catch(() => null);
    } catch { /* permissions API unavailable — start on the island view */ }
  }
  initMap(pos);
}

// Offline / script-blocked fallback: the pre-M6 nearest-stops list.
async function renderListFallback(holder) {
  holder.innerHTML = '';
  const pos = getLastPos();
  if (!pos) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'Map unavailable and no location fix.' }),
      el('p', { class: 'muted', text: 'Check connectivity and reopen this tab.' }),
    ]));
    return;
  }
  try {
    const { data: stops } = await api.nearbyStops(pos.lat, pos.lon, 2500);
    for (const s of stops.slice(0, 25)) {
      holder.appendChild(el('button', {
        class: 'dep-row dep-row-btn',
        onclick: () => openStopSchedule({ name: s.name, stopId: s.stopId, lat: s.lat, lon: s.lon }),
      }, [
        el('span', { class: 'dep-mode' }, [modeIcon((s.modes || [])[0] || 'BUS')]),
        el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: displayName(s.name) })]),
        el('span', { class: 'muted', text: `${s.dist} m` }),
        el('span', { class: 'dep-chevron', text: '›' }),
      ]));
    }
  } catch {
    holder.appendChild(el('div', { class: 'empty-state' }, [el('p', { text: 'Could not load stops.' })]));
  }
}
