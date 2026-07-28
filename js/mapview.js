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

function stopIcon(mode) {
  return window.L.divIcon({
    className: 'stop-pin',
    html: `<img src="${modeImgSrc(mode)}" alt="">`,
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

// Stops for the visible area: center + radius from the viewport (server caps
// r at 5 km / 40 closest stops — zoomed way out this is honest sampling of
// the middle, and the zoom hint below the map says so).
let loadSeq = 0;
async function loadVisibleStops() {
  if (!map) return;
  const seq = ++loadSeq;
  const c = map.getCenter();
  const corner = map.getBounds().getNorthEast();
  const r = Math.min(5000, Math.max(400, Math.round(map.distance(c, corner))));
  try {
    const { data: stops } = await api.nearbyStops(c.lat, c.lng, r);
    if (seq !== loadSeq || !map) return; // superseded by a later pan
    const keep = new Set();
    for (const s of stops) {
      keep.add(s.stopId);
      if (markers.has(s.stopId)) continue;
      const m = window.L.marker([s.lat, s.lon], {
        icon: stopIcon((s.modes || [])[0]), keyboard: false,
      }).addTo(map);
      m.bindTooltip(displayName(s.name), { direction: 'top', offset: [0, -14] });
      m.on('click', () => openStopSchedule({ name: s.name, stopId: s.stopId, lat: s.lat, lon: s.lon }));
      markers.set(s.stopId, m);
    }
    // drop markers far outside the current view so long sessions stay light
    const limit = r * 2.5;
    for (const [id, m] of markers) {
      if (keep.has(id)) continue;
      if (map.distance(c, m.getLatLng()) > limit) { m.remove(); markers.delete(id); }
    }
  } catch { /* pan on — stale markers beat an error state */ }
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
  holder.appendChild(el('p', { class: 'muted map-note', text: 'Tap a stop for today’s schedule · zoom in for more stops.' }));

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
