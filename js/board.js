// ── NEARBY DEPARTURE BOARD ──
// The curb screen: closest stops across all modes, next departures, live
// status where the feed has it. Must be useful in under two seconds — cached
// render first, network refresh after.

import { api } from './api.js';
import { el, modeMeta, staleChip } from './ui.js';
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
      try { return { stop: s, res: await api.stoptimes(s.stopId, 4) }; }
      catch { return { stop: s, res: null }; }
    }));
    renderBoard(boards, { stale, fetchedAt });
    if (manual) toast('Board refreshed', 'info', 1200);
  } catch {
    if (!document.querySelector('#board .stop-section')) {
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

function renderBoard(boards, { stale, fetchedAt }) {
  const holder = document.getElementById('board');
  holder.innerHTML = '';
  holder.appendChild(staleChip(fetchedAt, stale));

  let any = false;
  for (const { stop, res } of boards) {
    const rows = (res?.data?.stopTimes || []).filter((st) => !st.cancelled);
    if (!rows.length) continue;
    any = true;
    const section = el('div', { class: 'stop-section' });
    section.appendChild(el('div', { class: 'stop-section-head' }, [
      el('strong', { text: stop.name }),
      el('span', { class: 'muted', text: ` ${stop.dist} m` }),
    ]));
    for (const st of rows) section.appendChild(departureRow(st));
    holder.appendChild(section);
  }
  if (!any) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'No upcoming departures at stops near you.' }),
    ]));
  }
}

function departureRow(st) {
  const m = modeMeta(st.mode);
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

  return el('div', { class: 'dep-row' }, [
    el('span', { class: 'dep-mode', text: m.icon }),
    el('div', { class: 'dep-main' }, [
      el('span', { class: 'dep-route', text: st.routeShortName || m.label }),
      el('span', { class: 'dep-headsign muted', text: st.headsign ? `→ ${st.headsign}` : '' }),
    ]),
    el('div', { class: 'dep-when' }, [
      el('span', { class: `dep-count${st.realTime ? ' is-live' : ''}`, text: countdownText(st.departure || st.scheduledDeparture) }),
      el('span', { class: 'dep-clock muted', text: romeTime(st.departure || st.scheduledDeparture) }),
    ]),
    pinBtn,
  ]);
}

export function getLastPos() { return lastPos; }
