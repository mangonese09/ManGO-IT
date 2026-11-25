// ── NEARBY DEPARTURE BOARD ──
// The curb screen: closest stops across all modes, next departures, live
// status where the feed has it. Must be useful in under two seconds — cached
// render first, network refresh after.

import { api } from './api.js';
import { el, modeMeta, modeClass, modeIcon, staleChip } from './ui.js';
import { countdownText, romeTime } from './time.js';
import { displayName, railReplacementLabel } from './names.js';
import { saveDeparture, isSaved, removeSaved, addFavLine, removeFavLine, isFavLine } from './store.js';
import { toast } from './toast.js';

let refreshTimer = null;
let lastPos = null;

export function initBoard() {
  document.getElementById('board-refresh').addEventListener('click', () => loadBoard(true));
  loadBoard();
}

export function setBoardVisible(visible) {
  clearInterval(refreshTimer);
  if (visible) refreshTimer = setInterval(() => loadBoard(), 60000);
}

async function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 60000 },
    );
  });
}

// Only auto-request geolocation when the user already granted it — a
// permission prompt on page load is hostile (and a Lighthouse flag). First
// visit gets a "Show departures near me" button that asks on tap instead.
async function geoGranted() {
  try {
    const st = await navigator.permissions.query({ name: 'geolocation' });
    return st.state === 'granted';
  } catch {
    return true; // Permissions API unavailable → keep the old behavior
  }
}

function renderGeoPrompt(holder) {
  holder.innerHTML = '';
  holder.appendChild(el('div', { class: 'empty-state' }, [
    el('p', { text: 'See departures at stops around you.' }),
    el('button', {
      class: 'btn btn-ghost geo-btn',
      onclick: () => loadBoard(true),
    }, [
      el('img', { src: '/icons/place-pin.png', alt: '' }),
      el('span', { text: ' Show departures near me' }),
    ]),
  ]));
}

export async function loadBoard(manual = false) {
  const holder = document.getElementById('board');
  if (!manual && !(await geoGranted())) {
    if (!document.querySelector('#board .line-row')) renderGeoPrompt(holder);
    return;
  }
  try {
    lastPos = await locate();
  } catch {
    holder.innerHTML = '';
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'Location is off — the nearby board needs it.' }),
      el('p', { class: 'muted', text: 'Use the A→B search above, or allow location and refresh.' }),
    ]));
    return;
  }

  if (!holder.children.length) {
    holder.appendChild(el('div', { class: 'loading', text: 'Finding stops near you…' }));
  }
  loadHubHome(lastPos); // runs beside the stop board; neither waits on the other

  try {
    const { data: stops, stale, fetchedAt } = await api.nearbyStops(lastPos.lat, lastPos.lon);
    const picked = dedupeStops(stops).slice(0, 5);
    const boards = await Promise.all(picked.map(async (s) => {
      try { return { stop: s, res: await api.stoptimes(s.stopId, 6) }; }
      catch { return { stop: s, res: null }; }
    }));
    renderBoard(boards, { stale, fetchedAt });
    if (manual) toast('Board refreshed', 'info');
  } catch {
    if (!document.querySelector('#board .line-row')) {
      holder.innerHTML = '';
      holder.appendChild(el('div', { class: 'empty-state' }, [
        el('p', { text: 'Could not reach the departures service.' }),
        el('p', { class: 'muted', text: 'Will retry automatically every minute.' }),
      ]));
    }
  }
}

// ── NEAREST HUB (1.19.0) ──
// Five curated hubs (two airports, three main stations). Within HUB_R of one,
// Home leads with its board; anywhere else the slot stays hidden and the stop
// board below is the curb screen, as before.
const HUB_R = 1500;
export function nearestHub(hubs, pos, r = HUB_R) {
  let best = null;
  for (const h of hubs || []) {
    const d = metersBetween(pos, h);
    if (d <= r && (!best || d < best.d)) best = { hub: h, d };
  }
  return best;
}
function metersBetween(a, b) {
  const rad = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
async function loadHubHome(pos) {
  const slot = document.getElementById('hub-home');
  if (!slot) return;
  let near = null;
  try {
    // aggregated + a coarse cell: only the hub list is wanted, not the stops
    const { data } = await api.mapStops(pos.lat, pos.lon, HUB_R, true, 5000);
    near = nearestHub(data.hubs, pos);
  } catch {
    return; // keep whatever the slot already shows
  }
  if (!near) { slot.hidden = true; slot.innerHTML = ''; foldNearby(false); return; }
  try {
    const { renderHubPreview } = await import('./saved.js');
    await renderHubPreview(slot, near.hub, near.d);
    // 1.22.0 (re-score P1): standing at the hub, "Nearby departures" listed the same runs again
    // from the same station's stops. Fold it behind one button instead of a second copy.
    foldNearby(near.d <= 300 && !slot.hidden);
  } catch {
    if (!slot.children.length) slot.hidden = true;
  }
}

function foldNearby(on) {
  const view = document.getElementById('view-home');
  if (!view) return;
  view.classList.toggle('nearby-folded', on);
  let btn = document.getElementById('nearby-unfold');
  if (on && !btn) {
    btn = el('button', { id: 'nearby-unfold', class: 'btn btn-ghost btn-small btn-wide', type: 'button', text: 'Other stops nearby ›' });
    btn.addEventListener('click', () => { view.classList.remove('nearby-folded'); btn.remove(); });
    document.getElementById('board')?.before(btn);
  }
  if (!on && btn) btn.remove();
}

// Same station appears once per mode/quay — collapse by parentId, keep closest.
function dedupeStops(stops) {
  const seen = new Map();
  for (const s of stops) {
    const key = s.parentId || s.name.toUpperCase();
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

// Line-first board (audit P2, competitive §6): rows are LINES ranked by
// soonest departure, both directions on one row, hard-truncated at 8 behind
// "Show more" — not a stop-by-stop dump. The stop only matters when you're
// deciding which pole to stand at, so it rides along as secondary text.
function renderBoard(boards, { stale, fetchedAt }) {
  const holder = document.getElementById('board');
  holder.innerHTML = '';
  holder.appendChild(staleChip(fetchedAt, stale));

  const lines = new Map(); // mode|route -> {mode, route, dirs: Map(headsign -> best st + stop)}
  for (const { stop, res } of boards) {
    for (const st of (res?.data?.stopTimes || [])) {
      if (st.cancelled) continue;
      // F-3: nameless Trenitalia BUS = rail-replacement run; name the group
      const routeName = railReplacementLabel(st.mode, `${st.tripId || ''}${st.stopId || ''}`, st.routeShortName) || st.routeShortName;
      const key = `${st.mode}|${routeName || ''}`;
      if (!lines.has(key)) lines.set(key, { mode: st.mode, route: routeName, dirs: new Map() });
      const line = lines.get(key);
      const dir = st.headsign || '';
      const when = new Date(st.departure || st.scheduledDeparture).getTime();
      const cur = line.dirs.get(dir);
      if (!cur || when < cur.when) line.dirs.set(dir, { st, stop, when });
    }
  }
  const ranked = [...lines.values()]
    .map((l) => ({ ...l, soonest: Math.min(...[...l.dirs.values()].map((d) => d.when)) }))
    .sort((a, b) => a.soonest - b.soonest);

  if (!ranked.length) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'No upcoming departures at stops near you.' }),
    ]));
    return;
  }

  const list = el('div', { class: 'line-board' });
  holder.appendChild(list);
  const renderRows = (upto) => {
    for (const line of ranked.slice(list.childElementCount, upto)) list.appendChild(lineRow(line));
  };
  renderRows(8);
  if (ranked.length > 8) {
    holder.appendChild(el('button', {
      class: 'btn btn-ghost btn-small btn-wide', text: `Show ${ranked.length - 8} more lines`,
      onclick: (e) => { renderRows(ranked.length); e.target.remove(); },
    }));
  }
}

function lineRow(line) {
  const m = modeMeta(line.mode);
  // two directions max on the row, soonest first — more is noise
  const dirs = [...line.dirs.entries()].sort((a, b) => a[1].when - b[1].when).slice(0, 2);
  return el('div', { class: 'line-row' }, [
    el('span', { class: `dep-mode line-mode ${modeClass(line.mode, line.route)}` }, [modeIcon(line.mode, 'mode-img', line.route)]),
    el('div', { class: 'line-main' }, [
      el('div', { class: 'line-name' }, [
        el('strong', { text: line.route || m.label }),
      ]),
      ...dirs.map(([headsign, d]) => directionLine(headsign, d)),
    ]),
  ]);
}

// 1.18.7: the ☆ on a bus/tram line saves the LINE at this stop (a Saved
// "Lines" card with its next times) and taps off again; a train is a numbered
// run, so its ☆ pins that one departure, which drops out of Saved once gone.
// Every star is named by what it saves; the row itself opens the stop board.
function directionLine(headsign, { st, stop }) {
  const when = st.departure || st.scheduledDeparture;
  const route = (st.routeShortName || '').trim();
  const dest = headsign ? displayName(headsign) : '';
  const isRail = /RAIL|LONG_DISTANCE|HIGHSPEED/.test(st.mode || '');
  const lineKey = `BUS|${route}|${(st.headsign || '').trim()}`;
  const pinId = `${st.tripId || st.routeShortName}@${st.stopId}@${st.scheduledDeparture}`;
  const canLine = !isRail && route && st.stopId;
  const isOn = () => (canLine ? isFavLine(lineKey) : isSaved(pinId));
  const what = canLine
    ? `line ${route}${dest ? ` to ${dest}` : ''} at ${displayName(stop.name)}`
    : `the ${romeTime(when)} ${route || modeMeta(st.mode).label}${dest ? ` to ${dest}` : ''}`;
  const pinBtn = el('button', { class: 'pin-btn', type: 'button' });
  const paint = () => {
    const on = isOn();
    pinBtn.textContent = on ? '★' : '☆';
    pinBtn.classList.toggle('pinned', on);
    pinBtn.setAttribute('aria-pressed', String(on));
    pinBtn.setAttribute('aria-label', `Save ${what}`);
  };
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    if (isOn()) {
      if (canLine) removeFavLine(lineKey); else removeSaved(pinId);
      toast('Removed from Saved', 'info');
    } else if (canLine) {
      if (!addFavLine({ key: lineKey, mode: 'BUS', iconMode: st.mode, line: route, headsign: (st.headsign || '').trim(), stopId: st.stopId, stopName: stop.name || st.stopName || '' })) return;
      toast('Line saved — Saved tab', 'info');
    } else {
      saveDeparture({
        id: pinId, stopId: st.stopId, stopName: st.stopName, mode: st.mode,
        routeShortName: st.routeShortName, headsign: st.headsign,
        agencyName: st.agencyName, tripId: st.tripId,
        when, realTime: st.realTime,
      });
      toast('Pinned to Saved', 'info');
    }
    paint();
  };
  paint();
  const openBoard = async () => {
    const { openStopSchedule } = await import('./saved.js');
    openStopSchedule({ name: stop.name, stopId: stop.stopId, lat: stop.lat, lon: stop.lon, modes: stop.modes });
  };
  return el('div', { class: 'line-dir' }, [
    el('button', { class: 'line-headsign muted row-hit', type: 'button', onclick: openBoard,
      'aria-label': `${route || modeMeta(st.mode).label}${dest ? ` to ${dest}` : ''}, ${romeTime(when)} from ${displayName(stop.name)}. Open stop board`,
      text: dest ? `→ ${dest}` : '→ …' }),
    el('span', { class: 'line-stop muted', text: `${displayName(stop.name)} · ${stop.dist} m` }),
    el('div', { class: 'dep-when' }, [
      el('span', { class: `dep-count${st.realTime ? ' is-live' : ''}`, text: countdownText(st.departure || st.scheduledDeparture) }),
      el('span', { class: 'dep-clock muted', text: romeTime(st.departure || st.scheduledDeparture) }),
    ]),
    pinBtn,
  ]);
}

export function getLastPos() { return lastPos; }
