// ── SAVED (favorite stops + pinned departures) ──
import { api } from './api.js';
import { el, modeMeta, modeIcon, confirmModal, openSheet, closeSheet, placeIcon, placeIconKey, PLACE_ICONS } from './ui.js';
import { romeTime, romeDay, countdownText, isOtherRomeDay, romeWallToIso } from './time.js';
import { getSaved, purgeSaved, removeSaved, getFavStops, addFavStop, removeFavStop, isFavStop, getPlacesSorted, addPlace, removePlace, setHomePlace, setPlaceIcon } from './store.js';
import { toast } from './toast.js';
import { displayName } from './names.js';

// ── favorite-stop search: any stop kind (city bus / coach / train) ──
let favWired = false;
let favTimer = null;
let favSeq = 0;

function wireFavSearch() {
  if (favWired) return;
  favWired = true;
  const input = document.getElementById('fav-input');
  const list = document.getElementById('fav-suggest');
  input.addEventListener('input', () => {
    clearTimeout(favTimer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    favTimer = setTimeout(() => favSuggest(q), 300);
  });
}

async function favSuggest(q) {
  const list = document.getElementById('fav-suggest');
  const seq = ++favSeq;
  try {
    const { data } = await api.geocode(q);
    if (seq !== favSeq) return;
    list.innerHTML = '';
    // stops only — this box adds departure boards, not places
    const stops = data.filter((r) => r.type === 'STOP' || r.type === 'COACH_STOP').slice(0, 8);
    for (const r of stops) {
      let iconMode = 'BUS', kind = 'city bus stop';
      const m = r.modes || [];
      if (r.type === 'COACH_STOP') { iconMode = 'COACH'; kind = 'coach stop'; }
      else if (m.some((x) => /RAIL|LONG_DISTANCE/.test(x || ''))) { iconMode = 'RAIL'; kind = 'train station'; }
      else if (m.some((x) => /METRO|SUBWAY/.test(x || ''))) { iconMode = 'METRO'; kind = 'metro station'; }
      else if (m.some((x) => /TRAM/.test(x || ''))) { iconMode = 'TRAM'; kind = 'tram stop'; }
      const bits = [kind];
      if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(displayName(r.town));
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          const key = r.type === 'STOP' && r.id ? r.id : `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
          addFavStop({ key, name: r.name, kind, iconMode, stopId: r.type === 'STOP' ? r.id : null, lat: r.lat, lon: r.lon });
          document.getElementById('fav-input').value = '';
          list.hidden = true;
          toast(`${displayName(r.name)} added`, 'info', 1400);
          renderSaved();
        },
      }, [
        el('span', { class: 'suggest-icon' }, [modeIcon(iconMode)]),
        el('span', { class: 'suggest-name', text: displayName(r.name) }),
        el('span', { class: 'suggest-area', text: bits.join(' · ') }),
      ]));
    }
    list.hidden = stops.length === 0;
  } catch {
    list.hidden = true;
  }
}


// route + optional headsign — never a dangling "BUS →" when the feed has no
// destination for the run
function routeLabel(route, headsign) {
  return headsign ? `${route} → ${headsign}` : route;
}

// A clean "line → destination" label for a live-network departure. Drops junk
// where the route name is just the mode word — Trenitalia's rail-replacement
// buses arrive as a nameless "BUS", which used to render "BUS BUS". Now a
// station board reads "Bus" or "R → Palermo Centrale", never "BUS BUS".
function transitLabel(st) {
  const rn = (st.routeShortName || '').trim();
  const head = displayName((st.headsign || '').trim());
  const modeName = modeMeta(st.mode).label;
  const route = rn && rn.toUpperCase() !== (st.mode || '').toUpperCase() && rn.toLowerCase() !== modeName.toLowerCase() ? rn : '';
  if (route && head) return `${route} → ${head}`;
  if (head) return `${modeName} → ${head}`;
  return route || modeName;
}

// ── FULL DAY SCHEDULE ──
// Tapping a favorite stop opens every remaining + past departure for today:
// own-feed coach stops get the complete timetable; Transitous stops get the
// next 40 departures the network knows. Exported: the Map tab opens the same
// sheet for any nearby stop.
const isRailStop = (s) => s.stopId && /otherTRENITALIA/i.test(s.stopId);

// The Rome calendar date string (YYYY-MM-DD) for a Date. Chips are just
// Today · Tomorrow — any other day comes via the 📅 date picker (each chip is
// a CONCRETE Rome date so feriale/festivo/scolastico calendars resolve
// honestly; no abstract weekday/weekend categories).
const romeDateStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function scheduleDayChips() {
  const now = new Date();
  return [
    { date: null, label: 'Today' },
    { date: romeDateStr(new Date(now.getTime() + 86400000)), label: 'Tomorrow' },
  ];
}

export async function openStopSchedule(s) {
  if (s && (s.kind === 'hub' || s.hubId)) return openHubBoard(s); // a saved hub opens its unified board
  const body = el('div', { class: 'iti-detail sched-sheet' });
  openSheet(body, { title: displayName(s.name) });
  const content = el('div', { class: 'sched-content' });

  // Day chips: the board for a CONCRETE date — weekday/weekend/festive service
  // differences fall out of the real calendars for that day.
  let activeDate = null; // null = today
  const chipRow = el('div', { class: 'hub-chips sched-daychips' });
  const activate = (b) => { for (const x of chipRow.children) x.classList.toggle('is-active', x === b); };
  for (const c of scheduleDayChips()) {
    const b = el('button', {
      class: `chip-btn${c.date === null ? ' is-active' : ''}`, text: c.label,
      onclick: () => { activeDate = c.date; activate(b); load(); },
    });
    chipRow.appendChild(b);
  }
  // Any future date (planning): a 📅 chip fronting a hidden native date input —
  // same pattern as the Home when-picker. The chip label becomes the picked day.
  const dateInput = el('input', { type: 'date', class: 'when-native', 'aria-hidden': 'true', tabindex: '-1' });
  dateInput.min = romeDateStr(new Date());
  const pickLabel = el('span', { text: '' });
  const pickBtn = el('button', {
    class: 'chip-btn sched-pick', 'aria-label': 'Pick a date',
    onclick: () => { try { dateInput.showPicker(); } catch { dateInput.click(); } },
  }, [el('img', { class: 'chip-cal-img', src: '/icons/calendar-mango.svg', alt: '' }), pickLabel]);
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    activeDate = dateInput.value;
    pickLabel.textContent = romeDay(`${dateInput.value}T12:00:00`);
    activate(pickBtn); load();
  });
  chipRow.appendChild(pickBtn);
  chipRow.appendChild(dateInput);
  body.appendChild(chipRow);
  body.appendChild(content);

  async function load() {
    const forDate = activeDate; // capture; a stale response must not clobber a newer chip
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'loading', text: 'Loading schedule…' }));
    try {
      // Rail stations TODAY: the live ViaggiaTreno board (train #, delay,
      // platform). Other days (and VT-down) → the network schedule below.
      if (!forDate && isRailStop(s)) {
        let board = null;
        try { ({ data: board } = await api.vtBoard(s.stopId, s.name)); } catch { /* fall back */ }
        if (forDate !== activeDate) return;
        if (board && (board.departures || []).length) { content.innerHTML = ''; renderVtBoard(content, board.departures); return; }
      }
      let rows = [];
      let note = '';
      if (s.stopId) {
        const timeIso = forDate ? romeWallToIso(`${forDate}T00:00`) : null;
        const { data } = await api.stoptimes(s.stopId, 40, timeIso);
        if (forDate !== activeDate) return;
        rows = (data.stopTimes || []).map((st) => ({
          iso: st.departure || st.scheduledDeparture,
          time: romeTime(st.departure || st.scheduledDeparture),
          mode: st.mode,
          label: transitLabel(st),
          dir: displayName((st.headsign || '').trim()),
          live: st.realTime, cancelled: st.cancelled,
        }));
        // A sparse stop (one train a day) makes "next 40 departures" span
        // WEEKS — date-blind it read as the same train repeated 14×. Drop
        // exact repeats; day handling below.
        const seen = new Set();
        rows = rows.filter((r) => {
          const k = `${r.iso}|${r.label}`;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
        if (forDate) rows = rows.filter((r) => r.iso && romeDateStr(new Date(r.iso)) === forDate);
        note = forDate ? 'Network schedule for that day — no live status.'
          : isRailStop(s)
            ? 'No live train data right now — showing what the network schedule knows.'
            : 'Next departures from the live network.';
      } else {
        const { data } = await api.coachBoard(s.lat, s.lon, 300, true, forDate);
        if (forDate !== activeDate) return;
        rows = (data.results || []).filter((r) => forDate || r.day !== 'tomorrow').map((r) => ({
          time: r.dep, mode: 'COACH',
          label: routeLabel(displayName(r.route), displayName(r.headsign)),
          dir: displayName(r.headsign),
          past: !forDate && r.depMin < romeNowMin(),
        }));
        note = forDate ? 'Complete coach timetable for that day — scheduled times, no live status.'
          : 'Complete coach timetable for today, including already-departed runs (dimmed) — scheduled times, no live status.';
      }
      content.innerHTML = '';
      content.appendChild(el('p', { class: 'muted sched-note', text: note }));
      if (!rows.length) {
        content.appendChild(el('p', { class: 'muted', text: forDate ? 'No departures that day.' : 'No departures today.' }));
        return;
      }
      // Group by direction (headsign): a parent/bidirectional stop returns BOTH
      // ways of a line; interleaved by time it reads as if you could board
      // either here — split into per-direction sections instead.
      const rowEl = (r, short) => el('div', { class: `sched-row${r.past ? ' sched-past' : ''}${r.cancelled ? ' sched-cancelled' : ''}` }, [
        el('strong', { class: 'sched-time', text: r.time }),
        modeIcon(r.mode, 'mode-img mode-img-sm'),
        el('span', { class: 'sched-label', text: short ? r.label.split(' → ')[0] : r.label }),
        r.live ? el('span', { class: 'badge badge-live', text: 'live' }) : null,
        r.cancelled ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' }) : null,
      ]);
      // The selected day renders grouped by direction; on the Today view,
      // departures on LATER days (the whole tail at a one-train-a-day stop)
      // sit under explicit day headers, capped at 10.
      const dayRows = rows.filter((r) => !r.iso || !isOtherRomeDay(r.iso) || forDate);
      const later = forDate ? [] : rows.filter((r) => r.iso && isOtherRomeDay(r.iso)).slice(0, 10);
      const dirs = [];
      for (const r of dayRows) { if (r.dir && !dirs.includes(r.dir)) dirs.push(r.dir); }
      if (dirs.length > 1) {
        for (const d of dirs) {
          content.appendChild(el('div', { class: 'sched-dir', text: `→ ${d}` }));
          for (const r of dayRows.filter((x) => x.dir === d)) content.appendChild(rowEl(r, true));
        }
      } else {
        for (const r of dayRows) content.appendChild(rowEl(r, false));
      }
      if (!dayRows.length && !forDate) content.appendChild(el('p', { class: 'muted', text: 'No more departures today.' }));
      let lastDay = null;
      for (const r of later) {
        const day = romeDay(r.iso);
        if (day !== lastDay) { content.appendChild(el('div', { class: 'sched-dir sched-day', text: day })); lastDay = day; }
        content.appendChild(rowEl(r, false));
      }
    } catch {
      if (forDate !== activeDate) return;
      content.innerHTML = '';
      content.appendChild(el('p', { class: 'muted', text: 'Could not load the schedule — check connectivity and retry.' }));
    }
  }
  load();
}

// ── HUB BOARD ──
// A curated hub (airport / main station) opens ONE unified departures board:
// live rail (ViaggiaTreno) + our coaches + urban buses in radius, merge-sorted
// by /api/hub-board. Mode chips filter Trains vs Buses; the ★ favourites the
// hub like any stop (a saved hub reopens this board, not a stop schedule).
export async function openHubBoard(hub) {
  const favK = `hub:${hub.hubId}`;
  const body = el('div', { class: 'iti-detail sched-sheet hub-sheet' });
  body.appendChild(el('div', { class: 'loading', text: 'Loading departures…' }));
  openSheet(body, { title: displayName(hub.name) });
  let departures = [];
  let hubKind = hub.subkind || null; // 'rail' | 'airport'
  try {
    const { data } = await api.hubBoard(hub.hubId);
    departures = data.departures || [];
    hubKind = data.hub?.kind || hubKind;
  } catch {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted', text: 'Could not load departures — check connectivity and retry.' }));
    return;
  }

  let filter = 'all'; // all | rail | city | coach
  const MODE_OF = { rail: 'RAIL', city: 'BUS', coach: 'COACH' };
  const inFilter = (r) => filter === 'all' || r.mode === MODE_OF[filter];
  const list = el('div', { class: 'hub-rows' });
  function renderRows() {
    list.innerHTML = '';
    const rows = departures.filter(inFilter);
    if (!rows.length) { list.appendChild(el('p', { class: 'muted', text: 'No upcoming departures.' })); return; }
    for (const r of rows) {
      const line = (r.line || '').trim() || modeMeta(r.mode).label;
      const head = displayName((r.headsign || '').trim());
      list.appendChild(el('div', { class: 'sched-row' }, [
        el('strong', { class: 'sched-time', text: romeTime(r.timeISO) }),
        modeIcon(r.mode, 'mode-img mode-img-sm'),
        el('span', { class: 'sched-label', text: head ? `${line} → ${head}` : line }),
        r.realtime ? el('span', { class: 'badge badge-live', text: 'live' }) : null,
        el('span', { class: 'dep-count', text: countdownText(r.timeISO) }),
      ]));
    }
  }

  const chip = (key, text) => el('button', {
    class: `chip-btn hub-chip${filter === key ? ' is-active' : ''}`, text,
    onclick: (e) => { filter = key; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('is-active', b === e.currentTarget); renderRows(); },
  });

  const favBtn = el('button', { class: 'chip-btn hub-fav' });
  const paintFav = () => { const on = isFavStop(favK); favBtn.textContent = on ? '★ Saved' : '☆ Save'; favBtn.classList.toggle('pinned', on); };
  favBtn.onclick = () => {
    if (isFavStop(favK)) removeFavStop(favK);
    else addFavStop({ key: favK, hubId: hub.hubId, name: hub.name, kind: 'hub', iconMode: hub.subkind === 'airport' ? 'BUS' : 'RAIL', stopId: null, lat: hub.lat, lon: hub.lon });
    paintFav();
  };
  paintFav();

  // Offer the mode chips this hub can have: a RAIL hub always gets the Trains
  // chip (even late at night when no train rows are up — the filter shouldn't
  // come and go with the timetable); airports get it only when trains actually
  // appear. City/Coaches chips follow what the board currently carries.
  const present = new Set(departures.map((r) => r.mode));
  const chipDefs = [['all', 'All']];
  if (hubKind === 'rail' || present.has('RAIL')) chipDefs.push(['rail', 'Trains']);
  if (present.has('BUS')) chipDefs.push(['city', 'City']);
  if (present.has('COACH')) chipDefs.push(['coach', 'Coaches']);
  const chipRow = chipDefs.length > 2 ? el('div', { class: 'hub-chips' }, chipDefs.map(([k, t]) => chip(k, t))) : null;

  body.innerHTML = '';
  body.appendChild(el('div', { class: 'hub-toolbar' }, [chipRow, favBtn]));
  body.appendChild(list);
  renderRows();
}

// Delay → { text, cls }. Positive = late (amber), negative = early, 0 = on time.
function vtDelay(d) {
  if (d.delayMin == null) return { text: '', cls: '' };
  if (d.delayMin > 0) return { text: `+${d.delayMin}′`, cls: 'vt-late' };
  if (d.delayMin < 0) return { text: `${d.delayMin}′`, cls: 'vt-early' };
  return { text: 'on time', cls: 'vt-ontime' };
}

function renderVtBoard(body, deps) {
  body.innerHTML = '';
  body.appendChild(el('p', { class: 'muted sched-note' }, [
    el('span', { class: 'pulse-dot vt-livedot', 'aria-hidden': 'true' }),
    el('span', { text: ' Live departures — Trenitalia (RFI)' }),
  ]));
  for (const d of deps) {
    const delay = vtDelay(d);
    const meta = [`#${d.trainNumber}`, d.platform ? `Bin. ${d.platform}` : null].filter(Boolean).join(' · ');
    body.appendChild(el('div', { class: `sched-row vt-row${d.departed ? ' sched-past' : ''}${d.cancelled ? ' sched-cancelled' : ''}` }, [
      el('strong', { class: 'sched-time', text: d.clock || romeTime(d.scheduledMs) }),
      el('span', { class: 'vt-cat', text: d.category || 'Train' }),
      el('div', { class: 'vt-main' }, [
        el('span', { class: 'vt-dest', text: `→ ${displayName(d.destination) || d.label}` }),
        el('span', { class: 'vt-meta muted', text: meta }),
      ]),
      d.cancelled
        ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })
        : (delay.text ? el('span', { class: `vt-delay ${delay.cls}`, text: delay.text }) : null),
    ]));
  }
}

function romeNowMin() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = p.split(':').map(Number);
  return h * 60 + m;
}

async function favStopCard(s) {
  const card = el('div', { class: 'card fav-stop-card' }, [
    el('div', { class: 'fav-stop-head fav-stop-tap', role: 'button', tabindex: '0', onclick: () => openStopSchedule(s) }, [
      el('span', { class: 'suggest-icon' }, [modeIcon(s.iconMode || (s.icon === '🚌' ? 'COACH' : 'BUS'))]),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: displayName(s.name) }),
        el('span', { class: 'muted dep-headsign', text: `${s.kind} · tap for today's schedule` }),
      ]),
      el('button', {
        class: 'pin-btn pinned', text: '★', 'aria-label': 'Remove from favorites',
        onclick: async (e) => {
          // the ★ lives inside the tappable card head — without this, one tap
          // opened the remove modal AND the schedule sheet stacked on top
          e.stopPropagation();
          const ok = await confirmModal(`Remove ${displayName(s.name)} from favorites?`, { confirmText: 'Remove' });
          if (ok) { removeFavStop(s.key); renderSaved(); }
        },
      }),
    ]),
  ]);
  const rows = el('div', { class: 'fav-stop-rows', text: '…' });
  card.appendChild(rows);
  try {
    let deps = [];
    if (s.kind === 'hub' && s.hubId) {
      const { data } = await api.hubBoard(s.hubId);
      deps = (data.departures || []).map((r) => ({
        label: r.headsign ? `${(r.line || '').trim() || r.mode} → ${displayName(r.headsign)}` : (r.line || r.mode),
        iconMode: r.mode, when: r.timeISO, live: r.realtime,
      }));
    } else if (s.stopId) {
      const { data } = await api.stoptimes(s.stopId, 4);
      deps = (data.stopTimes || []).map((st) => ({
        label: transitLabel(st),
        iconMode: st.mode,
        when: st.departure, live: st.realTime, cancelled: st.cancelled,
      }));
    } else {
      const { data } = await api.coachBoard(s.lat, s.lon);
      deps = (data.results || []).map((r) => ({
        label: routeLabel(displayName(r.route), displayName(r.headsign)), iconMode: 'COACH',
        clock: r.dep + (r.day === 'tomorrow' ? ' (tomorrow)' : ''),
      }));
    }
    rows.innerHTML = '';
    if (!deps.length) rows.appendChild(el('p', { class: 'muted', text: 'No upcoming departures.' }));
    for (const d of deps.slice(0, 4)) {
      rows.appendChild(el('div', { class: 'dep-row' }, [
        el('span', { class: 'dep-mode' }, [modeIcon(d.iconMode || 'BUS')]),
        el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: d.label })]),
        el('div', { class: 'dep-when' }, [
          d.cancelled
            ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })
            : el('span', { class: `dep-count${d.live ? ' is-live' : ''}`, text: d.when ? countdownText(d.when) : d.clock }),
          d.when ? el('span', { class: 'dep-clock muted', text: romeTime(d.when) }) : null,
        ]),
      ]));
    }
  } catch {
    rows.textContent = '';
    rows.appendChild(el('p', { class: 'muted', text: 'Departures unavailable right now.' }));
  }
  return card;
}

// ── FAVOURITE PLACES (trip endpoints) ──
let placeWired = false, placeTimer = null, placeSeq = 0;
function wirePlaceSearch() {
  if (placeWired) return;
  placeWired = true;
  const input = document.getElementById('place-input');
  const list = document.getElementById('place-suggest');
  input.addEventListener('input', () => {
    clearTimeout(placeTimer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    placeTimer = setTimeout(() => placeSuggest(q), 300);
  });
}
async function placeSuggest(q) {
  const list = document.getElementById('place-suggest');
  const seq = ++placeSeq;
  try {
    const { data } = await api.geocode(q);
    if (seq !== placeSeq) return;
    list.innerHTML = '';
    const rows = (data || []).filter((r) => isFinite(r.lat) && isFinite(r.lon)).slice(0, 12);
    for (const r of rows) {
      const bits = [];
      if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(displayName(r.town));
      if (r.province && r.province !== r.town) bits.push(`prov. ${r.province}`);
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
          addPlace({ key, label: displayName(r.name), name: r.name, lat: r.lat, lon: r.lon });
          document.getElementById('place-input').value = '';
          list.hidden = true;
          toast(`${displayName(r.name)} added`, 'info', 1400);
          renderSaved();
        },
      }, [
        el('span', { class: 'suggest-icon' }, [placeIcon('pin')]),
        el('span', { class: 'suggest-name', text: displayName(r.name) }),
        bits.length ? el('span', { class: 'suggest-area', text: bits.join(' · ') }) : null,
      ]));
    }
    list.hidden = rows.length === 0;
  } catch { list.hidden = true; }
}
// Icon picker: tap a place's icon → a sheet of the mango icon set. Picking one
// persists it (setPlaceIcon) and re-renders. Home stays a separate toggle.
function openIconPicker(p) {
  const grid = el('div', { class: 'icon-picker-grid' });
  for (const opt of PLACE_ICONS) {
    const active = placeIconKey(p) === opt.key;
    grid.appendChild(el('button', {
      class: `icon-picker-cell${active ? ' active' : ''}`,
      'aria-label': opt.label, 'aria-pressed': String(active),
      onclick: () => {
        // Choosing "Home" IS the home designation (exclusive) — there's no
        // separate toggle any more. Any other icon un-homes a former home place.
        if (opt.key === 'home') { setPlaceIcon(p.key, 'home'); setHomePlace(p.key); }
        else { setPlaceIcon(p.key, opt.key); if (p.home) setHomePlace(null); }
        closeSheet(); renderSaved();
      },
    }, [
      placeIcon(opt.key, 'place-icon-img place-icon-lg'),
      el('span', { class: 'icon-picker-label', text: opt.label }),
    ]));
  }
  openSheet(el('div', { class: 'icon-picker' }, [grid]), { title: `Icon for ${displayName(p.name)}` });
}

function placeCard(p) {
  return el('div', { class: 'card fav-place-card' }, [
    el('div', { class: 'fav-stop-head' }, [
      el('button', {
        class: 'place-icon-btn', 'aria-label': 'Change icon', title: 'Change icon',
        onclick: () => openIconPicker(p),
      }, [placeIcon(placeIconKey(p))]),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: p.label || displayName(p.name) }),
        el('span', { class: 'muted dep-headsign', text: p.home ? 'Home' : 'saved place' }),
      ]),
      el('button', {
        class: 'pin-btn pinned', text: '✕', 'aria-label': 'Remove place',
        onclick: async () => {
          const ok = await confirmModal(`Remove ${displayName(p.name)}?`, { confirmText: 'Remove' });
          if (ok) { removePlace(p.key); renderSaved(); }
        },
      }),
    ]),
  ]);
}

export async function renderSaved() {
  wirePlaceSearch();
  const placeHolder = document.getElementById('fav-places');
  placeHolder.innerHTML = '';
  const places = getPlacesSorted();
  for (const p of places) placeHolder.appendChild(placeCard(p));
  if (!places.length) placeHolder.appendChild(el('p', { class: 'muted place-empty', text: 'No places yet — add Home or a town above for one-tap routing.' }));

  wireFavSearch();
  const favHolder = document.getElementById('fav-stops');
  favHolder.innerHTML = '';
  const favs = getFavStops();
  for (const s of favs) favHolder.appendChild(await favStopCard(s));

  const holder = document.getElementById('saved-list');
  const items = purgeSaved();
  holder.innerHTML = '';

  if (!items.length) {
    if (!favs.length) holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'Nothing pinned yet.' }),
      el('p', { class: 'muted', text: 'Search above to add a stop, or tap ☆ on any departure on the Home board.' }),
    ]));
    return;
  }

  // Refresh live status per unique stop, then re-match by tripId.
  const stopIds = [...new Set(items.map((d) => d.stopId).filter(Boolean))];
  const fresh = new Map();
  await Promise.all(stopIds.map(async (sid) => {
    try {
      const { data } = await api.stoptimes(sid, 15);
      for (const st of data.stopTimes || []) if (st.tripId) fresh.set(`${st.tripId}@${sid}`, st);
    } catch { /* stale times still render below */ }
  }));

  // pinned rows get the same card surface as the favorite stops above them
  const pinnedCard = el('div', { class: 'card saved-pinned-card' }, [
    el('div', { class: 'muted dep-headsign', text: 'Pinned departures' }),
  ]);
  holder.appendChild(pinnedCard);

  for (const d of items.sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))) {
    const updated = d.tripId ? fresh.get(`${d.tripId}@${d.stopId}`) : null;
    const when = updated?.departure || d.when;
    const cancelled = updated?.cancelled;
    const m = modeMeta(d.mode);
    pinnedCard.appendChild(el('div', { class: 'dep-row saved-row' }, [
      el('span', { class: 'dep-mode' }, [modeIcon(d.mode)]),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: `${d.routeShortName || m.label} ${d.headsign ? '→ ' + displayName(d.headsign) : ''}` }),
        el('span', { class: 'muted dep-headsign', text: `${displayName(d.stopName)}${isOtherRomeDay(when) ? ' · ' + romeDay(when) : ''}` }),
      ]),
      el('div', { class: 'dep-when' }, [
        cancelled
          ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })
          : el('span', { class: `dep-count${updated?.realTime ? ' is-live' : ''}`, text: countdownText(when) }),
        el('span', { class: 'dep-clock muted', text: romeTime(when) }),
      ]),
      el('button', {
        class: 'pin-btn pinned', text: '★',
        onclick: async () => {
          const ok = await confirmModal('Remove this pinned departure?', { confirmText: 'Remove' });
          if (ok) { removeSaved(d.id); renderSaved(); toast('Removed', 'info', 1200); }
        },
      }),
    ]));
  }
}
