// ── SAVED (pinned departures) ──
import { api } from './api.js';
import { el, modeMeta, confirmModal } from './ui.js';
import { romeTime, romeDay, countdownText, isOtherRomeDay } from './time.js';
import { getSaved, purgeSaved, removeSaved } from './store.js';
import { toast } from './toast.js';

export async function renderSaved() {
  const holder = document.getElementById('saved-list');
  const items = purgeSaved();
  holder.innerHTML = '';

  if (!items.length) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'Nothing pinned yet.' }),
      el('p', { class: 'muted', text: 'Tap ☆ on any departure on the Home board to keep it here.' }),
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

  for (const d of items.sort((a, b) => new Date(a.when) - new Date(b.when))) {
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
