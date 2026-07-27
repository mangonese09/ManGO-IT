// ── APP BOOT + NAVIGATION ──
import { initSearch } from './search.js';
import { initBoard, setBoardVisible } from './board.js';
import { renderSaved } from './saved.js';
import { renderMapTab } from './mapview.js';
import { initSettings, renderFreshness } from './settings.js';
import { closeSheet, anySheetOpen } from './ui.js';
import { pruneCache } from './store.js';

const VIEWS = ['home', 'saved', 'map', 'settings'];
let current = 'home';
const navStack = [];

function setView(view, push = true) {
  if (!VIEWS.includes(view) || view === current) return;
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
  if (view === 'settings') renderFreshness();
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
  for (const v of VIEWS) {
    document.getElementById(`nav-${v}`).addEventListener('click', () => setView(v));
  }
  pruneCache();
  initSettings();
  initSearch();
  initBoard();
  initEdgeSwipe();
  initNativeBackButton();

  // pull-to-refresh reloads the page: reopen the tab the user was on
  try {
    const last = localStorage.getItem('mangoit.view');
    if (last && last !== 'home') setView(last, false);
    history.replaceState({ view: current }, '', '#' + current);
  } catch { /* private mode */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => { /* offline first load */ });
    // A new SW claiming this page means the precache just changed under us —
    // reload ONCE so the running modules match the new shell (no torn state).
    // Only when a controller is REPLACED: first-ever install claiming an
    // uncontrolled page must not reload the very first visit.
    const hadController = !!navigator.serviceWorker.controller;
    let swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || swReloaded) return;
      swReloaded = true;
      location.reload();
    });
  }
}

document.addEventListener('DOMContentLoaded', boot);
