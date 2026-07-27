// ── MAP TAB (M6 placeholder) ──
// The real map ships in M6. Until then: nearest stops as a list, mode-tagged,
// so the tab is still useful on the ground.

import { api } from './api.js';
import { el, modeMeta, modeIcon } from './ui.js';
import { getLastPos } from './board.js';
import { displayName } from './names.js';

export async function renderMapTab() {
  const holder = document.getElementById('map-list');
  holder.innerHTML = '';
  holder.appendChild(el('p', { class: 'muted map-note', text: 'Full map view arrives in M6 — nearest stops for now.' }));

  const pos = getLastPos();
  if (!pos) {
    holder.appendChild(el('div', { class: 'empty-state' }, [
      el('p', { text: 'No location fix yet — open Home first or allow location.' }),
    ]));
    return;
  }
  try {
    const { data: stops } = await api.nearbyStops(pos.lat, pos.lon, 2500);
    for (const s of stops.slice(0, 25)) {
      
      holder.appendChild(el('div', { class: 'dep-row' }, [
        el('span', { class: 'dep-mode' }, [modeIcon((s.modes || [])[0] || 'BUS')]),
        el('div', { class: 'dep-main' }, [el('span', { class: 'dep-route', text: displayName(s.name) })]),
        el('span', { class: 'muted', text: `${s.dist} m` }),
      ]));
    }
  } catch {
    holder.appendChild(el('div', { class: 'empty-state' }, [el('p', { text: 'Could not load stops.' })]));
  }
}
