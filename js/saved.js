// ── SAVED (favorite stops + pinned departures) ──
import { api } from './api.js';
import { el, modeMeta, modeIcon, confirmModal, openSheet, closeSheet, placeIcon, placeIconKey, PLACE_ICONS, LENS_SVG } from './ui.js';
import { romeTime, romeDay, countdownText, isOtherRomeDay, romeWallToIso, deviceZoneGap } from './time.js';
import { getSaved, purgeSaved, removeSaved, getFavStops, addFavStop, removeFavStop, isFavStop, getPlacesSorted, addPlace, removePlace, setHomePlace, setPlaceIcon } from './store.js';
import { toast } from './toast.js';
import { displayName, railReplacementLabel } from './names.js';
import { classifySuggestion, routeToPlace } from './search.js';

// SV-2/SV-3: the add-search cards collapse behind "+ Add" rows; the Home/Work
// slot rows open the place search with a pending designation that the next
// added place adopts.
let pendingSlot = null;
const PLACE_PH = 'Add a place — home, a town or an address';
function openAddCard(which, placeholder) {
  const card = document.getElementById(which === 'place' ? 'place-search-card' : 'fav-search-card');
  const tog = document.getElementById(which === 'place' ? 'place-add-toggle' : 'fav-add-toggle');
  const input = document.getElementById(which === 'place' ? 'place-input' : 'fav-input');
  if (card) card.hidden = false;
  if (tog) tog.hidden = true;
  if (input) { if (placeholder) input.placeholder = placeholder; input.focus(); }
}
function closeAddCard(which) {
  const card = document.getElementById(which === 'place' ? 'place-search-card' : 'fav-search-card');
  const tog = document.getElementById(which === 'place' ? 'place-add-toggle' : 'fav-add-toggle');
  const input = document.getElementById(which === 'place' ? 'place-input' : 'fav-input');
  if (card) card.hidden = true;
  if (tog) tog.hidden = false;
  if (input) { input.value = ''; input.placeholder = which === 'place' ? PLACE_PH : input.placeholder; }
  pendingSlot = null;
}

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
      // F-8: the ONE shared classifier — this inline copy predated v1.3.0's
      // compound labels, so a starred station complex stored "train station"
      // while every other surface said "train, tram & bus station".
      const { iconEl, kind } = classifySuggestion(r);
      const m = r.modes || [];
      const iconMode = r.type === 'COACH_STOP' ? 'COACH'
        : m.some((x) => /RAIL|LONG_DISTANCE/.test(x || '')) ? 'RAIL'
          : m.some((x) => /METRO|SUBWAY/.test(x || '')) ? 'METRO'
            : m.some((x) => /TRAM/.test(x || '')) ? 'TRAM' : 'BUS';
      const bits = [kind];
      if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(displayName(r.town));
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          const key = r.type === 'STOP' && r.id ? r.id : `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
          addFavStop({ key, name: r.name, kind, iconMode, stopId: r.type === 'STOP' ? r.id : null, lat: r.lat, lon: r.lon });
          closeAddCard('fav');
          list.hidden = true;
          toast(`${displayName(r.name)} added`, 'info', 1400);
          renderSaved();
        },
      }, [
        el('span', { class: 'suggest-icon' }, [iconEl]),
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
  // F-3: a nameless, destination-less Trenitalia BUS is a rail-replacement run
  return railReplacementLabel(st.mode, `${st.tripId || ''}${st.stopId || ''}`, rn) || route || modeName;
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

// ── F-2: LINE-GROUPED BOARDS (2026-08-10 walkthrough) ──
// One row per line+direction with the following runs' clocks stacked — the
// Transit/Citymapper pattern ("N4 → Sarullo · then 04:55 · 05:25") instead of
// one row per departure. Cancelled and live rows stay standalone: their status
// is per-run and must not vanish into a group. Pure — unit-tested.
export function groupRuns(rows, keyOf, isPlain = () => true) {
  const out = [];
  const byKey = new Map();
  for (const r of rows) {
    if (!isPlain(r)) { out.push({ first: r, rest: [] }); continue; }
    const k = keyOf(r);
    const g = byKey.get(k);
    if (g) g.rest.push(r);
    else { const ng = { first: r, rest: [] }; byKey.set(k, ng); out.push(ng); }
  }
  return out;
}
export function thenText(clocks, cap = 3) {
  if (!clocks.length) return '';
  const shown = clocks.slice(0, cap);
  const more = clocks.length - shown.length;
  return `then ${shown.join(' · ')}${more > 0 ? ` +${more} more` : ''}`;
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
  }, [el('img', { class: 'chip-cal-img', src: '/icons/calendar-mango.svg', alt: '', width: '17', height: '17' }), pickLabel]);
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
            : 'Live departures.';
      } else {
        const { data } = await api.coachBoard(s.lat, s.lon, 300, true, forDate);
        if (forDate !== activeDate) return;
        rows = (data.results || []).filter((r) => forDate || r.day !== 'tomorrow').map((r) => ({
          time: r.dep, mode: 'COACH',
          label: routeLabel(displayName(r.route), displayName(r.headsign)),
          dir: displayName(r.headsign),
          past: !forDate && r.depMin < romeNowMin(),
          depMin: r.depMin,
        }));
        note = forDate ? 'Complete coach timetable for that day — scheduled times, no live status.'
          : 'Complete coach timetable for today, including already-departed runs (dimmed) — scheduled times, no live status.';
      }
      content.innerHTML = '';
      // a board of bare clock times is the other place the Rome/device gap reads
      // as a bug — state the zone here too, not only on the Home form
      const gap = deviceZoneGap();
      if (gap) content.appendChild(el('p', { class: 'tz-banner', text: `Italy time — ${gap.text}` }));
      content.appendChild(el('p', { class: 'muted sched-note', text: note }));
      if (!rows.length) {
        content.appendChild(el('p', { class: 'muted', text: forDate ? 'No departures that day.' : 'No departures today.' }));
        return;
      }
      // Group by direction (headsign): a parent/bidirectional stop returns BOTH
      // ways of a line; interleaved by time it reads as if you could board
      // either here — split into per-direction sections instead.
      // Right-aligned countdown on today's upcoming rows — same readout as the
      // hub board, so "how soon" doesn't require clock math against Rome time.
      const rowCountdown = (r) => {
        if (forDate || r.past || r.cancelled) return '';
        if (r.iso) return isOtherRomeDay(r.iso) ? '' : countdownText(r.iso);
        if (r.depMin == null) return '';
        const diff = r.depMin - romeNowMin();
        if (diff < -2) return '';
        if (diff <= 1) return 'now';
        return diff < 60 ? `${diff} min` : `${Math.floor(diff / 60)}h ${diff % 60}m`;
      };
      const rowEl = (r, short) => el('div', { class: `sched-row${r.past ? ' sched-past' : ''}${r.cancelled ? ' sched-cancelled' : ''}` }, [
        el('strong', { class: 'sched-time', text: r.time }),
        modeIcon(r.mode, 'mode-img mode-img-sm'),
        el('span', { class: 'sched-label', text: short ? r.label.split(' → ')[0] : r.label }),
        r.live ? el('span', { class: 'badge badge-live', text: 'live' }) : null,
        r.cancelled ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' }) : null,
        el('span', { class: 'dep-count', text: rowCountdown(r) }),
      ]);
      // The selected day renders grouped by direction. The later-days tail
      // (day-headed rows) exists for SPARSE stops, where "next 40" spans weeks
      // and today alone would read as a dead stop — at a stop with a healthy
      // board it just duplicated the Tomorrow chip, so it only renders when
      // today is thin.
      const dayRows = rows.filter((r) => !r.iso || !isOtherRomeDay(r.iso) || forDate);
      const later = (forDate || dayRows.length >= 5) ? [] : rows.filter((r) => r.iso && isOtherRomeDay(r.iso)).slice(0, 10);
      // F-2: within a direction, one row per line with every run's clock on a
      // wrapped times line (paper-timetable style) — the bold clock and the
      // countdown always describe the NEXT departure, not the first of the day.
      const renderGroup = (g, short) => {
        const runs = [g.first, ...g.rest];
        const nxt = runs.find((x) => !x.past) || g.first;
        const row = rowEl({ ...nxt, past: runs.every((x) => x.past) }, short);
        content.appendChild(row);
        if (runs.length > 1) {
          const wrap = el('div', { class: 'sched-times' });
          for (const x of runs) {
            wrap.appendChild(el('span', {
              class: `sched-t${x.past ? ' sched-past' : ''}${x === nxt ? ' sched-t-next' : ''}`, text: x.time,
            }));
          }
          content.appendChild(wrap);
        }
      };
      const grouped = (list2) => groupRuns(list2, (x) => x.label, (x) => !x.live && !x.cancelled);
      const dirs = [];
      for (const r of dayRows) { if (r.dir && !dirs.includes(r.dir)) dirs.push(r.dir); }
      if (dirs.length > 1) {
        for (const d of dirs) {
          content.appendChild(el('div', { class: 'sched-dir', text: `→ ${d}` }));
          for (const g of grouped(dayRows.filter((x) => x.dir === d))) renderGroup(g, true);
        }
      } else {
        for (const g of grouped(dayRows)) renderGroup(g, false);
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
  const overlay = openSheet(body, { title: displayName(hub.name) });
  // ★ save lives in the sheet HEAD beside ✕ (icon-only) — as a toolbar button
  // it pushed the chip row past 390px and wrapped onto a lonely second line.
  const favBtn = el('button', { class: 'hub-head-btn hub-fav-head', 'aria-label': 'Save this hub' });
  const paintFav = () => { const on = isFavStop(favK); favBtn.textContent = on ? '★' : '☆'; favBtn.classList.toggle('pinned', on); };
  favBtn.onclick = () => {
    if (isFavStop(favK)) removeFavStop(favK);
    else addFavStop({ key: favK, hubId: hub.hubId, name: hub.name, kind: 'hub', iconMode: hub.subkind === 'airport' ? 'BUS' : 'RAIL', stopId: null, lat: hub.lat, lon: hub.lon });
    paintFav();
  };
  paintFav();
  const head = overlay.querySelector('.sheet-head');
  head.insertBefore(favBtn, head.querySelector('.sheet-close'));
  let departures = [];
  try {
    const { data } = await api.hubBoard(hub.hubId);
    departures = data.departures || [];
  } catch {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted', text: 'Could not load departures — check connectivity and retry.' }));
    return;
  }

  // Same filter model as the main map: independent mango-icon toggle chips
  // (all on by default) + the mango search lens filtering by destination text.
  // A typed query searches the WHOLE rest of today (lazy full board fetch with
  // intermediate calls), not just the next-departures window — so "Taormina"
  // matches a Messina-bound REG that calls there, and an evening Agrigento
  // coach matches at lunchtime.
  const fam = { rail: true, city: true, coach: true };
  let query = '';
  let fullRows = null, fullFailed = false, fullPromise = null;
  const loadFull = () => {
    if (fullPromise) return;
    fullPromise = api.hubBoard(hub.hubId, true)
      .then(({ data }) => { fullRows = data.departures || []; })
      .catch(() => { fullFailed = true; })
      .then(() => renderRows());
  };
  const FAM_OF = { RAIL: 'rail', BUS: 'city', COACH: 'coach' };
  // via entries are {n, t} (stop + clock); tolerate plain strings from older
  // cached payloads.
  const viaName = (v) => (v && v.n != null ? v.n : String(v || ''));
  // When a row carries its intermediate calls (via), match direction-accurately
  // on where THIS run actually goes — headsign + calls, not the line name (a
  // "Catania – Taormina – Messina" line name would match its Militello-bound
  // return run too). Rows without via keep line-name matching.
  const hayOf = (r) => (r.via ? `${r.headsign || ''} ${r.stopName || ''} ${r.via.map(viaName).join(' ')}`
    : `${r.line || ''} ${r.headsign || ''} ${r.stopName || ''}`).toLowerCase();
  const viaHit = (r) => (query && (r.via || []).find((v) => viaName(v).toLowerCase().includes(query))) || null;
  const inFilter = (r) => fam[FAM_OF[r.mode] || 'city'] && (!query || hayOf(r).includes(query));
  const list = el('div', { class: 'hub-rows' });
  function renderRows() {
    list.innerHTML = '';
    const searching = query && !fullRows && !fullFailed;
    if (searching) loadFull();
    const rows = (query && fullRows ? fullRows : departures).filter(inFilter);
    if (!rows.length) {
      list.appendChild(el('p', {
        class: 'muted',
        text: searching ? 'Searching all of today…'
          : query ? (fullRows ? 'No departures match today.' : 'No departures match.')
            : 'No upcoming departures.',
      }));
      return;
    }
    const MAX = 60;
    // F-2: one row per line+direction, following runs stacked underneath.
    // Rail rows carry the train number in `line`, so they stay one-per-train.
    const groups = groupRuns(rows,
      (x) => `${x.mode}|${(x.line || '').trim()}|${(x.headsign || '').trim()}`,
      (x) => !x.realtime && !x.cancelled);
    for (const g of groups.slice(0, MAX)) {
      const r = g.first;
      const line = (r.line || '').trim().toUpperCase() === 'BUS' || !(r.line || '').trim()
        ? (railReplacementLabel(r.mode, r.tripId, r.line) || (r.line || '').trim() || modeMeta(r.mode).label)
        : (r.line || '').trim();
      const head = displayName((r.headsign || '').trim());
      const past = typeof r.minutes === 'number' && r.minutes < 0;
      const lbl = el('div', { class: 'sched-label2' }, [
        el('span', { class: 'sl-main', text: head ? `${line} → ${head}` : line }),
      ]);
      if (g.rest.length) {
        lbl.appendChild(el('span', { class: 'sl-via muted', text: thenText(g.rest.map((x) => romeTime(x.timeISO))) }));
      }
      // matched on an intermediate stop: answer "where does it fit for ME" on
      // its OWN line with the arrival clock — appended inline it vanished
      // under the headsign's ellipsis
      const hit = viaHit(r);
      if (hit && !`${r.headsign || ''} ${r.stopName || ''}`.toLowerCase().includes(query)) {
        const t = hit && hit.t ? ` at ${hit.t}` : '';
        lbl.appendChild(el('span', { class: 'sl-via muted', text: `→ reaches ${displayName(viaName(hit))}${t}` }));
      }
      const cells = [
        el('strong', { class: 'sched-time', text: romeTime(r.timeISO) }),
        modeIcon(r.mode, 'mode-img mode-img-sm'),
        lbl,
        r.realtime ? el('span', { class: 'badge badge-live', text: 'live' }) : null,
        el('span', { class: 'dep-count', text: past ? '' : countdownText(r.timeISO) }),
      ];
      // rows tap through: trains → live status + calls + map; coaches → the
      // remaining route with times + map; city buses → network route + map
      const rowCls = `sched-row${past ? ' sched-past' : ''}`;
      let open = null;
      if (r.mode === 'RAIL' && r.trainNumber) open = () => openTrainLive(r, hub);
      else if (r.mode === 'COACH' && Array.isArray(r.via) && r.via.length) open = () => openCoachRoute(r, hub.name);
      else if (r.mode === 'BUS' && r.tripId) open = () => openTripRoute(r);
      if (open) {
        cells.push(el('span', { class: 'dep-chevron', text: '›' }));
        list.appendChild(el('button', { class: `${rowCls} sched-row-btn`, onclick: open }, cells));
      } else {
        list.appendChild(el('div', { class: rowCls }, cells));
      }
    }
    if (groups.length > MAX) list.appendChild(el('p', { class: 'muted', text: `+${groups.length - MAX} more lines later today` }));
    if (searching) list.appendChild(el('p', { class: 'muted', text: 'Searching all of today…' }));
  }

  // Map-style toggle chips (mango icons, .on ring, dim when off). Every hub —
  // airport or station — always gets all three chips, matching the map top-bar;
  // filters shouldn't come and go with the timetable.
  const chipRow = el('div', { class: 'hub-chips' });
  const mkFam = (key, mode, label) => {
    // A family with nothing on the board is greyed out and inert — you can't
    // filter down to a mode that has no departures to show.
    const has = departures.some((r) => (FAM_OF[r.mode] || 'city') === key);
    const b = el('button', {
      class: has ? 'map-chip on' : 'map-chip chip-none',
      onclick: () => { if (!has) return; fam[key] = !fam[key]; b.classList.toggle('on', fam[key]); renderRows(); },
    }, [modeIcon(mode, 'mode-img mode-img-sm'), el('span', { text: label })]);
    if (!has) b.disabled = true;
    return b;
  };
  // mango search lens — filter this board by destination text. The lens lives
  // in the SHEET HEAD beside ★ and ✕ (all three sized alike): it's a sheet
  // action, not a family filter, so it doesn't belong in the chip row.
  const searchInput = el('input', {
    class: 'map-search-input hub-search', type: 'search',
    placeholder: 'Filter by destination…', autocomplete: 'off',
  });
  searchInput.hidden = true;
  searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); renderRows(); });
  const searchBtn = el('button', {
    class: 'hub-head-btn hub-head-lens', 'aria-label': 'Search this board',
    html: LENS_SVG, // plain mango magnifier — the one search glyph app-wide
    onclick: () => {
      searchInput.hidden = !searchInput.hidden;
      if (!searchInput.hidden) searchInput.focus();
      else { searchInput.value = ''; query = ''; renderRows(); }
    },
  });
  head.insertBefore(searchBtn, favBtn);
  chipRow.appendChild(mkFam('rail', 'RAIL', 'Trains'));
  chipRow.appendChild(mkFam('city', 'BUS', 'City'));
  chipRow.appendChild(mkFam('coach', 'COACH', 'Coaches'));

  body.innerHTML = '';
  body.appendChild(el('div', { class: 'hub-toolbar' }, [chipRow]));
  body.appendChild(searchInput);
  body.appendChild(list);
  renderRows();
}

// "View route on map" — jumps to the Map tab and traces the given shape
// (already-normalized {stops, path}) via the shared tracer.
function shapeMapBtn(getShape, originName) {
  return el('button', {
    class: 'chip-btn coach-map-btn', text: '🗺 View route on map',
    onclick: async () => {
      try {
        const shape = await getShape();
        const { showTripShapeOnMap } = await import('./mapview.js');
        closeSheet(); // this sheet
        closeSheet(); // hub board beneath
        showTripShapeOnMap(shape, { name: originName || '' });
      } catch {
        toast('No route map available for this run', 'warn');
      }
    },
  });
}

// City-bus row → its full network route (stops + times) with a map jump.
async function openTripRoute(r) {
  const body = el('div', { class: 'iti-detail sched-sheet' });
  body.appendChild(el('div', { class: 'loading', text: 'Loading route…' }));
  openSheet(body, { title: `${(r.line || '').trim() || 'Route'} → ${displayName((r.headsign || '').trim())}` });
  try {
    const { data: shape } = await api.tripShape(r.tripId);
    body.innerHTML = '';
    body.appendChild(shapeMapBtn(() => shape, r.stopName));
    body.appendChild(el('p', { class: 'muted sched-note', text:
      `${shape.operator ? displayName(shape.operator) + ' · ' : ''}Network schedule.` }));
    routeStopRows(body, shape.stops.map((s2) => ({ n: s2.name, t: s2.t })));
  } catch {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted', text: 'Could not load this route — check connectivity and retry.' }));
  }
}

// Ordered stop list rows shared by the train + coach route sheets.
function routeStopRows(body, stops) {
  for (const s of stops) {
    const n = s && s.n != null ? s.n : String(s || '');
    body.appendChild(el('div', { class: 'sched-row' }, [
      el('strong', { class: 'sched-time', text: (s && s.t) || '' }),
      el('span', { class: 'sched-label', text: displayName(n) }),
    ]));
  }
}

// A coach row's remaining route: every stop from here to the terminus, with
// scheduled times ("where does this coach go" answered in one tap), plus a
// jump to the Map tab's traced line for the same route.
function openCoachRoute(r, hubName) {
  const body = el('div', { class: 'iti-detail sched-sheet' });
  if (r.ci != null || (isFinite(r.sLat) && isFinite(r.sLon))) {
    body.appendChild(el('button', {
      class: 'chip-btn coach-map-btn', text: '🗺 View route on map',
      onclick: async () => {
        const { showCoachRouteOnMap } = await import('./mapview.js');
        closeSheet(); // route sheet
        closeSheet(); // hub board beneath
        showCoachRouteOnMap({ ci: r.ci, lat: r.sLat, lon: r.sLon, routeName: r.line, stopName: r.stopName || hubName });
      },
    }));
  }
  body.appendChild(el('p', { class: 'muted sched-note', text:
    `${r.operator ? displayName(r.operator) + ' · ' : ''}Scheduled times — no live tracking.` }));
  body.appendChild(el('div', { class: 'sched-row' }, [
    el('strong', { class: 'sched-time', text: romeTime(r.timeISO) }),
    el('span', { class: 'sched-label', text: displayName(r.stopName || hubName || 'This stop') }),
  ]));
  routeStopRows(body, r.via || []);
  openSheet(body, { title: displayName((r.line || '').trim() || 'Coach route') });
}

// Live status for one train off a hub board row — delay, last seen, the
// full ordered call list (VT's fermate; falls back to the row's via data),
// and a map jump (trip matched server-side against the network data).
async function openTrainLive(r, hub) {
  const body = el('div', { class: 'iti-detail train-live sched-sheet' });
  body.appendChild(el('div', { class: 'loading', text: 'Checking live status…' }));
  openSheet(body, { title: `${(r.line || '').trim() || 'Train'} → ${displayName((r.headsign || '').trim())}` });
  const viaFallback = (r.via || []).map((v) => (v && v.n != null ? v : { n: String(v || ''), t: null }));
  const mapBtn = hub ? shapeMapBtn(async () => (await api.railShape(hub.hubId, r.trainNumber, r.timeISO)).data, hub.name) : null;
  try {
    const { data } = await api.vtLive(r.trainNumber);
    body.innerHTML = '';
    if (mapBtn) body.appendChild(mapBtn);
    if (!data || !data.live) {
      body.appendChild(el('p', { class: 'muted', text: 'No live data for this train right now — it may not have departed yet.' }));
      if (viaFallback.length) {
        body.appendChild(el('div', { class: 'sched-dir', text: 'Calls at' }));
        routeStopRows(body, viaFallback);
      }
      return;
    }
    if (data.cancelled) body.appendChild(el('p', {}, [el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })]));
    const d = vtDelay(data);
    body.appendChild(el('p', { class: `train-live-delay ${d.cls}`, text:
      data.delayMin == null ? 'No delay reported yet.'
        : data.delayMin > 0 ? `Running ${data.delayMin} min late.`
          : data.delayMin < 0 ? `Running ${-data.delayMin} min early.` : 'On time.' }));
    if (data.lastSeenStation) {
      body.appendChild(el('p', { class: 'muted', text: `Last seen at ${displayName(data.lastSeenStation)}${data.lastSeenAtMs ? ` (${romeTime(data.lastSeenAtMs)})` : ''}.` }));
    }
    if (data.origin || data.destination) {
      body.appendChild(el('p', { class: 'muted', text: `${displayName(data.origin || '?')} → ${displayName(data.destination || '?')} · #${data.trainNumber}` }));
    }
    const stops = (data.stops || []).length ? data.stops : viaFallback;
    if (stops.length) {
      body.appendChild(el('div', { class: 'sched-dir', text: 'Calls at' }));
      routeStopRows(body, stops);
    }
  } catch {
    body.innerHTML = '';
    if (mapBtn) body.appendChild(mapBtn);
    body.appendChild(el('p', { class: 'muted', text: 'Could not reach live tracking — check connectivity and retry.' }));
    if (viaFallback.length) {
      body.appendChild(el('div', { class: 'sched-dir', text: 'Calls at' }));
      routeStopRows(body, viaFallback);
    }
  }
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
      el('span', { class: 'suggest-icon' }, [modeIcon(s.iconMode || 'BUS')]),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: displayName(s.name) }),
        el('span', { class: 'muted dep-headsign', text: s.kind || 'stop' }),
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
      // 10 not 4: grouping by line (below) collapses same-line runs, so a
      // 4-row fetch often filled the card with one line's next four buses
      const { data } = await api.stoptimes(s.stopId, 10);
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
    // F-2: one card row per line+direction, next runs stacked under the clock
    for (const g of groupRuns(deps, (x) => x.label, (x) => !x.live && !x.cancelled).slice(0, 4)) {
      const d = g.first;
      const clocks = g.rest.map((x) => (x.when ? romeTime(x.when) : x.clock)).filter(Boolean);
      rows.appendChild(el('div', { class: 'dep-row' }, [
        el('span', { class: 'dep-mode' }, [modeIcon(d.iconMode || 'BUS')]),
        el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: d.label })]),
        el('div', { class: 'dep-when' }, [
          d.cancelled
            ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })
            : el('span', { class: `dep-count${d.live ? ' is-live' : ''}`, text: d.when ? countdownText(d.when) : d.clock }),
          d.when ? el('span', { class: 'dep-clock muted', text: romeTime(d.when) }) : null,
          clocks.length ? el('span', { class: 'dep-clock muted dep-then', text: thenText(clocks, 2) }) : null,
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
          const slot = pendingSlot; // SV-2/SV-5: a slot-opened add IS the designation
          addPlace({ key, label: displayName(r.name), name: r.name, lat: r.lat, lon: r.lon,
            home: slot === 'home', icon: slot || undefined });
          list.hidden = true;
          closeAddCard('place');
          toast(`${displayName(r.name)} ${slot === 'home' ? 'set as Home' : slot === 'work' ? 'set as Work' : 'added'}`, 'info', 1400);
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
  openSheet(el('div', { class: 'icon-picker' }, [
    // SV-2: the icon-is-the-designation coupling stops being a secret
    el('p', { class: 'muted icon-picker-hint', text: 'Choosing the Home icon makes this your Home place.' }),
    grid,
  ]), { title: `Icon for ${displayName(p.name)}` });
}

function placeCard(p) {
  return el('div', { class: 'card fav-place-card' }, [
    el('div', { class: 'fav-stop-head' }, [
      el('button', {
        class: 'place-icon-btn', 'aria-label': 'Change icon', title: 'Change icon',
        onclick: () => openIconPicker(p),
      }, [placeIcon(placeIconKey(p))]),
      // SV-1: the card's PRIMARY action is GO THERE (Citymapper's one-tap
      // home) — destination-first routing from wherever the user is now.
      el('button', { class: 'dep-main fav-stop-tap place-go', onclick: () => routeToPlace(p) }, [
        el('span', { class: 'dep-route', text: p.label || displayName(p.name) }),
        el('span', { class: 'muted dep-headsign', text: p.home ? 'Home — tap to go' : p.icon === 'work' ? 'Work — tap to go' : 'Tap to go' }),
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
  // SV-3: the add-search cards live behind compact "+ Add" rows
  const pTog = document.getElementById('place-add-toggle');
  if (pTog && !pTog.dataset.wired) {
    pTog.dataset.wired = '1';
    pTog.addEventListener('click', () => { pendingSlot = null; openAddCard('place', PLACE_PH); });
    document.getElementById('fav-add-toggle').addEventListener('click', () => openAddCard('fav'));
  }
  const placeHolder = document.getElementById('fav-places');
  placeHolder.innerHTML = '';
  const places = getPlacesSorted();
  // SV-2/SV-5: Home and Work are permanent labelled SLOTS that ask to be
  // filled (Google/Citymapper convention) — not secrets inside an icon picker.
  const slotRow = (kind, label) => el('button', {
    class: 'card fav-place-card place-slot',
    onclick: () => { pendingSlot = kind; openAddCard('place', kind === 'home' ? 'Where is Home?' : 'Where is Work?'); },
  }, [
    el('span', { class: 'place-icon-btn place-slot-icon' }, [placeIcon(kind)]),
    el('div', { class: 'dep-main' }, [
      el('span', { class: 'dep-route', text: label }),
      el('span', { class: 'muted dep-headsign', text: 'One tap to route there, every day' }),
    ]),
    el('span', { class: 'dep-chevron', text: '›' }),
  ]);
  if (!places.some((p) => p.home)) placeHolder.appendChild(slotRow('home', 'Set Home'));
  if (!places.some((p) => p.icon === 'work')) placeHolder.appendChild(slotRow('work', 'Set Work'));
  for (const p of places) placeHolder.appendChild(placeCard(p));

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
