// ── SHARED UI HELPERS ──
import { agoText } from './time.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

export const MODE_META = {
  WALK: { icon: '🚶', label: 'Walk' },
  BUS: { icon: '🚌', label: 'Bus' },
  COACH: { icon: '🚌', label: 'Coach' },
  TRAM: { icon: '🚊', label: 'Tram' },
  METRO: { icon: '🚇', label: 'Metro' },
  SUBWAY: { icon: '🚇', label: 'Metro' },
  REGIONAL_RAIL: { icon: '🚆', label: 'Train' },
  REGIONAL_FAST_RAIL: { icon: '🚆', label: 'Train' },
  RAIL: { icon: '🚆', label: 'Train' },
  LONG_DISTANCE: { icon: '🚆', label: 'Train' },
  NIGHT_RAIL: { icon: '🚆', label: 'Night train' },
  HIGHSPEED_RAIL: { icon: '🚄', label: 'Train' },
  FERRY: { icon: '⛴️', label: 'Ferry' },
};
export function modeMeta(mode) {
  return MODE_META[mode] || { icon: '🚌', label: mode ? mode.replace(/_/g, ' ').toLowerCase() : '?' };
}
export function isRailMode(mode) {
  return /RAIL|LONG_DISTANCE|METRO|SUBWAY/.test(mode || '');
}

// Green "live" vs grey "scheduled" — honesty about data quality (PRD §10).
export function liveBadge(realTime) {
  return el('span', {
    class: `badge ${realTime ? 'badge-live' : 'badge-sched'}`,
    text: realTime ? 'live' : 'scheduled',
  });
}

export function staleChip(fetchedAt, stale) {
  const chip = el('span', {
    class: `stale-chip${stale ? ' is-stale' : ''}`,
    text: stale ? `offline — data from ${agoText(fetchedAt)}` : `updated ${agoText(fetchedAt)}`,
  });
  return chip;
}

// ── SHEETS (bottom sheets with drag-to-dismiss) ──
let sheetStack = [];

export function openSheet(contentEl, { title = '' } = {}) {
  const overlay = el('div', { class: 'sheet-overlay' });
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-grab' }),
    title ? el('div', { class: 'sheet-title', text: title }) : null,
    contentEl,
  ]);
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  attachDragDismiss(sheet);
  document.body.appendChild(overlay);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => overlay.classList.add('show'));
  sheetStack.push(overlay);
  return overlay;
}

export function closeSheet() {
  const overlay = sheetStack.pop();
  if (!overlay) return false;
  overlay.classList.remove('show');
  setTimeout(() => overlay.remove(), 250);
  if (!sheetStack.length) document.body.classList.remove('sheet-open');
  return true;
}
export function anySheetOpen() { return sheetStack.length > 0; }

function attachDragDismiss(sheet) {
  let startY = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 4) return;
    startY = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (dy > 90) closeSheet();
    else sheet.style.transform = '';
    startY = null;
  });
}

// ── STYLED CONFIRM (never a native dialog) ──
export function confirmModal(message, { confirmText = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'sheet-overlay modal-center show' });
    const done = (v) => { overlay.remove(); resolve(v); };
    const box = el('div', { class: 'modal-box' }, [
      el('p', { class: 'modal-msg', text: message }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => done(false) }),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText, onclick: () => done(true) }),
      ]),
    ]);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.body.appendChild(overlay);
  });
}
