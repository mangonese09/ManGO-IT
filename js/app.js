// ── APP BOOT + NAVIGATION ──
import { initSearch } from './search.js';
import { initBoard, setBoardVisible } from './board.js';
import { renderSaved } from './saved.js';
import { renderMapTab } from './mapview.js';
import { initSettings } from './settings.js';
import { closeSheet, anySheetOpen } from './ui.js';
import { pruneCache } from './store.js';

const VIEWS = ['home', 'saved', 'map', 'settings'];
let current = 'home';
const navStack = [];

const viewScroll = {}; // QA-16: keep each tab's scroll position
function setView(view, push = true) {
  if (!VIEWS.includes(view) || view === current) return;
  viewScroll[current] = window.scrollY;
  if (push) navStack.push(current);
  current = view;
  // survive a page reload (browser pull-to-refresh) on the same tab
  try { localStorage.setItem('mangoit.view', view); } catch { /* private mode */ }
  // QA-03: browser back walks the tab stack instead of exiting the app
  if (push) { try { history.pushState({ view }, '', '#' + view); } catch { /* sandboxed */ } }
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).hidden = v !== view;
    document.getElementById(`nav-${v}`).classList.toggle('active', v === view);
  }
  setBoardVisible(view === 'home');
  if (view === 'saved') renderSaved();
  if (view === 'map') renderMapTab();
  requestAnimationFrame(() => scrollTo(0, viewScroll[view] || 0));
}

function goBack() {
  if (anySheetOpen()) { closeSheet(); return true; }
  const prev = navStack.pop();
  if (prev) {
    setView(prev, false);
    try { if (history.state && history.state.view) history.back(); } catch { /* sandboxed */ }
    return true;
  }
  return false;
}

// browser/hardware back → unwind sheet, then tab stack (QA-03)
window.addEventListener('popstate', (e) => {
  if (anySheetOpen()) { closeSheet(true); return; }
  const v = (e.state && e.state.view) || 'home';
  navStack.length = 0; // history is now the source of truth for depth
  if (v !== current) setView(v, false);
});

// ── NATIVE SHELL BRIDGE (Capacitor wrap, M7) ──
// No-ops on plain web: the same bundle serves it.mangonese.dev and the
// Android app. Hardware back: close sheet → pop nav stack → on the root
// view, minimize instead of killing the activity.
function initNativeBackButton() {
  const C = window.Capacitor;
  const App = C?.Plugins?.App;
  if (!App?.addListener) return;
  App.addListener('backButton', () => {
    if (goBack()) return;
    if (App.minimizeApp) App.minimizeApp();
    else if (App.exitApp) App.exitApp();
  });
}

// Left-edge swipe back (house PWA standard).
function initEdgeSwipe() {
  let startX = null, startY = null;
  document.addEventListener('touchstart', (e) => {
    // panning the map from the left edge must not navigate back (M6)
    if (e.target.closest?.('.leaflet-container')) { startX = null; return; }
    const t = e.touches[0];
    startX = t.clientX <= 24 ? t.clientX : null;
    startY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const t = e.changedTouches[0];
    if (t.clientX - startX > 70 && Math.abs(t.clientY - startY) < 60) goBack();
    startX = null;
  }, { passive: true });
}

function boot() {
  // The service-worker registration + torn-state reload live in an INLINE
  // script in index.html (v1.5.1) — a torn half-updated cache can kill this
  // whole module graph before boot() exists, and the self-heal must survive
  // exactly that. Nothing SW-related belongs in here.
  for (const v of VIEWS) {
    document.getElementById(`nav-${v}`).addEventListener('click', () => setView(v));
  }
  // One broken/torn module must not take the rest of the app down with it:
  // the failure is logged, the other tabs keep working, and the SW block
  // above swaps the torn shell out on its own.
  const safe = (name, fn) => { try { fn(); } catch (err) { console.error(`init ${name} failed`, err); } };
  safe('pruneCache', pruneCache);
  safe('settings', initSettings);
  safe('search', initSearch);
  safe('board', initBoard);
  safe('edgeSwipe', initEdgeSwipe);
  safe('nativeBack', initNativeBackButton);
  safe('keyboardNav', initKeyboardNav);

  // pull-to-refresh reloads the page: reopen the tab the user was on
  try {
    const last = localStorage.getItem('mangoit.view');
    if (last && last !== 'home') setView(last, false);
    history.replaceState({ view: current }, '', '#' + current);
  } catch { /* private mode */ }
}

// Hide the fixed bottom nav while the soft keyboard is open. A position:fixed
// bottom bar otherwise floats ABOVE the keyboard on mobile, covering the From/To
// suggestion dropdown. Tie it to the real keyboard via VisualViewport (the
// visual viewport shrinks when the keyboard opens) so it never fires on desktop.
function initKeyboardNav() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    // URL-bar collapse is ~50-100px; a keyboard is ~250px+. 150 is a safe gate.
    const kbOpen = (window.innerHeight - vv.height) > 150;
    document.body.classList.toggle('kb-open', kbOpen);
  };
  vv.addEventListener('resize', sync);
}

document.addEventListener('DOMContentLoaded', boot);
