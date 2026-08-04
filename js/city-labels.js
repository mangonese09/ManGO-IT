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

function tier(p) { return p >= 45000 ? 'big' : p >= 8000 ? 'mid' : 'small'; }

function loadPlaces() {
  loading ||= fetch(DATA_URL)
    .then((r) => { if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); })
    .then((rows) => { places = rows; }) // pre-sorted by population desc
    .catch(() => { loading = null; }); // silent: map simply keeps no extra labels
  return loading;
}

function render() {
  if (!map || !places) return;
  layer.clearLayers();
  const z = map.getZoom();
  if (z >= HANDOFF_ZOOM) return;
  const bounds = map.getBounds().pad(0.08);
  const floor = minPop(z);
  // greedy collision cull, biggest towns first: one label per ~78×26px cell,
  // with the horizontal neighbours reserved too (labels are wide).
  const taken = new Set();
  let shown = 0;
  for (const p of places) {
    if (p.p < floor) break; // sorted by population — everything after is smaller
    if (shown >= CAP) break;
    if (!bounds.contains([p.lat, p.lon])) continue;
    const pt = map.project([p.lat, p.lon], z);
    const cx = Math.round(pt.x / 78);
    const cy = Math.round(pt.y / 26);
    const cells = [`${cx},${cy}`, `${cx - 1},${cy}`, `${cx + 1},${cy}`];
    if (cells.some((c) => taken.has(c))) continue;
    cells.forEach((c) => taken.add(c));
    shown += 1;
    // divIcon html is a template string — escape the OSM name (quotes exist)
    const safe = p.n.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    layer.addLayer(window.L.marker([p.lat, p.lon], {
      pane: PANE,
      interactive: false,
      keyboard: false,
      icon: window.L.divIcon({
        className: 'city-label-wrap',
        html: `<span class="city-label cl-${tier(p.p)}">${safe}</span>`,
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
  const schedule = () => { clearTimeout(t); t = setTimeout(render, 120); };
  map.on('zoomend', schedule);
  map.on('moveend', schedule);
  await loadPlaces();
  render();
}
