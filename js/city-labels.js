// City/town/village labels the app draws itself (v0.45.6). The Carto raster
// basemap bakes labels into tiles: density is fixed, sparse at mid zooms, and
// a name can vanish between zoom levels because each level re-picks its label
// set. We now use the *_nolabels basemap below z13 and draw our own labels
// from a baked OSM extract (vendor/sicily-places.json — 756 places with
// population), so density is ours to choose, thresholds are MONOTONIC (a name
// that appears at z9 is still there at z10-12), and labels render in a pane
// ABOVE the stop pins (tap-through) so a pin can never hide a town name.
const DATA_URL = '/vendor/sicily-places.json';
const PANE = 'city-labels';
const HANDOFF_ZOOM = 13; // >= this, the Carto *_only_labels tiles take over

// ── density bands ──
// min population by zoom — strictly decreasing so zooming IN never drops a
// label ("appears then goes away" was the raster-tile behaviour).
function minPop(z) {
  if (z <= 6) return 90000;
  if (z === 7) return 50000;
  if (z === 8) return 25000;
  if (z === 9) return 12000;
  if (z === 10) return 6000;
  if (z === 11) return 2200;
  return 700; // z12
}
const CAP = 44; // hard ceiling per viewport — never flood the screen

let map = null;
let layer = null;
let places = null;
let loading = null;
let schedule = () => {};
// Obstacles the labels must not paint across (v1.3.0, backlog item 8): the
// hub pins are 40×40 discs centred on the same point a city label centres on,
// so "PALERMO" landed straight across the airport pin. mapview registers a
// source returning [{lat, lon, r}] and pokes refreshLabels() when hubs land
// (they arrive async, after moveend has already drawn the labels).
let obstacleSource = () => [];
export function setObstacleSource(fn) { obstacleSource = fn; }
export function refreshLabels() { schedule(); }

function tier(p) { return p >= 45000 ? 'big' : p >= 8000 ? 'mid' : 'small'; }
// estimated on-screen label box per tier — collision math only, not layout
const EST = { big: { cw: 10, h: 18 }, mid: { cw: 7.5, h: 16 }, small: { cw: 6.5, h: 14 } };

function loadPlaces() {
  loading ||= fetch(DATA_URL)
    .then((r) => { if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); })
    .then((rows) => { places = rows; }) // pre-sorted by population desc
    .catch(() => { loading = null; }); // silent: map simply keeps no extra labels
  return loading;
}

// does a w×h label box centred at (x, y+dy) touch any obstacle disc?
function hitsObstacle(x, y, dy, w, h, obs) {
  const top = y + dy - h / 2, left = x - w / 2;
  for (const o of obs) {
    const cx = Math.max(left, Math.min(o.x, left + w));
    const cy = Math.max(top, Math.min(o.y, top + h));
    if ((cx - o.x) ** 2 + (cy - o.y) ** 2 < o.r * o.r) return true;
  }
  return false;
}

function render() {
  if (!map || !places) return;
  layer.clearLayers();
  const z = map.getZoom();
  if (z >= HANDOFF_ZOOM) return;
  const bounds = map.getBounds().pad(0.08);
  const floor = minPop(z);
  const obs = obstacleSource().map((o) => {
    const q = map.project([o.lat, o.lon], z);
    return { x: q.x, y: q.y, r: o.r || 26 };
  });
  // greedy collision cull, biggest towns first: one label per ~78×26px cell,
  // with the horizontal neighbours reserved too (labels are wide).
  const taken = new Set();
  let shown = 0;
  for (const p of places) {
    if (p.p < floor) break; // sorted by population — everything after is smaller
    if (shown >= CAP) break;
    if (!bounds.contains([p.lat, p.lon])) continue;
    const pt = map.project([p.lat, p.lon], z);
    // The town name outranks a hub pin, but offset beats overlay (Google/Apple
    // put the label beside the marker): centred by default, and when that
    // crosses a hub disc try below it, then above — below wins if both fail.
    const est = EST[tier(p.p)];
    const w = p.n.length * est.cw;
    let dy = 0;
    if (obs.length && hitsObstacle(pt.x, pt.y, 0, w, est.h, obs)) {
      dy = !hitsObstacle(pt.x, pt.y, 38, w, est.h, obs) ? 38
        : (!hitsObstacle(pt.x, pt.y, -38, w, est.h, obs) ? -38 : 38);
    }
    const cx = Math.round(pt.x / 78);
    const cy = Math.round((pt.y + dy) / 26);
    const cells = [`${cx},${cy}`, `${cx - 1},${cy}`, `${cx + 1},${cy}`];
    if (cells.some((c) => taken.has(c))) continue;
    cells.forEach((c) => taken.add(c));
    shown += 1;
    // divIcon html is a template string — escape the OSM name (quotes exist)
    const safe = p.n.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const style = dy ? ` style="transform:translate(-50%,calc(-50% + ${dy}px))"` : '';
    layer.addLayer(window.L.marker([p.lat, p.lon], {
      pane: PANE,
      interactive: false,
      keyboard: false,
      icon: window.L.divIcon({
        className: 'city-label-wrap',
        html: `<span class="city-label cl-${tier(p.p)}"${style}>${safe}</span>`,
        iconSize: [0, 0],
      }),
    }));
  }
}

export async function initCityLabels(theMap) {
  map = theMap;
  map.createPane(PANE);
  const pane = map.getPane(PANE);
  pane.style.zIndex = 620;          // above markerPane (600): pins never hide names
  pane.style.pointerEvents = 'none'; // taps fall through to the pins beneath
  layer = window.L.layerGroup().addTo(map);
  let t = null;
  schedule = () => { clearTimeout(t); t = setTimeout(render, 120); };
  map.on('zoomend', schedule);
  map.on('moveend', schedule);
  await loadPlaces();
  render();
}
