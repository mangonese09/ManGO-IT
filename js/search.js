// ── A→B SEARCH ──
import { api } from './api.js';
import { el, modeMeta, modeClass, modeIcon, isRailMode, liveBadge, staleChip, openSheet, placeIcon, placeIconKey } from './ui.js';
import { romeTime, romeDay, romeHour, dayPartKey, DAYPARTS, durationText, isOtherRomeDay, romeWallToIso, whenLabel, deviceZoneGap, romeNowInputValue } from './time.js';
import { displayName } from './names.js';
import { worstTransferMin, transferTier, transferChipText, imminentText, legStripModel, groupByDaypart, plusTag, isRailReplacement, RESULT_FILTERS, matchesFilter } from './itinerary.js';
import { operatorFor, fareChip, fareSummary, eur } from './operators.js';
import { saisOdFare } from './fares-od.js';
import { getRecents, pushRecent, removeRecent, getFavStops, addFavStop, removeFavStop, getSettings, getPlacesSorted, addPlace, removePlace, isPlace } from './store.js';
import { getLastPos } from './board.js';
import { toast } from './toast.js';

// Selected endpoints: {name, place} where place is "lat,lon" or a stopId.
const sel = { from: null, to: null };
let departMode = 'depart'; // or 'arrive'

export function initSearch() {
  wireEndpoint('from');
  wireEndpoint('to');
  document.getElementById('swap-btn').addEventListener('click', swapEndpoints);
  document.getElementById('search-btn').addEventListener('click', runSearch);
  document.getElementById('when-toggle').addEventListener('click', toggleWhen);
  initWhenChip();
  initModeToggles();
  renderRecents();
}

// ── WHEN CHIP (v0.9.5) ──
// The native datetime-local's "mm/dd/yyyy --:--" placeholder read as broken
// US-formatted text. A styled chip shows "Now" or the picked Italy time and
// opens the native picker on tap; the input stays in the DOM (visually
// hidden) so the picker, form value and existing search code are unchanged.
function syncWhenDisplay() {
  const input = document.getElementById('when-input');
  const disp = document.getElementById('when-display');
  const clear = document.getElementById('when-clear');
  if (!input || !disp) return;
  disp.textContent = whenLabel(input.value);
  if (clear) clear.hidden = !input.value;
}

function initWhenChip() {
  const input = document.getElementById('when-input');
  const disp = document.getElementById('when-display');
  const clear = document.getElementById('when-clear');
  if (!input || !disp) return;
  // An empty datetime-local opens seeded from the DEVICE clock, so a phone still
  // on Chicago time invited the user to pick 1:30pm meaning their own 1:30pm.
  // Seed Italy now instead; if they dismiss the picker, drop back to "Now".
  let seeded = null;
  disp.addEventListener('click', () => {
    if (!input.value) { seeded = romeNowInputValue(); input.value = seeded; syncWhenDisplay(); }
    try { input.showPicker(); } catch { input.focus(); }
  });
  input.addEventListener('cancel', () => {
    if (seeded && input.value === seeded) { input.value = ''; syncWhenDisplay(); }
    seeded = null;
  });
  input.addEventListener('change', () => { seeded = null; syncWhenDisplay(); });
  input.addEventListener('input', syncWhenDisplay);
  if (clear) clear.addEventListener('click', () => { input.value = ''; seeded = null; syncWhenDisplay(); });
  syncWhenDisplay();
  renderZoneNote();
}

// ── ITALY-TIME NOTICE ──
// Silent on an Italian-offset phone. Off-offset, it replaces the footnote with
// the actual gap and repeats it above the results, where the clock times are.
function renderZoneNote() {
  const p = document.querySelector('.when-tz');
  const gap = deviceZoneGap();
  if (!p || !gap) return;
  p.textContent = `All times are Italy time — ${gap.text}.`;
  p.classList.add('tz-gap');
}

export function zoneBanner() {
  const gap = deviceZoneGap();
  if (!gap) return null;
  return el('p', { class: 'tz-banner', text: `Italy time — ${gap.text}` });
}


// programmatic value changes don't fire 'input' — call after any of them
function syncClears() {
  for (const w of ['from', 'to']) {
    const i = document.getElementById(`${w}-input`);
    const b = document.getElementById(`${w}-clear`);
    if (i && b) b.hidden = !i.value;
  }
}

function wireEndpoint(which) {
  const input = document.getElementById(`${which}-input`);
  const list = document.getElementById(`${which}-suggest`);
  const clearBtn = document.getElementById(`${which}-clear`);
  let timer = null;

  const syncClear = () => { clearBtn.hidden = !input.value; };
  clearBtn.addEventListener('click', () => {
    input.value = '';
    sel[which] = null;
    list.innerHTML = '';
    list.hidden = true;
    syncClear();
    input.focus();
  });

  input.addEventListener('input', () => {
    sel[which] = null;
    syncClear();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
    timer = setTimeout(() => suggest(which, q), 300);
  });
  input.addEventListener('focus', () => {
    if (!input.value.trim()) showQuickPicks(which, list, input);
  });
  // QA-23: Enter searches (was never wired; enterkeyhint promised it)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    list.hidden = true;
    if (sel.from && sel.to) runSearch();
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) { list.hidden = true; }
  });
}

// Focusing an empty endpoint shows quick-picks: My location (From only), then
// your saved places (Home first). Tapping one fills the endpoint immediately.
function showQuickPicks(which, list, input) {
  list.innerHTML = '';
  if (which === 'from') {
    list.appendChild(el('button', {
      class: 'suggest-row suggest-loc',
      onclick: () => {
        list.hidden = true;
        input.value = 'My location';
        syncClears();
        locate().then((pos) => {
          sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`, lat: pos.lat, lon: pos.lon };
        }).catch(() => {
          input.value = '';
          syncClears();
          toast('Location unavailable — type a place instead', 'warn');
        });
      },
    }, [
      el('img', { src: '/icons/place-pin.png', alt: '' }),
      el('span', { text: ' My location' }),
    ]));
  }
  list.appendChild(chooseOnMapRow(which));
  for (const p of getPlacesSorted().slice(0, 6)) {
    list.appendChild(el('button', {
      class: 'suggest-row suggest-place',
      onclick: () => {
        list.hidden = true;
        sel[which] = { name: p.name, place: `${p.lat},${p.lon}`, lat: p.lat, lon: p.lon };
        input.value = p.label || displayName(p.name);
        syncClears();
        // destination-first, mirroring a suggestion pick
        if (which === 'to' && !sel.from) {
          document.getElementById('from-input').value = 'My location';
          syncClears();
          locate().then((pos) => {
            sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`, lat: pos.lat, lon: pos.lon };
            runSearch();
          }).catch(() => {
            document.getElementById('from-input').value = '';
            syncClears();
            toast('Location unavailable — set a starting point', 'warn');
          });
        } else if (sel.from && sel.to) {
          runSearch();
        }
      },
    }, [
      el('span', { class: 'suggest-icon' }, [placeIcon(placeIconKey(p))]),
      el('span', { class: 'suggest-name', text: p.label || displayName(p.name) }),
      el('span', { class: 'suggest-area', text: p.home ? 'Home' : 'saved place' }),
    ]));
  }
  list.hidden = list.children.length === 0;
}

// ── MODE FILTERS (v0.9.0) ──
// Two honest buckets: trains vs buses+coaches. Tram/metro/ferry are
// marginal here and always stay included. Both-off is nonsense — blocked.
const RAIL_MODES = 'RAIL,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,REGIONAL_FAST_RAIL';
const BUS_MODES = 'BUS,COACH';
const ALWAYS_MODES = 'TRAM,METRO,SUBWAY,FERRY';
let modeSel = { train: true, bus: true };
try { modeSel = { ...modeSel, ...JSON.parse(localStorage.getItem('mangoit.modes') || '{}') } } catch { /* fresh */ }

function initModeToggles() {
  for (const which of ['train', 'bus']) {
    const btn = document.getElementById(`mode-${which}`);
    btn.classList.toggle('active', modeSel[which]);
    btn.setAttribute('aria-pressed', String(modeSel[which]));
    btn.addEventListener('click', () => {
      if (modeSel[which] && !modeSel[which === 'train' ? 'bus' : 'train']) {
        toast('Keep at least one mode on', 'warn');
        return;
      }
      modeSel[which] = !modeSel[which];
      btn.classList.toggle('active', modeSel[which]);
      btn.setAttribute('aria-pressed', String(modeSel[which]));
      try { localStorage.setItem('mangoit.modes', JSON.stringify(modeSel)); } catch { /* private mode */ }
      // QA-17: debounced — toggle bursts fire one search, not one per tap
      clearTimeout(initModeToggles._t);
      if (sel.from && sel.to) initModeToggles._t = setTimeout(runSearch, 400);
    });
  }
}

function planModes() {
  if (modeSel.train && modeSel.bus) return null; // no filter
  return (modeSel.train ? RAIL_MODES : BUS_MODES) + ',' + ALWAYS_MODES;
}

// ── WHOLE-DAY VIEW (Ship 3, §5) ──
// A search covers from-now to the end of the service day (§5.3, Open Q#1 →
// user chose from-now + Earlier ▲). Results cluster by daypart; Earlier/Later
// pills page the edges via MOTIS cursors. Users who want a short list flip
// Settings → "Next departures only" (§5.8), which restores the 6-in-6h view.
function wholeDay() { return getSettings().resultSpan !== 'next'; }

// Seconds from an anchor instant to 03:00 Rome the next day — the service-day
// end (§5.6: no coach departs 00:00–04:00). Clamped so a late search still
// spans the tail and an early one doesn't request an absurd window.
function wholeDayWindowSec(anchorMs) {
  const romeDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(anchorMs));
  const endIso = romeWallToIso(`${nextDateStr(romeDate)}T03:00`);
  const sec = Math.round((new Date(endIso).getTime() - anchorMs) / 1000);
  return Math.max(3600, Math.min(90000, sec)); // 1h floor, ~25h ceiling
}

function romeDateOf(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}
const DAYPART_LABEL = Object.fromEntries(DAYPARTS.map((d) => [d.key, d.label]));

// Accumulated whole-day plan state — the pills page into this and re-render.
// cutoffMs = service-day end (03:00 next day); the default view stops there and
// `expanded` flips true when Later reveals the already-fetched next day (§5.6).
// anchorMs = the instant the user actually asked about (the Depart-at time, or
// now). Day labelling keys off THIS, not off the device's today — searching a
// future date used to leave rows on today's date silently unlabelled while the
// requested day got a header, so an Earlier page that walked back into
// yesterday read as part of the searched day.
const dayView = { its: [], next: null, prev: null, base: null, stale: false, fetchedAt: 0, loading: false, cutoffMs: 0, expanded: false, anchorMs: 0 };
function itiKey(it) { return `${it.startTime}|${it.endTime}|${it.legs?.[0]?.routeShortName || ''}`; }
function mergeIts(more) {
  const seen = new Set(dayView.its.map(itiKey));
  for (const it of more) if (!seen.has(itiKey(it))) { seen.add(itiKey(it)); dayView.its.push(it); }
}

// ── RESULT FILTER (v1.2.0) ──
// Chips narrow the list already in hand and carry their own counts, so an empty
// bucket is visible before you tap it. Predicates live in itinerary.js (pure,
// unit-tested). Reset to All on every new search: a sticky "Direct" would
// quietly empty the next route you looked up.
let resultFilter = 'all';
let rerenderResults = () => {};

function filterRow(all) {
  const row = el('div', { class: 'filter-row', role: 'group', 'aria-label': 'Filter results' });
  for (const f of RESULT_FILTERS) {
    const n = f.key === 'all' ? all.length : all.filter((it) => matchesFilter(it, f.key)).length;
    const active = resultFilter === f.key;
    row.appendChild(el('button', {
      class: `filter-chip${active ? ' active' : ''}${!n ? ' filter-chip-empty' : ''}`,
      'aria-pressed': String(active),
      onclick: () => { if (resultFilter === f.key) return; resultFilter = f.key; rerenderResults(); },
    }, [
      el('span', { text: f.label }),
      f.key === 'all' ? null : el('span', { class: 'filter-count', text: String(n) }),
    ]));
  }
  return row;
}

function filterEmptyState() {
  const label = (RESULT_FILTERS.find((f) => f.key === resultFilter) || {}).label || 'that';
  return el('div', { class: 'empty-state' }, [
    el('p', { text: `No ${label.toLowerCase()} options on this route.` }),
    el('button', {
      class: 'btn btn-ghost btn-small', text: 'Show all results',
      onclick: () => { resultFilter = 'all'; rerenderResults(); },
    }),
  ]);
}

// belt-and-suspenders if upstream ignores transitModes
function itineraryAllowed(it) {
  for (const l of it.legs || []) {
    if (l.mode === 'WALK') continue;
    const isRail = /RAIL|LONG_DISTANCE/.test(l.mode || '');
    const isBus = l.mode === 'BUS' || l.mode === 'COACH';
    if (isRail && !modeSel.train) return false;
    if (isBus && !modeSel.bus) return false;
  }
  return true;
}

// What a geocode result IS (icon + human kind) — shared by Home suggestions
// and the Map tab's place search so both surfaces read identically.
export function classifySuggestion(r) {
  let iconEl = placeIcon('pin');
  let kind = '';
  if (r.type === 'AIRPORT') {
    // server-side IATA/alias hit (PMO, CTA…) — same plane artwork as the map's
    // airport hub pins. Explicit width/height: a dynamically-created icon img
    // must not depend on CSS alone (a stale-CSS/fresh-JS service worker window
    // renders it at natural size otherwise).
    iconEl = el('img', { class: 'mode-img', src: '/icons/plane-mango.png', alt: 'Airport', width: '22', height: '22' });
    kind = 'airport';
  } else if (r.type === 'STOP') {
    const m = r.modes || [];
    if (m.some((x) => /RAIL|LONG_DISTANCE/.test(x || ''))) { iconEl = modeIcon('RAIL'); kind = 'train station'; }
    else if (m.some((x) => /METRO|SUBWAY/.test(x || ''))) { iconEl = modeIcon('METRO'); kind = 'metro station'; }
    else if (m.some((x) => /TRAM/.test(x || ''))) { iconEl = modeIcon('TRAM'); kind = 'tram stop'; }
    else { iconEl = modeIcon('BUS'); kind = 'city bus stop'; }
  } else if (r.type === 'COACH_STOP') {
    iconEl = modeIcon('COACH'); kind = 'coach stop';
  } else if (/^(city|town|village|hamlet)/.test(r.category || '') || (!r.category && r.type === 'PLACE')) {
    iconEl = el('span', { class: 'mode-emoji', text: '🏘️' }); kind = 'town';
  } else if (r.type === 'ADDRESS' || /^(via|viale|corso|salita|piazza)\b/i.test(r.name)) {
    kind = 'address';
  }
  return { iconEl, kind };
}

// "Choose on map" (Google Maps' directions pattern): jump to the Map tab in
// pick mode — pan a fixed centre pin, confirm, come back with the spot set.
function chooseOnMapRow(which) {
  return el('button', {
    class: 'suggest-row suggest-mappick',
    onclick: () => chooseOnMap(which),
  }, [
    el('span', { class: 'suggest-icon' }, [placeIcon('pin')]),
    el('span', { class: 'suggest-name', text: 'Choose on map' }),
    el('span', { class: 'suggest-area', text: 'drop a pin anywhere' }),
  ]);
}

async function chooseOnMap(which) {
  document.getElementById(`${which}-suggest`).hidden = true;
  const { pickPointOnMap } = await import('./mapview.js');
  const pick = await pickPointOnMap();
  if (!pick) return; // cancelled (✕ or a nav tap) — stay wherever the user went
  document.getElementById('nav-home')?.click();
  sel[which] = { name: pick.label, place: `${pick.lat.toFixed(5)},${pick.lon.toFixed(5)}`, lat: pick.lat, lon: pick.lon };
  document.getElementById(`${which}-input`).value = pick.label;
  syncClears();
  if (sel.from && sel.to) runSearch();
}

// Exact-name-first ranking, shared by Home + map search: typing "palermo"
// should lead with Palermo the city and its main station, not Catania street
// stops NAMED after Palermo. Ties keep the server's Sicily-first order.
export function rankSuggestions(rows, q) {
  const ql = (q || '').trim().toLowerCase();
  const score = (r) => {
    // an airport row only exists when the query EXACTLY matched its code or an
    // alias, so it is the answer — without this it scores on name ("Aeroporto
    // Falcone Borsellino" doesn't start with "pmo") and gets pushed down.
    if (r.type === 'AIRPORT') return -1;
    const n = (r.name || '').toLowerCase();
    const nameRank = n === ql ? 0 : n.startsWith(ql) ? 1 : 2;
    const { kind } = classifySuggestion(r);
    const kindRank = kind === 'town' ? 0 : kind === 'train station' ? 1 : kind === 'coach stop' ? 2 : 3;
    return nameRank * 10 + kindRank;
  };
  return rows.map((r, i) => ({ r, i, sc: score(r) }))
    .sort((a, b) => a.sc - b.sc || a.i - b.i)
    .map((x) => x.r);
}

// star a stop/station straight from the Home suggestions -> Saved favorites
export function suggestStar(r, kind) {
  const key = r.type === 'STOP' && r.id ? r.id : `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  const isFav = () => getFavStops().some((f) => f.key === key);
  const star = el('span', {
    class: `pin-btn suggest-star${isFav() ? ' pinned' : ''}`,
    role: 'button', tabindex: '0', 'aria-label': 'Save stop', text: isFav() ? '★' : '☆',
    onclick: (e) => {
      e.stopPropagation();
      if (isFav()) {
        removeFavStop(key);
        star.textContent = '☆'; star.classList.remove('pinned');
        toast('Removed from Saved', 'info', 1400);
      } else {
        const iconMode = r.type === 'COACH_STOP' ? 'COACH'
          : (r.modes || []).some((x) => /RAIL|LONG_DISTANCE/.test(x || '')) ? 'RAIL' : 'BUS';
        addFavStop({ key, name: r.name, kind, iconMode, stopId: r.type === 'STOP' ? r.id : null, lat: r.lat, lon: r.lon });
        star.textContent = '★'; star.classList.add('pinned');
        toast('Saved — see the Saved tab', 'info', 1400);
      }
    },
  });
  return star;
}

// Star for a PLACE result (town / address) — saves a trip-endpoint favourite,
// distinct from a stop's departures board.
export function placeStar(r) {
  const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  const star = el('span', {
    class: `pin-btn suggest-star${isPlace(key) ? ' pinned' : ''}`,
    role: 'button', tabindex: '0', 'aria-label': 'Save place', text: isPlace(key) ? '★' : '☆',
    onclick: (e) => {
      e.stopPropagation();
      if (isPlace(key)) {
        removePlace(key);
        star.textContent = '☆'; star.classList.remove('pinned');
        toast('Removed from places', 'info', 1400);
      } else {
        addPlace({ key, label: displayName(r.name), name: r.name, lat: r.lat, lon: r.lon });
        star.textContent = '★'; star.classList.add('pinned');
        toast('Saved to places — Saved tab', 'info', 1400);
      }
    },
  });
  return star;
}

// Location bias for address autocomplete (§geocode): a bare street query like
// "Via Crocifisso" is one of dozens across Italy — without a bias Transitous
// returns a globally-ranked list where Sicily barely appears. Bias to the
// user's known position when it's inside Italy (best local relevance), else the
// Sicily centroid. Never triggers a permission prompt — reuses board.js's
// already-granted fix, so a Chicago-set phone still gets Sicilian streets.
const SICILY_CENTROID = '37.6,14.15';
function inItaly(p) {
  return p && p.lat >= 35.2 && p.lat <= 47.2 && p.lon >= 6.5 && p.lon <= 18.8;
}
function geoBias() {
  const p = getLastPos();
  return (p && inItaly(p)) ? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}` : SICILY_CENTROID;
}

const suggestSeq = { from: 0, to: 0 };
async function suggest(which, q) {
  const list = document.getElementById(`${which}-suggest`);
  const seq = ++suggestSeq[which];
  try {
    const { data } = await api.geocode(q, geoBias());
    if (seq !== suggestSeq[which]) return; // a newer request superseded this one
    list.innerHTML = '';
    list.appendChild(chooseOnMapRow(which));
    // show up to 12 (the geocoder caps at ~10 anyway): with Sicily-first ranking
    // this surfaces more Sicilian streets so a nearby one isn't cut off the list
    for (const r of rankSuggestions(data, q).slice(0, 12)) {
      // every result states WHAT it is: train station / metro / tram /
      // city bus stop / intercity coach stop / town / address. The neutral
      // default is the mango pin (was a bare red 📌 emoji).
      const { iconEl, kind } = classifySuggestion(r);
      // context line: "what it is · town · province", never just an echo of
      // the name ("· Italia" is geocoder filler, not context — drop it)
      const bits = [];
      if (kind) bits.push(kind);
      if (r.town && r.town !== 'Italia' && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(displayName(r.town));
      if (r.province && r.province !== r.town) bits.push(`prov. ${r.province}`);
      if (!bits.length && r.province) bits.push(`prov. ${r.province}`);
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          sel[which] = { name: r.name, place: r.type === 'STOP' && r.id ? r.id : `${r.lat},${r.lon}`, lat: r.lat, lon: r.lon };
          document.getElementById(`${which}-input`).value = displayName(r.name);
          syncClears();
          list.hidden = true;
          // destination-first: picking a To with no From = route me there from here
          if (which === 'to' && !sel.from) {
            document.getElementById('from-input').value = 'My location';
            syncClears();
            locate().then((pos) => {
              sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`, lat: pos.lat, lon: pos.lon };
              runSearch();
            }).catch(() => {
              document.getElementById('from-input').value = '';
              toast('Location unavailable — set a starting point', 'warn');
            });
          }
        },
      }, [
        el('span', { class: 'suggest-icon' }, [iconEl]),
        el('span', { class: 'suggest-name', text: displayName(r.name) }),
        bits.length ? el('span', { class: 'suggest-area', text: bits.join(' · ') }) : null,
        (r.type === 'STOP' || r.type === 'COACH_STOP') ? suggestStar(r, kind)
          : (isFinite(r.lat) && isFinite(r.lon) ? placeStar(r) : null),
      ]));
    }
    list.hidden = false; // the Choose-on-map row is always present
  } catch (err) {
    // R-05: a dead lookup used to look exactly like "no matches" — the one
    // surface where absence went unexplained. Say so, once per outage.
    if (seq !== suggestSeq[which]) return;
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'suggest-row suggest-dead muted', text:
      /429/.test(err?.message || '') ? 'Too many searches just now — wait a moment and retype.'
        : "Can't reach place search — check your connection and retype." }));
    list.hidden = false;
  }
}

function swapEndpoints() {
  const fi = document.getElementById('from-input');
  const ti = document.getElementById('to-input');
  [fi.value, ti.value] = [ti.value, fi.value];
  [sel.from, sel.to] = [sel.to, sel.from];
  syncClears();
}

function toggleWhen() {
  departMode = departMode === 'depart' ? 'arrive' : 'depart';
  const btn = document.getElementById('when-toggle');
  btn.textContent = departMode === 'depart' ? 'Depart' : 'Arrive by';
  btn.setAttribute('aria-pressed', String(departMode === 'arrive'));
  // R-01: "Arrive by" only reaches the router when a time is set, so with no
  // time it silently did nothing. Say what it needs instead of pretending.
  if (departMode === 'arrive' && !document.getElementById('when-input').value) {
    toast('Pick an arrival time — tap the Now chip', 'info', 2200);
  }
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 120000 },
    );
  });
}

function havM(a, b) {
  const p = Math.PI / 180, dl = (b.lon - a.lon) * p, dp = (b.lat - a.lat) * p;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

let searchSeq = 0;
async function runSearch() {
  const mySeq = ++searchSeq; // rapid re-searches (mode toggles) supersede in-flight ones
  const results = document.getElementById('results');
  if (!sel.from || !sel.to) {
    toast('Pick both places from the suggestions', 'warn');
    return;
  }
  // QA-01: same place both ends -> honest refusal, not loop-bus self-trips
  if (sel.from.name === sel.to.name ||
      (sel.from.lat && sel.to.lat && havM(sel.from, sel.to) < 400)) {
    toast('Origin and destination are the same place', 'warn');
    return;
  }
  results.innerHTML = '';
  results.appendChild(el('div', { class: 'loading', text: 'Finding routes…' }));

  const whenVal = document.getElementById('when-input').value;
  const params = { fromPlace: sel.from.place, toPlace: sel.to.place };
  if (whenVal) {
    params.time = romeWallToIso(whenVal);
    if (departMode === 'arrive') params.arriveBy = true;
  }
  const modes = planModes();
  if (modes) params.modes = modes;

  // The instant the user asked about — day labelling and the "nothing until…"
  // note both key off this, so it is set for every search, whole-day or not.
  const anchorMs = params.time ? new Date(params.time).getTime() : Date.now();
  dayView.anchorMs = anchorMs;
  resultFilter = 'all';

  // Whole-day window (§5.3): from the anchor (now, or an explicit Depart-at
  // time) to the service-day end. "Arrive by" keeps the tight before-deadline
  // window — a whole day of arrivals is not what that question asks.
  const whole = wholeDay() && departMode === 'depart';
  let cutoffMs = 0;
  if (whole) {
    params.searchWindow = wholeDayWindowSec(anchorMs);
    params.maxItineraries = 24;
    cutoffMs = anchorMs + params.searchWindow * 1000; // service-day end
  }

  // Race the plan with our own direct lookup (answers in ms): direct coaches
  // render alongside WEAK plan results too, not only on total failure —
  // Transitous can "succeed" with a 4 h rail-replacement bus while our feed
  // holds a 2 h coach it hasn't ingested yet (audit F-4).
  // explicit travel dates flow through to the direct lookup, or a date-picked
  // search would render TODAY's coaches as the answer
  const qDate = whenVal ? whenVal.slice(0, 10) : null;
  const qAfterMin = (whenVal && departMode === 'depart')
    ? Number(whenVal.slice(11, 13)) * 60 + Number(whenVal.slice(14, 16)) : null;
  const directPromise = (modeSel.bus && sel.from?.lat && sel.to?.lat)
    ? api.direct({ fromLat: sel.from.lat, fromLon: sel.from.lon,
                   toLat: sel.to.lat, toLon: sel.to.lon,
                   date: qDate || undefined, afterMin: qAfterMin ?? undefined,
                   full: whole }).catch(() => null)
    : Promise.resolve(null);

  try {
    const { data, stale, fetchedAt } = await api.plan(params);
    if (mySeq !== searchSeq) return;
    pushRecent({ from: sel.from, to: sel.to });
    renderRecents();
    const allowed = (data.itineraries || []).filter(itineraryAllowed);
    if (whole && allowed.length) {
      dayView.its = allowed.slice();
      dayView.next = data.nextPageCursor || null;
      dayView.prev = data.previousPageCursor || null;
      dayView.base = { ...params }; delete dayView.base.pageCursor;
      dayView.stale = stale; dayView.fetchedAt = fetchedAt;
      dayView.cutoffMs = cutoffMs; dayView.expanded = false;
      renderDayView();
    } else {
      renderItineraries(allowed, { stale, fetchedAt });
    }
    const dir = await directPromise;
    if (mySeq !== searchSeq) return;
    const runs = dir?.data?.results || [];
    const xfers = dir?.data?.transfers || [];
    const its = allowed;
    if (!its.length) {
      const ok = renderDirectBlock(runs, 'empty', xfers);
      // Cross-network stitch: our coach → a big-city rail hub → the destination
      // by train. Answers "coach-only town → Palermo airport" that neither path
      // completes alone (our coaches aren't in Transitous yet).
      const stitched = await maybeRenderViaHub(whenVal, mySeq);
      if (mySeq !== searchSeq) return;
      if (!ok && !stitched) await renderDeadEnd(params, whenVal);
    } else if (runs.length) {
      const bestPlanMin = Math.min(...its.map((i) => (i.duration || 1e9) / 60));
      const bestDirectMin = Math.min(...runs.map(directRunMinutes));
      if (bestDirectMin + 15 < bestPlanMin) renderDirectBlock(runs, 'faster', xfers);
    }
    maybeHorizonNote(whenVal);
  } catch (err) {
    if (mySeq !== searchSeq) return;
    results.innerHTML = '';
    const dir = await directPromise;
    if (mySeq !== searchSeq) return;
    const ok = renderDirectBlock(dir?.data?.results || [], 'down', dir?.data?.transfers || []);
    if (!ok) {
      // R-04: "too many requests" is not "the service is down" — saying the
      // wrong one sends the user to check their connection for no reason.
      const busy = /429/.test(err?.message || '');
      results.appendChild(el('div', { class: 'empty-state' }, [
        el('p', { text: busy
          ? 'Too many searches in the last minute.'
          : 'No route found — the routing service may be unreachable.' }),
        el('p', { class: 'muted', text: busy
          ? 'Wait about a minute and search again.'
          : 'Check the operator sites directly, or retry when back online.' }),
      ]));
    }
  }
}

// ── DEAD-END FALLBACKS (audit P1) ──
// Empty results are never a bare shrug: (1) admit when the query is past
// the verified schedule horizon, (2) probe the same trip tomorrow, (3) name
// the nearest stop our data actually serves when an endpoint is uncovered.
// R-18: memoised, but not forever — a tab left open across a feed refresh
// would otherwise quote a horizon that moved hours ago.
let healthPromise = null;
let healthAt = 0;
const HEALTH_TTL_MS = 30 * 60 * 1000;
function feedHorizonDate() {
  if (!healthPromise || Date.now() - healthAt > HEALTH_TTL_MS) {
    healthAt = Date.now();
    healthPromise = api.health().catch(() => null);
  }
  return healthPromise.then((h) => h?.data?.feedHorizon?.date || null);
}

function romeDateStr(offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86400000));
}

function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
  return nd.toISOString().slice(0, 10);
}

async function maybeHorizonNote(whenVal) {
  const horizon = await feedHorizonDate();
  const qDate = (whenVal && whenVal.slice(0, 10)) || romeDateStr(0);
  if (!horizon || qDate <= horizon) return;
  const results = document.getElementById('results');
  if (results.querySelector('.horizon-note')) return;
  results.appendChild(el('div', { class: 'horizon-note muted', text:
    `Coach schedules are verified through ${horizon}. On later dates coaches that do run may be missing here — recheck closer to travel.` }));
}

async function renderDeadEnd(params, whenVal) {
  const results = document.getElementById('results');
  const box = el('div', { class: 'empty-state' }, [
    el('p', { text: 'No connections found for this trip.' }),
  ]);
  results.appendChild(box);

  const baseDate = (whenVal && whenVal.slice(0, 10)) || romeDateStr(0);
  const probeDate = nextDateStr(baseDate);

  // next-day probe: "nothing today" usually means "the last run left",
  // and the honest answer is when the next one goes
  try {
    const probe = await api.plan({
      fromPlace: params.fromPlace, toPlace: params.toPlace,
      time: romeWallToIso(`${probeDate}T05:00`),
    });
    const its = probe?.data?.itineraries || [];
    if (its.length) {
      const first = its[0];
      box.appendChild(el('p', { text:
        `First connection on ${romeDay(first.startTime)}: ${romeTime(first.startTime)} → ${romeTime(first.endTime)} (${durationText(first.duration)}).` }));
      box.appendChild(el('button', { class: 'btn btn-ghost btn-small', text: 'Search that day instead', onclick: () => {
        document.getElementById('when-input').value = `${probeDate}T05:00`;
        syncWhenDisplay();
        departMode = 'depart';
        runSearch();
      } }));
    }
  } catch { /* probe is best-effort */ }

  // unserved-endpoint hint: say which side has no coverage and name the
  // closest stop that does
  for (const which of ['from', 'to']) {
    const pt = sel[which];
    if (!pt?.lat) continue;
    try {
      const near = await api.nearestServed(pt.lat, pt.lon);
      const s = near?.data?.stops?.[0];
      if (s && s.m > 2000) {
        box.appendChild(el('p', { class: 'muted', text:
          `${displayName(pt.name)} has no nearby stop in our coach data — nearest served: ${displayName(s.name)}, ${(s.m / 1000).toFixed(1)} km away.` }));
      }
    } catch { /* hint only */ }
  }

  // QA-12: never a bare one-liner — always close with something actionable.
  // R-03/C-1: the horizon sentence belongs to maybeHorizonNote alone; printing
  // it here too rendered it twice, back to back, on every past-horizon search.
  box.appendChild(el('p', { class: 'muted', text:
    'Try another date, swap the direction, or check the operator sites.' }));
  await maybeHorizonNote(whenVal);
}

function directRunMinutes(r) {
  const [dh, dm] = r.dep.split(':').map(Number);
  const [ah, am] = r.arr.split(':').map(Number);
  return ((ah * 60 + am) - (dh * 60 + dm) + 1440) % 1440;
}

// ── CROSS-NETWORK HUB STITCH (coach + train) ──
async function maybeRenderViaHub(whenVal, mySeq) {
  if (!sel.from?.lat || !sel.to?.place) return false;
  // Mode toggles are a contract: every stitch contains a coach leg, so with
  // buses off the whole block is out (the plan/direct blocks already comply).
  if (!modeSel.bus) return false;
  const results = document.getElementById('results');
  const note = el('div', { class: 'loading', text: 'Checking coach + train connections…' });
  results.appendChild(note);
  const qDate = whenVal ? whenVal.slice(0, 10) : undefined;
  const qAfterMin = (whenVal && departMode === 'depart')
    ? Number(whenVal.slice(11, 13)) * 60 + Number(whenVal.slice(14, 16)) : undefined;
  let data;
  try {
    ({ data } = await api.viaHub({ fromLat: sel.from.lat, fromLon: sel.from.lon,
      fromPlace: sel.from.place, toPlace: sel.to.place,
      toLat: sel.to.lat, toLon: sel.to.lon, date: qDate, afterMin: qAfterMin }));
  } catch { note.remove(); return false; }
  if (mySeq !== searchSeq) { note.remove(); return false; }
  note.remove();
  const stitches = (data?.stitches || []).filter((s) => s.coach && s.onward?.legs?.length)
    // trains off → drop stitches whose live half rides a rail leg
    .filter((s) => modeSel.train || !(s.onward.legs || []).some((l) => /RAIL|LONG_DISTANCE/.test(l.mode || '')));
  if (!stitches.length) return false;
  renderViaHubBlock(stitches);
  return true;
}

function onwardSummary(it) {
  const transit = (it.legs || []).filter((l) => l.mode !== 'WALK');
  const names = transit.map((l) => isRailReplacement(l) ? 'rail bus' : (l.routeShortName || l.displayName || modeMeta(l.mode).label));
  return names.join(' → ') || 'onward connection';
}

// Overall start/end clocks — the coach is first (forward) or last (reverse).
function stitchTimes(s) {
  return s.reverse
    ? { dep: romeTime(s.onward.startTime), arr: `${s.coach.arr}${plusTag(s.coach.arrPlus)}` }
    : { dep: s.coach.dep, arr: romeTime(s.onward.endTime) };
}

function appendMotisLegs(body, legs) {
  const opsSeen = new Set();
  (legs || []).forEach((leg, i) => {
    if (leg.mode === 'WALK') {
      const dest = leg.to?.name && !/^(end|start)$/i.test(leg.to.name) ? ` to ${displayName(leg.to.name)}` : '';
      body.appendChild(el('div', { class: 'leg leg-walk' }, [
        modeIcon('WALK', 'mode-img mode-img-sm'),
        el('span', { text: ` ${durationText(leg.duration)} walk` }),
        el('span', { class: 'muted', text: dest }),
      ]));
      return;
    }
    body.appendChild(renderTransitLeg(leg, i, opsSeen));
  });
}

function coachLegNode(c) {
  return detailCoachLeg({ route: c.routeId || '', operator: c.operator, from: c.from, to: c.to, dep: c.dep, arr: c.arr });
}

function renderViaHubBlock(stitches) {
  const results = document.getElementById('results');
  const kids = [
    el('div', { class: 'direct-head' }, [
      el('strong', { text: 'Change in the hub city' }),
      el('p', { class: 'muted', text: 'Coach legs run on their printed schedule — no live tracking.' }),
    ]),
  ];
  // Leg lines use the same mango mode icons as every other result — a stitch
  // is just an itinerary with a change, not a different kind of thing.
  const legLine = (mode, text, then = false) => el('div', { class: 'stitch-legline muted' }, [
    then ? el('span', { class: 'stitch-then', text: 'then ' }) : null,
    modeIcon(mode, 'mode-img mode-img-sm'),
    el('span', { text: ` ${text}` }),
  ]);
  for (const s of stitches) {
    const t = stitchTimes(s);
    const onwardMode = ((s.onward.legs || []).find((l) => l.mode !== 'WALK') || {}).mode || 'RAIL';
    const coachText = `${s.coach.dep} → ${s.coach.arr}${plusTag(s.coach.arrPlus)} to ${displayName(s.coach.to)}`;
    kids.push(el('button', { class: 'card iti-card stitch-card', onclick: () => openStitchDetail(s) }, [
      el('div', { class: 'iti-times' }, [
        el('span', { class: 'iti-time', text: `${t.dep} → ${t.arr}` }),
        el('span', { class: 'iti-dur', text: `via ${s.hub}` }),
      ]),
      s.reverse
        ? legLine(onwardMode, `${onwardSummary(s.onward)} to ${s.hub}`)
        : legLine('COACH', coachText),
      s.reverse
        ? legLine('COACH', coachText, true)
        : legLine(onwardMode, `${onwardSummary(s.onward)} to ${displayName(destName())}`, true),
      el('span', { class: 'dep-chevron stitch-chevron', text: '›' }),
    ]));
  }
  results.appendChild(el('div', { class: 'direct-block' }, kids));
}

function destName() { return sel.to?.name || 'destination'; }

function stitchChangeNote(atName) {
  return el('div', { class: 'stitch-change muted', text:
    `↕ Change at ${displayName(atName)}. The coach runs on its printed schedule (no live tracking) — allow some margin at the change.` });
}

function openStitchDetail(s) {
  const body = el('div', { class: 'iti-detail' });
  const t = stitchTimes(s);
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${t.dep} → ${t.arr}` }),
    el('span', { class: 'muted', text: ` · via ${s.hub}` }),
  ]));

  if (s.reverse) {
    // MOTIS [origin → hub] first, then our coach [hub → destination].
    appendMotisLegs(body, s.onward.legs);
    body.appendChild(stitchChangeNote(s.coach.from));
    coachWalkIn(body, s.coach);
    body.appendChild(coachLegNode(s.coach));
  } else {
    // Our coach [origin → hub] first, then MOTIS [hub → destination].
    coachWalkIn(body, s.coach);
    body.appendChild(coachLegNode(s.coach));
    body.appendChild(stitchChangeNote(s.coach.to));
    appendMotisLegs(body, s.onward.legs);
  }
  openSheet(body, { title: 'Trip detail — coach + connection' });
}

function coachWalkIn(body, coach) {
  if (coach.fromWalkM > 400) {
    const w = walkMin(coach.fromWalkM);
    body.appendChild(detailWalkRow(coach.fromWalkM,
      `${w} min walk (${(coach.fromWalkM / 1000).toFixed(1)} km) to ${displayName(coach.from)} — leave by ~${leaveBy(coach.dep, w)}`));
  }
}

// QA-22: compact day marker — the clock stays the loudest thing on the line
function dayTag(day) {
  if (!day || day === 'today') return '';
  if (day === 'tomorrow') return ' +1';
  const d = new Date(day + 'T12:00:00Z');
  return isNaN(d) ? ` ${day}` : ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── DIRECT-RESULT DETAIL SHEETS ──
// Every result row opens a full itinerary breakdown, same as plan cards.
function detailWalkRow(m, text) {
  return el('div', { class: 'leg leg-walk' }, [
    modeIcon('WALK', 'mode-img mode-img-sm'),
    el('span', { text: ` ${text}` }),
  ]);
}

function detailCoachLeg(leg) {
  return el('div', { class: 'leg leg-transit' }, [
    el('span', { class: 'leg-route' }, [
      modeIcon('COACH', 'mode-img mode-img-sm'),
      el('span', { text: ` ${displayName(leg.route)}` }),
    ]),
    el('div', { class: 'leg-stops' }, [
      el('div', { class: 'leg-stop' }, [
        el('strong', { text: leg.dep }), el('span', { text: ` ${displayName(leg.from)}` }),
      ]),
      el('div', { class: 'leg-stop' }, [
        el('strong', { text: leg.arr }), el('span', { text: ` ${displayName(leg.to)}` }),
      ]),
    ]),
    el('div', { class: 'muted leg-op', text: `${leg.operator} · scheduled times, no live status` }),
  ]);
}

function openDirectDetail(r) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${r.dep} → ${r.arr}` }),
    el('span', { class: 'muted', text: `${dayTag(r.day) || ' today'} · direct coach` }),
  ]));
  if (r.fromWalkM > 400) {
    const w = walkMin(r.fromWalkM);
    body.appendChild(detailWalkRow(r.fromWalkM,
      `${w} min walk (${(r.fromWalkM / 1000).toFixed(1)} km) to ${displayName(r.from)} — leave by ~${leaveBy(r.dep, w)}`));
  }
  body.appendChild(detailCoachLeg(r));
  if (r.toWalkM > 400) {
    body.appendChild(detailWalkRow(r.toWalkM,
      `${walkMin(r.toWalkM)} min walk (${(r.toWalkM / 1000).toFixed(1)} km) from ${displayName(r.to)} to your destination`));
  }
  openSheet(body, { title: 'Trip detail' });
}

function openChainDetail(c) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${c.legs[0].dep} → ${c.legs[1].arr}` }),
    el('span', { class: 'muted', text: `${dayTag(c.day) || ' today'} · 1 transfer` }),
  ]));
  if (c.fromWalkM > 400) {
    const w = walkMin(c.fromWalkM);
    body.appendChild(detailWalkRow(c.fromWalkM,
      `${w} min walk (${(c.fromWalkM / 1000).toFixed(1)} km) to ${displayName(c.legs[0].from)} — leave by ~${leaveBy(c.legs[0].dep, w)}`));
  }
  body.appendChild(detailCoachLeg(c.legs[0]));
  body.appendChild(el('div', { class: 'leg leg-walk' }, [
    el('span', { text: `⏱ ${c.waitMin} min at ${displayName(c.xferStop)}` }),
  ]));
  body.appendChild(detailCoachLeg(c.legs[1]));
  if (c.toWalkM > 400) {
    body.appendChild(detailWalkRow(c.toWalkM,
      `${walkMin(c.toWalkM)} min walk (${(c.toWalkM / 1000).toFixed(1)} km) from ${displayName(c.legs[1].to)} to your destination`));
  }
  openSheet(body, { title: 'Trip detail' });
}

// Walk legs to/from the coach network (v0.7.1): an address 4 km from the
// nearest stop still gets its route — with the walk stated, not hidden.
const WALK_M_PER_MIN = 80; // ~4.8 km/h
function walkMin(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)); }

function leaveBy(dep, wMin) {
  const [h, mm] = dep.split(':').map(Number);
  const t = ((h * 60 + mm - wMin) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function walkChip(fromWalkM, toWalkM) {
  const total = (fromWalkM > 400 ? fromWalkM : 0) + (toWalkM > 400 ? toWalkM : 0);
  if (!total) return null;
  return el('span', { class: 'chip chip-walk' }, [
    modeIcon('WALK', 'mode-img mode-img-xs'),
    el('span', { text: `${walkMin(total)} min` }),
  ]);
}


const DIRECT_HEADS = {
  down: 'Routing unavailable — our coaches only',
  empty: 'Direct coaches',
  faster: 'Faster by coach',
};

function directRunBtn(r) {
  return el('button', { class: 'dep-row dep-row-btn', onclick: () => openDirectDetail(r) }, [
    el('span', { class: 'dep-mode' }, [modeIcon('COACH')]),
    el('div', { class: 'dep-main dep-main-tight' }, [
      el('span', { class: 'dep-route' }, [
        el('span', { text: `${r.dep} → ${r.arr}${plusTag(r.arrPlus)}${dayTag(r.day)}` }),
        walkChip(r.fromWalkM || 0, r.toWalkM || 0),
      ]),
      el('span', { class: 'muted dep-headsign dep-oneline', text: `${displayName(r.from)} → ${displayName(r.to)}` }),
    ]),
    el('span', { class: 'dep-chevron', text: '›' }),
  ]);
}

function directXferBtn(c) {
  return el('button', { class: 'dep-row xfer-row dep-row-btn', onclick: () => openChainDetail(c) }, [
    el('span', { class: 'dep-mode' }, [modeIcon('COACH'), modeIcon('COACH')]),
    el('div', { class: 'dep-main dep-main-tight' }, [
      el('span', { class: 'dep-route' }, [
        el('span', { text: `${c.legs[0].dep} → ${c.legs[1].arr}${plusTag(c.arrPlus)}${dayTag(c.day)} · 1 transfer` }),
        walkChip(c.fromWalkM || 0, c.toWalkM || 0),
      ]),
      el('span', { class: 'muted dep-headsign dep-oneline', text: `${displayName(c.legs[0].from)} → ${displayName(c.legs[1].to)}` }),
    ]),
    el('span', { class: 'dep-chevron', text: '›' }),
  ]);
}

// Direct single-leg coaches + one-transfer chains from our own feed, honestly
// labeled (scheduled times only). As a supplement beside plan results ('faster')
// it stays short; as the primary answer ('empty'/'down') on a whole-day search
// it groups by daypart like the plan list.
function renderDirectBlock(runs, reason, transfers = []) {
  if (!runs.length && !transfers.length) return false;
  const results = document.getElementById('results');
  const primary = reason === 'empty' || reason === 'down';
  const shown = (!primary && runs.length > 3) ? runs.slice(0, 3) : runs;
  const kids = [
    el('div', { class: 'direct-head' }, [
      el('strong', { text: DIRECT_HEADS[reason] }),
      el('p', { class: 'muted', text: 'Scheduled times · tap a trip for details' }),
    ]),
  ];
  if (primary && shown.length > 6) {
    const today = shown.filter((r) => r.day === 'today');
    const later = shown.filter((r) => r.day !== 'today');
    const base = today.length ? today : later;
    for (const g of groupByDaypart(base, (r) => Number(r.dep.slice(0, 2)))) {
      kids.push(el('h3', { class: 'daypart-head', text: g.label }));
      for (const r of g.items) kids.push(directRunBtn(r));
    }
    if (today.length && later.length) {
      kids.push(el('h3', { class: 'daypart-head', text: 'Tomorrow' }));
      for (const r of later) kids.push(directRunBtn(r));
    }
  } else {
    for (const r of shown) kids.push(directRunBtn(r));
  }
  for (const c of transfers) kids.push(directXferBtn(c));
  results.appendChild(el('div', { class: 'direct-block' }, kids));
  return true;
}

// ── WHOLE-DAY RENDER (Ship 3, §5.7) ──
// "Earlier today" was a lie: when the searched day is empty MOTIS's earlier
// cursor walks back into the PREVIOUS day, and it said "today" regardless.
// Neither pill can know which day it will land on until the page returns, so
// neither one claims a day — the day headers below state it once it's known.
function pagePill(dir) {
  const label = dir === 'earlier' ? '▲  Earlier departures' : '▼  Later departures';
  return el('button', { class: `day-page day-page-${dir}`, onclick: () => pageDay(dir) },
    [el('span', { text: label })]);
}

function hasLaterLocal() {
  return !dayView.expanded && dayView.cutoffMs > 0
    && dayView.its.some((it) => new Date(it.startTime).getTime() >= dayView.cutoffMs);
}

async function pageDay(dir) {
  if (dayView.loading) return;
  // Later first reveals the next day already fetched (instant), before paging.
  if (dir === 'later' && hasLaterLocal()) { dayView.expanded = true; renderDayView(); return; }
  const cursor = dir === 'earlier' ? dayView.prev : dayView.next;
  if (!cursor || !dayView.base) return;
  dayView.loading = true;
  const btn = document.querySelector(`.day-page-${dir} span`);
  if (btn) btn.textContent = 'Loading…';
  try {
    const { data } = await api.plan({ ...dayView.base, pageCursor: cursor });
    mergeIts((data.itineraries || []).filter(itineraryAllowed));
    if (dir === 'earlier') dayView.prev = data.previousPageCursor || null;
    else { dayView.next = data.nextPageCursor || null; dayView.expanded = true; }
    renderDayView();
  } catch {
    toast('Could not load more departures', 'warn');
    if (btn) btn.textContent = dir === 'earlier' ? '▲  Earlier today' : '▼  Later departures';
  } finally {
    dayView.loading = false;
  }
}

// The searched day may simply have nothing after the requested time — Sunday
// coach service to a hill town is genuinely empty for hours. Say so, with the
// real gap, instead of opening on a 19:00 result as if it were the next one.
// Measured over the UNFILTERED window so a chip selection can't change the claim.
function anchorGapNote(inWindow, anchorMs) {
  if (!inWindow.length || !anchorMs) return null;
  const anchorIso = new Date(anchorMs).toISOString();
  const anchorDate = romeDateOf(anchorMs);
  const when = anchorDate === romeDateOf(Date.now()) ? 'today' : romeDay(anchorIso);
  const from = romeTime(anchorIso);
  const onDay = inWindow.filter((it) => romeDateOf(new Date(it.startTime).getTime()) === anchorDate);
  if (!onDay.length) {
    return el('div', { class: 'gap-note muted', text:
      `No departures ${when} after ${from} — showing the next ones.` });
  }
  const firstMs = Math.min(...onDay.map((it) => new Date(it.startTime).getTime()));
  if (firstMs - anchorMs < 90 * 60000) return null; // a normal wait, not a gap
  return el('div', { class: 'gap-note muted', text:
    `Nothing between ${from} and ${romeTime(new Date(firstMs).toISOString())} ${when} — that's the first departure.` });
}

// Single-pass, day-aware render: sorted by time so the searched day precedes
// the next. A day header appears whenever the list spans more than one day, or
// when its single day isn't the one you searched — paging can land on either.
// Dayparts head each cluster within a day.
function renderDayView() {
  const results = document.getElementById('results');
  rerenderResults = renderDayView;
  results.innerHTML = '';
  results.appendChild(staleChip(dayView.fetchedAt, dayView.stale));
  const zb1 = zoneBanner(); if (zb1) results.appendChild(zb1);

  const now = Date.now();
  const anchorMs = dayView.anchorMs || now;
  const anchorDate = romeDateOf(anchorMs);

  let inWindow = [...dayView.its].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  if (!dayView.expanded && dayView.cutoffMs > 0) {
    inWindow = inWindow.filter((it) => new Date(it.startTime).getTime() < dayView.cutoffMs);
  }
  results.appendChild(filterRow(inWindow));
  if (dayView.prev) results.appendChild(pagePill('earlier'));
  const gap = anchorGapNote(inWindow, anchorMs);
  if (gap) results.appendChild(gap);

  const sorted = inWindow.filter((it) => matchesFilter(it, resultFilter));
  if (!sorted.length) {
    results.appendChild(filterEmptyState());
    if (hasLaterLocal() || dayView.next) results.appendChild(pagePill('later'));
    ensureNextPill();
    return;
  }

  const hasPast = sorted.some((x) => new Date(x.startTime).getTime() < now - 60000);
  const multiDay = new Set(sorted.map((it) => romeDateOf(new Date(it.startTime).getTime()))).size > 1;
  let curDate = null, curPart = null, nowRuleDone = false;
  for (const it of sorted) {
    const ms = new Date(it.startTime).getTime();
    const d = romeDateOf(ms);
    if (d !== curDate) {
      if (multiDay || d !== anchorDate) results.appendChild(el('h3', { class: 'day-head', text: romeDay(it.startTime) }));
      curDate = d; curPart = null;
    }
    const part = dayPartKey(romeHour(it.startTime) ?? 20);
    if (part !== curPart) {
      results.appendChild(el('h3', { class: 'daypart-head', text: DAYPART_LABEL[part] }));
      curPart = part;
    }
    const past = ms < now - 60000;
    if (!past && !nowRuleDone && hasPast) {
      results.appendChild(el('div', { class: 'now-rule', text: 'now' }));
      nowRuleDone = true;
    }
    const card = itineraryCard(it);
    if (past) card.classList.add('iti-past');
    results.appendChild(card);
  }
  if (hasLaterLocal() || dayView.next) results.appendChild(pagePill('later'));
  ensureNextPill();
}

// Floating "↑ Next departure" pill (§5.7): jumps back to the first future row
// after the user scrolls past it. Reuses the map tab's locate-button pattern.
let nextPillWired = false;
function ensureNextPill() {
  if (!document.getElementById('next-dep-pill')) {
    const pill = el('button', { id: 'next-dep-pill', class: 'next-dep-pill', hidden: 'hidden', text: '↑ Next departure' });
    pill.addEventListener('click', () => {
      const t = document.querySelector('#results .iti-card:not(.iti-past)');
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    document.body.appendChild(pill);
  }
  if (!nextPillWired) {
    nextPillWired = true;
    window.addEventListener('scroll', updateNextPill, { passive: true });
  }
  updateNextPill();
}
function updateNextPill() {
  const pill = document.getElementById('next-dep-pill');
  if (!pill) return;
  const onHome = !document.getElementById('view-home')?.hidden;
  const t = document.querySelector('#results .iti-card:not(.iti-past)');
  pill.hidden = !onHome || !t || t.getBoundingClientRect().top > 80;
}
function hideNextPill() {
  const p = document.getElementById('next-dep-pill');
  if (p) p.hidden = true;
}

function renderItineraries(itineraries, { stale, fetchedAt }) {
  const results = document.getElementById('results');
  rerenderResults = () => renderItineraries(itineraries, { stale, fetchedAt });
  results.innerHTML = '';
  results.appendChild(staleChip(fetchedAt, stale));
  const zb2 = zoneBanner(); if (zb2) results.appendChild(zb2);
  hideNextPill();

  if (!itineraries.length) return; // caller renders direct results or the dead-end fallbacks

  results.appendChild(filterRow(itineraries));
  const shown = itineraries.filter((it) => matchesFilter(it, resultFilter));
  if (!shown.length) { results.appendChild(filterEmptyState()); return; }
  for (const it of shown) results.appendChild(itineraryCard(it));
}

// Result card (audit P2, competitive §1–§4): dep→arr clocks dominant,
// proportional leg strip, worst-transfer risk chip, honest live/scheduled.
function itineraryCard(it) {
  const transitLegs = it.legs.filter((l) => l.mode !== 'WALK');

  const strip = el('div', { class: 'leg-strip' });
  for (const seg of legStripModel(it.legs)) {
    if (seg.walk) {
      strip.appendChild(seg.long
        ? el('span', { class: 'leg-walk-gap leg-walk-long' }, [modeIcon('WALK', 'mode-img mode-img-sm')])
        : el('span', { class: 'leg-walk-gap', text: '›' }));
      continue;
    }
    const m = modeMeta(seg.mode);
    strip.appendChild(el('span', {
      class: `leg-seg ${modeClass(seg.mode)}`, style: `flex-grow:${seg.pct}`,
      title: `${m.label} ${seg.label}`.trim(),
    }, [
      modeIcon(seg.mode, 'mode-img leg-glyph-img'),
      seg.label ? el('span', { class: 'leg-label', text: seg.label }) : null,
    ]));
  }

  const worst = worstTransferMin(it.legs);
  const tier = transferTier(worst);
  const imminent = imminentText(it.startTime);
  const anyLive = transitLegs.some((l) => l.realTime);
  const railBus = transitLegs.some(isRailReplacement); // R-09: give the anonymous BUS cards an identity

  return el('button', { class: 'card iti-card', onclick: () => openItineraryDetail(it) }, [
    el('div', { class: 'iti-times' }, [
      el('span', { class: 'iti-time', text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
      imminent ? el('span', { class: 'chip chip-imminent', text: imminent }) : null,
      el('span', { class: 'iti-dur', text: durationText(it.duration) }),
    ]),
    // "other day" means other than the day you SEARCHED, not other than the
    // device's today — otherwise a future-dated search labels every row.
    isOtherRomeDay(it.startTime, new Date(dayView.anchorMs || Date.now()))
      ? el('div', { class: 'iti-day muted', text: romeDay(it.startTime) }) : null,
    strip,
    el('div', { class: 'iti-meta' }, [
      el('span', { class: 'muted', text: it.transfers === 0 ? 'direct' : `${it.transfers} transfer${it.transfers > 1 ? 's' : ''}` }),
      railBus ? el('span', { class: 'chip chip-railbus', text: 'replacement bus' }) : null,
      tier === 'calm' ? el('span', { class: 'muted', text: transferChipText(worst, tier) }) : null,
      tier === 'tight' || tier === 'risky' ? el('span', { class: `chip chip-xfer-${tier}`, text: transferChipText(worst, tier) }) : null,
      liveBadge(anyLive),
    ]),
  ]);
}

// ── ITINERARY DETAIL ──
function openItineraryDetail(it) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
    el('span', { class: 'muted', text: ` · ${durationText(it.duration)} · ${romeDay(it.startTime)}` }),
  ]));

  // Sum-total row (§4.6): only when EVERY paid transit leg has an exact fare;
  // a booking/counter leg is unknowable, so we never sum it. Always "≈" since
  // urban 90-min tickets can cover a transfer (an upper bound, not a promise).
  const paidLegs = it.legs.filter((l) => l.mode !== 'WALK' && !isRailReplacement(l));
  const fares = paidLegs.map(legExactFare);
  if (paidLegs.length >= 2 && fares.every((f) => f != null)) {
    body.appendChild(el('div', { class: 'iti-total', text: `≈ ${eur(fares.reduce((a, b) => a + b, 0))} total` }));
  }

  const opsSeen = new Set(); // one ticket block per operator per sheet
  const opCounts = operatorLegCounts(it.legs); // for the urban day-pass hint (§4.5)
  it.legs.forEach((leg, i) => {
    if (leg.mode === 'WALK') {
      body.appendChild(el('div', { class: 'leg leg-walk' }, [
        modeIcon('WALK', 'mode-img mode-img-sm'),
        el('span', { text: ` ${durationText(leg.duration)} walk` }),
        el('span', { class: 'muted', text: leg.to?.name ? ` to ${displayName(leg.to.name)}` : '' }),
      ]));
      return;
    }
    body.appendChild(renderTransitLeg(leg, i, opsSeen, opCounts));
  });
  openSheet(body, { title: 'Trip detail' });
}

// Count transit legs per operator in an itinerary (day-pass hint needs 2+).
function operatorLegCounts(legs) {
  const counts = {};
  for (const l of legs || []) {
    if (l.mode === 'WALK') continue;
    const o = operatorFor(l.agencyName);
    if (o) counts[o.name] = (counts[o.name] || 0) + 1;
  }
  return counts;
}

// SAIS Trasporti has exact per-city-pair fares (harvested costo) — resolve the
// leg's from/to cities to an OD price; null falls back to the generic state.
function legOdFare(leg) {
  if (!leg || !/sais\s*trasporti/i.test(leg.agencyName || '')) return null;
  return saisOdFare(leg.from?.name, leg.to?.name);
}

// A leg's exact fare as a number, or null if it can't be summed (counter/booking/
// unknown). SAIS OD price wins; otherwise an operator flat single.
function legExactFare(leg) {
  const od = legOdFare(leg);
  if (od != null) return od;
  const op = operatorFor(leg.agencyName);
  return op && op.fare && op.fare.kind === 'flat' ? op.fare.single : null;
}

function fareChipEl(op, leg) {
  const od = legOdFare(leg);
  const c = od != null ? { state: 'exact', text: eur(od), sub: null } : fareChip(op);
  if (!c) return null;
  return el('span', { class: `chip fare-chip fare-${c.state}` }, [
    el('span', { text: c.text }),
    c.sub ? el('span', { class: 'fare-sub', text: ` · ${c.sub}` }) : null,
  ]);
}

function renderTransitLeg(leg, idx, opsSeen = new Set(), opCounts = {}) {
  const m = modeMeta(leg.mode);
  const op = operatorFor(leg.agencyName);
  const wrap = el('div', { class: 'leg' });

  const railBus = isRailReplacement(leg);
  wrap.appendChild(el('div', { class: 'leg-head' }, [
    el('span', { class: 'leg-route' }, [
      modeIcon(leg.mode, 'mode-img mode-img-sm'),
      el('span', { text: ` ${railBus ? 'Rail replacement bus' : (leg.displayName || leg.routeShortName || m.label)}` }),
    ]),
    railBus ? el('span', { class: 'badge badge-railbus', text: 'REPLACEMENT' }) : null,
    liveBadge(leg.realTime),
    leg.cancelled ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' }) : null,
    railBus ? null : fareChipEl(op, leg), // rail-replacement rides the train ticket — no separate fare
  ]));
  // R-09: a substitute bus standing in for a train — say so, don't leave it anonymous.
  if (railBus) wrap.appendChild(el('div', { class: 'muted leg-headsign', text: 'Runs in place of the train · same Trenitalia ticket' }));
  if (leg.headsign) wrap.appendChild(el('div', { class: 'muted leg-headsign', text: `→ ${displayName(leg.headsign)}` }));

  wrap.appendChild(el('div', { class: 'leg-stops' }, [
    legEndpointRow(leg.from, leg.from?.departure || leg.startTime, true),
    intermediateBlock(leg),
    legEndpointRow(leg.to, leg.to?.arrival || leg.endTime, false),
  ]));

  if (leg.agencyName) wrap.appendChild(el('div', { class: 'muted leg-agency', text: `Operated by ${op?.name || leg.agencyName}` }));

  // Live Trenitalia status for rail legs, resolved by train number.
  if (isRailMode(leg.mode) && /trenitalia/i.test(leg.agencyName || '')) {
    const trainNr = (leg.tripShortName || leg.displayName || '').replace(/\D/g, '');
    if (trainNr) {
      const slot = el('div', { class: 'leg-live muted', text: 'Checking live status…' });
      wrap.appendChild(slot);
      api.vtLive(trainNr).then(({ data }) => {
        slot.innerHTML = '';
        if (!data.live) { slot.textContent = 'No live data for this train yet.'; return; }
        if (data.cancelled) { slot.appendChild(el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })); return; }
        const d = data.delayMin;
        slot.appendChild(el('span', {
          class: `delay ${d > 4 ? 'delay-bad' : d > 0 ? 'delay-mid' : 'delay-ok'}`,
          text: d === null ? 'live' : d <= 0 ? 'on time' : `+${d} min`,
        }));
        if (data.lastSeenStation) slot.appendChild(el('span', { class: 'muted', text: ` · last seen at ${data.lastSeenStation}` }));
      }).catch(() => { slot.textContent = 'Live status unavailable.'; });
    }
  }

  // Ticketing block — informational only, links out (PRD non-goal: never sell).
  // Shown once per operator per sheet: a Trenitalia train + Trenitalia bus
  // itinerary was repeating the identical block back-to-back.
  if (op && !opsSeen.has(op.name)) {
    opsSeen.add(op.name);
    const kids = [el('div', { class: 'ticket-title', text: `🎫 How to buy — ${op.name}` })];
    // SAIS Trasporti: this leg's exact city-pair fare (harvested), shown before
    // the generic how-to-buy text.
    const od = legOdFare(leg);
    if (od != null) kids.push(el('div', { class: 'fare-line', text: `${eur(od)} · ${displayName(leg.from?.name)} → ${displayName(leg.to?.name)} (buy before boarding)` }));
    // Fare summary (§4.3): exact flats show the number + passes; counter/booking
    // show the honest text. The chip on the leg row carries the headline price.
    const summary = fareSummary(op, opCounts[op.name] || 1);
    if (summary) {
      for (const line of summary.lines) kids.push(el('div', { class: 'fare-line', text: line }));
      if (summary.passHint) kids.push(el('div', { class: 'fare-hint', text: `💡 ${summary.passHint}` }));
    }
    // Purchase instructions collapse by default — the fare is the headline.
    const detail = el('p', { class: 'muted ticket-how', hidden: 'hidden', text: op.howToBuy });
    const toggle = el('button', {
      class: 'stops-toggle', text: 'How to buy ▾',
      onclick: () => { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? 'How to buy ▾' : 'How to buy ▴'; },
    });
    kids.push(toggle, detail);
    // Outbound link, honestly labelled — no buy-button styling (§4.6).
    if (op.website) {
      kids.push(el('a', { class: 'ticket-link', href: op.website, target: '_blank', rel: 'noopener' }, [
        el('span', { text: op.website.replace(/^https?:\/\/(www\.)?/, '') }),
        el('span', { class: 'muted', text: ' ↗ leaves ManGO:IT' }),
      ]));
    }
    wrap.appendChild(el('div', { class: 'ticket-block' }, kids));
  }
  return wrap;
}

function legEndpointRow(place, timeIso, isDep) {
  return el('div', { class: 'stop-row stop-endpoint' }, [
    el('span', { class: 'stop-time', text: romeTime(timeIso) }),
    el('span', { class: 'stop-name', text: displayName(place?.name) || '—' }),
    place?.track ? el('span', { class: 'badge badge-track', text: `bin. ${place.track}` }) : null,
  ]);
}

function intermediateBlock(leg) {
  const stops = leg.intermediateStops || [];
  if (!stops.length) return null;
  const list = el('div', { class: 'stop-list', hidden: 'hidden' });
  for (const s of stops) {
    list.appendChild(el('div', { class: 'stop-row' }, [
      el('span', { class: 'stop-time muted', text: romeTime(s.arrival || s.departure) }),
      el('span', { class: 'stop-name muted', text: displayName(s.name) }),
    ]));
  }
  const word = stops.length === 1 ? 'stop' : 'stops';
  const btn = el('button', {
    class: 'stops-toggle', text: `${stops.length} ${word} ▾`,
    onclick: () => {
      const open = !list.hidden;
      list.hidden = open;
      btn.textContent = `${stops.length} ${word} ${open ? '▾' : '▴'}`;
    },
  });
  return el('div', {}, [btn, list]);
}

// ── RECENTS ──
function renderRecents() {
  const holder = document.getElementById('recents');
  const recents = getRecents();
  holder.innerHTML = '';
  if (!recents.length) return;
  recents.forEach((r, i) => {
    holder.appendChild(el('span', { class: 'chip chip-recent chip-recent-wrap' }, [
      el('button', {
        class: 'chip-recent-go', text: `${shortName(r.from.name)} → ${shortName(r.to.name)}`,
        onclick: () => {
          sel.from = r.from; sel.to = r.to;
          // R-08: every other display sink runs names through displayName();
          // this one refilled the fields in raw ALL-CAPS feed spelling.
          document.getElementById('from-input').value = displayName(r.from.name);
          document.getElementById('to-input').value = displayName(r.to.name);
          syncClears();
          runSearch();
        },
      }),
      el('button', {
        class: 'chip-recent-x', 'aria-label': 'Remove from recents', text: '✕',
        onclick: () => { removeRecent(i); renderRecents(); },
      }),
    ]));
  });
}
function shortName(n) { return displayName((n || '').split('(')[0].trim().slice(0, 18)); }
