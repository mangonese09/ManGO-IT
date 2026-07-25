// ── A→B SEARCH ──
import { api } from './api.js';
import { el, modeMeta, isRailMode, liveBadge, staleChip, openSheet } from './ui.js';
import { romeTime, romeDay, durationText, isOtherRomeDay, romeWallToIso } from './time.js';
import { operatorFor } from './operators.js';
import { getRecents, pushRecent } from './store.js';
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
  renderRecents();
}

function wireEndpoint(which) {
  const input = document.getElementById(`${which}-input`);
  const list = document.getElementById(`${which}-suggest`);
  let timer = null;

  input.addEventListener('input', () => {
    sel[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
    timer = setTimeout(() => suggest(which, q), 300);
  });
  input.addEventListener('focus', () => {
    if (which === 'from' && !input.value.trim()) showMyLocationOption(list, input);
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) { list.hidden = true; }
  });
}

function showMyLocationOption(list, input) {
  list.innerHTML = '';
  list.appendChild(el('button', {
    class: 'suggest-row suggest-loc', text: '📍 My location',
    onclick: () => {
      list.hidden = true;
      input.value = 'My location';
      locate().then((pos) => {
        sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}` };
      }).catch(() => {
        input.value = '';
        toast('Location unavailable — type a place instead', 'warn');
      });
    },
  }));
  list.hidden = false;
}

async function suggest(which, q) {
  const list = document.getElementById(`${which}-suggest`);
  try {
    const { data } = await api.geocode(q);
    list.innerHTML = '';
    const results = [...data].sort((a, b) => (a.type === 'STOP' ? -1 : 1) - (b.type === 'STOP' ? -1 : 1));
    for (const r of results.slice(0, 8)) {
      const icon = r.type === 'STOP' ? (r.modes.some(isRailMode) ? '🚉' : '🚏') : '📌';
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          sel[which] = { name: r.name, place: r.type === 'STOP' ? r.id : `${r.lat},${r.lon}` };
          document.getElementById(`${which}-input`).value = r.name;
          list.hidden = true;
        },
      }, [
        el('span', { class: 'suggest-icon', text: icon }),
        el('span', { class: 'suggest-name', text: r.name }),
        r.area ? el('span', { class: 'suggest-area', text: r.area }) : null,
      ]));
    }
    list.hidden = results.length === 0;
  } catch {
    list.hidden = true;
  }
}

function swapEndpoints() {
  const fi = document.getElementById('from-input');
  const ti = document.getElementById('to-input');
  [fi.value, ti.value] = [ti.value, fi.value];
  [sel.from, sel.to] = [sel.to, sel.from];
}

function toggleWhen() {
  departMode = departMode === 'depart' ? 'arrive' : 'depart';
  document.getElementById('when-toggle').textContent = departMode === 'depart' ? 'Depart' : 'Arrive by';
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

async function runSearch() {
  const results = document.getElementById('results');
  if (!sel.from || !sel.to) {
    toast('Pick both places from the suggestions', 'warn');
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

  try {
    const { data, stale, fetchedAt } = await api.plan(params);
    pushRecent({ from: sel.from, to: sel.to });
    renderRecents();
    renderItineraries(data.itineraries || [], { stale, fetchedAt });
  } catch (err) {
    results.innerHTML = '';
    results.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'No route found — the routing service may be unreachable.' }),
      el('p', { class: 'muted', text: 'Check the operator sites directly, or retry when back online.' }),
    ]));
  }
}

function renderItineraries(itineraries, { stale, fetchedAt }) {
  const results = document.getElementById('results');
  results.innerHTML = '';
  results.appendChild(staleChip(fetchedAt, stale));

  if (!itineraries.length) {
    results.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'No route found for that trip.' }),
      el('p', { class: 'muted', text: 'Sicilian coach coverage grows as the ManGO:IT feed lands (M4). Try rail hubs, or check operator sites.' }),
    ]));
    return;
  }

  for (const it of itineraries) {
    const transitLegs = it.legs.filter((l) => l.mode !== 'WALK');
    const chips = el('div', { class: 'iti-chips' });
    for (const leg of transitLegs.length ? transitLegs : it.legs) {
      const m = modeMeta(leg.mode);
      chips.appendChild(el('span', { class: 'chip', text: `${m.icon} ${leg.routeShortName || leg.displayName || m.label}` }));
    }
    const anyStatic = transitLegs.some((l) => !l.realTime);
    const card = el('button', { class: 'card iti-card', onclick: () => openItineraryDetail(it) }, [
      el('div', { class: 'iti-times' }, [
        el('span', { class: 'iti-time', text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
        el('span', { class: 'iti-dur', text: durationText(it.duration) }),
      ]),
      isOtherRomeDay(it.startTime) ? el('div', { class: 'iti-day muted', text: romeDay(it.startTime) }) : null,
      chips,
      el('div', { class: 'iti-meta' }, [
        el('span', { class: 'muted', text: it.transfers === 0 ? 'direct' : `${it.transfers} transfer${it.transfers > 1 ? 's' : ''}` }),
        anyStatic ? el('span', { class: 'badge badge-sched', text: 'some legs schedule-only' }) : el('span', { class: 'badge badge-live', text: 'live data' }),
      ]),
    ]);
    results.appendChild(card);
  }
}

// ── ITINERARY DETAIL ──
function openItineraryDetail(it) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
    el('span', { class: 'muted', text: ` · ${durationText(it.duration)} · ${romeDay(it.startTime)}` }),
  ]));

  it.legs.forEach((leg, i) => {
    if (leg.mode === 'WALK') {
      body.appendChild(el('div', { class: 'leg leg-walk' }, [
        el('span', { text: `🚶 ${durationText(leg.duration)} walk` }),
        el('span', { class: 'muted', text: leg.to?.name ? ` to ${leg.to.name}` : '' }),
      ]));
      return;
    }
    body.appendChild(renderTransitLeg(leg, i));
  });
  openSheet(body, { title: 'Trip detail' });
}

function renderTransitLeg(leg, idx) {
  const m = modeMeta(leg.mode);
  const op = operatorFor(leg.agencyName);
  const wrap = el('div', { class: 'leg' });

  wrap.appendChild(el('div', { class: 'leg-head' }, [
    el('span', { class: 'leg-route', text: `${m.icon} ${leg.displayName || leg.routeShortName || m.label}` }),
    liveBadge(leg.realTime),
    leg.cancelled ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' }) : null,
  ]));
  if (leg.headsign) wrap.appendChild(el('div', { class: 'muted leg-headsign', text: `→ ${leg.headsign}` }));

  wrap.appendChild(el('div', { class: 'leg-stops' }, [
    legEndpointRow(leg.from, leg.from?.departure || leg.startTime, true),
    intermediateBlock(leg),
    legEndpointRow(leg.to, leg.to?.arrival || leg.endTime, false),
  ]));

  if (leg.agencyName) wrap.appendChild(el('div', { class: 'muted leg-agency', text: `Operated by ${leg.agencyName}` }));

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
  if (op) {
    wrap.appendChild(el('div', { class: 'ticket-block' }, [
      el('div', { class: 'ticket-title', text: `🎫 Tickets — ${op.name}` }),
      el('p', { class: 'muted', text: op.howToBuy }),
      el('a', { class: 'ticket-link', href: op.website, target: '_blank', rel: 'noopener', text: op.website.replace('https://', '') }),
    ]));
  }
  return wrap;
}

function legEndpointRow(place, timeIso, isDep) {
  return el('div', { class: 'stop-row stop-endpoint' }, [
    el('span', { class: 'stop-time', text: romeTime(timeIso) }),
    el('span', { class: 'stop-name', text: place?.name || '—' }),
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
      el('span', { class: 'stop-name muted', text: s.name }),
    ]));
  }
  const btn = el('button', {
    class: 'stops-toggle', text: `${stops.length} stops ▾`,
    onclick: () => {
      const open = !list.hidden;
      list.hidden = open;
      btn.textContent = `${stops.length} stops ${open ? '▾' : '▴'}`;
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
  for (const r of recents) {
    holder.appendChild(el('button', {
      class: 'chip chip-recent', text: `${shortName(r.from.name)} → ${shortName(r.to.name)}`,
      onclick: () => {
        sel.from = r.from; sel.to = r.to;
        document.getElementById('from-input').value = r.from.name;
        document.getElementById('to-input').value = r.to.name;
        runSearch();
      },
    }));
  }
}
function shortName(n) { return (n || '').split('(')[0].trim().slice(0, 18); }
