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
// Some feeds file Palermo's tram lines (TRAM1…) as buses; the line name is the
// better witness, so a bus-moded "TRAM n" line is drawn as the tram it is.
export function effectiveMode(mode, name) {
  if (!/WALK|RAIL|TRAM|METRO|SUBWAY|FERRY|LONG_DISTANCE/.test(mode || '') && /^\s*tram\s*\d/i.test(name || '')) return 'TRAM';
  return mode;
}
export function modeIcon(mode, cls = 'mode-img', name) {
  mode = effectiveMode(mode, name);
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
export function modeClass(mode, name) {
  mode = effectiveMode(mode, name);
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

// Escape closes the top sheet — keyboard rule; every other close path
// (backdrop, ✕, drag, hardware back) existed but Esc was missing. Found by
// the session suite (session-core.js s3). Guarded: unit tests import this
// module in Node, where there is no document.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetStack.length) { e.preventDefault(); closeSheet(); return; }
    // A non-button carrying role=button must answer Enter and Space itself;
    // stopPropagation keeps a star nested in a row from firing the row.
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute
        && t.getAttribute('role') === 'button' && t.tagName !== 'BUTTON') {
      e.preventDefault(); e.stopPropagation(); t.click();
    }
  }, true);
}

// Everything behind the top dialog is inert: focus and the screen reader's
// virtual cursor stay inside it (aria-modal alone is not honoured everywhere).
function syncInert() {
  const top = sheetStack[sheetStack.length - 1];
  for (const n of document.body.children) {
    if (n.tagName === 'SCRIPT' || n.classList.contains('toast-holder')) continue;
    n.inert = !!top && n !== top;
  }
}

// Our own history.back() (closing a sheet by ✕, Esc, drag or backdrop) raises
// a popstate. app.js must not read it as the user pressing Back — that closed
// the sheet UNDERNEATH a stacked one and re-asserted the previous tab.
let pendingPops = 0;
export function consumeSheetPop() {
  if (pendingPops > 0) { pendingPops--; return true; }
  return false;
}

let dialogSeq = 0;
function pushDialog(overlay, dialog, focusEl) {
  overlay._opener = document.activeElement;
  document.body.appendChild(overlay);
  document.body.classList.add('sheet-open');
  sheetStack.push(overlay);
  syncInert();
  // QA-03: sheets are history entries — browser/hardware back closes them
  try { history.pushState({ ...(history.state || {}), sheet: sheetStack.length }, ''); } catch { /* sandboxed */ }
  try { (focusEl || dialog).focus({ preventScroll: true }); } catch { /* not focusable */ }
}

export function openSheet(contentEl, { title = '' } = {}) {
  const overlay = el('div', { class: 'sheet-overlay' });
  const titleId = `sheet-title-${++dialogSeq}`;
  const sheet = el('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    ...(title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Details' }),
  }, [
    el('div', { class: 'sheet-grab' }),
    el('div', { class: 'sheet-head' }, [
      el('h2', { class: 'sheet-title', id: titleId, text: title }),
      el('button', { class: 'sheet-close', 'aria-label': 'Close', text: '✕', onclick: () => closeSheet() }),
    ]),
    contentEl,
  ]);
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  attachDragDismiss(sheet);
  pushDialog(overlay, sheet);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return overlay;
}

// fromPop: true when history.popstate is unwinding us — don't call back() again
export function closeSheet(fromPop = false) {
  const overlay = sheetStack.pop();
  if (!overlay) return false;
  overlay.classList.remove('show');
  setTimeout(() => overlay.remove(), 250);
  if (!sheetStack.length) document.body.classList.remove('sheet-open');
  syncInert();
  // Focus returns to what opened the dialog. Not to a text field: on a phone
  // that would raise the keyboard nobody asked for.
  const op = overlay._opener;
  if (op && op.isConnected && op !== document.body && !/^(INPUT|TEXTAREA)$/.test(op.tagName)) {
    try { op.focus({ preventScroll: true }); } catch { /* gone */ }
  }
  if (!fromPop && history.state && history.state.sheet) {
    pendingPops++;
    setTimeout(() => { if (pendingPops > 0) pendingPops--; }, 800); // a back() that never raised popstate
    history.back();
  }
  if (overlay._onClose) overlay._onClose();
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
  // A call, the notification shade or a system gesture cancels the touch:
  // spring back instead of leaving the sheet hanging part-way down.
  sheet.addEventListener('touchcancel', () => {
    sheet.style.transform = '';
    startY = null; dy = 0;
  });
}

// ── STYLED CONFIRM (never a native dialog) ──
export function confirmModal(message, { confirmText = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    // A confirm is a dialog like any sheet: it sits on the same stack, so Esc,
    // the Back button and the backdrop all cancel it, and focus starts on
    // Cancel (the safe answer) and returns to the opener afterwards.
    const overlay = el('div', { class: 'sheet-overlay modal-center show' });
    let result = false;
    overlay._onClose = () => resolve(result);
    const done = (v) => { result = v; closeSheet(); };
    const msgId = `modal-msg-${++dialogSeq}`;
    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => done(false) });
    const box = el('div', { class: 'modal-box', role: 'alertdialog', 'aria-modal': 'true', 'aria-describedby': msgId, 'aria-label': confirmText }, [
      el('p', { class: 'modal-msg', id: msgId, text: message }),
      el('div', { class: 'modal-actions' }, [
        cancel,
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText, onclick: () => done(true) }),
      ]),
    ]);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    pushDialog(overlay, box, cancel);
  });
}

// Plain magnifier glyph, stroke = currentColor (mango via CSS) — the single
// search icon everywhere (replaced the mango-fruit lens, user call 2026-08-02).
export const LENS_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.6" y1="15.6" x2="21" y2="21"/></svg>';
