// ── MAP TAB (M6) ──
// Real interactive map: self-hosted Leaflet, Carto basemaps (light/dark to
// match the app theme), stops loaded for the visible area from /api/stops,
// every marker opening the same "Today — <stop>" schedule sheet as Saved.
// Leaflet (147 KB) loads lazily on first tab open so Home paint stays fast.
// If it can't load (first visit offline), the old nearest-stops list renders.

import { api } from './api.js';
import { el, modeIcon } from './ui.js';
import { getLastPos } from './board.js';
import { displayName } from './names.js';
import { openStopSchedule } from './saved.js';
import { toast } from './toast.js';

const SICILY_CENTER = [37.55, 14.27]; // no-fix fallback: the whole island
const SICILY_ZOOM = 8;
const NEAR_ZOOM = 16;

let map = null;
let tileLayer = null;
let tileTheme = null;
let youMarker = null;
let leafletPromise = null;
const markers = new Map(); // stopId -> L.Marker

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

function stopIcon(mode, kind) {
  const src = kind === 'coach' ? '/icons/modes/bus.png' : modeImgSrc(mode);
  return window.L.divIcon({
    className: `stop-pin${kind === 'coach' ? ' pin-coach' : ''}`,
    html: `<img src="${src}" alt="">`,
    iconSize: [30, 30], iconAnchor: [15, 15],
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

// Stops for the visible area — transit (Transitous) AND our coach stops. The
// server caps at 60 transit + 90 coach nearest the centre; the zoom hint says
// zoomed-way-out is honest sampling of the middle.
let loadSeq = 0;
async function loadVisibleStops() {
  if (!map || highlightActive) return; // don't churn markers under an active highlight
  const seq = ++loadSeq;
  const c = map.getCenter();
  const corner = map.getBounds().getNorthEast();
  const r = Math.min(8000, Math.max(500, Math.round(map.distance(c, corner))));
  try {
    const { data } = await api.mapStops(c.lat, c.lng, r);
    if (seq !== loadSeq || !map || highlightActive) return;
    const stops = data.stops || [];
    const keep = new Set();
    for (const s of stops) {
      keep.add(s.id);
      if (markers.has(s.id)) continue;
      const meta = { id: s.id, kind: s.kind, name: s.name, stopId: s.kind === 'transit' ? s.id : null, lat: s.lat, lon: s.lon };
      const m = window.L.marker([s.lat, s.lon], {
        icon: stopIcon((s.modes || [])[0], s.kind), keyboard: false,
      }).addTo(map);
      m.meta = meta;
      m.bindTooltip(displayName(s.name), { direction: 'top', offset: [0, -14] });
      m.on('click', () => highlightStop(meta));
      markers.set(s.id, m);
    }
    const limit = r * 2.5;
    for (const [id, m] of markers) {
      if (keep.has(id)) continue;
      if (map.distance(c, m.getLatLng()) > limit) { m.remove(); markers.delete(id); }
    }
  } catch { /* pan on — stale markers beat an error state */ }
}

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

function clearHighlight() {
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

async function highlightStop(meta) {
  const L = window.L;
  clearHighlight();
  let data;
  try {
    ({ data } = await api.stopRoutes(meta.kind === 'coach' ? { ci: meta.id.slice(1) } : { stopId: meta.id }));
  } catch { openStopSchedule(meta); return; }
  const routes = (data && data.routes) || [];
  if (!routes.length) { openStopSchedule(meta); return; } // nothing to draw — just show times

  highlightActive = true;
  highlightLayer = L.layerGroup().addTo(map);
  const litPts = [];
  routes.forEach((rt, i) => {
    const pts = rt.stops.map((s) => [s.lat, s.lon]);
    L.polyline(pts, { color: routeColor(rt.mode, i), weight: 4, opacity: 0.85, lineJoin: 'round' }).addTo(highlightLayer);
    litPts.push(...rt.stops);
  });
  // Frame the routes without zooming past street level.
  const all = routes.flatMap((r) => r.stops.map((s) => [s.lat, s.lon]));
  if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.12), { maxZoom: 13, animate: true });
  document.getElementById('map-canvas').classList.add('has-highlight');
  for (const [id, m] of markers) {
    const e = m.getElement();
    if (!e) continue;
    if (id === meta.id) { e.classList.add('lit', 'origin'); continue; }
    const ll = m.getLatLng();
    if (litPts.some((s) => map.distance(ll, [s.lat, s.lon]) < 45)) e.classList.add('lit');
  }
  showInfoBar(meta, routes);
}

function showInfoBar(meta, routes) {
  const holder = document.getElementById('map-canvas');
  if (infoBar) infoBar.remove();
  const legend = el('div', { class: 'map-legend' });
  routes.slice(0, 6).forEach((rt, i) => {
    legend.appendChild(el('span', {}, [
      el('i', { style: `background:${routeColor(rt.mode, i)}` }),
      el('span', { text: displayName((rt.name || modeLabel(rt.mode)).slice(0, 22)) }),
    ]));
  });
  infoBar = el('div', { class: 'map-info-bar' }, [
    el('div', { class: 'mib-main' }, [
      el('div', { class: 'mib-name', text: displayName(meta.name) }),
      el('div', { class: 'mib-sub', text: `${routes.length} route${routes.length > 1 ? 's' : ''} here` }),
      legend,
    ]),
    el('button', { class: 'mib-btn', text: 'Schedule', onclick: () => openStopSchedule(meta) }),
    el('button', { class: 'mib-x', 'aria-label': 'Clear', text: '✕', onclick: clearHighlight }),
  ]);
  holder.appendChild(infoBar);
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
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  addLocateControl();
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
  loadVisibleStops();
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
  holder.appendChild(el('p', { class: 'muted map-note', text: 'Tap a stop to trace its routes · tap the map to clear · zoom in for more stops.' }));

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
