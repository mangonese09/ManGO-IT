// ── SAVED (favorite stops + pinned departures) ──
import { api } from './api.js';
import { el, modeMeta, confirmModal } from './ui.js';
import { romeTime, romeDay, countdownText, isOtherRomeDay } from './time.js';
import { getSaved, purgeSaved, removeSaved, getFavStops, addFavStop, removeFavStop } from './store.js';
import { toast } from './toast.js';

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
      let icon = '🚏', kind = 'city bus stop';
      const m = r.modes || [];
      if (r.type === 'COACH_STOP') { icon = '🚌'; kind = 'coach stop'; }
      else if (m.some((x) => /RAIL|LONG_DISTANCE/.test(x || ''))) { icon = '🚉'; kind = 'train station'; }
      else if (m.some((x) => /METRO|SUBWAY/.test(x || ''))) { icon = '🚇'; kind = 'metro station'; }
      else if (m.some((x) => /TRAM/.test(x || ''))) { icon = '🚊'; kind = 'tram stop'; }
      const bits = [kind];
      if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(r.town);
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          const key = r.type === 'STOP' && r.id ? r.id : `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
          addFavStop({ key, name: r.name, kind, icon, stopId: r.type === 'STOP' ? r.id : null, lat: r.lat, lon: r.lon });
          document.getElementById('fav-input').value = '';
          list.hidden = true;
          toast(`${r.name} added`, 'info', 1400);
          renderSaved();
        },
      }, [
        el('span', { class: 'suggest-icon', text: icon }),
        el('span', { class: 'suggest-name', text: r.name }),
        el('span', { class: 'suggest-area', text: bits.join(' · ') }),
      ]));
    }
    list.hidden = stops.length === 0;
  } catch {
    list.hidden = true;
  }
}

async function favStopCard(s) {
  const card = el('div', { class: 'card fav-stop-card' }, [
    el('div', { class: 'fav-stop-head' }, [
      el('span', { class: 'suggest-icon', text: s.icon || '🚏' }),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: s.name }),
        el('span', { class: 'muted dep-headsign', text: s.kind }),
      ]),
      el('button', {
        class: 'pin-btn pinned', text: '★',
        onclick: async () => {
          const ok = await confirmModal(`Remove ${s.name} from favorites?`, { confirmText: 'Remove' });
          if (ok) { removeFavStop(s.key); renderSaved(); }
        },
      }),
    ]),
  ]);
  const rows = el('div', { class: 'fav-stop-rows', text: '…' });
  card.appendChild(rows);
  try {
    let deps = [];
    if (s.stopId) {
      const { data } = await api.stoptimes(s.stopId, 4);
      deps = (data.stopTimes || []).map((st) => ({
        label: `${st.routeShortName || modeMeta(st.mode).label} → ${st.headsign || ''}`,
        icon: modeMeta(st.mode).icon,
        when: st.departure, live: st.realTime, cancelled: st.cancelled,
      }));
    } else {
      const { data } = await api.coachBoard(s.lat, s.lon);
      deps = (data.results || []).map((r) => ({
        label: `${r.route} → ${r.headsign}`, icon: '🚌',
        clock: r.dep + (r.day === 'tomorrow' ? ' (tomorrow)' : ''),
      }));
    }
    rows.innerHTML = '';
    if (!deps.length) rows.appendChild(el('p', { class: 'muted', text: 'No upcoming departures.' }));
    for (const d of deps.slice(0, 4)) {
      rows.appendChild(el('div', { class: 'dep-row' }, [
        el('span', { class: 'dep-mode', text: d.icon }),
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

export async function renderSaved() {
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

  for (const d of items.sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))) {
    const updated = d.tripId ? fresh.get(`${d.tripId}@${d.stopId}`) : null;
    const when = updated?.departure || d.when;
    const cancelled = updated?.cancelled;
    const m = modeMeta(d.mode);
    holder.appendChild(el('div', { class: 'dep-row saved-row' }, [
      el('span', { class: 'dep-mode', text: m.icon }),
      el('div', { class: 'dep-main' }, [
        el('span', { class: 'dep-route', text: `${d.routeShortName || m.label} ${d.headsign ? '→ ' + d.headsign : ''}` }),
        el('span', { class: 'muted dep-headsign', text: `${d.stopName}${isOtherRomeDay(when) ? ' · ' + romeDay(when) : ''}` }),
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
