// ── MAP TAB (M6 placeholder) ──
// The real map ships in M6. Until then: nearest stops as a list, mode-tagged,
// each row opening the same "Today — <stop>" schedule sheet as Saved favorites.

import { api } from './api.js';
import { el, modeMeta, modeIcon } from './ui.js';
import { getLastPos } from './board.js';
import { displayName } from './names.js';
import { openStopSchedule } from './saved.js';

function locateHere() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 60000 },
    );
  });
}

export async function renderMapTab(posOverride = null) {
  const holder = document.getElementById('map-list');
  holder.innerHTML = '';
  holder.appendChild(el('p', { class: 'muted map-note', text: 'Full map view arrives in M6 — nearest stops for now.' }));

  const pos = posOverride || getLastPos();
  if (!pos) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'See the stops around you.' }),
      el('button', {
        class: 'btn btn-ghost geo-btn',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try { renderMapTab(await locateHere()); }
          catch {
            btn.disabled = false;
            btn.nextElementSibling?.remove();
            btn.insertAdjacentElement('afterend',
              el('p', { class: 'muted', text: 'Location unavailable — check the permission and retry.' }));
          }
        },
      }, [
        el('img', { src: '/icons/place-pin.png', alt: '' }),
        el('span', { text: ' Show stops near me' }),
      ]),
    ]));
    return;
  }
  try {
    const { data: stops } = await api.nearbyStops(pos.lat, pos.lon, 2500);
    for (const s of stops.slice(0, 25)) {
      holder.appendChild(el('button', {
        class: 'dep-row dep-row-btn',
        onclick: () => openStopSchedule({ name: s.name, stopId: s.stopId, lat: s.lat, lon: s.lon }),
      }, [
        el('span', { class: 'dep-mode' }, [modeIcon((s.modes || [])[0] || 'BUS')]),
        el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: displayName(s.name) })]),
        el('span', { class: 'muted', text: `${s.dist} m` }),
        el('span', { class: 'dep-chevron', text: '›' }),
      ]));
    }
  } catch {
    holder.appendChild(el('div', { class: 'empty-state' }, [el('p', { text: 'Could not load stops.' })]));
  }
}
