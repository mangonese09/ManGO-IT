// ── APP BOOT + NAVIGATION ──
import { initSearch } from './search.js';
import { initBoard, setBoardVisible } from './board.js';
import { renderSaved } from './saved.js';
// the map module (Leaflet glue, 70 KB) loads the first time the Map tab opens
import { initSettings } from './settings.js';
import { initSync } from './sync.js';
import { closeSheet, anySheetOpen, consumeSheetPop } from './ui.js';
import { pruneCache, getPref, setPref } from './store.js';

const VIEWS = ['home', 'saved', 'map', 'settings'];
let current = 'home';

const viewScroll = {}; // QA-16: keep each tab's scroll position
// 1.19.2 (shared Mangonese Back rule): Home is the first history entry. Leaving Home adds
// exactly one entry; switching between other tabs replaces it; Back from any tab returns
// Home; Back on Home leaves the site (web) or minimizes (Android app). The old model pushed
// every tap and kept a parallel navStack that popstate emptied, so in the Android app the
// second Back minimized instead of returning Home.
let pendingView = null;
function setView(view, fromHistory = false) {
  if (!VIEWS.includes(view)) return;
  // Settings sits one entry above the tab it opened from: leaving it drops that entry first
  if (!fromHistory && current === 'settings' && view !== 'settings') { pendingView = view; try { history.back(); } catch { /* */ } return; }
  if (view === current) {                       // re-tapping the tab you are on: back to its top
    if (!fromHistory) scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (!fromHistory) {
    if (view === 'home') { try { history.back(); } catch { /* sandboxed */ } return; }   // popstate lands Home
    try {
      if (current === 'home' || view === 'settings') history.pushState({ view }, '', '#' + view);
      else history.replaceState({ view }, '', '#' + view);
    } catch { /* sandboxed */ }
  }
  viewScroll[current] = window.scrollY;
  current = view;
  // survive a page reload on the same tab
  setPref('view', view);
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).hidden = v !== view;
    const nb = document.getElementById(`nav-${v}`);
    nb.classList.toggle('active', v === view);
    if (v === view) nb.setAttribute('aria-current', 'page'); else nb.removeAttribute('aria-current');
  }
  setBoardVisible(view === 'home');
  // pull-to-refresh (and its Android overscroll stretch) only on Home
  document.body.classList.toggle('no-ptr', view !== 'home');
  if (view === 'saved') renderSaved();
  if (view === 'map') import('./mapview.js').then((m) => m.renderMapTab());
  requestAnimationFrame(() => scrollTo(0, viewScroll[view] || 0));
}

function goBack() {
  if (anySheetOpen()) { closeSheet(); return true; }
  if (current !== 'home') { try { history.back(); } catch { setView('home', true); } return true; }
  return false;
}

// browser/hardware back → unwind sheet, then the tab (QA-03)
window.addEventListener('popstate', (e) => {
  if (consumeSheetPop()) return; // our own back() from closing a sheet
  if (anySheetOpen()) { closeSheet(true); return; }
  const v = (e.state && e.state.view) || 'home';
  if (v !== current) setView(v, true);
  if (pendingView) { const p = pendingView; pendingView = null; if (p !== current) setView(p); }
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
  let startX = null, startY = null, startT = 0;
  document.addEventListener('touchstart', (e) => {
    // panning the map from the left edge must not navigate back (M6)
    if (e.target.closest?.('.leaflet-container')) { startX = null; return; }
    const t = e.touches[0];
    startX = t.clientX <= 24 ? t.clientX : null;
    startY = t.clientY; startT = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const t = e.changedTouches[0];
    // shared thresholds; on Home with nothing open goBack() does nothing (a swipe never leaves the app)
    if (t.clientX - startX > 70 && Math.abs(t.clientY - startY) < 80 && Date.now() - startT < 700) goBack();
    startX = null;
  }, { passive: true });
}

function boot() {
  // The service-worker registration + torn-state reload live in an INLINE
  // script in index.html (v1.5.1) — a torn half-updated cache can kill this
  // whole module graph before boot() exists, and the self-heal must survive
  // exactly that. Nothing SW-related belongs in here.
  for (const v of VIEWS) {
    // the gear toggles: tapping it on Settings goes back to where you were
    document.getElementById(`nav-${v}`).addEventListener('click', () => { if (v === 'settings' && current === 'settings') history.back(); else setView(v); });
  }
  // 1.20.0: never reload under someone mid-search. The inline script in index.html reloads on a
  // new service worker so a torn shell can repair itself; once the app has booted it is healthy,
  // so disarm that (swReloaded is a global var there) and ask instead. The inline script stays
  // byte-identical: the enforced CSP pins its hash.
  window.swReloaded = true;
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (document.querySelector('.update-bar')) return;
      const bar = document.createElement('div');
      bar.className = 'update-bar'; bar.setAttribute('role', 'status');
      const msg = document.createElement('span'); msg.textContent = 'ManGO:IT was updated';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-primary btn-small'; btn.textContent = 'Reload';
      btn.addEventListener('click', () => location.reload());
      bar.append(msg, btn); document.body.appendChild(bar);
    });
  }
  // offline: one strip under the header, and a toast when the connection is back
  const strip = document.getElementById('offline-strip');
  const paintOffline = () => { if (strip) strip.hidden = navigator.onLine !== false; };
  window.addEventListener('offline', paintOffline);
  window.addEventListener('online', () => { paintOffline(); import('./toast.js').then((t) => t.toast('Back online.')); });
  paintOffline();
  // One broken/torn module must not take the rest of the app down with it:
  // the failure is logged, the other tabs keep working, and the SW block
  // above swaps the torn shell out on its own.
  const safe = (name, fn) => { try { fn(); } catch (err) { console.error(`init ${name} failed`, err); } };
  safe('pruneCache', pruneCache);
  // storage-durability §5: ask the browser not to evict our origin under
  // pressure — non-blocking, and Settings reports the honest answer.
  safe('persistStorage', () => { navigator.storage?.persist?.().catch(() => {}); });
  safe('settings', initSettings);
  // 1.18.0: a device that signed in before reconnects its account (Firebase loads lazily)
  safe('sync', () => { initSync().catch(() => { /* offline boot: Settings shows the state */ }); });
  window.addEventListener('mangoit:synced', () => { if (!document.getElementById('view-saved').hidden) renderSaved(); });
  safe('search', initSearch);
  safe('board', initBoard);
  safe('edgeSwipe', initEdgeSwipe);
  safe('nativeBack', initNativeBackButton);
  safe('keyboardNav', initKeyboardNav);

  safe('pullRefresh', initPullRefresh);
  // a reload reopens the tab the user was on, with Home underneath it so Back still returns Home
  try {
    history.replaceState({ view: 'home' }, '', '#home');
    const last = getPref('view', null);
    if (last && last !== 'home') setView(last);
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

// ── PULL TO REFRESH (1.19.2) ── the browser's reload-on-pull is off everywhere; on Home a
// pull of 72px refreshes the departures board in place (same as the ↻ button).
function initPullRefresh() {
  let y0 = null, pulling = false, ind = null;
  const el = () => {
    if (!ind) { ind = document.createElement('div'); ind.className = 'ptr'; ind.innerHTML = '<span class="ptr-spin" aria-hidden="true"></span>'; document.body.appendChild(ind); }
    return ind;
  };
  document.addEventListener('touchstart', (e) => {
    y0 = null;
    if (current !== 'home' || window.scrollY > 0 || anySheetOpen() || e.touches[0].clientX <= 24) return;
    if (e.target.closest?.('.leaflet-container')) return;
    y0 = e.touches[0].clientY; pulling = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy < 8) { if (pulling) { pulling = false; el().style.transform = ''; } return; }
    pulling = true;
    const p = Math.min(110, dy * 0.5);
    el().classList.add('is-on'); el().classList.toggle('is-ready', p >= 72);
    el().style.transform = `translateY(${p}px)`;
  }, { passive: true });
  const end = () => {
    if (y0 == null) return; y0 = null;
    if (!pulling) return; pulling = false;
    if (!ind.classList.contains('is-ready')) { ind.classList.remove('is-on'); ind.style.transform = ''; return; }
    ind.classList.add('is-busy'); ind.style.transform = 'translateY(56px)';
    document.getElementById('board-refresh')?.click();
    setTimeout(() => { ind.classList.remove('is-on', 'is-ready', 'is-busy'); ind.style.transform = ''; }, 900);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
