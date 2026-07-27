// ── NEARBY DEPARTURE BOARD ──
// The curb screen: closest stops across all modes, next departures, live
// status where the feed has it. Must be useful in under two seconds — cached
// render first, network refresh after.

import { api } from './api.js';
import { el, modeMeta, modeClass, modeIcon, staleChip } from './ui.js';
import { countdownText, romeTime } from './time.js';
import { saveDeparture, isSaved } from './store.js';
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

export async function loadBoard(manual = false) {
  const holder = document.getElementById('board');
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

  try {
    const { data: stops, stale, fetchedAt } = await api.nearbyStops(lastPos.lat, lastPos.lon);
    const picked = dedupeStops(stops).slice(0, 5);
    const boards = await Promise.all(picked.map(async (s) => {
      try { return { stop: s, res: await api.stoptimes(s.stopId, 6) }; }
      catch { return { stop: s, res: null }; }
    }));
    renderBoard(boards, { stale, fetchedAt });
    if (manual) toast('Board refreshed', 'info', 1200);
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
      const key = `${st.mode}|${st.routeShortName || ''}`;
      if (!lines.has(key)) lines.set(key, { mode: st.mode, route: st.routeShortName, dirs: new Map() });
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
    el('span', { class: `dep-mode line-mode ${modeClass(line.mode)}` }, [modeIcon(line.mode)]),
    el('div', { class: 'line-main' }, [
      el('div', { class: 'line-name' }, [
        el('strong', { text: line.route || m.label }),
      ]),
      ...dirs.map(([headsign, d]) => directionLine(headsign, d)),
    ]),
  ]);
}

function directionLine(headsign, { st, stop }) {
  const id = `${st.tripId || st.routeShortName}@${st.stopId}@${st.scheduledDeparture}`;
  const pinBtn = el('button', {
    class: `pin-btn${isSaved(id) ? ' pinned' : ''}`,
    text: isSaved(id) ? '★' : '☆',
    onclick: (e) => {
      e.stopPropagation();
      const ok = saveDeparture({
        id, stopId: st.stopId, stopName: st.stopName, mode: st.mode,
        routeShortName: st.routeShortName, headsign: st.headsign,
        agencyName: st.agencyName, tripId: st.tripId,
        when: st.departure || st.scheduledDeparture, realTime: st.realTime,
      });
      if (ok) { pinBtn.textContent = '★'; pinBtn.classList.add('pinned'); toast('Pinned to Saved', 'info', 1500); }
    },
  });
  return el('div', { class: 'line-dir' }, [
    el('span', { class: 'line-headsign muted', text: headsign ? `→ ${headsign}` : '→ …' }),
    el('span', { class: 'line-stop muted', text: `${stop.name} · ${stop.dist} m` }),
    el('div', { class: 'dep-when' }, [
      el('span', { class: `dep-count${st.realTime ? ' is-live' : ''}`, text: countdownText(st.departure || st.scheduledDeparture) }),
      el('span', { class: 'dep-clock muted', text: romeTime(st.departure || st.scheduledDeparture) }),
    ]),
    pinBtn,
  ]);
}

export function getLastPos() { return lastPos; }
