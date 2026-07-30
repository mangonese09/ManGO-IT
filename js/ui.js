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

// Mango-character mode icons (from ManGO blueline): train / bus / walker.
// Metro and tram ride the train mango; ferry keeps its emoji until a mango
// boat exists. Every img carries the mode label as alt text.
const MODE_IMG = {
  rail: '/icons/modes/train.png',
  bus: '/icons/modes/bus.png',
  walk: '/icons/modes/pedestrian.png',
};
export function modeIcon(mode, cls = 'mode-img') {
  const kind = mode === 'WALK' ? 'walk'
    : (isRailMode(mode) || mode === 'TRAM') ? 'rail'
    : mode === 'FERRY' ? null : 'bus';
  if (!kind) return el('span', { class: cls.replace('mode-img', 'mode-emoji'), text: modeMeta(mode).icon });
  return el('img', { class: cls, src: MODE_IMG[kind], alt: modeMeta(mode).label });
}

// ── PLACE ICONS (favourite trip endpoints) ──
// Mango-styled SVG set borrowed from ManGO blueline (orange circle + white
// glyph), recoloured to the ManGO:IT --mango token. The order here is the
// order shown in the picker; 'pin' is the neutral default, 'home' is auto-set
// when a place is marked Home.
export const PLACE_ICONS = [
  { key: 'home', label: 'Home' },
  { key: 'work', label: 'Work' },
  { key: 'pin', label: 'Pin' },
  { key: 'coffee', label: 'Café' },
  { key: 'food', label: 'Food' },
  { key: 'friend', label: 'Friend' },
  { key: 'gym', label: 'Gym' },
  { key: 'school', label: 'School' },
  { key: 'shopping', label: 'Shopping' },
];
const PLACE_ICON_KEYS = new Set(PLACE_ICONS.map((i) => i.key));

// The icon a place actually shows: an explicit choice wins; a Home place with
// no explicit choice shows the house; everything else the neutral pin.
export function placeIconKey(p) {
  if (p && PLACE_ICON_KEYS.has(p.icon)) return p.icon;
  return p && p.home ? 'home' : 'pin';
}
export function placeIcon(key, cls = 'place-icon-img') {
  const k = PLACE_ICON_KEYS.has(key) ? key : 'pin';
  const label = (PLACE_ICONS.find((i) => i.key === k) || {}).label || 'Place';
  return el('img', { class: cls, src: `/icons/places/place-${k}.svg`, alt: label });
}

// Five fixed mode colors (audit P2, competitive §7): consistency beats
// operator branding at 44+ tiny operators. Always paired with the glyph —
// color alone never carries the meaning.
export function modeClass(mode) {
  if (isRailMode(mode) && /METRO|SUBWAY|TRAM/.test(mode)) return 'mode-tram';
  if (isRailMode(mode)) return 'mode-rail';
  if (mode === 'FERRY') return 'mode-ferry';
  if (mode === 'TRAM') return 'mode-tram';
  if (mode === 'COACH') return 'mode-coach';
  return 'mode-bus'; // urban bus + unknowns
}

// Live = animated pulse glyph (Transit-style, competitive §3); scheduled =
// quiet text. Binary and honest: never tint a scheduled time green.
export function liveBadge(realTime) {
  if (!realTime) return el('span', { class: 'badge badge-sched', text: 'scheduled' });
  return el('span', { class: 'badge badge-live' }, [
    el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }),
    el('span', { text: 'live' }),
  ]);
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
    el('div', { class: 'sheet-head' }, [
      el('div', { class: 'sheet-title', text: title }),
      el('button', { class: 'sheet-close', 'aria-label': 'Close', text: '✕', onclick: () => closeSheet() }),
    ]),
    contentEl,
  ]);
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  attachDragDismiss(sheet);
  document.body.appendChild(overlay);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => overlay.classList.add('show'));
  sheetStack.push(overlay);
  // QA-03: sheets are history entries — browser/hardware back closes them
  try { history.pushState({ ...(history.state || {}), sheet: sheetStack.length }, ''); } catch { /* sandboxed */ }
  return overlay;
}

// fromPop: true when history.popstate is unwinding us — don't call back() again
export function closeSheet(fromPop = false) {
  const overlay = sheetStack.pop();
  if (!overlay) return false;
  overlay.classList.remove('show');
  setTimeout(() => overlay.remove(), 250);
  if (!sheetStack.length) document.body.classList.remove('sheet-open');
  if (!fromPop && history.state && history.state.sheet) history.back();
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
